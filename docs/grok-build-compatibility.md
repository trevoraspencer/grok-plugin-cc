# Grok Build compatibility audit — July 2026

Audit window: the repository's previous change on July 5, 2026 through July 10, 2026. Sources are xAI's [Grok Build changelog](https://x.ai/build/changelog), [headless scripting reference](https://docs.x.ai/build/cli/headless-scripting), [CLI reference](https://docs.x.ai/build/cli/reference), and [Grok 4.5 documentation](https://docs.x.ai/developers/grok-4-5).

## Changelog assessment

| Release | Date | Plugin relevance and decision |
| --- | --- | --- |
| 0.2.87 | Jul 5 | Server-configurable per-model effort menus and more tolerant custom model blocks do not change the headless contract. The plugin now validates its own allowlisted model configuration explicitly. |
| 0.2.88 | Jul 6 | Session search, rendering, plugin-update UI, and history fixes are TUI-only for this integration. No wrapper change required. |
| 0.2.89 | Jul 7 | `--effort` and `--reasoning-effort` became interchangeable. The wrapper now accepts both but emits one canonical `--reasoning-effort`, with the long form winning if both are supplied. |
| 0.2.90 | Jul 7 | `grok models` improved credential/catalog reporting and refresh behavior. `/grok:setup` now probes this command to detect stale auth and verify the two expected model IDs. Local Grok marketplace support is unrelated to installing this Claude Code plugin. |
| 0.2.91 | Jul 7 | Voice/worktree dialog changes are TUI-only. No wrapper change required. |
| 0.2.92 | Jul 8 | Minimal/fullscreen, ask-user configuration, shell-output, and permission fixes do not alter this read-only one-shot wrapper. No change required. |
| 0.2.93 | Jul 8 | TUI, MCP permission display, plugin listing, and `--no-ask-user` subagent changes do not alter `grok -p` JSON output. This is the stable version used for live validation. |
| 0.2.94 | Jul 9 | `grok inspect` labeling and ACP client fixes do not affect the headless wrapper or its MCP server. The release was present in the changelog but the stable updater still reported 0.2.93 as current during the audit. |

## Model decision

Grok 4.5 launched July 8 with model ID `grok-4.5`, became Grok Build's default model, and supports function calling plus web and X search. The live `grok models` catalog returned exactly:

- `grok-4.5`
- `grok-composer-2.5-fast`

Version 0.2.0 of this plugin therefore exposes only those IDs. `grok-4.5` is the default for review, ask, and search; Composer 2.5 Fast is the optional fast model and fallback. Legacy/custom IDs are rejected at both dispatcher and MCP boundaries.

## Headless contract

The current official scripting contract remains compatible with the existing architecture:

```text
grok -p <prompt> --output-format json --no-auto-update
```

`--disable-web-search`, `--max-turns`, `--model`, and reasoning effort remain supported. ACP is still unnecessary because Claude Code calls Grok for stateless one-shot work. Live validation must cover the JSON response envelope, web search, both supported models, MCP tool invocation, and a freshly installed Claude Code plugin.
