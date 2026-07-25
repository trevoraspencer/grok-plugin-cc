// Plugin configuration loader and model resolution.
//
// Precedence for config values: repo override (./.grok/grok-plugin.json) >
// shipped defaults (config/defaults.json) > hard-coded safety net.
// Precedence for the model slug: explicit -m/--model > the kind's configured
// slug (default_model / search_model) > fallback_model > grok-4.5.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PLUGIN_ROOT = path.resolve(HERE, "..", "..");
export const DEFAULTS_PATH = path.join(PLUGIN_ROOT, "config", "defaults.json");

// Hard-coded safety net so the tools still run if config/defaults.json is
// missing or corrupt (drift mitigation — see ROADMAP risk #2).
export const SUPPORTED_MODELS = Object.freeze(["grok-4.5", "grok-composer-2.5-fast"]);
const SUPPORTED_MODEL_SET = new Set(SUPPORTED_MODELS);

const HARD_DEFAULTS = Object.freeze({
  default_model: "grok-4.5",
  search_model: "grok-4.5",
  fallback_model: "grok-composer-2.5-fast",
  safety: "permissive",
  web_search: true,
  max_turns: null
});

const MODEL_KEYS = ["default_model", "search_model", "fallback_model"];
const SAFETY_MODES = new Set(["permissive", "preview"]);

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export function loadConfig({ cwd = process.cwd() } = {}) {
  const shipped = readJsonSafe(DEFAULTS_PATH);
  const base = normalizeConfig(shipped, HARD_DEFAULTS);

  const overridePath = path.join(cwd, ".grok", "grok-plugin.json");
  const override = readJsonSafe(overridePath);
  if (override && typeof override === "object" && !Array.isArray(override)) {
    return normalizeConfig(override, base);
  }
  return base;
}

export function normalizeConfig(config, fallback = HARD_DEFAULTS) {
  const normalized = { ...fallback };
  const source = config && typeof config === "object" && !Array.isArray(config) ? config : {};

  for (const key of MODEL_KEYS) {
    if (typeof source[key] === "string" && source[key].trim()) {
      normalized[key] = source[key].trim();
    }
  }

  if (SAFETY_MODES.has(source.safety)) {
    normalized.safety = source.safety;
  }

  if (typeof source.web_search === "boolean") {
    normalized.web_search = source.web_search;
  }

  if (source.max_turns === null) {
    normalized.max_turns = null;
  } else if (Number.isInteger(source.max_turns) && source.max_turns > 0) {
    normalized.max_turns = source.max_turns;
  }

  return normalized;
}

export function resolveModel({ explicit, kind = "default", config = {} } = {}) {
  if (explicit && String(explicit).trim()) {
    return requireSupportedModel(String(explicit).trim());
  }
  const key = kind === "search" ? "search_model" : "default_model";
  const chosen = config[key];
  if (chosen && String(chosen).trim()) {
    return requireSupportedModel(String(chosen).trim(), key);
  }
  const fallback = config.fallback_model;
  if (fallback && String(fallback).trim()) {
    return requireSupportedModel(String(fallback).trim(), "fallback_model");
  }
  return HARD_DEFAULTS.default_model;
}

export function isSupportedModel(model) {
  return typeof model === "string" && SUPPORTED_MODEL_SET.has(model.trim());
}

export function requireSupportedModel(model, source = "model") {
  const normalized = String(model ?? "").trim();
  if (SUPPORTED_MODEL_SET.has(normalized)) {
    return normalized;
  }
  throw new Error(
    `Unsupported ${source} \"${normalized || "(empty)"}\". Supported models: ${SUPPORTED_MODELS.join(", ")}. ` +
      "Legacy model IDs such as grok-build are deprecated by this plugin."
  );
}

export function configuredModelIssues(config = {}) {
  return MODEL_KEYS.flatMap((key) => {
    const value = config[key];
    return value && !isSupportedModel(value) ? [`${key}=${String(value).trim()}`] : [];
  });
}
