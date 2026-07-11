# VISION.md — trevoraspencer/grok-plugin-cc

> **Status:** living document · **Trajectory:** public release (v0.1.0, MIT) · **License:** [MIT](LICENSE)
> **Disclaimer:** Unofficial. Not affiliated with or endorsed by xAI. "Grok" and "Grok Build" are xAI's.
> **Implementation:** v1 shipped 2026-06-14 and open-sourced under [MIT](LICENSE) on GitHub (2026-06-15) — see [README.md](README.md) for install. Updated for the July 2026 catalog: commands live under `commands/` (not `skills/`); the plugin exposes only `grok-4.5` (default/review/search) and `grok-composer-2.5-fast` (fast alternative/fallback); `hooks/` and `agents/` are not part of v1.

## Executive Summary

A personal, fully-controlled Claude Code plugin that brings xAI's **Grok Build** CLI (`grok`) into Claude Code as a set of `/grok:*` slash commands plus a Grok-backed MCP server. It is **Grok-native by design** — inspired by `openai/codex-plugin-cc`'s command/job/subagent *UX*, but built around what the `grok` CLI actually offers (headless one-shot execution and live web/X search), not a port of Codex's architecture.

Deliberate non-choice: **this does not use ACP.** Grok's `grok agent stdio` speaks the Agent Client Protocol, but ACP casts Grok as the *agent* and expects an *editor client* to service its file/terminal/permission callbacks — which a Claude Code plugin is not. The idiomatic, low-friction path for "Claude Code calls Grok" is headless `grok -p --output-format json` plus an MCP server, so that is what this plugin uses.

## Why this exists

Four motivations, in MVP priority order:

1. **Second opinion** — Grok reviews Claude's diffs/branches as an outside model with different priors.
2. **Live web/X search (headline)** — first-class realtime search that Claude-in-Claude-Code lacks; the main reason to reach for Grok mid-task.
3. **Cost/speed arbitrage** — offload work to a configurable Grok model while Claude orchestrates.
4. **Pattern parity** — the proven `codex-plugin-cc` command/job workflow, Grok-powered.

## Goals

- Grok-native `/grok:*` commands that feel familiar to `codex-plugin-cc` users without pretending Grok is Codex.
- Make Grok's live search a first-class capability — both as a command and as an MCP tool Claude can call on its own.
- Full local control: editable prompts (skill bodies) and plugin config are version-controlled and take effect immediately; no telemetry; no external services beyond the `grok` CLI.
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

Grok Build exposes exactly two machine-friendly modes: `grok -p "..."` (headless one-shot, `--output-format plain|json|streaming-json`) and `grok agent stdio` (ACP over newline-delimited JSON-RPC 2.0). ACP is rejected for the reason above. Therefore:

- **Slash commands** → a thin `.mjs` wrapper → `grok -p --output-format json` (always with `--no-auto-update` in automation). Stateless, one call per invocation; no broker or daemon.
- **MCP server** (`.mcp.json` at plugin root) exposing **`grok_search`** and **`grok_ask`** so Claude can consult Grok — especially live search — autonomously during its own work.

### Background jobs — lightweight

Detach a `grok -p` call using **Claude Code's own background-bash** (`run_in_background`). `/grok:status`, `/grok:result`, `/grok:cancel` are thin wrappers over the job's PID and a transient output file (the file is job plumbing, not a kept artifact — consistent with inline-only delivery). No persisted registry; if that proves insufficient it can be revisited in phase 2.

### Models

Configurable, allowlisted **default = Grok 4.5**, overridable per call (`--model`/`-m`) and via plugin config with Grok Composer 2.5 Fast as the only alternative.

As verified against the live Grok Build catalog on 2026-07-10, the supported IDs are `grok-4.5` and `grok-composer-2.5-fast`. Older IDs are intentionally deprecated by this plugin and rejected at the dispatcher and MCP boundaries.

`--effort` and `--reasoning-effort` are accepted as aliases and normalized to one `--reasoning-effort` CLI argument. Grok 4.5 supports low, medium, and high effort; Composer follows its server-provided configuration.

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

