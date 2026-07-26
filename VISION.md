# VISION.md — trevoraspencer/grok-plugin-cc

> **Status:** living document · **Trajectory:** public release (v0.1.0, MIT) · **License:** [MIT](LICENSE)
> **Disclaimer:** Unofficial. Not affiliated with or endorsed by xAI. "Grok" and "Grok Build" are xAI's.
> **Implementation:** v1 shipped 2026-06-14 and was open-sourced under [MIT](LICENSE) on GitHub on 2026-06-15. The current implementation uses `commands/` for slash-command prompts, a two-model allowlisted routing config updated for the July 2026 catalog (`grok-4.5` for review/ask/search, `grok-composer-2.5-fast` as the fast alternative/fallback), a transient OS-temp job registry, and no `hooks/` or `agents/` directories. See [README.md](README.md) for the operational reference and install instructions.

## Executive Summary

A personal, fully-controlled Claude Code plugin that brings xAI's **Grok Build** CLI (`grok`) into Claude Code as a set of `/grok:*` slash commands plus a Grok-backed MCP server. It is **Grok-native by design** — inspired by `openai/codex-plugin-cc`'s command/job/subagent *UX*, but built around what the `grok` CLI actually offers (headless one-shot execution and live web/X search), not a port of Codex's architecture.

Deliberate non-choice: **this does not use ACP.** Grok's `grok agent stdio` speaks the Agent Client Protocol, but ACP casts Grok as the *agent* and expects an *editor client* to service its file/terminal/permission callbacks — which a Claude Code plugin is not. The idiomatic, low-friction path for "Claude Code calls Grok" is bounded headless `grok --single=<prompt> --output-format=json` plus an MCP server, so that is what this plugin uses.

## Why this exists

Four motivations, in MVP priority order:

1. **Second opinion** — Grok reviews Claude's diffs/branches as an outside model with different priors.
2. **Live web/X search (headline)** — first-class realtime search that Claude-in-Claude-Code lacks; the main reason to reach for Grok mid-task.
3. **Cost/speed arbitrage** — offload work to a configurable Grok model while Claude orchestrates.
4. **Pattern parity** — the proven `codex-plugin-cc` command/job workflow, Grok-powered.

## Goals

- Grok-native `/grok:*` commands that feel familiar to `codex-plugin-cc` users without pretending Grok is Codex.
- Make Grok's live search a first-class capability — both as a command and as an MCP tool Claude can call on its own.
- Full local control: editable command prompts and plugin config are version-controlled and take effect immediately; no telemetry; no external services beyond the `grok` CLI.
- Easy to fork, read, and hand-edit (plain `.mjs`, no build step).
- Conform to the current Claude Code plugin spec so local install is a 2-step, sub-5-minute affair.

## Non-Goals (v1)

- **ACP / `grok agent stdio`** integration (wrong fit for this direction — see Architecture).
- A Codex-style persistent **app-server** or heavy **job registry** (Grok has no app-server to mirror).
- **Stateful/resumable** Grok sessions — interactions are stateless one-shot by design.
- Writing **result artifacts to disk** — output is rendered inline.
- A curated **plugin-marketplace listing** as a launch goal — the plugin is open-source on GitHub (MIT) and installs straight from the repo, but a third-party/official marketplace listing is still not chased.
- `rescue`/delegation, deep `research`, `adversarial-review`, image/video (`imagine`) — all **phase 2**.

## Architecture

### Transport — headless + MCP hybrid (not ACP)

The implementation deliberately targets Grok Build's `grok --single=<prompt>` headless mode and does not use `grok agent stdio`/ACP. Therefore:

- **Slash commands** → a thin `.mjs` wrapper → `grok --single=<prompt> --output-format=json` with auto-update, subagents, memory, and workspace tools disabled. Stateless, one call per invocation; no broker or daemon.
- **MCP server** (`.mcp.json` at plugin root) exposing **`grok_search`** and **`grok_ask`** so Claude can consult Grok — especially live search — autonomously during its own work.

### Background jobs — lightweight

