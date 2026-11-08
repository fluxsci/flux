// The transcript model — ONE pure reducer from the runner's event stream
// (RunnerPayload: message deltas, thinking, tool calls, usage, status, errors)
// to the view model every AI surface renders: Ask's exchange, a background
// run's live activity in the Inbox, and the kept thread. Pure and DOM-free so
// it gates hermetically (verify-transcript.ts) and so Ask and the Inbox can
// never drift in how they read the same stream.
//
// Shape: a transcript is a list of TURNS (human question → agent answer). An
// agent turn is a list of BLOCKS in arrival order — prose, thinking, a GROUP of
// consecutive tool calls, an error — so a reader sees "it looked at these,
// then said this". Deltas fold into the block they belong to; a completed
// message envelope REPLACES its streamed text (never duplicates it).

import type { RunnerPayload } from "../project/types";

export type TurnRole = "human" | "agent";
export type ToolStatus = "started" | "done" | "failed";
/** What a tool call is, for the icon and the summary line. */
export type ToolKind = "flux" | "read" | "search" | "edit" | "shell" | "web" | "other";

export interface ToolCall {
  /** The runner's tool id (already turn-scoped by the caller when needed). */
  id: string;
  /** The raw tool title ("mcp__flux__get_figure_image", "Read", "Grep"). */
  title: string;
  /** The human name ("get_figure_image", "Read"). */
  name: string;
  kind: ToolKind;
  input: unknown;
  output?: unknown;
  status: ToolStatus;
  /** One short line a reader understands ("figure 2", "paper/draft.qmd", "TODO"). */
  summary: string;
  /** PNG/JPEG data URLs found in the tool's result (a figure the agent looked at). */
  images: string[];
}

export type Block =
  | { kind: "text"; id: string; text: string; streaming: boolean }
  | { kind: "thinking"; id: string; text: string; streaming: boolean }
  | { kind: "tools"; id: string; calls: ToolCall[] }
  | { kind: "error"; id: string; message: string };

export interface Usage { costUsd?: number; inputTokens?: number; outputTokens?: number }

export type TurnState = "streaming" | "done" | "failed" | "cancelled";

export interface Turn {
  id: string;
  role: TurnRole;
  /** A human turn has exactly one text block; an agent turn has any number. */
  blocks: Block[];
  state: TurnState;
  usage?: Usage;
  /** Human turns: the pictures attached to the question (object/data URLs). */
  images?: string[];
  startedAt: number;
  endedAt?: number;
}

export type RunState = "idle" | "starting" | "running" | "done" | "failed" | "cancelled";

export interface Transcript {
  turns: Turn[];
  sessionId: string;
  state: RunState;
  /** The runner's last status reason ("Reading the captured context…"). */
  reason: string;
  /** The last fatal error, if any (also recorded as a block on the open turn). */
  error: string;
}

export const emptyTranscript = (): Transcript => ({ turns: [], sessionId: "", state: "idle", reason: "", error: "" });

let counter = 0;
const uid = (prefix: string) => `${prefix}${++counter}`;

/** Start a human turn and open the agent turn that will answer it. */
export function askTurn(t: Transcript, text: string, opts: { images?: string[]; now?: number } = {}): Transcript {
  const now = opts.now ?? Date.now();
  const human: Turn = { id: uid("h"), role: "human", blocks: [{ kind: "text", id: uid("t"), text, streaming: false }], state: "done", images: opts.images, startedAt: now, endedAt: now };
  const agent: Turn = { id: uid("a"), role: "agent", blocks: [], state: "streaming", startedAt: now };
  return { ...t, turns: [...t.turns, human, agent], state: "starting", reason: "", error: "" };
}

/** The agent turn that is still receiving events, if any. */
export function openTurn(t: Transcript): Turn | null {
  const last = t.turns[t.turns.length - 1];
  return last && last.role === "agent" && last.state === "streaming" ? last : null;
}

function withOpenTurn(t: Transcript, update: (turn: Turn) => Turn, now: number): Transcript {
  const i = t.turns.length - 1;
  const last = t.turns[i];
  if (last && last.role === "agent" && last.state === "streaming") {
    const turns = t.turns.slice(); turns[i] = update(last); return { ...t, turns };
  }
  // Events without a question (a resumed session, a background task): open a turn for them.
  const fresh: Turn = { id: uid("a"), role: "agent", blocks: [], state: "streaming", startedAt: now };
  return { ...t, turns: [...t.turns, update(fresh)] };
}

