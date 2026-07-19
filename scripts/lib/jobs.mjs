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

const JOB_ID_PATTERN = /^\d{13}-[0-9a-f]{8}$/;

export function isValidJobId(id) {
  return typeof id === "string" && JOB_ID_PATTERN.test(id);
}

export function isValidJobPid(pid) {
  return Number.isSafeInteger(pid) && pid > 0;
}

function hasValidStoredPids(record) {
  return (
    (record?.pid == null || isValidJobPid(record.pid)) &&
    (record?.childPid == null || isValidJobPid(record.childPid))
  );
}

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
  if (!isValidJobId(id)) {
    return null;
  }
  return path.join(jobsDir(), `${id}.json`);
}

function outputPath(id) {
  if (!isValidJobId(id)) {
    return null;
  }
  return path.join(jobsDir(), `${id}.out`);
}

function nowIso() {
  return new Date().toISOString();
}

function writeRecord(record, expectedId = record?.id) {
  if (!isValidJobId(expectedId) || record?.id !== expectedId || !hasValidStoredPids(record)) {
    return null;
  }
  const file = recordPath(expectedId);
  if (!file) {
    return null;
  }
  ensureDir();
  try {
    fs.writeFileSync(file, JSON.stringify(record, null, 2));
  } catch {
    // ignore
  }
  return record;
}

export function createJob({ kind = "ask", cmd = "" } = {}) {
  ensureDir();
  const id = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const outFile = outputPath(id);
  if (outFile) {
    try {
      fs.writeFileSync(outFile, "");
    } catch {
      // ignore
    }
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
    outFile,
    summary: ""
  };
  return writeRecord(record);
}

function readRecord(id) {
  const file = recordPath(id);
  if (!file) {
    return null;
  }
  try {
    const record = JSON.parse(fs.readFileSync(file, "utf8"));
    if (
      !record ||
      typeof record !== "object" ||
      Array.isArray(record) ||
      record.id !== id ||
      !hasValidStoredPids(record)
    ) {
      return null;
    }
    return record;
  } catch {
    return null;
  }
}

// Best-effort liveness probe. kill(pid, 0) delivers no signal: ESRCH means the
// process is gone; EPERM means it exists but belongs to another user (alive).
function isPidAlive(pid) {
  if (!isValidJobPid(pid)) {
    return false;
  }
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
function reconcileRecord(record, expectedId) {
  if (!isValidJobId(expectedId) || record?.id !== expectedId || !hasValidStoredPids(record)) {
    return null;
  }
  if (!record || record.status !== "running") {
    return record;
  }
  if (!isValidJobPid(record.pid)) {
    return markFailed(record.id, "job has no valid running process id") ?? record;
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
  if (!isValidJobId(id)) {
    return null;
  }
  return reconcileRecord(readRecord(id), id);
}

function updateJob(id, patch) {
  if (!isValidJobId(id)) {
    return null;
  }
  // Raw read on purpose: reconciliation itself goes through updateJob, so
  // reading the reconciled view here would recurse.
  const job = readRecord(id);
  if (!job) {
    return null;
  }
  return writeRecord({ ...job, ...patch, id }, id);
}

export function markRunning(id, pid) {
  if (!isValidJobPid(pid)) {
    return null;
  }
  return updateJob(id, { status: "running", pid, startedAt: nowIso() });
}

// Record the pid of the spawned grok child. The wrapper pid alone is not
// enough for cancellation: killing only the wrapper would orphan the live
// grok process, which keeps burning quota until it finishes on its own.
export function recordChildPid(id, childPid) {
  if (!isValidJobPid(childPid)) {
    return null;
  }
  return updateJob(id, { childPid });
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
  const file = outputPath(id);
  if (!file) {
    return;
  }
  ensureDir();
  try {
    fs.writeFileSync(file, String(text ?? ""));
  } catch {
    // ignore
  }
}

export function readOutput(id) {
  const file = outputPath(id);
  if (!file) {
    return null;
  }
  try {
    return fs.readFileSync(file, "utf8");
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
    .map((file) => file.slice(0, -".json".length))
    .filter((id) => isValidJobId(id))
    .map((id) => reconcileRecord(readRecord(id), id))
    .filter(Boolean);
  // ids are `${ms}-${uuid8}` with fixed-width ms, so a reverse string sort is newest-first.
  jobs.sort((a, b) => String(b.id).localeCompare(String(a.id)));
  return jobs;
}

export function cancelJob(id) {
  if (!isValidJobId(id)) {
    return { ok: false, error: `Invalid job ID: ${id}` };
  }
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
    if (isValidJobPid(pid)) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // process already gone — fall through and mark cancelled anyway
      }
    }
  }
  return { ok: true, job: markCancelled(id) };
}
