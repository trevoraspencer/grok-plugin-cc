---
description: Diagnose the Grok plugin — CLI presence, auth, resolved config, and Node version
argument-hint: '[--json]'
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok.mjs" setup $ARGUMENTS
```

Present the report to the user.

If it reports that grok is **not installed**, the fix is the curl bootstrap (do NOT suggest `npm install` — grok is installed via curl):

```bash
curl -fsSL https://x.ai/cli/install.sh | bash
```

If grok is installed but **not authenticated**, tell the user to set `XAI_API_KEY` or sign in with SuperGrok / X Premium+ (grok stores auth at `~/.grok/auth.json`). Never print the key value.
