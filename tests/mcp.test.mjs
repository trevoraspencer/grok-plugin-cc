import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { handleMessage, TOOLS } from "../scripts/mcp-server.mjs";

const FAKE_CONFIG = {
  default_model: "grok-4.5",
  search_model: "grok-4.5",
  fallback_model: "grok-composer-2.5-fast"
};

test("mcp: initialize returns serverInfo.name=grok, tools capability, echoed protocol", async () => {
  const res = await handleMessage({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18" }
  });
  assert.equal(res.result.serverInfo.name, "grok");
  assert.equal(res.result.serverInfo.version, "0.2.0");
  assert.ok(res.result.capabilities.tools);
  assert.equal(res.result.protocolVersion, "2025-06-18");
});

test("mcp: initialize falls back to a supported protocol for an unknown version", async () => {
  const res = await handleMessage({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "1999-01-01" }
  });
  assert.equal(typeof res.result.protocolVersion, "string");
  assert.notEqual(res.result.protocolVersion, "1999-01-01");
});

test("mcp: tools/list returns exactly grok_search and grok_ask with required fields", async () => {
  const res = await handleMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const names = res.result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["grok_ask", "grok_search"]);
  const search = res.result.tools.find((t) => t.name === "grok_search");
  const ask = res.result.tools.find((t) => t.name === "grok_ask");
  assert.deepEqual(search.inputSchema.required, ["query"]);
  assert.deepEqual(ask.inputSchema.required, ["prompt"]);
  assert.deepEqual(search.inputSchema.properties.model.enum, ["grok-4.5", "grok-composer-2.5-fast"]);
  assert.deepEqual(ask.inputSchema.properties.model.enum, ["grok-4.5", "grok-composer-2.5-fast"]);
  // exported TOOLS matches the wire response
  assert.equal(TOOLS.length, 2);
});

test("mcp: tool schemas are strict about declared input properties", async () => {
  const res = await handleMessage({ jsonrpc: "2.0", id: 20, method: "tools/list" });
  for (const tool of res.result.tools) {
    assert.equal(tool.inputSchema.type, "object");
    assert.equal(tool.inputSchema.additionalProperties, false, `${tool.name} should reject unknown fields`);
  }
});

test("mcp: notifications/initialized produces no response", async () => {
  const res = await handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" });
  assert.equal(res, null);
});

test("mcp: unknown method with an id yields -32601", async () => {
  const res = await handleMessage({ jsonrpc: "2.0", id: 9, method: "does/notexist" });
  assert.equal(res.error.code, -32601);
});

test("mcp: a non-JSON-RPC object yields -32600", async () => {
  const res = await handleMessage({ hello: "world" });
  assert.equal(res.error.code, -32600);
});

test("mcp: tools/call grok_search uses the search model + web search (fake runner)", async () => {
  const calls = [];
  const fakeRun = async (opts) => {
    calls.push(opts);
    return { ok: true, text: "answer with [cite](http://x)", thought: "" };
  };
  const res = await handleMessage(
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "grok_search", arguments: { query: "latest AI news" } }
    },
    { run: fakeRun, config: FAKE_CONFIG }
  );
  assert.equal(calls[0].model, "grok-4.5");
  assert.equal(calls[0].webSearch, true);
  assert.equal(res.result.content[0].type, "text");
  assert.ok(res.result.content[0].text.includes("answer"));
  assert.equal(res.result.isError, false);
});

test("mcp: legacy model overrides are rejected before invoking Grok", async () => {
  let called = false;
  const res = await handleMessage(
    {
      jsonrpc: "2.0",
      id: 74,
      method: "tools/call",
      params: { name: "grok_ask", arguments: { prompt: "hi", model: "grok-build" } }
    },
    { run: async () => ((called = true), { ok: true, text: "x" }), config: FAKE_CONFIG }
  );
  assert.equal(called, false);
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /deprecated/i);
});

test("mcp: tools/call with empty query is a tool execution error (isError true)", async () => {
  const res = await handleMessage(
    {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "grok_search", arguments: { query: "" } }
    },
    { run: async () => ({ ok: true, text: "x" }), config: FAKE_CONFIG }
  );
  assert.equal(res.result.isError, true);
});

test("mcp: grok_ask honors search:false (fake runner)", async () => {
  const calls = [];
  const fakeRun = async (opts) => {
    calls.push(opts);
    return { ok: true, text: "ok" };
  };
  await handleMessage(
    {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "grok_ask", arguments: { prompt: "hi", search: false } }
    },
    { run: fakeRun, config: FAKE_CONFIG }
  );
  assert.equal(calls[0].webSearch, false);
});

