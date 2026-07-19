import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { renderUntracked, resolveDiff } from "../scripts/lib/git.mjs";

function makeRepo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "grok-git-review-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const initialized = spawnSync("git", ["init", "--quiet"], { cwd: root, encoding: "utf8" });
  assert.equal(initialized.status, 0, initialized.stderr);
  return root;
}

function fileSystemWith(overrides = {}) {
  return {
    constants: fs.constants,
    closeSync: fs.closeSync,
    fstatSync: fs.fstatSync,
    lstatSync: fs.lstatSync,
    openSync: fs.openSync,
    readSync: fs.readSync,
    realpathSync: fs.realpathSync,
    ...overrides
  };
}

test("git: working-tree review includes regular untracked files", (t) => {
  const root = makeRepo(t);
  fs.writeFileSync(path.join(root, "notes.txt"), "ordinary untracked contents\n");

  const review = resolveDiff({ scope: "working-tree", cwd: root });

  assert.equal(review.hasChanges, true);
  assert.match(review.diff, /### notes\.txt/);
  assert.match(review.diff, /ordinary untracked contents/);
});

test("git: working-tree review never reads an untracked symlink target", (t) => {
  const root = makeRepo(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "grok-git-secret-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));

  const secret = "external-secret-that-must-not-enter-the-review";
  const target = path.join(outside, "secret.txt");
  fs.writeFileSync(target, `${secret}\n`);
  fs.symlinkSync(target, path.join(root, "linked-secret.txt"));

  const review = resolveDiff({ scope: "working-tree", cwd: root });

  assert.equal(review.hasChanges, true);
  assert.match(review.diff, /### linked-secret\.txt/);
  assert.match(review.diff, /skipped: symbolic link/);
  assert.doesNotMatch(review.diff, new RegExp(secret));
});

test("git: parent-directory swap cannot redirect an untracked read outside the checkout", (t) => {
  const root = makeRepo(t);
  const originalParent = path.join(root, "pending");
  const parkedParent = path.join(root, "pending-before-swap");
  fs.mkdirSync(originalParent);
  fs.writeFileSync(path.join(originalParent, "notes.txt"), "safe contents\n");

  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "grok-git-parent-race-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const secret = "external-parent-swap-secret";
  fs.writeFileSync(path.join(outside, "notes.txt"), `${secret}\n`);

  let swapped = false;
  const raceFileSystem = fileSystemWith({
    openSync(file, flags) {
      if (!swapped) {
        swapped = true;
        fs.renameSync(originalParent, parkedParent);
        fs.symlinkSync(outside, originalParent, process.platform === "win32" ? "junction" : "dir");
      }
      return fs.openSync(file, flags);
    }
  });

  const rendered = renderUntracked(root, "pending/notes.txt", {
    checkoutRoot: fs.realpathSync(root),
    fileSystem: raceFileSystem
  });

  assert.equal(swapped, true);
  assert.match(rendered, /skipped: file changed while opening/);
  assert.doesNotMatch(rendered, new RegExp(secret));
});

test("git: identity check protects platforms without O_NOFOLLOW from a final-component swap", (t) => {
  const root = makeRepo(t);
  const reviewed = path.join(root, "notes.txt");
  const parked = path.join(root, "notes-before-swap.txt");
  fs.writeFileSync(reviewed, "safe contents\n");

  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "grok-git-final-race-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const secret = "external-final-swap-secret";
  const target = path.join(outside, "secret.txt");
  fs.writeFileSync(target, `${secret}\n`);

  let swapped = false;
  const raceFileSystem = fileSystemWith({
    constants: { O_RDONLY: fs.constants.O_RDONLY },
    openSync(file) {
      if (!swapped) {
        swapped = true;
        fs.renameSync(reviewed, parked);
        fs.symlinkSync(target, reviewed);
      }
      return fs.openSync(file, fs.constants.O_RDONLY);
    }
  });

  const rendered = renderUntracked(root, "notes.txt", {
    checkoutRoot: fs.realpathSync(root),
    fileSystem: raceFileSystem
  });

  assert.equal(swapped, true);
  assert.match(rendered, /skipped: file changed while opening/);
  assert.doesNotMatch(rendered, new RegExp(secret));
});

test("git: an unavailable file identity fails closed", (t) => {
  const root = makeRepo(t);
  const reviewed = path.join(root, "unknown-identity.txt");
  const secret = "identity-unavailable-secret";
  fs.writeFileSync(reviewed, `${secret}\n`);

  const unidentifiedFileSystem = fileSystemWith({
    fstatSync(descriptor, options) {
      const stat = fs.fstatSync(descriptor, options);
      return {
        dev: stat.dev,
        ino: 0n,
        size: stat.size,
        isFile: () => stat.isFile()
      };
    }
  });

  const rendered = renderUntracked(root, "unknown-identity.txt", {
    checkoutRoot: fs.realpathSync(root),
    fileSystem: unidentifiedFileSystem
  });

  assert.match(rendered, /skipped: file identity unavailable/);
  assert.doesNotMatch(rendered, new RegExp(secret));
});

test("git: a file that grows after fstat is bounded and rejected", (t) => {
  const root = makeRepo(t);
  const reviewed = path.join(root, "growing.txt");
  fs.writeFileSync(reviewed, "safe contents\n");

  const secret = "post-stat-growth-secret";
  let grew = false;
  const growingFileSystem = fileSystemWith({
    fstatSync(descriptor, options) {
      const stat = fs.fstatSync(descriptor, options);
      if (!grew) {
        grew = true;
        fs.appendFileSync(reviewed, `${secret}${"x".repeat(32 * 1024)}\n`);
      }
      return stat;
    }
  });

  const rendered = renderUntracked(root, "growing.txt", {
    checkoutRoot: fs.realpathSync(root),
    fileSystem: growingFileSystem
  });

  assert.equal(grew, true);
  assert.match(rendered, /skipped: file grew beyond \d+ byte limit/);
  assert.doesNotMatch(rendered, new RegExp(secret));
});
