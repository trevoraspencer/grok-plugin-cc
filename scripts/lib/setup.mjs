// Setup doctor logic for /grok:setup.
//
// buildSetupReport is pure (inject grokVersion/hasAuth/config/nodeVersion) so it
// is fully unit-testable. gatherSetupInputs does the impure probing. The
// XAI_API_KEY value is NEVER read into the report — only its presence.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { grokVersion } from "./grok.mjs";

const NODE_FLOOR = 18;

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

export function gatherSetupInputs(config) {
  return {
    grokVersion: grokVersion(),
    hasAuth: detectAuth(),
    config,
    nodeVersion: process.version
  };
}

export function buildSetupReport({
  grokVersion = null,
  hasAuth = false,
  config = {},
  nodeVersion = process.version
} = {}) {
  const cliOk = Boolean(grokVersion);
  const major = Number.parseInt(String(nodeVersion).replace(/^v/, "").split(".")[0], 10);
  const nodeOk = Number.isFinite(major) ? major >= NODE_FLOOR : true;
  const authOk = Boolean(hasAuth);

  const checks = [
    {
      name: "grok CLI",
      status: cliOk ? "ok" : "fail",
      detail: cliOk ? grokVersion : "not found — install it or set GROK_BIN"
    },
    {
      name: "auth",
      status: authOk ? "ok" : "warn",
      detail: authOk
        ? "credentials present (XAI_API_KEY or ~/.grok/auth.json)"
        : "no credentials detected"
    },
    {
      name: "Node.js",
      status: nodeOk ? "ok" : "warn",
      detail: `${nodeVersion} (floor: v${NODE_FLOOR})`
    },
    {
      name: "models",
      status: "ok",
      detail: `default=${config.default_model}, search=${config.search_model}, fallback=${config.fallback_model}`
    },
    { name: "safety", status: "ok", detail: String(config.safety ?? "permissive") },
    { name: "web search default", status: "ok", detail: config.web_search === false ? "off" : "on" },
    { name: "automation", status: "ok", detail: "headless calls always pass --no-auto-update" }
  ];

  const nextSteps = [];
  if (!cliOk) {
    nextSteps.push("Install Grok Build: curl -fsSL https://x.ai/cli/install.sh | bash");
  }
  if (!authOk) {
    nextSteps.push(
      "Authenticate: set XAI_API_KEY, or sign in with SuperGrok / X Premium+ (grok stores auth at ~/.grok/auth.json)."
    );
  }
  if (!nodeOk) {
    nextSteps.push(`Upgrade Node.js to v${NODE_FLOOR}+ (current: ${nodeVersion}).`);
  }

  const ok = cliOk && authOk && nodeOk;
  return { ok, cliOk, verdict: ok ? "OK" : "issues found", checks, nextSteps };
}