test("mcp: grok_ask honors config web_search=false when the search arg is absent", async () => {
  const calls = [];
  const fakeRun = async (opts) => {
    calls.push(opts);
    return { ok: true, text: "x" };
  };
  await handleMessage(
    {
      jsonrpc: "2.0",
      id: 71,
      method: "tools/call",
      params: { name: "grok_ask", arguments: { prompt: "hi" } }
    },
    { run: fakeRun, config: { ...FAKE_CONFIG, web_search: false } }
  );
  assert.equal(calls[0].webSearch, false);
});

test("mcp: grok_ask search:true overrides config web_search=false", async () => {
  const calls = [];
  const fakeRun = async (opts) => {
    calls.push(opts);
    return { ok: true, text: "x" };
  };
  await handleMessage(
    {
      jsonrpc: "2.0",
      id: 72,
      method: "tools/call",
      params: { name: "grok_ask", arguments: { prompt: "hi", search: true } }
    },
    { run: fakeRun, config: { ...FAKE_CONFIG, web_search: false } }
  );
  assert.equal(calls[0].webSearch, true);
});

test("mcp: grok_search always searches regardless of config web_search=false", async () => {
  const calls = [];
  const fakeRun = async (opts) => {
    calls.push(opts);
    return { ok: true, text: "x" };
  };
  await handleMessage(
    {
      jsonrpc: "2.0",
      id: 73,
      method: "tools/call",
      params: { name: "grok_search", arguments: { query: "x" } }
    },
    { run: fakeRun, config: { ...FAKE_CONFIG, web_search: false } }
  );
  assert.equal(calls[0].webSearch, true);
});

test("mcp: grok_ask and grok_search pass process bounds through to the runner", async () => {
  const calls = [];
  const fakeRun = async (opts) => {
    calls.push(opts);
    return { ok: true, text: "x" };
  };
  const config = { ...FAKE_CONFIG, max_turns: 5, timeout_ms: 120_000 };
  await handleMessage(
    { jsonrpc: "2.0", id: 81, method: "tools/call", params: { name: "grok_ask", arguments: { prompt: "hi" } } },
    { run: fakeRun, config }
  );
  await handleMessage(
    { jsonrpc: "2.0", id: 82, method: "tools/call", params: { name: "grok_search", arguments: { query: "q" } } },
    { run: fakeRun, config }
  );
  assert.equal(calls[0].maxTurns, 5);
  assert.equal(calls[1].maxTurns, 5);
  assert.equal(calls[0].timeoutMs, 120_000);
  assert.equal(calls[1].timeoutMs, 120_000);
});

test("mcp: max_turns null/absent leaves maxTurns undefined", async () => {
  const calls = [];
  const fakeRun = async (opts) => {
    calls.push(opts);
    return { ok: true, text: "x" };
  };
  await handleMessage(
    { jsonrpc: "2.0", id: 83, method: "tools/call", params: { name: "grok_ask", arguments: { prompt: "hi" } } },
    { run: fakeRun, config: { ...FAKE_CONFIG, max_turns: null } }
  );
  assert.equal(calls[0].maxTurns, undefined);
});

test("mcp: tools/call on a grok failure returns isError true with the message", async () => {
  const res = await handleMessage(
    {
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: { name: "grok_ask", arguments: { prompt: "hi" } }
    },
    { run: async () => ({ ok: false, error: "grok exploded" }), config: FAKE_CONFIG }
  );
  assert.equal(res.result.isError, true);
  assert.ok(res.result.content[0].text.includes("grok exploded"));
});

test("mcp: child process handshake + malformed line, server stays alive", async () => {
  const server = fileURLToPath(new URL("../scripts/mcp-server.mjs", import.meta.url));
  const child = spawn(process.execPath, [server], { stdio: ["pipe", "pipe", "pipe"] });

  const messages = [];
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.trim()) {
        messages.push(JSON.parse(line));
      }
    }
  });

  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
  child.stdin.write("{ this is not valid json\n");

  await new Promise((resolve) => setTimeout(resolve, 400));
  child.stdin.end();
  const code = await new Promise((resolve) => child.on("close", resolve));

  assert.equal(code, 0);
  const init = messages.find((m) => m.id === 1);
  const list = messages.find((m) => m.id === 2);
  const parseError = messages.find((m) => m.error && m.error.code === -32700);
  assert.ok(init && init.result.serverInfo.name === "grok");
  assert.ok(list && list.result.tools.length === 2);
  assert.ok(parseError, "malformed line should produce a -32700 parse error and not crash the server");
});
