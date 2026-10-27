import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runHandoffCommand } from "../src/cli/handoff.ts";
import { getDefaultSessionDir } from "../src/core/session-manager.ts";

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

describe("between-turn handoff", () => {
	let temp: string;
	let source: string;
	let agent: string;
	let archive: string;
	beforeEach(() => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error");
		vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", "");
		temp = realpathSync(mkdtempSync(join(tmpdir(), "pi-handoff-test-")));
		source = join(temp, "source");
		agent = join(temp, "agent");
		archive = join(temp, "move.json.gz");
		mkdirSync(source);
		git(source, "init", "--quiet", "--initial-branch=main");
		git(source, "config", "user.name", "Test");
		git(source, "config", "user.email", "test@example.invalid");
		writeFileSync(join(source, "tracked.txt"), "base\n");
		writeFileSync(join(source, ".gitignore"), ".pi/\n.env\n.env.*\n");
		git(source, "add", "tracked.txt", ".gitignore");
		git(source, "commit", "--quiet", "-m", "base");
		const directory = getDefaultSessionDir(source, agent);
		writeFileSync(
			join(directory, "test.jsonl"),
			`${JSON.stringify({ type: "session", version: 3, id: "test", cwd: source, timestamp: "2026-01-01T00:00:00Z" })}\n{"type":"custom","id":"entry","parentId":null,"timestamp":"2026-01-01T00:00:00Z","customType":"preserved","data":{"fact":"from prompt"}}\n`,
		);
	});
	afterEach(() => {
		rmSync(temp, { recursive: true, force: true });
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
	});

	it("restores without a remote, preserving index, worktree, binary files and session body", () => {
		writeFileSync(join(source, "tracked.txt"), "staged\n");
		git(source, "add", "tracked.txt");
		writeFileSync(join(source, "tracked.txt"), "unstaged\n");
		writeFileSync(join(source, "binary.bin"), Buffer.from([0, 255, 1, 8]));
		writeFileSync(join(source, ".env"), "NOT_EXPORTED=private\n");
		mkdirSync(join(source, ".pi"));
		writeFileSync(join(source, ".pi/settings.json"), '{"defaultThinkingLevel":"off"}');
		symlinkSync("tracked.txt", join(source, "link"));
		expect(runHandoffCommand(["push", "--out", archive], source, agent)).toBe(0);
		const target = join(temp, "different-path");
		expect(runHandoffCommand(["pull", archive, "--cwd", target], temp, agent)).toBe(0);
		expect(git(target, "rev-parse", "HEAD")).toBe(git(source, "rev-parse", "HEAD"));
		expect(git(target, "diff", "--cached", "--binary")).toBe(git(source, "diff", "--cached", "--binary"));
		expect(git(target, "diff", "--binary")).toBe(git(source, "diff", "--binary"));
		expect(readFileSync(join(target, "binary.bin"))).toEqual(Buffer.from([0, 255, 1, 8]));
		expect(readFileSync(join(target, "link"), "utf8")).toBe("unstaged\n");
		expect(readFileSync(join(target, ".pi/settings.json"), "utf8")).toContain("off");
		expect(existsSync(join(target, ".env"))).toBe(false);
		const restored = readFileSync(join(getDefaultSessionDir(target, agent), "test.jsonl"), "utf8").split("\n");
		const original = readFileSync(join(getDefaultSessionDir(source, agent), "test.jsonl"), "utf8").split("\n");
		expect(JSON.parse(restored[0]).cwd).toBe(target);
		expect(restored.slice(1)).toEqual(original.slice(1));
		expect(runHandoffCommand(["pull", archive, "--cwd", target], temp, agent)).toBe(1);
	});

	it("rejects traversal and escaping symlinks without writing outside the target", () => {
		expect(runHandoffCommand(["push", "--out", archive], source, agent)).toBe(0);
		const bundle = JSON.parse(gunzipSync(readFileSync(archive)).toString());
		bundle.files.push({ path: "../escape", data: "", symlink: false, mode: 0o644 });
		writeFileSync(archive, gzipSync(JSON.stringify(bundle)));
		expect(runHandoffCommand(["pull", archive, "--cwd", join(temp, "target")], temp, agent)).toBe(1);
		expect(existsSync(join(temp, "escape"))).toBe(false);
		bundle.files = [
			{ path: "escape", data: Buffer.from("../../escape").toString("base64"), symlink: true, mode: 0o777 },
		];
		writeFileSync(archive, gzipSync(JSON.stringify(bundle)));
		expect(runHandoffCommand(["pull", archive, "--cwd", join(temp, "target")], temp, agent)).toBe(1);
		expect(existsSync(join(temp, "escape"))).toBe(false);
	});

	it("rejects credential files and inline API keys", () => {
		mkdirSync(join(source, ".pi"));
		writeFileSync(join(source, ".pi/auth.json"), "{}");
		expect(runHandoffCommand(["push", "--out", archive], source, agent)).toBe(1);
		expect(existsSync(archive)).toBe(false);
		rmSync(join(source, ".pi/auth.json"));
		writeFileSync(join(source, ".pi/models.json"), JSON.stringify({ apiKey: "example-credential-value" }));
		expect(runHandoffCommand(["push", "--out", archive], source, agent)).toBe(1);
		expect(existsSync(archive)).toBe(false);
	});

	it("rejects newly staged credentials and tracked escaping symlinks", () => {
		writeFileSync(join(source, "auth.json"), "{}");
		git(source, "add", "auth.json");
		expect(runHandoffCommand(["push", "--out", archive], source, agent)).toBe(1);
		git(source, "rm", "--cached", "auth.json");
		rmSync(join(source, "auth.json"));
		symlinkSync("../outside", join(source, "escape"));
		git(source, "add", "escape");
		expect(runHandoffCommand(["push", "--out", archive], source, agent)).toBe(1);
		expect(existsSync(archive)).toBe(false);
	});

	it("rejects credentials deleted from history even when their blob matches another file", () => {
		writeFileSync(join(source, "auth.json"), "base\n");
		git(source, "add", "auth.json");
		git(source, "commit", "--quiet", "-m", "credential file");
		git(source, "rm", "auth.json");
		git(source, "commit", "--quiet", "-m", "remove credential file");
		expect(runHandoffCommand(["push", "--out", archive], source, agent)).toBe(1);
		expect(existsSync(archive)).toBe(false);
	});

	it("stores a canonical session cwd when the restore target has a symlinked parent", () => {
		expect(runHandoffCommand(["push", "--out", archive], source, agent)).toBe(0);
		const actual = join(temp, "actual");
		const alias = join(temp, "alias");
		mkdirSync(actual);
		symlinkSync(actual, alias, "junction");
		const target = join(alias, "restored");
		expect(runHandoffCommand(["pull", archive, "--cwd", target], temp, agent)).toBe(0);
		const canonicalTarget = realpathSync(target);
		expect(canonicalTarget).not.toBe(target);
		const sessionPath = join(getDefaultSessionDir(canonicalTarget, agent), "test.jsonl");
		const header = JSON.parse(readFileSync(sessionPath, "utf8").split("\n")[0]);
		expect(header.cwd).toBe(canonicalTarget);
		expect(runHandoffCommand(["push", "--out", join(temp, "return.json.gz")], canonicalTarget, agent)).toBe(0);
	});
});
