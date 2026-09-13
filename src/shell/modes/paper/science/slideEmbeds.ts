import { StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import { scanSlideEmbeds, serializeSlideEmbed, parseSlideEmbed, embedKey, type SlideEmbedRef } from "../../../../lib/slide/embed";
import type { SlideRepository, SlideSnapshot } from "../../../../lib/slide/embedRepository";
import { mountSlideEmbed, SLIDE_EMBED_CSS, type EmbedPlaybackState, type SlideEmbedPlayer } from "../../../../lib/slide/embedPlayer";
import { touchesMe } from "./changeGate";

export const resetSlidePlayback = StateEffect.define<null>();
interface Entry { from: number; to: number; ref: SlideEmbedRef; playback: { value?: EmbedPlaybackState; ratio?: number }; duplicate: boolean }
interface Mount { key: string; update(entry: Entry): void; destroy(): void }
const mounts = new WeakMap<HTMLElement, Mount>();
export function slideEmbeds(repository: SlideRepository, onOpen: (r: SlideEmbedRef) => void, onReplace: (el: HTMLElement, r: SlideEmbedRef) => void): Extension {
  class SlideWidget extends WidgetType {
    constructor(readonly entry: Entry) { super(); }
    get estimatedHeight() {
      const width = this.entry.ref.width, value = parseFloat(width ?? "100%");
      const w = width?.endsWith("%") || !width ? 604 * value / 100 : Math.min(604, value * (width.endsWith("in") ? 96 : width.endsWith("cm") ? 96 / 2.54 : width.endsWith("mm") ? 96 / 25.4 : width.endsWith("pt") ? 96 / 72 : 1));
      return w / (this.entry.playback.ratio ?? 16 / 9) + 90 + (this.entry.ref.caption ? Math.ceil(this.entry.ref.caption.length / Math.max(15, w / 8)) * 24 : 0);
    }
    eq(other: SlideWidget) { return this.entry.playback === other.entry.playback && JSON.stringify(this.entry.ref) === JSON.stringify(other.entry.ref) && this.entry.duplicate === other.entry.duplicate; }
    toDOM(view: EditorView) {
      let current = this.entry, alive = true, visible = false, version = 0, controller: SlideEmbedPlayer | undefined, snapshot: SlideSnapshot | undefined;
      const wrap = document.createElement("div"); wrap.className = "flux-slide-embed"; wrap.contentEditable = "false";
      const style = document.createElement("style"); style.textContent = SLIDE_EMBED_CSS; wrap.append(style);
      const content = document.createElement("div"); content.style.aspectRatio = String(current.playback.ratio ?? 16 / 9); wrap.append(content);
      const caption = document.createElement("div"); caption.className = "flux-slide-caption"; wrap.append(caption);
      const sizes = document.createElement("div"); sizes.className = "flux-slide-sizes";
      const setWidth = (width: string | null) => {
        const pos = view.posAtDOM(wrap), line = view.state.doc.lineAt(pos);
        const ref = parseSlideEmbed(line.text);
        if (ref) view.dispatch({ changes: { from: line.from, to: line.to, insert: serializeSlideEmbed({ ...ref, width }) }, userEvent: "input.slidewidth" });
      };
      for (const value of ["50%", "75%", "100%", null]) { const b = document.createElement("button"); b.type = "button"; b.textContent = value ?? "Auto"; b.title = `Slide width ${value ?? "Auto"}`; b.onclick = () => setWidth(value); sizes.append(b); }
      const replace = document.createElement("button"); replace.type = "button"; replace.textContent = "Replace…"; replace.title = "Choose replacement slide"; replace.onclick = () => onReplace(wrap, current.ref); sizes.append(replace); wrap.append(sizes);
      const grip = document.createElement("div"); grip.className = "flux-slide-grip"; grip.title = "Drag to resize slide"; wrap.append(grip);
      let cancelDrag: (() => void) | undefined;
      grip.onpointerdown = e => {
        e.preventDefault(); e.stopPropagation(); grip.setPointerCapture(e.pointerId);
        const col = view.contentDOM.getBoundingClientRect(), center = col.left + col.width / 2;
        let pct = Math.round(wrap.getBoundingClientRect().width * 100 / col.width), moved = false;
        const move = (ev: PointerEvent) => { moved = true; pct = Math.max(10, Math.min(100, Math.round((ev.clientX - center) * 200 / col.width))); wrap.style.width = `${pct}%`; view.requestMeasure(); };
        const clear = () => { grip.removeEventListener("pointermove", move); grip.removeEventListener("pointerup", up); grip.removeEventListener("pointercancel", cancel); cancelDrag = undefined; };
        const up = () => { clear(); if (moved) setWidth(`${pct}%`); };
        const cancel = () => { clear(); update(current); };
        cancelDrag = cancel; grip.addEventListener("pointermove", move); grip.addEventListener("pointerup", up); grip.addEventListener("pointercancel", cancel);
      };
      const update = (entry: Entry) => {
        current = entry;
        const width = current.ref.width;
        wrap.style.width = width ? /^\d+(\.\d+)?$/.test(width) ? `${width}px` : width : snapshot ? `${snapshot.payload.deck.stage.width}px` : "100%";
        caption.textContent = `${current.duplicate ? "Duplicate slide anchor. " : ""}${current.ref.caption}`;
        view.requestMeasure();
      };
      const mount = () => {
        if (!snapshot || !visible || !alive || controller) return;
        content.style.aspectRatio = "";
        controller = mountSlideEmbed(content, snapshot.payload, { state: current.playback.value, onState: value => { current.playback.value = value; }, onOpen: () => onOpen(current.ref), onEscape: () => view.focus() });
        view.requestMeasure();
      };
      const load = async () => {
        const ticket = ++version;
        try {
          const next = await repository.load(current.ref);
          if (!alive || ticket !== version) return;
          if (next !== snapshot) { controller?.pauseOffscreen(); controller?.destroy(); controller = undefined; snapshot = next; current.playback.ratio = next.payload.deck.stage.width / next.payload.deck.stage.height; }
          const poster = document.createElement("img"); poster.alt = current.ref.caption || "Slide preview"; poster.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(next.poster)}`; poster.style.cssText = "display:block;width:100%;height:auto";
          if (!controller) content.replaceChildren(poster);
          update(current); mount();
          if (next.warnings.length) content.title = next.warnings.join("\n");
          view.requestMeasure();
        } catch (e) {
          if (!alive || ticket !== version) return;
          controller?.destroy(); controller = undefined; snapshot = undefined;
          const error = document.createElement("div"); error.className = "flux-slide-error"; error.textContent = `Slide unavailable: ${e instanceof Error ? e.message : String(e)}`;
          content.replaceChildren(error); view.requestMeasure();
        }
      };
      const off = repository.subscribe(() => { void load(); });
      const observer = new IntersectionObserver(entries => {
        visible = entries[0]?.isIntersecting ?? false;
        if (visible) { if (snapshot) mount(); else void load(); }
        else if (controller) { controller.pauseOffscreen(); controller.destroy(); controller = undefined; if (snapshot) { const img = document.createElement("img"); img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(snapshot.poster)}`; img.style.width = "100%"; content.append(img); } }
      }, { root: view.scrollDOM, rootMargin: "200px" });
      observer.observe(wrap); update(current);
      mounts.set(wrap, { key: embedKey(current.ref), update, destroy() { alive = false; version++; cancelDrag?.(); observer.disconnect(); off(); controller?.destroy(); } });
      return wrap;
    }
    updateDOM(dom: HTMLElement) { const found = mounts.get(dom); if (!found || found.key !== embedKey(this.entry.ref)) return false; found.update(this.entry); return true; }
    destroy(dom: HTMLElement) { mounts.get(dom)?.destroy(); mounts.delete(dom); }
    ignoreEvent() { return true; }
  }
  function build(text: string, previous: Entry[] = []): { decorations: DecorationSet; entries: Entry[] } {
    const seen = new Set<string>();
    const entries = scanSlideEmbeds(text).map(span => {
      const old = previous.find(e => e.from === span.from && embedKey(e.ref) === embedKey(span.ref));
      const duplicate = seen.has(span.ref.id); seen.add(span.ref.id);
      return { ...span, playback: old?.playback ?? {}, duplicate };
    });
    const marks = entries.flatMap(e => [Decoration.line({ class: "cm-flux-embedsrc" }).range(e.from), Decoration.widget({ widget: new SlideWidget(e), block: true, side: 1 }).range(e.to)]);
    return { decorations: Decoration.set(marks, true), entries };
  }
  return StateField.define<{ decorations: DecorationSet; entries: Entry[] }>({
    create: state => build(state.doc.toString()),
    update(value, tr) {
      if (tr.effects.some(e => e.is(resetSlidePlayback))) return build(tr.newDoc.toString());
      if (!tr.docChanged) return value;
      const mapped = value.entries.map(e => ({ ...e, from: tr.changes.mapPos(e.from, 1), to: tr.changes.mapPos(e.to, -1) }));
      if (touchesMe(tr, value.decorations, { tokens: [".flux-slide", "```", "~~~", "<!--", "-->", "$$", "---", "\\[", "\\]"] })) return build(tr.newDoc.toString(), mapped);
      return { decorations: value.decorations.map(tr.changes), entries: mapped };
    },
    provide: field => EditorView.decorations.from(field, value => value.decorations),
  });
}
