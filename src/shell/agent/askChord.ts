// The tiny input bootstrap is synchronous. Answer rendering and runner IO stay
// in the lazy surface, so a cold chunk or slow capture cannot steal typing.
// The bootstrap is built with the SAME skeleton the lazy surface renders
// (surface header + composer, the global .surface-head / .flux-composer
// vocabulary in app.css), and the surface adopts its exact position, so the
// handover never moves a pixel under the user's hands.
import { get, writable } from "svelte/store";
import { currentProject, view } from "../shellStore";
import { pushToast } from "../../lib/toast";
import { captureAnnotationView, closeAnnotation } from "./annotateChord";
import { annotationOpen, askOpen } from "./annotationVisibility";
import { anchorPanel, unionRects, type Rect, type AnchorResult } from "../../lib/ui/anchor";
import { targetPrompt, type TargetRef } from "../../lib/project/targets";
import type { AnnotationRequest } from "./annotateChord";
export { askOpen } from "./annotationVisibility";
/** The panel's planned footprint: the lazy surface keeps this width and this top edge. */
export const ASK_WIDTH = 480;
const BOOTSTRAP_HEIGHT = 150;
export interface AskRequest extends AnnotationRequest {
  root: string; avoid: Rect | null; at: AnchorResult; input: HTMLTextAreaElement; bootstrap: HTMLDivElement;
  typed: boolean; submitPending: boolean; onInput?: () => void; onSubmit?: () => void; onClose?: () => void;
  /** Escape while a run is busy stops it instead of discarding the exchange; returns true when handled. */
  onEscape?: () => boolean;
}
export const askRequest = writable<AskRequest | null>(null);
let previousFocus: HTMLElement | null = null, previousWindow: Window | null = null;
export function isAskChord(e: KeyboardEvent): boolean {
  return (e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.code === "KeyJ";
}
export function closeAsk(): void {
  const req = get(askRequest);
  askOpen.set(false); askRequest.set(null);
  req?.onClose?.(); req?.bootstrap.remove(); req?.input.remove();
  try { if (previousFocus?.isConnected) { previousWindow?.focus(); previousFocus.focus({ preventScroll: true }); } } catch { /* closed utility */ }
}
/** Escape: a busy run stops first; an idle Ask closes. */
export function escapeAsk(): void {
  const req = get(askRequest);
  if (req?.onEscape?.()) return;
  closeAsk();
}
export function requestAsk(opts: { targets?: TargetRef[]; utility?: { name: string; window: Window } } = {}): void {
  const project = get(currentProject);
  if (get(view) === "home" || !project?.path) { pushToast("info", "Open a project to ask about it"); return; }
  if (get(askOpen)) { closeAsk(); return; }
  if (get(annotationOpen)) closeAnnotation();
  const win = opts.utility?.window ?? window, doc = win.document;
  previousWindow = win; previousFocus = doc.activeElement as HTMLElement | null;
  const capture = captureAnnotationView(opts);
  const rects: Rect[] = [];
  const add = (r: DOMRect) => { if (r.width || r.height) rects.push({ x: r.x, y: r.y, w: r.width, h: r.height }); };
  const selection = doc.getSelection();
  if (selection?.rangeCount) add(selection.getRangeAt(0).getBoundingClientRect());
  if (!rects.length) for (const node of doc.querySelectorAll('.canvas-host .sel-box, .cm-cursor')) add(node.getBoundingClientRect());
  const avoid = opts.utility ? null : unionRects(rects);
  const targets = capture.stamp.targets ?? [];
  const bootstrap = document.createElement("div"); bootstrap.className = "ask-bootstrap-layer";
  const panel = document.createElement("div"); panel.className = "ask-bootstrap agent-surface";
  bootstrap.dataset.askSurface = "";
  bootstrap.setAttribute("role", "dialog"); bootstrap.setAttribute("aria-label", "Ask about this");
  const head = document.createElement("div"); head.className = "surface-head";
  const ttl = document.createElement("span"); ttl.className = "ttl"; ttl.textContent = "Ask";
  const sep = document.createElement("span"); sep.className = "vsep";
  const ctx = document.createElement("span"); ctx.className = "ctx"; ctx.textContent = targets.length ? targetPrompt(targets, "About").replace(/…$/, "") : "about this view";
  head.append(ttl, sep, ctx);
  const body = document.createElement("div"); body.className = "ask-body";
  const composer = document.createElement("div"); composer.className = "flux-composer";
  const input = document.createElement("textarea"); input.setAttribute("aria-label", "Ask a question"); input.placeholder = targetPrompt(targets); input.rows = 2;
  const bar = document.createElement("div"); bar.className = "composer-bar";
  const hint = document.createElement("span"); hint.className = "hint"; hint.textContent = "Enter sends · Shift+Enter newline";
  bar.append(hint); composer.append(input, bar); body.append(composer);
  const w = Math.min(ASK_WIDTH, window.innerWidth - 16);
  const at = anchorPanel({ avoid, size: { w, h: BOOTSTRAP_HEIGHT }, viewport: { w: window.innerWidth, h: window.innerHeight } });
  panel.style.left = `${at.x}px`; panel.style.top = `${at.y}px`; panel.style.width = `${w}px`;
  panel.append(head, body); bootstrap.append(panel);
  const request: AskRequest = { ...capture, root: project.path, avoid, at, input, bootstrap, typed: false, submitPending: false };
  input.addEventListener("input", () => { if (!request.typed) { request.typed = true; request.onInput?.(); } });
  input.addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault(); e.stopPropagation();
      if (request.onSubmit) request.onSubmit(); else request.submitPending = true;
    }
  });
  (document.fullscreenElement ?? document.querySelector(".present") ?? document.body).append(bootstrap);
  askRequest.set(request); askOpen.set(true);
  if (opts.utility) window.focus();
  input.focus({ preventScroll: true });
}
