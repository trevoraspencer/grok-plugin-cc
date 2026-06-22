#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const AUTO_DIR = path.join(ROOT, "auto");
const LAST_RESULT = path.join(AUTO_DIR, "eval-last.json");

function rel(file) {
  return path.relative(ROOT, file);
}

function exists(file) {
  return fs.existsSync(path.join(ROOT, file));
}

function readText(file) {
  try {
    return fs.readFileSync(path.join(ROOT, file), "utf8");
  } catch {
    return "";
  }
}

function readJson(file) {
  try {
    return JSON.parse(readText(file));
  } catch (error) {
    return { __error: error.message };
  }
}

function runCommand(id, command, args, { timeoutMs = 60000, env = {} } = {}) {
  const started = performance.now();
  const result = spawnSync(command, args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024 * 20,
    windowsHide: true
  });
  const durationMs = Math.round(performance.now() - started);
  return {
    id,
    command: [command, ...args].join(" "),
    status: result.status,
    signal: result.signal,
    durationMs,
    ok: result.status === 0,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    error: result.error ? result.error.message : null
  };
}

function tail(text, lines = 12, maxChars = 4000) {
  const parts = String(text || "").trimEnd().split(/\r?\n/);
  const value = parts.slice(Math.max(0, parts.length - lines)).join("\n");
  return value.length > maxChars ? `${value.slice(0, maxChars)}\n[truncated ${value.length - maxChars} chars]` : value;
}

