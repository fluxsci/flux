<script lang="ts">
  /**
   * Styling a layer's objects by a column of its table, in place under the layer's row: "colour by" or "opacity by".
   *
   * The columns are paper keys, each with a small picture of what choosing it does (a categorical column: its first
   * colours; a numeric one: its colour map; for opacity: a fade), and "none". Resting on a key SHOWS its choice on
   * the image before anything is written (`fluximgStylePreview`); pressing it writes the view, one undo step. A numeric
   * column's window is two pink handles on a strip of the column's own distribution (drag a handle, drag between them
   * to slide, roll the wheel over the strip: the nearer one moves), as a channel's contrast is set. Coloured by
   * numbers, the colour map is one of a row of swatches; by categories, the categories are listed with their colours
   * and resting on one lights its objects on the image.
   *
   * Keys, only when the layers card holds the keyboard (`d`; never from a click): digits pick a column (0 = none),
   * arrows walk the keys (each previewed), Enter picks, Esc closes (`BoardLayers` routes them). A pick by click closes it.
   *
   * Nothing moves under a pointer that has not moved: the drawer opening can grow the card under a still pointer, so a
   * key is previewed (and can be picked by click) only once the pointer has moved since the drawer opened. A preview
   * is ONE override (layer, part, column) over the model, derived by the overlay; leaving the drawer clears it.
   */
  import { fluximgLutsReady, resolveLut } from "../store";
  import { columnHistogram, columnKind, columnSummaries, DEFAULT_PALETTE, DEFAULT_STYLE_LUT, cachedObjectStyles, numericExtent, slotColor, styleTable, type ColumnSummary } from "../objectStyle";
  import { middleEllipsis } from "../inspectorEdits";
  import type { FluximgLayer, FluximgTable } from "../types";
  import type { ResolvedLayer } from "../view";
  import { formatNumber } from "../viewOps";
  import { histogramPath } from "./histogram";
  import PaperKey from "./PaperKey.svelte";
  import { colorBy, opacityBy, setStyleLut, setStyleRange, toggleStyleMissing, toggleStyleReverse } from "./actions";
  import { cancelLiveEdit, fluximgHover, fluximgStylePreview, settleLiveEdit } from "./session";

  let { layer, lv, table, part, width = 226, choice = $bindable(-1), problem = "", onpicked }: {
    layer: FluximgLayer;
    lv: ResolvedLayer;
    table: FluximgTable | null;
    part: "color" | "opacity";
    width?: number;
    /** The key the keyboard is on (-1: none yet): 0 = "none", then the columns in order. */
    choice?: number;
    /** Why the stored styling cannot apply (a column the table lacks, a table that cannot be read), or "". */
    problem?: string;
    /** A choice was made: by a click (the drawer closes) or by a key. */
    onpicked: (byClick: boolean) => void;
  } = $props();

  const uid = `fxs-${Math.random().toString(36).slice(2)}`;
  const columns = $derived(columnSummaries(table, layer.kind === "intensity" ? null : layer).filter((c) => (part === "color" ? c.kind !== "empty" : c.kind === "number")));
  const current = $derived(part === "color" ? lv.styleBy?.color?.column ?? null : lv.styleBy?.opacity?.column ?? null);
  /** The ink a fade is drawn in: the layer's own colour. */
  const ink = $derived(lv.color ?? (layer.kind !== "intensity" ? layer.color : null) ?? "#fffcf0");
  const lut = $derived(lv.styleBy?.color?.lut ?? DEFAULT_STYLE_LUT);

  // --- what a key would do ------------------------------------------------------------------------
  // Has the pointer moved since the drawer opened? The first move seen is where it rests; one elsewhere is a move.
  let rest: { x: number; y: number } | null = null;
  let moved = $state(false);
  $effect(() => {
    const seen = (e: PointerEvent): void => {
      if (!rest) { rest = { x: e.clientX, y: e.clientY }; return; }
      if (e.clientX !== rest.x || e.clientY !== rest.y) { moved = true; window.removeEventListener("pointermove", seen, true); }
    };
    window.addEventListener("pointermove", seen, { capture: true, passive: true });
    return () => window.removeEventListener("pointermove", seen, true);
  });
  /** Show a column's choice on the image (undefined: show the model again). */
  function preview(column: string | null | undefined, byKey = false): void {
    if (column === undefined) { fluximgStylePreview.set(null); return; }
    if (!byKey && !moved) return;
    fluximgStylePreview.set({ layerId: lv.id, part, column });
  }
  function pick(column: string | null, byClick: boolean): void {
    if (byClick && !moved) return; // the card grew under a still pointer: that key was never pointed at
    fluximgStylePreview.set(null);
    if (column !== current) { if (part === "color") colorBy(lv.id, column); else opacityBy(lv.id, column); }
    onpicked(byClick);
  }
  /** The keys in keyboard order: "none" first. */
  export function keyAt(i: number): string | null | undefined { return i === 0 ? null : columns[i - 1]?.name; }
  export function count(): number { return columns.length + 1; }
  export function previewAt(i: number): void { preview(keyAt(i), true); }
  export function pickAt(i: number): void { const c = keyAt(i); if (c !== undefined) pick(c, false); }
  // Whatever way the drawer goes (closed, another part, another layer, the board closing), its preview goes with it.
  $effect(() => () => { fluximgStylePreview.set(null); });

  /** A key's little picture, as CSS: the first colours, the colour map, or the fade. */
  function picture(c: ColumnSummary): string {
    void $fluximgLutsReady;
    if (part === "opacity") return `linear-gradient(90deg, color-mix(in srgb, ${ink} 15%, transparent), ${ink})`;
    if (c.kind === "number") {
      const t = styleTable(c.name === current ? lut : DEFAULT_STYLE_LUT, c.name === current && !!lv.styleBy?.color?.reverse, resolveLut);
      return `linear-gradient(90deg,${[0, 64, 128, 192, 255].map((i) => slotColor(t, i)).join(",")})`;
    }
    const n = Math.min(4, Math.max(1, c.distinct)), pal = DEFAULT_PALETTE;
    return `linear-gradient(90deg,${Array.from({ length: n }, (_, i) => `${pal[i]} ${(i / n) * 100}% ${((i + 1) / n) * 100}%`).join(",")})`;
  }
  const words = (c: ColumnSummary): string => (c.kind === "number" && c.range ? `${fmt(c.range[0])}–${fmt(c.range[1])}` : `${c.distinct} value${c.distinct === 1 ? "" : "s"}`);
  const fmt = (v: number): string => formatNumber(Number(v.toPrecision(4)));

  // --- the window of a numeric column ------------------------------------------------------------
  const values = $derived(current && table ? table.columns[current] ?? null : null);
  const numeric = $derived(!!values && columnKind(values) === "number" && !(part === "color" && lv.styleBy?.color?.palette && !lv.styleBy.color.lut));
  const extent = $derived(values && numeric ? numericExtent(values) : null);
  const range = $derived.by((): [number, number] | null => {
    if (!extent) return null;
    const r = part === "color" ? lv.styleBy?.color?.range : lv.styleBy?.opacity?.range;
    return r && r[1] > r[0] ? [r[0], r[1]] : [extent[0], extent[1] > extent[0] ? extent[1] : extent[0] + 1];
  });
  const W = $derived(width - 20), H = 30;
  let held = $state.raw<{ lo: number; hi: number } | null>(null);
  const lo = $derived(range?.[0] ?? 0), hi = $derived(range?.[1] ?? 1);
  const domain = $derived.by(() => {
    if (held) return held;
    if (!extent) return { lo: 0, hi: 1 };
    let a = extent[0], b = extent[1] > extent[0] ? extent[1] : extent[0] + 1;
    const pad = 0.04 * (Math.max(b, hi) - Math.min(a, lo));
    if (lo < a) a = lo - pad;
    if (hi > b) b = hi + pad;
    return { lo: a, hi: b };
  });
  const xOf = (v: number): number => Math.min(W, Math.max(0, ((v - domain.lo) / (domain.hi - domain.lo)) * W));
  const vOf = (x: number): number => domain.lo + (x / W) * (domain.hi - domain.lo);
  const xb = $derived(xOf(lo)), xw = $derived(xOf(hi));
  const hist = $derived(values && numeric ? columnHistogram(values, Math.min(64, Math.max(16, Math.round(W / 4)))) : null);
  const shape = $derived(hist ? histogramPath(hist, domain, W, H, "linear") : "");
  const stops = $derived.by(() => {
    void $fluximgLutsReady;
    if (part === "opacity") return [{ o: 0, c: ink, a: 0.15 }, { o: 1, c: ink, a: 1 }];
    const t = styleTable(lut, !!lv.styleBy?.color?.reverse, resolveLut);
    return Array.from({ length: 9 }, (_, i) => ({ o: i / 8, c: slotColor(t, Math.round((i / 8) * 255)), a: 1 }));
  });

  type Point = "black" | "white" | "window";
  let svg = $state<SVGSVGElement>();
  let hit = $state<HTMLDivElement>();
  let drag = $state.raw<{ pointer: number; which: Point; x0: number; from: [number, number] } | null>(null);
  let over = $state<Point | null>(null);
  const local = (e: PointerEvent): number => { const r = svg!.getBoundingClientRect(); return ((e.clientX - r.left) / r.width) * W; };
  const pointAt = (x: number): Point => { const db = Math.abs(x - xb), dw = Math.abs(x - xw); return db <= 9 && db <= dw ? "black" : dw <= 9 ? "white" : x > xb && x < xw ? "window" : db < dw ? "black" : "white"; };
  function windowAt(x: number): [number, number] {
    const d = drag!, v = vOf(x);
    if (d.which === "window") { const dv = v - vOf(d.x0); return [d.from[0] + dv, d.from[1] + dv]; }
    const span = (domain.hi - domain.lo) * 1e-3;
    return d.which === "black" ? [Math.min(v, d.from[1] - span), d.from[1]] : [d.from[0], Math.max(v, d.from[0] + span)];
  }
  /** The window as written: the column's own extent is the default, so it clears. */
  function write(r: [number, number]): void {
    const own = extent && Math.abs(r[0] - extent[0]) < 1e-9 * Math.max(1, Math.abs(extent[0])) && Math.abs(r[1] - extent[1]) < 1e-9 * Math.max(1, Math.abs(extent[1]));
    const round = (v: number): number => Number(v.toPrecision(6));
    setStyleRange(lv.id, part, own ? null : [round(r[0]), round(r[1])]);
  }
  function down(e: PointerEvent): void {
    if (e.button !== 0 || !svg || !hit || !range) return;
    e.preventDefault(); e.stopPropagation();
    const x = local(e);
    held = { ...domain };
    drag = { pointer: e.pointerId, which: pointAt(x), x0: x, from: [range[0], range[1]] };
    hit.setPointerCapture(e.pointerId);
    write(windowAt(x));
  }
  function move(e: PointerEvent): void {
    if (!svg) return;
    if (!drag) { over = pointAt(local(e)); return; }
    if (e.pointerId !== drag.pointer) return;
    write(windowAt(local(e)));
  }
  function finish(e: PointerEvent, phase: "end" | "cancel"): void {
    if (!drag || e.pointerId !== drag.pointer) return;
    if (phase === "end") write(windowAt(local(e)));
    drag = null; held = null;
    if (hit?.hasPointerCapture(e.pointerId)) hit.releasePointerCapture(e.pointerId);
    if (phase === "end") settleLiveEdit(); else cancelLiveEdit();
  }
  const lit = (p: Point): boolean => drag?.which === p || (!drag && over === p);
  const cursor = $derived(drag?.which === "window" ? "grabbing" : over === "window" ? "grab" : "ew-resize");

  const MAPS = ["viridis", "cividis", "plasma", "magma", "crameri.batlow", "cmasher.ember"];
  const mapCss = (name: string): string => { void $fluximgLutsReady; const t = styleTable(name, false, resolveLut); return `linear-gradient(90deg,${[0, 64, 128, 192, 255].map((i) => slotColor(t, i)).join(",")})`; };

  // --- categories and objects without a value ------------------------------------------------------
  const legend = $derived.by(() => { void $fluximgLutsReady; return lv.styleBy ? cachedObjectStyles(table, layer.kind !== "intensity" ? layer.key ?? null : null, lv.styleBy, resolveLut).legend : null; });
  const cats = $derived(part === "color" && legend?.color?.kind === "category" ? legend.color.entries : []);
  const missing = $derived(legend?.missing ?? null);
  function lightKeys(keys: string[] | null): void {
    if (keys?.length) fluximgHover.set({ layerId: lv.id, key: keys[0], keys, from: "list" });
    else if ($fluximgHover?.from === "list") fluximgHover.set(null);
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="style" style={`--ink:${ink}`} data-fxb-style={`${part}:${lv.id}`} onpointerdown={(e) => e.stopPropagation()}>
  {#if problem}
    <!-- The stored styling cannot apply: say so, and offer to clear it (or pick another column below). -->
    <div class="problem" data-fxb-style-problem>
      <span>{problem}</span>
      <PaperKey quiet size={20} glyph="none" label="Clear it" id="style-clear" onpress={() => { fluximgStylePreview.set(null); if (part === "color") colorBy(lv.id, null); else opacityBy(lv.id, null); }} />
    </div>
  {/if}
  <div class="cols scrolls" role="listbox" aria-label={part === "color" ? `Colour ${lv.name} by` : `Opacity of ${lv.name} by`}>
    <button class="ck none" class:on={current === null} class:kb={choice === 0} type="button" role="option" aria-selected={current === null} data-fxb-style-col=""
      data-tip={part === "color" ? "One colour for all" : "Every object as opaque as the layer"} data-hk="0"
      onpointerenter={() => preview(null)} onpointermove={() => preview(null)} onpointerleave={() => preview(undefined)} onclick={() => pick(null, true)}>
      <span class="pic none"></span><span class="nm">none</span>
    </button>
    {#each columns as c, i (c.name)}
      <button class="ck" class:on={current === c.name} class:kb={choice === i + 1} type="button" role="option" aria-selected={current === c.name} data-fxb-style-col={c.name}
        data-tip={`${c.name} · ${words(c)}`} data-hk={i < 9 ? String(i + 1) : undefined}
        onpointerenter={() => preview(c.name)} onpointermove={() => preview(c.name)} onpointerleave={() => preview(undefined)} onclick={() => pick(c.name, true)}>
        <span class="pic" style={`background:${picture(c)}`}></span><span class="nm">{middleEllipsis(c.name, 13)}</span>
      </button>
    {/each}
    {#if !columns.length}<span class="empty">{part === "opacity" ? "No column of numbers" : "No column to colour by"}</span>{/if}
  </div>

  {#if range && current}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="strip" data-fxb-wheel={`style:${part}:${lv.id}`}>
      <div class="wellbox" style={`width:${W}px;height:${H}px`}>
        <svg bind:this={svg} class="well" width={W} height={H} viewBox={`0 0 ${W} ${H}`} data-fxb-stylewell data-b={(xb / W).toFixed(4)} data-w={(xw / W).toFixed(4)}>
          <defs>
            <linearGradient id={`${uid}-map`} gradientUnits="userSpaceOnUse" x1={xb} y1="0" x2={Math.max(xw, xb + 0.01)} y2="0">
              {#each stops as s (s.o)}<stop offset={s.o} stop-color={s.c} stop-opacity={s.a} />{/each}
            </linearGradient>
            <clipPath id={`${uid}-in`}><rect x={xb} y="0" width={Math.max(0, xw - xb)} height={H} /></clipPath>
          </defs>
          {#if shape}
            <path class="out" d={shape} />
            <path class="in" d={shape} fill={`url(#${uid}-map)`} clip-path={`url(#${uid}-in)`} />
            <path class="edge" d={shape} />
          {/if}
          <line class="pt" class:lit={lit("black")} x1={xb} y1="0" x2={xb} y2={H} />
          <line class="pt" class:lit={lit("white")} x1={xw} y1="0" x2={xw} y2={H} />
        </svg>
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div bind:this={hit} class="hit" style={`cursor:${cursor}`} data-tip="Drag a handle, or between them · roll: the nearer one"
          onpointerdown={down} onpointermove={move} onpointerleave={() => (over = null)} onpointerup={(e) => finish(e, "end")} onpointercancel={(e) => finish(e, "cancel")} onlostpointercapture={(e) => finish(e, "cancel")}></div>
        <span class="knob" class:lit={lit("black")} class:held={drag?.which === "black" || drag?.which === "window"} style={`left:${xb}px`} data-fxb-style-knob="lo"></span>
        <span class="knob" class:lit={lit("white")} class:held={drag?.which === "white" || drag?.which === "window"} style={`left:${xw}px`} data-fxb-style-knob="hi"></span>
      </div>
      <div class="ends"><span data-fxb-style-lo>{fmt(range[0])}</span><span class="what">{part === "color" ? current : `opacity ${Math.round((lv.styleBy?.opacity?.to?.[0] ?? 0.15) * 100)}–${Math.round((lv.styleBy?.opacity?.to?.[1] ?? 1) * 100)}%`}</span><span data-fxb-style-hi>{fmt(range[1])}</span></div>
    </div>
    {#if part === "color" && numeric}
      <div class="maps" role="listbox" aria-label="Colour map">
        {#each MAPS as name (name)}
          <button class="sw" class:cur={lut === name} type="button" role="option" aria-selected={lut === name} aria-label={name} data-tip={name} data-fxb-style-map={name}
            style={`background:${mapCss(name)}`} onclick={() => setStyleLut(lv.id, name)}></button>
        {/each}
        <span class="gap"></span>
        <PaperKey quiet size={20} glyph="invert" label="Reverse the colour map" on={!!lv.styleBy?.color?.reverse} onpress={() => toggleStyleReverse(lv.id)} />
      </div>
    {/if}
  {/if}

  {#if cats.length}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="cats" onpointerleave={() => lightKeys(null)}>
      {#each cats.slice(0, 24) as e, i (i)}
        <span class="cat" data-fxb-style-cat={e.label} onpointerenter={() => lightKeys(e.keys)}><i style={`background:${e.color}`}></i>{e.label}<b>{e.count}</b></span>
      {/each}
      {#if cats.length > 24}<span class="cat more">+{cats.length - 24}</span>{/if}
      {#if legend?.color?.kind === "category" && legend.color.repeats}<span class="cat more" data-fxb-style-repeats>colours repeat: more values than colours</span>{/if}
    </div>
  {/if}

  {#if missing}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="foot" onpointerenter={() => lightKeys(missing.keys)} onpointerleave={() => lightKeys(null)}>
      <span class="miss" class:hidden={missing.mode === "hide"}><i></i>{missing.count} without a value{missing.mode === "hide" ? ": hidden" : ": dimmed"}</span>
      <PaperKey quiet size={20} glyph="hideMissing" label={missing.mode === "hide" ? "Show objects without a value, dimmed" : "Hide objects without a value"} on={missing.mode === "hide"} id="style-missing" onpress={() => toggleStyleMissing(lv.id)} />
    </div>
  {/if}
</div>

<style>
  .style { display: flex; flex-direction: column; gap: 7px; padding: 4px 9px 9px 10px; cursor: var(--cursor-cross); }
  /* Many columns: three rows of keys, then the rest scroll (the wheel scrolls a list). */
  .cols { display: flex; flex-wrap: wrap; gap: 5px; max-height: 118px; overflow-y: auto; scrollbar-width: thin; scrollbar-color: rgba(255, 252, 240, 0.18) transparent; }
  .problem { display: flex; align-items: center; gap: 6px; justify-content: space-between; font: 10.5px/14px var(--font-ui); color: var(--c-warning, #d0a215); }
  /* A column as a paper key: what choosing it does, drawn small, over its name. */
  .ck { position: relative; display: flex; flex-direction: column; align-items: stretch; gap: 3px; min-width: 46px; max-width: 104px; height: 34px; box-sizing: border-box; padding: 5px 5px 3px; border-radius: 5px; border: 1px solid color-mix(in oklab, var(--c-layout-gap) 45%, transparent);
    background: var(--flx-paper); box-shadow: 0 1.5px 2.5px rgba(0, 0, 0, 0.5); cursor: var(--cursor-cross-hover); transition: background-color 80ms linear, border-color 80ms linear; }
  .ck:hover, .ck.kb { background: color-mix(in oklab, var(--c-layout-gap) 16%, var(--flx-paper)); border-color: var(--c-layout-gap); }
  .ck:active { transform: translateY(1px); box-shadow: 0 0 1px rgba(0, 0, 0, 0.6); }
  .ck.on { background: var(--c-layout-gap); border-color: color-mix(in oklab, var(--flx-paper) 60%, var(--c-layout-gap)); }
  .pic { display: block; height: 9px; border-radius: 2px; box-shadow: inset 0 0 0 1px rgba(16, 15, 15, 0.25); }
  .pic.none { background: transparent; box-shadow: inset 0 0 0 1.3px var(--flx-magenta-600); opacity: 0.6; }
  .ck.on .pic.none { box-shadow: inset 0 0 0 1.3px var(--flx-paper); }
  .nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 600 9.5px/12px var(--font-mono); color: var(--flx-magenta-600); text-align: center; }
  .ck.on .nm { color: var(--flx-paper); }
  .empty { font: 10.5px var(--font-ui); color: var(--fxb-tx-dim); padding: 4px 0; }
  .strip { display: flex; flex-direction: column; gap: 3px; padding-top: 2px; }
  .wellbox { position: relative; }
  .well { display: block; border-radius: 4px; background: var(--fxb-well); box-shadow: inset 0 0 0 1px rgba(255, 252, 240, 0.07); overflow: hidden; pointer-events: none; }
  .hit { position: absolute; inset: 0 -7px -8px -7px; touch-action: none; }
  .out { fill: #6f6e69; opacity: 0.55; }
  .edge { fill: none; stroke: var(--fxb-tx); stroke-width: 1; stroke-opacity: 0.55; stroke-linejoin: round; }
  .pt { stroke: var(--fxb-pink); stroke-width: 1.25; }
  .pt.lit { stroke: var(--fxb-pink-hi); stroke-width: 2; }
  .knob { position: absolute; top: 100%; width: 10px; height: 10px; margin: -5px 0 0 -5px; box-sizing: border-box; border-radius: 50%; background: var(--fxb-paper); border: 2px solid var(--fxb-pink); box-shadow: 0 1px 2px rgba(0, 0, 0, 0.6); pointer-events: none; transition: width 70ms linear, height 70ms linear, margin 70ms linear, background-color 70ms linear, box-shadow 70ms linear; }
  .knob.lit { width: 12px; height: 12px; margin: -6px 0 0 -6px; background: var(--fxb-pink); border-color: var(--fxb-paper); }
  .knob.held { box-shadow: 0 0 0 4px color-mix(in oklab, var(--fxb-pink) 32%, transparent), 0 1px 2px rgba(0, 0, 0, 0.6); }
  .ends { display: flex; justify-content: space-between; gap: 8px; margin-top: 5px; font: 10px var(--font-mono); font-variant-numeric: tabular-nums; color: var(--fxb-tx); }
  .ends .what { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fxb-tx-dim); }
  .maps { display: flex; align-items: center; gap: 5px; }
  .sw { flex: none; width: 16px; height: 16px; padding: 0; border-radius: 50%; border: 1px solid rgba(255, 252, 240, 0.28); cursor: var(--cursor-cross-hover); box-shadow: 0 1px 2px rgba(0, 0, 0, 0.5); transition: transform 70ms linear; }
  .sw:hover { transform: scale(1.18); }
  .sw.cur { box-shadow: 0 0 0 2px var(--fxb-card), 0 0 0 3.5px var(--fxb-pink); }
  .gap { flex: 1; }
  /* What the colours mean: each category in its colour, with how many objects it has. */
  .cats { display: flex; flex-wrap: wrap; gap: 3px 9px; max-height: 66px; overflow: hidden; }
  .cat { display: inline-flex; align-items: center; gap: 4px; max-width: 100%; font: 10.5px/16px var(--font-mono); color: var(--fxb-tx-hi); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: var(--cursor-cross-hover); border-radius: 3px; padding: 0 3px 0 0; }
  .cat:hover { background: color-mix(in oklab, var(--fxb-pink) 22%, transparent); }
  .cat i { flex: none; width: 8px; height: 8px; border-radius: 2px; box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.6); }
  .cat b { font-weight: 400; color: var(--fxb-tx-dim); }
  .cat.more { color: var(--fxb-tx-dim); }
  .foot { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
  .miss { display: inline-flex; align-items: center; gap: 5px; font: 10.5px var(--font-ui); color: var(--fxb-tx-dim); }
  .miss i { width: 8px; height: 8px; border-radius: 2px; background: #878580; opacity: 0.6; }
  .miss.hidden i { background: transparent; box-shadow: inset 0 0 0 1px #878580; }
  @media (prefers-reduced-motion: reduce) { .sw, .knob, .ck { transition: none; } .sw:hover, .ck:active { transform: none; } }
</style>
