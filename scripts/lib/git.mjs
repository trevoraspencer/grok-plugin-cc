// Git helpers for /grok:review. Read-only: these only ever inspect repository
// state, never mutate it. All git invocation is contained here.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

import { truncate } from "./render.mjs";

// Leave headroom for the review instructions inside the 100 KiB prompt argv
// boundary enforced by lib/grok.mjs.
const MAX_DIFF_BYTES = 96 * 1024;
const MAX_UNTRACKED_BYTES = 24 * 1024;
const MAX_UNTRACKED_FILES = 1000;
const MAX_PATH_CHARS = 4096;
const GIT_TIMEOUT_MS = 15_000;
const GIT_MAX_BUFFER = 8 * 1024 * 1024;
const BIGINT_STATS = { bigint: true };

function git(args, cwd = process.cwd()) {
  const noHooks = process.platform === "win32" ? "NUL" : "/dev/null";
  const result = spawnSync(
    "git",
    [
      "-c",
      "core.fsmonitor=false",
      "-c",
      `core.hooksPath=${noHooks}`,
      "-c",
      "submodule.recurse=false",
      ...args
    ],
    {
      cwd,
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
      windowsHide: true
    }
  );
  return {
    status: result.status ?? (result.error ? 1 : 0),
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ?? null
  };
}

function gitFailure(result, operation) {
  const detail = (result.stderr || result.error?.message || "").trim();
  return `${operation} failed${detail ? `: ${truncate(detail, 500)}` : "."}`;
}

// Review refs are data, never options or arbitrary revision expressions.
// Support ordinary branches, tags, remote refs, SHA-like values, and HEAD~N,
// while rejecting option-shaped and range/reflog syntax.
export function isSafeRevision(ref) {
  return (
    typeof ref === "string" &&
    ref.length > 0 &&
    ref.length <= 256 &&
    /^[A-Za-z0-9][A-Za-z0-9._/@+~/-]*$/.test(ref) &&
    !ref.startsWith("-") &&
    !ref.includes("..") &&
    !ref.includes("@{") &&
    !ref.includes("//") &&
    !ref.endsWith("/") &&
    !ref.endsWith(".") &&
    !ref.endsWith(".lock")
  );
}

export function isGitRepo(cwd = process.cwd()) {
  return git(["rev-parse", "--is-inside-work-tree"], cwd).status === 0;
}

export function statusShort(cwd = process.cwd()) {
  return git(["status", "--short", "--untracked-files=all"], cwd).stdout.trim();
}

export function hasChanges(cwd = process.cwd()) {
  return isGitRepo(cwd) && statusShort(cwd).length > 0;
}

export function workingTreeDiff(cwd = process.cwd()) {
  const staged = git(["diff", "--cached", "--no-ext-diff"], cwd).stdout;
  const unstaged = git(["diff", "--no-ext-diff"], cwd).stdout;
  return [staged, unstaged].filter((part) => part.trim()).join("\n");
}

export function branchDiff(base, cwd = process.cwd()) {
  if (!isSafeRevision(base)) {
    return "";
  }
  return git(["diff", "--no-ext-diff", "--no-textconv", `${base}...HEAD`, "--"], cwd).stdout;
}