Detach a headless call using **Claude Code's own background-bash** (`run_in_background`). The dispatcher creates private atomic records and bounded output in an owner-only temporary directory, binds wrapper and child PIDs to process-start identities, and exposes that state through `/grok:status`, `/grok:result`, and `/grok:cancel`. Dead wrappers reconcile to `failed`; cancellation first persists a sticky terminal state, then terminates the verified Grok process group and wrapper. This is intentionally lightweight local process state, not a durable database or an in-repo result artifact.

### Models

Two configurable routes are implemented, both allowlisted:

- `default_model = grok-4.5` for `/grok:review`.
- `search_model = grok-4.5` for `/grok:ask`, `grok_search`, and `grok_ask` (Grok 4.5 supports live web and X search).

`fallback_model = grok-composer-2.5-fast` is used when the selected route has no usable ID. `--model`/`-m` overrides routing per call. As verified against the live Grok Build catalog on 2026-07-10, the supported IDs are `grok-4.5` and `grok-composer-2.5-fast`; older IDs (including `grok-build`) are intentionally deprecated by this plugin and rejected with a migration error at the dispatcher and MCP boundaries.

The ask command also forwards `--max-turns`. `--effort` and `--reasoning-effort` are accepted as aliases and normalized to one `--reasoning-effort=<value>` CLI argument; supplying both is rejected as ambiguous. Grok 4.5 supports low, medium, and high effort; Composer follows its server-provided configuration.

### Safety

**Permissive by default** (trust + git as the safety net) — and MVP commands are read-only anyway (`review`, `ask`). The write-capable `rescue` (phase 2) honors a config toggle `safety = permissive | preview`, so a future public release can flip the default to diff-preview/approval **without a rewrite**.

## Feature Scope

### MVP (v0.1)

- **`/grok:review`** — read-only review of the working tree or a branch. Flags: `--base <ref>`, `--scope`, `--background`.
- **`/grok:ask`** — one-shot question to Grok, leaning on live web/X search (the headline differentiator).
- **`/grok:status` · `/grok:result` · `/grok:cancel`** — lightweight background-job control.
- **`/grok:setup`** — doctor: verifies `grok` is installed, checks `XAI_API_KEY`/sign-in, prints resolved config, ensures `--no-auto-update` is used in automation.
- **MCP tools** — `grok_search` (+ `grok_ask`) via `.mcp.json` for autonomous use by Claude.

### Phase 2 (deferred)

- **`/grok:rescue`** — delegate a coding task to a `grok-rescue` subagent (write-capable; honors the safety toggle; named-session resume via `grok -s <id>` only if stateful is later wanted).
- **`/grok:research`** — deeper multi-step search + synthesis.
- **`/grok:adversarial-review`**, **`/grok:imagine`** (image), a broader MCP toolset, and a real job registry if the lightweight model proves insufficient.

## Tech & Structure

- **Language:** plain **`.mjs`** ES modules (no build step; trivial to fork/hand-edit). **Node 18+**, declared in package metadata (`engines`) and checked/reported by `/grok:setup` (which warns below the floor).
- **Grok CLI:** install via xAI's curl bootstrap (`curl -fsSL https://x.ai/cli/install.sh | bash`), **not npm**. Auth via `XAI_API_KEY` or SuperGrok / X Premium Plus sign-in. Grok's own config lives at `~/.grok/config.toml` (project override `./.grok/config.toml`).
- **Plugin config:** version-controlled defaults in `config/defaults.json`, with a validated, git-ignored `.grok/grok-plugin.json` machine override. Command prompts live in `commands/*.md`; both are editable, committed where appropriate, and effective without a build.
- **Repo layout:**

```
grok-plugin-cc/
├── .claude-plugin/
│   ├── plugin.json          # manifest — only `name` is strictly required
│   └── marketplace.json     # enables /plugin marketplace add ./ + /plugin install
├── commands/                # ask, review, setup, status, result, cancel prompts
├── scripts/
│   ├── grok.mjs             # slash-command dispatcher
│   ├── mcp-server.mjs       # zero-dependency stdio MCP server
│   └── lib/                 # config, git, Grok, jobs, render, and setup helpers
├── .mcp.json                # Grok-backed MCP server (grok_search / grok_ask)
├── config/defaults.json     # version-controlled validated defaults
├── tests/                   # offline Node test suite
├── auto/                    # offline eval, benchmark, and release guidance
├── VISION.md                # this file
└── README.md                # install (grok curl + marketplace add) + unofficial disclaimer
```

