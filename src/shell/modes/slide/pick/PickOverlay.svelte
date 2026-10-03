<script lang="ts">
  // The Become picker on the stage: the mode accent (a Flexoki-green outline
  // and soft halo around the slide, the backdrop dimmed a touch — a scoped,
  // owner-requested exception to the surface contract's no-glow rule), the
  // source's dashed outline, the hovered unit, the numbered picks and the
  // marquee. Outlines live in STAGE coordinates under one transformed group,
  // so a pan or zoom rewrites one attribute rather than every outline; rects
  // are measured from the live nodes only when picks / hover / the scene change.
  //
  // While picking, canvas presses belong to the picker: this component claims
  // them in the capture phase on the canvas wrapper (rulers, guides, Space /
  // middle-button pans, the wheel and every non-Select tool still reach the
  // shared Canvas untouched).
  import { yieldsToShellModal, isAnnotateChord } from "../../../agent/annotationVisibility";
  import { get } from "svelte/store";
  import { untrack } from "svelte";
  import { viewport, project, activeTool, isEditorTargetExcluded } from "../../../../lib/store";
  import { plotManifests, plotGen } from "../../../../lib/plot/store";
  import { presentationViewport, type EditorCanvasPresentation } from "../../../../lib/editorPresentation";
  import { partReadout, readoutText, nodeAttrs } from "../../../../lib/plot/readout";
  import type { SemanticPlotElement } from "../../../../lib/types";
  import { hitUnit, unitNodes, unitStageRect, frameBox, marqueeCandidates, type HitContext } from "./stageHit";
  import { boxFrom, isSourceUnit, marqueeUnits, refsToUnits, sameUnit, unitKey, type MarqueeCandidate, type PickUnit, type StageRect, type UnitDescription } from "./pickModel";
  import { BADGE_LIMIT, type BecomePicker } from "./pickState.svelte";
  import { unitRef } from "./pickLabels";
  import { perfCounters } from "../../../../lib/dev/perfCounters";

  let { picker, wrap, slideId, presentation, refLabel, describe }: {
    picker: BecomePicker;
    wrap: HTMLElement | null;
    slideId: string | null;
    presentation: EditorCanvasPresentation;
    refLabel: (ref: { element: string; parts?: string[]; group?: string }) => string;
    describe: (u: PickUnit) => UnitDescription;
  } = $props();

  const stage = $derived(presentation.stage ?? { width: 0, height: 0 });
  const fig = $derived($project.figures.find((f) => f.id === slideId) ?? null);
  const unborn = $derived(new Set(presentation.unbornElementIds ?? []));
  const target = $derived(picker.target);
  const like = $derived(picker.like);
  const armed = $derived(!!picker.mode);

  // --- the frame on screen (viewport math: no DOM read per pan frame) --------------------------------
  let hostOffset = $state({ x: 0, y: 0 });
  const display = $derived(presentationViewport($viewport, presentation));
  const fx = $derived(hostOffset.x + display.panX + (fig?.x ?? 0) * display.zoom);
  const fy = $derived(hostOffset.y + display.panY + (fig?.y ?? 0) * display.zoom);
  const z = $derived(display.zoom || 1);
  $effect(() => {
    const w = wrap;
    if (!w || !armed) return;
    const measure = () => {
      const host = w.querySelector(".canvas-host"), a = w.getBoundingClientRect(), b = host?.getBoundingClientRect();
      if (b) hostOffset = { x: b.left - a.left, y: b.top - a.top };
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(w);
    return () => ro.disconnect();
  });

  // --- measurement ----------------------------------------------------------------------------------
  function hitContext(): HitContext | null {
    const f = fig;
    if (!f) return null;
    return {
      fig: f,
      manifestFor: (el: SemanticPlotElement) => get(plotManifests)[el.assetId],
      excluded: (id, part) => unborn.has(id) || isEditorTargetExcluded(id, part),
    };
  }
  const hostEl = () => wrap?.querySelector(".canvas-host") ?? null;
  function stageRectOf(u: PickUnit): StageRect | null {
    const host = hostEl(), f = fig;
    const box = host && slideId ? frameBox(host, slideId, stage.width) : null;
    return host && f && box ? unitStageRect(u, host, f, box, (el) => get(plotManifests)[el.assetId]) : null;
  }
  // Stage rects of the picks and the source, re-measured when the scene or the
  // pick changes (never per pan/zoom frame — they are stage coordinates).
  let rects = $state.raw(new Map<string, StageRect>());
  const units = $derived(target?.units ?? []);
  const sourceUnits = $derived(target ? refsToUnits([target.source]) : []);
  $effect(() => {
    void $project; void $plotGen; void presentation.camera; void presentation.partStates; void presentation.elementStates;
    const list = [...units, ...sourceUnits];
    if (!armed) { untrack(() => { if (rects.size) rects = new Map(); }); return; }
    untrack(() => {
      const next = new Map<string, StageRect>();
      for (const u of list) {
        const key = unitKey(u);
        const r = stageRectOf(u) ?? rects.get(key); // culled/unmounted: keep the last box
        if (r) next.set(key, r);
      }
      rects = next;
    });
  });

  // --- hover ----------------------------------------------------------------------------------------
  let hoverRect = $state.raw<StageRect | null>(null);
  let lastTarget: Element | null = null;
  let lastAlt = false;
  function updateHover(node: Element | null, alt: boolean) {
    const t0 = performance.now();
    try { resolveHover(node, alt); } finally {
      const ms = performance.now() - t0;
      perfCounters.pickHoverMoves++; perfCounters.pickHoverMs += ms;
      if (ms > perfCounters.pickHoverWorstMs) perfCounters.pickHoverWorstMs = ms;
    }
  }
  function resolveHover(node: Element | null, alt: boolean) {
    lastTarget = node; lastAlt = alt;
    if (!picker.picking || press) return;
    const host = hostEl();
    const ctx = hitContext();
    const hit = node && host?.contains(node) && ctx ? hitUnit(node, ctx, alt && !like) : null;
    let unit = hit?.unit ?? null;
    if (unit && like) unit = { element: hit!.elementId };
    const cur = picker.hover;
    if (!unit) { if (cur) { picker.hover = null; hoverRect = null; } return; }
    if (cur && sameUnit(cur.unit, unit)) return; // the cheap path: same unit, nothing to do
    perfCounters.pickHoverChanges++;
    const label = refLabel(unitRef(unit)), context = unit.part ? describe(unit).context : undefined;
    let state: "free" | "picked" | "source" | "effect" | "none" = "free", detail: string | undefined, readout: string | undefined;
    if (like) {
      const effect = picker.likeEffectOf(unit.element);
      state = effect ? "effect" : "none";
      detail = effect ?? "no effect in this step";
    } else if (target) {
      if (isSourceUnit(unit, target.source, picker.unitContext())) { state = "source"; detail = "the object that becomes"; }
      else if (target.units.some((u) => sameUnit(u, unit!))) { state = "picked"; detail = "click to remove"; }
      if (unit.part && fig) {
        const el = fig.elements.find((e) => e.id === unit!.element);
        if (el?.type === "plot") {
          const node2 = unitNodes(unit, host!, fig)[0];
          const text = readoutText(partReadout(get(plotManifests)[el.assetId], unit.part, nodeAttrs(node2)));
          const lines = text.split("\n").slice(1).filter(Boolean);
          if (lines.length) readout = lines.join(" · ");
        }
      }
    }
    picker.hover = { unit, label, state, ...(context && !label.includes(context) ? { context } : {}), ...(detail ? { detail } : {}), ...(readout ? { readout } : {}) };
    hoverRect = stageRectOf(unit);
  }
  // A hovered unit that just got picked/unpicked re-describes itself.
  $effect(() => { void units.length; untrack(() => { const h = picker.hover; if (h) { picker.hover = null; updateHover(lastTarget, lastAlt); } }); });
  $effect(() => { if (!picker.picking) untrack(() => { if (picker.hover) picker.hover = null; hoverRect = null; }); });

  // --- pointer ownership ----------------------------------------------------------------------------
  type Press = { id: number; x: number; y: number; hit: PickUnit | null; elementId: string | null; alt: boolean; moved: boolean; from?: { x: number; y: number }; cands?: MarqueeCandidate[] };
  let press: Press | null = null;
  let spaceHeld = false;
  const PASS = ".ruler, .ruler-corner, .guide-hit, button, input, select, textarea, [contenteditable], foreignObject";
  const toStagePoint = (cx: number, cy: number) => {
    const a = wrap!.getBoundingClientRect();
    return { x: (cx - a.left - fx) / z, y: (cy - a.top - fy) / z };
  };
  function owns(e: PointerEvent | MouseEvent): boolean {
    if (!picker.picking || get(activeTool) !== "select" || spaceHeld) return false;
    const t = e.target instanceof Element ? e.target : null;
    const host = hostEl();
    return !!t && !!host && host.contains(t) && !t.closest(PASS);
  }
  function onDown(e: PointerEvent) {
    if (e.button !== 0 || !owns(e)) return;
    e.stopPropagation(); e.preventDefault();
    const ctx = hitContext();
    const hit = ctx ? hitUnit(e.target as Element, ctx, e.altKey && !like) : null;
    press = { id: e.pointerId, x: e.clientX, y: e.clientY, hit: hit ? (like ? { element: hit.elementId } : hit.unit) : null, elementId: hit?.elementId ?? null, alt: e.altKey, moved: false };
    try { wrap?.setPointerCapture(e.pointerId); } catch { /* a synthetic pointer */ }
  }
  function onMove(e: PointerEvent) {
    if (!press) { updateHover(e.target instanceof Element ? e.target : null, e.altKey); return; }
    if (e.pointerId !== press.id) return;
    e.stopPropagation();
    if (!press.moved && Math.hypot(e.clientX - press.x, e.clientY - press.y) < 4) return;
    if (like || !target) return; // Animate like is click-only
    if (!press.moved) {
      press.moved = true;
      press.from = toStagePoint(press.x, press.y);
      const host = hostEl(), ctx = hitContext(), box = host && slideId ? frameBox(host, slideId, stage.width) : null;
      press.cands = host && ctx && box ? marqueeCandidates(host, ctx, box) : [];
      picker.hover = null; hoverRect = null;
    }
    const box = boxFrom(press.from!, toStagePoint(e.clientX, e.clientY));
    const remove = e.altKey;
    const inside = marqueeUnits(press.cands ?? [], box).filter((u) => !isSourceUnit(u, target.source, picker.unitContext()));
    const preview = remove ? inside.filter((u) => target.units.some((p) => sameUnit(p, u))) : inside;
    picker.marquee = { from: press.from!, box, remove, preview };
    previewRects = new Map(preview.map((u) => [unitKey(u), press!.cands!.find((c) => sameUnit(c.unit, u))!.rect]));
  }
  let previewRects = $state.raw(new Map<string, StageRect>());
  function onUp(e: PointerEvent) {
    const p = press;
    if (!p || e.pointerId !== p.id) return;
    press = null;
    e.stopPropagation();
    try { wrap?.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    const m = picker.marquee;
    if (p.moved) {
      if (m) { if (m.remove) picker.remove(m.preview); else picker.add(m.preview); }
      picker.marquee = null; previewRects = new Map();
      updateHover(document.elementFromPoint(e.clientX, e.clientY), e.altKey);
      return;
    }
    if (!p.hit) return;
    // The click that follows carries the platform's click count (`detail`), so
    // a double-click honours the OS double-click time; a synthetic press with
    // no click still toggles.
    pendingClick = p.hit;
    setTimeout(() => { if (pendingClick === p.hit) { pendingClick = null; activate(p.hit!, 1); } });
  }
  let pendingClick: PickUnit | null = null;
  function activate(unit: PickUnit, count: number) {
    if (like) { picker.pickLike(unit.element); return; }
    if (count >= 2) picker.pickAndConfirm(unit); else picker.toggle(unit);
  }
  function onCancel(e: PointerEvent) {
    if (!press || e.pointerId !== press.id) return;
    press = null; picker.marquee = null; previewRects = new Map();
  }
  // The canvas's own click / dblclick (group entry, text edit, node edit) never
  // run on a press the picker owned.
  function swallow(e: MouseEvent) {
    if (e.type === "click" && pendingClick) {
      const unit = pendingClick; pendingClick = null;
      e.stopPropagation(); e.preventDefault();
      activate(unit, e.detail);
      return;
    }
    if (owns(e)) { e.stopPropagation(); e.preventDefault(); }
  }
  function onKeyState(e: KeyboardEvent) {
    if (yieldsToShellModal(e) || isAnnotateChord(e)) return;
    if (e.code === "Space") spaceHeld = e.type === "keydown";
    if (e.key === "Alt" && lastTarget && !press) { picker.hover = null; updateHover(lastTarget, e.type === "keydown"); }
  }
  $effect(() => {
    const w = wrap;
    if (!w || !armed) return;
    const opts = { capture: true } as const;
    w.addEventListener("pointerdown", onDown, opts);
    w.addEventListener("pointermove", onMove, opts);
    w.addEventListener("pointerup", onUp, opts);
    w.addEventListener("pointercancel", onCancel, opts);
    w.addEventListener("click", swallow, opts);
    w.addEventListener("dblclick", swallow, opts);
    w.addEventListener("pointerleave", onLeave);
    window.addEventListener("keydown", onKeyState, true);
    window.addEventListener("keyup", onKeyState, true);
    return () => {
      w.removeEventListener("pointerdown", onDown, opts);
      w.removeEventListener("pointermove", onMove, opts);
      w.removeEventListener("pointerup", onUp, opts);
      w.removeEventListener("pointercancel", onCancel, opts);
      w.removeEventListener("click", swallow, opts);
      w.removeEventListener("dblclick", swallow, opts);
      w.removeEventListener("pointerleave", onLeave);
      window.removeEventListener("keydown", onKeyState, true);
      window.removeEventListener("keyup", onKeyState, true);
      press = null; pendingClick = null; lastTarget = null;
    };
  });
  function onLeave() { if (!press && picker.hover) { picker.hover = null; hoverRect = null; } lastTarget = null; }
  // Escape (picker.onKey) dropped the marquee: forget the press too.
  $effect(() => { if (!picker.marquee && press?.moved) { press = null; previewRects = new Map(); } });

  // --- what to draw ---------------------------------------------------------------------------------
  const O = 2; // screen-px outset of every outline
  const out = (r: StageRect, extra = 0) => ({ x: r.x - (O + extra) / z, y: r.y - (O + extra) / z, w: r.w + (2 * (O + extra)) / z, h: r.h + (2 * (O + extra)) / z });
  // Round things get a hugging ring (each of six dense dots stays distinct);
  // everything else a rounded box.
  const ringOf = (u: PickUnit): boolean => u.part ? describe(u).kind === "point" : fig?.elements.find((e) => e.id === u.element)?.type === "ellipse";
  const picked = $derived(units.map((u, i) => ({ u, i, key: unitKey(u), r: rects.get(unitKey(u)), ring: ringOf(u) })).filter((p): p is { u: PickUnit; i: number; key: string; r: StageRect; ring: boolean } => !!p.r));
  const hover = $derived(picker.hover);
  const hoverRing = $derived(hover ? ringOf(hover.unit) : false);
  const source = $derived(sourceUnits.map((u) => rects.get(unitKey(u))).filter((r): r is StageRect => !!r));
  const showBadges = $derived(units.length > 0 && units.length <= BADGE_LIMIT);
  // Order badges sit on the outline's top-left corner — only where they help:
  // on units big enough to carry one (≥ 14 screen px) and never on top of an
  // earlier badge, so dense marker sets stay readable (their outlines say enough).
  const badges = $derived.by(() => {
    if (!showBadges) return [];
    const placed: { x: number; y: number; w: number; n: number; key: string }[] = [];
    for (const p of picked) {
      if (p.r.w * z < 14 || p.r.h * z < 14) continue;
      const n = p.i + 1, w = n >= 10 ? 15 : 11, x = p.r.x * z - O - 4, y = p.r.y * z - O - 4;
      if (placed.some((b) => x < b.x + b.w + 1 && b.x < x + w + 1 && y < b.y + 12 && b.y < y + 12)) continue;
      placed.push({ x, y, w, n, key: p.key });
    }
    return placed;
  });
</script>

{#if armed}
  <div class="pick-layer" class:adding={picker.adding} class:like={!!like} data-pick-layer={like ? "like" : picker.adding ? "add" : "pick"} aria-hidden="true">
    <div class="pick-frame" data-pick-frame style:left={`${fx}px`} style:top={`${fy}px`} style:width={`${stage.width * z}px`} style:height={`${stage.height * z}px`}></div>
    <svg class="pick-svg" xmlns="http://www.w3.org/2000/svg">
      <g transform={`translate(${fx} ${fy}) scale(${z})`}>
        {#each source as r}
          {@const b = out(r, 1)}
          <rect class="pick-source" data-pick-source x={b.x} y={b.y} width={b.w} height={b.h} rx={3 / z} vector-effect="non-scaling-stroke" />
        {/each}
        {#if !picker.adding}
          {#each picked as p (p.key)}
            {@const b = out(p.r, p.ring ? 0.5 : 0)}
            {#if p.ring}
              <ellipse class="pick-on" data-pick-unit={p.key} cx={b.x + b.w / 2} cy={b.y + b.h / 2} rx={b.w / 2} ry={b.h / 2} vector-effect="non-scaling-stroke" />
            {:else}
              <rect class="pick-on" data-pick-unit={p.key} x={b.x} y={b.y} width={b.w} height={b.h} rx={2 / z} vector-effect="non-scaling-stroke" />
            {/if}
          {/each}
          {#each [...previewRects] as [key, r] (key)}
            {@const b = out(r)}
            <rect class="pick-preview" class:remove={picker.marquee?.remove} data-pick-preview={key} x={b.x} y={b.y} width={b.w} height={b.h} rx={Math.min(b.w, b.h) / 2.5} vector-effect="non-scaling-stroke" />
          {/each}
          {#if hover && hoverRect && !picker.marquee}
            {@const b = out(hoverRect, 1)}
            {#if hoverRing}
              <ellipse class="pick-hover-halo" cx={b.x + b.w / 2} cy={b.y + b.h / 2} rx={b.w / 2} ry={b.h / 2} vector-effect="non-scaling-stroke" />
              <ellipse class="pick-hover" class:on={hover.state === "picked"} class:dim={hover.state === "source" || hover.state === "none"} data-pick-hover={unitKey(hover.unit)} cx={b.x + b.w / 2} cy={b.y + b.h / 2} rx={b.w / 2} ry={b.h / 2} vector-effect="non-scaling-stroke" />
            {:else}
              <rect class="pick-hover-halo" x={b.x} y={b.y} width={b.w} height={b.h} rx={3 / z} vector-effect="non-scaling-stroke" />
              <rect class="pick-hover" class:on={hover.state === "picked"} class:dim={hover.state === "source" || hover.state === "none"} data-pick-hover={unitKey(hover.unit)} x={b.x} y={b.y} width={b.w} height={b.h} rx={3 / z} vector-effect="non-scaling-stroke" />
            {/if}
          {/if}
          {#if picker.marquee}
            {@const m = picker.marquee.box}
            <rect class="pick-marquee" class:remove={picker.marquee.remove} data-pick-marquee x={m.x} y={m.y} width={m.w} height={m.h} vector-effect="non-scaling-stroke" />
          {/if}
        {:else}
          {#each picked as p (p.key)}
            {@const b = out(p.r)}
            <rect class="pick-on quiet" data-pick-unit={p.key} x={b.x} y={b.y} width={b.w} height={b.h} rx={2 / z} vector-effect="non-scaling-stroke" />
          {/each}
        {/if}
      </g>
      {#if badges.length && !picker.adding}
        <g transform={`translate(${fx} ${fy})`}>
          {#each badges as b (b.key)}
            <g class="pick-badge" data-pick-badge={b.n} transform={`translate(${b.x} ${b.y})`}>
              <rect width={b.w} height="11" rx="2.5" />
              <text x={b.w / 2} y="8.1">{b.n}</text>
            </g>
          {/each}
        </g>
      {/if}
    </svg>
  </div>
{/if}

<style>
  /* The mode accent: one ≤ 240 ms entry, then it RESTS (nothing animates at
     rest; reduced motion: no entry at all). */
  .pick-layer { position: absolute; inset: 0; pointer-events: none; z-index: 3; overflow: hidden; animation: pick-in 220ms ease-out; }
  @keyframes pick-in { from { opacity: 0; } to { opacity: 1; } }
  @media (prefers-reduced-motion: reduce) { .pick-layer { animation: none; } }
  .pick-frame {
    position: absolute; box-sizing: border-box; border-radius: 1px;
    /* ring · halo · the backdrop outside the frame dimmed ~6 % */
    box-shadow: 0 0 0 1.5px var(--c-pick), 0 0 22px var(--c-pick-glow), 0 0 0 200vmax rgba(0, 0, 0, 0.06);
  }
  /* Add mode: a second inner hairline marks the sub-state. */
  .pick-layer.adding .pick-frame::after { content: ""; position: absolute; inset: 4px; border: 1px dashed color-mix(in oklab, var(--c-pick) 70%, transparent); border-radius: 1px; }
  .pick-svg { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
  .pick-svg rect, .pick-svg ellipse { fill: none; }
  .pick-source { stroke: var(--c-pick); stroke-width: 1.5; stroke-dasharray: 5 3; }
  .pick-on { stroke: var(--c-pick); stroke-width: 2; fill: color-mix(in oklab, var(--c-pick) 7%, transparent) !important; }
  .pick-on.quiet { stroke-width: 1.5; stroke-opacity: 0.8; }
  .pick-preview { stroke: var(--c-pick); stroke-width: 1; stroke-dasharray: 3 2; stroke-opacity: 0.85; }
  .pick-preview.remove { stroke: var(--c-danger); }
  .pick-hover-halo { stroke: var(--c-pick); stroke-opacity: 0.25; stroke-width: 5.5; }
  .pick-hover { stroke: var(--c-pick); stroke-opacity: 0.7; stroke-width: 1.5; }
  .pick-hover.on { stroke-dasharray: 4 2; stroke-opacity: 0.9; }
  .pick-hover.dim { stroke: var(--c-tx-muted); }
  .pick-marquee { stroke: var(--c-pick); stroke-width: 1; stroke-dasharray: 4 3; fill: color-mix(in oklab, var(--c-pick) 7%, transparent) !important; }
  .pick-marquee.remove { stroke: var(--c-danger); fill: color-mix(in oklab, var(--c-danger) 6%, transparent) !important; }
  .pick-badge rect { fill: var(--c-pick) !important; }
  .pick-badge text { font: 600 8px var(--font-mono); fill: #100f0f; text-anchor: middle; }
</style>
