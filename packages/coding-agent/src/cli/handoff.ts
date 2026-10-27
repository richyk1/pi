import { execFileSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { APP_NAME, CONFIG_DIR_NAME, ENV_SESSION_DIR, expandTildePath } from "../config.ts";
import { findMostRecentSession, getDefaultSessionDir, type SessionHeader } from "../core/session-manager.ts";
import { SettingsManager } from "../core/settings-manager.ts";

const HELP = `Usage:
  ${APP_NAME} handoff push [--out <file>]
  ${APP_NAME} handoff pull <file> [--cwd <dir>]

Move a session between turns without calling a model.
Push the most recent session for the current directory and its Git workspace.
Pull requires an empty target directory (default: current directory).
Requires Git and a repository with at least one commit. Stop Pi before pushing.
Only project-level ${CONFIG_DIR_NAME}/ settings are included, not global settings or credentials.
The single .json.gz file includes complete Git history; treat it as private.`;

interface WorkspaceFile {
	path: string;
	mode: number;
	data: string;
	symlink: boolean;
}

interface HandoffBundle {
	format: "pi-handoff-1";
	head: string;
	branch: string;
	cwd: string;
	sessionName: string;
	session: string;
	history: string;
	staged: string;
	unstaged: string;
	files: WorkspaceFile[];
}

function git(cwd: string, args: string[], input?: Buffer | string): Buffer {
	return execFileSync("git", ["-C", cwd, ...args], {
		input,
		maxBuffer: 512 * 1024 * 1024,
		stdio: ["pipe", "pipe", "pipe"],
	});
}

function checkPath(path: string): void {
	if (
		typeof path !== "string" ||
		!path ||
		isAbsolute(path) ||
		path.includes("\\") ||
		path.includes("\0") ||
		path.split("/").some((p) => !p || p === "." || p === ".." || p.toLowerCase() === ".git")
	) {
		throw new Error(`Unsafe workspace path: ${JSON.stringify(path)}`);
	}
	if (
		/(^|\/)(auth\.json|mcp-auth\.json|credentials(?:\.[^/]*)?|\.env(?:\.[^/]*)?|\.npmrc|\.netrc|id_rsa[^/]*|id_ed25519[^/]*|[^/]+\.(?:pem|key|p12))$/i.test(
			path,
		)
	) {
		throw new Error(`Credential file cannot be handed off: ${path}`);
	}
}

function checkSecrets(content: string): void {
	const secrets = Object.entries(process.env)
		.filter(([key, value]) => /(?:API_KEY|TOKEN|SECRET|PASSWORD)$/.test(key) && value && value.length >= 12)
		.map(([, value]) => value!);
	if (
		secrets.some((secret) => content.includes(secret)) ||
		/sk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}|-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/.test(content) ||
		/["'](?:apiKey|api_key|clientSecret|client_secret|access_token|refresh_token|password)["']\s*:\s*["'](?!\$\{|!)[^"']{8,}["']/i.test(
			content,
		)
	) {
		throw new Error("Credential material detected. Remove it before handing off; the bundle was not written.");
	}
}

function sessionDirectory(cwd: string, agentDir: string): string {
	const settings = SettingsManager.create(cwd, agentDir);
	const configured = process.env[ENV_SESSION_DIR] ?? settings.getSessionDir();
	return configured ? resolve(cwd, expandTildePath(configured)) : getDefaultSessionDir(cwd, agentDir);
}

function readSession(content: string): { header: SessionHeader; body: string; count: number } {
	const newline = content.indexOf("\n");
	if (newline < 0) throw new Error("Invalid session: missing header line");
	const header = JSON.parse(content.slice(0, newline)) as SessionHeader;
	if (header.type !== "session" || typeof header.id !== "string" || typeof header.cwd !== "string") {
		throw new Error("Invalid session header");
	}
	const body = content.slice(newline + 1);
	const entries = body.trim().split("\n").filter(Boolean);
	for (const line of entries) JSON.parse(line);
	return { header, body, count: entries.length };
}

function push(cwd: string, agentDir: string, output?: string): void {
	const sessionPath = findMostRecentSession(sessionDirectory(cwd, agentDir), cwd);
	if (!sessionPath) throw new Error(`No saved session for ${cwd}`);
	const session = readFileSync(sessionPath, "utf8");
	const { count } = readSession(session);
	const root = git(cwd, ["rev-parse", "--show-toplevel"]).toString().trim();
	const head = git(root, ["rev-parse", "HEAD"]).toString().trim();
	if (
		git(root, ["ls-files", "--stage"])
			.toString()
			.split("\n")
			.some((line) => line.startsWith("160000 "))
	) {
		throw new Error("Submodules are not supported by handoff");
	}
	for (const path of git(root, ["ls-files", "-z"]).toString().split("\0").filter(Boolean)) {
		checkPath(path);
		const full = join(root, path);
		try {
			if (lstatSync(full).isSymbolicLink()) {
				const target = readlinkSync(full);
				if (isAbsolute(target) || relative(root, resolve(dirname(full), target)).startsWith(".."))
					throw new Error(`Symlink leaves workspace: ${path}`);
			}
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
		}
	}
	// Do not silently export credential files, including files deleted from HEAD.
	for (const path of git(root, ["log", "--all", "HEAD", "--format=", "--name-only", "-z"])
		.toString()
		.split("\0")
		.filter(Boolean)) {
		checkPath(path);
	}
	checkSecrets(git(root, ["log", "--all", "HEAD", "-p", "--format="]).toString());
	const paths = new Set(
		git(root, ["ls-files", "--others", "--exclude-standard", "-z"]).toString().split("\0").filter(Boolean),
	);
	const projectConfig = join(realpathSync(cwd), CONFIG_DIR_NAME);
	function collect(directory: string): void {
		for (const name of readdirSync(directory)) {
			const path = join(directory, name);
			if (lstatSync(path).isDirectory()) collect(path);
			else paths.add(relative(root, path));
		}
	}
	if (existsSync(projectConfig)) {
		if (lstatSync(projectConfig).isSymbolicLink())
			throw new Error("Project settings directory must not be a symlink");
		collect(projectConfig);
	}
	const files: WorkspaceFile[] = [];
	for (const path of paths) {
		checkPath(path);
		const full = join(root, path);
		const stat = lstatSync(full);
		if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error(`Unsupported workspace file: ${path}`);
		const symlink = stat.isSymbolicLink();
		const data = symlink ? Buffer.from(readlinkSync(full)) : readFileSync(full);
		if (
			symlink &&
			(isAbsolute(data.toString()) || relative(root, resolve(dirname(full), data.toString())).startsWith(".."))
		) {
			throw new Error(`Symlink leaves workspace: ${path}`);
		}
		checkSecrets(data.toString());
		files.push({ path, mode: stat.mode & 0o777, data: data.toString("base64"), symlink });
	}
	const temp = mkdtempSync(join(tmpdir(), "pi-handoff-"));
	try {
		const historyPath = join(temp, "history.bundle");
		git(root, ["bundle", "create", historyPath, "--all", "HEAD"]);
		const bundle: HandoffBundle = {
			format: "pi-handoff-1",
			head,
			branch: git(root, ["branch", "--show-current"]).toString().trim(),
			cwd: relative(root, realpathSync(cwd)),
			sessionName: basename(sessionPath),
			session,
			history: readFileSync(historyPath).toString("base64"),
			staged: git(root, ["diff", "--cached", "--binary", "--full-index", "HEAD"]).toString(),
			unstaged: git(root, ["diff", "--binary", "--full-index"]).toString(),
			files,
		};
		checkSecrets(session);
		checkSecrets(bundle.staged);
		checkSecrets(bundle.unstaged);
		const destination = resolve(output ?? join(tmpdir(), `pi-handoff-${Date.now()}.json.gz`));
		const bytes = gzipSync(JSON.stringify(bundle));
		writeFileSync(destination, bytes, { mode: 0o600, flag: "wx" });
		console.log(`Bundle: ${destination} (${bytes.length} bytes)`);
		console.log(
			`Contents: session ${count} entries, HEAD ${head}, complete Git history, staged/unstaged patches, ${files.length} workspace/settings files`,
		);
		console.log("Handoff model calls: 0; handoff tokens: 0");
	} finally {
		rmSync(temp, { recursive: true, force: true });
	}
}

function pull(file: string, cwd: string, agentDir: string): void {
	const bundle = JSON.parse(gunzipSync(readFileSync(file)).toString()) as HandoffBundle;
	if (
		bundle.format !== "pi-handoff-1" ||
		!/^[a-f0-9]{40,64}$/.test(bundle.head) ||
		![
			bundle.branch,
			bundle.cwd,
			bundle.sessionName,
			bundle.session,
			bundle.history,
			bundle.staged,
			bundle.unstaged,
		].every((value) => typeof value === "string") ||
		!Array.isArray(bundle.files)
	)
		throw new Error("Invalid handoff bundle");
	if (bundle.cwd) checkPath(bundle.cwd);
	if (basename(bundle.sessionName) !== bundle.sessionName || !bundle.sessionName.endsWith(".jsonl"))
		throw new Error("Invalid session filename");
	const { header, body, count } = readSession(bundle.session);
	for (const entry of bundle.files) {
		checkPath(entry.path);
		if (typeof entry.data !== "string" || typeof entry.mode !== "number" || typeof entry.symlink !== "boolean")
			throw new Error("Invalid workspace file");
	}
	if (existsSync(cwd) && readdirSync(cwd).length > 0) throw new Error(`Target must be empty: ${cwd}`);
	mkdirSync(cwd, { recursive: true });
	cwd = realpathSync(cwd);
	const temp = mkdtempSync(join(tmpdir(), "pi-handoff-"));
	try {
		const historyPath = join(temp, "history.bundle");
		writeFileSync(historyPath, Buffer.from(bundle.history, "base64"), { mode: 0o600 });
		git(cwd, ["init", "--quiet"]);
		git(cwd, ["fetch", "--quiet", "--update-head-ok", historyPath, "+refs/*:refs/*", "HEAD"]);
		if (bundle.branch) {
			git(cwd, ["check-ref-format", `refs/heads/${bundle.branch}`]);
			git(cwd, ["symbolic-ref", "HEAD", `refs/heads/${bundle.branch}`]);
		} else git(cwd, ["update-ref", "--no-deref", "HEAD", bundle.head]);
		git(cwd, ["update-ref", "HEAD", bundle.head]);
		git(cwd, ["read-tree", "--reset", "-u", "HEAD"]);
		if (bundle.staged) git(cwd, ["apply", "--index", "--binary", "-"], bundle.staged);
		if (bundle.unstaged) git(cwd, ["apply", "--binary", "-"], bundle.unstaged);
		for (const entry of bundle.files.filter((entry) => !entry.symlink)) {
			const path = join(cwd, entry.path);
			// Never follow a symlink from the restored Git tree while writing an overlay.
			for (let parent = path; parent !== cwd; parent = dirname(parent)) {
				if (existsSync(parent) && lstatSync(parent).isSymbolicLink())
					throw new Error(`Symlink overlay conflict: ${entry.path}`);
			}
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, Buffer.from(entry.data, "base64"));
			chmodSync(path, entry.mode);
		}
		for (const entry of bundle.files.filter((entry) => entry.symlink)) {
			const path = join(cwd, entry.path);
			const target = Buffer.from(entry.data, "base64").toString();
			if (isAbsolute(target) || relative(cwd, resolve(dirname(path), target)).startsWith(".."))
				throw new Error(`Symlink leaves workspace: ${entry.path}`);
			for (let parent = dirname(path); parent !== cwd; parent = dirname(parent)) {
				if (existsSync(parent) && lstatSync(parent).isSymbolicLink())
					throw new Error(`Symlink overlay conflict: ${entry.path}`);
			}
			mkdirSync(dirname(path), { recursive: true });
			rmSync(path, { force: true });
			symlinkSync(target, path);
		}
		for (const path of git(cwd, ["ls-files", "-z"]).toString().split("\0").filter(Boolean)) {
			checkPath(path);
			const full = join(cwd, path);
			try {
				if (lstatSync(full).isSymbolicLink()) {
					const target = readlinkSync(full);
					if (isAbsolute(target) || relative(cwd, resolve(dirname(full), target)).startsWith(".."))
						throw new Error(`Symlink leaves workspace: ${path}`);
				}
			} catch (error) {
				if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
			}
		}
		mkdirSync(join(cwd, bundle.cwd), { recursive: true });
		const sessionCwd = realpathSync(join(cwd, bundle.cwd));
		const directory = sessionDirectory(sessionCwd, agentDir);
		mkdirSync(directory, { recursive: true });
		const sessionPath = join(directory, bundle.sessionName);
		if (existsSync(sessionPath)) throw new Error(`Session already exists: ${sessionPath}`);
		writeFileSync(sessionPath, `${JSON.stringify({ ...header, cwd: sessionCwd })}\n${body}`, {
			mode: 0o600,
			flag: "wx",
		});
		const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
		console.log(`Restored workspace: ${cwd}`);
		console.log(`Session: ${sessionPath} (${count} entries; only header cwd changed)`);
		console.log(`Resume: cd ${quote(sessionCwd)} && ${APP_NAME} --session ${quote(sessionPath)}`);
		console.log("Handoff model calls: 0; handoff tokens: 0");
	} finally {
		rmSync(temp, { recursive: true, force: true });
	}
}

export function runHandoffCommand(args: string[], cwd: string, agentDir: string): number {
	try {
		if (!args.length || args.includes("--help") || args.includes("-h") || args[0] === "help") {
			console.log(HELP);
			return 0;
		}
		const [command, ...rest] = args;
		const positional: string[] = [];
		let value: string | undefined;
		const option = command === "push" ? "--out" : "--cwd";
		for (let index = 0; index < rest.length; index++) {
			if (rest[index] === option && rest[index + 1] && !rest[index + 1].startsWith("--") && value === undefined)
				value = rest[++index];
			else if (!rest[index].startsWith("-")) positional.push(rest[index]);
			else throw new Error(`Unknown or incomplete option: ${rest[index]}`);
		}
		if (command === "push" && positional.length === 0) push(cwd, agentDir, value);
		else if (command === "pull" && positional.length === 1)
			pull(resolve(cwd, positional[0]), resolve(cwd, value ?? "."), agentDir);
		else throw new Error(HELP);
		return 0;
	} catch (error) {
		console.error(`Handoff error: ${error instanceof Error ? error.message : String(error)}`);
		return 1;
	}
}
