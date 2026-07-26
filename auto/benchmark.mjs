#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requestedIterations = Number.parseInt(process.env.BENCH_ITERATIONS || "5", 10);
const ITERATIONS =
  Number.isInteger(requestedIterations) && requestedIterations > 0 && requestedIterations <= 1000
    ? requestedIterations
    : 5;

const CASES = [
  {
    id: "ask_print_args_no_search",
    args: [
      path.join(ROOT, "scripts", "grok.mjs"),
      "ask",
      "--print-args --model grok-composer-2.5-fast --no-search benchmark prompt"
    ]
  },
  {
    id: "review_print_args_empty_branch_diff",
    args: [path.join(ROOT, "scripts", "grok.mjs"), "review", "--print-args --scope branch --base HEAD"]
  },
  {
    id: "setup_json",
    args: [path.join(ROOT, "scripts", "grok.mjs"), "setup", "--json --offline"]
  }
];

function percentile(values, percentileValue) {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((percentileValue / 100) * sorted.length) - 1);
  return sorted[index] ?? 0;
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function runCase(testCase) {
  const samples = [];
  const failures = [];

  for (let index = 0; index < ITERATIONS; index += 1) {
    const started = performance.now();
    const result = spawnSync(process.execPath, testCase.args, {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 10,
      timeout: 30000,
      windowsHide: true
    });
    samples.push(performance.now() - started);
    if (result.status !== 0) {
      failures.push({
        iteration: index + 1,
        status: result.status,
        stderr: String(result.stderr || "").trim().slice(0, 500),
        stdout: String(result.stdout || "").trim().slice(0, 500)
      });
    }
  }

  const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length;
  return {
    id: testCase.id,
    iterations: ITERATIONS,
    ok: failures.length === 0,
    durationMs: {
      min: round(Math.min(...samples)),
      mean: round(mean),
      p50: round(percentile(samples, 50)),
      p95: round(percentile(samples, 95)),
      max: round(Math.max(...samples))
    },
    failures
  };
}

const results = CASES.map(runCase);
const output = {
  timestamp: new Date().toISOString(),
  cwd: ROOT,
  node: process.version,
  iterations: ITERATIONS,
  note: "Dispatcher-only benchmark. It uses --print-args or setup JSON and never calls live Grok.",
  ok: results.every((result) => result.ok),
  results
};

process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
process.exitCode = output.ok ? 0 : 1;
