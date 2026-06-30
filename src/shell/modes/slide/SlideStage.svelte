<script lang="ts">
  // SlideStage — the WYSIWYG editor stage. Mounts the ONE renderer (player/render)
  // into a fixed StageSize scaled to fit, then overlays selection + drag/resize/
  // marquee/snap affordances. Reuses the figure canvas's pure interaction math
  // (geometry.selectionBBox/elementBBox/rectsIntersect, editing.resizeRemap) and
  // mirrors its un-exported handle/snap blocks, adapted to the slide's single
  // fit-scale (no pan, no per-figure offset — the slide IS the frame).
  //
  // Gesture pattern (from the figure canvas): capture originals at pointer-down,
  // preview live by mutating the rendered wrappers' geometry, and write the model
  // ONCE on pointer-up via a single commitDeck (no per-frame deck clone).
  import { renderSlide } from "../../../lib/slide/player/render";
  import { computeSlideAnims, applyStatic } from "../../../lib/slide/player/player";
  import { plotGen, plotManifests } from "../../../lib/plot/store";
  import { get } from "svelte/store";
  import { selectionBBox, elementBBox, rectsIntersect } from "../../../lib/geometry";
  import { resizeRemap } from "../../../lib/editing";
  import { commitDeck, selection } from "../../../lib/slide/store";
  import { setElementBox, deleteElements, findElement, setTextBoxText, setMathTex } from "../../../lib/slide/ops";
  import type { Element as FigElement } from "../../../lib/types";
  import type { Slide, SlideElement, DeckTheme, StageSize } from "../../../lib/slide/types";

  let {
    slide,
    theme,
    stage,
    interactive = true,
    focused = true,
    beat = 0,
    assetUrl,
    figureSvg,
  }: {
    slide: Slide;
    theme: DeckTheme;
    stage: StageSize;
    interactive?: boolean;
    focused?: boolean;
    /** Freeze the stage at this beat's static (build) state for preview. */
    beat?: number;
    assetUrl?: (id: string) => string | undefined;
    figureSvg?: (id: string) => string | undefined;
  } = $props();

  type Rect = { x: number; y: number; w: number; h: number };
  type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
  const HANDLES: Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
  const cursorFor: Record<Handle, string> = {
    nw: "nwse-resize", se: "nwse-resize", ne: "nesw-resize", sw: "nesw-resize",
    n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize",
  };

  let viewport = $state<HTMLElement>();
  let scaledEl = $state<HTMLElement>();
  let stageEl = $state<HTMLElement>();
  let fitW = $state(0);
  let fitH = $state(0);
  const scale = $derived(fitW > 0 && fitH > 0 ? Math.min(fitW / stage.width, fitH / stage.height) : 0);

  // Rendered wrappers (elId → div), refreshed each render so previews can mutate them.
  let wrappers = new Map<string, HTMLElement>();

  // Re-render the slide whenever its content/theme/plot-regen/beat changes, then
  // freeze it at the selected beat's static (build) state so the scrubber previews
  // builds. Editing happens against model coordinates regardless of preview styles.
  $effect(() => {
    const gen = $plotGen; // subscribe so plot hot-swaps re-render
    if (!stageEl) return;
    const opts = { theme, assetUrl, figureSvg, plotGen: gen, mode: "edit" as const, plotManifest: (id: string) => get(plotManifests)[id] };
    const r = renderSlide(stageEl, slide, stage, opts);
    wrappers = r.elements;
    const specs = computeSlideAnims(slide, r, stageEl, stage, opts);
    applyStatic(specs, beat);
    // hide the element being inline-edited (the textarea overlay stands in for it)
    if (editingId) { const w = r.elements.get(editingId); if (w) w.style.visibility = "hidden"; }
  });

  // --- selection helpers (slide store is string[]; we work with a Set) ---------
  const els = $derived(slide.elements);
  function byId(id: string): SlideElement | undefined {
    return els.find((e) => e.id === id);
  }
  /** Expand a hit set to whole groups within this slide. */
  function expandGroups(ids: Set<string>): string[] {
    const groups = new Set<string>();
    for (const e of els) if (ids.has(e.id) && e.groupId) groups.add(e.groupId);
    const out = new Set(ids);
    if (groups.size) for (const e of els) if (e.groupId && groups.has(e.groupId)) out.add(e.id);
    return [...out];
  }
  const selectedEls = $derived(($selection.map(byId).filter(Boolean)) as SlideElement[]);
  const modelBox = $derived(selectionBBox(selectedEls as unknown as FigElement[]));

  // The overlay box: a live preview during a gesture, else the model selection box.
  let previewBox = $state<Rect | null>(null);
  const overlayBox = $derived(previewBox ?? modelBox);

  // --- coordinate mapping (the one viewport adaptation) ------------------------
  function toAuthoring(cx: number, cy: number): { x: number; y: number } {
    const r = scaledEl!.getBoundingClientRect();
    return { x: (cx - r.left) / scale, y: (cy - r.top) / scale };
  }

  // --- the resize-box math (mirrors Canvas.svelte computeResizeBox) ------------
  function computeResizeBox(ob: Rect, h: Handle, lp: { x: number; y: number }, shift: boolean): Rect {
    let x = ob.x, y = ob.y, w = ob.w, hh = ob.h;
    const right = ob.x + ob.w;
    const bottom = ob.y + ob.h;
    if (h.includes("w")) { x = lp.x; w = right - lp.x; }
    if (h.includes("e")) w = lp.x - ob.x;
    if (h.includes("n")) { y = lp.y; hh = bottom - lp.y; }
    if (h.includes("s")) hh = lp.y - ob.y;
    if (shift && ob.w > 0 && ob.h > 0) {
      const s = Math.max(w / ob.w, hh / ob.h);
      w = ob.w * s; hh = ob.h * s;
      if (h.includes("w")) x = right - w;
      if (h.includes("n")) y = bottom - hh;
    }
    return { x, y, w: Math.max(1, w), h: Math.max(1, hh) };
  }

  // --- the snapper (mirrors Canvas.svelte snap) --------------------------------
  function snap(edges: number[], targets: number[], thr: number): { off: number; line: number | null } {
    let best = thr, off = 0, line: number | null = null;
    for (const edge of edges)
      for (const t of targets) {
        const d = t - edge;
        if (Math.abs(d) < best) { best = Math.abs(d); off = d; line = t; }
      }
    return { off, line };
  }
  function snapTargets(excludeIds: Set<string>): { xs: number[]; ys: number[] } {
    const xs = [0, stage.width, stage.width / 2];
    const ys = [0, stage.height, stage.height / 2];
    for (const e of els) {
      if (excludeIds.has(e.id)) continue;
      const b = elementBBox(e as unknown as FigElement);
      xs.push(b.x, b.x + b.w, b.x + b.w / 2);
      ys.push(b.y, b.y + b.h, b.y + b.h / 2);
    }
    return { xs, ys };
  }

  function handlePos(h: Handle, b: Rect): [number, number] {
    const map: Record<Handle, [number, number]> = {
      nw: [b.x, b.y], n: [b.x + b.w / 2, b.y], ne: [b.x + b.w, b.y],
      e: [b.x + b.w, b.y + b.h / 2], se: [b.x + b.w, b.y + b.h], s: [b.x + b.w / 2, b.y + b.h],
      sw: [b.x, b.y + b.h], w: [b.x, b.y + b.h / 2],
    };
    return map[h];
  }

  // --- gesture state -----------------------------------------------------------
  type Gesture =
    | { kind: "move"; ids: string[]; origs: Map<string, SlideElement>; ob: Rect; start: { x: number; y: number } }
    | { kind: "resize"; ids: string[]; origs: Map<string, SlideElement>; ob: Rect; handle: Handle }
    | { kind: "marquee"; x0: number; y0: number; add: Set<string> };
  let gesture: Gesture | null = null;
  // The committed delta/box for the active gesture, stashed during move so
  // pointer-up writes the model from numbers (not by parsing back DOM styles).
  let liveMove = { dx: 0, dy: 0 };
  let liveNb: Rect | null = null;
  let guideX = $state<number | null>(null);
  let guideY = $state<number | null>(null);
  let marquee = $state<Rect | null>(null);

  // --- inline text editing (dblclick → screen-space textarea overlay) ----------
  let editingId = $state<string | null>(null);
  let editText = $state("");
  let taEl = $state<HTMLTextAreaElement>();
  const editingEl = $derived(editingId ? byId(editingId) : undefined);
  // Box + font for the overlay textarea (screen px), or null if not editing.
  const editStyle = $derived.by(() => {
    const el = editingEl;
    if (!el || (el.type !== "textBox" && el.type !== "math")) return null;
    return {
      x: el.x, y: el.y, w: el.width, h: el.height,
      fs: el.fontSize ?? 32,
      weight: el.type === "textBox" ? (el.fontWeight ?? 400) : 400,
      align: el.type === "textBox" ? (el.align ?? "left") : "center",
      color: el.color ?? "var(--c-tx)",
    };
  });

  function cloneSel(ids: string[]): Map<string, SlideElement> {
    const m = new Map<string, SlideElement>();
    for (const id of ids) {
      const e = byId(id);
      if (e) m.set(id, structuredClone(e));
    }
    return m;
  }

  // Apply a transient {x,y,width,height} to a rendered wrapper (live preview).
  function previewEl(id: string, box: { x: number; y: number; width: number; height: number }) {
    const w = wrappers.get(id);
    if (!w) return;
    w.style.left = `${box.x}px`;
    w.style.top = `${box.y}px`;
    w.style.width = `${box.width}px`;
    w.style.height = `${box.height}px`;
  }

  function hitTest(p: { x: number; y: number }): SlideElement | null {
    const tol = 6 / scale; // grab tolerance — keeps thin/degenerate lines clickable
    for (let i = els.length - 1; i >= 0; i--) {
      const e = els[i];
      if (e.locked) continue;
      const b = elementBBox(e as unknown as FigElement);
      if (p.x >= b.x - tol && p.x <= b.x + b.w + tol && p.y >= b.y - tol && p.y <= b.y + b.h + tol) return e;
    }
    return null;
  }

  function onStagePointerDown(e: PointerEvent) {
    if (!interactive || e.button !== 0) return;
    const p = toAuthoring(e.clientX, e.clientY);
    const hit = hitTest(p);
    scaledEl!.setPointerCapture(e.pointerId);
    if (hit) {
      // Select (shift toggles; click on an unselected element replaces).
      let ids: string[];
      if (e.shiftKey) {
        const s = new Set($selection);
        s.has(hit.id) ? s.delete(hit.id) : s.add(hit.id);
        ids = expandGroups(s);
      } else {
        ids = $selection.includes(hit.id) ? $selection : expandGroups(new Set([hit.id]));
      }
      selection.set(ids);
      const ob = selectionBBox(ids.map(byId).filter(Boolean) as unknown as FigElement[]);
      if (ob) { gesture = { kind: "move", ids, origs: cloneSel(ids), ob, start: p }; liveMove = { dx: 0, dy: 0 }; }
    } else {
      // Empty: marquee select (clear unless shift-extending).
      if (!e.shiftKey) selection.set([]);
      gesture = { kind: "marquee", x0: p.x, y0: p.y, add: new Set(e.shiftKey ? $selection : []) };
    }
  }

  function onHandleDown(e: PointerEvent, handle: Handle) {
    if (!interactive) return;
    e.stopPropagation();
    const ids = $selection;
    const ob = selectionBBox(ids.map(byId).filter(Boolean) as unknown as FigElement[]);
    if (!ob) return;
    scaledEl!.setPointerCapture(e.pointerId);
    gesture = { kind: "resize", ids, origs: cloneSel(ids), ob, handle };
    liveNb = null;
  }

  function onPointerMove(e: PointerEvent) {
    if (!gesture) return;
    const p = toAuthoring(e.clientX, e.clientY);
    if (gesture.kind === "move") {
      let dx = p.x - gesture.start.x;
      let dy = p.y - gesture.start.y;
      const { xs, ys } = snapTargets(new Set(gesture.ids));
      const b = gesture.ob;
      const sX = snap([b.x + dx, b.x + b.w / 2 + dx, b.x + b.w + dx], xs, 6 / scale);
      const sY = snap([b.y + dy, b.y + b.h / 2 + dy, b.y + b.h + dy], ys, 6 / scale);
      if (sX.line != null) { dx += sX.off; guideX = sX.line; } else guideX = null;
      if (sY.line != null) { dy += sY.off; guideY = sY.line; } else guideY = null;
      liveMove = { dx, dy };
      for (const id of gesture.ids) {
        const o = gesture.origs.get(id)!;
        previewEl(id, { x: o.x + dx, y: o.y + dy, width: o.width, height: o.height });
      }
      previewBox = { x: b.x + dx, y: b.y + dy, w: b.w, h: b.h };
    } else if (gesture.kind === "resize") {
      const nb = computeResizeBox(gesture.ob, gesture.handle, p, e.shiftKey);
      liveNb = nb;
      for (const id of gesture.ids) {
        const o = gesture.origs.get(id)!;
        const tmp = structuredClone(o);
        resizeRemap(tmp as unknown as FigElement, o as unknown as FigElement, gesture.ob, nb);
        previewEl(id, { x: tmp.x, y: tmp.y, width: tmp.width, height: tmp.height });
      }
      previewBox = nb;
    } else if (gesture.kind === "marquee") {
      const r: Rect = {
        x: Math.min(gesture.x0, p.x), y: Math.min(gesture.y0, p.y),
        w: Math.abs(p.x - gesture.x0), h: Math.abs(p.y - gesture.y0),
      };
      marquee = r;
      const hit = new Set(gesture.add);
      for (const el of els) if (rectsIntersect(elementBBox(el as unknown as FigElement), r)) hit.add(el.id);
      selection.set(expandGroups(hit));
    }
  }

  function onPointerUp() {
    if (!gesture) return;
    const g = gesture;
    gesture = null;
    guideX = guideY = null;
    marquee = null;
    previewBox = null;
    if (g.kind === "move") {
      const { dx, dy } = liveMove;
      if (dx === 0 && dy === 0) return; // a click, not a drag
      commitDeck((d) => {
        for (const id of g.ids) {
          const o = g.origs.get(id)!;
          setElementBox(d, id, { x: o.x + dx, y: o.y + dy });
        }
      });
    } else if (g.kind === "resize" && liveNb) {
      const nb = liveNb;
      const ob = g.ob;
      commitDeck((d) => {
        for (const id of g.ids) {
          const orig = g.origs.get(id);
          const found = findElement(d, id); // → { slide, el } | null
          // resizeRemap handles every type correctly: scales boxes, remaps line
          // endpoints, and scales text font-size (mirrors the figure canvas).
          if (orig && found) resizeRemap(found.el as unknown as FigElement, orig as unknown as FigElement, ob, nb);
        }
      });
    }
  }

  // --- inline editing (mirror Canvas.svelte's textarea-overlay pattern) --------
  function startEdit(el: SlideElement) {
    if (el.type !== "textBox" && el.type !== "math") return;
    gesture = null; previewBox = null;
    selection.set([el.id]);
    editingId = el.id;
    editText = el.type === "textBox" ? el.blocks.map((b) => b.text).join("\n") : el.tex;
    requestAnimationFrame(() => { taEl?.focus(); taEl?.select(); });
  }
  function onEditInput() {
    const id = editingId;
    if (!id) return;
    const t = editingEl?.type;
    commitDeck((d) => {
      if (t === "textBox") setTextBoxText(d, id, editText);
      else if (t === "math") setMathTex(d, id, editText);
    });
  }
  function finishEdit() { editingId = null; }
  function onEditKey(e: KeyboardEvent) {
    e.stopPropagation();
    if (e.key === "Escape") { e.preventDefault(); finishEdit(); }
    else if (e.key === "Enter" && editingEl?.type === "math") { e.preventDefault(); finishEdit(); }
  }
  function onStageDblClick(e: MouseEvent) {
    if (!interactive) return;
    const hit = hitTest(toAuthoring(e.clientX, e.clientY));
    if (hit) startEdit(hit);
  }

  // --- keyboard: delete + nudge (only when this stage has a selection) ---------
  function onKey(e: KeyboardEvent) {
    if (!interactive || !focused || $selection.length === 0) return;
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || (e.target as HTMLElement)?.isContentEditable) return;
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      const ids = $selection;
      commitDeck((d) => deleteElements(d, ids));
      selection.set([]);
    } else if (e.key === "Escape") {
      selection.set([]);
    } else if (e.key.startsWith("Arrow")) {
      e.preventDefault();
      const step = e.shiftKey ? 10 : 1;
      const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
      const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
      const ids = $selection;
      commitDeck((d) => {
        for (const id of ids) {
          const el = d.slides.flatMap((s) => s.elements).find((x) => x.id === id);
          if (el) setElementBox(d, id, { x: el.x + dx, y: el.y + dy });
        }
      });
    }
  }
