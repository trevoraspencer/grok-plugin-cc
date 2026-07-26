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
  cancelJob,
  isValidJobId,
  isValidJobPid
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

  // Use our own (live) pid: readJob now reconciles running records whose
  // process is gone, so a made-up pid would legitimately read back as failed.
  markRunning(job.id, process.pid);
  let current = readJob(job.id);
  assert.equal(current.status, "running");
  assert.equal(current.pid, process.pid);

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
  const firstTimestamp = Number(a.id.slice(0, 13));
  while (Date.now() <= firstTimestamp) {
    // Keep the test deterministic without introducing an async timing window.
  }
  const later = createJob({ kind: "review" });
  const ids = listJobs().map((j) => j.id);
  assert.equal(ids[0], later.id);
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

test("jobs: a 'running' record whose process died reads back as failed, not running forever", async () => {
  freshJobsDir();
  const dead = spawn(process.execPath, ["-e", "setTimeout(() => process.exit(0), 500)"]);
  const job = createJob({ kind: "ask" });
  assert.equal(markRunning(job.id, dead.pid)?.status, "running");
  await new Promise((resolve) => dead.on("exit", resolve));

  const seen = readJob(job.id);
  assert.equal(seen.status, "failed");
  assert.match(seen.summary, /no longer running/);
  // reconciliation persists the terminal state and listJobs agrees
  assert.equal(listJobs().find((j) => j.id === job.id).status, "failed");
  // a dead job can no longer be "cancelled"
  assert.equal(cancelJob(job.id).ok, false);
});

test("jobs: a 'running' record with a live process stays running", () => {
  freshJobsDir();
  const job = createJob({ kind: "ask" });
  markRunning(job.id, process.pid);
  assert.equal(readJob(job.id).status, "running");
  assert.equal(listJobs().find((j) => j.id === job.id).status, "running");
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

test("jobs: validates the canonical job ID format", () => {
  assert.equal(isValidJobId("1700000000000-deadbeef"), true);
  for (const id of [
    "170000000000-deadbeef",
    "1700000000000-DEADBEEF",
    "../outside",
    "/tmp/outside",
    "1700000000000-deadbeef/child",
    "1700000000000-deadbeef\\child"
  ]) {
    assert.equal(isValidJobId(id), false, `expected ${JSON.stringify(id)} to be invalid`);
  }
});

test("jobs: validates process IDs without ever accepting init or out-of-range values", () => {
  assert.equal(isValidJobPid(1), false);
  assert.equal(isValidJobPid(process.pid), true);
  assert.equal(isValidJobPid(2_147_483_647), true);
  for (const pid of [0, 1, -1, 1.5, "123", 2_147_483_648, Number.MAX_SAFE_INTEGER, NaN, Infinity]) {
    assert.equal(isValidJobPid(pid), false, `expected ${String(pid)} to be invalid`);
  }
});

test("jobs: invalid persisted wrapper or child process IDs never trigger signals", () => {
  const invalidPids = [0, -1, 1.5, "123", Number.MAX_SAFE_INTEGER + 1];
  const originalKill = process.kill;
  let signalCalls = 0;
  process.kill = () => {
    signalCalls += 1;
    return true;
  };
  try {
    for (const field of ["pid", "childPid"]) {
      for (const invalidPid of invalidPids) {
        const dir = freshJobsDir();
        const id = "1700000000000-deadbeef";
        const record = {
          id,
          kind: "ask",
          status: "running",
          pid: process.pid,
          childPid: null,
          startedAt: new Date().toISOString()
        };
        record[field] = invalidPid;
        const file = path.join(dir, `${id}.json`);
        const serialized = JSON.stringify(record);
        fs.writeFileSync(file, serialized);

        assert.equal(readJob(id), null, `${field}=${String(invalidPid)} should reject reads`);
        assert.deepEqual(listJobs(), [], `${field}=${String(invalidPid)} should reject listing`);
        assert.equal(markDone(id, "overwrite"), null, `${field}=${String(invalidPid)} should reject updates`);
        assert.equal(cancelJob(id).ok, false, `${field}=${String(invalidPid)} should reject cancel`);
        assert.equal(fs.readFileSync(file, "utf8"), serialized);
      }
    }
  } finally {
    process.kill = originalKill;
  }

  assert.equal(signalCalls, 0);
});

test("jobs: invalid process IDs cannot enter records through update helpers", () => {
  freshJobsDir();
  const job = createJob({ kind: "ask" });
  for (const pid of [0, -1, 1.5, "123", Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(markRunning(job.id, pid), null);
    assert.equal(recordChildPid(job.id, pid), null);
  }
  const unchanged = readJob(job.id);
  assert.equal(unchanged.status, "queued");
  assert.equal(unchanged.pid, null);
  assert.equal(unchanged.childPid, null);
});

test("jobs: a running record without a process ID is rejected without probing a process group", () => {
  const dir = freshJobsDir();
  const id = "1700000000000-deadbeef";
  fs.writeFileSync(
    path.join(dir, `${id}.json`),
    JSON.stringify({
      id,
      kind: "ask",
      status: "running",
      pid: null,
      childPid: null,
      startedAt: new Date().toISOString()
    })
  );

  const originalKill = process.kill;
  let signalCalls = 0;
  process.kill = () => {
    signalCalls += 1;
    return true;
  };
  try {
    assert.equal(readJob(id), null);
  } finally {
    process.kill = originalKill;
  }
  assert.equal(signalCalls, 0);
});

test("jobs: registry directory and plugin-created files are owner-only", () => {
  const dir = freshJobsDir();
  fs.chmodSync(dir, 0o777);
  const job = createJob({ kind: "ask" });
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(dir, `${job.id}.json`)).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(dir, `${job.id}.out`)).mode & 0o777, 0o600);
});

