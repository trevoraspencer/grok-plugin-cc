# Release Checklist

Use this checklist before tagging or publishing `grok-plugin-cc`. It is scoped to the repo's current distribution model: a local-first Claude Code plugin installed from GitHub or a local clone, not an npm package.

## Release Gates

- Run `npm run eval` and require `mandatoryPass: true`.
- Run `npm test` and require all tests to pass.
- Run `npm run check` and require Node syntax checks to pass.
- Run `/grok:setup` in a real Claude Code session and confirm:
  - Grok CLI is detected.
  - Auth is present or the report gives safe auth guidance.
  - Node version is 18 or newer.
  - resolved `default_model`, `search_model`, and `fallback_model` match `config/defaults.json`.
- Smoke-test `/grok:ask --no-search "Say ok"` and confirm output is rendered inline.
- Smoke-test `/grok:review --scope working-tree --print-args` through the dispatcher and confirm the command stays read-only.
- Start one background ask or review job, then verify `/grok:status`, `/grok:result <job-id>`, and `/grok:cancel <job-id>` behavior as applicable.
- Start the MCP server with `node scripts/mcp-server.mjs`, send `initialize` and `tools/list`, and confirm `grok_search` plus `grok_ask` are listed.

## Safety Gates

- Confirm no command other than future phase-2 write-capable work edits files.
- Confirm `/grok:review` still tells the model not to rewrite code or act on findings.
- Confirm `scripts/lib/grok.mjs` is still the only production choke point for live Grok invocation.
- Confirm every automated Grok call includes `--no-auto-update`.
- Confirm no test, eval, or benchmark requires live network access.
- Confirm no code path prints `XAI_API_KEY`, auth file contents, or other secret values.

## Packaging Gates

- Confirm `.claude-plugin/plugin.json` has the intended plugin name, version, description, author, license, and homepage.
- Confirm `.claude-plugin/marketplace.json` points the `grok` plugin at `./`.
- Confirm `.mcp.json` references `${CLAUDE_PLUGIN_ROOT}/scripts/mcp-server.mjs`.
- Confirm `README.md` install instructions mention both GitHub marketplace install and local clone install.
- Confirm `LICENSE` is present and `package.json` license is `MIT`.
- Confirm `config/defaults.json` remains version-controlled and safe to edit.

## Documentation Gates

- README command table matches the command files in `commands/`.
- README configuration table matches `config/defaults.json`.
- README explains that Grok is installed with the xAI curl bootstrap, not npm.
- README explains that this plugin is unofficial and not affiliated with xAI.
- VISION.md remains a living design reference and any implemented phase-2 item is moved out of "deferred" language.

## Versioning Notes

- Keep the plugin manifest version and `package.json` version aligned for public release tags.
- Use a tag name such as `v0.1.0` for release checkpoints.
- If a release changes command behavior, include the command names in the release notes.
- If a release changes config keys, document migration behavior and defaults.

## Rollback Plan

- Keep the previous git tag available.
- If a release breaks install, revert plugin manifest or marketplace changes first.
- If a release breaks Grok invocation, revert changes touching `scripts/lib/grok.mjs` or dispatcher call construction.
- If a release breaks MCP behavior, revert changes touching `scripts/mcp-server.mjs` or `.mcp.json`.