</script>

<svelte:window onkeydown={onKey} />

<div class="fit" bind:this={viewport} bind:clientWidth={fitW} bind:clientHeight={fitH}>
  {#if scale > 0}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="scaled"
      bind:this={scaledEl}
      style={`width:${stage.width * scale}px;height:${stage.height * scale}px`}
      onpointerdown={onStagePointerDown}
      onpointermove={onPointerMove}
      onpointerup={onPointerUp}
      onpointercancel={onPointerUp}
      ondblclick={onStageDblClick}>
      <div
        class="stage"
        bind:this={stageEl}
        style={`width:${stage.width}px;height:${stage.height}px;transform:scale(${scale});transform-origin:0 0`}>
      </div>

      {#if interactive}
        <!-- overlay: screen-px, sibling of .stage; positions at value*scale -->
        <svg class="overlay" width={stage.width * scale} height={stage.height * scale}>
          {#if guideX != null}
            <line class="guide" x1={guideX * scale} y1={0} x2={guideX * scale} y2={stage.height * scale} />
          {/if}
          {#if guideY != null}
            <line class="guide" x1={0} y1={guideY * scale} x2={stage.width * scale} y2={guideY * scale} />
          {/if}
          {#if marquee}
            <rect class="marquee" x={marquee.x * scale} y={marquee.y * scale}
              width={marquee.w * scale} height={marquee.h * scale} />
          {/if}
          {#if overlayBox}
            <rect class="selbox" x={overlayBox.x * scale} y={overlayBox.y * scale}
              width={overlayBox.w * scale} height={overlayBox.h * scale} />
            {#each HANDLES as h (h)}
              {@const pos = handlePos(h, overlayBox)}
              <rect
                class="handle"
                x={pos[0] * scale - 5} y={pos[1] * scale - 5} width={10} height={10}
                style={`cursor:${cursorFor[h]}`}
                onpointerdown={(e) => onHandleDown(e, h)} />
            {/each}
          {/if}
        </svg>
      {/if}

      {#if interactive && editStyle}
        <!-- inline text editor: screen-space textarea over the element being edited -->
        <textarea
          class="inline-edit"
          bind:this={taEl}
          bind:value={editText}
          spellcheck="false"
          style={`left:${editStyle.x * scale}px;top:${editStyle.y * scale}px;width:${editStyle.w * scale}px;height:${editStyle.h * scale}px;font-size:${editStyle.fs * scale}px;font-weight:${editStyle.weight};text-align:${editStyle.align};color:${editStyle.color};`}
          oninput={onEditInput}
          onblur={finishEdit}
          onkeydown={onEditKey}
          onpointerdown={(e) => e.stopPropagation()}
        ></textarea>
      {/if}
    </div>
  {/if}
</div>

<style>
  .fit {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
  }
  .scaled {
    position: relative;
    border: 1px solid var(--c-line-strong, #343331);
    box-shadow: 0 10px 34px rgba(0, 0, 0, 0.5);
    touch-action: none;
  }
  .stage {
    position: absolute;
    top: 0;
    left: 0;
    overflow: hidden;
  }
  .overlay {
    position: absolute;
    top: 0;
    left: 0;
    pointer-events: none;
    overflow: visible;
  }
  .selbox {
    fill: none;
    stroke: var(--c-accent, #4385be);
    stroke-width: 1;
  }
  .handle {
    fill: var(--c-bg, #100f0f);
    stroke: var(--c-accent, #4385be);
    stroke-width: 1.5;
    pointer-events: all;
  }
  .guide {
    stroke: var(--c-accent-bright, #66a0c8);
    stroke-width: 1;
    stroke-dasharray: 4 3;
  }
  .marquee {
    fill: color-mix(in oklab, var(--c-accent, #4385be) 14%, transparent);
    stroke: var(--c-accent, #4385be);
    stroke-width: 1;
  }
  .inline-edit {
    position: absolute;
    z-index: 10;
    margin: 0;
    padding: 0;
    border: 1px dashed var(--c-accent, #4385be);
    border-radius: 2px;
    background: color-mix(in oklab, var(--c-bg, #100f0f) 70%, transparent);
    font-family: var(--font-serif, Georgia, "Times New Roman", serif);
    line-height: 1.2;
    resize: none;
    outline: none;
    box-sizing: border-box;
    overflow: hidden;
  }
</style>
