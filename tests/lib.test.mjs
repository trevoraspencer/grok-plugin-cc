import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { parseArgs } from "../scripts/lib/args.mjs";
import { resolveModel, loadConfig, normalizeConfig } from "../scripts/lib/config.mjs";
import { buildGrokArgs, parseGrokJson, classifyGrokOutput, runGrok } from "../scripts/lib/grok.mjs";
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

test("config: normalizeConfig keeps valid local overrides and drops unknown keys", () => {
  const config = normalizeConfig({
    default_model: " custom-default ",
    search_model: " custom-search ",
    fallback_model: " custom-fallback ",
    safety: "preview",
    web_search: false,
    max_turns: 4,
    no_auto_update: false
  });
  assert.equal(config.default_model, "custom-default");
  assert.equal(config.search_model, "custom-search");
  assert.equal(config.fallback_model, "custom-fallback");
  assert.equal(config.safety, "preview");
  assert.equal(config.web_search, false);
  assert.equal(config.max_turns, 4);
  assert.equal("no_auto_update" in config, false);
});

test("config: invalid local overrides fall back to shipped defaults", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-config-"));
  try {
    fs.mkdirSync(path.join(dir, ".grok"));
    fs.writeFileSync(
      path.join(dir, ".grok", "grok-plugin.json"),
      JSON.stringify({
        default_model: " local-default ",
        search_model: "",
        fallback_model: 42,
        safety: "dangerous",
        web_search: "false",
        max_turns: "10",
        no_auto_update: false
      })
    );
    const config = loadConfig({ cwd: dir });
    assert.equal(config.default_model, "local-default");
    assert.equal(config.search_model, "grok-build");
    assert.equal(config.fallback_model, "grok-build");
    assert.equal(config.safety, "permissive");
    assert.equal(config.web_search, true);
    assert.equal(config.max_turns, null);
    assert.equal("no_auto_update" in config, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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

test("grok: runGrok exposes each spawned child via onSpawn (pid recordable)", async () => {
  // Point GROK_BIN at node itself: it rejects grok's flags and exits fast,
  // which is a deterministic offline failure — no retry (not transient), and
  // onSpawn must have fired exactly once with a real child pid.
  const previous = process.env.GROK_BIN;
  process.env.GROK_BIN = process.execPath;
  try {
    const pids = [];
    const result = await runGrok({ prompt: "hi", retries: 0, onSpawn: (child) => pids.push(child.pid) });
    assert.equal(pids.length, 1);
    assert.ok(Number.isInteger(pids[0]) && pids[0] > 0);
    assert.equal(result.ok, false);
  } finally {
    if (previous === undefined) {
      delete process.env.GROK_BIN;
    } else {
      process.env.GROK_BIN = previous;
    }
  }
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
