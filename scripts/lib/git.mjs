// Git helpers for /grok:review. Read-only: these only ever inspect repository
// state, never mutate it. All git invocation is contained here.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

import { truncate } from "./render.mjs";

// Measured in UTF-16 code units (String.length via truncate), not bytes —
// multi-byte text can weigh more on the wire, but the cap is self-consistent.
const MAX_DIFF_CHARS = 100 * 1024;
const MAX_UNTRACKED_BYTES = 24 * 1024;
const BIGINT_STATS = { bigint: true };

function git(args, cwd = process.cwd()) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true
  });
  return {
    status: result.status ?? (result.error ? 1 : 0),
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ?? null
  };
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
  return git(["diff", "--no-ext-diff", `${base}...HEAD`], cwd).stdout;
}

// Whether a ref resolves to a commit. Used to reject a typo'd --base before
// branchDiff (whose empty stdout on a bad ref would otherwise read as "no
// changes" and hide a whole branch).
export function refExists(ref, cwd = process.cwd()) {
  return git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], cwd).status === 0;
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
  return git(["ls-files", "--others", "--exclude-standard"], cwd)
    .stdout.trim()
    .split("\n")
    .filter(Boolean);
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

  // Resolve `auto`: review the working tree when it is dirty; otherwise fall
  // back to a branch diff against the detected default base, so a clean-but-
  // committed feature branch is still reviewed instead of reporting nothing.
  let mode = target.mode;
  let ref = target.base;
  if (mode === "auto") {
    if (statusShort(cwd).length > 0) {
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
    const diff = branchDiff(branchRef, cwd);
    return {
      label: `branch diff against ${branchRef} (${branchRef}...HEAD)`,
      diff,
      hasChanges: diff.trim().length > 0
    };
  }

  const status = statusShort(cwd);
  const tracked = workingTreeDiff(cwd);
  const untracked = listUntracked(cwd);
  const untrackedBlock = untracked
    .map((file) => renderUntracked(cwd, file, { checkoutRoot }))
    .join("\n\n");
  const diff = [
    status ? `# git status\n${status}` : "",
    tracked ? `# tracked changes (staged + unstaged)\n${tracked}` : "",
    untrackedBlock ? `# untracked files\n${untrackedBlock}` : ""
  ]
    .filter(Boolean)
    .join("\n\n");

  return { label: "working tree diff", diff, hasChanges: status.length > 0 };
}

// Compose the read-only review prompt from a resolved diff. Pure + testable.
export function buildReviewPrompt({ label, diff }) {
  const raw = String(diff ?? "");
  const body = truncate(raw, MAX_DIFF_CHARS);
  const truncatedNote =
    raw.length > MAX_DIFF_CHARS ? "\n(Note: the diff was truncated to fit the size limit.)" : "";
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
