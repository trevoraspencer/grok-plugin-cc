// Lightweight transient job registry for background grok runs.
//
// No persisted DB and no kept artifacts: each job is a small JSON record plus an
// output file under the OS temp dir (overridable via GROK_JOBS_DIR for tests).
// All functions tolerate a missing dir / missing files and never throw on a
// broken filesystem state.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import process from "node:process";

export function jobsDir() {
  return process.env.GROK_JOBS_DIR || path.join(os.tmpdir(), "grok-plugin-cc-jobs");
}

function ensureDir() {
  const dir = jobsDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // ignore — read/write calls below degrade gracefully
  }
  return dir;
}

function recordPath(id) {
  return path.join(jobsDir(), `${id}.json`);
}

function outputPath(id) {
  return path.join(jobsDir(), `${id}.out`);
}

function nowIso() {
  return new Date().toISOString();
}

function writeRecord(record) {
  ensureDir();
  try {
    fs.writeFileSync(recordPath(record.id), JSON.stringify(record, null, 2));
  } catch {
    // ignore
  }
  return record;
}

export function createJob({ kind = "ask", cmd = "" } = {}) {
  ensureDir();
  const id = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  try {
    fs.writeFileSync(outputPath(id), "");
  } catch {
    // ignore
  }
  const record = {
    id,
    kind,
    status: "queued",
    pid: null,
    childPid: null,
    startedAt: nowIso(),
    finishedAt: null,
    cmd,
    outFile: outputPath(id),
    summary: ""
  };
  return writeRecord(record);
}

function readRecord(id) {
  try {
    return JSON.parse(fs.readFileSync(recordPath(id), "utf8"));
  } catch {
    return null;
  }
}

// Best-effort liveness probe. kill(pid, 0) delivers no signal: ESRCH means the
// process is gone; EPERM means it exists but belongs to another user (alive).
function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error) && error.code === "EPERM";
  }
}

// A record can claim "running" forever if its wrapper process died without
// reaching a terminal mark (OOM-killed, kill -9, machine crash). Reconcile at
// read time: a running record whose pid is gone is marked failed, so
// /grok:status and /grok:result stop reporting a dead job as alive.
function reconcileRecord(record) {
  if (!record || record.status !== "running" || !Number.isFinite(record.pid)) {
    return record;
  }
  if (isPidAlive(record.pid)) {
    return record;
  }
  return (
    markFailed(record.id, `process ${record.pid} is no longer running; it exited without recording a result`) ??
    record
  );
}

export function readJob(id) {
  return reconcileRecord(readRecord(id));
}

function updateJob(id, patch) {
  // Raw read on purpose: reconciliation itself goes through updateJob, so
  // reading the reconciled view here would recurse.
  const job = readRecord(id);
  if (!job) {
    return null;
  }
  return writeRecord({ ...job, ...patch });
}

export function markRunning(id, pid) {
  return updateJob(id, { status: "running", pid: pid ?? null, startedAt: nowIso() });
}

// Record the pid of the spawned grok child. The wrapper pid alone is not
// enough for cancellation: killing only the wrapper would orphan the live
// grok process, which keeps burning quota until it finishes on its own.
export function recordChildPid(id, childPid) {
  return updateJob(id, { childPid: Number.isFinite(childPid) ? childPid : null });
}

export function markDone(id, summary = "") {
  return updateJob(id, { status: "done", finishedAt: nowIso(), summary: String(summary).slice(0, 500) });
}

export function markFailed(id, error = "") {
  return updateJob(id, { status: "failed", finishedAt: nowIso(), summary: String(error).slice(0, 500) });
}

export function markCancelled(id) {
  return updateJob(id, { status: "cancelled", finishedAt: nowIso() });
}

export function writeOutput(id, text) {
  ensureDir();
  try {
    fs.writeFileSync(outputPath(id), String(text ?? ""));
  } catch {
    // ignore
  }
}

export function readOutput(id) {
  try {
    return fs.readFileSync(outputPath(id), "utf8");
  } catch {
    return null;
  }
}

export function listJobs() {
  let files;
  try {
    files = fs.readdirSync(jobsDir());
  } catch {
    return [];
  }
  const jobs = files
    .filter((file) => file.endsWith(".json"))
    .map((file) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(jobsDir(), file), "utf8"));
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .map((record) => reconcileRecord(record));
  // ids are `${ms}-${uuid8}` with fixed-width ms, so a reverse string sort is newest-first.
  jobs.sort((a, b) => String(b.id).localeCompare(String(a.id)));
  return jobs;
}

export function cancelJob(id) {
  const job = readJob(id);
  if (!job) {
    return { ok: false, error: `No such job: ${id}` };
  }
  if (job.status !== "running" && job.status !== "queued") {
    return { ok: false, error: `Job ${id} is ${job.status}, not running.`, job };
  }
  // Kill the wrapper FIRST so it cannot observe the grok child's exit and
  // overwrite the cancelled status with failed; then kill the child itself
  // so the actual work process is not orphaned.
  for (const pid of [job.pid, job.childPid]) {
    if (Number.isFinite(pid)) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // process already gone — fall through and mark cancelled anyway
      }
    }
  }
  return { ok: true, job: markCancelled(id) };
}
