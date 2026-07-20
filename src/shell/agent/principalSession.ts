// The persistent principal-agent session (principal-agent scheme). Module-scoped
// singleton in the terminalSession.ts spirit: the drawer component merely
// attaches/detaches a long-lived xterm host, so the principal (and its
// scrollback) survives drawer toggles and mode switches. The session spawns the
// USER'S configured principal CLI (agents.json → agent:principalSpec) in a real
// PTY, and Flux itself captures the TRANSCRIPT — the xterm buffer is flushed to
// Context/Transcripts/<stamp>.md periodically and on exit/close, so the record
// is agent-agnostic (whatever CLI runs, the terminal host sees it) and needs no
// cooperation from the agent. With no bridge (web dev server / node-pty
// missing) the drawer shows an "unavailable" notice.

import { get, writable, type Writable } from "svelte/store";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { fileBridge, joinPath } from "../../lib/project/types";
import { CONTEXT_PATHS } from "../../lib/project/contextTemplates";
import {
  serializeTerminalBuffer,
  transcriptDoc,
  transcriptStamp,
} from "../../lib/terminal/bufferText";
import { currentProject } from "../shellStore";
import { registerPrincipalAskSink } from "../command/commandBus";

export interface PrincipalSelection {
  principal: { family: string; model: string; effort: string };
  worker: { family: string; model: string; effort: string };
}

function bridge() {
  return fileBridge()?.term;
}

export type PrincipalStatus = "idle" | "connecting" | "running" | "exited" | "unavailable";

export const principalStatus: Writable<PrincipalStatus> = writable("idle");
export const principalInfo: Writable<{ command: string; cwd: string; pid: number } | null> =
  writable(null);
export const principalNotice: Writable<string | null> = writable(null);

let status: PrincipalStatus = "idle";
function setStatus(s: PrincipalStatus) {
  status = s;
  principalStatus.set(s);
}

function cssVar(name: string, fallback: string): string {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  } catch {
    return fallback;
  }
}

interface Session {
  el: HTMLDivElement;
  term: Terminal;
  fit: FitAddon;
  ptyId: string | null;
  opened: boolean;
  /** Absolute transcript path for THIS run (set at spawn). */
  transcriptPath: string | null;
  transcriptTimer: ReturnType<typeof setInterval> | null;
  /** Buffer line count already flushed (avoid rewriting unchanged transcripts). */
  lastFlushedSig: string;
  startedAt: string;
}

let session: Session | null = null;
let sessionRoot: string | null | undefined = undefined;
const pendingAsks: string[] = [];
let askTimer: ReturnType<typeof setTimeout> | null = null;

const TRANSCRIPT_FLUSH_MS = 30_000;

async function flushTranscript(force = false): Promise<void> {
  const s = session;
  const fb = fileBridge();
  if (!s || !fb || !s.transcriptPath || !s.opened) return;
  try {
    const body = serializeTerminalBuffer(s.term);
    const sig = `${body.length}:${body.slice(-80)}`;
    if (!force && sig === s.lastFlushedSig) return;
    s.lastFlushedSig = sig;
    await fb.writeText(s.transcriptPath, transcriptDoc(s.startedAt, body));
  } catch {
    /* transcripts are best-effort — never break the session over them */
  }
}

