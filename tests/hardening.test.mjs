import { test } from "node:test";
import assert from "node:assert/strict";

import { buildGrokArgs, classifyGrokOutput } from "../scripts/lib/grok.mjs";
import { buildReviewPrompt } from "../scripts/lib/git.mjs";
import { renderResult } from "../scripts/lib/render.mjs";

test("hardening: special characters in a prompt pass through as one unescaped argv element", () => {
  // Because args are handed to spawn as argv (no shell), nothing here is
  // interpolated or needs escaping — the prompt arrives at grok byte-for-byte.
  const nasty = 'quote " backtick ` dollar $HOME semicolon ; pipe | newline\nrm -rf /';
  const args = buildGrokArgs({ prompt: nasty, model: "grok-4.5" });
  assert.ok(args.includes(`--single=${nasty}`));
  assert.equal(args.some((arg) => arg === nasty), false);
});

test("hardening: option-shaped prompts stay bound as values", () => {
  for (const prompt of ["--help", "--model=attacker", "-p", "--"]) {
    const args = buildGrokArgs({ prompt, model: "grok-4.5" });
    assert.equal(args[0], `--single=${prompt}`);
    assert.equal(args.includes(prompt), false);
  }
});

test("hardening: special characters in a diff survive into the review prompt", () => {
  const diff = 'const s = "$(rm -rf /)"; // backtick ` and pipe | and newline\nok';
  const prompt = buildReviewPrompt({ label: "working tree diff", diff });
  assert.ok(prompt.includes("$(rm -rf /)"));
  assert.ok(prompt.includes("backtick `"));
});

test("hardening: oversized diff is truncated with a note", () => {
  const big = "x".repeat(200 * 1024);
  const prompt = buildReviewPrompt({ label: "working tree diff", diff: big });
  assert.ok(prompt.includes("truncated"));
  assert.ok(prompt.length < big.length);
});

test("hardening: multi-byte diffs are truncated against the UTF-8 argv budget", () => {
  const prompt = buildReviewPrompt({
    label: "working tree diff",
    diff: "😀".repeat(100 * 1024)
  });
  assert.ok(prompt.includes("truncated"));
  assert.ok(Buffer.byteLength(prompt, "utf8") < 100 * 1024);
});

test("hardening: buildGrokArgs tolerates empty/missing prompt without throwing", () => {
  assert.doesNotThrow(() => buildGrokArgs({ prompt: "", model: "m" }));
  assert.doesNotThrow(() => buildGrokArgs({ model: "m" }));
});

test("hardening: malformed JSON on stdout is a clear error, not a crash", () => {
  const result = classifyGrokOutput({ stdout: "<<not json>>", code: 0 });
  assert.equal(result.ok, false);
  const md = renderResult(result);
  assert.ok(/Grok error/i.test(md));
});

test("hardening: a non-zero exit surfaces stderr, never a raw stack", () => {
  const result = classifyGrokOutput({ stdout: "", stderr: "authentication failed", code: 1 });
  assert.equal(result.ok, false);
  assert.equal(result.error, "authentication failed");
  assert.ok(!/at Object|node:internal/.test(renderResult(result)));
});

test("hardening: renderResult redacts credentials even for caller-constructed results", () => {
  const previous = process.env.XAI_API_KEY;
  process.env.XAI_API_KEY = "render-secret-value";
  try {
    assert.doesNotMatch(
      renderResult({
        ok: false,
        error: "render-secret-value",
        stderr: "Bearer another.secret/token"
      }),
      /render-secret-value|another\.secret/
    );
  } finally {
    if (previous === undefined) {
      delete process.env.XAI_API_KEY;
    } else {
      process.env.XAI_API_KEY = previous;
    }
  }
});
