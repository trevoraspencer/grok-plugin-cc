// Private, bounded, transient job registry for background Grok runs.
//
// Records and captured output live in an owner-only directory below the OS
// temporary directory (overridable with GROK_JOBS_DIR for tests). Every read
// is bounded and refuses symlinks; every write is private and atomic.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import process from "node:process";
import { spawnSync } from "node:child_process";

const JOB_ID_PATTERN = /^\d{13}-[0-9a-f]{8}$/;
const JOB_STATUSES = new Set(["queued", "running", "done", "failed", "cancelled"]);
const TERMINAL_STATUSES = new Set(["done", "failed", "cancelled"]);
const JOB_KINDS = new Set(["ask", "review"]);
const MAX_RECORD_BYTES = 64 * 1024;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_JOB_FILES = 1000;
const MAX_PID = 2_147_483_647;
const LOCK_ATTEMPTS = 100;
const LOCK_WAIT_MS = 10;
const STALE_LOCK_MS = 30_000;
const SIGNAL_GRACE_MS = 1000;
const BIGINT_STATS = { bigint: true };
const sleepCell = new Int32Array(new SharedArrayBuffer(4));
const HAS_POSIX_MODES = process.platform !== "win32";

export function isValidJobId(id) {
  return typeof id === "string" && JOB_ID_PATTERN.test(id);
}

// PID 1 is deliberately excluded: an invalid/corrupt record must never be
// able to signal the host init process.
export function isValidJobPid(pid) {
  return Number.isSafeInteger(pid) && pid > 1 && pid <= MAX_PID;
}

export function jobsDir() {
  const identity =
    typeof process.getuid === "function"
      ? String(process.getuid())
      : crypto.createHash("sha256").update(os.userInfo().username).digest("hex").slice(0, 12);
  return process.env.GROK_JOBS_DIR || path.join(os.tmpdir(), `grok-plugin-cc-jobs-${identity}`);
}

function currentUid() {
  return typeof process.getuid === "function" ? BigInt(process.getuid()) : null;
}

function ownedByCurrentUser(stat) {
  const uid = currentUid();
  return uid === null || stat.uid === uid;
}

function secureDirectory({ create = false, throwOnError = false } = {}) {
  const dir = jobsDir();
  try {
    if (create) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    const stat = fs.lstatSync(dir, BIGINT_STATS);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("path is not a real directory");
    }
    if (!ownedByCurrentUser(stat)) {
      throw new Error("directory is owned by another user");
    }
    // Repair an owner-controlled legacy directory, then verify the result.
    // Windows does not expose ACLs through POSIX mode bits; its per-user temp
    // directory and inherited ACLs provide the equivalent boundary there.
    if (HAS_POSIX_MODES && (Number(stat.mode) & 0o077) !== 0) {
      fs.chmodSync(dir, 0o700);
      const repaired = fs.lstatSync(dir, BIGINT_STATS);
      if ((Number(repaired.mode) & 0o077) !== 0) {
        throw new Error("directory is accessible by other users");
      }
    }
    return dir;
  } catch (error) {
    if (throwOnError) {
      throw new Error(`Cannot use secure Grok job directory "${dir}": ${error.message}`, {
        cause: error
      });
    }
    return null;
  }
}

function jobPath(id, suffix) {
  if (!isValidJobId(id)) {
    return null;
  }
  return path.join(jobsDir(), `${id}.${suffix}`);
}

function recordPath(id) {
  return jobPath(id, "json");
}

function outputPath(id) {
  return jobPath(id, "out");
}

function lockPath(id) {
  return jobPath(id, "lock");
}

function nowIso() {
  return new Date().toISOString();
}

function validIso(value, { nullable = false } = {}) {
  return (
    (nullable && value === null) ||
    (typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value)))
  );
}

function validStartToken(value, { nullable = false } = {}) {
  return (nullable && value === null) || (typeof value === "string" && value.length > 0 && value.length <= 256);
}

