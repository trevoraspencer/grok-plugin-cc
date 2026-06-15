import { test } from "node:test";
import assert from "node:assert/strict";

import { buildSetupReport } from "../scripts/lib/setup.mjs";
import { renderSetupReport } from "../scripts/lib/render.mjs";

const CONFIG = {
  default_model: "grok-composer-2.5-fast",
  search_model: "grok-build",
  fallback_model: "grok-build",
  safety: "permissive",
  web_search: true
};

test("setup: OK when grok present + auth present + node ok", () => {
  const report = buildSetupReport({
    grokVersion: "grok 0.2.51",
    hasAuth: true,
    config: CONFIG,
    nodeVersion: "v22.22.3"
  });
  assert.equal(report.ok, true);
  assert.equal(report.cliOk, true);
  assert.equal(report.verdict, "OK");
  assert.ok(report.checks.find((c) => c.name === "grok CLI" && c.status === "ok"));
  assert.ok(report.checks.find((c) => c.name === "models" && c.detail.includes("grok-composer-2.5-fast")));
  assert.equal(report.nextSteps.length, 0);
});

test("setup: CLI missing → fail status + curl install guidance (never npm) + non-OK", () => {
  const report = buildSetupReport({
    grokVersion: null,
    hasAuth: true,
    config: CONFIG,
    nodeVersion: "v22.22.3"
  });
  assert.equal(report.cliOk, false);
  assert.equal(report.ok, false);
  assert.ok(report.checks.find((c) => c.name === "grok CLI" && c.status === "fail"));
  assert.ok(report.nextSteps.some((s) => /curl -fsSL https:\/\/x\.ai\/cli\/install\.sh \| bash/.test(s)));
  assert.ok(!report.nextSteps.some((s) => /npm/i.test(s)));
});

test("setup: auth missing → auth-needed step and non-OK", () => {
  const report = buildSetupReport({
    grokVersion: "grok 0.2.51",
    hasAuth: false,
    config: CONFIG,
    nodeVersion: "v22.22.3"
  });
  assert.ok(report.checks.find((c) => c.name === "auth" && c.status === "warn"));
  assert.ok(report.nextSteps.some((s) => /XAI_API_KEY|sign in/i.test(s)));
  assert.equal(report.ok, false);
  assert.equal(report.cliOk, true); // CLI present, so exit code would still be 0
});

test("setup: old Node → warn + upgrade step", () => {
  const report = buildSetupReport({
    grokVersion: "grok 0.2.51",
    hasAuth: true,
    config: CONFIG,
    nodeVersion: "v16.0.0"
  });
  assert.ok(report.checks.find((c) => c.name === "Node.js" && c.status === "warn"));
  assert.ok(report.nextSteps.some((s) => /Upgrade Node/i.test(s)));
});

test("setup: report is JSON-serializable with the documented shape", () => {
  const report = buildSetupReport({
    grokVersion: "grok 0.2.51",
    hasAuth: true,
    config: CONFIG,
    nodeVersion: "v22.22.3"
  });
  const round = JSON.parse(JSON.stringify(report));
  assert.ok(Array.isArray(round.checks));
  for (const key of ["ok", "cliOk", "verdict", "checks", "nextSteps"]) {
    assert.ok(key in round, `missing key ${key}`);
  }
});

test("setup: renderSetupReport produces readable markdown without throwing on a broken env", () => {
  const report = buildSetupReport({ grokVersion: null, hasAuth: false, config: {}, nodeVersion: "v22.22.3" });
  const md = renderSetupReport(report);
  assert.ok(md.includes("# Grok setup"));
  assert.ok(md.includes("Status: issues found"));
  assert.ok(md.includes("Next steps:"));
});
