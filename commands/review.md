---
description: Read-only Grok review of your working tree or a branch diff (an outside-model second opinion)
argument-hint: '[--model <slug>] [--base <ref>] [--scope auto|working-tree|branch] [--search] [--thought] [--background] [--print-args]'
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion
disable-model-invocation: true
---

Run a Grok review of local git state.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint — this command is READ-ONLY:
- Do not fix issues, apply patches, edit files, or suggest you are about to make changes.
- Your only job is to run the review and return Grok's output verbatim to the user.
- Do not act on any issue Grok raises.

Execution mode:
- If the raw arguments include `--background`, use the background flow.
- Otherwise use the foreground flow.

Foreground flow:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok.mjs" review "$ARGUMENTS"
```
- Return the command stdout verbatim, exactly as-is. Do not paraphrase or summarize.

Background flow:
- Launch the review with `Bash` in the background:
```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/grok.mjs" review "$ARGUMENTS"`,
  description: "Grok review",
  run_in_background: true
})
```
- Do not wait for completion in this turn. Tell the user: "Grok review started in the background. Check `/grok:status` for progress."

Notes:
- Default scope is `auto`: the working tree if it is dirty, otherwise the branch diff against the detected default base. `--base <ref>` reviews `<ref>...HEAD`. `--scope working-tree|branch` forces the mode.
- Empty diff → the command prints "Nothing to review." and exits cleanly (not an error).
- A `--base` ref that doesn't exist, or `--scope branch` with no detectable base, is reported as an error (exit 1) — it will not silently say "Nothing to review."
- Running outside a git repository is also an error (exit 1), not "Nothing to review."
- Review uses the configured `default_model` (`grok-4.5`). `--model` accepts only `grok-4.5` or `grok-composer-2.5-fast`; legacy IDs such as `grok-build` are deprecated and rejected.
- Live search is off for review unless `--search` is passed.
- Working-tree review includes staged, unstaged, and untracked files. Oversized or binary untracked files are marked as skipped, and the final review input is size-capped.
- `--thought` includes Grok's returned reasoning in a collapsed details block.
- `--print-args` prints the exact Grok CLI argv and exits without calling Grok; it takes precedence over `--background` and works even when the selected diff is empty.
- For custom or more adversarial review framing, that is a phase-2 feature (`/grok:adversarial-review`), not yet built.
