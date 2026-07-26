import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { parseInvocation, resolveWebSearch, validateInvocation } from "../scripts/grok.mjs";
import { selectReviewTarget, buildReviewPrompt, resolveDiff } from "../scripts/lib/git.mjs";
import { resolveModel } from "../scripts/lib/config.mjs";

function tmpRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-review-scope-"));
  const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "a@b.c");
  git("config", "user.name", "a");
  fs.writeFileSync(path.join(dir, "f.txt"), "base\n");
  git("add", "f.txt");
  git("commit", "-qm", "base");
  return { dir, git };
}

test("ask: parses --model override and --no-search from a single $ARGUMENTS token", () => {
  const { options, positionals } = parseInvocation(["--model grok-composer-2.5-fast --no-search What is 2+2?"]);
  assert.equal(options.model, "grok-composer-2.5-fast");
  assert.equal(options["no-search"], true);
  assert.equal(positionals.join(" "), "What is 2+2?");
});

test("ask: a bare prompt yields no options and the full prompt", () => {
  const { options, positionals } = parseInvocation(["what is the capital of France"]);
  assert.deepEqual(options, {});
  assert.equal(positionals.join(" "), "what is the capital of France");
});

test("ask: option-looking words inside prompt text remain prompt data", () => {
  const { options, positionals } = parseInvocation([
    "explain --model grok-build and --no-search behavior"
  ]);
  assert.deepEqual(options, {});
  assert.equal(
    positionals.join(" "),
    "explain --model grok-build and --no-search behavior"
  );
});

test("dispatcher: conflicting and out-of-range options fail before execution", () => {
  assert.throws(
    () => validateInvocation(parseInvocation(["--search --no-search hi"]), "ask"),
    /only one/i
  );
  assert.throws(
    () => validateInvocation(parseInvocation(["--effort low --reasoning-effort high hi"]), "ask"),
    /only one/i
  );
  assert.throws(
    () => validateInvocation(parseInvocation(["--max-turns 0 hi"]), "ask"),
    /max-turns/
  );
  assert.throws(
    () => validateInvocation(parseInvocation(["--json hi"]), "ask"),
    /unsupported option/i
  );
  assert.throws(
    () => validateInvocation(parseInvocation(["unexpected"]), "review"),
    /positional/
  );
});

test("ask: default model is search_model (grok-4.5); --model overrides it", () => {
  const config = {
    default_model: "grok-4.5",
    search_model: "grok-4.5",
    fallback_model: "grok-composer-2.5-fast"
  };
  assert.equal(resolveModel({ kind: "search", config }), "grok-4.5");
  assert.equal(
    resolveModel({ explicit: "grok-composer-2.5-fast", kind: "search", config }),
    "grok-composer-2.5-fast"
  );
});

test("review: scope selection distinguishes base vs working-tree vs auto", () => {
  assert.deepEqual(selectReviewTarget({ base: "main" }), { mode: "branch", base: "main" });
  assert.deepEqual(selectReviewTarget({ scope: "working-tree" }), { mode: "working-tree", base: null });
  assert.deepEqual(selectReviewTarget({ scope: "auto" }), { mode: "auto", base: null });
  assert.deepEqual(selectReviewTarget({ scope: "branch" }), { mode: "branch", base: null });
  assert.throws(() => selectReviewTarget({ scope: "bogus" }), /Unsupported review scope/);
});

test("review: buildReviewPrompt embeds the diff and enforces read-only framing", () => {
  const prompt = buildReviewPrompt({
    label: "working tree diff",
    diff: "diff --git a/x b/x\n+fake change"
  });
  assert.ok(prompt.includes("+fake change"));
  assert.ok(prompt.includes("working tree diff"));
  assert.ok(/findings only/i.test(prompt));
  assert.ok(/do not rewrite/i.test(prompt));
});

test("review: uses default_model by default; --model overrides", () => {
  const config = {
    default_model: "grok-4.5",
    search_model: "grok-4.5",
    fallback_model: "grok-composer-2.5-fast"
  };
  assert.equal(resolveModel({ kind: "default", config }), "grok-4.5");
  assert.equal(resolveModel({ explicit: "grok-composer-2.5-fast", kind: "default", config }), "grok-composer-2.5-fast");
});

