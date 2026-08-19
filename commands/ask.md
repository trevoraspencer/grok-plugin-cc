---
description: Ask Grok a one-shot question, leaning on live web/X search (the headline differentiator)
argument-hint: '[--model <slug>] [--no-search|--search] [--max-turns <n>] [--effort <level>] [--reasoning-effort <level>] [--thought] [--background] [--print-args] <question>'
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/grok.mjs *)
disallowed-tools: Edit, Write, NotebookEdit
disable-model-invocation: true
---

Ask Grok a one-shot question.

Raw slash-command arguments:
`$ARGUMENTS`

Execution mode:
- If the raw arguments include `--background`, use the background flow.
- Otherwise use the foreground flow.

Foreground flow:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok.mjs" ask "$ARGUMENTS"
```
- Return the command stdout verbatim — do not summarize, paraphrase, or add commentary before or after it.
- Preserve any inline markdown citation links Grok includes.

Background flow:
- Launch with `Bash` in the background:
```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/grok.mjs" ask "$ARGUMENTS"`,
  description: "Grok ask",
  run_in_background: true
})
```
- Do not wait for completion in this turn. The command prints a job id immediately; tell the user: "Grok ask started in the background. Check `/grok:status` for progress, then `/grok:result <job-id>` for the answer."

Notes:
- Grok answers with live web/X search **on by default** (the main reason to reach for Grok mid-task), following the `web_search` config setting. Pass `--no-search` to disable it for one call, or `--search` to force it on.
- The default model is the configured `search_model` (`grok-4.5`). `--model` accepts only `grok-4.5` or `grok-composer-2.5-fast`; legacy IDs such as `grok-build` are deprecated and rejected.
- `--max-turns <n>` overrides the configured `max_turns` for this call. `--effort` and `--reasoning-effort` are aliases sent as one canonical `--reasoning-effort=<value>` argument; supplying both is rejected as ambiguous.
- `--thought` includes Grok's returned reasoning in a collapsed details block.
- `--print-args` prints the exact Grok CLI argv and exits without calling Grok; it takes precedence over `--background`.
- The Grok child is read-only: every invocation disables subagents and memory and denies Grok's Bash, Edit, Read, Grep, and MCP workspace tools.
