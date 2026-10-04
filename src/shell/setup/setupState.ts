// "Set up Flux…" (2026-10-03): the one-time window a fresh install opens with — the `flux`
// command on PATH, Quarto, TinyTeX, fluxplot and AI agents — reopenable from Settings and the
// command palette. Main owns detection and the installers (electron/ipc/setup.cjs →
// managedTools.cjs); this module owns the window's state and the actions' bookkeeping.
import { derived, get, writable } from "svelte/store";
import { fileBridge, type SetupStatus, type SetupTaskResult } from "../../lib/project/types";
import { setShellPanel } from "../agent/annotationVisibility";

export type SetupTask = "quarto" | "tinytex";

export const setupOpen = writable(false);
export const setupStatus = writable<SetupStatus | null>(null);
/** Live progress: quarto as a 0–1 fraction + phase, tinytex as its latest log line. */
export const setupProgress = writable<{ quarto?: { phase: string; fraction: number }; tinytex?: { line: string } }>({});
export const setupRunning = writable<ReadonlySet<SetupTask | "terminal">>(new Set());
export const setupErrors = writable<Partial<Record<SetupTask | "terminal", string>>>({});
/** Word export and the export dialog follow this instead of a one-shot probe. */
export const quartoReady = derived(setupStatus, (s) => !!s?.quarto.installed);

setupOpen.subscribe((open) => setShellPanel("setup", open));

let unsubscribeProgress: (() => void) | null = null;
function listen(): void {
  const fb = fileBridge();
  if (unsubscribeProgress || !fb?.onSetupProgress) return;
  unsubscribeProgress = fb.onSetupProgress((p) => {
    if (p.task === "quarto") setupProgress.update((s) => ({ ...s, quarto: { phase: p.phase, fraction: p.total ? Math.min(1, p.done / p.total) : 0 } }));
    else setupProgress.update((s) => ({ ...s, tinytex: { line: p.line } }));
  });
}

export async function refreshSetup(): Promise<SetupStatus | null> {
  const fb = fileBridge();
  if (!fb?.setupStatus) return null;
  try {
    const s = await fb.setupStatus();
    setupStatus.set(s);
    return s;
  } catch {
    return null;
  }
}

export function openSetup(): void {
  listen();
  setupOpen.set(true);
  void refreshSetup();
}

/** Closing marks the window as seen, so it never opens on its own again. */
export function closeSetup(): void {
  setupOpen.set(false);
  void fileBridge()?.prefsSet?.({ onboardingCompleted: true }).catch(() => {});
}

/** Startup: open on the installed app's first launch only. */
export async function maybeOpenSetupOnFirstRun(): Promise<void> {
  const s = await refreshSetup();
  if (s?.firstRun) openSetup();
}

function setRunning(task: SetupTask | "terminal", on: boolean): void {
  setupRunning.update((s) => {
    const next = new Set(s);
    if (on) next.add(task); else next.delete(task);
    return next;
  });
}
function setError(task: SetupTask | "terminal", message: string): void {
  setupErrors.update((e) => ({ ...e, [task]: message || undefined }));
}

async function runTask(task: SetupTask, call: () => Promise<SetupTaskResult> | undefined): Promise<boolean> {
  if (get(setupRunning).has(task)) return false;
  listen();
  setRunning(task, true);
  setError(task, "");
  setupProgress.update((s) => ({ ...s, [task]: undefined }));
  try {
    const r = await call();
    if (!r) { setError(task, "Not available here"); return false; }
    if (!r.ok && !r.cancelled) setError(task, r.error || "Failed");
    return r.ok;
  } catch (e) {
    setError(task, e instanceof Error ? e.message : String(e));
    return false;
  } finally {
    setRunning(task, false);
    setupProgress.update((s) => ({ ...s, [task]: undefined }));
    await refreshSetup();
  }
}

export const installQuarto = () => runTask("quarto", () => fileBridge()?.setupInstallQuarto?.());
export const installTinytex = () => runTask("tinytex", () => fileBridge()?.setupInstallTinytex?.());
export const cancelSetupTask = (task: SetupTask) => void fileBridge()?.setupCancel?.(task);

export async function addFluxToTerminal(): Promise<void> {
  if (get(setupRunning).has("terminal")) return;
  setRunning("terminal", true);
  setError("terminal", "");
  try {
    await fileBridge()?.setupAddToTerminal?.();
  } catch (e) {
    setError("terminal", e instanceof Error ? e.message : String(e));
  } finally {
    setRunning("terminal", false);
    await refreshSetup();
  }
}
