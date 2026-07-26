# grok-plugin-cc

Bring xAI's **Grok Build** CLI (`grok`) into Claude Code as a set of `/grok:*` slash commands plus a Grok-backed MCP server — for an outside-model second opinion and first-class **live web/X search** mid-task.

> **Unofficial.** Not affiliated with or endorsed by xAI. "Grok" and "Grok Build" are xAI's.
> **License:** [MIT](LICENSE).

## What it is

A personal, fully-local Claude Code plugin. It wraps headless `grok --single=<prompt> --output-format=json` (no ACP, no daemon) and renders Grok's answers inline. Everything is plain `.mjs` with **zero runtime dependencies** and no build step, so it's trivial to fork and hand-edit.

- **`/grok:ask`** — one-shot question to Grok, with live web/X search on by default (the headline feature).
- **`/grok:review`** — read-only review of your working tree or a branch diff, as an outside model.
- **`/grok:status` · `/grok:result` · `/grok:cancel`** — lightweight control for background jobs.
- **`/grok:setup`** — doctor: checks the CLI, auth, and resolved config.
- **MCP tools** — `grok_search` and `grok_ask`, so Claude can consult Grok (especially live search) on its own mid-task.

## Install

**1. Install Grok Build and authenticate:**

```bash
curl -fsSL https://x.ai/cli/install.sh | bash
```

Then authenticate — either set `XAI_API_KEY`, or sign in (SuperGrok / X Premium+). The plugin needs Node 18+ and CI exercises Node 18, 20, 22, and 24.

**2. Install the plugin from GitHub:**

```text
/plugin marketplace add trevoraspencer/grok-plugin-cc
/plugin install grok@grok-plugin-cc
```

Or, to fork and hand-edit, clone first and add the local path:

```text
git clone https://github.com/trevoraspencer/grok-plugin-cc
/plugin marketplace add ./grok-plugin-cc
/plugin install grok@grok-plugin-cc
```

For a one-session try without installing (from a local clone):

```bash
claude --plugin-dir ./grok-plugin-cc
```

(There is no bare `/plugin install <path>` — use the marketplace add + install pair, or the one-session `--plugin-dir` flag.)

Run `/grok:setup` to confirm everything is wired up.

## Command reference

| Command | What it does | Key flags |
| --- | --- | --- |
| `/grok:ask <question>` | Ask Grok one-shot; live search follows config and defaults on | `--model <slug>`, `--no-search`, `--search`, `--max-turns <n>`, `--effort <level>`, `--reasoning-effort <level>`, `--thought`, `--background`, `--print-args` |
| `/grok:review` | Read-only review of the diff; live search defaults off | `--model <slug>`, `--base <ref>`, `--scope auto\|working-tree\|branch`, `--search`, `--max-turns <n>`, `--effort <level>` or `--reasoning-effort <level>`, `--thought`, `--background`, `--print-args` |
| `/grok:status [job-id]` | List background jobs, or one job's detail | — |
| `/grok:result <job-id>` | Print a finished job's captured output | — |
| `/grok:cancel <job-id>` | Cancel a running background job | — |
| `/grok:setup` | Diagnose CLI, auth, and resolved config | `--json` |

All live calls are strictly read-only at the process boundary: the wrapper disables Grok subagents and memory and denies Bash, Edit, Read, Grep, and MCP workspace tools. Review never edits files or applies patches and cannot inspect files beyond the bounded diff supplied in its prompt.

For `ask` and `review`, `--max-turns` overrides the configured `max_turns` for that call. `--effort` and `--reasoning-effort` are aliases; use one, because supplying both is rejected as ambiguous. Whether effort affects a response depends on the selected model. `--thought` appends Grok's returned reasoning in a collapsed details block, and `--print-args` prints the exact CLI argv without invoking Grok. `--print-args` takes precedence over `--background`.

**Review scope** (`--scope`, default `auto`):

- `auto` — the working tree if it has uncommitted changes; otherwise a branch diff against the detected default branch (`main` / `master` / `trunk` / `origin/HEAD`).
- `working-tree` — always the uncommitted changes (staged + unstaged + untracked).
- `branch` — a branch diff; pass `--base <ref>` to pick the base, otherwise the default branch is detected.

An empty diff prints `Nothing to review.` and exits 0. A `--base` ref that doesn't exist — or `--scope branch` when no base can be detected — is reported as an error (exit 1) rather than a misleading "nothing to review". Base values are restricted to bounded branch, tag, remote, SHA-like, or simple `HEAD~N` refs; option-shaped, reflog, range, control-character, and oversized values are rejected. Running the command outside a git repository is likewise an error (exit 1).

Working-tree review includes staged, unstaged, and up to 1,000 untracked paths, enumerated with NUL delimiters so unusual filenames cannot merge records. Untracked files larger than 24 KiB, binary files, symlinks, and files whose identity changes while opening are represented by a skip marker. Git operations have time/output limits, and review diff content is capped at 96 KiB of UTF-8 so the final prompt remains below the operating system's single-argument limit. Review does not use live search unless `--search` is passed.

### Background jobs

`ask` and `review` can run through Claude Code's background Bash support. The dispatcher writes private, atomic records and bounded output under an owner-specific OS-temporary directory; POSIX directories/files are `0700`/`0600`, while Windows uses the per-user temp directory's inherited ACLs. Symlinks are refused, and at most 1,000 jobs and 4 MiB of output per job are retained. Records bind both dispatcher and Grok child PIDs to process-start identities so a recycled PID is never signaled. Cancellation is persisted before the verified Grok process group and wrapper are terminated, and terminal states cannot be overwritten by a late exit. This is local process plumbing, not a durable database or a kept project artifact.

## MCP tools

