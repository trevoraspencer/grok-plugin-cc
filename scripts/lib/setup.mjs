// Setup doctor logic for /grok:setup.
//
// buildSetupReport is pure (inject grokVersion/hasAuth/config/nodeVersion) so it
// is fully unit-testable. gatherSetupInputs does the impure probing. The
// XAI_API_KEY value is NEVER read into the report — only its presence.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { configuredModelIssues, SUPPORTED_MODELS } from "./config.mjs";
import { grokModelStatus, grokVersion } from "./grok.mjs";

const NODE_FLOOR = 18;
const MIN_GROK_VERSION = [0, 2, 111];

function parseGrokVersion(value) {
  const match = String(value ?? "").match(/\b(\d+)\.(\d+)\.(\d+)\b/);
  return match ? match.slice(1).map(Number) : null;
}

function versionAtLeast(actual, minimum) {
  if (!actual) return false;
  for (let index = 0; index < minimum.length; index += 1) {
    if (actual[index] > minimum[index]) return true;
    if (actual[index] < minimum[index]) return false;
  }
  return true;
}

export function detectAuth() {
  if (process.env.XAI_API_KEY && process.env.XAI_API_KEY.trim()) {
    return true;
  }
  try {
    return fs.existsSync(path.join(os.homedir(), ".grok", "auth.json"));
  } catch {
    return false;
  }
}

export function gatherSetupInputs(config, { offline = false } = {}) {
  const modelStatus = offline ? null : grokModelStatus();
  return {
    // Offline mode is the hermetic CI/eval schema smoke: do not execute even
    // a locally installed or user-supplied GROK_BIN.
    grokVersion: offline ? null : grokVersion(),
    hasAuth: modelStatus?.ok ? modelStatus.authenticated : detectAuth(),
    modelStatus,
    config,
    nodeVersion: process.version
  };
}

export function buildSetupReport({
  grokVersion = null,
  hasAuth = false,
  modelStatus = null,
  config = {},
  nodeVersion = process.version
} = {}) {
  const cliOk = Boolean(grokVersion);
  const grokVersionOk = cliOk && versionAtLeast(parseGrokVersion(grokVersion), MIN_GROK_VERSION);
  const major = Number.parseInt(String(nodeVersion).replace(/^v/, "").split(".")[0], 10);
  const nodeOk = Number.isFinite(major) ? major >= NODE_FLOOR : true;
  const authOk = Boolean(hasAuth);
  const modelIssues = configuredModelIssues(config);
  const missingModels = modelStatus?.models?.length
    ? SUPPORTED_MODELS.filter((model) => !modelStatus.models.includes(model))
    : [];
  const modelsOk = modelIssues.length === 0 && missingModels.length === 0;

  const checks = [
    {
      name: "grok CLI",
      status: !cliOk ? "fail" : grokVersionOk ? "ok" : "warn",
      detail: !cliOk
        ? "not found — install it or set GROK_BIN"
        : `${grokVersion} (minimum tested: ${MIN_GROK_VERSION.join(".")})`
    },
    {
      name: "auth",
      status: authOk ? "ok" : "warn",
      detail: authOk
        ? modelStatus?.ok
          ? "authenticated (verified by grok models)"
          : "credentials present (live verification skipped or unavailable)"
        : "not authenticated (an auth file alone is not sufficient)"
    },
    {
      name: "Node.js",
      status: nodeOk ? "ok" : "warn",
      detail: `${nodeVersion} (floor: v${NODE_FLOOR})`
    },
    {
      name: "models",
      status: modelsOk ? "ok" : "fail",
      detail: modelsOk
        ? `supported=${SUPPORTED_MODELS.join(", ")}; default=${config.default_model}; search=${config.search_model}; fallback=${config.fallback_model}`
        : [
            modelIssues.length ? `unsupported config: ${modelIssues.join(", ")}` : null,
            missingModels.length ? `not in grok models: ${missingModels.join(", ")}` : null
          ]
            .filter(Boolean)
            .join("; ")
    },
    { name: "safety", status: "ok", detail: String(config.safety ?? "permissive") },
    { name: "web search default", status: "ok", detail: config.web_search === false ? "off" : "on" },
    {
      name: "automation",
      status: "ok",
      detail: "headless calls disable auto-update, subagents, memory, and workspace tools"
    }
  ];

  const nextSteps = [];
  if (!cliOk) {
    nextSteps.push("Install Grok Build: curl -fsSL https://x.ai/cli/install.sh | bash");
  }
  if (!authOk) {
    nextSteps.push("Authenticate: run `grok login` (or `grok login --device-auth`), or set XAI_API_KEY.");
  }
  if (cliOk && !grokVersionOk) {
    nextSteps.push(`Update Grok Build to ${MIN_GROK_VERSION.join(".")} or newer with \`grok update\`.`);
  }
  if (!modelsOk) {
    nextSteps.push(`Use only supported model IDs: ${SUPPORTED_MODELS.join(", ")}.`);
  }
  if (!nodeOk) {
    nextSteps.push(`Upgrade Node.js to v${NODE_FLOOR}+ (current: ${nodeVersion}).`);
  }

  const ok = cliOk && grokVersionOk && authOk && nodeOk && modelsOk;
  return { ok, cliOk, verdict: ok ? "OK" : "issues found", checks, nextSteps };
}
