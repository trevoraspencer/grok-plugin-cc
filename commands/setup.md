---
description: Diagnose the Grok plugin — CLI presence, auth, resolved config, and Node version
argument-hint: '[--json] [--offline]'
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/grok.mjs *)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok.mjs" setup "$ARGUMENTS"
```

Present the report to the user.

`--json` emits the same report as structured JSON. The dispatcher exits nonzero when the Grok CLI is missing or the models check fails; missing auth and an old Node version are reported as warnings and next steps without changing the exit code.

`--offline` skips live CLI probes so CI and eval can run without Grok installed. It always exits 0, even when the CLI is missing. Do not pass `--offline` in a normal setup; it can hide a broken install.

If it reports that grok is **not installed**, the fix is the curl bootstrap (do NOT suggest `npm install` — grok is installed via curl):

```bash
curl -fsSL https://x.ai/cli/install.sh | bash
```

If grok is installed but **not authenticated**, tell the user to run `grok login` (or `grok login --device-auth`) or set `XAI_API_KEY`. The setup check validates the live CLI state, so a stale `~/.grok/auth.json` file does not count as authenticated. Never print the key value or any other credential value.
