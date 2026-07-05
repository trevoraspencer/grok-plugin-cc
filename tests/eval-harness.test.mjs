// Regression tests for the eval-harness dry-run validators (review finding
// MED-1): stdout that parses as JSON but has the WRONG SHAPE is drift and must
// fail closed — the mandatory_dry_runs release gate exists to catch exactly
// that. Importing the harness must not execute it (main() is guarded).

import { test } from "node:test";
import assert from "node:assert/strict";

import { dryRunCases } from "../auto/eval-harness.mjs";

function validatorFor(id) {
  const found = dryRunCases().find((testCase) => testCase.id === id);
  assert.ok(found, `dry-run case ${id} should exist`);
  return (stdout) => found.validate({ stdout });
}

const CONFORMING_ARGV = [
  "-p",
  "What is 2+2?",
  "--output-format",
  "json",
  "-m",
  "grok-composer-2.5-fast",
  "--no-auto-update",
  "--disable-web-search"
];

test("eval harness: ask dry-run passes a conforming argv array", () => {
  const validate = validatorFor("ask_explicit_model_no_search");
  assert.equal(validate(JSON.stringify(CONFORMING_ARGV)).ok, true);
});

test("eval harness: ask dry-run fails closed on drifted (non-array) JSON", () => {
  const validate = validatorFor("ask_explicit_model_no_search");
  // e.g. --print-args drifting from a bare argv array to a wrapper object
  const drifted = validate(JSON.stringify({ args: CONFORMING_ARGV }));
  assert.equal(drifted.ok, false);
  assert.match(drifted.error, /argv array/);
  // non-JSON stdout is still a failure
  assert.equal(validate("not json").ok, false);
  // an argv array missing a required flag is still a failure
  const missingFlag = CONFORMING_ARGV.filter((part) => part !== "--disable-web-search");
  assert.equal(validate(JSON.stringify(missingFlag)).ok, false);
});

test("eval harness: review dry-run fails closed on drifted (non-array) JSON", () => {
  const validate = validatorFor("review_dry_run_read_only");
  const conforming = [
    "-p",
    "Review the following working tree diff. Do NOT rewrite the code.",
    "--output-format",
    "json",
    "-m",
    "grok-composer-2.5-fast",
    "--no-auto-update",
    "--disable-web-search"
  ];
  assert.equal(validate(JSON.stringify(conforming)).ok, true);
  const drifted = validate(JSON.stringify({ args: conforming }));
  assert.equal(drifted.ok, false);
  assert.match(drifted.error, /argv array/);
});

test("eval harness: setup smoke fails closed on drifted (non-object) JSON", () => {
  const validate = validatorFor("setup_json_smoke");
  const conforming = { ok: true, cliOk: true, checks: [], nextSteps: [] };
  assert.equal(validate(JSON.stringify(conforming)).ok, true);
  // scalar / null drift used to early-return the parser's ok:true object
  assert.equal(validate(JSON.stringify("ok")).ok, false);
  assert.match(validate(JSON.stringify("ok")).error, /JSON object/);
  assert.equal(validate("null").ok, false);
  // an object missing the report keys is still a failure
  assert.equal(validate("{}").ok, false);
});
