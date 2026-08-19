#!/usr/bin/env node
// Zero-dependency stdio JSON-RPC 2.0 MCP server exposing read-only Grok calls.
// Messages are UTF-8 JSON objects delimited by newlines, per MCP stdio.

import fs from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";

import { MAX_GROK_PROMPT_ARG_BYTES, redactGrokSecrets, runGrok } from "./lib/grok.mjs";
import { loadConfig, resolveModel, SUPPORTED_MODELS } from "./lib/config.mjs";
import { renderResult } from "./lib/render.mjs";

const SERVER_INFO = { name: "grok", version: "0.2.0" };
const DEFAULT_PROTOCOL = "2025-11-25";
const SUPPORTED_PROTOCOLS = new Set(["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"]);
const MAX_PROMPT_CHARS = MAX_GROK_PROMPT_ARG_BYTES;
const MAX_LINE_BYTES = 1024 * 1024;
const MAX_IN_FLIGHT = 8;
const MAX_ERROR_CHARS = 1000;
const decoder = new TextDecoder("utf-8", { fatal: true });

export const TOOLS = [
  {
    name: "grok_search",
    description:
      "Search the live web/X with Grok and return a synthesized answer with inline citations. Use this when you need current, real-time information that may be newer than your training data. Each call spends against the user's xAI quota, can run up to 15 minutes, and does not ask for confirmation.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          minLength: 1,
          maxLength: MAX_PROMPT_CHARS,
          description: "The question or topic to research with live web search."
        },
        model: {
          type: "string",
          enum: SUPPORTED_MODELS,
          description: "Optional supported Grok model ID to override the default search model."
        }
      },
      required: ["query"],
      additionalProperties: false
    }
  },
  {
    name: "grok_ask",
    description:
      "Ask Grok a one-shot question. Live web search follows the plugin's web_search setting unless the call overrides it with search=true or search=false. Each call spends against the user's xAI quota, can run up to 15 minutes, and does not ask for confirmation.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          minLength: 1,
          maxLength: MAX_PROMPT_CHARS,
          description: "The question or instruction for Grok."
        },
        model: {
          type: "string",
          enum: SUPPORTED_MODELS,
          description: "Optional supported Grok model ID to override the configured search model."
        },
        search: {
          type: "boolean",
          description: "Optional live-search override for this call. Omit it to use the configured web_search default."
        }
      },
      required: ["prompt"],
      additionalProperties: false
    }
  }
];

function plainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(object, allowed) {
  return Object.keys(object).every((key) => allowed.has(key));
}

function validRequestId(id) {
  return (
    id === null ||
    (Number.isSafeInteger(id) && Number.isFinite(id)) ||
    (typeof id === "string" && id.length <= 256 && !/[\u0000-\u001f\u007f]/.test(id))
  );
}

function boundedMessage(message) {
  return redactGrokSecrets(message ?? "Unknown error")
    .replace(/\0/g, "\uFFFD")
    .slice(0, MAX_ERROR_CHARS);
}

function jsonrpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function jsonrpcError(id, code, message) {
  return { jsonrpc: "2.0", id: validRequestId(id) ? id : null, error: { code, message: boundedMessage(message) } };
}

function negotiateProtocol(requested) {
  return typeof requested === "string" && SUPPORTED_PROTOCOLS.has(requested)
    ? requested
    : DEFAULT_PROTOCOL;
}

function toolResult(id, grokResult) {
  return jsonrpcResult(id, {
    content: [{ type: "text", text: renderResult(grokResult).trimEnd() }],
    isError: grokResult.ok !== true
  });
}

function toolExecutionError(id, message) {
  return jsonrpcResult(id, {
    content: [{ type: "text", text: boundedMessage(message) }],
    isError: true
  });
}

function validateToolParams(params) {
  if (!plainObject(params) || !hasOnlyKeys(params, new Set(["name", "arguments"]))) {
    return "tools/call params must contain only `name` and `arguments`.";
  }
  if (typeof params.name !== "string" || params.name.length === 0 || params.name.length > 128) {
    return "tools/call requires a bounded `name` string.";
  }
  if (!plainObject(params.arguments)) {
    return "tools/call requires `arguments` to be an object.";
  }
  return null;
}