The plugin ships a zero-dependency stdio MCP server (`.mcp.json` → `scripts/mcp-server.mjs`) exposing:

- **`grok_search`** — `{ query, model? }` → **always** performs a live web/X search and returns Grok's synthesized answer, including citation links when Grok supplies them.
- **`grok_ask`** — `{ prompt, model?, search? }` → a one-shot question. Live search follows the `web_search` config default; pass `search:true`/`false` to override per call.

Claude can call these autonomously when it needs current information. The server implements the MCP `2025-11-25` stdio framing, rejects messages above 1 MiB, validates runtime arguments against the advertised strict schemas, ignores call notifications, and caps work at eight concurrent requests.

## Configuration

Version-controlled defaults live in [`config/defaults.json`](config/defaults.json). A machine-local override may be placed at `./.grok/grok-plugin.json` (git-ignored). Overrides must be regular, non-symlink files no larger than 64 KiB and are validated per key: `safety` must be `permissive` or `preview`, `web_search` must be boolean, `max_turns` must be `null` or an integer from 1 through `4294967295`, and `timeout_ms` must be a positive integer no greater than `2147483647`; invalid and unknown values are ignored in favor of the shipped defaults. Model keys must name one of the two supported model IDs — an unsupported or legacy ID (including `grok-build`) is flagged by `/grok:setup` and rejected with a migration error when the model is resolved, instead of being forwarded to the CLI.

| Key | Default | Meaning |
| --- | --- | --- |
| `default_model` | `grok-4.5` | model for `/grok:review` and general use |
| `search_model` | `grok-4.5` | model for `ask` / `grok_search`; Grok 4.5 supports web and X search |
| `fallback_model` | `grok-composer-2.5-fast` | fast alternative used when the selected config key is empty |
| `safety` | `permissive` | reserved for future write-capable commands; current commands remain read-only regardless of this value |
| `web_search` | `true` | live-search default for `/grok:ask` and the `grok_ask` MCP tool (the `grok_search` tool always searches, regardless of this) |
| `max_turns` | `null` | cap on grok agent turns for `ask` and the MCP tools; `null` = no cap |
| `timeout_ms` | `900000` | wall-clock deadline for each live Grok call (15 minutes); override locally for unusually long workloads |

Per-call flags always win over config: `--model`/`-m` overrides the model ID, and `--no-search`/`--search` override the `web_search` default. The plugin intentionally exposes only the two models in the current Grok Build catalog:

- `grok-4.5` — default for review, questions, and live web/X search.
- `grok-composer-2.5-fast` — faster optional alternative and configured fallback.

Legacy or custom IDs (including `grok-build`) are rejected with a migration error instead of being forwarded to the CLI. Machine-local overrides in `.grok/grok-plugin.json` must also use one of the two supported IDs.

> `--no-auto-update`, `--no-subagents`, `--no-memory`, and explicit tool denials are **always** passed to Grok in automation. They are not config knobs.

### The `--effort` / `--reasoning-effort` note

`--effort` and `--reasoning-effort` are accepted as aliases. The wrapper emits one canonical `--reasoning-effort=<value>` argument and rejects a call that supplies both. Grok 4.5 supports `low`, `medium`, and `high` reasoning effort. Composer behavior follows its server-provided model configuration.

## Design notes

- **Headless + MCP, not ACP.** ACP casts Grok as the agent expecting an editor client; that's the wrong fit for "Claude Code calls Grok." This plugin uses headless one-shot calls plus an MCP server.
- **No kept artifacts.** Output renders inline. Background jobs use a transient registry under the OS temp dir — never committed.
- **Drift-resistant.** All `grok` invocation goes through one choke-point (`scripts/lib/grok.mjs`) with option values bound as indivisible `--name=value` arguments, a 100 KiB UTF-8 per-prompt argv cap, complete Windows command-line accounting, a two-model allowlist, a hard-coded fallback, defensive JSON parsing, a configurable 15-minute deadline, and a bounded 4 MiB combined output capture. Calls that exceed either runtime bound terminate the complete POSIX process group and report a failure rather than returning truncated JSON. Grok can exit 0 with an empty answer when its web-search worker transiently fails; the wrapper treats that as a failure and retries once.
- **Auth/key safety.** `XAI_API_KEY` is only ever presence-checked and is redacted from all captured Grok output, errors, rendered results, and persisted background-job output.

## Development

No runtime dependencies. Dev scripts (Node's built-in tooling only):

```bash
npm run check   # node --check on production and test .mjs files
npm run eval    # full local eval harness with composite score
npm run bench   # deterministic dispatcher-only benchmark
npm test        # node --test (unit suite, no live CLI calls)
```

`ask` and `review` accept `--print-args`: it prints the exact `grok` argv that *would* be sent and exits without calling grok — a dry-run for debugging model and flag resolution.

The eval and benchmark helpers are offline by design. They exercise Node syntax, unit tests, command dry-runs, MCP handshake behavior, metadata, and dispatcher latency without making live Grok or web-search calls.

Current compatibility baseline: the official changelog and CLI/permission references were reviewed through Grok Build `0.2.111` (July 22, 2026), and the locally installed CLI reported `0.2.112` during validation. The headless integration uses the current `--single=<prompt> --output-format=json --no-auto-update` contract plus explicit read-only permission flags; `/grok:setup` verifies the installed version, live auth state, and the two-model catalog.

See [`docs/grok-build-compatibility.md`](docs/grok-build-compatibility.md) for the version-by-version compatibility audit and resulting decisions.

## Roadmap (phase 2, deferred)

`/grok:rescue` (delegate a write-capable coding task; honors the `safety` toggle), `/grok:research` (deeper multi-step search), `/grok:adversarial-review`, `/grok:imagine` (image), a broader MCP toolset, and a real job registry if the lightweight model proves insufficient.