function parseTestCount(output) {
  const match = output.match(/# tests\s+(\d+)/);
  return match ? Number(match[1]) : 0;
}

function parseJsonStdout(commandResult) {
  try {
    return { ok: true, value: JSON.parse(commandResult.stdout) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function includesAll(haystack, needles) {
  return needles.every((needle) => haystack.includes(needle));
}

function commandDryRuns() {
  const cases = [
    {
      id: "ask_explicit_model_no_search",
      args: [
        path.join(ROOT, "scripts", "grok.mjs"),
        "ask",
        "--print-args --model grok-composer-2.5-fast --no-search What is 2+2?"
      ],
      validate(result) {
        const parsed = parseJsonStdout(result);
        if (!parsed.ok || !Array.isArray(parsed.value)) return parsed;
        return {
          ok:
            includesAll(parsed.value, [
              "-p",
              "What is 2+2?",
              "--output-format",
              "json",
              "-m",
              "grok-composer-2.5-fast",
              "--no-auto-update",
              "--disable-web-search"
            ]) && parsed.value[1] === "What is 2+2?",
          value: parsed.value
        };
      }
    },
    {
      id: "review_dry_run_read_only",
      args: [path.join(ROOT, "scripts", "grok.mjs"), "review", "--print-args --scope working-tree"],
      validate(result) {
        const parsed = parseJsonStdout(result);
        if (!parsed.ok || !Array.isArray(parsed.value)) return parsed;
        return {
          ok:
            includesAll(parsed.value, ["-p", "--output-format", "json", "--no-auto-update", "--disable-web-search"]) &&
            parsed.value.some((part) => String(part).includes("Do NOT rewrite")),
          value: parsed.value
        };
      }
    },
    {
      id: "setup_json_smoke",
      args: [path.join(ROOT, "scripts", "grok.mjs"), "setup", "--json"],
      validate(result) {
        const parsed = parseJsonStdout(result);
        if (!parsed.ok || typeof parsed.value !== "object" || parsed.value === null) return parsed;
        return {
          ok:
            typeof parsed.value.ok === "boolean" &&
            typeof parsed.value.cliOk === "boolean" &&
            Array.isArray(parsed.value.checks) &&
            Array.isArray(parsed.value.nextSteps),
          value: parsed.value
        };
      }
    }
  ];

  return cases.map((testCase) => {
    const commandResult = runCommand(testCase.id, process.execPath, testCase.args, { timeoutMs: 30000 });
    const validation = commandResult.ok ? testCase.validate(commandResult) : { ok: false, error: "command failed" };
    return {
      id: testCase.id,
      ok: Boolean(commandResult.ok && validation.ok),
      durationMs: commandResult.durationMs,
      status: commandResult.status,
      detail: validation.ok ? "dry-run shape matched" : validation.error || "dry-run shape mismatch",
      stdoutTail: tail(commandResult.stdout, 4),
      stderrTail: tail(commandResult.stderr, 4)
    };
  });
}

function mcpSmoke() {
  return new Promise((resolve) => {
    const started = performance.now();
    const child = spawn(process.execPath, [path.join(ROOT, "scripts", "mcp-server.mjs")], {
      cwd: ROOT,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (partial) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      const durationMs = Math.round(performance.now() - started);
      resolve({ durationMs, stdout, stderr, ...partial });
    };

    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      finish({ ok: false, status: null, detail: "MCP smoke timed out" });
    }, 10000);

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => finish({ ok: false, status: null, detail: error.message }));
    child.on("close", (status) => {
      const messages = stdout
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
      const init = messages.find((message) => message.id === 1);
      const list = messages.find((message) => message.id === 2);
      const tools = list?.result?.tools || [];
      const names = tools.map((tool) => tool.name).sort();
      finish({
        ok:
          status === 0 &&
          init?.result?.serverInfo?.name === "grok" &&
          names.join(",") === "grok_ask,grok_search",
        status,
        detail: names.join(",") || "no tools returned",
        tools: names,
        stdoutTail: tail(stdout, 4),
        stderrTail: tail(stderr, 4)
      });
    });

    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })}\n`
    );
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
    child.stdin.end();
  });
}

function boolCheck(id, description, ok, detail = "") {
  return { id, description, ok: Boolean(ok), detail };
}

function countTestsInFiles() {
  const testDir = path.join(ROOT, "tests");
  if (!fs.existsSync(testDir)) return 0;
  return fs
    .readdirSync(testDir)
    .filter((name) => name.endsWith(".mjs"))
    .map((name) => readText(path.join("tests", name)))
    .reduce((sum, text) => sum + (text.match(/\btest\(/g) || []).length, 0);
}

function metadataChecks() {
  const pkg = readJson("package.json");
  const plugin = readJson(".claude-plugin/plugin.json");
  const marketplace = readJson(".claude-plugin/marketplace.json");
  const mcp = readJson(".mcp.json");
  const defaults = readJson("config/defaults.json");
  const readme = readText("README.md");
  const vision = readText("VISION.md");
  const grokLib = readText("scripts/lib/grok.mjs");
  const mcpServer = readText("scripts/mcp-server.mjs");
  const configLib = readText("scripts/lib/config.mjs");
  const commandFiles = ["ask", "review", "status", "result", "cancel", "setup"].map((name) => `commands/${name}.md`);

  return [
    boolCheck("package_json_valid", "package.json parses", !pkg.__error, pkg.__error || ""),
    boolCheck("plugin_json_valid", ".claude-plugin/plugin.json parses", !plugin.__error, plugin.__error || ""),
    boolCheck("marketplace_json_valid", ".claude-plugin/marketplace.json parses", !marketplace.__error, marketplace.__error || ""),
    boolCheck("mcp_json_valid", ".mcp.json parses", !mcp.__error, mcp.__error || ""),
    boolCheck("node_18_engine", "package declares Node 18+ engine", String(pkg.engines?.node || "").includes(">=18")),
    boolCheck("zero_runtime_deps", "package has no runtime dependencies", !pkg.dependencies || Object.keys(pkg.dependencies).length === 0),
    boolCheck("module_type", "package uses ES modules", pkg.type === "module"),
    boolCheck("eval_script", "package exposes npm run eval", pkg.scripts?.eval === "node auto/eval-harness.mjs"),
    boolCheck("test_script", "package exposes npm test", typeof pkg.scripts?.test === "string" && pkg.scripts.test.includes("node --test")),
    boolCheck("check_script", "package exposes npm run check", typeof pkg.scripts?.check === "string" && pkg.scripts.check.includes("node --check")),
    boolCheck("plugin_name", "plugin manifest name is grok", plugin.name === "grok"),
    boolCheck("marketplace_points_local", "marketplace source points at repo root", marketplace.plugins?.some((entry) => entry.name === "grok" && entry.source === "./")),
    boolCheck("mcp_server_configured", ".mcp.json points at scripts/mcp-server.mjs", JSON.stringify(mcp).includes("scripts/mcp-server.mjs")),
    boolCheck("all_command_files", "all six slash command files exist", commandFiles.every(exists), commandFiles.filter((file) => !exists(file)).join(", ")),
    boolCheck("ask_docs_search", "ask command documents live search", readText("commands/ask.md").includes("live web/X search")),
    boolCheck("review_read_only", "review command enforces read-only behavior", readText("commands/review.md").includes("READ-ONLY")),
    boolCheck("job_commands_exist", "status/result/cancel commands exist", ["commands/status.md", "commands/result.md", "commands/cancel.md"].every(exists)),
    boolCheck("setup_curl_guidance", "setup command recommends curl bootstrap, not npm", readText("commands/setup.md").includes("curl -fsSL https://x.ai/cli/install.sh")),
    boolCheck("mcp_tools_exported", "MCP server exports grok_search and grok_ask", includesAll(mcpServer, ["grok_search", "grok_ask"])),
    boolCheck("defaults_models", "defaults include composer/search/fallback models", includesAll(JSON.stringify(defaults), ["grok-composer-2.5-fast", "grok-build", "fallback_model"])),
    boolCheck("no_auto_update", "grok calls always include --no-auto-update", grokLib.includes("--no-auto-update")),
    boolCheck("transient_retry", "grok wrapper retries transient empty answers", includesAll(grokLib, ["transient", "attempts", "retries"])),
    boolCheck("readme_unofficial", "README carries unofficial disclaimer", /Unofficial/i.test(readme)),
    boolCheck("readme_install", "README documents install flow", includesAll(readme, ["/plugin marketplace add", "/plugin install"])),
    boolCheck("vision_phase2", "VISION tracks deferred phase-2 features", includesAll(vision, ["/grok:rescue", "/grok:research", "phase 2"])),
    boolCheck("autoresearch_manual", "autoresearch manual exists", exists("auto/autoresearch.md")),
    boolCheck("autoresearch_log", "autoresearch JSONL log exists", exists("auto/autoresearch.jsonl")),
    boolCheck("gitignore_eval_scratch", ".gitignore excludes generated eval output", readText(".gitignore").includes("auto/eval-last.json")),
    boolCheck("release_checklist", "release checklist exists", exists("auto/release-checklist.md")),
    boolCheck("benchmark_script", "benchmark helper exists", exists("auto/benchmark.mjs")),
    boolCheck("bench_package_script", "package exposes npm run bench", pkg.scripts?.bench === "node auto/benchmark.mjs"),
    boolCheck("readme_eval_docs", "README documents npm run eval", readme.includes("npm run eval")),
    boolCheck("readme_bench_docs", "README documents npm run bench", readme.includes("npm run bench")),
    boolCheck("command_contract_tests", "command contract tests exist", exists("tests/commands.test.mjs")),
    boolCheck("metadata_tests", "metadata/release tests exist", exists("tests/metadata.test.mjs")),
    boolCheck("mcp_schema_strict", "MCP tool schemas reject extra properties", (mcpServer.match(/additionalProperties:\s*false/g) || []).length >= 2),
    boolCheck("config_validation", "config loader normalizes unsafe local overrides", configLib.includes("normalizeConfig")),
    boolCheck("config_validation_tests", "config validation tests exist", readText("tests/lib.test.mjs").includes("invalid local overrides"))
  ];
}

function componentScore(checks) {
  if (!checks.length) return 0;
  const passed = checks.filter((check) => check.ok).length;
  return (passed / checks.length) * 100;
}

function summarizeCommand(command) {
  return {
    id: command.id,
    command: command.command,
    ok: command.ok,
    status: command.status,
    signal: command.signal,
    durationMs: command.durationMs,
    stdoutTail: tail(command.stdout),
    stderrTail: tail(command.stderr),
    error: command.error
  };
}

async function main() {
  const npmTest = runCommand("npm_test", "npm", ["test"], { timeoutMs: 120000 });
  const npmCheck = runCommand("npm_check", "npm", ["run", "check"], { timeoutMs: 60000 });
  const dryRuns = commandDryRuns();
  const mcp = await mcpSmoke();
  const metadata = metadataChecks();

  const testCount = parseTestCount(`${npmTest.stdout}\n${npmTest.stderr}`) || countTestsInFiles();
  const testCountScore = Math.min(1, testCount / 90) * 10;
  const testsScore =
    (npmTest.ok ? 50 : 0) +
    (npmCheck.ok ? 25 : 0) +
    (dryRuns.every((check) => check.ok) ? 15 : componentScore(dryRuns) * 0.15) +
    testCountScore;

  const visionIds = new Set([
    "all_command_files",
    "ask_docs_search",
    "review_read_only",
    "job_commands_exist",
    "setup_curl_guidance",
    "mcp_tools_exported",
    "defaults_models",
    "no_auto_update",
    "transient_retry",
    "vision_phase2"
  ]);
  const visionChecks = metadata.filter((check) => visionIds.has(check.id));
  const robustnessChecks = metadata.filter((check) => !visionIds.has(check.id));

  const visionScore = componentScore(visionChecks);
  const robustnessScore = componentScore(robustnessChecks);
  const composite = testsScore * 0.4 + visionScore * 0.3 + robustnessScore * 0.3;

  const mandatoryChecks = [
    boolCheck("mandatory_npm_test", "npm test passes", npmTest.ok),
    boolCheck("mandatory_npm_check", "npm run check passes", npmCheck.ok),
    boolCheck("mandatory_dry_runs", "command dry-runs pass", dryRuns.every((check) => check.ok)),
    boolCheck("mandatory_mcp_smoke", "MCP initialize/tools-list smoke passes", mcp.ok),
    boolCheck(
      "mandatory_metadata_json",
      "package/plugin/marketplace/MCP JSON files parse",
      metadata
        .filter((check) => ["package_json_valid", "plugin_json_valid", "marketplace_json_valid", "mcp_json_valid"].includes(check.id))
        .every((check) => check.ok)
    )
  ];

  const result = {
    timestamp: new Date().toISOString(),
    cwd: ROOT,
    node: process.version,
    mandatoryPass: mandatoryChecks.every((check) => check.ok),
    score: {
      composite: Number(composite.toFixed(2)),
      tests: Number(testsScore.toFixed(2)),
      vision: Number(visionScore.toFixed(2)),
      robustnessDocsPerformance: Number(robustnessScore.toFixed(2)),
      formula: "0.40*tests + 0.30*vision + 0.30*robustnessDocsPerformance"
    },
    metrics: {
      testCount,
      dryRunCount: dryRuns.length,
      metadataChecks: metadata.length,
      metadataPassed: metadata.filter((check) => check.ok).length
    },
    mandatoryChecks,
    commandResults: [summarizeCommand(npmTest), summarizeCommand(npmCheck)],
    dryRuns,
    mcp,
    metadata
  };

  fs.mkdirSync(AUTO_DIR, { recursive: true });
  fs.writeFileSync(LAST_RESULT, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.mandatoryPass ? 0 : 1;
}

main().catch((error) => {
  const result = {
    timestamp: new Date().toISOString(),
    cwd: ROOT,
    mandatoryPass: false,
    score: { composite: 0, tests: 0, vision: 0, robustnessDocsPerformance: 0 },
    error: error.message
  };
  fs.mkdirSync(AUTO_DIR, { recursive: true });
  fs.writeFileSync(LAST_RESULT, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = 1;
});