test("jobs: records or output exposed through permissive POSIX modes fail closed", () => {
  if (process.platform === "win32") {
    return;
  }
  const dir = freshJobsDir();
  const job = createJob({ kind: "ask" });
  const record = path.join(dir, `${job.id}.json`);
  const output = path.join(dir, `${job.id}.out`);

  fs.chmodSync(record, 0o644);
  assert.equal(readJob(job.id), null);
  fs.chmodSync(record, 0o600);
  fs.chmodSync(output, 0o644);
  assert.equal(readOutput(job.id), null);
});

test("jobs: a symlinked registry directory fails closed", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "grok-jobs-dir-link-"));
  const target = path.join(root, "target");
  const linked = path.join(root, "jobs");
  fs.mkdirSync(target, { mode: 0o700 });
  fs.symlinkSync(target, linked, process.platform === "win32" ? "junction" : "dir");
  process.env.GROK_JOBS_DIR = linked;
  assert.throws(() => createJob({ kind: "ask" }), /secure Grok job directory/i);
  assert.deepEqual(listJobs(), []);
});

test("jobs: output symlinks cannot disclose or overwrite their targets", () => {
  const dir = freshJobsDir();
  const job = createJob({ kind: "ask" });
  const output = path.join(dir, `${job.id}.out`);
  const victim = path.join(dir, "victim");
  fs.writeFileSync(victim, "secret");
  fs.unlinkSync(output);
  fs.symlinkSync(victim, output);

  assert.equal(readOutput(job.id), null);
  assert.equal(writeOutput(job.id, "safe replacement"), true);
  assert.equal(fs.readFileSync(victim, "utf8"), "secret");
  assert.equal(fs.lstatSync(output).isSymbolicLink(), false);
  assert.equal(readOutput(job.id), "safe replacement");
});

test("jobs: captured output is bounded and explicitly marked when truncated", () => {
  freshJobsDir();
  const job = createJob({ kind: "ask" });
  assert.equal(writeOutput(job.id, "x".repeat(5 * 1024 * 1024)), true);
  const output = readOutput(job.id);
  assert.ok(Buffer.byteLength(output) <= 4 * 1024 * 1024);
  assert.match(output, /\[output truncated at 4 MiB\]/);
});

test("jobs: terminal cancellation is sticky against late wrapper completion", () => {
  freshJobsDir();
  const job = createJob({ kind: "ask" });
  markRunning(job.id, process.pid);
  markCancelled(job.id);
  markDone(job.id, "late success");
  markFailed(job.id, "late failure");
  assert.equal(readJob(job.id).status, "cancelled");
});

