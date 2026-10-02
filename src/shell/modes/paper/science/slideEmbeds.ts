import { StateEffect, StateField, type EditorState, type Extension, type Range } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { scanSlideEmbeds, serializeSlideEmbed, parseSlideEmbed, embedKey, type SlideEmbedRef } from "../../../../lib/slide/embed";
import type { SlideRepository, SlideSnapshot } from "../../../../lib/slide/embedRepository";
import { mountSlideEmbed, SLIDE_EMBED_CSS, type EmbedPlaybackState, type SlideEmbedPlayer } from "../../../../lib/slide/embedPlayer";
import { touchesMe, paperPerf } from "./changeGate";
import { SlideSrcWidget } from "./widgets";
import { chipActivation } from "./chipActivation";
import { createSlideChipCatalog, slideChipLabel, type SlideChipCatalog } from "./slideChipCatalog";

export const resetSlidePlayback = StateEffect.define<null>();
/** The chip catalog settled a deck read: re-derive the source-line chips. */
const refreshSlideChips = StateEffect.define<null>();
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
      let current = this.entry, alive = true, visible = false, version = 0, mounting = false, controller: SlideEmbedPlayer | undefined, snapshot: SlideSnapshot | undefined;
      const wrap = document.createElement("div"); wrap.className = "flux-slide-embed"; wrap.contentEditable = "false";
      const style = document.createElement("style"); style.textContent = SLIDE_EMBED_CSS; wrap.append(style);
      const content = document.createElement("div"); content.style.aspectRatio = String(current.playback.ratio ?? 16 / 9); wrap.append(content);
      // A live 3D embed that cannot start keeps its still and SAYS so here
      // (the reason is the tooltip) — never only a hover title on the art.
      const status = document.createElement("div"); status.className = "flux-slide-status"; status.setAttribute("role", "status"); status.hidden = true; wrap.append(status);
      const setStatus = (text = "", detail = "") => { status.textContent = text; status.title = detail; status.hidden = !text; };
      const still = (svg: string) => { const img = document.createElement("img"); img.alt = current.ref.caption || "Slide preview"; img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`; img.style.cssText = "display:block;width:100%;height:auto"; return img; };
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
      const mount = async () => {
        if (!snapshot || !visible || !alive || controller || mounting) return;
        const captured = snapshot, ticket = version; mounting = true;
        let model3d: import('../../../../lib/model3d/host').Model3dHost | undefined;
        try {
          if (captured.modelSource) {
            const { createEmbedServiceHost } = await import('../../../../lib/slide/embedServiceHost');
            if (!alive || !visible || ticket !== version || snapshot !== captured) return;
            model3d = createEmbedServiceHost(captured);
          }
          if (!alive || !visible || ticket !== version || snapshot !== captured) { model3d?.dispose(); return; }
          content.style.aspectRatio = "";
          controller = mountSlideEmbed(content, captured.payload, { model3d, state: current.playback.value, onState: value => { current.playback.value = value; }, onOpen: () => onOpen(current.ref), onEscape: () => view.focus() });
          if (model3d) content.dataset.model3dHost = 'service';
          setStatus();
          view.requestMeasure();
        } catch (error) {
          model3d?.dispose();
          if (alive && ticket === version) {
            // mountSlideEmbed may have cleared the art before failing: restore the still it promises.
            if (!controller) { content.style.aspectRatio = String(current.playback.ratio ?? 16 / 9); content.replaceChildren(still(captured.poster)); }
            setStatus(captured.modelSource ? "3D preview unavailable — showing a still" : "Live preview unavailable — showing a still", error instanceof Error ? error.message : String(error));
            view.requestMeasure();
          }
        } finally { mounting = false; if (alive && visible && snapshot !== captured) void mount(); }
      };
      const load = async () => {
        const ticket = ++version;
        try {
          const next = await repository.load(current.ref);
          if (!alive || ticket !== version) return;
          if (next !== snapshot) { controller?.pauseOffscreen(); controller?.destroy(); controller = undefined; snapshot = next; current.playback.ratio = next.payload.deck.stage.width / next.payload.deck.stage.height; }
          if (!controller) content.replaceChildren(still(next.poster));
          update(current); void mount();
          if (next.warnings.length) content.title = next.warnings.join("\n");
          view.requestMeasure();
        } catch (e) {
          if (!alive || ticket !== version) return;
          controller?.destroy(); controller = undefined; snapshot = undefined; setStatus();
          const error = document.createElement("div"); error.className = "flux-slide-error"; error.textContent = `Slide unavailable: ${e instanceof Error ? e.message : String(e)}`;
          content.replaceChildren(error); view.requestMeasure();
        }
      };
      const off = repository.subscribe(() => { void load(); });
      const observer = new IntersectionObserver(entries => {
        visible = entries[0]?.isIntersecting ?? false;
        if (visible) { if (snapshot) void mount(); else void load(); }
        else if (controller) { controller.pauseOffscreen(); controller.destroy(); controller = undefined; if (snapshot) { const img = document.createElement("img"); img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(snapshot.poster)}`; img.style.width = "100%"; content.append(img); } }
      }, { root: view.scrollDOM, rootMargin: "200px" });
      observer.observe(wrap); update(current);
      // CodeMirror measures a block widget by its border box, so the shared
      // stylesheet's `margin:16px auto` was invisible to the height map: every
      // slide shifted the map 32px against the DOM below it, and ArrowDown
      // skipped lines under an embedded slide. A flow-root host contains those
      // margins in its own box (export keeps the stylesheet unchanged).
      const host = document.createElement("div"); host.className = "flux-slide-embed-host"; host.style.display = "flow-root"; host.append(wrap);
      mounts.set(host, { key: embedKey(current.ref), update, destroy() { alive = false; version++; cancelDrag?.(); observer.disconnect(); off(); controller?.destroy(); } });
      return host;
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
  const field = StateField.define<{ decorations: DecorationSet; entries: Entry[] }>({
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
  // The SOURCE line folds to a `▷ Deck 3 · Slide 4` chip unless a selection
  // touches it — the figure-chip rule (chips.ts): an inline atomic replace of
  // the line's content (indent kept), so the line stays and vertical motion
  // still costs one keypress, and the block field above stays doc-pure (it is
  // never rebuilt for the selection). Its entries are the one scan, so the
  // chip folds exactly the lines that carry a player. Caret motion costs a
  // re-derive only when it crosses an embed line's reveal state.
  const touches = (state: EditorState, e: Entry) => state.selection.ranges.some(r => r.from <= e.to && r.to >= e.from);
  const fold = ViewPlugin.fromClass(class {
    decorations: DecorationSet = Decoration.none;
    mask = "";
    catalog: SlideChipCatalog;
    alive = true;
    constructor(readonly view: EditorView) {
      // One catalog per editor: deck reads happen on first sight and on
      // repository invalidation only; a settled change re-derives the chips.
      this.catalog = createSlideChipCatalog(repository, () => { if (this.alive) view.dispatch({ effects: refreshSlideChips.of(null) }); });
      this.build(view.state);
    }
    build(state: EditorState) {
      paperPerf.slideChips++;
      const { entries } = state.field(field), doc = state.doc, marks: Range<Decoration>[] = [];
      let mask = "";
      for (const e of entries) {
        const open = touches(state, e);
        mask += open ? "1" : "0";
        if (open || e.to > doc.length || e.from > e.to) continue;
        const line = doc.lineAt(e.from);
        if (line.from !== e.from || line.to !== e.to) continue; // mid-rebuild mapping: never fold a stale span
        const indent = line.text.length - line.text.trimStart().length;
        const label = slideChipLabel(e.ref, this.catalog.lookup(e.ref), line.text);
        marks.push(Decoration.replace({ widget: new SlideSrcWidget(e.ref, label, onOpen) }).range(line.from + indent, line.to));
      }
      this.mask = mask;
      this.decorations = Decoration.set(marks, true);
    }
    update(u: ViewUpdate) {
      const before = u.startState.field(field), after = u.state.field(field);
      if (u.transactions.some(t => t.effects.some(e => e.is(refreshSlideChips)))) return this.build(u.state);
      // The block field MAPS its entries on prose edits and re-scans when an
      // edit lands within a line of an embed (its change gate). Either way,
      // when every embed kept its span and its source, the chips are mapped:
      // a prose keystroke costs zero chip builds.
      const same = (e: Entry, i: number) => {
        const p = before.entries[i];
        if (e.ref === p.ref) return true;
        return e.from === u.changes.mapPos(p.from, 1) && e.to === u.changes.mapPos(p.to, -1) && JSON.stringify(e.ref) === JSON.stringify(p.ref);
      };
      if (before !== after && (before.entries.length !== after.entries.length || !after.entries.every(same))) return this.build(u.state);
      if (!u.docChanged && !u.selectionSet) return;
      const mask = after.entries.map(e => touches(u.state, e) ? "1" : "0").join("");
      if (mask !== this.mask) return this.build(u.state);
      if (u.docChanged) this.decorations = this.decorations.map(u.changes);
    }
    destroy() { this.alive = false; this.catalog.dispose(); }
  }, {
    decorations: v => v.decorations,
    provide: plugin => EditorView.atomicRanges.of(view => view.plugin(plugin)?.decorations ?? Decoration.none),
  });
  return [field, fold, chipActivation];
}