function validRecord(record, expectedId) {
  const pidPair =
    (record?.pid === null && record?.pidStart === null) ||
    (isValidJobPid(record?.pid) && validStartToken(record?.pidStart));
  const childPidPair =
    (record?.childPid === null && record?.childPidStart === null) ||
    (isValidJobPid(record?.childPid) && validStartToken(record?.childPidStart));
  return Boolean(
    record &&
      typeof record === "object" &&
      !Array.isArray(record) &&
      record.id === expectedId &&
      JOB_KINDS.has(record.kind) &&
      JOB_STATUSES.has(record.status) &&
      pidPair &&
      childPidPair &&
      validIso(record.startedAt) &&
      validIso(record.finishedAt, { nullable: true }) &&
      (TERMINAL_STATUSES.has(record.status)
        ? validIso(record.finishedAt)
        : record.finishedAt === null) &&
      typeof record.cmd === "string" &&
      record.cmd.length <= 1024 &&
      typeof record.summary === "string" &&
      record.summary.length <= 500 &&
      record.outFile === outputPath(expectedId) &&
      (record.status !== "queued" || (record.pid === null && record.childPid === null)) &&
      (record.status !== "running" || isValidJobPid(record.pid))
  );
}

function hasFileIdentity(stat) {
  return (
    typeof stat?.dev === "bigint" &&
    typeof stat?.ino === "bigint" &&
    stat.ino !== 0n
  );
}

function readPrivateFile(file, maxBytes) {
  if (!secureDirectory()) {
    return null;
  }
  let descriptor;
  try {
    const before = fs.lstatSync(file, BIGINT_STATS);
    if (!before.isFile() || before.isSymbolicLink() || !ownedByCurrentUser(before)) {
      return null;
    }
    if (
      (HAS_POSIX_MODES && (Number(before.mode) & 0o077) !== 0) ||
      before.size > BigInt(maxBytes)
    ) {
      return null;
    }
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const opened = fs.fstatSync(descriptor, BIGINT_STATS);
    if (
      !opened.isFile() ||
      !ownedByCurrentUser(opened) ||
      !hasFileIdentity(before) ||
      !hasFileIdentity(opened) ||
      before.dev !== opened.dev ||
      before.ino !== opened.ino ||
      opened.size > BigInt(maxBytes)
    ) {
      return null;
    }
    const size = Number(opened.size);
    const buffer = Buffer.alloc(size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const read = fs.readSync(descriptor, buffer, offset, buffer.length - offset, null);
      if (read === 0) {
        break;
      }
      offset += read;
    }
    if (offset > maxBytes) {
      return null;
    }
    return buffer.subarray(0, offset);
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // The bounded read result has already been determined.
      }
    }
  }
}

function atomicPrivateWrite(file, data) {
  const dir = secureDirectory({ create: true, throwOnError: true });
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
  const temporary = path.join(dir, `.tmp-${process.pid}-${crypto.randomUUID()}`);
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    let offset = 0;
    while (offset < buffer.length) {
      offset += fs.writeSync(descriptor, buffer, offset, buffer.length - offset);
    }
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, file);
    fs.chmodSync(file, 0o600);
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // Preserve the original write error.
      }
    }
    try {
      fs.unlinkSync(temporary);
    } catch {
      // A failed temporary write may not have created a file.
    }
    throw error;
  }
}

function readRecord(id) {
  const file = recordPath(id);
  if (!file) {
    return null;
  }
  const bytes = readPrivateFile(file, MAX_RECORD_BYTES);
  if (!bytes) {
    return null;
  }
  try {
    const record = JSON.parse(bytes.toString("utf8"));
    return validRecord(record, id) ? record : null;
  } catch {
    return null;
  }
}

function writeRecord(record, expectedId = record?.id) {
  if (!isValidJobId(expectedId) || !validRecord(record, expectedId)) {
    return null;
  }
  const encoded = Buffer.from(`${JSON.stringify(record, null, 2)}\n`);
  if (encoded.length > MAX_RECORD_BYTES) {
    return null;
  }
  try {
    atomicPrivateWrite(recordPath(expectedId), encoded);
    return record;
  } catch {
    return null;
  }
}

function acquireLock(id) {
  const file = lockPath(id);
  if (!file || !secureDirectory({ create: true })) {
    return null;
  }
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
    try {
      return { file, descriptor: fs.openSync(file, "wx", 0o600) };
    } catch (error) {
      if (error?.code !== "EEXIST") {
        return null;
      }
      try {
        const stat = fs.lstatSync(file, BIGINT_STATS);
        if (
          stat.isFile() &&
          !stat.isSymbolicLink() &&
          ownedByCurrentUser(stat) &&
          Date.now() - Number(stat.mtimeMs) > STALE_LOCK_MS
        ) {
          fs.unlinkSync(file);
          continue;
        }
      } catch {
        // Another updater may have just released the lock.
      }
      Atomics.wait(sleepCell, 0, 0, LOCK_WAIT_MS);
    }
  }
  return null;
}

