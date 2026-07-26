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
  max_turns: null,
  timeout_ms: 900_000
});

const MODEL_KEYS = ["default_model", "search_model", "fallback_model"];
const SAFETY_MODES = new Set(["permissive", "preview"]);
const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_TURNS = 4_294_967_295;

function readJsonSafe(file) {
  let descriptor;
  try {
    const stat = fs.lstatSync(file, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > BigInt(MAX_CONFIG_BYTES)) {
      return null;
    }
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || opened.size > BigInt(MAX_CONFIG_BYTES)) {
      return null;
    }
    const buffer = Buffer.alloc(Number(opened.size) + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const bytesRead = fs.readSync(descriptor, buffer, offset, buffer.length - offset, null);
      if (bytesRead === 0) {
        break;
      }
      offset += bytesRead;
    }
    if (offset > MAX_CONFIG_BYTES) {
      return null;
    }
    return JSON.parse(buffer.subarray(0, offset).toString("utf8"));
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // A config read is best-effort; ignore close errors.
      }
    }
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
    if (
      typeof source[key] === "string" &&
      source[key].trim() &&
      source[key].length <= 256 &&
      !source[key].includes("\0")
    ) {
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
  } else if (
    Number.isInteger(source.max_turns) &&
    source.max_turns > 0 &&
    source.max_turns <= MAX_TURNS
  ) {
    normalized.max_turns = source.max_turns;
  }

  if (Number.isInteger(source.timeout_ms) && source.timeout_ms > 0 && source.timeout_ms <= MAX_TIMEOUT_MS) {
    normalized.timeout_ms = source.timeout_ms;
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
  const displayed = normalized
    ? JSON.stringify(normalized.slice(0, 256)) + (normalized.length > 256 ? "…" : "")
    : '"(empty)"';
  throw new Error(
    `Unsupported ${source} ${displayed}. Supported models: ${SUPPORTED_MODELS.join(", ")}. ` +
      "Legacy model IDs such as grok-build are deprecated by this plugin."
  );
}

export function configuredModelIssues(config = {}) {
  return MODEL_KEYS.flatMap((key) => {
    const value = config[key];
    return value && !isSupportedModel(value)
      ? [`${key}=${String(value).trim().slice(0, 256)}`]
      : [];
  });
}