function ensure(): Session {
  if (session) return session;
  const el = document.createElement("div");
  el.className = "flux-principal-host";
  el.style.cssText = "width:100%;height:100%;";
  const term = new Terminal({
    fontFamily: cssVar("--font-mono", "ui-monospace, Menlo, Consolas, monospace"),
    fontSize: 12.5,
    lineHeight: 1.18,
    cursorBlink: true,
    cursorStyle: "bar",
    scrollback: 50_000, // the transcript serializes from this buffer — keep it deep
    theme: {
      background: cssVar("--c-bg", "#100f0f"),
      foreground: cssVar("--c-tx-1", "#cecdc3"),
      cursor: cssVar("--c-accent", "#4385be"),
    },
    macOptionIsMeta: true,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  session = {
    el,
    term,
    fit,
    ptyId: null,
    opened: false,
    transcriptPath: null,
    transcriptTimer: null,
    lastFlushedSig: "",
    startedAt: "",
  };

  const br = bridge();
  if (!br) {
    setStatus("unavailable");
    return session;
  }
  term.onData((d) => {
    if (session?.ptyId) br.write(session.ptyId, d);
  });
  br.onData((m) => {
    if (session && m.id === session.ptyId) {
      session.term.write(m.data);
      if (pendingAsks.length) armAskFlush(400);
    }
  });
  br.onExit((m) => {
    if (session && m.id === session.ptyId) {
      session.ptyId = null;
      principalInfo.set(null);
      setStatus("exited");
      void flushTranscript(true);
      stopTranscriptTimer();
      const code = typeof m.exitCode === "number" ? ` · code ${m.exitCode}` : "";
      session.term.write(
        `\r\n\x1b[90m[principal exited${code}] — Restart to start a new session\x1b[0m\r\n`,
      );
    }
  });
  return session;
}

function stopTranscriptTimer() {
  const s = session;
  if (s?.transcriptTimer) {
    clearInterval(s.transcriptTimer);
    s.transcriptTimer = null;
  }
}

async function start(s: Session, selection?: PrincipalSelection): Promise<void> {
  const br = bridge();
  const fb = fileBridge();
  if (!br || !fb?.agentPrincipalSpec) {
    setStatus("unavailable");
    return;
  }
  setStatus("connecting");
  const spec = await fb.agentPrincipalSpec(selection ? { selection } : undefined).catch(() => null);
  if (!spec?.ok || !spec.command) {
    setStatus("exited");
    s.term.write(
      `\r\n\x1b[31m${spec?.error ?? "couldn't resolve the principal launch spec"}\x1b[0m\r\n` +
        `\x1b[90mEdit the roster in <FluxConfig>/agents.json (see FluxContext/AGENTS-CONFIG.md).\x1b[0m\r\n`,
    );
    return;
  }
  if (spec.warning) principalNotice.set(spec.warning);
  const res = await br.create({
    command: spec.command,
    args: spec.args ?? [],
    cwd: spec.cwd,
    env: spec.env,
    cols: s.term.cols,
    rows: s.term.rows,
  });
  if (!res.ok) {
    setStatus("exited");
    s.term.write(
      `\r\n\x1b[31m${res.error}\x1b[0m\r\n\x1b[90mIs \`${spec.command}\` installed? The roster lives in ${spec.agentsPath ?? "<FluxConfig>/agents.json"}.\x1b[0m\r\n`,
    );
    return;
  }
  s.ptyId = res.id;
  s.startedAt = new Date().toISOString();
  principalInfo.set({ command: spec.command, cwd: res.cwd, pid: res.pid });
  setStatus("running");
  // Transcript home: the OPEN PROJECT's Context/Transcripts (the cwd may be the
  // analysis parent — transcripts always belong to the project).
  const root = get(currentProject)?.path ?? null;
  s.transcriptPath = root
    ? joinPath(root, `${CONTEXT_PATHS.transcriptsDir}/${transcriptStamp()}.md`)
    : null;
  s.lastFlushedSig = "";
  stopTranscriptTimer();
  s.transcriptTimer = setInterval(() => void flushTranscript(), TRANSCRIPT_FLUSH_MS);
  fitNow();
  armAskFlush(4000); // boot fallback: flush queued asks even if quiet-detect misses
}

function armAskFlush(ms: number) {
  if (askTimer) clearTimeout(askTimer);
  askTimer = setTimeout(() => {
    askTimer = null;
    flushAsks();
  }, ms);
}

function flushAsks() {
  const s = session;
  const br = bridge();
  if (!s?.ptyId || !br || status !== "running") return;
  while (pendingAsks.length) br.write(s.ptyId, pendingAsks.shift()!);
  s.term.focus();
}

/** Prefill (never auto-submit) a line into the principal's input. */
export function ask(text: string): void {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return;
  pendingAsks.push(t + " ");
  if (status === "running") armAskFlush(50);
}

export function isAvailable(): boolean {
  return !!bridge();
}

let inited = false;
/** Idempotent wiring: retire the session when the open project changes (its
 *  transcript + cwd belong to the old one), and drain queued asks. Called from
 *  the drawer's mount (this module loads lazily on first open). */
export function initPrincipalSession(): void {
  if (inited) return;
  inited = true;
  registerPrincipalAskSink(ask);
  currentProject.subscribe((p) => void syncRoot(p?.path ?? null));
}

let lastSelection: PrincipalSelection | null = null;

/** Probe the roster for the drawer's launch picker (families + standing choice). */
export async function probeRoster() {
  return fileBridge()?.agentPrincipalSpec?.({ probe: true }).catch(() => null) ?? null;
}

/** Launch a session with the picker's selection (persisted as last-used). */
export async function launch(selection: PrincipalSelection): Promise<void> {
  const s = ensure();
  if (s.ptyId) return; // already running
  lastSelection = selection;
  await start(s, selection);
  s.term.focus();
}

/** Back to the picker: kill anything running and return to idle. */
export async function resetToIdle(): Promise<void> {
  const s = session;
  const br = bridge();
  if (s?.ptyId && br) {
    await flushTranscript(true);
    await br.kill(s.ptyId);
    s.ptyId = null;
  }
  stopTranscriptTimer();
  if (s?.opened) s.term.reset();
  principalInfo.set(null);
  setStatus(bridge() ? "idle" : "unavailable");
}

export function attach(container: HTMLElement): void {
  const s = ensure();
  container.appendChild(s.el);
  if (!s.opened) {
    s.term.open(s.el);
    s.opened = true;
  }
  requestAnimationFrame(() => {
    fitNow();
    s.term.focus();
    // No auto-start: the drawer's picker calls launch() explicitly.
  });
}

export function detach(): void {
  void flushTranscript();
  session?.el.parentElement?.removeChild(session.el);
}

export function fitNow(): void {
  const s = session;
  if (!s || !s.opened) return;
  try {
    s.fit.fit();
    if (s.ptyId) bridge()?.resize(s.ptyId, s.term.cols, s.term.rows);
  } catch {
    /* host not laid out yet */
  }
}

export function focus(): void {
  session?.term.focus();
}

export async function restart(): Promise<void> {
  const s = ensure();
  const br = bridge();
  if (!br) {
    setStatus("unavailable");
    return;
  }
  await flushTranscript(true);
  if (s.ptyId) {
    await br.kill(s.ptyId);
    s.ptyId = null;
  }
  stopTranscriptTimer();
  s.term.reset();
  await start(s, lastSelection ?? undefined);
  s.term.focus();
}

/** Project switch/close: the running principal belongs to the OLD project —
 *  flush its transcript, kill it, and reset so the next attach starts fresh. */
export async function syncRoot(root: string | null): Promise<void> {
  const prev = sessionRoot;
  sessionRoot = root;
  if (prev === undefined || prev === root) return;
  const s = session;
  const br = bridge();
  if (s?.ptyId && br) {
    await flushTranscript(true);
    await br.kill(s.ptyId);
  }
  stopTranscriptTimer();
  if (s) {
    s.ptyId = null;
    s.transcriptPath = null;
    if (s.opened) s.term.reset();
  }
  principalInfo.set(null);
  setStatus("idle");
}
