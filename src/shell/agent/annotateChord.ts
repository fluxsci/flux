// Installed before Shell mounts children: this listener owns the chord even
// when a modal uses capture listeners, or a lazy composer has not mounted yet.
import { get, writable } from "svelte/store";
import { currentProject, view } from "../shellStore";
import { fileBridge } from "../../lib/project/types";
import { pushToast } from "../../lib/toast";
import { prepareTargetResolvers, targetViewIdentity } from "../../lib/bridge/targetResolvers";
import { buildContextStamp } from "../../lib/bridge/contextStamp";
import type { ContextStamp } from "../../lib/project/annotations";
import type { TargetRef } from "../../lib/project/targets";

import { annotationOpen, isAnnotateChord } from "./annotationVisibility";
export { annotationOpen, isAnnotateChord, yieldsToShellModal } from "./annotationVisibility";
export interface AnnotationRequest {
  stamp: ContextStamp;
  shot: Promise<{ png: Uint8Array; width: number; height: number } | null>;
  document: Document;
  size: { w: number; h: number; dpr: number };
  generation: number;
  identity: unknown[];
}
export const annotationRequest = writable<AnnotationRequest | null>(null);
let generation = 0;
let buffer = "";
let cancelledBuffer = "";
let submitBuffered = false;
let inputReady = false;
let originalFocus: HTMLElement | null = null;
let originalWindow: Window | null = null;
export function closeAnnotation(): void {
  annotationOpen.set(false);
  cancelledBuffer += buffer;
  buffer = ""; submitBuffered = false; inputReady = false;
  try { if (originalFocus?.isConnected) { originalWindow?.focus(); originalFocus.focus({ preventScroll: true }); } } catch { /* closed utility */ }
}
export function requestAnnotation(opts: { targets?: TargetRef[]; utility?: { name: string; window: Window } } = {}): void {
  if (get(view) === "home" || !get(currentProject)) { pushToast("info", "Open a project to annotate"); return; }
  if (get(annotationOpen)) { closeAnnotation(); return; }
  buffer = ""; submitBuffered = false; inputReady = false;
  const win = opts.utility?.window ?? window;
  originalWindow = win;
  const focused = win.document.activeElement as HTMLElement | null;
  originalFocus = typeof focused?.focus === "function" ? focused : null;
  prepareTargetResolvers();
  const stamp = buildContextStamp({ targets: opts.targets, document: win.document,
    window: opts.utility ? { kind: "utility", name: opts.utility.name } : { kind: "main" } });
  // Start capture BEFORE any overlay paints. The promise has a rejection handler
  // immediately, including while the lazy module is still loading.
  const shot = fileBridge()?.captureWindow?.({ target: opts.utility ? "child" : "sender" }).catch(() => null) ?? Promise.resolve(null);
  annotationRequest.set({ stamp, shot, document: win.document, identity: targetViewIdentity(win.document),
    size: { w: win.innerWidth, h: win.innerHeight, dpr: win.devicePixelRatio || 1 }, generation: ++generation });
  annotationOpen.set(true);
}
export function bufferAnnotationInput(): void { inputReady = false; }
export function focusAnnotationInput(input: HTMLTextAreaElement): { text: string; submit: boolean } {
  input.focus({ preventScroll: true });
  inputReady = input.ownerDocument.activeElement === input;
  const result = { text: cancelledBuffer + buffer, submit: submitBuffered };
  cancelledBuffer = "";
  buffer = ""; submitBuffered = false;
  return result;
}
export function discardAnnotationBuffer(): void { cancelledBuffer = ""; buffer = ""; submitBuffered = false; }
export function installAnnotateChord(): () => void {
  function key(e: KeyboardEvent) {
    if (isAnnotateChord(e)) {
      e.preventDefault(); e.stopImmediatePropagation();
      if (!e.repeat) requestAnnotation();
      return;
    }
    // Retired chord: absorb browser Save As as well as old editor save branches.
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.code === "KeyS") {
      e.preventDefault(); e.stopImmediatePropagation(); return;
    }
    if (!get(annotationOpen) || inputReady) return;
    if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); closeAnnotation(); return; }
    if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
    if (e.key.length === 1) buffer += e.key;
    else if (e.key === "Backspace") buffer = [...buffer].slice(0, -1).join("");
    else if (e.key === "Enter") { if (e.shiftKey) buffer += "\n"; else submitBuffered = true; }
    else return;
    e.preventDefault(); e.stopImmediatePropagation();
  }
  const shield = (e: Event) => { if (get(annotationOpen) && !inputReady) { e.preventDefault(); e.stopImmediatePropagation(); } };
  window.addEventListener("keydown", key, true);
  window.addEventListener("pointerdown", shield, true);
  window.addEventListener("wheel", shield, { capture: true, passive: false });
  return () => { window.removeEventListener("keydown", key, true); window.removeEventListener("pointerdown", shield, true); window.removeEventListener("wheel", shield, true); };
}
