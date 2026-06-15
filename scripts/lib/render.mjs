// Turn a grok result (from lib/grok.mjs runGrok) into an inline markdown string.
// Used identically by the slash-command dispatcher and the MCP server so that
// citations and error formatting render the same everywhere.

export function truncate(value, max = 100000) {
  const text = String(value ?? "");
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max)}\n\n…[truncated ${text.length - max} chars]`;
}

export function renderResult(result, { showThought = false } = {}) {
  if (!result || result.ok !== true) {
    const message = (result && result.error) || "Unknown error.";
    const lines = ["> ⚠ **Grok error**", "", message];
    const stderr = result && result.stderr ? String(result.stderr).trim() : "";
    if (stderr && stderr !== message) {
      lines.push("", "```text", truncate(stderr, 4000), "```");
    }
    return `${lines.join("\n")}\n`;
  }

  const body = (result.text || "").trim() || "_(Grok returned no text.)_";
  let out = body;
  if (showThought && result.thought && result.thought.trim()) {
    out += `\n\n<details>\n<summary>Reasoning</summary>\n\n${truncate(result.thought.trim(), 8000)}\n\n</details>`;
  }
  return `${out}\n`;
}

// --- Background job rendering -------------------------------------------------

export function formatElapsed(job, now = Date.now()) {
  const start = Date.parse(job?.startedAt);
  if (!Number.isFinite(start)) {
    return "";
  }
  const end = job?.finishedAt ? Date.parse(job.finishedAt) : now;
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  return `${seconds}s`;
}

function escapeCell(value) {
  return String(value ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ")
    .trim()
    .slice(0, 80);
}

export function renderJobsTable(jobs, now = Date.now()) {
  if (!Array.isArray(jobs) || jobs.length === 0) {
    return "No grok jobs yet.\n";
  }
  const lines = ["| Job ID | Kind | Status | Elapsed | Summary |", "| --- | --- | --- | --- | --- |"];
  for (const job of jobs) {
    lines.push(
      `| ${escapeCell(job.id)} | ${escapeCell(job.kind)} | ${escapeCell(job.status)} | ${escapeCell(
        formatElapsed(job, now)
      )} | ${escapeCell(job.summary)} |`
    );
  }
  return `${lines.join("\n")}\n`;
}

export function renderSetupReport(report) {
  const icon = (status) => (status === "ok" ? "✓" : status === "warn" ? "!" : "✗");
  const lines = ["# Grok setup", "", `Status: ${report.verdict}`, "", "Checks:"];
  for (const check of report.checks) {
    lines.push(`- ${icon(check.status)} ${check.name}: ${check.detail}`);
  }
  if (report.nextSteps.length > 0) {
    lines.push("", "Next steps:");
    for (const step of report.nextSteps) {
      lines.push(`- ${step}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export function renderJobDetail(job, now = Date.now()) {
  const pending = job.status === "running" || job.status === "queued";
  const lines = [
    `# Grok job ${job.id}`,
    "",
    `- Kind: ${job.kind}`,
    `- Status: ${job.status}`,
    `- PID: ${job.pid ?? "—"}`,
    `- Started: ${job.startedAt}`,
    `- Finished: ${job.finishedAt ?? "—"}`,
    `- Elapsed: ${formatElapsed(job, now)}`
  ];
  if (job.summary) {
    lines.push(`- Summary: ${job.summary}`);
  }
  lines.push(
    pending
      ? `- Result when done: /grok:result ${job.id}`
      : `- Result: /grok:result ${job.id}`
  );
  if (pending) {
    lines.push(`- Cancel: /grok:cancel ${job.id}`);
  }
  return `${lines.join("\n")}\n`;
}
