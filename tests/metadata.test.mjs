import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readText(file) {
  return fs.readFileSync(path.join(ROOT, file), "utf8");
}

function readJson(file) {
  return JSON.parse(readText(file));
}

test("metadata: package and plugin manifests stay release-ready", () => {
  const pkg = readJson("package.json");
  const plugin = readJson(".claude-plugin/plugin.json");

  assert.equal(pkg.name, "grok-plugin-cc");
  assert.equal(pkg.private, true);
  assert.equal(pkg.type, "module");
  assert.equal(pkg.license, "MIT");
  assert.equal(pkg.engines.node, ">=18");
  assert.deepEqual(pkg.dependencies || {}, {});
  assert.equal(plugin.name, "grok");
  assert.equal(plugin.version, pkg.version);
  assert.equal(plugin.license, pkg.license);
  assert.match(plugin.homepage, /^https:\/\/github\.com\/trevoraspencer\/grok-plugin-cc/);
});

test("metadata: marketplace and MCP config point at local plugin entrypoints", () => {
  const marketplace = readJson(".claude-plugin/marketplace.json");
  const mcp = readJson(".mcp.json");

  const grokPlugin = marketplace.plugins.find((plugin) => plugin.name === "grok");
  assert.ok(grokPlugin, "marketplace should publish the grok plugin");
  assert.equal(grokPlugin.source, "./");
  assert.equal(mcp.mcpServers.grok.command, "node");
  assert.deepEqual(mcp.mcpServers.grok.args, ["${CLAUDE_PLUGIN_ROOT}/scripts/mcp-server.mjs"]);
});

test("metadata: release checklist covers gates, docs, versioning, and rollback", () => {
  const checklist = readText("auto/release-checklist.md");

  for (const heading of [
    "## Release Gates",
    "## Safety Gates",
    "## Packaging Gates",
    "## Documentation Gates",
    "## Versioning Notes",
    "## Rollback Plan"
  ]) {
    assert.ok(checklist.includes(heading), `missing ${heading}`);
  }
});

test("metadata: README documents offline eval and benchmark development flow", () => {
  const readme = readText("README.md");

  assert.ok(readme.includes("npm run eval"));
  assert.ok(readme.includes("npm run bench"));
  assert.ok(readme.includes("node --test"));
  assert.match(readme, /offline by design/i);
  assert.match(readme, /without making live Grok or web-search calls/i);
});

test("metadata: benchmark helper stays deterministic and dispatcher-only", () => {
  const benchmark = readText("auto/benchmark.mjs");

  assert.ok(benchmark.includes("BENCH_ITERATIONS"));
  assert.ok(benchmark.includes("--print-args"));
  assert.ok(benchmark.includes("setup_json"));
  assert.ok(benchmark.includes("never calls live Grok"));
  assert.ok(!benchmark.includes("runGrok("));
});

test("metadata: eval harness tracks mandatory gates and composite formula", () => {
  const harness = readText("auto/eval-harness.mjs");

  assert.ok(harness.includes("0.40*tests + 0.30*vision + 0.30*robustnessDocsPerformance"));
  assert.ok(harness.includes("mandatory_npm_test"));
  assert.ok(harness.includes("mandatory_npm_check"));
  assert.ok(harness.includes("mandatory_dry_runs"));
  assert.ok(harness.includes("mandatory_mcp_smoke"));
  assert.ok(harness.includes("mandatory_metadata_json"));
  assert.ok(harness.includes("testCount / 90"));
});

test("metadata: autoresearch log remains valid JSONL for the GPT-only rerun", () => {
  const entries = readText("auto/autoresearch.jsonl")
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line));
  const setupIndex = entries.findIndex((entry) => entry.hypothesis === "Start GPT-only rerun without Grok Build consultation.");

  assert.ok(setupIndex >= 0, "expected GPT-only setup entry");
  for (const entry of entries.slice(setupIndex)) {
    assert.match(entry.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    assert.ok(Array.isArray(entry.checks));
    assert.notEqual(entry.event, "research-fallback");
  }
});

test("metadata: active autoresearch manual forbids Grok consultation in this rerun", () => {
  const manual = readText("auto/autoresearch.md");
  const activeSection = manual.split("### Active Rerun: Codex-Only")[1].split("### Previous Run: Grok Attempt")[0];

  assert.ok(activeSection.includes("do not invoke Grok Build"));
  assert.ok(activeSection.includes("Do not run `node scripts/grok.mjs ask ...`"));
  assert.ok(activeSection.includes("Using Codex GPT-only xhigh:"));
  assert.ok(activeSection.includes("no `research-fallback` entry unless a non-Grok local command unexpectedly fails"));
});

test("metadata: release checklist preserves safety gates for secrets and live calls", () => {
  const checklist = readText("auto/release-checklist.md");

  assert.ok(checklist.includes("Confirm no test, eval, or benchmark requires live network access."));
  assert.ok(checklist.includes("Confirm no code path prints `XAI_API_KEY`, auth file contents, or other secret values."));
  assert.ok(checklist.includes("Confirm every automated Grok call includes `--no-auto-update`."));
  assert.ok(checklist.includes("Confirm `/grok:review` still tells the model not to rewrite code or act on findings."));
});

test("metadata: release checklist preserves packaging and install gates", () => {
  const checklist = readText("auto/release-checklist.md");

  assert.ok(checklist.includes("Confirm `.claude-plugin/plugin.json` has the intended plugin name"));
  assert.ok(checklist.includes("Confirm `.claude-plugin/marketplace.json` points the `grok` plugin at `./`."));
  assert.ok(checklist.includes('Confirm `.mcp.json` references `${CLAUDE_PLUGIN_ROOT}/scripts/mcp-server.mjs`.'));
  assert.ok(checklist.includes("Confirm `README.md` install instructions mention both GitHub marketplace install and local clone install."));
});

test("metadata: benchmark cases cover ask, review, and setup dispatcher paths", () => {
  const benchmark = readText("auto/benchmark.mjs");

  assert.ok(benchmark.includes('id: "ask_print_args_no_search"'));
  assert.ok(benchmark.includes('id: "review_print_args_empty_branch_diff"'));
  assert.ok(benchmark.includes('id: "setup_json"'));
  assert.ok(benchmark.includes('"review"'));
  assert.ok(benchmark.includes('"--print-args --scope branch --base HEAD"'));
});

test("metadata: eval harness optional checks cover production-readiness artifacts", () => {
  const harness = readText("auto/eval-harness.mjs");

  for (const checkId of [
    "release_checklist",
    "benchmark_script",
    "bench_package_script",
    "readme_eval_docs",
    "readme_bench_docs",
    "command_contract_tests",
    "metadata_tests",
    "mcp_schema_strict",
    "config_validation",
    "config_validation_tests"
  ]) {
    assert.ok(harness.includes(checkId), `missing optional check ${checkId}`);
  }
});