// Whether a ref resolves to a commit. Used to reject a typo'd --base before
// branchDiff (whose empty stdout on a bad ref would otherwise read as "no
// changes" and hide a whole branch).
export function refExists(ref, cwd = process.cwd()) {
  return (
    isSafeRevision(ref) &&
    git(["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`], cwd).status === 0
  );
}

export function detectDefaultBranch(cwd = process.cwd()) {
  for (const candidate of ["main", "master", "trunk"]) {
    if (git(["show-ref", "--verify", "--quiet", `refs/heads/${candidate}`], cwd).status === 0) {
      return candidate;
    }
  }
  const symbolic = git(["symbolic-ref", "refs/remotes/origin/HEAD"], cwd);
  if (symbolic.status === 0) {
    const head = symbolic.stdout.trim().replace("refs/remotes/origin/", "origin/");
    if (head) {
      return head;
    }
  }
  return null;
}

function listUntracked(cwd) {
  const result = git(["ls-files", "-z", "--others", "--exclude-standard"], cwd);
  if (result.status !== 0) {
    return { files: [], truncated: false, error: gitFailure(result, "Listing untracked files") };
  }
  const all = result.stdout.split("\0").filter(Boolean);
  const files = all.filter((file) => file.length <= MAX_PATH_CHARS).slice(0, MAX_UNTRACKED_FILES);
  return {
    files,
    truncated: all.length > files.length,
    error: null
  };
}

function pathIsWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function hasFileIdentity(stat) {
  // BigInt stats avoid inode truncation. An unavailable/zero inode cannot
  // establish identity portably, so fail closed rather than reading.
  return (
    typeof stat?.dev === "bigint" &&
    typeof stat?.ino === "bigint" &&
    stat.ino !== 0n
  );
}

function sameFileIdentity(before, after) {
  return before.dev === after.dev && before.ino === after.ino;
}

function readBounded(descriptor, fileSystem) {
  const buffer = Buffer.alloc(MAX_UNTRACKED_BYTES + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const bytesRead = fileSystem.readSync(descriptor, buffer, offset, buffer.length - offset, null);
    if (bytesRead === 0) {
      break;
    }
    offset += bytesRead;
  }
  return buffer.subarray(0, offset);
}

export function renderUntracked(cwd, relativePath, { checkoutRoot, fileSystem = fs } = {}) {
  const absolute = path.join(cwd, relativePath);
  let stat;
  try {
    if (checkoutRoot === undefined) {
      checkoutRoot = fileSystem.realpathSync(cwd);
    }
    stat = fileSystem.lstatSync(absolute, BIGINT_STATS);
  } catch {
    return `### ${relativePath}\n(skipped: unreadable)`;
  }
  if (stat.isSymbolicLink()) {
    return `### ${relativePath}\n(skipped: symbolic link)`;
  }
  if (!stat.isFile()) {
    return `### ${relativePath}\n(skipped: not a regular file)`;
  }

  let resolved;
  try {
    resolved = fileSystem.realpathSync(absolute);
  } catch {
    return `### ${relativePath}\n(skipped: unreadable)`;
  }
  if (
    typeof checkoutRoot !== "string" ||
    typeof resolved !== "string" ||
    !pathIsWithin(checkoutRoot, resolved)
  ) {
    return `### ${relativePath}\n(skipped: outside working tree)`;
  }

  let descriptor;
  try {
    // O_NOFOLLOW blocks final-component swaps where available. The identity
    // check below also covers platforms without it and parent-directory swaps.
    const noFollow = fileSystem.constants.O_NOFOLLOW ?? 0;
    descriptor = fileSystem.openSync(absolute, fileSystem.constants.O_RDONLY | noFollow);
    const openedStat = fileSystem.fstatSync(descriptor, BIGINT_STATS);
    if (!openedStat.isFile()) {
      return `### ${relativePath}\n(skipped: not a regular file)`;
    }
    if (!hasFileIdentity(stat) || !hasFileIdentity(openedStat)) {
      return `### ${relativePath}\n(skipped: file identity unavailable)`;
    }
    if (!sameFileIdentity(stat, openedStat)) {
      return `### ${relativePath}\n(skipped: file changed while opening)`;
    }
    if (openedStat.size > BigInt(MAX_UNTRACKED_BYTES)) {
      return `### ${relativePath}\n(skipped: ${openedStat.size} bytes exceeds ${MAX_UNTRACKED_BYTES} limit)`;
    }
    const buffer = readBounded(descriptor, fileSystem);
    if (buffer.length > MAX_UNTRACKED_BYTES) {
      return `### ${relativePath}\n(skipped: file grew beyond ${MAX_UNTRACKED_BYTES} byte limit)`;
    }
    if (buffer.includes(0)) {
      return `### ${relativePath}\n(skipped: binary)`;
    }
    return `### ${relativePath}\n\`\`\`\n${buffer.toString("utf8").trimEnd()}\n\`\`\``;
  } catch {
    return `### ${relativePath}\n(skipped: unreadable)`;
  } finally {
    if (descriptor !== undefined) {
      try {
        fileSystem.closeSync(descriptor);
      } catch {
        // The read result is already determined; close errors are non-actionable here.
      }
    }
  }
}

// Pure target selection (no git calls) — unit-testable.
export function selectReviewTarget({ scope = "auto", base = null } = {}) {
  if (base) {
    return { mode: "branch", base };
  }
  const normalized = scope || "auto";
  if (normalized === "branch") {
    return { mode: "branch", base: null };
  }
  if (normalized === "working-tree") {
    return { mode: "working-tree", base: null };
  }
  if (normalized === "auto") {
    return { mode: "auto", base: null };
  }
  throw new Error(`Unsupported review scope "${normalized}". Use auto, working-tree, branch, or --base <ref>.`);
}

// Resolve the actual diff text + a human label + whether there's anything to review.
export function resolveDiff({ scope = "auto", base = null, cwd = process.cwd() } = {}) {
  if (!isGitRepo(cwd)) {
    // A non-repo cwd is a hard input error, same as a bad --base: reporting
    // "Nothing to review." here would misleadingly hide the review target.
    return {
      label: "working tree",
      diff: "",
      hasChanges: false,
      error: "Not a git repository. Run /grok:review from inside a git repository."
    };
  }

  // Capture the checkout's canonical identity before any working-tree
  // enumeration so replacing the cwd path cannot redefine the confinement
  // boundary between Git listing an entry and this process opening it.
  let checkoutRoot = null;
  try {
    checkoutRoot = fs.realpathSync(cwd);
  } catch {
    // Untracked files will fail closed; tracked Git output can still be useful.
  }

  const target = selectReviewTarget({ scope, base });
  const statusResult = git(["status", "--short", "--untracked-files=all"], cwd);
  if (statusResult.status !== 0) {
    return {
      label: "working tree",
      diff: "",
      hasChanges: false,
      error: gitFailure(statusResult, "Reading Git status")
    };
  }
  const status = statusResult.stdout.trim();

  // Resolve `auto`: review the working tree when it is dirty; otherwise fall
  // back to a branch diff against the detected default base, so a clean-but-
  // committed feature branch is still reviewed instead of reporting nothing.
  let mode = target.mode;
  let ref = target.base;
  if (mode === "auto") {
    if (status.length > 0) {
      mode = "working-tree";
    } else {
      const detected = detectDefaultBranch(cwd);
      if (detected) {
        mode = "branch";
        ref = detected;
      } else {
        mode = "working-tree";
      }
    }
  }

  if (mode === "branch") {
    const branchRef = ref || detectDefaultBranch(cwd);
    if (!branchRef) {
      // Explicit --scope branch but no base could be detected. Surface it
      // rather than silently degrading to a working-tree review.
      return {
        label: "branch diff",
        diff: "",
        hasChanges: false,
        error: "Could not detect a base branch to diff against. Pass --base <ref>."
      };
    }
    if (!isSafeRevision(branchRef)) {
      return {
        label: "branch diff",
        diff: "",
        hasChanges: false,
        error:
          "Invalid base ref. Use a branch, tag, remote ref, commit SHA, or simple HEAD~N expression; option/range syntax is not accepted."
      };
    }
    if (!refExists(branchRef, cwd)) {
      // A typo'd / nonexistent base would make git exit non-zero with empty
      // stdout, which would otherwise read as "nothing to review".
      return {
        label: `branch diff against ${branchRef}`,
        diff: "",
        hasChanges: false,
        error: `Base ref "${branchRef}" not found. Pass a valid --base <ref>.`
      };
    }
    const result = git(
      ["diff", "--no-ext-diff", "--no-textconv", `${branchRef}...HEAD`, "--"],
      cwd
    );
    if (result.status !== 0) {
      return {
        label: `branch diff against ${branchRef}`,
        diff: "",
        hasChanges: false,
        error: gitFailure(result, `Diff against "${branchRef}"`)
      };
    }
    const diff = result.stdout;
    return {
      label: `branch diff against ${branchRef} (${branchRef}...HEAD)`,
      diff,
      hasChanges: diff.trim().length > 0
    };
  }

  const stagedResult = git(["diff", "--cached", "--no-ext-diff", "--no-textconv", "--"], cwd);
  if (stagedResult.status !== 0) {
    return {
      label: "working tree diff",
      diff: "",
      hasChanges: false,
      error: gitFailure(stagedResult, "Reading staged changes")
    };
  }
  const unstagedResult = git(["diff", "--no-ext-diff", "--no-textconv", "--"], cwd);
  if (unstagedResult.status !== 0) {
    return {
      label: "working tree diff",
      diff: "",
      hasChanges: false,
      error: gitFailure(unstagedResult, "Reading unstaged changes")
    };
  }
  const tracked = [stagedResult.stdout, unstagedResult.stdout]
    .filter((part) => part.trim())
    .join("\n");
  const untracked = listUntracked(cwd);
  if (untracked.error) {
    return {
      label: "working tree diff",
      diff: "",
      hasChanges: false,
      error: untracked.error
    };
  }
  const untrackedParts = [];
  let untrackedBytes = 0;
  let untrackedRenderTruncated = false;
  for (const file of untracked.files) {
    const rendered = renderUntracked(cwd, file, { checkoutRoot });
    const renderedBytes = Buffer.byteLength(rendered, "utf8");
    if (untrackedBytes + renderedBytes > MAX_DIFF_BYTES) {
      untrackedRenderTruncated = true;
      break;
    }
    untrackedParts.push(rendered);
    untrackedBytes += renderedBytes + 2;
  }
  const untrackedBlock = untrackedParts.join("\n\n");
  const diff = [
    status ? `# git status\n${status}` : "",
    tracked ? `# tracked changes (staged + unstaged)\n${tracked}` : "",
    untrackedBlock ? `# untracked files\n${untrackedBlock}` : "",
    untracked.truncated
      ? `# untracked file notice\nOnly the first ${MAX_UNTRACKED_FILES} bounded paths were included.`
      : "",
    untrackedRenderTruncated
      ? "# untracked content notice\nAdditional untracked content was omitted after reaching the review budget."
      : ""
  ]
    .filter(Boolean)
    .join("\n\n");

  return { label: "working tree diff", diff, hasChanges: status.length > 0 };
}

// Compose the read-only review prompt from a resolved diff. Pure + testable.
export function buildReviewPrompt({ label, diff }) {
  const raw = String(diff ?? "");
  const rawBytes = Buffer.byteLength(raw, "utf8");
  let body = raw;
  if (rawBytes > MAX_DIFF_BYTES) {
    // Find the longest UTF-16 prefix whose UTF-8 encoding fits the byte budget.
    // Binary search avoids copying a potentially multi-megabyte diff once per
    // code point, and the surrogate adjustment keeps the prefix well-formed.
    let low = 0;
    let high = raw.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (Buffer.byteLength(raw.slice(0, middle), "utf8") <= MAX_DIFF_BYTES) {
        low = middle;
      } else {
        high = middle - 1;
      }
    }
    if (low > 0 && /[\uD800-\uDBFF]/.test(raw[low - 1])) {
      low -= 1;
    }
    body = raw.slice(0, low);
  }
  const truncatedNote =
    rawBytes > MAX_DIFF_BYTES ? "\n(Note: the diff was truncated to fit the size limit.)" : "";
  return [
    "You are an expert code reviewer acting as an outside model with different priors than the author.",
    `Review the following ${label}. Identify bugs, correctness issues, security problems, and risky changes.`,
    "Return prioritized findings only. Do NOT rewrite the code, output patches, or claim you will make changes.",
    `If you find nothing material, say so briefly.${truncatedNote}`,
    "",
    "```diff",
    body,
    "```"
  ].join("\n");
}
