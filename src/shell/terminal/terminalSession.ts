// Persistent integrated-terminal session for the Dynamic Margin.
//
// The Dynamic Margin swaps view components on every rail switch, which would
// otherwise tear down the xterm and kill the shell each time you glanced at
// References. So the session lives HERE, at module scope, not in component
// state: one detached host <div> with the xterm opened into it once, plus the
// PTY id. TerminalView merely appends that <div> on mount and detaches it on
// unmount — the shell (and its scrollback) keep running across switches, in the
// same spirit as the "stable getter-backed marginHost" in PaperMode.
//
// The native shell itself runs in the Electron main process (electron/main.cjs);
// here we only speak the `window.fig.term` bridge. With no bridge (the web dev
// server, or node-pty failing to load) the session reports "unavailable" and
// TerminalView shows a notice instead of a broken terminal.

import { writable, type Writable } from "svelte/store";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { fileBridge } from "../../lib/project/types";

// SHL-16: the PTY bridge (window.fig.term) is now typed centrally on FileBridge; reach it
// through fileBridge() so there's no ad-hoc window cast. Undefined under the web fallback.
function bridge() {
  return fileBridge()?.term;
}

export type TermStatus = "idle" | "connecting" | "running" | "exited" | "unavailable";

export interface TermInfo {
  shell: string;
  cwd: string;
  pid: number;
}

let status: TermStatus = "idle";
export const termStatus: Writable<TermStatus> = writable(status);
export const termInfo: Writable<TermInfo | null> = writable(null);

function setStatus(s: TermStatus) {
  status = s;
  termStatus.set(s);
}

function cssVar(name: string, fallback: string): string {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  } catch {
    return fallback;
  }
}

// Flexoki "paper" terminal theme — matches the manuscript surface (the .paper
// scope: cream page, ink text), with the Flexoki LIGHT ANSI ramp (600-weight
// normals + 400-weight brights, legible on cream). The terminal lives only in
// the Paper module, which is always cream, so these are fixed rather than read
// from the theme. starship's success arrow is "bold green", which xterm draws
// in the BRIGHT slot — so brightGreen is green-500, the requested prompt colour,
// and the caret matches.
const PAPER = "#fffcf0"; // --flx-paper (editor page)
const INK = "#100f0f"; // --flx-black (primary ink)
const GREEN_500 = "#768d21"; // Flexoki green-500 — caret + bold ❯ prompt
function buildTheme() {
  return {
    background: PAPER,
    foreground: INK,
    cursor: GREEN_500,
    cursorAccent: PAPER,
    selectionBackground: "rgba(67, 133, 190, 0.28)", // soft Flexoki-blue wash
    black: "#100f0f",
    red: "#af3029", // red-600
    green: "#66800b", // green-600
    yellow: "#ad8301", // yellow-600
    blue: "#205ea6", // blue-600
    magenta: "#a02f6f", // magenta-600
    cyan: "#24837b", // cyan-600
    white: "#cecdc3", // base-200
    brightBlack: "#6f6e69", // base-600
    brightRed: "#d14d41", // red-400
    brightGreen: GREEN_500, // green-500 → the bold ❯ success prompt
    brightYellow: "#d0a215", // yellow-400
    brightBlue: "#4385be", // blue-400
    brightMagenta: "#ce5d97", // magenta-400
    brightCyan: "#3aa99f", // cyan-400
    brightWhite: "#f2f0e5", // base-50
  };
}

interface Session {
  el: HTMLDivElement;
  term: Terminal;
  fit: FitAddon;
  ptyId: string | null;
  opened: boolean;
}

let session: Session | null = null;
// The project root the live shell was started for. `undefined` = never observed (so the very
// first syncRoot call doesn't kill anything); after that a change means a project switch.
let sessionRoot: string | null | undefined = undefined;

