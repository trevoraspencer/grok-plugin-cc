import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import {
  createJob,
  markRunning,
  markDone,
  markFailed,
  markCancelled,
  recordChildPid,
  writeOutput,
  readOutput,
  readJob,
  listJobs,
  cancelJob
} from "../scripts/lib/jobs.mjs";
import { renderJobsTable, renderJobDetail, formatElapsed } from "../scripts/lib/render.mjs";

function freshJobsDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-jobs-test-"));
  process.env.GROK_JOBS_DIR = dir;
  return dir;
}

test("jobs: full lifecycle create → running → done → read output", () => {
  freshJobsDir();
  const job = createJob({ kind: "ask" });
  assert.equal(job.status, "queued");
  assert.match(job.id, /^\d{13}-[0-9a-f]{8}$/);

  markRunning(job.id, 4242);
  let current = readJob(job.id);
  assert.equal(current.status, "running");
  assert.equal(current.pid, 4242);

  writeOutput(job.id, "rendered grok output");
  markDone(job.id, "first line summary");
  current = readJob(job.id);
  assert.equal(current.status, "done");
  assert.equal(current.summary, "first line summary");
  assert.ok(current.finishedAt);
  assert.equal(readOutput(job.id), "rendered grok output");

  const all = listJobs();
  assert.ok(all.some((j) => j.id === job.id));
});

test("jobs: markFailed and markCancelled set terminal states", () => {
  freshJobsDir();
  const failed = createJob({ kind: "ask" });
  markFailed(failed.id, "boom");
  assert.equal(readJob(failed.id).status, "failed");
  assert.equal(readJob(failed.id).summary, "boom");

  const cancelled = createJob({ kind: "review" });
  markRunning(cancelled.id, 1);
  markCancelled(cancelled.id);
  assert.equal(readJob(cancelled.id).status, "cancelled");
});

test("jobs: listJobs returns newest first", () => {
  freshJobsDir();
  const a = createJob({ kind: "ask" });
  // Force a distinct, later id so ordering is deterministic regardless of clock granularity.
  const laterId = `${Date.now() + 1000}-aaaaaaaa`;
  fs.writeFileSync(
    path.join(process.env.GROK_JOBS_DIR, `${laterId}.json`),
    JSON.stringify({ id: laterId, kind: "review", status: "done", startedAt: new Date().toISOString() })
  );
  const ids = listJobs().map((j) => j.id);
  assert.equal(ids[0], laterId);
  assert.ok(ids.includes(a.id));
});

test("jobs: cancelJob terminates a running pid and marks cancelled", () => {
  freshJobsDir();
  const child = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 60000)"]);
  const job = createJob({ kind: "ask" });
  markRunning(job.id, child.pid);

  const result = cancelJob(job.id);
  assert.equal(result.ok, true);
  assert.equal(readJob(job.id).status, "cancelled");

  // cancelJob on an already-finished job is a friendly no-op error
  markDone(job.id, "x");
  const second = cancelJob(job.id);
  assert.equal(second.ok, false);

  try {
    child.kill("SIGKILL");
  } catch {
    // already dead from the SIGTERM above
  }
});

test("jobs: cancelJob terminates the recorded grok child pid too, not just the wrapper", async () => {
  freshJobsDir();
  // Simulate the real topology: a dispatcher wrapper process plus the grok
  // child it spawned. Cancelling must SIGTERM both, or the child is orphaned.
  const wrapper = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 60000)"]);
  const grokChild = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 60000)"]);
  const exits = Promise.all(
    [wrapper, grokChild].map(
      (proc) => new Promise((resolve) => proc.on("exit", (code, signal) => resolve(signal)))
    )
  );
  try {
    const job = createJob({ kind: "ask" });
    markRunning(job.id, wrapper.pid);
    recordChildPid(job.id, grokChild.pid);
    assert.equal(readJob(job.id).childPid, grokChild.pid);

    const result = cancelJob(job.id);
    assert.equal(result.ok, true);
    assert.equal(readJob(job.id).status, "cancelled");
    assert.deepEqual(await exits, ["SIGTERM", "SIGTERM"]);
  } finally {
    for (const proc of [wrapper, grokChild]) {
      try {
        proc.kill("SIGKILL");
      } catch {
        // already dead from the SIGTERM above
      }
    }
  }
});

test("jobs: tolerates a missing jobs dir", () => {
  process.env.GROK_JOBS_DIR = path.join(os.tmpdir(), `grok-jobs-absent-${Date.now()}`);
  assert.deepEqual(listJobs(), []);
  assert.equal(readJob("nope"), null);
  assert.equal(readOutput("nope"), null);
  assert.equal(cancelJob("nope").ok, false);
});

test("render: job table and detail format cleanly", () => {
  const now = Date.parse("2026-06-14T00:00:30.000Z");
  const job = {
    id: "1700000000000-deadbeef",
    kind: "ask",
    status: "running",
    pid: 9,
    startedAt: "2026-06-14T00:00:00.000Z",
    finishedAt: null,
    summary: "weather | with pipe"
  };
  const table = renderJobsTable([job], now);
  assert.ok(table.includes("| Job ID |"));
  assert.ok(table.includes("1700000000000-deadbeef"));
  assert.ok(table.includes("\\|")); // pipe in summary escaped
  assert.equal(formatElapsed(job, now), "30s");
  assert.equal(renderJobsTable([], now), "No grok jobs yet.\n");

  const detail = renderJobDetail(job, now);
  assert.ok(detail.includes("/grok:cancel 1700000000000-deadbeef"));
  assert.ok(detail.includes("Status: running"));
});
