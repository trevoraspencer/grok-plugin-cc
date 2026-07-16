---
description: Ask Grok a one-shot question, leaning on live web/X search (the headline differentiator)
argument-hint: '[--model <slug>] [--no-search|--search] [--max-turns <n>] [--effort <level>] [--reasoning-effort <level>] [--thought] [--background] [--print-args] <question>'
allowed-tools: Bash(node:*)
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
- The default model is the configured `search_model` (`grok-build`), which searches reliably. Override per call with `--model <slug>`.
- `--max-turns <n>` overrides the configured `max_turns` for this call. `--effort` and `--reasoning-effort` are forwarded to Grok and only affect models that support them.
- `--thought` includes Grok's returned reasoning in a collapsed details block.
- `--print-args` prints the exact Grok CLI argv and exits without calling Grok; it takes precedence over `--background`.
- This command is read-only — it only asks Grok a question and prints the answer.
