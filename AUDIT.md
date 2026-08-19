# Full-repo audit

**Date:** 2026-08-18
**Scope:** entire `grok-plugin-cc` tree. No remediations in this pass.
**Method:** read all production sources, command prompts, tests, CI, and docs. Ran `npm test` (154 passed, 0 failed).
**Tree at audit:** `5edfc18` Harden Grok execution, MCP transport, and background jobs (#9)

This is a small, carefully hardened Claude Code plugin. The last several commits are security fixes, and it shows. The remaining problems are not "forgot to quote a shell argument." They are leftover gaps in process lifetime, Claude-side permissions, cost control, and a few docs that overclaim.

---

## What this is

`grok-plugin-cc` 0.2.0. Zero runtime dependencies. Plain `.mjs`. Node 18+.

Six commands: `ask`, `review`, `status`, `result`, `cancel`, `setup`. Two MCP tools: `grok_search` and `grok_ask`. Config lives in `config/defaults.json` with an optional `./.grok/grok-plugin.json` override. Background jobs are JSON files under the OS temp dir, not in the repo.

The design choice is explicit and still looks right. ACP would make Grok the agent and Claude Code the editor client. This plugin does the opposite, so it uses `grok --single=... --output-format=json` and keeps Grok read-only at the CLI boundary (`--no-subagents`, `--no-memory`, `--deny` for Bash/Edit/Read/Grep/MCPTool).

---

## How the pieces connect

User types `/grok:ask ...`. Claude Code loads `commands/ask.md`, substitutes `$ARGUMENTS`, and (if Claude follows the prompt) runs `node scripts/grok.mjs ask "$ARGUMENTS"`. The dispatcher parses flags, loads config, and calls `runGrok()`. That builds argv as `--name=value` pairs, spawns `GROK_BIN` or `grok` in a new POSIX process group, captures up to 4 MiB, times out at 15 minutes, redacts `XAI_API_KEY`, and retries once on the empty-answer / cancelled-search signature.

`/grok:review` is the same path after `resolveDiff()` builds a size-capped prompt from git status, staged/unstaged diffs, and bounded untracked files.

`--background` creates a job record, prints the id, then runs the same `runGrok()` and writes rendered output to a `0600` file. `/grok:status`, `/grok:result`, and `/grok:cancel` read or signal that registry.

The MCP server is a hand-rolled newline JSON-RPC loop. Same `runGrok()` choke point. Config is loaded once at server start.

---

## Overall verdict

For a zero-dep plugin that shells out to a third-party CLI, this is well above average. Job IDs, PID reuse, symlink swaps, git hook execution, option-shaped prompts, and secret redaction were all thought through and tested.

The honesty gap is the marketing of "read-only" and "cannot inspect files beyond the bounded diff." That is true for the Grok child. It is not true for Claude, who is running the slash command. The other gap that will actually bite people is orphaned `grok` processes after cancel/abort, which keeps spending against the user's xAI quota.

---

## High

### 1. A killed wrapper leaves Grok running

`spawnGrok()` sets `detached: true` on POSIX so timeouts and `/grok:cancel` can signal the whole process group. That is the right idea for descendants. It also puts Grok outside the wrapper's process group.

There is no `SIGINT` / `SIGTERM` / `exit` handler on the dispatcher or the runner. If Claude Code aborts the bash tool, or the user hits Ctrl-C, Node dies and the detached group keeps going. Foreground `ask` / `review` do not even create a job, so `/grok:cancel` cannot find them.

For background jobs, `reconcileRecord()` in `scripts/lib/jobs.mjs` notices the wrapper PID is gone and marks the job `failed`. It does not signal `childPid`, even though the start token is sitting right there.

Same class of bug on a normal Grok exit. Process-group SIGKILL is only armed when the wrapper itself decided to terminate (timeout or output cap). If the `grok` binary exits 0 and leaves a search worker in the detached group, that worker is orphaned.

On Windows, `detached` is off and cancel uses a direct PID, so descendants can survive there too.

Impact: silent API spend, leftover processes, `/grok:status` saying failed while Grok is still working.

### 2. Review is not read-only on the Claude side

README and `commands/review.md` say the command is read-only and cannot inspect files beyond the bounded diff. The Grok argv denials support that. Claude's command frontmatter does not.

`commands/review.md` grants `Read`, `Glob`, `Grep`, `Bash(node:*)`, `Bash(git:*)`, and `AskUserQuestion`.

Official Claude Code docs are explicit. `allowed-tools` is a grant, not a restriction. Tools not listed stay callable under the user's normal permissions. There is no `disallowed-tools` anywhere in this repo.

`Bash(node:*)` also pre-approves `node -e '...'`, not only the dispatcher. `Bash(git:*)` pre-approves arbitrary git, including writes, during the review turn.

The "do not fix issues" rule is prompt text. A jailbroken or sloppy turn can read secrets, run git, or edit files while the Grok child stays sandboxed.

`ask` is narrower (`Bash(node:*)` only) but has the same `node -e` grant.

### 3. MCP can spend money without a user in the loop

This is the product. Claude is supposed to call `grok_search` mid-task. After install the plugin defaults to enabled (`defaultEnabled` is unset, so it is `true`). The MCP server starts. Each call can run 15 minutes. Eight can run at once. Search is forced on for `grok_search`. Transient failures retry immediately, and the retry regex treats auth and rate-limit stderr as transient.

There is no per-session budget, no confirmation, no cancel method, and config is snapshotted at MCP start so flipping `web_search` in `.grok/grok-plugin.json` does not affect an already-running server.

Claude Code's own docs say `defaultEnabled: false` is the pattern for plugins that connect to a paid external service. This plugin does not set it.

### 4. Working-tree review sends local file contents to xAI

`resolveDiff()` includes staged diffs, unstaged diffs, and up to 1000 untracked files (24 KiB each, 96 KiB total budget). `ls-files --exclude-standard` honors gitignore, so an ignored `.env` stays out. A new untracked `credentials.json` or a staged secret does not.

That is normal for a review bot. The docs never say it. People will run `/grok:review` on a dirty tree and ship secrets to Grok's API.

---

## Medium

### 5. `ask` / `review` are model-mediated. `status` / `result` / `cancel` are not.

Status uses bang substitution, the `!` line that Claude Code runs before the model sees the prompt. Ask and review ask Claude to decide foreground vs background, then run a fenced bash block. The dispatcher already implements `--background`. Claude does not need to choose. That extra layer is how you get paraphrased output, skipped execution, or a "Grok ask started" message with no job.

`disable-model-invocation: true` is correct for "don't auto-fire an expensive command." There is a known Claude Code bug (anthropics/claude-code#50075) where that flag can hide plugin commands from the agent even after the user typed the slash. This plugin copies the `codex-plugin-cc` pattern and inherits that platform risk. Setup does not set the flag, so Claude can run `/grok:setup` on its own.

### 6. `setup.md` leaves `$ARGUMENTS` unquoted

`commands/setup.md` runs `setup $ARGUMENTS` without quotes. Every other command quotes `"$ARGUMENTS"`. Empty args are fine. Args with spaces or globs are not.

`--offline` is also implemented and undocumented. It makes a missing CLI exit 0, which is intentional for CI and a footgun if a user or Claude passes it.

### 7. `/grok:setup` exit code only cares about a missing binary

`cmdSetup` in `scripts/grok.mjs` sets exit 1 only when `!report.cliOk`. Failed model catalog, old Grok, missing auth, and old Node still exit 0. Auth and Node are documented as warnings. A `models` check with status `fail` is not. Scripts that key off the process exit will green-light a broken model config.

When `grok models` itself fails, auth falls back to "does `XAI_API_KEY` or `~/.grok/auth.json` exist?" `commands/setup.md` says a stale auth file does not count. That is only true when the live probe succeeds and reports unauthenticated.

### 8. Allowlist is not at the spawn choke point

README says all invocation goes through one choke point with a two-model allowlist. `resolveModel()` in `scripts/lib/config.mjs` enforces the list. `buildGrokArgs()` in `scripts/lib/grok.mjs` does not. Dispatcher and MCP both resolve first, so the live paths are fine. The documented invariant is still wrong, and a future caller that skips `resolveModel()` will forward an arbitrary `--model=`.

`--effort` / `--reasoning-effort` are only checked for NUL and length 64. Any string is forwarded. `--model=` (empty) is silently ignored and the configured model is used.

### 9. Dead git helpers are the weaker copies

`workingTreeDiff()` and `branchDiff()` still exist in `scripts/lib/git.mjs`. `resolveDiff()` does not use them. The helpers omit `--no-textconv` and some of the error handling. `statusShort()` / `hasChanges()` are also unused by the dispatcher. If someone "simplifies" review onto the helpers, git `textconv` filters can run, which is code execution from repo config. The live path disables that. The leftover path does not.

### 10. `--base` silently wins over `--scope working-tree`

`selectReviewTarget()` returns branch mode whenever `base` is set, even if the user also passed `--scope working-tree`. No warning.

### 11. JSON scrape can drop a valid answer

`parseGrokJson()` first tries a straight parse, then takes the slice from the first `{` to the last `}`. A banner that contains a brace, then a real JSON object, makes the slice invalid and the call fails even though a parseable object was on stdout. The opposite case (two objects) also fails. Tests only cover a clean object surrounded by non-brace noise.

### 12. Job registry never expires

Cap is 1000 JSON files. No TTL. `cmd` is always `""` because `runBackground()` never passes the prompt, so `/grok:status` cannot show what was asked. Crashed `atomicPrivateWrite()` can leave `.tmp-*` files that do not count toward the cap. Stale lock recovery is a 30s mtime unlink, which is racy under clock jump or a stuck writer.

`GROK_JOBS_DIR` is trusted if ownership/mode checks pass. Tests depend on that. A user who points it at a shared directory and then cannot chmod it gets hard failures, which is fail-closed and fine.

### 13. Compatibility docs are already aging

Audit date is 2026-08-18. `docs/grok-build-compatibility.md` reviews the changelog through 0.2.111 / local 0.2.112, audit window through 2026-07-25. The two-model allowlist is a hard break if xAI adds or renames IDs. `/grok:setup` will fail the models check. Live ask/review will throw at resolve time. There is no softer fallback beyond `fallback_model`, and that fallback is also allowlisted.

VISION still frames the public release as v0.1.0. Package and plugin manifests are 0.2.0.

---

## Low

**MCP protocol tightness.** `initialize` rejects any params key other than `protocolVersion`, `capabilities`, `clientInfo`. A future Claude Code field will 400 the handshake. `tools/call` works with no prior `initialize`. No `notifications/cancelled`. No logging/resources/prompts. Fine for v1, brittle against the spec moving.

**Character vs byte prompt limits.** Tool schemas use `maxLength: 102400` characters. A 100k-character emoji string is then rejected by the UTF-8 byte check. Correct, but the schema advertises a higher limit than the runner accepts.

**Redaction false positives.** `xai-***` and `Bearer ***` patterns will scrub docs and examples, not just credentials. Empty `XAI_API_KEY` is skipped (good). A whitespace-only key would replace spaces in output.

**`safety` is theater.** It is validated and shown in setup. No command reads it. `preview` does nothing. Someone will think they turned on a safer mode.

**Quote-unaware `$ARGUMENTS`.** Flags must come first. Internal whitespace collapses. Documented. Still a UX trap for `/grok:ask explain --search`.

**`npm run check` is Unix-only** (`find ... -exec`). CI is Ubuntu-only. Windows path, PowerShell start-token, and `O_NOFOLLOW` absence are commented and unit-tested with fakes, not exercised on a Windows runner.

**Plugin / marketplace metadata.** Manifests parse and match versions. Missing `displayName`, `repository`, `keywords`, `defaultEnabled`, and marketplace plugin-entry extras. Not load-breaking.

**Eval harness scores string presence.** `auto/eval-harness.mjs` treats "file contains this substring" as vision/robustness. That is a ratchet against accidental deletes, not a proof the behavior still holds. Composite score can be farmed without making the product safer.

**`auto/autoresearch.*` is leftover process.** Tracked JSONL and a "do not call Grok" manual from a finished 2026-06-22 run. Harmless, confusing next to README.

**Release checklist vs README.** Checklist says README must not imply invalid override values are accepted. README says invalid values are ignored, then says unsupported model IDs are kept and rejected later. Both are partly true. Model strings that look like IDs are kept. `max_turns: "10"` is ignored.

**Tests that look stricter than they are.** `jobs.test.mjs` calls `markRunning(id, 1)`. PID 1 is rejected by design, so that line is a no-op. The cancel-still-works assertion still passes. MCP concurrency is tested with `ping`, not with overlapping `runGrok()` calls. There is no integration test that Claude Code actually invokes the slash commands.

**Hidden `--offline`.** In `OPTION_SPEC` and allowed for setup. Not in the README table or `argument-hint`.

---

## What is in good shape

An audit that only lists holes misrepresents this repo.

- Argv is spawn-argv, not a shell string. Option-shaped prompts stay `--single=--help`.
- Git review disables `core.fsmonitor`, sets `hooksPath` to `/dev/null`, disables submodule recurse, uses `--no-ext-diff --no-textconv`, `--end-of-options`, and a tight revision allowlist.
- Untracked reads use `lstat` + `O_NOFOLLOW` + inode identity + checkout `realpath` confinement. Symlink and parent-swap cases have tests.
- Jobs refuse traversal IDs, PID 1, start-token mismatch, world-readable files, and symlink dirs/outputs. Terminal cancel is sticky.
- Secrets are stripped from classified output, rendered markdown, setup reports (presence only), and persisted job output.
- MCP drops call notifications, caps line size at 1 MiB, caps in-flight at 8, validates extra keys, and stays up after a bad line.
- CI pins actions by SHA, `contents: read`, Node 18/20/22/24, no live Grok on `npm test` / `eval` / `bench`.
- 154 tests, 0 failures, in about 2.2s on the audit machine.

The hardening history (`#6` through `#9`) is visible in the code, not just the commit messages.

---

## Test and CI gaps (not failures)

The suite does not cover:

- Wrapper abort / Ctrl-C leaving a detached Grok group
- `reconcileRecord` killing (or not killing) `childPid`
- Claude Code actually loading `commands/*.md`
- Windows job identity and ACL behavior
- Live `grok` JSON envelope drift (by design, offline)
- Concurrent real MCP `tools/call` saturation
- `--base` plus `--scope working-tree`
- Config reload on a long-lived MCP process

Those are missing tests, not red tests.

---

## Residual risk that is inherent

Grok answers, including live search, come back as markdown and get dropped into Claude's context. A search result can try to instruct Claude. That is indirect prompt injection and you cannot fully fix it inside this wrapper.

`--deny=Read` on Grok does not stop Grok's own web/X search from fetching the public internet. Search is the feature.

`XAI_API_KEY` is passed through `env: process.env` to the child. Correct. Anyone who can read the process environment can read the key.

`GROK_BIN` can be any executable path. Trusted local env, same as most CLI wrappers.

---

## Suggested fix order (not done in this pass)

1. On wrapper exit/signal, kill the recorded Grok process group. Do the same when reconciling a dead wrapper that still has a matching `childPid`.
2. Make `ask` / `review` bang-commands like `status`, and add `disallowed-tools` for Edit/Write on review. Narrow `Bash(node:*)` to the dispatcher script.
3. Set `defaultEnabled: false` and snapshot a cost warning in the MCP tool descriptions.
4. Say in README that review uploads the selected diff and untracked bodies to xAI.
5. Delete or route the dead git helpers so `--no-textconv` cannot regress.
6. Fail `/grok:setup` when the models check is `fail`, and quote `$ARGUMENTS` in `setup.md`.

The plugin is close to what VISION promised for v1. The remaining risk is less "can a prompt escape argv" and more "does the story about read-only, cancel, and cost match the process that actually runs."
