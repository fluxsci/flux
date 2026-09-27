"use strict";

const REQUIRED = ["--input-format", "--output-format", "--verbose", "--include-partial-messages", "--tools", "--permission-mode", "--permission-prompts", "--allowedTools", "--disallowedTools", "--add-dir", "--strict-mcp-config", "--mcp-config", "--resume"];
function capabilities(version, help) {
  const missing = REQUIRED.filter(flag => !help.includes(flag));
  const promptFile = help.includes("--append-system-prompt-file");
  if (!promptFile && !help.includes("--append-system-prompt")) missing.push("--append-system-prompt");
  return { version: version.trim(), available: !missing.length, reason: missing.length ? `Update Claude Code: missing ${missing.join(", ")}` : undefined,
    promptFile, model: help.includes("--model"), effort: help.includes("--effort") };
}
function args(o) {
  const a = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
    o.caps.promptFile ? "--append-system-prompt-file" : "--append-system-prompt", o.caps.promptFile ? o.packPath : o.packText,
    // Read-only by construction: the only built-ins are Read/Grep/Glob, and dontAsk denies
    // anything not pre-approved. Flux's server runs read-only, so all of its tools are
    // allowed (dontAsk otherwise denies every MCP call); the run directory holds the
    // attached view PNGs, which live outside the project. Verified on Claude Code 2.1.283.
    "--tools", "Read,Grep,Glob", "--permission-mode", "dontAsk", "--permission-prompts", "none",
    "--strict-mcp-config", "--mcp-config", o.mcpPath, "--add-dir", o.runDir, "--allowedTools", "mcp__flux"];
  if (o.model) a.push("--model", o.model);
  if (o.effort) a.push("--effort", o.effort);
  if (o.resume) a.push("--resume", o.resume);
  // Variadic tool lists are LAST. There is never a positional user prompt.
  a.push("--disallowedTools", "Bash", "Edit", "Write", "NotebookEdit");
  return a;
}
function turn(text, images = []) {
  // Read accepts images. Until the installed stream protocol advertises an image
  // schema, use that verified tool path instead of inventing a stdin block shape.
  const content = text + (images.length ? `\n\nAttached view (read these PNG files):\n${images.map(p => JSON.stringify(p)).join("\n")}` : "");
  return JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n";
}
function parser(emit) {
  const tools = new Map(), blocks = new Map(), streamed = new Set();
  let messageId = "", sawMessage = false;
  const tool = (b, status, output) => {
    const old = tools.get(b.id);
    const next = { type: "tool", toolId: b.id, title: b.name ?? old?.title ?? "Tool", input: b.input ?? old?.input ?? {}, status, ...(output === undefined ? {} : { output }) };
    tools.set(b.id, next); emit(next);
  };
  return e => {
    if (e.type === "system" && e.subtype === "init") {
      // Empty slash_commands/apiKeySource:none also occur in authenticated -p
      // fixtures. Only explicit bare markers are evidence of bare mode.
      if (e.bare === true || e.bare_mode === true || e.mode === "bare" || e.permissionMode === "bare") {
        emit({ type: "error", fatal: true, message: "Claude Code started in bare mode. Disable bare mode and sign in using your installed CLI. See https://code.claude.com/docs/en/cli-reference" });
        return;
      }
      if (e.session_id) emit({ type: "session", sessionId: e.session_id });
      const connected = e.mcp_servers?.some(s => s.name === "flux" && s.status === "connected");
      emit({ type: "status", state: "running", ...(connected ? {} : { reason: "Flux tools unavailable in this Claude session — run Flux → AI status → Repair" }) });
    } else if (e.type === "stream_event") {
      const v = e.event ?? {};
      if (v.type === "message_start") { messageId = v.message?.id ?? ""; blocks.clear(); }
      if (v.type === "content_block_start") {
        const b = { ...v.content_block, json: "" }; blocks.set(v.index, b);
        if (b.type === "text" && b.text) { streamed.add(messageId); emit({ type: "message.delta", messageId, text: b.text }); sawMessage = true; }
        if (b.type === "tool_use") tool(b, "started");
      }
      if (v.type === "content_block_delta") {
        const d = v.delta ?? {}, b = blocks.get(v.index);
        if (d.type === "text_delta") { streamed.add(messageId); emit({ type: "message.delta", messageId, text: d.text }); sawMessage = true; }
        if (d.type === "thinking_delta") emit({ type: "thought.delta", text: d.thinking });
        if (d.type === "input_json_delta" && b) b.json += d.partial_json;
      }
      if (v.type === "content_block_stop") {
        const b = blocks.get(v.index);
        if (b?.type === "tool_use" && b.json && !tools.get(b.id)?.completeInput) {
          try { b.input = JSON.parse(b.json); tool(b, "started"); } catch { /* complete assistant envelope follows */ }
        }
      }
    } else if (e.type === "assistant") {
      const m = e.message ?? {};
      const text = (m.content ?? []).filter(b => b.type === "text").map(b => b.text).join("");
      // A completed envelope finalizes that message, never duplicates its deltas.
      if (text) { emit({ type: "message", messageId: m.id, text }); sawMessage = true; }
      for (const b of m.content ?? []) {
        if (b.type === "thinking" && !streamed.has(m.id)) emit({ type: "thought.delta", text: b.thinking });
        if (b.type === "tool_use") { tool(b, "started"); tools.get(b.id).completeInput = true; }
      }
    } else if (e.type === "user") {
      for (const b of Array.isArray(e.message?.content) ? e.message.content : []) if (b.type === "tool_result")
        tool({ id: b.tool_use_id }, b.is_error ? "failed" : "done", b.content);
    } else if (e.type === "result") {
      if (!sawMessage && e.result) emit({ type: "message", text: e.result });
      if (e.usage || e.total_cost_usd !== undefined) emit({ type: "usage", costUsd: e.total_cost_usd,
        inputTokens: (e.usage?.input_tokens ?? 0) + (e.usage?.cache_read_input_tokens ?? 0) + (e.usage?.cache_creation_input_tokens ?? 0), outputTokens: e.usage?.output_tokens });
      if (e.is_error) emit({ type: "error", message: e.result || (e.errors ?? []).join("\n") || "Claude Code failed" });
      emit({ type: "status", state: e.is_error ? "failed" : "idle" });
      sawMessage = false; streamed.clear(); tools.clear();
    } else if (e.type === "error") emit({ type: "error", message: e.error?.message || e.message || "Claude Code failed" });
  };
}
module.exports = { capabilities, args, turn, parser };
