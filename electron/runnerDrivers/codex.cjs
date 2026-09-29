"use strict";

// Explicitly pre-approve Flux MCP writes; exec itself still never prompts.
const TASK_MCP_APPROVAL_MODE = "approve";

function capabilities(version, help, resumeHelp = "") {
  const missing = ["--json", "--skip-git-repo-check", "--sandbox", "--cd", "--image", "--config"].filter(flag => !help.includes(flag));
  if (!/PROMPT/.test(resumeHelp) || !resumeHelp.includes("--json")) missing.push("exec resume --json [PROMPT]");
  return { version: version.trim(), available: !missing.length, reason: missing.length ? `Update Codex: missing ${missing.join(", ")}` : undefined,
    model: help.includes("--model"), effort: help.includes("--config"), promptFile: false };
}
function mcpConfig(o) {
  // JSON strings are valid TOML basic strings; keys here are fixed, never user input.
  const q = JSON.stringify;
  const env = o.mcpEnv ?? { FLUX_MCP_READONLY: "1", FLUX_CLIENT: "fluxchat", FLUX_PROJECT: o.root };
  return `mcp_servers.flux={command=${q(o.launcher)},args=["mcp",${q(o.root)}],env={${Object.entries(env).map(([k,v]) => `${k}=${q(v)}`).join(",")}}`;
}
function args(o) {
  // exec resume has a smaller flag grammar: sandbox/cwd belong to the global
  // config and spawn options there, not to resume's positional parser.
  const sandbox = o.mode === "task" ? "workspace-write" : "read-only";
  const a = ["-c", 'approval_policy="never"', "-c", `sandbox_mode=${JSON.stringify(sandbox)}`, "-c", "mcp_servers={}", "-c", mcpConfig(o)];
  if (o.mode === "task") a.push("-c", `mcp_servers.flux.default_tools_approval_mode=${JSON.stringify(TASK_MCP_APPROVAL_MODE)}`);
  a.push("exec");
  if (o.resume) a.push("resume", o.resume);
  a.push("--json", "--skip-git-repo-check");
  if (!o.resume) a.push("-C", o.cwd, "-s", sandbox);
  if (o.model) a.push("-m", o.model);
  if (o.effort) a.push("-c", `model_reasoning_effort=${JSON.stringify(o.effort)}`);
  for (const p of o.images ?? []) a.push("-i", p);
  a.push("--", "-");
  return a;
}
function turn(text, packText, resumed) { return (resumed ? "" : packText + "\n\n") + text; }
function parser(emit) {
  const messages = new Map();
  return e => {
    if (e.type === "thread.started") emit({ type: "session", sessionId: e.thread_id });
    else if (e.type === "turn.started") emit({ type: "status", state: "running" });
    else if (e.type.startsWith("item.")) {
      const i = e.item ?? {}, finished = e.type === "item.completed";
      if (i.type === "agent_message" || i.type === "reasoning") {
        const old = messages.get(i.id) ?? "", text = i.text ?? "";
        if (i.type === "agent_message") {
          if (finished) emit({ type: "message", messageId: i.id, text });
          else if (text.startsWith(old) && text.length > old.length) emit({ type: "message.delta", messageId: i.id, text: text.slice(old.length) });
        } else if (text.startsWith(old) && text.length > old.length) emit({ type: "thought.delta", text: text.slice(old.length) });
        messages.set(i.id, text);
      } else if (i.type === "command_execution" || i.type === "mcp_tool_call") {
        const failed = i.status === "failed" || !!i.error || (i.exit_code != null && i.exit_code !== 0);
        emit({ type: "tool", toolId: i.id, title: i.type === "command_execution" ? "Command" : `${i.server}.${i.tool}`,
          input: i.type === "command_execution" ? i.command : i.arguments,
          status: failed ? "failed" : finished ? "done" : "started", output: i.type === "command_execution" ? i.aggregated_output : i.error ?? i.result });
      } else if (i.type === "file_change") for (const c of i.changes ?? []) emit({ type: "file.change", path: c.path, kind: c.kind });
    } else if (e.type === "turn.completed") {
      emit({ type: "usage", inputTokens: e.usage?.input_tokens, outputTokens: e.usage?.output_tokens });
      emit({ type: "status", state: "idle" });
    } else if (e.type === "turn.failed" || e.type === "error") {
      emit({ type: "error", message: e.error?.message || e.message || "Codex failed" });
      emit({ type: "status", state: "failed" });
    }
  };
}
module.exports = { capabilities, args, turn, parser, mcpConfig, TASK_MCP_APPROVAL_MODE };
