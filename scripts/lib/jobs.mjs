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
    startedAt: nowIso(),
    finishedAt: null,
    cmd,
    outFile: outputPath(id),
    summary: ""
  };
  return writeRecord(record);
}

export function readJob(id) {
  try {
    return JSON.parse(fs.readFileSync(recordPath(id), "utf8"));
  } catch {
    return null;
  }
}

function updateJob(id, patch) {
  const job = readJob(id);
  if (!job) {
    return null;
  }
  return writeRecord({ ...job, ...patch });
}

export function markRunning(id, pid) {
  return updateJob(id, { status: "running", pid: pid ?? null, startedAt: nowIso() });
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
    .filter(Boolean);
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
  if (Number.isFinite(job.pid)) {
    try {
      process.kill(job.pid, "SIGTERM");
    } catch {
      // process already gone — fall through and mark cancelled anyway
    }
  }
  return { ok: true, job: markCancelled(id) };
}
