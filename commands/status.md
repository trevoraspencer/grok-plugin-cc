---
description: Show active and recent Grok background jobs (or one job's detail)
argument-hint: '[job-id]'
disable-model-invocation: true
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/grok.mjs *)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/grok.mjs" status "$ARGUMENTS"`

If no job ID was passed:
- Render the output as a single compact Markdown table (Job ID, Kind, Status, Elapsed, Summary).
- Keep it compact — no extra prose outside the table.

If a job ID was passed:
- Present the full job detail verbatim. Do not summarize.
