// Git helpers for /grok:review. Read-only: these only ever inspect repository
// state, never mutate it. All git invocation is contained here.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

import { truncate } from "./render.mjs";

const MAX_DIFF_BYTES = 100 * 1024;
const MAX_UNTRACKED_BYTES = 24 * 1024;

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

function renderUntracked(cwd, relativePath) {
  const absolute = path.join(cwd, relativePath);
  let stat;
  try {
    stat = fs.statSync(absolute);
  } catch {
    return `### ${relativePath}\n(skipped: unreadable)`;
  }
  if (stat.isDirectory()) {
    return `### ${relativePath}\n(skipped: directory)`;
  }
  if (stat.size > MAX_UNTRACKED_BYTES) {
    return `### ${relativePath}\n(skipped: ${stat.size} bytes exceeds ${MAX_UNTRACKED_BYTES} limit)`;
  }
  let buffer;
  try {
    buffer = fs.readFileSync(absolute);
  } catch {
    return `### ${relativePath}\n(skipped: unreadable)`;
  }
  if (buffer.includes(0)) {
    return `### ${relativePath}\n(skipped: binary)`;
  }
  return `### ${relativePath}\n\`\`\`\n${buffer.toString("utf8").trimEnd()}\n\`\`\``;
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
  const untrackedBlock = untracked.map((file) => renderUntracked(cwd, file)).join("\n\n");
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
  const body = truncate(raw, MAX_DIFF_BYTES);
  const truncatedNote =
    raw.length > MAX_DIFF_BYTES ? "\n(Note: the diff was truncated to fit the size limit.)" : "";
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