- **Spec constraint:** the Grok MCP server is registered once at the plugin root through `.mcp.json`; v1 does not ship a subagent, hook, or duplicate per-command server configuration.

## Distribution & Install

Personal in origin; **publicly released under [MIT](LICENSE)** on GitHub at [trevoraspencer/grok-plugin-cc](https://github.com/trevoraspencer/grok-plugin-cc).

1. **Install Grok Build:** `curl -fsSL https://x.ai/cli/install.sh | bash`; set `XAI_API_KEY` or sign in.
2. **Install the plugin:** `/plugin marketplace add trevoraspencer/grok-plugin-cc` then `/plugin install grok@grok-plugin-cc`. (To fork: `git clone` then `/plugin marketplace add ./grok-plugin-cc`. One-session try from a clone: `claude --plugin-dir ./grok-plugin-cc`. There is no bare `/plugin install <path>`.)

## Success Criteria (v1)

- `/grok:review` and `/grok:ask` work end-to-end against the real `grok` CLI, rendering output inline.
- `grok_search` MCP tool is callable by Claude autonomously mid-task.
- Background review (`--background`) plus `status`/`result`/`cancel` works on Claude Code's background-bash.
- `/grok:setup` correctly diagnoses a missing CLI and reports detected auth, Node, model, safety, search, and automation state without exposing credentials.
- Model, search, and turn-limit defaults are editable in-repo and take effect immediately; `safety` is validated and reported but remains reserved until a write-capable command is implemented.
- Fully local; install in under 5 minutes.

## Design references

- **`openai/codex-plugin-cc`** — architectural inspiration (app-server + commands/jobs/subagent UX). https://github.com/openai/codex-plugin-cc
- **`zachdunn/grok-plugin-claude-code`** — closest precedent: lean headless `grok -p --output-format json`, no job registry. https://github.com/zachdunn/grok-plugin-claude-code
- **`VasiHemanth/grok-build-plugin`** — MCP-first hybrid (`grok_search` MCP tool). https://github.com/VasiHemanth/grok-build-plugin
- **`LovelaceLoom/grok-plugin-cc`** — broadest CLI-wrapper surface (formerly `taibaran/grok-plugin-cc`). https://github.com/LovelaceLoom/grok-plugin-cc
- **`phuryn/grok-build-vscode`** — ACP reference (VS Code extension, *not* a CC plugin). https://github.com/phuryn/grok-build-vscode
- **Grok Build** — docs https://docs.x.ai/build/overview · headless https://docs.x.ai/build/cli/headless-scripting · announcement https://x.ai/news/grok-build-cli
- **Model status** — https://docs.x.ai/developers/migration/may-15-retirement
- **Claude Code plugin spec** — reference https://code.claude.com/docs/en/plugins-reference · subagents https://code.claude.com/docs/en/sub-agents · marketplaces https://code.claude.com/docs/en/plugin-marketplaces
- **ACP** — https://agentclientprotocol.com (why it's editor↔agent and a poor fit for this direction)

## Open items to verify at scaffold time — RESOLVED (2026-06-14)

- ~~Exact `-m` slug for the chosen default model; pin a fallback.~~ → Verified slugs at implementation time (2026-06-14) were `grok-composer-2.5-fast` (review) and `grok-build` (ask/search); re-verified 2026-07-10: `grok-4.5` is now the primary review/search model and `grok-composer-2.5-fast` the fast alternative/fallback. All centralized in `config/defaults.json` and enforced by `scripts/lib/config.mjs`.
- ~~Node floor against the installed `grok` version.~~ → Node 18+ floor, continuously tested on Node 18/20/22/24; current compatibility requires Grok Build 0.2.111+ and was locally re-verified with 0.2.112. `/grok:setup` warns below either floor.
- ~~Whether Grok's live search is on by default under `-p` or needs a flag.~~ → Live search is **on by default** under `-p`; `--disable-web-search` turns it off. Note: the search worker can transiently fail (exit 0, empty text, `stopReason: Cancelled`), so the wrapper treats an empty answer as a failure and retries once.