function releaseLock(lock) {
  if (!lock) {
    return;
  }
  try {
    fs.closeSync(lock.descriptor);
  } finally {
    try {
      fs.unlinkSync(lock.file);
    } catch {
      // A stale-lock recovery may already have removed it.
    }
  }
}

function canonicalKind(kind) {
  return JOB_KINDS.has(kind) ? kind : null;
}

export function createJob({ kind = "ask", cmd = "" } = {}) {
  const normalizedKind = canonicalKind(kind);
  if (!normalizedKind) {
    throw new TypeError(`Unsupported job kind: ${kind}`);
  }
  if (typeof cmd !== "string" || cmd.includes("\0") || cmd.length > 1024) {
    throw new TypeError("Job command must be a NUL-free string of at most 1024 characters");
  }
  const dir = secureDirectory({ create: true, throwOnError: true });
  const existing = fs
    .readdirSync(dir)
    .filter((file) => file.endsWith(".json") && isValidJobId(file.slice(0, -5)));
  if (existing.length >= MAX_JOB_FILES) {
    throw new Error(`Grok job registry is full (${MAX_JOB_FILES} records); remove old jobs before starting another`);
  }

  let id;
  do {
    id = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  } while (fs.existsSync(recordPath(id)));

  const record = {
    id,
    kind: normalizedKind,
    status: "queued",
    pid: null,
    pidStart: null,
    childPid: null,
    childPidStart: null,
    startedAt: nowIso(),
    finishedAt: null,
    cmd,
    outFile: outputPath(id),
    summary: ""
  };
  atomicPrivateWrite(record.outFile, Buffer.alloc(0));
  if (!writeRecord(record)) {
    try {
      fs.unlinkSync(record.outFile);
    } catch {
      // Preserve the actionable record-write failure below.
    }
    throw new Error("Could not persist the Grok job record");
  }
  return record;
}