function validatePrompt(value, name) {
  if (typeof value !== "string") {
    return `${name} must be a string.`;
  }
  if (!value.trim()) {
    return `${name} must not be empty.`;
  }
  if (value.includes("\0")) {
    return `${name} must not contain NUL characters.`;
  }
  if (value.length > MAX_PROMPT_CHARS) {
    return `${name} exceeds the ${MAX_PROMPT_CHARS}-character limit.`;
  }
  if (Buffer.byteLength(value, "utf8") > MAX_GROK_PROMPT_ARG_BYTES) {
    return `${name} exceeds the ${MAX_GROK_PROMPT_ARG_BYTES}-byte UTF-8 limit.`;
  }
  return null;
}

async function handleToolCall(id, params, { run, config }) {
  const paramError = validateToolParams(params);
  if (paramError) {
    return jsonrpcError(id, -32602, paramError);
  }
  const { name, arguments: args } = params;

  if (name === "grok_search") {
    if (!hasOnlyKeys(args, new Set(["query", "model"]))) {
      return toolExecutionError(id, "grok_search received an unknown argument.");
    }
    const promptError = validatePrompt(args.query, "grok_search `query`");
    if (promptError) {
      return toolExecutionError(id, promptError);
    }
    if (args.model !== undefined && typeof args.model !== "string") {
      return toolExecutionError(id, "grok_search `model` must be a string.");
    }
    let model;
    try {
      model = resolveModel({ explicit: args.model, kind: "search", config });
    } catch (error) {
      return toolExecutionError(id, error.message);
    }
    try {
      const result = await run({
        prompt: args.query.trim(),
        model,
        webSearch: true,
        maxTurns: config.max_turns ?? undefined,
        timeoutMs: config.timeout_ms ?? undefined
      });
      return toolResult(id, result);
    } catch (error) {
      return toolExecutionError(id, `Grok invocation failed: ${error.message}`);
    }
  }

  if (name === "grok_ask") {
    if (!hasOnlyKeys(args, new Set(["prompt", "model", "search"]))) {
      return toolExecutionError(id, "grok_ask received an unknown argument.");
    }
    const promptError = validatePrompt(args.prompt, "grok_ask `prompt`");
    if (promptError) {
      return toolExecutionError(id, promptError);
    }
    if (args.model !== undefined && typeof args.model !== "string") {
      return toolExecutionError(id, "grok_ask `model` must be a string.");
    }
    if (args.search !== undefined && typeof args.search !== "boolean") {
      return toolExecutionError(id, "grok_ask `search` must be a boolean.");
    }
    let model;
    try {
      model = resolveModel({ explicit: args.model, kind: "search", config });
    } catch (error) {
      return toolExecutionError(id, error.message);
    }
    try {
      const result = await run({
        prompt: args.prompt.trim(),
        model,
        webSearch: args.search === undefined ? config.web_search !== false : args.search,
        maxTurns: config.max_turns ?? undefined,
        timeoutMs: config.timeout_ms ?? undefined
      });
      return toolResult(id, result);
    } catch (error) {
      return toolExecutionError(id, `Grok invocation failed: ${error.message}`);
    }
  }

  return jsonrpcError(id, -32602, `Unknown tool: ${name}`);
}

// Pure message handler with injectable runner/config for hermetic tests.
export async function handleMessage(message, { run = runGrok, config = loadConfig() } = {}) {
  if (
    !plainObject(message) ||
    !hasOnlyKeys(message, new Set(["jsonrpc", "id", "method", "params"])) ||
    message.jsonrpc !== "2.0" ||
    typeof message.method !== "string" ||
    message.method.length === 0 ||
    message.method.length > 128
  ) {
    const id = plainObject(message) && Object.hasOwn(message, "id") ? message.id : null;
    return jsonrpcError(id, -32600, "Invalid Request: expected a JSON-RPC 2.0 request object.");
  }

  const hasId = Object.hasOwn(message, "id");
  if (hasId && !validRequestId(message.id)) {
    return jsonrpcError(null, -32600, "Invalid Request: unsupported JSON-RPC id.");
  }

  // Notifications never receive a response and, critically, never start an
  // expensive Grok call. Only the initialized notification has local meaning.
  if (!hasId) {
    return null;
  }

  const { method, id, params } = message;
  if (params !== undefined && !plainObject(params)) {
    return jsonrpcError(id, -32602, "Invalid params: expected an object.");
  }

  switch (method) {
    case "initialize":
      if (
        params !== undefined &&
        !hasOnlyKeys(params, new Set(["protocolVersion", "capabilities", "clientInfo"]))
      ) {
        return jsonrpcError(id, -32602, "Invalid initialize params.");
      }
      return jsonrpcResult(id, {
        protocolVersion: negotiateProtocol(params?.protocolVersion),
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO
      });
    case "ping":
      return jsonrpcResult(id, {});
    case "tools/list":
      return jsonrpcResult(id, { tools: TOOLS });
    case "tools/call":
      return handleToolCall(id, params, { run, config });
    default:
      return jsonrpcError(id, -32601, `Method not found: ${method}`);
  }
}

