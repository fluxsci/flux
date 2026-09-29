// One app/annotation stamp. Modes publish cheap state or register readers here;
// no mode imports (in particular no CodeMirror or slide engine at Home).
import { get, writable } from "svelte/store";
import { project, selection, partSelection, activeFigureId, selectedFrameId, activeCanvasId, viewport, embeddedProjectRoot } from "../store";
import { currentProject, view } from "../../shell/shellStore";
import { focusedMode } from "../../shell/paneStore";
import { storeTenant } from "../tenancy";
import { hasFlushOwner } from "../../shell/lifecycle";
import { paperSelection } from "../project/paperSelectionStore";
import type { ContextStamp } from "../project/annotations";
import { currentTargets } from "./targetResolvers";
import { uniqueTargets, type TargetRef } from "../project/targets";

export const readerContext = writable<ContextStamp["reader"]>(null);
export const libraryContext = writable<ContextStamp["library"]>(null);
export const slideContext = writable<ContextStamp["slide"]>(null);
export const presentContext = writable<ContextStamp["present"]>(null);
export const paperHeading = writable<string | undefined>(undefined);

export function figureContextRelevant(surface = get(focusedMode)): boolean {
  return get(view) === "workspace" && get(embeddedProjectRoot) === get(currentProject)?.path &&
    (surface === "figure" || surface === "slide") && storeTenant() === surface && hasFlushOwner(surface);
}
export function buildContextStamp(opts: { window?: ContextStamp["window"]; targets?: TargetRef[]; document?: Document } = {}): ContextStamp {
  const presenting = get(presentContext);
  const surface = get(view) === "home" ? "home" : presenting ? "present" : get(focusedMode);
  const stamp: ContextStamp = { surface, window: opts.window ?? { kind: "main" }, targets: [] };
  if (figureContextRelevant() && (surface === "figure" || surface === "slide")) {
    const p = get(project), id = get(activeFigureId), fig = p.figures.find(f => f.id === id), sel = get(selection);
    Object.assign(stamp, {
      activeFigureId: id, activeFigureName: fig?.nickname || fig?.name || null,
      activeCanvasId: get(activeCanvasId), selectedFrameId: get(selectedFrameId), selection: [...sel],
      selectionSummary: p.figures.flatMap(f => f.elements.filter(e => sel.has(e.id))).slice(0, 20).map(e => ({ id: e.id, type: e.type, name: e.name })),
      partSelection: get(partSelection), viewport: { ...get(viewport) },
    });
    if (surface === "slide") stamp.slide = get(slideContext);
  }
  if (surface === "paper") {
    const p = get(paperSelection);
    stamp.doc = p ? { path: p.doc, from: p.from, to: p.to, quote: p.quote, heading: get(paperHeading) } : null;
  }
  if (surface === "reader") stamp.reader = get(readerContext);
  if (surface === "library") stamp.library = get(libraryContext);
  if (presenting) stamp.present = presenting;
  const targets = opts.targets ? [...opts.targets] : currentTargets(surface, opts.document);
  if (!targets.length) {
    if (stamp.doc) targets.push({ kind: "doc", ...stamp.doc });
    if (stamp.reader?.citekey) targets.push({ kind: "passage", citekey: stamp.reader.citekey, page: stamp.reader.page ?? 1, quote: stamp.reader.selection, highlightId: stamp.reader.highlightId, title: stamp.reader.title });
    for (const citekey of stamp.library?.selectedKeys ?? []) targets.push({ kind: "library-item", citekey });
    if (presenting?.slideId) targets.push({ kind: "beat", deckId: presenting.deckId, slideId: presenting.slideId, beat: presenting.beat });
  }
  const docTarget = targets.find(t => t.kind === "doc");
  if (surface === "paper" && docTarget?.kind === "doc") stamp.doc = { path: docTarget.path, from: docTarget.from, to: docTarget.to, quote: docTarget.quote ?? "", heading: docTarget.heading };
  stamp.targets = uniqueTargets(targets);
  return stamp;
}
