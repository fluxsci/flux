// Cross-surface review navigation uses the existing mode loading handshakes.
import type { ContextStamp } from "../lib/project/annotations";
import { get } from "svelte/store";
import { setFocusedMode, panes, focusedMode, focusPane } from "./paneStore";
import type { ModeId } from "./shellStore";
import { requestOpenDoc, requestOpenSlide, openFigureRequest, openLibraryRequest } from "./command/commandBus";

function focusMode(mode: ModeId) {
  if (get(focusedMode) === mode) return;
  const open = get(panes);
  const existing = open.find(p => p.mode === mode);
  const editor = mode === "figure" || mode === "slide" ? open.find(p => p.mode === "figure" || p.mode === "slide") : undefined;
  if (existing || editor) focusPane((existing ?? editor)!.id);
  setFocusedMode(mode);
}

export async function navigateToStamp(stamp: ContextStamp): Promise<void> {
  const targets = stamp.targets ?? [];
  const doc = targets.find(t => t.kind === "doc") ?? stamp.doc;
  const slide = targets.find(t => t.kind === "slide" || t.kind === "beat" || t.kind === "track");
  const deck = stamp.slide ?? stamp.present;
  const figure = targets.find(t => "figureId" in t);
  const passage = targets.find(t => t.kind === "passage") ?? stamp.reader;
  if (doc && (stamp.surface === "paper" || !figure && !slide && !passage)) {
    requestOpenDoc(doc.path, doc); focusMode("paper");
  } else if (slide || deck) {
    requestOpenSlide(slide?.deckId ?? deck!.deckId, slide?.slideId ?? deck?.slideId, {
      slideIndex: deck?.slideIndex, beat: slide && "beat" in slide ? slide.beat : deck?.beat,
      trackId: slide?.kind === "track" ? slide.trackId : undefined,
    });
    focusMode("slide");
  } else if (figure || stamp.activeFigureId) {
    const figureId = figure?.figureId ?? stamp.activeFigureId!;
    const elements = targets.flatMap(t => "elementId" in t && "figureId" in t && t.figureId === figureId ? [t.elementId] : []);
    const parts = targets.flatMap(t => t.kind === "part" && t.figureId === figureId ? [{ elementId: t.elementId, partId: t.partId }] : []);
    openFigureRequest.set({ figureId, elements: elements.length ? elements : stamp.selection ?? [], parts: parts.length ? parts : stamp.partSelection ? [stamp.partSelection] : [] });
    focusMode("figure");
  } else if (passage) {
    const { openInReader } = await import("./modes/reader/readerStore");
    focusMode("reader");
    openInReader(passage.citekey, { page: passage.page });
  } else if (stamp.surface === "library" || targets.some(t => t.kind === "library-item")) {
    const keys = targets.flatMap(t => t.kind === "library-item" ? [t.citekey] : []);
    openLibraryRequest.set({ ...stamp.library, ...(keys.length ? { selectedKeys: keys, query: keys[0] } : {}) });
    focusMode("library");
  } else if (["figure", "paper", "slide", "reader"].includes(stamp.surface)) {
    focusMode(stamp.surface as "figure" | "paper" | "slide" | "reader");
  } else throw new Error("This item has no saved destination");
}