function ensure(): Session {
  if (session) return session;

  const el = document.createElement("div");
  el.className = "flux-term-host";
  el.style.cssText = "width:100%;height:100%;";

  const term = new Terminal({
    fontFamily: cssVar("--font-mono", "ui-monospace, Menlo, Consolas, monospace"),
    fontSize: 13,
    lineHeight: 1.15,
    cursorBlink: true,
    cursorStyle: "bar",
    scrollback: 5000,
    theme: buildTheme(),
    macOptionIsMeta: true,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);

  session = { el, term, fit, ptyId: null, opened: false };

  const br = bridge();
  if (!br) {
    setStatus("unavailable");
    return session;
  }

  // Keystrokes → shell.
  term.onData((d) => {
    if (session?.ptyId) br.write(session.ptyId, d);
  });
  // Shell output → terminal (filtered to our session id).
  br.onData((msg) => {
    if (session && msg.id === session.ptyId) term.write(msg.data);
  });
  br.onExit((msg) => {
    if (session && msg.id === session.ptyId) {
      session.ptyId = null;
      termInfo.set(null);
      setStatus("exited");
      const code = typeof msg.exitCode === "number" ? ` · code ${msg.exitCode}` : "";
      term.write(`\r\n\x1b[90m[process exited${code}] — Restart to start a new shell\x1b[0m\r\n`);
    }
  });

  return session;
}

async function start(s: Session): Promise<void> {
  const br = bridge();
  if (!br) {
    setStatus("unavailable");
    return;
  }
  setStatus("connecting");
  // cwd is left to the main process, which opens in the current project root
  // (else home) — it already tracks that via the file-watch root.
  const res = await br.create({ cols: s.term.cols, rows: s.term.rows });
  if (res.ok) {
    s.ptyId = res.id;
    termInfo.set({ shell: res.shell, cwd: res.cwd, pid: res.pid });
    setStatus("running");
    fitNow();
  } else {
    setStatus("exited");
    s.term.write(`\r\n\x1b[31m${res.error}\x1b[0m\r\n`);
  }
}

/** True when the Electron terminal bridge is present (desktop app). */
export function isAvailable(): boolean {
  return !!bridge();
}

/** Mount the persistent terminal host into `container`; spins up a shell on first use. */
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
    if (status === "idle" && bridge()) void start(s);
  });
}

/** Detach the host from the DOM but keep the shell + scrollback alive. */
export function detach(): void {
  session?.el.parentElement?.removeChild(session.el);
}

/** Refit to the host's current size and tell the PTY its new dimensions. */
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

/** Prefill text into the running session's input — NEVER submits (no newline).
 *  The reader's "Ask AI" writes questions here; whatever the user runs in this
 *  terminal (a shell, `flux principal`, …) receives the keystrokes. */
export function prefill(text: string): void {
  const s = session;
  const br = bridge();
  const t = text.replace(/\s+/g, " ").trim();
  if (!s?.ptyId || !br || !t) return;
  br.write(s.ptyId, t + " ");
  s.term.focus();
}

/** Kill any running shell and start a fresh one, clearing the screen. */
export async function restart(): Promise<void> {
  const s = ensure();
  const br = bridge();
  if (!br) {
    setStatus("unavailable");
    return;
  }
  if (s.ptyId) {
    await br.kill(s.ptyId);
    s.ptyId = null;
  }
  s.term.reset();
  await start(s);
  s.term.focus();
}

/** Kill the running shell without starting a new one. */
export async function kill(): Promise<void> {
  const s = session;
  if (!s) return;
  const br = bridge();
  if (s.ptyId && br) await br.kill(s.ptyId);
  s.ptyId = null;
  termInfo.set(null);
  setStatus("exited");
}

/**
 * PAP-17: note the active project root. On a genuine change (not the first observation), kill the
 * shell — it was spawned with the OLD project's cwd, so leaving it alive runs commands in the
 * wrong directory. Reset to "idle" (not "exited") so the next attach() auto-starts a fresh shell
 * in the new project's cwd. The main process derives cwd from the current file-watch root, so a
 * new shell lands in the right place; we only need to retire the stale one.
 */
export async function syncRoot(root: string | null): Promise<void> {
  const prev = sessionRoot;
  sessionRoot = root;
  if (prev === undefined || prev === root) return; // first observation, or same project
  const s = session;
  const br = bridge();
  if (s?.ptyId && br) await br.kill(s.ptyId);
  if (s) {
    s.ptyId = null;
    if (s.opened) s.term.reset();
  }
  termInfo.set(null);
  setStatus("idle");
}