function replaceBlock(turn: Turn, index: number, block: Block): Turn {
  const blocks = turn.blocks.slice(); blocks[index] = block; return { ...turn, blocks };
}
function closeStreaming(turn: Turn): Turn {
  return { ...turn, blocks: turn.blocks.map(b => (b.kind === "text" || b.kind === "thinking") && b.streaming ? { ...b, streaming: false } : b) };
}

/** Fold one runner event. `now` lets gates run on a fake clock. */
export function reduceTranscript(t: Transcript, event: RunnerPayload, now = Date.now()): Transcript {
  switch (event.type) {
    case "session": return { ...t, sessionId: event.sessionId };
    case "background": return t;
    case "message.delta":
    case "message": {
      const id = `m:${event.messageId ?? "answer"}`;
      return withOpenTurn(t, turn => {
        const i = turn.blocks.findIndex(b => b.kind === "text" && b.id === id);
        if (event.type === "message") {
          const block: Block = { kind: "text", id, text: event.text, streaming: false };
          return i < 0 ? { ...turn, blocks: [...turn.blocks, block] } : replaceBlock(turn, i, block);
        }
        if (i < 0) return { ...turn, blocks: [...turn.blocks, { kind: "text", id, text: event.text, streaming: true }] };
        const b = turn.blocks[i] as Extract<Block, { kind: "text" }>;
        return replaceBlock(turn, i, { ...b, text: b.text + event.text, streaming: true });
      }, now);
    }
    case "thought.delta":
      return withOpenTurn(t, turn => {
        const last = turn.blocks[turn.blocks.length - 1];
        if (last?.kind === "thinking" && last.streaming) return replaceBlock(turn, turn.blocks.length - 1, { ...last, text: last.text + event.text });
        return { ...turn, blocks: [...turn.blocks, { kind: "thinking", id: uid("k"), text: event.text, streaming: true }] };
      }, now);
    case "tool":
      return withOpenTurn(t, turn => {
        const call = describeTool(event);
        // A finished tool updates its own row wherever it sits; a new one joins the trailing group.
        for (let i = turn.blocks.length - 1; i >= 0; i--) {
          const b = turn.blocks[i];
          if (b.kind !== "tools") continue;
          const j = b.calls.findIndex(c => c.id === call.id);
          if (j >= 0) { const calls = b.calls.slice(); calls[j] = call; return replaceBlock(turn, i, { ...b, calls }); }
        }
        const closed = closeStreaming(turn);
        const last = closed.blocks[closed.blocks.length - 1];
        if (last?.kind === "tools") return replaceBlock(closed, closed.blocks.length - 1, { ...last, calls: [...last.calls, call] });
        return { ...closed, blocks: [...closed.blocks, { kind: "tools", id: uid("g"), calls: [call] }] };
      }, now);
    case "usage":
      return withOpenTurn(t, turn => ({ ...turn, usage: { costUsd: event.costUsd, inputTokens: event.inputTokens, outputTokens: event.outputTokens } }), now);
    case "error": {
      const next = withOpenTurn(t, turn => ({ ...turn, blocks: [...closeStreaming(turn).blocks, { kind: "error", id: uid("e"), message: event.message }] }), now);
      return { ...next, error: event.message };
    }
    case "status": {
      const reason = event.reason ?? "";
      if (event.state === "starting" || event.state === "running") return { ...t, state: event.state, reason };
      const finished: TurnState = event.state === "failed" ? "failed" : event.state === "cancelled" ? "cancelled" : "done";
      const i = t.turns.length - 1, last = t.turns[i];
      const turns = t.turns.slice();
      if (last && last.role === "agent" && last.state === "streaming") turns[i] = { ...closeStreaming(last), state: finished, endedAt: now };
      return { ...t, turns, state: event.state, reason };
    }
    default: return t;
  }
}

/** Mark the open turn cancelled (the user pressed Stop). */
export function cancelTranscript(t: Transcript, now = Date.now()): Transcript {
  return reduceTranscript(t, { type: "status", state: "cancelled", reason: "Stopped" }, now);
}

// --- tools ---------------------------------------------------------------------------

/** "get_figure_image", not "mcp__flux__get_figure_image" (Claude) or "flux.get_figure_image" (Codex). */
export const toolName = (title: string): string => title.replace(/^mcp__flux__|^flux\./, "");

