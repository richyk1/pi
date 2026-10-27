import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const cli = join(root, "packages/coding-agent/dist/bundle/cli.js");
const limiter = join(root, "packages/coding-agent/examples/handoff-limit.ts");
const container = process.argv[2] === "container";
const resuming = process.argv[2] === "resume";
const work = container ? "/transfer" : realpathSync(resuming ? process.argv[3] : mkdtempSync(join(tmpdir(), "pi-handoff-demo-")));
const agentDir = join(work, container ? "container-agent" : "agent");
const ledger = join(work, "requests.json");
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_HANDOFF_REQUEST_LEDGER = ledger;
process.env.PI_SKIP_VERSION_CHECK = "1";
process.env.PI_OFFLINE = "1";
delete process.env.PI_CODING_AGENT_SESSION_DIR;
const recallOnly = process.env.PI_HANDOFF_RECALL_ONLY === "1";

function run(command, args, cwd, options = {}) {
	return execFileSync(command, args, { cwd, env: process.env, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, ...options });
}
function pi(cwd, args) {
	return run(process.execPath, [cli, ...args], cwd);
}
function git(cwd, args) {
	return run("git", args, cwd);
}
function session(cwd) {
	const directory = join(agentDir, "sessions", `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
	const files = readdirSync(directory).filter((name) => name.endsWith(".jsonl"));
	assert.equal(files.length, 1);
	return join(directory, files[0]);
}
function evidence(cwd, label) {
	const lines = readFileSync(session(cwd), "utf8").trim().split("\n");
	const entries = lines.slice(1).map((line) => JSON.parse(line));
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, usd: 0 };
	for (const entry of entries) {
		const u = entry.type === "usage" ? entry.usage : entry.message?.role === "assistant" ? entry.message.usage : undefined;
		if (!u) continue;
		for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"]) usage[key] += u[key] ?? 0;
		usage.usd += u.cost?.total ?? 0;
	}
	const state = {
		entries: entries.length,
		bodySha256: createHash("sha256").update(lines.slice(1).join("\n")).digest("hex"),
		status: git(cwd, ["status", "--porcelain=v1"]),
		diff: git(cwd, ["diff", "HEAD", "--"]),
		staged: git(cwd, ["diff", "--cached", "--binary"]),
		note: readFileSync(join(cwd, "untracked.txt"), "utf8"),
		settings: readFileSync(join(cwd, ".pi/settings.json"), "utf8"),
		usage,
	};
	console.log(`${label}: ${state.entries} session entries; usage ${JSON.stringify(usage)}`);
	console.log(`Workspace status:\n${state.status.trimEnd()}`);
	console.log(`Workspace diff:\n${state.diff.trimEnd()}`);
	return state;
}
function moved(before, after, label) {
	assert.deepEqual(after, before);
	console.log(`${label}: transcript body hash, entry count, usage, staged/unstaged diff, untracked file and .pi settings identical`);
}
function turn(cwd, model, prompt, noTools = false) {
	const output = pi(cwd, ["-p", "--continue", "--model", `anthropic/${model}`, "--thinking", "off", "--no-extensions", "-e", limiter, "--no-skills", "--no-context-files", "--approve", ...(noTools ? ["--no-tools"] : []), "--system-prompt", "You are a concise coding assistant. Follow the user's task exactly. Use relative paths. Never commit changes. Do not write secrets or remembered facts to files.", prompt]);
	writeFileSync(join(work, `answer-${container ? "container" : basename(cwd)}.txt`), output);
	console.log(output.trim());
	return output;
}
function showTurn(before, after, name) {
	const delta = Object.fromEntries(Object.entries(after.usage).map(([key, value]) => [key, value - (before?.usage[key] ?? 0)]));
	console.log(`${name} token usage: ${JSON.stringify(delta)}`);
}

if (container) {
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false, provider: { maxRetries: 0 } }, cacheWarming: "off", compaction: { enabled: false } }));
	const model = readFileSync(join(work, "model.txt"), "utf8");
	const cwd = "/transfer/cloud-project";
	console.log(pi("/tmp", ["handoff", "pull", join(work, "outbound.json.gz"), "--cwd", cwd]).trim());
	const before = JSON.parse(readFileSync(join(work, "host-state.json"), "utf8"));
	const restored = evidence(cwd, "After host -> container");
	moved(before, restored, "Host -> container move");
	const answer = turn(cwd, model, recallOnly
		? "What is the exact launch phrase from my first user message? Reply with only that phrase."
		: "Use one bash call to create calculator.test.js containing an assert that add(2,3) equals 5, then run node calculator.test.js. After the tool returns, your final answer MUST contain the exact launch phrase from my first message. Do not put that phrase in a file.", recallOnly);
	assert.ok(answer.includes(readFileSync(join(work, "expected-fact.txt"), "utf8")), "Container answer lost the remembered fact");
	console.log("Container answer contains first-prompt-only fact: yes");
	const after = evidence(cwd, "Container turn complete");
	showTurn(restored, after, "Turn 2 (container)");
	console.log(pi(cwd, ["handoff", "push", "--out", join(work, "return.json.gz")]).trim());
	const afterPush = evidence(cwd, "After container push");
	moved(after, afterPush, "Container push");
	writeFileSync(join(work, "container-state.json"), JSON.stringify(after));
} else {
	if (process.env.PI_DEMO_ENV) {
		const values = parseEnv(readFileSync(process.env.PI_DEMO_ENV, "utf8"));
		if (values.ANTHROPIC_API_KEY) process.env.ANTHROPIC_API_KEY = values.ANTHROPIC_API_KEY;
	}
	assert.ok(process.env.ANTHROPIC_API_KEY, "Set ANTHROPIC_API_KEY or PI_DEMO_ENV");
	assert.ok(existsSync(cli), "Build the fork first: npm run build:offline");
	console.log(`Artifacts: ${work}`);
	const cwd = join(work, "laptop-project");
	const fact = "copper otter 731";
	let model;
	if (!resuming) {
	const response = await fetch("https://api.anthropic.com/v1/models?limit=100", { headers: { "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" } });
	if (!response.ok) throw new Error(`Anthropic models request failed: HTTP ${response.status}`);
	const { data } = await response.json();
	const newest = (family) => data.filter((model) => model.id.includes(family)).sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
	model = (newest("haiku") ?? newest("sonnet"))?.id;
	assert.ok(model, "No Haiku or Sonnet model returned");
	console.log(`Model: ${model}; limit: 6 Messages requests, 512 output tokens/request, $0.50 conservative reservation`);
	writeFileSync(join(work, "model.txt"), model);
	writeFileSync(ledger, JSON.stringify({ calls: 0, reservedUsd: 0 }));
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false, provider: { maxRetries: 0 } }, cacheWarming: "off", compaction: { enabled: false } }));
	mkdirSync(cwd);
	git(cwd, ["init", "--quiet"]);
	git(cwd, ["config", "user.name", "Handoff Demo"]);
	git(cwd, ["config", "user.email", "handoff@example.invalid"]);
	writeFileSync(join(cwd, "calculator.js"), "exports.add = (a, b) => a - b;\n");
	writeFileSync(join(cwd, ".gitignore"), ".pi/\n.env\n.env.*\n");
	git(cwd, ["add", "calculator.js", ".gitignore"]);
	git(cwd, ["commit", "--quiet", "-m", "Initial buggy calculator"]);
	writeFileSync(join(cwd, "staged.txt"), "Keep this staged across both moves.\n");
	git(cwd, ["add", "staged.txt"]);
	writeFileSync(join(cwd, "untracked.txt"), "Keep this untracked across both moves.\n");
	mkdirSync(join(cwd, ".pi"));
	writeFileSync(join(cwd, ".pi/settings.json"), JSON.stringify({ retry: { enabled: false, provider: { maxRetries: 0 } }, compaction: { enabled: false } }));
	// This assertion fixture is outside the workspace and is never supplied to Pi.
	writeFileSync(join(work, "expected-fact.txt"), fact);
	turn(cwd, model, `Remember this exact launch phrase only in our conversation: ${fact}. Do not repeat it yet or write it to a file. Inspect calculator.js and fix addition. Use exactly one bash tool call: node -e 'const fs=require("node:fs");const p="calculator.js";const s=fs.readFileSync(p,"utf8");console.log(s);fs.writeFileSync(p,s.replace("a - b","a + b"))'. Then answer briefly. Do not run tests yet.`);
	} else {
		model = readFileSync(join(work, "model.txt"), "utf8");
		console.log(`Resuming saved first turn; keeping request ledger: ${readFileSync(ledger, "utf8")}`);
	}
	const before = evidence(cwd, "Host turn complete");
	assert.match(readFileSync(join(cwd, "calculator.js"), "utf8"), /a \+ b/);
	showTurn(null, before, "Turn 1 (host)");
	if (!existsSync(join(work, "outbound.json.gz"))) console.log(pi(cwd, ["handoff", "push", "--out", join(work, "outbound.json.gz")]).trim());
	moved(before, evidence(cwd, "After host push"), "Host push");
	writeFileSync(join(work, "host-state.json"), JSON.stringify(before));
	console.log(run("docker", ["run", "--rm", "-e", "ANTHROPIC_API_KEY", "-e", "PI_HANDOFF_RECALL_ONLY", "-v", `${root}:/pi:ro`, "-v", `${work}:/transfer`, "node:22", "node", "/pi/packages/coding-agent/examples/handoff-demo.mjs", "container"], cwd).trim());
	const back = join(work, "laptop-returned");
	console.log(pi(cwd, ["handoff", "pull", join(work, "return.json.gz"), "--cwd", back]).trim());
	const previous = JSON.parse(readFileSync(join(work, "container-state.json"), "utf8"));
	const restored = evidence(back, "After container -> host");
	moved(previous, restored, "Container -> host move");
	const final = turn(back, model, "What is the exact launch phrase from my first user message? Reply with only that phrase.", true);
	assert.ok(final.includes(fact), "Return turn lost the remembered fact");
	const after = evidence(back, "Final host turn complete");
	showTurn(restored, after, "Turn 3 (host)");
	console.log(`Request ledger: ${readFileSync(ledger, "utf8")}`);
	console.log("PASS: host -> Linux container -> host; no summary step; moves used 0 model calls and 0 additional tokens.");
	console.log("Normal continuation requests still pay for input context. No process, socket, provider stream or model cache is transferred.");
}
