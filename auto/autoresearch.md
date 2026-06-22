# Autoresearch Operating Manual

This file is the local operating manual for the production-readiness ratchet in this repository. It is intentionally explicit so a future agent can resume the run without relying on hidden chat context.

## Primary Goal

Make `grok-plugin-cc` more production-ready for a public, local-first Claude Code plugin release while preserving its current design constraints:

- Node 18+.
- Plain ES modules.
- Zero runtime dependencies.
- No build step.
- No live Grok calls in normal tests or eval gates.
- Safety-first behavior for anything write-capable.

The current run is constrained to five autoresearch cycles before human review.

## Composite Metric

The eval harness computes a 0-100 composite score:

```text
composite = tests * 0.40 + vision * 0.30 + robustnessDocsPerformance * 0.30
```

Component intent:

- `tests`: unit tests, syntax checks, command dry-runs, MCP smoke coverage.
- `vision`: alignment with `VISION.md` v1 goals and safe treatment of deferred phase-2 work.
- `robustnessDocsPerformance`: release readiness, docs, safety invariants, performance visibility, config hardening, and local tooling quality.

The mandatory pass/fail gates are stricter than the score. A candidate can improve optional score areas, but it must still pass the mandatory gates before it can be kept.

## Strict Rules

1. NEVER STOP mid-cycle. A cycle ends only after it is accepted and committed, or rejected, reverted, and logged.
2. Keep changes atomic. Each cycle should test one hypothesis.
3. Preserve zero runtime dependencies unless a later human explicitly changes that constraint.
4. Do not add live network or live Grok calls to `npm test`, `npm run check`, or `npm run eval`.
5. Never print, log, or snapshot secret values. Presence checks are allowed; values are not.
6. Do not weaken read-only command guarantees.
7. Do not change unrelated user work. If unrelated local edits appear, leave them alone and work around them.
8. Prefer characterization tests before behavior changes.
9. Commit every accepted cycle with a clear message.
10. Log every cycle in `auto/autoresearch.jsonl`.

## VISION Alignment

The repo's `VISION.md` defines v1 as a Grok-native, headless-plus-MCP Claude Code plugin:

- `/grok:ask`
- `/grok:review`
- `/grok:status`
- `/grok:result`
- `/grok:cancel`
- `/grok:setup`
- `grok_search` and `grok_ask` MCP tools
- version-controlled config
- no ACP
- no daemon
- no persisted answer artifacts

Phase-2 features such as `/grok:rescue`, `/grok:research`, adversarial review, image support, and a real job registry are eligible only when they are small, safe, tested, and improve the composite score. Write-capable work must preserve the documented `safety` direction.

## Git Keep/Revert Logic

Before each cycle:

1. Run `npm run eval`.
2. Record the baseline score and git status.
3. State the cycle hypothesis.

After implementation:

1. Run `npm run eval`.
2. Accept only if all mandatory gates pass and the composite score strictly improves.
3. If accepted, update `auto/autoresearch.jsonl` and commit all relevant changes.
4. If rejected, revert only the files touched by that cycle, log the rejection, and leave the branch clean.

Do not use destructive global resets when narrower file-level reversal is possible.

## Research Mandate

### Active Rerun: Codex-Only

For the `autoresearch-gpt55-xhigh-20260622-193805` rerun, do not invoke Grok Build, the Grok CLI, or Grok-backed MCP tools for research, reasoning, or code generation. The user explicitly requested dropping Grok Build and using the Codex session's GPT-only high-reasoning pass instead.

For this rerun:

1. Prefix substantive cycle reasoning with:

   ```text
   Using Codex GPT-only xhigh:
   ```

2. Do not run `node scripts/grok.mjs ask ...` as a research step.
3. Continue to run offline deterministic eval and benchmark commands.
4. Keep the same ratchet rule: accept only if mandatory gates pass and composite score strictly improves.
5. Log every cycle in `auto/autoresearch.jsonl` with no `research-fallback` entry unless a non-Grok local command unexpectedly fails.

### Previous Run: Grok Attempt

For heavy reasoning and code generation steps, prefix the reasoning update with:

```text
Using grok-build composer-2.5-fast:
```

Preferred flow:

1. Try a local dry model consultation through:
   `node scripts/grok.mjs ask --model grok-composer-2.5-fast --no-search "<prompt>"`
2. If the Grok CLI is missing, unauthenticated, blocked, slow, or otherwise unsuitable, record the fallback in `auto/autoresearch.jsonl`.
3. Continue in the same fast/reliable style without blocking the cycle.

Live web search is allowed only when a cycle genuinely needs current external facts. Normal eval and test commands must remain offline and deterministic.

## Cycle Log Schema

Each `auto/autoresearch.jsonl` line should be valid JSON with this shape:

```json
{
  "ts": "ISO-8601 timestamp",
  "cycle": 1,
  "event": "accepted|rejected|setup|research-fallback|final",
  "scoreBefore": 91.23,
  "scoreAfter": 92.10,
  "hypothesis": "one sentence",
  "checks": ["npm run eval"],
  "commit": "short sha or null",
  "notes": "short factual note"
}
```

Keep log entries concise and factual. The final report can summarize the rich detail.