// --- Codex review fix #2: ask honors the configured web_search default ---

test("ask web search: --no-search forces off even when config has it on", () => {
  assert.equal(resolveWebSearch({ "no-search": true }, { web_search: true }), false);
});

test("ask web search: honors config web_search=false when no flag is given", () => {
  assert.equal(resolveWebSearch({}, { web_search: false }), false);
});

test("ask web search: defaults on when config is unset", () => {
  assert.equal(resolveWebSearch({}, {}), true);
  assert.equal(resolveWebSearch({}, { web_search: true }), true);
});

test("ask web search: --search forces on even when config has it off", () => {
  assert.equal(resolveWebSearch({ search: true }, { web_search: false }), true);
});

// --- Codex review fix #1: auto scope falls back to a branch diff when clean ---

test("review(auto): clean feature branch falls back to a branch diff, not 'Nothing to review'", () => {
  const { dir, git } = tmpRepo();
  try {
    git("checkout", "-qb", "feature");
    fs.writeFileSync(path.join(dir, "f.txt"), "base\nfeature change\n");
    git("commit", "-qam", "feature change");
    // working tree is now clean; the change lives only in commits on `feature`
    const info = resolveDiff({ scope: "auto", cwd: dir });
    assert.equal(info.hasChanges, true);
    assert.match(info.label, /branch diff against main/);
    assert.match(info.diff, /feature change/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("review(auto): a dirty working tree still reviews the working tree", () => {
  const { dir } = tmpRepo();
  try {
    fs.writeFileSync(path.join(dir, "f.txt"), "base\nuncommitted\n");
    const info = resolveDiff({ scope: "auto", cwd: dir });
    assert.equal(info.hasChanges, true);
    assert.match(info.label, /working tree/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("review(auto): a clean default branch with nothing ahead has nothing to review", () => {
  const { dir } = tmpRepo();
  try {
    const info = resolveDiff({ scope: "auto", cwd: dir });
    assert.equal(info.hasChanges, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- Codex sweep fix: a bad/undetectable --base must error, not silently report clean ---

test("review(--base bogus): a nonexistent base ref errors instead of 'Nothing to review'", () => {
  const { dir, git } = tmpRepo();
  try {
    git("checkout", "-qb", "feature");
    fs.writeFileSync(path.join(dir, "f.txt"), "base\nwork\n");
    git("commit", "-qam", "work");
    const info = resolveDiff({ scope: "auto", base: "maaain", cwd: dir });
    assert.ok(info.error, "expected an error for a nonexistent base ref");
    assert.match(info.error, /not found/i);
    assert.equal(info.hasChanges, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("review(--scope branch): no detectable base errors instead of silently using working tree", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-nobase-"));
  try {
    const git = (...a) => execFileSync("git", a, { cwd: dir, stdio: "pipe" });
    git("init", "-q", "-b", "devfeature"); // no main/master/trunk, no remote
    git("config", "user.email", "a@b.c");
    git("config", "user.name", "a");
    fs.writeFileSync(path.join(dir, "f.txt"), "x\n");
    git("add", "f.txt");
    git("commit", "-qm", "c1");
    const info = resolveDiff({ scope: "branch", cwd: dir });
    assert.ok(info.error, "expected an error when no base branch is detectable");
    assert.match(info.error, /base branch/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("review(non-repo): running outside a git repository errors instead of 'Nothing to review'", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-nonrepo-"));
  try {
    const info = resolveDiff({ scope: "auto", cwd: dir });
    assert.ok(info.error, "expected an error outside a git repository");
    assert.match(info.error, /not a git repository/i);
    assert.equal(info.hasChanges, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("review(--base valid): a real base still produces a branch diff (no false error)", () => {
  const { dir, git } = tmpRepo();
  try {
    git("checkout", "-qb", "feature");
    fs.writeFileSync(path.join(dir, "f.txt"), "base\nBASE_OK_MARKER\n");
    git("commit", "-qam", "work");
    const info = resolveDiff({ scope: "auto", base: "main", cwd: dir });
    assert.equal(info.error, undefined);
    assert.equal(info.hasChanges, true);
    assert.match(info.diff, /BASE_OK_MARKER/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
