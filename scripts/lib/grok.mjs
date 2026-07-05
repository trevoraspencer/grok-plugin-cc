// The single choke-point for invoking the `grok` CLI. No other file in this
// plugin shells out to grok — keeping all CLI invocation here makes the plugin
// resilient to grok flag/output drift (ROADMAP risk #2).
//
// Verified headless JSON shape (grok 0.2.x): { text, stopReason, sessionId,
// requestId, thought }. Web search is ON by default under `-p`; pass
// webSearch:false to add --disable-web-search.

import { spawn, spawnSync } from "node:child_process";
import process from "node:process";

export function grokBinary() {
  return process.env.GROK_BIN || "grok";
}

// Probe the installed grok version (honors GROK_BIN). Returns the version
// string, or null if grok is missing / errors. This is the only other place
// besides runGrok that touches the grok binary — kept here so all grok
// invocation lives behind this one module.
export function grokVersion() {
  const result = spawnSync(grokBinary(), ["--version"], { encoding: "utf8", windowsHide: true });
  if (result.error || (result.status ?? 1) !== 0) {
    return null;
  }
  return (result.stdout || result.stderr || "").trim() || null;
}

export function buildGrokArgs({
  prompt,
  model,
  outputFormat = "json",
  webSearch,
  effort,
  reasoningEffort,
  maxTurns,
  extra = []
} = {}) {
  const args = ["-p", String(prompt ?? "")];
  args.push("--output-format", outputFormat);
  if (model) {
    args.push("-m", String(model));
  }
  args.push("--no-auto-update");
  if (webSearch === false) {
    args.push("--disable-web-search");
  }
  if (effort !== undefined && effort !== null && effort !== "") {
    args.push("--effort", String(effort));
  }
  if (reasoningEffort !== undefined && reasoningEffort !== null && reasoningEffort !== "") {
    args.push("--reasoning-effort", String(reasoningEffort));
  }
  if (maxTurns !== undefined && maxTurns !== null && maxTurns !== "") {
    args.push("--max-turns", String(maxTurns));
  }
  if (Array.isArray(extra) && extra.length) {
    args.push(...extra);
  }
  return args;
}

// Defensive JSON parse: tolerate leading/trailing noise on stdout by extracting
// the outermost {...} object if a straight parse fails.
export function parseGrokJson(stdout) {
  const trimmed = String(stdout ?? "").trim();
  if (!trimmed) {
    return { parsed: null, error: "empty stdout" };
  }
  try {
    return { parsed: JSON.parse(trimmed), error: null };
  } catch (firstError) {
    const first = trimmed.indexOf("{");
    const last = trimmed.lastIndexOf("}");
    if (first !== -1 && last > first) {
      try {
        return { parsed: JSON.parse(trimmed.slice(first, last + 1)), error: null };
      } catch (secondError) {
        return { parsed: null, error: secondError.message };
      }
    }
    return { parsed: null, error: firstError.message };
  }
}

function failure(partial) {
  return {
    ok: false,
    text: "",
    thought: "",
    stopReason: null,
    sessionId: null,
    requestId: null,
    raw: null,
    stderr: "",
    code: null,
    error: "Unknown grok error.",
    transient: false,
    ...partial
  };
}

const MISSING_CLI_HINT =
  'Install it with: curl -fsSL https://x.ai/cli/install.sh | bash, or set GROK_BIN to the grok path.';

const TRANSIENT_STDERR = /Auth\(|Authorization|Transport channel closed|temporarily|rate.?limit/i;

// Turn a finished grok invocation (stdout/stderr/exit code) into a result
// object. Pure + testable. Critically: grok exits 0 even when its web-search
// worker fails — the answer comes back empty with stopReason "Cancelled". We
// treat any empty answer as a failure, and flag the transient signature so the
// caller can retry once.
export function classifyGrokOutput({ stdout = "", stderr = "", code = 0 } = {}) {
  if (code !== 0) {
    const detail = stderr.trim() || stdout.trim() || `grok exited with code ${code}`;
    return failure({ raw: stdout, stderr, code, error: detail, transient: TRANSIENT_STDERR.test(stderr) });
  }

  const { parsed, error: parseError } = parseGrokJson(stdout);
  if (!parsed || typeof parsed !== "object") {
    return failure({
      text: stdout.trim(),
      raw: stdout,
      stderr,
      code,
      error: `Could not parse grok JSON output: ${parseError}`
    });
  }

  const text =
    typeof parsed.text === "string" ? parsed.text : parsed.text != null ? String(parsed.text) : "";
  const thought = typeof parsed.thought === "string" ? parsed.thought : "";
  const stopReason = parsed.stopReason ?? null;
  const sessionId = parsed.sessionId ?? null;
  const requestId = parsed.requestId ?? null;

  if (!text.trim()) {
    const transient = /cancel/i.test(String(stopReason)) || TRANSIENT_STDERR.test(stderr);
    return failure({
      thought,
      stopReason,
      sessionId,
      requestId,
      raw: parsed,
      stderr,
      code,
      transient,
      error:
        `Grok returned no answer (stopReason: ${stopReason}).` +
        (transient
          ? " This looks like a transient web-search worker hiccup — please retry, or use --no-search for a model-only answer."
          : "")
    });
  }

  return {
    ok: true,
    text,
    thought,
    stopReason,
    sessionId,
    requestId,
    raw: parsed,
    stderr,
    code,
    error: null,
    transient: false
  };
}

function spawnGrok(opts) {
  const args = buildGrokArgs(opts);
  const bin = grokBinary();

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, { env: process.env, windowsHide: true });
    } catch (error) {
      resolve(failure({ error: `Failed to launch grok ("${bin}"): ${error.message}` }));
      return;
    }

    // Let the caller observe the spawned child (e.g. to record its pid so
    // /grok:cancel can terminate the real work process, not just the
    // dispatcher wrapper). Observer errors must never break the call.
    if (typeof opts.onSpawn === "function") {
      try {
        opts.onSpawn(child);
      } catch {
        // ignore
      }
    }

    let stdout = "";
    let stderr = "";
    let settled = false;

    const settle = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    child.on("error", (error) => {
      if (error && error.code === "ENOENT") {
        settle(failure({ error: `grok CLI not found (tried "${bin}"). ${MISSING_CLI_HINT}` }));
        return;
      }
      settle(failure({ error: error ? error.message : "spawn error", stderr }));
    });

    child.on("close", (code) => settle(classifyGrokOutput({ stdout, stderr, code: code ?? 0 })));
  });
}

// Run grok, retrying exactly once on the transient web-search failure signature.
// `retries` is bounded (default 1) — this never loops indefinitely.
// Pass `onSpawn(child)` to observe each spawned child process (re-invoked on retry).
export async function runGrok(opts = {}) {
  const retries = Number.isInteger(opts.retries) ? opts.retries : 1;
  let result = await spawnGrok(opts);
  let attempts = 1;
  while (!result.ok && result.transient && attempts <= retries) {
    result = await spawnGrok(opts);
    attempts += 1;
  }
  return { ...result, attempts };
}
