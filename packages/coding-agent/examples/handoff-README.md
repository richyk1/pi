# Between-turn handoff

This fork pins Pi **0.87.1**, upstream commit
`8cd0ed48de52f48ebd64bf44cffbf0bae568df97` (2026-09-25).
The handoff adds no dependencies.

Current model metadata also needs the upstream Google API adapter registration
backported into the OpenCode Go provider. No dependency versions change.

From the repository root:

```bash
npm ci --ignore-scripts
npm run hydrate:model-data
npm run build:offline
./handoff-demo.sh
```

Requires Docker, Git, Node.js 22.19+ and `ANTHROPIC_API_KEY`.
`PI_DEMO_ENV=/absolute/path/to/.env ./handoff-demo.sh` reads only that key
without printing it. Docker receives it as an environment variable.

The demo fixes a calculator locally, transfers its actual session and dirty Git
workspace to Linux at another path, continues there, transfers back, and recalls
a fact supplied only in the first prompt. It checks transcript hashes, entry
counts, index/worktree diffs, untracked files and project settings around moves.
There is no summary call. Normal turns still pay for input context.

The single gzip JSON bundle embeds full Git history, HEAD, binary staged and
unstaged patches, untracked files, project `.pi/` files and the JSONL session.
Pull requires an empty directory. No remote, Git config, hooks or global Pi
auth/settings are copied. Known credential files and detected inline keys are
rejected. Inspect private data in history and transcripts before exporting.

The run reserves at most $0.50 and permits at most six Messages requests,
512 output tokens each, with retries and cache warming disabled. Temporary
artifacts, the request ledger and container session persist after failures.
Resume after the first turn with `./handoff-demo.sh resume <artifact-directory>`.
Set `PI_HANDOFF_RECALL_ONLY=1` to use no tools and 256 output tokens in recovery
turns; this does not repeat the code-edit/test turn.

This moves persisted session state, not a process heap, running subprocesses,
network connections, provider streams or model caches. Bundle size grows with
history and session length. Refer to [sessions](../docs/sessions.md) for CLI use.

## Recorded run

On 2026-10-27, the API listed `claude-haiku-5-5`. The retained session used:

| Turn | Session entries after turn | Total tokens | Catalog-estimated USD |
| --- | ---: | ---: | ---: |
| Host edit | 7 | 3945 | 0.000376855 |
| Container recall | 10 | 536 | 0.000069900 |
| Host recall | 13 | 625 | 0.000081025 |

The outgoing bundle was **3424 bytes**, and the return bundle was **3653 bytes**.
Both moves preserved transcript body hashes, entry counts, usage, staged and
unstaged diffs, untracked content and `.pi/settings.json` exactly.

```text
copper otter 731
Container answer contains first-prompt-only fact: yes
Container -> host move: transcript body hash, entry count, usage, staged/unstaged diff, untracked file and .pi settings identical
copper otter 731
Request ledger: {"calls":6,"reservedUsd":0.19273500000000002}
PASS: host -> Linux container -> host; no summary step; moves used 0 model calls and 0 additional tokens.
```

This was a recovery run, not an unmodified fresh run after pinning. The original
host turn was reused. A first container attempt ran a real addition check but
omitted the fact and failed its assertion. Its two paid requests count in the
six-request ledger, but their session was lost before persistence was fixed.
The final two recovery requests disabled tools and recalled the fact on Linux
and the host. Nothing was simulated. The retained session estimates $0.00052778;
the failed attempt's exact token usage is unavailable, so the reservation is
the bound for all six requests.

The pinned fork builds offline after metadata hydration. Touched-package lint,
typecheck and handoff tests pass. The full root check fails in untouched AI tests
that reference retired model IDs in today's hydrated provider catalogs.
