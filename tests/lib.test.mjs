import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseArgs } from "../scripts/lib/args.mjs";
import {
  resolveModel,
  loadConfig,
  normalizeConfig,
  SUPPORTED_MODELS,
  configuredModelIssues
} from "../scripts/lib/config.mjs";
import {
  buildGrokArgs,
  parseGrokJson,
  classifyGrokOutput,
  runGrok,
  DEFAULT_GROK_TIMEOUT_MS,
  DEFAULT_GROK_MAX_OUTPUT_BYTES
} from "../scripts/lib/grok.mjs";
import { renderResult, truncate } from "../scripts/lib/render.mjs";

const GROK_PROCESS_FIXTURE = fileURLToPath(new URL("./fixtures/grok-process-fixture.mjs", import.meta.url));

async function withGrokFixture(mode, callback) {
  const previousBin = process.env.GROK_BIN;
  const previousMode = process.env.GROK_TEST_FIXTURE_MODE;
  const previousBytes = process.env.GROK_TEST_FIXTURE_BYTES;
  process.env.GROK_BIN = GROK_PROCESS_FIXTURE;
  process.env.GROK_TEST_FIXTURE_MODE = mode;
  try {
    return await callback();
  } finally {
    for (const [key, value] of [
      ["GROK_BIN", previousBin],
      ["GROK_TEST_FIXTURE_MODE", previousMode],
      ["GROK_TEST_FIXTURE_BYTES", previousBytes]
    ]) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test("args: parses value options, booleans, and positionals", () => {
  const cfg = { valueOptions: ["model"], booleanOptions: ["no-search"], aliasMap: { m: "model" } };
  const { options, positionals } = parseArgs(["-m", "grok-4.5", "--no-search", "hello", "world"], cfg);
  assert.equal(options.model, "grok-4.5");
  assert.equal(options["no-search"], true);
  assert.deepEqual(positionals, ["hello", "world"]);
});

test("args: -- passes the remainder through as positionals", () => {
  const { positionals } = parseArgs(["a", "--", "-m", "b"], { valueOptions: ["m"] });
  assert.deepEqual(positionals, ["a", "-m", "b"]);
});

test("config: resolveModel precedence is explicit > kind > fallback", () => {
  const config = {
    default_model: "grok-4.5",
    search_model: "grok-4.5",
    fallback_model: "grok-composer-2.5-fast"
  };
  assert.equal(resolveModel({ explicit: "grok-composer-2.5-fast", kind: "default", config }), "grok-composer-2.5-fast");
  assert.equal(resolveModel({ kind: "default", config }), "grok-4.5");
  assert.equal(resolveModel({ kind: "search", config }), "grok-4.5");
  assert.equal(resolveModel({ kind: "default", config: { fallback_model: "grok-composer-2.5-fast" } }), "grok-composer-2.5-fast");
  assert.equal(resolveModel({ kind: "default", config: {} }), "grok-4.5");
});

test("config: only the current Grok Build catalog is supported", () => {
  assert.deepEqual(SUPPORTED_MODELS, ["grok-4.5", "grok-composer-2.5-fast"]);
  assert.throws(() => resolveModel({ explicit: "grok-build" }), /deprecated/i);
  assert.throws(() => resolveModel({ explicit: "grok-4.3" }), /supported models/i);
  assert.deepEqual(configuredModelIssues({ default_model: "grok-build" }), ["default_model=grok-build"]);
});

test("config: loadConfig returns the documented defaults", () => {
  const config = loadConfig();
  assert.equal(config.default_model, "grok-4.5");
  assert.equal(config.search_model, "grok-4.5");
  assert.equal(config.fallback_model, "grok-composer-2.5-fast");
  assert.equal(config.safety, "permissive");
  assert.equal(config.web_search, true);
  assert.equal(config.timeout_ms, 900_000);
});

test("config: no_auto_update is NOT an advertised knob (--no-auto-update is always-on)", () => {
  // The flag is non-negotiable for headless safety, so it must not appear as a
  // configurable key that a user could (ineffectively) try to turn off.
  assert.equal("no_auto_update" in loadConfig(), false);
  // and buildGrokArgs always emits it
  assert.ok(buildGrokArgs({ prompt: "x", model: "m" }).includes("--no-auto-update"));
});

test("config: normalizeConfig keeps well-formed local overrides and drops unknown keys", () => {
  const config = normalizeConfig({
    default_model: " grok-composer-2.5-fast ",
    search_model: " grok-4.5 ",
    fallback_model: " grok-composer-2.5-fast ",
    safety: "preview",
    web_search: false,
    max_turns: 4,
    timeout_ms: 120_000,
    no_auto_update: false
  });
  assert.equal(config.default_model, "grok-composer-2.5-fast");
  assert.equal(config.search_model, "grok-4.5");
  assert.equal(config.fallback_model, "grok-composer-2.5-fast");
  assert.equal(config.safety, "preview");
  assert.equal(config.web_search, false);
  assert.equal(config.max_turns, 4);
  assert.equal(config.timeout_ms, 120_000);
  assert.equal("no_auto_update" in config, false);
});

test("config: invalid local overrides fall back to shipped defaults", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-config-"));
  try {
    fs.mkdirSync(path.join(dir, ".grok"));
    fs.writeFileSync(
      path.join(dir, ".grok", "grok-plugin.json"),
      JSON.stringify({
        default_model: " grok-composer-2.5-fast ",
        search_model: "",
        fallback_model: 42,
        safety: "dangerous",
        web_search: "false",
        max_turns: "10",
        timeout_ms: Number.MAX_SAFE_INTEGER,
        no_auto_update: false
      })
    );
    const config = loadConfig({ cwd: dir });
    assert.equal(config.default_model, "grok-composer-2.5-fast");
    assert.equal(config.search_model, "grok-4.5");
    assert.equal(config.fallback_model, "grok-composer-2.5-fast");
    assert.equal(config.safety, "permissive");
    assert.equal(config.web_search, true);
    assert.equal(config.max_turns, null);
    assert.equal(config.timeout_ms, 900_000);
    assert.equal("no_auto_update" in config, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("grok: buildGrokArgs yields the basic-ask shape", () => {
  const args = buildGrokArgs({ prompt: "hi", model: "grok-4.5" });
  assert.ok(args.includes("-p"));
  assert.ok(args.includes("hi"));
  assert.ok(args.includes("--output-format"));
  assert.ok(args.includes("json"));
  assert.ok(args.includes("-m"));
  assert.ok(args.includes("grok-4.5"));
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
  assert.ok(args.includes("--reasoning-effort"));
  assert.ok(!args.includes("--effort"));
  assert.equal(args[args.indexOf("--reasoning-effort") + 1], "high");
  assert.ok(args.includes("--max-turns"));
  assert.equal(args[args.indexOf("--max-turns") + 1], "3");
});

test("grok: --reasoning-effort wins when both aliases are supplied", () => {
  const args = buildGrokArgs({ prompt: "x", model: "m", effort: "low", reasoningEffort: "high" });
  assert.equal(args.filter((arg) => arg === "--reasoning-effort").length, 1);
  assert.equal(args[args.indexOf("--reasoning-effort") + 1], "high");
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

test("grok: live calls use conservative bounded defaults", () => {
  assert.equal(DEFAULT_GROK_TIMEOUT_MS, 15 * 60 * 1000);
  assert.equal(DEFAULT_GROK_MAX_OUTPUT_BYTES, 4 * 1024 * 1024);
});

test("grok: runGrok terminates a timed-out child with actionable guidance", async () => {
  await withGrokFixture("hang", async () => {
    let childPid;
    const startedAt = Date.now();
    const result = await runGrok({
      prompt: "offline timeout fixture",
      retries: 0,
      timeoutMs: 250,
      onSpawn: (child) => {
        childPid = child.pid;
      }
    });

    assert.equal(result.ok, false);
    assert.equal(result.attempts, 1);
    assert.equal(result.transient, false);
    assert.match(result.error, /timed out after 250 ms/i);
    assert.match(result.error, /timeout_ms/);
    const elapsedMs = Date.now() - startedAt;
    assert.ok(elapsedMs >= 1000, "timeout fixture should exercise the SIGKILL grace-period fallback");
    assert.ok(elapsedMs < 3000, "timed-out fixture should be terminated promptly");
    assert.throws(() => process.kill(childPid, 0), (error) => error?.code === "ESRCH");
  });
});

test("grok: runGrok terminates output that exceeds the combined capture cap", async () => {
  await withGrokFixture("oversized-output", async () => {
    process.env.GROK_TEST_FIXTURE_BYTES = "65536";
    const result = await runGrok({
      prompt: "offline output fixture",
      retries: 0,
      timeoutMs: 2000,
      maxOutputBytes: 1024
    });

    assert.equal(result.ok, false);
    assert.equal(result.attempts, 1);
    assert.equal(result.transient, false);
    assert.equal(result.raw, null);
    assert.equal(result.text, "");
    assert.match(result.error, /exceeded the 1024-byte combined capture limit/i);
    assert.match(result.error, /reduce the requested output or max turns/i);
  });
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