const FLUX_TOOL = /^(mcp__flux__|flux\.)/;
export function toolKind(title: string): ToolKind {
  if (FLUX_TOOL.test(title)) return "flux";
  const n = title.toLowerCase();
  if (/^(read|cat|view|notebookread)$/.test(n)) return "read";
  if (/^(grep|glob|ls|search|find|rg)$/.test(n)) return "search";
  if (/^(edit|write|multiedit|notebookedit|apply_patch|create)$/.test(n)) return "edit";
  if (/^(bash|shell|exec|run|terminal|powershell)$/.test(n)) return "shell";
  if (/^(webfetch|websearch|fetch|browser|web)$/.test(n)) return "web";
  return "other";
}

const str = (v: unknown): string | null => typeof v === "string" && v.trim() ? v.trim() : null;
const tail = (p: string): string => p.replace(/[\\/]+$/, "").split(/[\\/]/).slice(-2).join("/");
const clip = (s: string, n = 72): string => s.length > n ? `${s.slice(0, n - 1)}…` : s;

/** The one line that explains a call to a reader who never saw its JSON. */
export function toolSummary(title: string, input: unknown): string {
  const name = toolName(title);
  const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const kind = toolKind(title);
  if (kind === "read" || kind === "edit") {
    const p = str(o.file_path) ?? str(o.path) ?? str(o.notebook_path);
    if (p) {
      const from = typeof o.offset === "number" ? o.offset : null, limit = typeof o.limit === "number" ? o.limit : null;
      return clip(tail(p) + (from != null ? `:${from}${limit != null ? `–${from + limit}` : ""}` : ""));
    }
  }
  if (kind === "search") {
    const q = str(o.pattern) ?? str(o.query) ?? str(o.glob);
    const where = str(o.path);
    if (q) return clip(`${q}${where ? ` in ${tail(where)}` : ""}`);
  }
  if (kind === "shell") { const c = str(o.command) ?? str(o.cmd); if (c) return clip(c.replace(/\s+/g, " ")); }
  if (kind === "web") { const u = str(o.url) ?? str(o.query); if (u) return clip(u); }
  if (kind === "flux") {
    const parts: string[] = [];
    const id = str(o.id) ?? str(o.figure) ?? str(o.figureId) ?? str(o.deck) ?? str(o.element) ?? str(o.partId);
    const doc = str(o.doc) ?? str(o.document) ?? str(o.name);
    if (id) parts.push(id);
    if (doc) parts.push(doc);
    const q = str(o.query) ?? str(o.text) ?? str(o.filter);
    if (q) parts.push(`“${clip(q, 40)}”`);
    if (parts.length) return clip(parts.join(" · "));
  }
  if (typeof input === "string") return clip(input);
  const firsts = Object.entries(o).filter(([, v]) => typeof v === "string" || typeof v === "number").slice(0, 2).map(([k, v]) => `${k}: ${clip(String(v), 32)}`);
  return firsts.length ? clip(firsts.join(" · ")) : "";
}

/** data: image URLs inside a tool result (Claude returns image blocks for Flux's PNG tools). */
export function toolImages(output: unknown, limit = 4): string[] {
  const out: string[] = [];
  const walk = (v: unknown, depth: number): void => {
    if (out.length >= limit || depth > 4 || v == null) return;
    if (typeof v === "string") { if (/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(v) && v.length < 12_000_000) out.push(v); return; }
    if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return; }
    if (typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (o.type === "image" && o.source && typeof o.source === "object") {
        const s = o.source as Record<string, unknown>;
        if (s.type === "base64" && typeof s.data === "string" && typeof s.media_type === "string" && /^image\/(png|jpeg|webp)$/.test(s.media_type) && s.data.length < 12_000_000) { out.push(`data:${s.media_type};base64,${s.data}`); return; }
      }
      for (const x of Object.values(o)) walk(x, depth + 1);
    }
  };
  walk(output, 0);
  return out;
}

export function describeTool(event: Extract<RunnerPayload, { type: "tool" }>): ToolCall {
  return { id: event.toolId, title: event.title, name: toolName(event.title), kind: toolKind(event.title), input: event.input,
    output: event.output, status: event.status, summary: toolSummary(event.title, event.input), images: toolImages(event.output) };
}

