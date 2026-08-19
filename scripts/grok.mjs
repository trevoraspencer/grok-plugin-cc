#!/usr/bin/env node
// Companion dispatcher for the grok plugin. Invoked as:
//   node scripts/grok.mjs <subcommand> "$ARGUMENTS"
// where "$ARGUMENTS" is the raw slash-command argument string (one shell token).
//
// Subcommands: ask, review, status, result, cancel, setup. All grok invocation
// goes through lib/grok.mjs.

import fs from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseArgs } from "./lib/args.mjs";
import { loadConfig, resolveModel } from "./lib/config.mjs";
import { buildGrokArgs, runGrok } from "./lib/grok.mjs";
import { renderResult, renderJobsTable, renderJobDetail, renderSetupReport } from "./lib/render.mjs";
import { resolveDiff, buildReviewPrompt } from "./lib/git.mjs";
import { gatherSetupInputs, buildSetupReport } from "./lib/setup.mjs";
import {
  createJob,
  markRunning,
  markDone,
  markFailed,
  recordChildPid,
  writeOutput,
  readJob,
  readOutput,
  listJobs,
  cancelJob
} from "./lib/jobs.mjs";

export const OPTION_SPEC = {
  valueOptions: ["model", "base", "scope", "max-turns", "effort", "reasoning-effort"],
  booleanOptions: ["no-search", "search", "background", "thought", "print-args", "json", "offline"],
  aliasMap: { m: "model" }
};

// $ARGUMENTS arrives as a single quoted token; join any stray tokens and split
// on whitespace (not quote-aware, so apostrophes in a prompt survive intact).
export function parseInvocation(rawArgs) {
  const raw = rawArgs.join(" ").trim();
  const tokens = raw.length ? raw.split(/\s+/) : [];
  return parseArgs(tokens, OPTION_SPEC);
}

// Resolve whether live web search is on for `ask`. Precedence: an explicit flag
// (--no-search / --search) wins; otherwise the configured `web_search` default
// applies (on unless config sets it false).
export function resolveWebSearch(options, config) {
  if (options["no-search"]) {
    return false;
  }
  if (options.search) {
    return true;
  }
  return config.web_search !== false;
}

const SUBCOMMAND_OPTIONS = {
  ask: new Set([
    "model",
    "no-search",
    "search",
    "max-turns",
    "effort",
    "reasoning-effort",
    "thought",
    "background",
    "print-args"
  ]),
  review: new Set([
    "model",
    "base",
    "scope",
    "search",
    "max-turns",
    "effort",
    "reasoning-effort",
    "thought",
    "background",
    "print-args"
  ]),
  status: new Set(),
  result: new Set(),
  cancel: new Set(),
  setup: new Set(["json", "offline"])
};

export function validateInvocation(parsed, subcommand = "ask") {
  const { options } = parsed;
  const allowed = SUBCOMMAND_OPTIONS[subcommand];
  if (allowed) {
    const unsupported = Object.keys(options).filter((key) => !allowed.has(key));
    if (unsupported.length > 0) {
      throw new Error(`Unsupported option for ${subcommand}: --${unsupported[0]}`);
    }
  }
  if (["review", "setup"].includes(subcommand) && parsed.positionals.length > 0) {
    throw new Error(`${subcommand} does not accept positional arguments.`);
  }
  if (subcommand === "status" && parsed.positionals.length > 1) {
    throw new Error("status accepts at most one job ID.");
  }
  if (["result", "cancel"].includes(subcommand) && parsed.positionals.length > 1) {
    throw new Error(`${subcommand} accepts exactly one job ID.`);
  }
  if (options.search && options["no-search"]) {
    throw new Error("Use only one of --search or --no-search.");
  }
  if (options.effort !== undefined && options["reasoning-effort"] !== undefined) {
    throw new Error("Use only one of --effort or --reasoning-effort.");
  }
  for (const key of ["effort", "reasoning-effort"]) {
    const value = options[key];
    if (value !== undefined && (String(value).includes("\0") || String(value).length > 64)) {
      throw new Error(`--${key} must be a NUL-free value of at most 64 characters.`);
    }
  }
  if (options["max-turns"] !== undefined) {
    const rendered = String(options["max-turns"]);
    if (!/^[1-9]\d*$/.test(rendered) || Number(rendered) > 4_294_967_295) {
      throw new Error("--max-turns must be an integer from 1 through 4294967295.");
    }
  }
  return parsed;
}

