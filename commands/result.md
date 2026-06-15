---
description: Print the captured output of a finished Grok background job
argument-hint: '<job-id>'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/grok.mjs" result "$ARGUMENTS"`

- Return the captured output verbatim. Do not summarize or add commentary.
- If the job is still running, tell the user to check `/grok:status` and try again shortly.