/** The group's one-line summary: "Read 3 files · Searched twice · get_figure_image". */
export function toolGroupSummary(calls: readonly ToolCall[]): string {
  const counts = new Map<string, number>();
  for (const c of calls) {
    const key = c.kind === "flux" || c.kind === "other" ? c.name : c.kind;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const words: Record<string, [string, string]> = { read: ["Read 1 file", "Read {n} files"], search: ["Searched once", "Searched {n} times"], edit: ["Edited 1 file", "Edited {n} files"], shell: ["Ran 1 command", "Ran {n} commands"], web: ["Fetched 1 page", "Fetched {n} pages"] };
  return [...counts].map(([key, n]) => {
    const w = words[key];
    if (w) return n === 1 ? w[0] : w[1].replace("{n}", String(n));
    return n === 1 ? key : `${key} ×${n}`;
  }).join(" · ");
}

/** Running / failed / done, for the group's status dot. */
export function toolGroupStatus(calls: readonly ToolCall[]): ToolStatus {
  if (calls.some(c => c.status === "started")) return "started";
  if (calls.some(c => c.status === "failed")) return "failed";
  return "done";
}

/** A readable, bounded rendering of a tool's input or output for the expanded row. */
export function toolDetail(value: unknown, max = 4000): string {
  if (value == null) return "";
  let text: string;
  if (typeof value === "string") text = value;
  else if (Array.isArray(value) && value.every(v => v && typeof v === "object" && (v as { type?: string }).type === "text" && typeof (v as { text?: unknown }).text === "string")) text = value.map(v => (v as { text: string }).text).join("\n");
  else {
    const scrubbed = JSON.parse(JSON.stringify(value, (_k, v) => typeof v === "string" && v.startsWith("data:image/") ? "(image)" : (v && typeof v === "object" && (v as { type?: string }).type === "image") ? "(image)" : v));
    text = JSON.stringify(scrubbed, null, 2);
  }
  return text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} more characters)` : text;
}

// --- derived facts for the surfaces ----------------------------------------------------

/** The prose of the last agent answer (what Keep saves and Copy copies). */
export function lastAnswer(t: Transcript): string {
  for (let i = t.turns.length - 1; i >= 0; i--) {
    const turn = t.turns[i];
    if (turn.role !== "agent") continue;
    const text = turn.blocks.filter((b): b is Extract<Block, { kind: "text" }> => b.kind === "text").map(b => b.text).join("\n\n").trim();
    if (text) return text;
  }
  return "";
}

/** Question/answer pairs as plain messages (the kept-thread shape). */
export function transcriptMessages(t: Transcript): { role: TurnRole; text: string; id?: string }[] {
  const out: { role: TurnRole; text: string; id?: string }[] = [];
  for (const turn of t.turns) {
    const text = turn.blocks.filter((b): b is Extract<Block, { kind: "text" }> => b.kind === "text").map(b => b.text).join("\n\n").trim();
    if (text) out.push({ role: turn.role, text, id: turn.id });
  }
  return out;
}

/** Markdown of the whole exchange, for "Copy as markdown". */
export function transcriptMarkdown(t: Transcript, names: { human: string; agent: string } = { human: "You", agent: "Agent" }): string {
  const parts: string[] = [];
  for (const turn of t.turns) {
    const lines: string[] = [];
    for (const b of turn.blocks) {
      if (b.kind === "text") lines.push(b.text.trim());
      else if (b.kind === "tools") lines.push(`> ${toolGroupSummary(b.calls)}: ${b.calls.map(c => `${c.name}${c.summary ? ` (${c.summary})` : ""}`).join(", ")}`);
      else if (b.kind === "error") lines.push(`> Error: ${b.message}`);
    }
    if (lines.length) parts.push(`**${turn.role === "human" ? names.human : names.agent}**\n\n${lines.join("\n\n")}`);
  }
  return parts.join("\n\n---\n\n");
}

/** What the status line should say while the run is busy. */
export function transcriptActivity(t: Transcript): string {
  const turn = openTurn(t);
  if (!turn) return t.state === "starting" ? (t.reason || "Preparing…") : "";
  const last = turn.blocks[turn.blocks.length - 1];
  if (last?.kind === "tools") {
    const running = last.calls.find(c => c.status === "started");
    if (running) return `${running.kind === "read" ? "Reading" : running.kind === "search" ? "Searching" : running.kind === "edit" ? "Editing" : running.kind === "shell" ? "Running" : running.kind === "web" ? "Fetching" : "Using"} ${running.summary || running.name}…`;
  }
  if (last?.kind === "thinking" && last.streaming) return "Thinking…";
  if (last?.kind === "text" && last.streaming) return "Writing…";
  return t.reason || "Working…";
}
