# grok-plugin-cc

Bring xAI's **Grok Build** CLI (`grok`) into Claude Code as a set of `/grok:*` slash commands plus a Grok-backed MCP server — for an outside-model second opinion and first-class **live web/X search** mid-task.

> **Unofficial.** Not affiliated with or endorsed by xAI. "Grok" and "Grok Build" are xAI's.
> **License:** [MIT](LICENSE).

## What it is

A personal, fully-local Claude Code plugin. It wraps headless `grok -p --output-format json` (no ACP, no daemon) and renders Grok's answers inline. Everything is plain `.mjs` with **zero runtime dependencies** and no build step, so it's trivial to fork and hand-edit.

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

Then authenticate — either set `XAI_API_KEY`, or sign in (SuperGrok / X Premium+). The plugin needs Node 18+ (developed against Node 22).

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
| `/grok:review` | Read-only review of the diff; live search defaults off | `--model <slug>`, `--base <ref>`, `--scope auto\|working-tree\|branch`, `--search`, `--thought`, `--background`, `--print-args` |
| `/grok:status [job-id]` | List background jobs, or one job's detail | — |
| `/grok:result <job-id>` | Print a finished job's captured output | — |
| `/grok:cancel <job-id>` | Cancel a running background job | — |
| `/grok:setup` | Diagnose CLI, auth, and resolved config | `--json` |

`/grok:review` is strictly read-only — it never edits files or applies patches.

For `ask`, `--max-turns` overrides the configured `max_turns` for that call. `--effort` and `--reasoning-effort` are forwarded to the Grok CLI; whether they affect a response depends on the selected model. For both `ask` and `review`, `--thought` appends Grok's returned reasoning in a collapsed details block, and `--print-args` prints the exact CLI argv without invoking Grok. `--print-args` takes precedence over `--background`.

**Review scope** (`--scope`, default `auto`):

- `auto` — the working tree if it has uncommitted changes; otherwise a branch diff against the detected default branch (`main` / `master` / `trunk` / `origin/HEAD`).
- `working-tree` — always the uncommitted changes (staged + unstaged + untracked).
- `branch` — a branch diff; pass `--base <ref>` to pick the base, otherwise the default branch is detected.

An empty diff prints `Nothing to review.` and exits 0. A `--base` ref that doesn't exist — or `--scope branch` when no base can be detected — is reported as an error (exit 1) rather than a misleading "nothing to review". Running the command outside a git repository is likewise an error (exit 1).

Working-tree review includes staged, unstaged, and untracked files. Untracked files larger than 24 KiB and binary files are represented by a skip marker, and the assembled review input is capped at 100 Ki UTF-16 code units. Review does not use live search unless `--search` is passed.

### Background jobs

`ask` and `review` can run through Claude Code's background Bash support. The dispatcher writes a transient JSON record and captured output under the OS temporary directory, records both the dispatcher and Grok child PIDs, and exposes them through `status`, `result`, and `cancel`. Dead dispatcher processes are reconciled to `failed` when read, and cancellation terminates both recorded processes. This is local process plumbing, not a durable database or a kept project artifact.

## MCP tools

The plugin ships a zero-dependency stdio MCP server (`.mcp.json` → `scripts/mcp-server.mjs`) exposing:

- **`grok_search`** — `{ query, model? }` → **always** performs a live web/X search and returns Grok's synthesized answer, including citation links when Grok supplies them.
- **`grok_ask`** — `{ prompt, model?, search? }` → a one-shot question. Live search follows the `web_search` config default; pass `search:true`/`false` to override per call.

Claude can call these autonomously when it needs current information.

## Configuration

Version-controlled defaults live in [`config/defaults.json`](config/defaults.json). A machine-local override may be placed at `./.grok/grok-plugin.json` (git-ignored). Overrides are validated per key: model values must be non-empty strings, `safety` must be `permissive` or `preview`, `web_search` must be boolean, and `max_turns` must be `null` or a positive integer. Invalid and unknown values are ignored in favor of the shipped defaults.

| Key | Default | Meaning |
| --- | --- | --- |
<<<<<<< HEAD
| `default_model` | `grok-composer-2.5-fast` | model for `/grok:review` |
| `search_model` | `grok-build` | model for `ask` / `grok_search` (searches reliably) |
| `fallback_model` | `grok-build` | used if a chosen slug is empty |
| `safety` | `permissive` | reserved for future write-capable commands; current commands remain read-only regardless of this value |
=======
| `default_model` | `grok-4.5` | primary model for `review` and general use |
| `search_model` | `grok-4.5` | model for `ask` / `grok_search`; Grok 4.5 supports web and X search |
| `fallback_model` | `grok-composer-2.5-fast` | fast alternative used when the selected config key is empty |
| `safety` | `permissive` | trust + git as the safety net (MVP commands are read-only). The write-capable `rescue` is phase-2; this key lets a future release flip to preview/approval without a rewrite. |
>>>>>>> origin/main
| `web_search` | `true` | live-search default for `/grok:ask` and the `grok_ask` MCP tool (the `grok_search` tool always searches, regardless of this) |
| `max_turns` | `null` | cap on grok agent turns for `ask` and the MCP tools; `null` = no cap |

Per-call flags always win over config: `--model`/`-m` overrides the model ID, and `--no-search`/`--search` override the `web_search` default. The plugin intentionally exposes only the two models in the current Grok Build catalog:

- `grok-4.5` — default for review, questions, and live web/X search.
- `grok-composer-2.5-fast` — faster optional alternative and configured fallback.

Legacy or custom IDs (including `grok-build`) are rejected with a migration error instead of being forwarded to the CLI. Machine-local overrides in `.grok/grok-plugin.json` must also use one of the two supported IDs.

> `--no-auto-update` is **always** passed to grok in automation (it is not a config knob), so a headless call never triggers an interactive self-update.

### The `--effort` / `--reasoning-effort` note

`--effort` and `--reasoning-effort` are accepted as aliases. The wrapper emits one canonical `--reasoning-effort` argument; if both are supplied, the long form wins. Grok 4.5 supports `low`, `medium`, and `high` reasoning effort. Composer behavior follows its server-provided model configuration.

## Design notes

- **Headless + MCP, not ACP.** ACP casts Grok as the agent expecting an editor client; that's the wrong fit for "Claude Code calls Grok." This plugin uses headless one-shot calls plus an MCP server.
- **No kept artifacts.** Output renders inline. Background jobs use a transient registry under the OS temp dir — never committed.
- **Drift-resistant.** All `grok` invocation goes through one choke-point (`scripts/lib/grok.mjs`) with a two-model allowlist, a hard-coded fallback, and defensive JSON parsing. grok can exit 0 with an empty answer when its web-search worker transiently fails; the wrapper treats that as a failure and retries once.
- **Auth/key safety.** `XAI_API_KEY` is only ever presence-checked, never printed or logged.

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

Current compatibility baseline: tested with Grok Build stable `0.2.93` after reviewing the July 5–9, 2026 changes through changelog `0.2.94` (which was posted but not yet offered by the stable updater during validation). The headless integration continues to use `-p --output-format json --no-auto-update`; `/grok:setup` verifies the installed version, live auth state, and the two-model catalog.

See [`docs/grok-build-compatibility.md`](docs/grok-build-compatibility.md) for the version-by-version compatibility audit and resulting decisions.

## Roadmap (phase 2, deferred)

`/grok:rescue` (delegate a write-capable coding task; honors the `safety` toggle), `/grok:research` (deeper multi-step search), `/grok:adversarial-review`, `/grok:imagine` (image), a broader MCP toolset, and a real job registry if the lightweight model proves insufficient.
