---
description: Cancel a running Grok background job
argument-hint: '<job-id>'
disable-model-invocation: true
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/grok.mjs *)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/grok.mjs" cancel "$ARGUMENTS"`

- Confirm the cancellation to the user.
- Suggest `/grok:status` to see the updated queue.