function out(text) {
  process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
}

function err(text) {
  process.stderr.write(text.endsWith("\n") ? text : `${text}\n`);
}

// Detached background runner: this process IS the background job (launched by
// Claude Code's run_in_background). Create a record, capture our own pid, run
// the grok call, write the rendered output to the job's out file, then mark it
// done/failed. The job id is printed first so the launching turn can report it.
async function runBackground({ kind, callOpts, showThought }) {
  let job;
  try {
    job = createJob({ kind });
  } catch (error) {
    err(`Could not create a secure background job: ${error.message}`);
    process.exitCode = 1;
    return;
  }
  if (!markRunning(job.id, process.pid)) {
    markFailed(job.id, "could not bind the background wrapper process");
    err(`Could not securely bind background job ${job.id} to its wrapper process.`);
    process.exitCode = 1;
    return;
  }
  out(`Started background ${kind} job: ${job.id}`);
  out(`Check progress with: /grok:status ${job.id}`);
  try {
    let childBindingError = null;
    // Record each spawned grok child's pid so /grok:cancel can terminate the
    // real work process too, not just this wrapper (which would orphan it).
    const result = await runGrok({
      ...callOpts,
      onSpawn: (child) => {
        if (recordChildPid(job.id, child.pid)) {
          return;
        }
        childBindingError = "could not bind the Grok child process to the background job";
        try {
          if (process.platform !== "win32" && Number.isInteger(child.pid)) {
            process.kill(-child.pid, "SIGTERM");
          } else {
            child.kill("SIGTERM");
          }
        } catch {
          // The child may already have exited; the failure is recorded below.
        }
      }
    });
    if (childBindingError) {
      writeOutput(job.id, `> ⚠ **Grok error**\n\n${childBindingError}\n`);
      markFailed(job.id, childBindingError);
      return;
    }
    if (!writeOutput(job.id, renderResult(result, { showThought }))) {
      markFailed(job.id, "could not persist bounded job output");
      return;
    }
    if (result.ok) {
      markDone(job.id, (result.text || "").trim().split("\n")[0] || "done");
    } else {
      markFailed(job.id, result.error);
    }
  } catch (error) {
    writeOutput(job.id, `> ⚠ **Grok error**\n\n${error.message}\n`);
    markFailed(job.id, error.message);
  }
}

async function cmdAsk(parsed, config) {
  const prompt = parsed.positionals.join(" ").trim();
  if (!prompt) {
    err(
      "Usage: /grok:ask [--model <slug>] [--no-search|--search] [--max-turns <n>] " +
        "[--effort <level>] [--reasoning-effort <level>] [--thought] [--background] [--print-args] <question>"
    );
    process.exitCode = 1;
    return;
  }

  const callOpts = {
    prompt,
    model: resolveModel({ explicit: parsed.options.model, kind: "search", config }),
    webSearch: resolveWebSearch(parsed.options, config),
    effort: parsed.options.effort,
    reasoningEffort: parsed.options["reasoning-effort"],
    maxTurns: parsed.options["max-turns"] ?? config.max_turns ?? undefined,
    timeoutMs: config.timeout_ms ?? undefined
  };

  if (parsed.options["print-args"]) {
    out(JSON.stringify(buildGrokArgs(callOpts)));
    return;
  }

  if (parsed.options.background) {
    return runBackground({
      kind: "ask",
      callOpts,
      showThought: Boolean(parsed.options.thought)
    });
  }

  const result = await runGrok(callOpts);
  out(renderResult(result, { showThought: Boolean(parsed.options.thought) }));
  if (!result.ok) {
    process.exitCode = 1;
  }
}

