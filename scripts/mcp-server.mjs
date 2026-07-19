#!/usr/bin/env node
// Zero-dependency stdio JSON-RPC 2.0 MCP server exposing Grok to Claude.
//
// Tools: grok_search (live web/X search) and grok_ask (one-shot question).
// Transport: newline-delimited JSON-RPC 2.0 on stdin/stdout (one object per
// line). stdout is the protocol channel — only JSON is ever written there;
// diagnostics, if any, go to stderr. No external packages (only node:* + lib/*).
//
// MCP spec confirmed via Context7 (modelcontextprotocol, 2025-11-25):
//   initialize  -> { protocolVersion, capabilities.tools, serverInfo }
//   tools/list  -> { tools: [{ name, description, inputSchema }] }
//   tools/call  -> { content: [{ type:"text", text }], isError? }
//   protocol errors -> { error: { code, message } }

import process from "node:process";
import readline from "node:readline";
import { pathToFileURL } from "node:url";

import { runGrok } from "./lib/grok.mjs";
import { loadConfig, resolveModel, SUPPORTED_MODELS } from "./lib/config.mjs";
import { renderResult } from "./lib/render.mjs";

const SERVER_INFO = { name: "grok", version: "0.2.0" };
const DEFAULT_PROTOCOL = "2025-06-18";
const SUPPORTED_PROTOCOLS = new Set(["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"]);

export const TOOLS = [
  {
    name: "grok_search",
    description:
      "Search the live web/X with Grok and return a synthesized answer with inline citations. Use this when you need current, real-time information that may be newer than your training data.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The question or topic to research with live web search." },
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
      "Ask Grok a one-shot question. Live web search follows the plugin's web_search setting unless the call overrides it with search=true or search=false.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "The question or instruction for Grok." },
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

function jsonrpcResult(id, result) {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

function jsonrpcError(id, code, message) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function negotiateProtocol(requested) {
  if (typeof requested === "string" && SUPPORTED_PROTOCOLS.has(requested)) {
    return requested;
  }
  return DEFAULT_PROTOCOL;
}

function toolResult(id, grokResult) {
  return jsonrpcResult(id, {
    content: [{ type: "text", text: renderResult(grokResult).trimEnd() }],
    isError: grokResult.ok !== true
  });
}

function toolExecutionError(id, message) {
  return jsonrpcResult(id, { content: [{ type: "text", text: message }], isError: true });
}

async function handleToolCall(id, params, { run, config }) {
  const name = params?.name;
  const args = (params && params.arguments) || {};

  if (name === "grok_search") {
    const query = typeof args.query === "string" ? args.query.trim() : "";
    if (!query) {
      return toolExecutionError(id, "grok_search requires a non-empty `query` string.");
    }
    let model;
    try {
      model = resolveModel({ explicit: args.model, kind: "search", config });
    } catch (error) {
      return toolExecutionError(id, error.message);
    }
    const result = await run({
      prompt: query,
      model,
      webSearch: true,
      maxTurns: config.max_turns ?? undefined,
      timeoutMs: config.timeout_ms ?? undefined
    });
    return toolResult(id, result);
  }

  if (name === "grok_ask") {
    const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
    if (!prompt) {
      return toolExecutionError(id, "grok_ask requires a non-empty `prompt` string.");
    }
    let model;
    try {
      model = resolveModel({ explicit: args.model, kind: "search", config });
    } catch (error) {
      return toolExecutionError(id, error.message);
    }
    const result = await run({
      prompt,
      model,
      // explicit `search` arg wins; otherwise honor the configured web_search default
      webSearch: args.search === false ? false : args.search === true ? true : config.web_search !== false,
      maxTurns: config.max_turns ?? undefined,
      timeoutMs: config.timeout_ms ?? undefined
    });
    return toolResult(id, result);
  }

  return jsonrpcError(id, -32602, `Unknown tool: ${name ?? "(none)"}`);
}

// Pure-ish message handler: takes a parsed JSON-RPC message, returns the
// response object (or null for notifications). `run`/`config` are injectable
// so tests can exercise tools/call without invoking the live grok CLI.
export async function handleMessage(message, { run = runGrok, config = loadConfig() } = {}) {
  if (!message || typeof message !== "object" || Array.isArray(message) || message.jsonrpc !== "2.0") {
    const id = message && typeof message === "object" && "id" in message ? message.id : null;
    return jsonrpcError(id, -32600, "Invalid Request: expected a JSON-RPC 2.0 object.");
  }

  const { method, id, params } = message;
  const isNotification = id === undefined;

  switch (method) {
    case "initialize":
      return jsonrpcResult(id, {
        protocolVersion: negotiateProtocol(params?.protocolVersion),
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO
      });
    case "notifications/initialized":
    case "initialized":
      return null;
    case "ping":
      return jsonrpcResult(id, {});
    case "tools/list":
      return jsonrpcResult(id, { tools: TOOLS });
    case "tools/call":
      return handleToolCall(id, params, { run, config });
    default:
      if (isNotification) {
        return null;
      }
      return jsonrpcError(id, -32601, `Method not found: ${method}`);
  }
}

function send(object) {
  process.stdout.write(`${JSON.stringify(object)}\n`);
}

function startServer() {
  const config = loadConfig();
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

  // Graceful shutdown: only exit once stdin is closed AND no request is still
  // in flight, so a tools/call awaiting grok is never cut off mid-response.
  let pending = 0;
  let inputClosed = false;
  const maybeExit = () => {
    if (inputClosed && pending === 0) {
      process.exit(0);
    }
  };

  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      send(jsonrpcError(null, -32700, "Parse error: invalid JSON."));
      return;
    }
    pending += 1;
    handleMessage(message, { config })
      .then((response) => {
        if (response !== null && response !== undefined) {
          send(response);
        }
      })
      .catch((error) => {
        const id = message && typeof message === "object" && "id" in message ? message.id : null;
        send(jsonrpcError(id, -32603, `Internal error: ${error.message}`));
      })
      .finally(() => {
        pending -= 1;
        maybeExit();
      });
  });

  rl.on("close", () => {
    inputClosed = true;
    maybeExit();
  });
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  startServer();
}
