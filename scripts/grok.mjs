#!/usr/bin/env node
// Companion dispatcher for the grok plugin. Invoked as:
//   node scripts/grok.mjs <subcommand> "$ARGUMENTS"
// where "$ARGUMENTS" is the raw slash-command argument string (one shell token).
//
// Subcommands: ask, review, status, result, cancel, setup. All grok invocation
// goes through lib/grok.mjs.

import process from "node:process";
import { pathToFileURL } from "node:url";

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
  const job = createJob({ kind });
  out(`Started background ${kind} job: ${job.id}`);
  out(`Check progress with: /grok:status ${job.id}`);
  markRunning(job.id, process.pid);
  try {
    // Record each spawned grok child's pid so /grok:cancel can terminate the
    // real work process too, not just this wrapper (which would orphan it).
    const result = await runGrok({
      ...callOpts,
      onSpawn: (child) => recordChildPid(job.id, child.pid)
    });
    writeOutput(job.id, renderResult(result, { showThought }));
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
  if (!parsed.options.offline && !report.cliOk) {
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
  const parsed = parseInvocation(process.argv.slice(3));
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

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((error) => {
    err(`grok dispatcher error: ${error.message}`);
    process.exitCode = 1;
  });
}
