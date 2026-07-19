#!/usr/bin/env node

// Offline subprocess fixture for the live Grok runner boundary. It deliberately
// ignores Grok's argv because the tests exercise process lifecycle and capture
// behavior, not CLI argument parsing.

import process from "node:process";

const mode = process.env.GROK_TEST_FIXTURE_MODE;

if (mode === "hang") {
  // Force the runner to exercise its bounded SIGTERM -> SIGKILL escalation.
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
} else if (mode === "oversized-output") {
  const bytes = Number.parseInt(process.env.GROK_TEST_FIXTURE_BYTES || "1048576", 10);
  process.stdout.write("x".repeat(bytes));
  setInterval(() => {}, 1000);
} else {
  process.stdout.write('{"text":"fixture answer","stopReason":"EndTurn"}\n');
}
