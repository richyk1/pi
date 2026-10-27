# Sessions and Context

Pi saves a conversation as a session. The active branch of that session supplies conversation history for the next model request. Use session commands to continue work, explore another branch, or reduce the amount of history sent to the model.

## Continue or switch sessions

Pi saves sessions automatically unless you start it with `--no-session`.

```bash
pi --continue
pi --resume
```

`--continue` opens the most recent session for the current working directory. `--resume` opens the session picker. In interactive mode, `/resume` opens the same picker and `/new` starts a new session.

Use `/name` or `--name` to assign a recognizable session name. Run `/session` to verify the current session file, ID, message count, token usage, and cost.

The session picker lets you search, rename, and delete sessions. It can also show paths, change sorting, and limit results to named sessions. See [Keybindings](keybindings.md#sessions) for its shortcuts.

## Choose how to branch

Pi stores entries as a tree, so returning to an earlier point does not erase the branch you leave.

| Action | Result | Use it when |
|---|---|---|
| `/tree` | Moves within the current session file | Related alternatives should stay together |
| `/fork` | Creates a new session from an earlier user message | The alternative should become separate work |
| `/clone` | Copies the active branch into a new session | You want a separate copy of the current state |

In `/tree`, select a user message to put its text back in the editor. Edit and submit it to create another branch. Selecting an assistant response or another entry continues after that entry with an empty editor.

When you leave a branch, Pi can summarize it and attach that summary to the branch you enter. This preserves relevant work from the abandoned path without including every message from it.

For the persisted tree and entry types, see [Session Format](session-format.md).

## Manage conversation context

The model receives the active branch, not every branch in the session file. Pi combines that history with the system prompt, discovered context files, available tools, and loaded skill descriptions. [How Pi Works](how-pi-works.md#context) describes how those inputs are assembled.

The footer shows current context usage. When the active context approaches the model's limit, Pi normally compacts older history automatically. Compaction adds a summary and keeps recent messages. It does not delete the original session entries.

Run `/compact` to compact manually. You can add instructions when the summary should preserve a particular topic or decision. Configure automatic compaction and retained history through [Settings](settings.md#compaction).

Compaction can fail if the provider is unavailable or cannot accept the summarization request. Correct the provider problem and run `/compact` again. Disabling automatic compaction does not disable the manual command.

See [Compaction Reference](compaction.md) for thresholds, retained boundaries, branch-summary behavior, and extension hooks.

## Control session storage

By default, Pi stores sessions under `~/.pi/agent/sessions/`, grouped by working directory. Use `--session-dir`, `PI_CODING_AGENT_SESSION_DIR`, or the `sessionDir` setting to choose another location. The CLI option has highest precedence.

Use `--no-session` for an ephemeral run. An ephemeral session cannot be resumed after Pi exits.

Use `--session` when you already know the session path or ID. Use `--fork` to create a new session from an existing session before interactive mode starts.

## Move a session between machines

Stop Pi between turns, then run:

```bash
pi handoff push --out /tmp/work.json.gz
# Copy that one file to the other machine.
pi handoff pull /tmp/work.json.gz --cwd /path/to/empty/project
```

Pull prints the exact `cd ... && pi --session ...` command. It keeps the session
ID and every transcript entry unchanged. Only the header's working directory
changes, and the file moves into the session directory for the new path.
`PI_CODING_AGENT_SESSION_DIR` and the `sessionDir` setting apply on each machine.
Pull resolves directory aliases to their real paths before storing the session,
so resuming or pushing after `cd` uses the same working-directory identity.

The gzip-compressed JSON bundle contains a complete `git bundle` of local refs
and HEAD, separate binary staged and unstaged patches, non-ignored untracked
files, and project-level `.pi/` files (including ignored settings). It restores
without a remote. Git remote URLs, Git config, hooks, global Pi settings and
credentials are not copied. The target must be empty; existing work is never
overwritten. The current directory can be inside a repository; `--cwd` selects
the restored repository root, and the resume command returns to the same
relative directory.

Push rejects known credential filenames and detected inline keys rather than
silently changing a workspace. Ignored `.env` and `.env.*` files are not
included. Review the repository history and transcript before export: secret
detection cannot identify arbitrary private data. Treat bundles as private.
Submodules and repositories without a commit are not supported. Stop all
workspace writers before exporting. This command does not snapshot running
processes, sockets, provider streams or model caches.

Push and pull do not call a model or generate a summary. Normal continuation
requests still send and pay for conversation context. Bundle size grows with
history, transcript and workspace changes.

From a source checkout, run the real-model host/container/host demonstration:

```bash
npm ci --ignore-scripts
npm run hydrate:model-data
npm run build:offline
./handoff-demo.sh
```

It requires Docker, Node.js 22.19+, Git and `ANTHROPIC_API_KEY`. Alternatively set
`PI_DEMO_ENV` to a local dotenv file; only its Anthropic key is loaded, without
printing or bundling it. The script queries available models once, picks the
newest Haiku (or Sonnet if none), and disables retries, compaction and cache
warming. An explicit extension caps the entire run at six Messages requests,
512 output tokens per request and a conservative $0.50 reservation. Docker
receives the key through its environment, never through an image or archive.
The demo retains its temporary directory and prints entry counts, transcript
hash equality across moves, workspace diffs, bundle sizes and per-turn usage.
If execution stops after the first saved turn, use
`./handoff-demo.sh resume /path/to/printed/artifacts` to keep the same session,
model selection and request budget instead of paying for that turn again.

## Export or share a session

Use `/export` to write the current session as HTML or JSONL. Use `/share` to upload it and get a viewer link. Pi uses a Radius artifact when Radius authentication is configured; otherwise, it uses a private GitHub gist.

Review exported or shared sessions first. They can contain prompts, model responses, tool arguments, command output, file contents, and extension messages.

## Report a bug

Run `/bug [description]` to prepare a private report for the Pi developers. You can include the session transcript, omit it, or ask the current model to summarize the problem. Review any transcript or generated summary because it can contain sensitive conversation data.

The report includes environment and provider configuration without credential values, plus recorded error diagnostics. Upload it through `radius.pi.dev` or export the same report as a zip to inspect and share yourself. Uploads do not require a login; Radius authentication attributes the report to your account so the developers can follow up. If an upload fails, Pi offers to export the zip.
