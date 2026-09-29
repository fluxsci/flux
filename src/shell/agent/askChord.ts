// The tiny input bootstrap is synchronous. Answer rendering and runner IO stay
// in the lazy surface, so a cold chunk or slow capture cannot steal typing.
import { get, writable } from "svelte/store";
import { currentProject, view } from "../shellStore";
import { pushToast } from "../../lib/toast";
import { captureAnnotationView, closeAnnotation } from "./annotateChord";
import { annotationOpen, askOpen } from "./annotationVisibility";
import { anchorPanel, unionRects, type Rect } from "../../lib/ui/anchor";
import type { TargetRef } from "../../lib/project/targets";
import type { AnnotationRequest } from "./annotateChord";
export { askOpen } from "./annotationVisibility";
export interface AskRequest extends AnnotationRequest {
  root: string; avoid: Rect | null; input: HTMLTextAreaElement; bootstrap: HTMLDivElement;
  typed: boolean; submitPending: boolean; onInput?: () => void; onSubmit?: () => void; onClose?: () => void;
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
  const bootstrap = document.createElement("div"); bootstrap.className = "ask-bootstrap-layer";
  const panel = document.createElement("div"); panel.className = "ask-bootstrap";
  bootstrap.dataset.askSurface = "";
  bootstrap.setAttribute("role", "dialog"); bootstrap.setAttribute("aria-label", "Ask about this");
  const label = document.createElement("div"); label.textContent = "Ask about this · read-only";
  const input = document.createElement("textarea"); input.setAttribute("aria-label", "Ask a question"); input.placeholder = "Ask about this…"; input.rows = 2;
  const at = anchorPanel({ avoid, size: { w: Math.min(440, window.innerWidth - 16), h: 120 }, viewport: { w: window.innerWidth, h: window.innerHeight } });
  panel.style.left = `${at.x}px`; panel.style.top = `${at.y}px`;
  panel.append(label, input); bootstrap.append(panel);
  const request: AskRequest = { ...capture, root: project.path, avoid, input, bootstrap, typed: false, submitPending: false };
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