function send(object) {
  return process.stdout.write(`${JSON.stringify(object)}\n`);
}

export function startServer({ input = process.stdin } = {}) {
  const config = loadConfig();
  let line = Buffer.alloc(0);
  let discardingOversize = false;
  let pending = 0;
  let inputClosed = false;
  let outputClosed = false;
  let pausedForOutput = false;

  const writeResponse = (object) => {
    if (send(object) || pausedForOutput || inputClosed) {
      return;
    }
    pausedForOutput = true;
    input.pause();
    process.stdout.once("drain", () => {
      pausedForOutput = false;
      if (!inputClosed) {
        input.resume();
      }
    });
  };

  const maybeClose = () => {
    if (inputClosed && pending === 0 && !outputClosed) {
      outputClosed = true;
      process.stdout.end();
    }
  };

  const dispatch = (bytes) => {
    if (bytes.length === 0) {
      return;
    }
    let text;
    try {
      text = decoder.decode(bytes).trim();
    } catch {
      writeResponse(jsonrpcError(null, -32700, "Parse error: input must be valid UTF-8 JSON."));
      return;
    }
    if (!text) {
      return;
    }
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      writeResponse(jsonrpcError(null, -32700, "Parse error: invalid JSON."));
      return;
    }

    const isNotification = plainObject(message) && !Object.hasOwn(message, "id");
    if (isNotification) {
      return;
    }
    if (pending >= MAX_IN_FLIGHT) {
      writeResponse(
        jsonrpcError(
          plainObject(message) && Object.hasOwn(message, "id") ? message.id : null,
          -32000,
          `Server busy: at most ${MAX_IN_FLIGHT} requests may run concurrently.`
        )
      );
      return;
    }

    pending += 1;
    handleMessage(message, { config })
      .then((response) => {
        if (response !== null && response !== undefined) {
          writeResponse(response);
        }
      })
      .catch((error) => {
        const id = plainObject(message) && Object.hasOwn(message, "id") ? message.id : null;
        writeResponse(jsonrpcError(id, -32603, `Internal error: ${error.message}`));
      })
      .finally(() => {
        pending -= 1;
        maybeClose();
      });
  };

  const append = (segment) => {
    if (discardingOversize || segment.length === 0) {
      return;
    }
    if (line.length + segment.length > MAX_LINE_BYTES) {
      line = Buffer.alloc(0);
      discardingOversize = true;
      writeResponse(
        jsonrpcError(null, -32700, `Parse error: message exceeds ${MAX_LINE_BYTES} bytes.`)
      );
      return;
    }
    line = line.length === 0 ? Buffer.from(segment) : Buffer.concat([line, segment]);
  };

  input.on("data", (chunk) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let start = 0;
    for (let index = 0; index < bytes.length; index += 1) {
      if (bytes[index] !== 0x0a) {
        continue;
      }
      append(bytes.subarray(start, index));
      if (discardingOversize) {
        discardingOversize = false;
        line = Buffer.alloc(0);
      } else {
        dispatch(line);
        line = Buffer.alloc(0);
      }
      start = index + 1;
    }
    append(bytes.subarray(start));
  });

  input.on("end", () => {
    if (discardingOversize) {
      discardingOversize = false;
    } else {
      dispatch(line);
    }
    line = Buffer.alloc(0);
    inputClosed = true;
    maybeClose();
  });
  input.resume();
}

function invokedDirectly() {
  if (!process.argv[1]) {
    return false;
  }
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  startServer();
}
