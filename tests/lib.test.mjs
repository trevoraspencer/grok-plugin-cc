import { test } from "node:test";
import assert from "node:assert/strict";

import { parseArgs, splitRawArgumentString } from "../scripts/lib/args.mjs";
import { resolveModel, loadConfig } from "../scripts/lib/config.mjs";
import { buildGrokArgs, parseGrokJson, classifyGrokOutput } from "../scripts/lib/grok.mjs";
import { renderResult, truncate } from "../scripts/lib/render.mjs";

test("args: parses value options, booleans, and positionals", () => {
  const cfg = { valueOptions: ["model"], booleanOptions: ["no-search"], aliasMap: { m: "model" } };
  const { options, positionals } = parseArgs(["-m", "grok-build", "--no-search", "hello", "world"], cfg);
  assert.equal(options.model, "grok-build");
  assert.equal(options["no-search"], true);
  assert.deepEqual(positionals, ["hello", "world"]);
});

test("args: -- passes the remainder through as positionals", () => {
  const { positionals } = parseArgs(["a", "--", "-m", "b"], { valueOptions: ["m"] });
  assert.deepEqual(positionals, ["a", "-m", "b"]);
});

test("args: splitRawArgumentString honors quotes", () => {
  assert.deepEqual(splitRawArgumentString('ask "two words" plain'), ["ask", "two words", "plain"]);
});

test("config: resolveModel precedence is explicit > kind > fallback", () => {
  const config = {
    default_model: "grok-composer-2.5-fast",
    search_model: "grok-build",
    fallback_model: "grok-build"
  };
  assert.equal(resolveModel({ explicit: "x", kind: "default", config }), "x");
  assert.equal(resolveModel({ kind: "default", config }), "grok-composer-2.5-fast");
  assert.equal(resolveModel({ kind: "search", config }), "grok-build");
  assert.equal(resolveModel({ kind: "default", config: { fallback_model: "grok-build" } }), "grok-build");
  assert.equal(resolveModel({ kind: "default", config: {} }), "grok-build");
});

test("config: loadConfig returns the documented defaults", () => {
  const config = loadConfig();
  assert.equal(config.default_model, "grok-composer-2.5-fast");
  assert.equal(config.search_model, "grok-build");
  assert.equal(config.fallback_model, "grok-build");
  assert.equal(config.safety, "permissive");
  assert.equal(config.web_search, true);
});

test("config: no_auto_update is NOT an advertised knob (--no-auto-update is always-on)", () => {
  // The flag is non-negotiable for headless safety, so it must not appear as a
  // configurable key that a user could (ineffectively) try to turn off.
  assert.equal("no_auto_update" in loadConfig(), false);
  // and buildGrokArgs always emits it
  assert.ok(buildGrokArgs({ prompt: "x", model: "m" }).includes("--no-auto-update"));
});

test("grok: buildGrokArgs yields the basic-ask shape", () => {
  const args = buildGrokArgs({ prompt: "hi", model: "grok-build" });
  assert.ok(args.includes("-p"));
  assert.ok(args.includes("hi"));
  assert.ok(args.includes("--output-format"));
  assert.ok(args.includes("json"));
  assert.ok(args.includes("-m"));
  assert.ok(args.includes("grok-build"));
  assert.ok(args.includes("--no-auto-update"));
  assert.ok(!args.includes("--disable-web-search"));
  // -p must be immediately followed by the prompt
  assert.equal(args[args.indexOf("-p") + 1], "hi");
});

test("grok: buildGrokArgs adds --disable-web-search only when webSearch===false", () => {
  assert.ok(buildGrokArgs({ prompt: "hi", model: "m", webSearch: false }).includes("--disable-web-search"));
  assert.ok(!buildGrokArgs({ prompt: "hi", model: "m", webSearch: true }).includes("--disable-web-search"));
  assert.ok(!buildGrokArgs({ prompt: "hi", model: "m" }).includes("--disable-web-search"));
});

test("grok: buildGrokArgs adds optional flags when provided", () => {
  const args = buildGrokArgs({ prompt: "x", model: "m", effort: "high", maxTurns: 3 });
  assert.ok(args.includes("--effort"));
  assert.equal(args[args.indexOf("--effort") + 1], "high");
  assert.ok(args.includes("--max-turns"));
  assert.equal(args[args.indexOf("--max-turns") + 1], "3");
});

test("grok: parseGrokJson tolerates surrounding noise", () => {
  const { parsed } = parseGrokJson('noise\n{"text":"hello","thought":"t"}\ntrailing');
  assert.equal(parsed.text, "hello");
  const empty = parseGrokJson("");
  assert.equal(empty.parsed, null);
});

test("grok: classifyGrokOutput marks a real answer ok", () => {
  const r = classifyGrokOutput({ stdout: '{"text":"hello","stopReason":"EndTurn"}', code: 0 });
  assert.equal(r.ok, true);
  assert.equal(r.text, "hello");
  assert.equal(r.transient, false);
});

test("grok: classifyGrokOutput flags empty+Cancelled as a transient failure", () => {
  const r = classifyGrokOutput({
    stdout: '{"text":"","stopReason":"Cancelled","thought":"x"}',
    stderr: "ERROR worker quit with fatal: Transport channel closed, when Auth(AuthorizationRequired)",
    code: 0
  });
  assert.equal(r.ok, false);
  assert.equal(r.transient, true);
  assert.match(r.error, /no answer/i);
});

test("grok: classifyGrokOutput surfaces non-zero exit as failure", () => {
  const r = classifyGrokOutput({ stdout: "", stderr: "boom", code: 2 });
  assert.equal(r.ok, false);
  assert.equal(r.error, "boom");
});

test("grok: classifyGrokOutput reports a parse failure", () => {
  const r = classifyGrokOutput({ stdout: "not json at all", code: 0 });
  assert.equal(r.ok, false);
  assert.match(r.error, /parse/i);
});

test("render: renderResult includes text and renders an error block", () => {
  const ok = renderResult({ ok: true, text: "hello", thought: "t" });
  assert.ok(ok.includes("hello"));
  const err = renderResult({ ok: false, error: "boom" });
  assert.ok(/boom/.test(err));
  assert.ok(/error/i.test(err));
});

test("render: showThought adds a reasoning footer", () => {
  const out = renderResult({ ok: true, text: "body", thought: "deep" }, { showThought: true });
  assert.ok(out.includes("Reasoning"));
  assert.ok(out.includes("deep"));
  // default omits the footer
  assert.ok(!renderResult({ ok: true, text: "body", thought: "deep" }).includes("Reasoning"));
});

test("render: truncate caps length and notes it", () => {
  const long = "a".repeat(50);
  const capped = truncate(long, 10);
  assert.ok(capped.startsWith("aaaaaaaaaa"));
  assert.ok(capped.includes("truncated"));
  assert.equal(truncate("short", 10), "short");
});
