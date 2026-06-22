import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const COMMANDS = [
  { name: "ask", disablesModel: true, requiredTools: ["Bash(node:*)"], dispatcher: "ask" },
  { name: "review", disablesModel: true, requiredTools: ["Bash(node:*)", "Bash(git:*)"], dispatcher: "review" },
  { name: "status", disablesModel: true, requiredTools: ["Bash(node:*)"], dispatcher: "status" },
  { name: "result", disablesModel: true, requiredTools: ["Bash(node:*)"], dispatcher: "result" },
  { name: "cancel", disablesModel: true, requiredTools: ["Bash(node:*)"], dispatcher: "cancel" },
  { name: "setup", disablesModel: false, requiredTools: ["Bash(node:*)"], dispatcher: "setup" }
];

function commandText(name) {
  return fs.readFileSync(path.join(ROOT, "commands", `${name}.md`), "utf8");
}

function frontmatter(text) {
  const match = text.match(/^---\n([\s\S]*?)\n---/);
  assert.ok(match, "expected command markdown to start with frontmatter");
  return match[1];
}

test("commands: every shipped slash command has frontmatter with a description and argument hint", () => {
  for (const command of COMMANDS) {
    const fm = frontmatter(commandText(command.name));
    assert.match(fm, /^description:\s+\S/m, `${command.name} is missing description`);
    assert.match(fm, /^argument-hint:\s+/m, `${command.name} is missing argument-hint`);
    for (const tool of command.requiredTools) {
      assert.ok(fm.includes(tool), `${command.name} should allow ${tool}`);
    }
  }
});

test("commands: model invocation is disabled for mechanical command wrappers", () => {
  for (const command of COMMANDS.filter((entry) => entry.disablesModel)) {
    const fm = frontmatter(commandText(command.name));
    assert.match(fm, /^disable-model-invocation:\s+true/m, `${command.name} should not invoke the model`);
  }
});

test("commands: every command routes through the central dispatcher", () => {
  for (const command of COMMANDS) {
    const text = commandText(command.name);
    assert.ok(text.includes('${CLAUDE_PLUGIN_ROOT}/scripts/grok.mjs'), `${command.name} should use the plugin dispatcher`);
    assert.ok(text.includes(`grok.mjs" ${command.dispatcher}`), `${command.name} should call the ${command.dispatcher} subcommand`);
  }
});

test("commands: ask and review background modes use Claude Code background bash", () => {
  for (const name of ["ask", "review"]) {
    const text = commandText(name);
    assert.ok(text.includes("--background"), `${name} should document --background`);
    assert.ok(text.includes("run_in_background: true"), `${name} should launch background mode explicitly`);
  }
});

test("commands: review remains read-only and refuses to act on findings", () => {
  const text = commandText("review");
  assert.ok(text.includes("READ-ONLY"));
  assert.ok(text.includes("Do not fix issues, apply patches, edit files"));
  assert.ok(text.includes("Do not act on any issue Grok raises"));
});

test("commands: ask documents live search defaults and overrides", () => {
  const text = commandText("ask");
  assert.ok(text.includes("live web/X search"));
  assert.ok(text.includes("--no-search"));
  assert.ok(text.includes("--search"));
  assert.ok(text.includes("search_model"));
});

test("commands: setup keeps auth guidance secret-safe and curl-based", () => {
  const text = commandText("setup");
  assert.ok(text.includes("curl -fsSL https://x.ai/cli/install.sh | bash"));
  assert.match(text, /do NOT suggest `npm install`/i);
  assert.ok(text.includes("Never print the key value"));
});

test("commands: status/result/cancel preserve verbatim job plumbing output", () => {
  assert.ok(commandText("status").includes("Present the full job detail verbatim"));
  assert.ok(commandText("result").includes("Return the captured output verbatim"));
  assert.ok(commandText("cancel").includes("Confirm the cancellation"));
});
