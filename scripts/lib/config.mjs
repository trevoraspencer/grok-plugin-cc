// Plugin configuration loader and model resolution.
//
// Precedence for config values: repo override (./.grok/grok-plugin.json) >
// shipped defaults (config/defaults.json) > hard-coded safety net.
// Precedence for the model slug: explicit -m/--model > the kind's configured
// slug (default_model / search_model) > fallback_model > "grok-build".

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PLUGIN_ROOT = path.resolve(HERE, "..", "..");
export const DEFAULTS_PATH = path.join(PLUGIN_ROOT, "config", "defaults.json");

// Hard-coded safety net so the tools still run if config/defaults.json is
// missing or corrupt (drift mitigation — see ROADMAP risk #2).
const HARD_DEFAULTS = Object.freeze({
  default_model: "grok-composer-2.5-fast",
  search_model: "grok-build",
  fallback_model: "grok-build",
  safety: "permissive",
  web_search: true,
  max_turns: null
});

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export function loadConfig({ cwd = process.cwd() } = {}) {
  const shipped = readJsonSafe(DEFAULTS_PATH);
  const base = { ...HARD_DEFAULTS, ...(shipped && typeof shipped === "object" ? shipped : {}) };

  const overridePath = path.join(cwd, ".grok", "grok-plugin.json");
  const override = readJsonSafe(overridePath);
  if (override && typeof override === "object" && !Array.isArray(override)) {
    return { ...base, ...override };
  }
  return base;
}

export function resolveModel({ explicit, kind = "default", config = {} } = {}) {
  if (explicit && String(explicit).trim()) {
    return String(explicit).trim();
  }
  const key = kind === "search" ? "search_model" : "default_model";
  const chosen = config[key];
  if (chosen && String(chosen).trim()) {
    return String(chosen).trim();
  }
  const fallback = config.fallback_model;
  if (fallback && String(fallback).trim()) {
    return String(fallback).trim();
  }
  return "grok-build";
}