test("jobs: a mismatched process start token is reconciled without signaling", () => {
  const dir = freshJobsDir();
  const job = createJob({ kind: "ask" });
  markRunning(job.id, process.pid);
  const file = path.join(dir, `${job.id}.json`);
  const record = JSON.parse(fs.readFileSync(file, "utf8"));
  record.pidStart = "proc:0";
  fs.writeFileSync(file, JSON.stringify(record), { mode: 0o600 });
  fs.chmodSync(file, 0o600);

  const originalKill = process.kill;
  let destructiveSignals = 0;
  process.kill = (pid, signal) => {
    if (signal && signal !== 0) destructiveSignals += 1;
    return originalKill(pid, signal);
  };
  try {
    const seen = readJob(job.id);
    assert.equal(seen.status, "failed");
    assert.match(seen.summary, /no longer running as the recorded job process/);
  } finally {
    process.kill = originalKill;
  }
  assert.equal(destructiveSignals, 0);
});

test("jobs: registry growth is bounded", () => {
  const dir = freshJobsDir();
  for (let index = 0; index < 1000; index += 1) {
    const id = `1700000000000-${index.toString(16).padStart(8, "0")}`;
    fs.writeFileSync(path.join(dir, `${id}.json`), "");
  }
  assert.throws(() => createJob({ kind: "ask" }), /registry is full/);
});

test("jobs: traversal IDs cannot read, write, or signal outside the jobs directory", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "grok-jobs-traversal-test-"));
  const dir = path.join(root, "jobs");
  fs.mkdirSync(dir);
  process.env.GROK_JOBS_DIR = dir;

  const traversalId = "../outside";
  const outsideRecordPath = path.join(root, "outside.json");
  const outsideOutputPath = path.join(root, "outside.out");
  const outsideRecord = JSON.stringify({
    id: traversalId,
    kind: "ask",
    status: "queued",
    pid: 12345,
    childPid: 23456,
    startedAt: new Date().toISOString()
  });
  fs.writeFileSync(outsideRecordPath, outsideRecord);
  fs.writeFileSync(outsideOutputPath, "outside secret");

  const originalKill = process.kill;
  let signalCalls = 0;
  process.kill = () => {
    signalCalls += 1;
    return true;
  };
  try {
    assert.equal(readJob(traversalId), null);
    assert.equal(readOutput(traversalId), null);
    assert.equal(markDone(traversalId, "overwrite"), null);
    writeOutput(traversalId, "overwrite");
    assert.equal(cancelJob(traversalId).ok, false);
  } finally {
    process.kill = originalKill;
  }

  assert.equal(signalCalls, 0);
  assert.equal(fs.readFileSync(outsideRecordPath, "utf8"), outsideRecord);
  assert.equal(fs.readFileSync(outsideOutputPath, "utf8"), "outside secret");
});

test("jobs: a record ID must exactly match its canonical filename before updates or signals", () => {
  const dir = freshJobsDir();
  const requestedId = "1700000000000-deadbeef";
  const embeddedId = "1700000000001-cafebabe";
  const requestedPath = path.join(dir, `${requestedId}.json`);
  const record = JSON.stringify({
    id: embeddedId,
    kind: "ask",
    status: "queued",
    pid: 12345,
    childPid: 23456,
    startedAt: new Date().toISOString()
  });
  fs.writeFileSync(requestedPath, record);

  const originalKill = process.kill;
  let signalCalls = 0;
  process.kill = () => {
    signalCalls += 1;
    return true;
  };
  try {
    assert.equal(readJob(requestedId), null);
    assert.equal(markDone(requestedId, "overwrite"), null);
    assert.equal(cancelJob(requestedId).ok, false);
    assert.deepEqual(listJobs(), []);
  } finally {
    process.kill = originalKill;
  }

  assert.equal(signalCalls, 0);
  assert.equal(fs.readFileSync(requestedPath, "utf8"), record);
  assert.equal(fs.existsSync(path.join(dir, `${embeddedId}.json`)), false);
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