async function cmdReview(parsed, config) {
  const diffInfo = resolveDiff({
    scope: parsed.options.scope || "auto",
    base: parsed.options.base || null
  });

  // A bad/undetectable base ref is a hard input error — never silently report
  // "nothing to review" (which would hide the branch's work).
  if (diffInfo.error) {
    err(diffInfo.error);
    process.exitCode = 1;
    return;
  }

  const callOpts = {
    prompt: buildReviewPrompt(diffInfo),
    model: resolveModel({ explicit: parsed.options.model, kind: "default", config }),
    // A code review is focused on the diff; web search is off unless asked for.
    webSearch: Boolean(parsed.options.search),
    effort: parsed.options.effort,
    reasoningEffort: parsed.options["reasoning-effort"],
    maxTurns: parsed.options["max-turns"] ?? config.max_turns ?? undefined,
    timeoutMs: config.timeout_ms ?? undefined
  };

  // --print-args is a pure dry-run: report the intended grok invocation
  // regardless of whether the tree currently has changes.
  if (parsed.options["print-args"]) {
    out(JSON.stringify(buildGrokArgs(callOpts)));
    return;
  }

  if (!diffInfo.hasChanges) {
    out("Nothing to review.");
    return; // exit 0 — an empty diff is not an error
  }

  if (parsed.options.background) {
    return runBackground({
      kind: "review",
      callOpts,
      showThought: Boolean(parsed.options.thought)
    });
  }

  const result = await runGrok(callOpts);
  out(renderResult(result, { showThought: Boolean(parsed.options.thought) }));
  if (!result.ok) {
    process.exitCode = 1;
  }
}

function cmdStatus(parsed) {
  const id = parsed.positionals[0];
  if (id) {
    const job = readJob(id);
    if (!job) {
      out(`No such job: ${id}`);
      process.exitCode = 1;
      return;
    }
    out(renderJobDetail(job));
    return;
  }
  out(renderJobsTable(listJobs()));
}

function cmdResult(parsed) {
  const id = parsed.positionals[0];
  if (!id) {
    err("Usage: /grok:result <job-id>");
    process.exitCode = 1;
    return;
  }
  const job = readJob(id);
  if (!job) {
    out(`No such job: ${id}`);
    process.exitCode = 1;
    return;
  }
  if (job.status === "running" || job.status === "queued") {
    out(`Job ${id} is still ${job.status}. Check \`/grok:status ${id}\` and try again shortly.`);
    return;
  }
  const output = readOutput(id);
  out(output && output.trim() ? output : `Job ${id} finished (${job.status}) with no captured output.`);
}

function cmdCancel(parsed) {
  const id = parsed.positionals[0];
  if (!id) {
    err("Usage: /grok:cancel <job-id>");
    process.exitCode = 1;
    return;
  }
  const result = cancelJob(id);
  if (!result.ok) {
    out(result.error);
    process.exitCode = 1;
    return;
  }
  out(`Cancelled job ${id}. Run \`/grok:status\` to see the updated queue.`);
}

function cmdSetup(parsed, config) {
  const report = buildSetupReport(gatherSetupInputs(config, { offline: Boolean(parsed.options.offline) }));
  out(parsed.options.json ? JSON.stringify(report, null, 2) : renderSetupReport(report));
  // --offline is reserved for the hermetic eval/benchmark schema smoke. It
  // reports missing external tooling but must not fail a clean CI runner.
  if (!parsed.options.offline && (!report.cliOk || !report.modelsOk)) {
    process.exitCode = 1;
  }
}

const USAGE = `grok dispatcher — subcommands:
  ask <question>      Ask Grok one-shot (live web search on by default)
  review              Read-only review of the working tree or a branch diff
  status [job-id]     List background jobs, or show one job's detail
  result <job-id>     Print a finished job's captured output
  cancel <job-id>     Cancel a running background job
  setup [--json]      Diagnose CLI presence, auth, and resolved config`;

async function main() {
  const subcommand = process.argv[2];
  const parsed = validateInvocation(parseInvocation(process.argv.slice(3)), subcommand);
  const config = loadConfig();

  switch (subcommand) {
    case "ask":
      return cmdAsk(parsed, config);
    case "review":
      return cmdReview(parsed, config);
    case "status":
      return cmdStatus(parsed);
    case "result":
      return cmdResult(parsed);
    case "cancel":
      return cmdCancel(parsed);
    case "setup":
      return cmdSetup(parsed, config);
    default:
      err(subcommand ? `Unknown subcommand: ${subcommand}` : "No subcommand given.");
      err(USAGE);
      process.exitCode = 1;
      return undefined;
  }
}

let invokedDirectly = false;
if (process.argv[1]) {
  try {
    invokedDirectly =
      fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    invokedDirectly = false;
  }
}

if (invokedDirectly) {
  main().catch((error) => {
    err(`grok dispatcher error: ${error.message}`);
    process.exitCode = 1;
  });
}
