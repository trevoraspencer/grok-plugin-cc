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