export function processStartToken(pid) {
  if (!isValidJobPid(pid)) {
    return null;
  }
  if (process.platform === "linux") {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const close = stat.lastIndexOf(")");
      const fields = close >= 0 ? stat.slice(close + 1).trim().split(/\s+/) : [];
      const startTime = fields[19];
      if (/^\d+$/.test(startTime)) {
        return `proc:${startTime}`;
      }
    } catch {
      // Fall through to the portable process-start probe.
    }
  }
  if (process.platform !== "win32") {
    const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 2000,
      maxBuffer: 4096,
      windowsHide: true
    });
    const started = result.status === 0 ? result.stdout.trim().replace(/\s+/g, " ") : "";
    if (started) {
      return `ps:${started}`;
    }
  } else {
    const result = spawnSync(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`
      ],
      {
        encoding: "utf8",
        timeout: 3000,
        maxBuffer: 4096,
        windowsHide: true
      }
    );
    const ticks = result.status === 0 ? result.stdout.trim() : "";
    if (/^\d+$/.test(ticks)) {
      return `win:${ticks}`;
    }
  }
  // If creation time cannot be established, fail closed instead of storing a
  // PID-only token that could target an unrelated process after PID reuse.
  return null;
}

function processMatches(pid, expectedStart) {
  if (!isValidJobPid(pid) || !validStartToken(expectedStart)) {
    return false;
  }
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (!error || error.code !== "EPERM") {
      return false;
    }
  }
  return processStartToken(pid) === expectedStart;
}

function updateJob(id, patch) {
  if (!isValidJobId(id) || !patch || typeof patch !== "object" || Array.isArray(patch)) {
    return null;
  }
  const lock = acquireLock(id);
  if (!lock) {
    return null;
  }
  try {
    const job = readRecord(id);
    if (!job) {
      return null;
    }
    // Terminal states are sticky. In particular, a background wrapper that
    // observes its child exiting after cancellation cannot overwrite
    // "cancelled" with "done" or "failed".
    if (TERMINAL_STATUSES.has(job.status)) {
      return job;
    }
    return writeRecord({ ...job, ...patch, id }, id);
  } finally {
    releaseLock(lock);
  }
}

export function markRunning(id, pid) {
  const pidStart = processStartToken(pid);
  if (!pidStart) {
    return null;
  }
  return updateJob(id, { status: "running", pid, pidStart, startedAt: nowIso() });
}

export function recordChildPid(id, childPid) {
  const childPidStart = processStartToken(childPid);
  if (!childPidStart) {
    return null;
  }
  return updateJob(id, { childPid, childPidStart });
}

export function markDone(id, summary = "") {
  return updateJob(id, {
    status: "done",
    finishedAt: nowIso(),
    summary: String(summary).slice(0, 500)
  });
}

export function markFailed(id, error = "") {
  return updateJob(id, {
    status: "failed",
    finishedAt: nowIso(),
    summary: String(error).slice(0, 500)
  });
}

export function markCancelled(id) {
  return updateJob(id, { status: "cancelled", finishedAt: nowIso() });
}

function reconcileRecord(record, expectedId) {
  if (!validRecord(record, expectedId) || record.status !== "running") {
    return record;
  }
  if (processMatches(record.pid, record.pidStart)) {
    return record;
  }
  return (
    markFailed(
      expectedId,
      `process ${record.pid} is no longer running as the recorded job process; it exited without recording a result`
    ) ?? record
  );
}

export function readJob(id) {
  return isValidJobId(id) ? reconcileRecord(readRecord(id), id) : null;
}

export function writeOutput(id, text) {
  const file = outputPath(id);
  if (!file || !readRecord(id)) {
    return false;
  }
  const source = Buffer.from(String(text ?? ""));
  let bounded = source;
  if (source.length > MAX_OUTPUT_BYTES) {
    const suffix = Buffer.from("\n\n[output truncated at 4 MiB]\n");
    bounded = Buffer.concat([source.subarray(0, MAX_OUTPUT_BYTES - suffix.length), suffix]);
  }
  try {
    atomicPrivateWrite(file, bounded);
    return true;
  } catch {
    return false;
  }
}

export function readOutput(id) {
  const file = outputPath(id);
  if (!file || !readRecord(id)) {
    return null;
  }
  const bytes = readPrivateFile(file, MAX_OUTPUT_BYTES);
  return bytes ? bytes.toString("utf8") : null;
}

export function listJobs() {
  const dir = secureDirectory();
  if (!dir) {
    return [];
  }
  let ids;
  try {
    ids = fs
      .readdirSync(dir)
      .filter((file) => file.endsWith(".json"))
      .map((file) => file.slice(0, -5))
      .filter(isValidJobId)
      .sort((a, b) => b.localeCompare(a))
      .slice(0, MAX_JOB_FILES);
  } catch {
    return [];
  }
  return ids.map((id) => reconcileRecord(readRecord(id), id)).filter(Boolean);
}

function signalRecordedProcess(pid, startToken, { group = false, signal = "SIGTERM" } = {}) {
  if (!processMatches(pid, startToken)) {
    return false;
  }
  try {
    const target = group && process.platform !== "win32" ? -pid : pid;
    process.kill(target, signal);
    return true;
  } catch {
    // A process may not be a group leader on older callers/tests. Falling back
    // to its verified direct PID is still safer than leaving it orphaned.
    if (group && process.platform !== "win32" && processMatches(pid, startToken)) {
      try {
        process.kill(pid, signal);
        return true;
      } catch {
        // The process exited between the identity check and the fallback.
      }
    }
    return false;
  }
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

  // Persist cancellation before signaling anything. The lock and sticky
  // terminal-state rule prevent the wrapper's exit path from racing this back
  // to done/failed.
  const cancelled = markCancelled(id);
  if (!cancelled || cancelled.status !== "cancelled") {
    return { ok: false, error: `Could not safely mark job ${id} as cancelled.` };
  }

  const targets = [
    { pid: job.childPid, token: job.childPidStart, group: true },
    { pid: job.pid, token: job.pidStart, group: false }
  ].filter(({ pid, token }) => isValidJobPid(pid) && validStartToken(token));

  for (const target of targets) {
    signalRecordedProcess(target.pid, target.token, { group: target.group, signal: "SIGTERM" });
  }
  if (targets.length > 0) {
    setTimeout(() => {
      for (const target of targets) {
        signalRecordedProcess(target.pid, target.token, { group: target.group, signal: "SIGKILL" });
      }
    }, SIGNAL_GRACE_MS);
  }
  return { ok: true, job: cancelled };
}