- **Language:** plain **`.mjs`** ES modules (matches the canonical plugin; no build step; trivial to fork/hand-edit). **Node 18+** — confirm against the installed `grok` (some peers require Node 20+).
- **Grok CLI:** install via xAI's curl bootstrap (`curl -fsSL https://x.ai/cli/install.sh | bash`), **not npm**. Auth via `XAI_API_KEY` or SuperGrok / X Premium Plus sign-in. Grok's own config lives at `~/.grok/config.toml` (project override `./.grok/config.toml`).
- **Plugin config:** version-controlled in-repo (default model, `safety` mode, search defaults). **Prompts/templates live in each skill's `SKILL.md`** — editable, committed, effective immediately (this is the "version-controlled prompts/config" the draft wanted).
- **Repo layout** (corrected to the real Claude Code plugin spec):

```
grok-plugin-cc/
├── .claude-plugin/
│   ├── plugin.json          # manifest — only `name` is strictly required
│   └── marketplace.json     # enables /plugin marketplace add ./ + /plugin install
├── skills/                  # /grok:* as skills (SKILL.md) — preferred over commands/
│   ├── review/SKILL.md
│   ├── ask/SKILL.md
│   ├── setup/SKILL.md
│   ├── status/SKILL.md
│   ├── result/SKILL.md
│   └── cancel/SKILL.md
├── agents/                  # grok-rescue subagent (PHASE 2)
├── scripts/lib/             # .mjs: grok wrapper, headless runner, job tracking, render
├── .mcp.json                # Grok-backed MCP server (grok_search / grok_ask)
├── hooks/hooks.json         # optional (e.g. SessionStart setup check)
├── config/                  # version-controlled plugin defaults (model, safety, search)
├── VISION.md                # this file
└── README.md                # install (grok curl + marketplace add) + unofficial disclaimer
```

- **Spec trap:** plugin-shipped **subagents cannot declare their own `mcpServers`/`hooks`/`permissionMode`** (silently ignored for security). The Grok MCP server therefore lives at the plugin root via `.mcp.json`, never inside a subagent.

## Distribution & Install

Personal in origin; **publicly released under [MIT](LICENSE)** on GitHub at [trevoraspencer/grok-plugin-cc](https://github.com/trevoraspencer/grok-plugin-cc).

1. **Install Grok Build:** `curl -fsSL https://x.ai/cli/install.sh | bash`; set `XAI_API_KEY` or sign in.
2. **Install the plugin:** `/plugin marketplace add trevoraspencer/grok-plugin-cc` then `/plugin install grok@grok-plugin-cc`. (To fork: `git clone` then `/plugin marketplace add ./grok-plugin-cc`. One-session try from a clone: `claude --plugin-dir ./grok-plugin-cc`. There is no bare `/plugin install <path>`.)

## Success Criteria (v1)

- `/grok:review` and `/grok:ask` work end-to-end against the real `grok` CLI, rendering output inline.
- `grok_search` MCP tool is callable by Claude autonomously mid-task.
- Background review (`--background`) plus `status`/`result`/`cancel` works on Claude Code's background-bash.
- `/grok:setup` correctly diagnoses a missing CLI or missing API key.
- Default model + per-call override and the `safety` mode are editable in-repo and take effect immediately.
- Fully local; install in under 5 minutes.

## References (verified)

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

- ~~Exact `-m` slug for the chosen default model; pin a fallback.~~ → Re-verified 2026-07-10: `grok-4.5` is the primary review/search model and `grok-composer-2.5-fast` is the fast alternative/fallback. All centralized in `config/defaults.json` and enforced by `scripts/lib/config.mjs`.
- ~~Node floor against the installed `grok` version.~~ → Node 18+ floor (built against Node 22; current compatibility re-verified with `grok` 0.2.93). `/grok:setup` warns below either floor.
- ~~Whether Grok's live search is on by default under `-p` or needs a flag.~~ → Live search is **on by default** under `-p`; `--disable-web-search` turns it off. Note: the search worker can transiently fail (exit 0, empty text, `stopReason: Cancelled`), so the wrapper treats an empty answer as a failure and retries once.
