<script lang="ts">
  // The beat timeline — beats as columns, and INSIDE each column a mini-Gantt:
  // one lane per track, chip x-offset ∝ track.start, width ∝ duration, a hatched
  // tail for the stagger fan-out — all on ONE global px-per-ms scale so 200ms
  // reads as the same width in every beat. Direct manipulation everywhere:
  // drag a chip to retime (body = start, right edge = duration, snapping to the
  // 50ms grid + other tracks' boundaries; Alt disables), drag it OUT of its
  // column to move it to another beat (Alt = duplicate), marquee the background
  // to group-select, drag a beat header to reorder beats, hover between columns
  // to insert a beat, double-click a label to rename, cycle the advance mode
  // (click ▸ with-prev ▸ auto), right-click for the full menu. Preview commits
  // exactly once on release (the W17/FIG-1 transient-transform pattern).
  import { activeBeat, selTrackIds, commitDeck, sealHistory } from "../../../../lib/slide/store";
  import {
    slideById, addBeat as addBeatOp, deleteBeat as deleteBeatOp, duplicateBeat as duplicateBeatOp,
    reorderBeats, reorderTracks, moveTrackToBeat, duplicateTrack, setBeat,
  } from "../../../../lib/slide/ops";
  import type { Slide, Track, Beat } from "../../../../lib/slide/types";
  import type { FluxPlotManifest } from "../../../../lib/plot/types";
  import { PRESET_COLOR, chipLabel, trackFanout, beatEndMs, autoPxPerMs, snapMs } from "./shared";
  import { hoverTrackId, timelinePxPerMs, requestFlash } from "./animatorState";
  import { toggleSelectedDisabled, deleteSelectedTracks, duplicateSelectedTracks, moveSelectedToBeat } from "./trackActions";
  import TimelineMenu, { type MenuItem } from "./TimelineMenu.svelte";

  let {
    slide, plotTags, selPlotId, manifestFor, compact = false, onFocusDock, onPreviewFrom,
  }: {
    slide: Slide;
    plotTags: Map<string, string>;
    selPlotId: string | null;
    manifestFor: (target: string) => FluxPlotManifest | undefined;
    compact?: boolean;
    onFocusDock: () => void;
    onPreviewFrom?: (beat: number) => void;
  } = $props();

  const sid = $derived(slide.id);
  const isOtherPlot = (t: Track) => !!selPlotId && t.target !== selPlotId && plotTags.has(t.target);

  // --- the ONE temporal scale --------------------------------------------------
  const beatEnds = $derived(slide.beats.map((b, i) => (i === 0 ? 0 : beatEndMs(b.tracks, slide, manifestFor))));
  const pxPerMs = $derived($timelinePxPerMs ?? autoPxPerMs(Math.max(...beatEnds, 1)));
  const LANE_H = $derived(compact ? 18 : 20);
  const PAD_X = 8;
  const colW = (bi: number) => (bi === 0 ? 84 : Math.max(140, Math.round(beatEnds[bi] * pxPerMs) + PAD_X * 2 + 8));
  const rulerStep = $derived(pxPerMs >= 0.2 ? 100 : pxPerMs >= 0.08 ? 250 : 500);
  const rulerTicks = (bi: number): number[] => {
    const out: number[] = [];
    for (let t = rulerStep; t <= beatEnds[bi]; t += rulerStep) out.push(t);
    return out;
  };
  const fmtMs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(ms % 1000 ? 1 : 0)}s` : `${ms}`);
  function onWheel(e: WheelEvent) {
    if (!e.ctrlKey && !e.metaKey) return; // plain wheel keeps scrolling the row
    e.preventDefault();
    const cur = pxPerMs;
    timelinePxPerMs.set(Math.max(0.02, Math.min(0.8, cur * Math.exp(-e.deltaY * 0.002))));
  }

  // --- chip geometry -------------------------------------------------------------
  const chipX = (t: Track) => PAD_X + Math.round((t.start ?? 0) * pxPerMs);
  const chipW = (t: Track) => Math.max(18, Math.round((t.duration ?? 400) * pxPerMs));
  const tailW = (t: Track) => Math.round((t.stagger?.perMs ?? 0) * Math.max(0, trackFanout(t, slide, manifestFor(t.target)) - 1) * pxPerMs);

  // --- selection -------------------------------------------------------------------
  function selectChip(t: Track, additive: boolean) {
    if (!t.id) return;
    if (additive) selTrackIds.update((ids) => (ids.includes(t.id!) ? ids.filter((x) => x !== t.id) : [...ids, t.id!]));
    else if (!$selTrackIds.includes(t.id)) selTrackIds.set([t.id]);
  }

  // --- drag state machine ------------------------------------------------------------
  interface ChipOrig { id: string; start: number; duration: number; beatIndex: number }
  let drag = $state<
    | { kind: "chip"; mode: "armed" | "start" | "dur" | "move"; zone: "body" | "edge"; origs: ChipOrig[]; primary: ChipOrig;
        beatIndex: number; x0: number; y0: number; x1: number; y1: number; dxMs: number; overBeat: number | null; overLane: number | null; alt: boolean; magnets: number[] }
    | { kind: "beat"; mode: "armed" | "move"; beatId: string; from: number; x0: number; over: number | null }
    | { kind: "marquee"; x0: number; y0: number; x1: number; y1: number; base: string[]; rects: { id: string; r: DOMRect }[] }
    | null
  >(null);
  let timelineEl = $state<HTMLDivElement | null>(null);

  function chipDown(e: PointerEvent, t: Track, bi: number) {
    if (e.button !== 0 || !t.id || isOtherPlot(t)) return;
    e.stopPropagation();
    const additive = e.shiftKey || e.metaKey || e.ctrlKey;
    selectChip(t, additive);
    activeBeat.set(bi);
    onFocusDock();
    if (additive) return; // toggle-select only — no drag arm
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const zone: "body" | "edge" = e.clientX > rect.right - 8 ? "edge" : "body";
    const ids = $selTrackIds.includes(t.id) ? $selTrackIds : [t.id];
    const all = slide.beats.flatMap((b, i) => b.tracks.map((tk) => ({ tk, i })));
    const origs: ChipOrig[] = ids
      .map((id) => all.find((x) => x.tk.id === id))
      .filter((x): x is { tk: Track; i: number } => !!x)
      .map(({ tk, i }) => ({ id: tk.id!, start: tk.start ?? 0, duration: tk.duration ?? 400, beatIndex: i }));
    const primary = origs.find((o) => o.id === t.id)!;
    // snap magnets: the other (unselected) tracks' boundaries in this beat
    const magnets: number[] = [];
    for (const ot of slide.beats[bi].tracks) {
      if (!ot.id || ids.includes(ot.id)) continue;
      magnets.push(ot.start ?? 0, (ot.start ?? 0) + (ot.duration ?? 400));
    }
    drag = { kind: "chip", mode: "armed", zone, origs, primary, beatIndex: bi, x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY, dxMs: 0, overBeat: null, overLane: null, alt: e.altKey, magnets };
    window.addEventListener("pointermove", onDragMove);
    window.addEventListener("pointerup", onDragUp);
  }

  function headDown(e: PointerEvent, b: Beat, bi: number) {
    if (e.button !== 0 || bi === 0) return;
    if ((e.target as HTMLElement).closest("button, input, select")) return;
    drag = { kind: "beat", mode: "armed", beatId: b.id, from: bi, x0: e.clientX, over: null };
    window.addEventListener("pointermove", onDragMove);
    window.addEventListener("pointerup", onDragUp);
  }

  function timelineDown(e: PointerEvent) {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest(".trk, .head, .between, button, input, select")) return;
    const rects = Array.from(timelineEl?.querySelectorAll<HTMLElement>("[data-track-id]") ?? [])
      .filter((el) => !el.classList.contains("dim"))
      .map((el) => ({ id: el.dataset.trackId!, r: el.getBoundingClientRect() }));
    drag = { kind: "marquee", x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY, base: e.shiftKey ? [...$selTrackIds] : [], rects };
    window.addEventListener("pointermove", onDragMove);
    window.addEventListener("pointerup", onDragUp);
  }

  function beatIndexAt(x: number, y: number): number | null {
    const el = document.elementFromPoint(x, y)?.closest("[data-beat-index]") as HTMLElement | null;
    const bi = el ? Number(el.dataset.beatIndex) : NaN;
    return Number.isFinite(bi) ? bi : null;
  }

  function onDragMove(e: PointerEvent) {
    const d = drag;
    if (!d) return;
    if (d.kind === "chip") {
      const dx = e.clientX - d.x0, dy = e.clientY - d.y0;
      d.x1 = e.clientX; d.y1 = e.clientY;
      if (d.mode === "armed") {
        if (Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
        d.mode = d.zone === "edge" ? "dur" : "start";
      }
      if (d.mode === "start" || d.mode === "dur") {
        // a body-drag that reaches ANOTHER column (or leaves the timeline with
        // real vertical intent) upgrades to a move-to-beat; edge (duration)
        // drags never upgrade.
        const over = beatIndexAt(e.clientX, e.clientY);
        if (d.mode === "start" && ((over != null && over !== d.beatIndex) || (over === null && Math.abs(dy) > 30))) {
          d.mode = "move";
        } else {
          const raw = (d.mode === "start" ? d.primary.start : d.primary.duration) + dx / pxPerMs;
          const snapped = snapMs(raw, d.mode === "start" ? d.magnets : d.magnets.map((m) => m - d.primary.start), pxPerMs, !e.altKey);
          d.dxMs = snapped - (d.mode === "start" ? d.primary.start : d.primary.duration);
          drag = { ...d };
          return;
        }
      }
      if (d.mode === "move") {
        d.overBeat = beatIndexAt(e.clientX, e.clientY);
        if (d.overBeat === 0) d.overBeat = null; // never drop into the resting state
        if (d.overBeat != null) {
          const lanes = timelineEl?.querySelector<HTMLElement>(`[data-beat-index="${d.overBeat}"] .lanes`);
          const r = lanes?.getBoundingClientRect();
          const n = slide.beats[d.overBeat]?.tracks.length ?? 0;
          d.overLane = r ? Math.max(0, Math.min(n, Math.floor((e.clientY - r.top) / LANE_H + 0.5))) : n;
        } else d.overLane = null;
        d.alt = e.altKey;
        drag = { ...d };
      }
    } else if (d.kind === "beat") {
      if (d.mode === "armed" && Math.abs(e.clientX - d.x0) < 4) return;
      d.mode = "move";
      const over = beatIndexAt(e.clientX, e.clientY);
      d.over = over != null && over > 0 ? over : d.over;
      drag = { ...d };
    } else if (d.kind === "marquee") {
      d.x1 = e.clientX; d.y1 = e.clientY;
      const lo = { x: Math.min(d.x0, d.x1), y: Math.min(d.y0, d.y1) };
      const hi = { x: Math.max(d.x0, d.x1), y: Math.max(d.y0, d.y1) };
      const hit = d.rects.filter(({ r }) => r.left < hi.x && r.right > lo.x && r.top < hi.y && r.bottom > lo.y).map((x) => x.id);
      selTrackIds.set([...new Set([...d.base, ...hit])]);
      drag = { ...d };
    }
  }

  function onDragUp() {
    const d = drag;
    endDrag();
    if (!d) return;
    if (d.kind === "chip") {
      if (d.mode === "armed") {
        // a plain click on an already-multi-selected chip collapses to just it
        if ($selTrackIds.length > 1 && $selTrackIds.includes(d.primary.id)) selTrackIds.set([d.primary.id]);
        requestFlash(d.primary.id);
        return;
      }
      if ((d.mode === "start" || d.mode === "dur") && d.dxMs !== 0) {
        const field = d.mode === "start" ? "start" : "duration";
        const byId = new Map(d.origs.map((o) => [o.id, o] as const));
        commitDeck((dd) => {
          const s = slideById(dd, sid);
          if (!s) return;
          for (const b of s.beats) for (const t of b.tracks) {
            const o = t.id && byId.get(t.id);
            if (!o) continue;
            if (field === "start") t.start = Math.max(0, o.start + d.dxMs);
            else t.duration = Math.max(50, o.duration + d.dxMs);
          }
        });
        sealHistory();
      } else if (d.mode === "move" && d.overBeat != null) {
        const toId = slide.beats[d.overBeat]?.id;
        if (!toId) return;
        if (d.alt) {
          const copies: string[] = [];
          commitDeck((dd) => {
            for (const o of d.origs) {
              const nid = duplicateTrack(dd, sid, o.id);
              if (nid) { moveTrackToBeat(dd, sid, nid, toId, d.overLane ?? undefined); copies.push(nid); }
            }
          });
          if (copies.length) selTrackIds.set(copies);
        } else if (d.overBeat === d.beatIndex && d.overLane != null) {
          // same-beat vertical drag = reorder lanes
          const ids = slide.beats[d.beatIndex].tracks.map((t) => t.id!).filter(Boolean);
          const moving = d.origs.map((o) => o.id);
          const rest = ids.filter((id) => !moving.includes(id));
          const at = Math.max(0, Math.min(rest.length, d.overLane - moving.filter((id) => ids.indexOf(id) < d.overLane!).length));
          rest.splice(at, 0, ...moving);
          commitDeck((dd) => reorderTracks(dd, sid, toId, rest));
        } else {
          moveSelectedToBeat(toId, d.overLane ?? undefined);
          activeBeat.set(d.overBeat);
        }
        sealHistory();
      }
    } else if (d.kind === "beat" && d.mode === "move" && d.over != null && d.over !== d.from) {
      const movable = slide.beats.slice(1).map((b) => b.id).filter((id) => id !== d.beatId);
      const at = Math.max(0, Math.min(movable.length, d.over - 1));
      movable.splice(at, 0, d.beatId);
      commitDeck((dd) => reorderBeats(dd, sid, movable));
      activeBeat.set(d.over);
      sealHistory();
    }
  }
  function endDrag() {
    drag = null;
    window.removeEventListener("pointermove", onDragMove);
    window.removeEventListener("pointerup", onDragUp);
  }
  function onKeyCancel(e: KeyboardEvent) {
    if (e.key === "Escape" && drag) { e.stopPropagation(); endDrag(); }
  }

  // live preview transforms while dragging
  const dragging = (t: Track): string => {
    const d = drag;
    if (!d || d.kind !== "chip" || !t.id) return "";
    const isSel = d.origs.some((o) => o.id === t.id);
    if (!isSel) return "";
    if (d.mode === "start") return `transform: translateX(${Math.round(d.dxMs * pxPerMs)}px)`;
    if (d.mode === "dur") {
      const o = d.origs.find((x) => x.id === t.id)!;
      return `width: ${Math.max(18, Math.round((o.duration + d.dxMs) * pxPerMs))}px`;
    }
    if (d.mode === "move") return "opacity: 0.35; pointer-events: none";
    return "";
  };
  const dragTip = $derived.by(() => {
    const d = drag;
    if (!d || d.kind !== "chip") return null;
    if (d.mode === "start") return `start ${Math.max(0, Math.round(d.primary.start + d.dxMs))}ms`;
    if (d.mode === "dur") return `${Math.max(50, Math.round(d.primary.duration + d.dxMs))}ms`;
    if (d.mode === "move") return d.overBeat != null ? `${d.alt ? "copy" : "move"} → beat ${d.overBeat}` : "drop on a beat";
    return null;
  });

  // --- beat header widgets ---------------------------------------------------------
  let editingBeatId = $state<string | null>(null);
  function commitLabel(b: Beat, v: string) {
    commitDeck((d) => setBeat(d, sid, b.id, { label: v.trim() }), { coalesce: `beat-label:${b.id}` });
    sealHistory();
    editingBeatId = null;
  }
  const ADV_ICON: Record<string, string> = { click: "🖱", "with-prev": "⛓", auto: "⏱" };
  const ADV_TITLE: Record<string, string> = {
    click: "Advances on click — press to cycle to with-prev",
    "with-prev": "Plays WITH the previous beat's press — press to cycle to auto",
    auto: "Plays automatically after the previous beat — press to cycle to click",
  };
  function cycleAdvance(b: Beat) {
    const order: Beat["advance"][] = ["click", "with-prev", "auto"];
    const next = order[(order.indexOf(b.advance ?? "click") + 1) % order.length];
    commitDeck((d) => setBeat(d, sid, b.id, { advance: next, ...(next === "auto" ? { autoDelayMs: b.autoDelayMs ?? 600 } : {}) }));
  }
  function setAutoDelay(b: Beat, v: number) {
    commitDeck((d) => setBeat(d, sid, b.id, { autoDelayMs: Math.max(0, v) }), { coalesce: `auto-delay:${b.id}` });
  }
  function insertBeatAt(at: number) {
    let idx = at;
    commitDeck((d) => { addBeatOp(d, sid, { advance: "click", at }); idx = at; });
    activeBeat.set(idx);
  }
  function removeBeat(beatId: string, bi: number) {
    if (bi === 0) return;
    commitDeck((d) => deleteBeatOp(d, sid, beatId));
    if ($activeBeat >= bi) activeBeat.set(Math.max(0, $activeBeat - 1));
    selTrackIds.set([]);
  }

  // --- context menus -----------------------------------------------------------------
  let menu = $state<{ x: number; y: number; items: MenuItem[] } | null>(null);
  function chipCtx(e: MouseEvent, t: Track) {
    e.preventDefault();
    e.stopPropagation();
    if (!t.id || isOtherPlot(t)) return;
    if (!$selTrackIds.includes(t.id)) selTrackIds.set([t.id]);
    const n = $selTrackIds.length;
    const anyEnabled = slide.beats.flatMap((b) => b.tracks).filter((x) => x.id && $selTrackIds.includes(x.id)).some((x) => !x.disabled);
    const items: MenuItem[] = [
      { label: `Duplicate${n > 1 ? ` ${n}` : ""} (⌘D)`, action: () => duplicateSelectedTracks() },
      { label: anyEnabled ? "Disable (x)" : "Enable (x)", action: () => toggleSelectedDisabled() },
      { divider: true, label: "" },
      ...slide.beats.slice(1).map((b, i): MenuItem => ({
        label: `Move to beat ${i + 1}${b.label ? ` · ${b.label}` : ""}`,
        disabled: false,
        action: () => moveSelectedToBeat(b.id),
      })),
      { divider: true, label: "" },
      { label: `Delete${n > 1 ? ` ${n} tracks` : ""} (⌫)`, danger: true, action: () => deleteSelectedTracks() },
    ];
    menu = { x: e.clientX, y: e.clientY, items };
  }
  function beatCtx(e: MouseEvent, b: Beat, bi: number) {
    e.preventDefault();
    e.stopPropagation();
    if (bi === 0) return;
    menu = {
      x: e.clientX, y: e.clientY,
      items: [
        { label: "Rename", action: () => (editingBeatId = b.id) },
        { label: "Duplicate beat", action: () => commitDeck((d) => void duplicateBeatOp(d, sid, b.id)) },
        { label: "Insert beat before", action: () => insertBeatAt(bi) },
        { label: "Insert beat after", action: () => insertBeatAt(bi + 1) },
        { divider: true, label: "" },
        { label: "Delete beat", danger: true, action: () => removeBeat(b.id, bi) },
      ],
    };
  }
</script>

<svelte:window onkeydown={onKeyCancel} />
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="timeline" bind:this={timelineEl} onpointerdown={timelineDown} onwheel={onWheel}
  title="Ctrl+wheel: zoom the time scale · drag background: marquee-select tracks">
  {#each slide.beats as b, bi (b.id)}
    {#if bi > 0}
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <div class="between" onclick={() => insertBeatAt(bi)} title="Insert a beat here" role="button" tabindex="-1">
        <span class="plus">+</span>
      </div>
    {/if}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="col" class:cur={bi === $activeBeat} class:chain={b.advance === "with-prev"}
      class:drop={drag?.kind === "chip" && drag.mode === "move" && drag.overBeat === bi}
      class:beat-over={drag?.kind === "beat" && drag.mode === "move" && drag.over === bi}
      data-beat-index={bi}
      style={`width:${colW(bi)}px`}
      onclick={() => { activeBeat.set(bi); onFocusDock(); }}>
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="head" onpointerdown={(e) => headDown(e, b, bi)} oncontextmenu={(e) => beatCtx(e, b, bi)}
        title={bi > 0 ? "Drag to reorder beats · double-click the name to rename · right-click for more" : "The slide's resting state"}>
        <span class="bi">{bi === 0 ? "Start" : bi}</span>
        {#if bi > 0}
          {#if editingBeatId === b.id}
            <!-- svelte-ignore a11y_autofocus -->
            <input class="lab-in" autofocus value={b.label ?? ""}
              onblur={(e) => commitLabel(b, e.currentTarget.value)}
              onkeydown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); if (e.key === "Escape") { editingBeatId = null; } e.stopPropagation(); }} />
          {:else}
            <span class="lab" ondblclick={() => (editingBeatId = b.id)}>{b.label ?? ""}</span>
          {/if}
          <button class="adv" title={ADV_TITLE[b.advance ?? "click"]} onclick={(e) => { e.stopPropagation(); cycleAdvance(b); }}>{ADV_ICON[b.advance ?? "click"]}</button>
          {#if b.advance === "auto"}
            <input class="delay" type="number" min="0" step="100" value={b.autoDelayMs ?? 600}
              title="Delay after the previous beat finishes (ms)"
              onclick={(e) => e.stopPropagation()}
              onchange={(e) => setAutoDelay(b, +e.currentTarget.value)} />
          {/if}
          {#if b.tracks.length}<span class="total">{fmtMs(beatEnds[bi])}{beatEnds[bi] >= 1000 ? "" : "ms"}</span>{/if}
          {#if onPreviewFrom}
            <button class="pv" title="Play from this beat" onclick={(e) => { e.stopPropagation(); onPreviewFrom?.(bi); }}>▶</button>
          {/if}
          <button class="bx" title="Delete this beat" onclick={(e) => { e.stopPropagation(); removeBeat(b.id, bi); }}>✕</button>
        {/if}
      </div>
      {#if bi === 0}
        <div class="rest">resting state</div>
      {:else}
        {#if !compact}
          <div class="ruler">
            {#each rulerTicks(bi) as t (t)}
              <span class="rt" style={`left:${PAD_X + t * pxPerMs}px`}>{fmtMs(t)}</span>
            {/each}
          </div>
        {/if}
        <div class="lanes" style={`height:${Math.max(1, b.tracks.length) * LANE_H + 6}px`}>
          {#if !b.tracks.length}
            <div class="rest">no animations — drag a chip or part here</div>
          {/if}
          {#each b.tracks as t, ti (t.id ?? ti)}
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div class="trk" class:sel={!!t.id && $selTrackIds.includes(t.id)} class:dim={isOtherPlot(t)} class:dis={t.disabled}
              data-track-id={t.id}
              style={`--pc:${PRESET_COLOR[t.preset ?? "fade"] ?? "#888"}; left:${chipX(t)}px; top:${ti * LANE_H + 3}px; width:${chipW(t)}px; height:${LANE_H - 4}px; ${dragging(t)}`}
              title={isOtherPlot(t)
                ? "Belongs to another plot — select that plot to edit it"
                : `${chipLabel(t, slide, plotTags)} · ${t.preset ?? "fade"}${t.disabled ? " · disabled" : ""}\ndrag = retime · right edge = duration · drag out = move to another beat (Alt copies)`}
              onpointerdown={(e) => chipDown(e, t, bi)}
              oncontextmenu={(e) => chipCtx(e, t)}
              onpointerenter={() => hoverTrackId.set(t.id ?? null)}
              onpointerleave={() => hoverTrackId.set(null)}>
              <span class="dot" class:hollow={t.disabled}></span>
              <span class="nm">{chipLabel(t, slide, plotTags)}</span>
              {#if tailW(t) > 2}<span class="tail" style={`width:${tailW(t)}px`} title="stagger fan-out"></span>{/if}
              <span class="edge"></span>
            </div>
            {#if drag?.kind === "chip" && drag.mode === "move" && drag.overBeat === bi && drag.overLane === ti}
              <div class="lane-ins" style={`top:${ti * LANE_H + 1}px`}></div>
            {/if}
          {/each}
          {#if drag?.kind === "chip" && drag.mode === "move" && drag.overBeat === bi && drag.overLane === b.tracks.length}
            <div class="lane-ins" style={`top:${b.tracks.length * LANE_H + 1}px`}></div>
          {/if}
        </div>
      {/if}
    </div>
  {/each}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div class="between end" onclick={() => insertBeatAt(slide.beats.length)} title="Add a beat" role="button" tabindex="-1">
    <span class="plus">+</span>
  </div>

  {#if drag?.kind === "marquee"}
    <div class="marquee" style={`left:${Math.min(drag.x0, drag.x1)}px; top:${Math.min(drag.y0, drag.y1)}px; width:${Math.abs(drag.x1 - drag.x0)}px; height:${Math.abs(drag.y1 - drag.y0)}px`}></div>
  {/if}
  {#if dragTip && drag?.kind === "chip"}
    <div class="dragtip" style={`left:${drag.x1 + 12}px; top:${drag.y1 - 28}px`}>{dragTip}</div>
  {/if}
</div>

{#if menu}
  <TimelineMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => (menu = null)} />
{/if}

<style>
  .timeline {
    flex: 1; min-width: 0;
    display: flex; gap: 2px; overflow-x: auto; overflow-y: auto; padding-bottom: 4px;
    align-items: flex-start; min-height: 96px; position: relative;
  }
  .col {
    flex: 0 0 auto;
    border: 1px solid var(--c-line, #282726); border-radius: 6px;
    background: var(--c-bg-2, #16100f00); cursor: pointer; overflow: hidden;
    display: flex; flex-direction: column;
  }
  .col:hover { border-color: var(--c-line-strong, #343331); }
  .col.cur { border-color: var(--c-accent, #4385be); box-shadow: inset 0 0 0 1px var(--c-accent, #4385be); }
  .col.chain { border-left-style: dashed; }
  .col.drop { border-color: var(--c-accent-2, #3aa99f); box-shadow: inset 0 0 0 1px var(--c-accent-2, #3aa99f); }
  .col.beat-over { outline: 2px dashed var(--c-accent, #4385be); outline-offset: 1px; }
  .between {
    flex: 0 0 8px; align-self: stretch; display: flex; align-items: center; justify-content: center;
    cursor: pointer; border-radius: 4px; min-height: 60px;
  }
  .between .plus {
    opacity: 0; font-size: 12px; font-weight: 700; color: var(--c-bg, #100f0f);
    background: var(--c-accent, #4385be); border-radius: 50%; width: 15px; height: 15px;
    line-height: 15px; text-align: center; transition: opacity 0.1s;
  }
  .between:hover .plus { opacity: 1; }
  .between.end { flex-basis: 26px; }
  .head {
    display: flex; align-items: center; gap: 5px; padding: 3px 7px; position: relative;
    background: var(--c-bg-3, #1c1b1a); border-bottom: 1px solid var(--c-line, #282726);
    min-height: 22px;
  }
  .col.chain .head { background: color-mix(in oklab, var(--c-accent, #4385be) 10%, var(--c-bg-3, #1c1b1a)); }
  .bi { font-size: 12px; font-weight: 700; color: var(--c-tx-hi, #cecdc3); }
  .lab { font-size: 10px; color: var(--c-tx-3, #878580); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 110px; min-width: 8px; }
  .lab-in {
    font-size: 10px; width: 84px; color: var(--c-tx, #cecdc3); background: var(--c-bg, #100f0f);
    border: 1px solid var(--c-accent, #4385be); border-radius: 3px; padding: 0 3px;
  }
  .adv { border: none; background: none; cursor: pointer; font-size: 10px; padding: 0 1px; opacity: 0.75; }
  .adv:hover { opacity: 1; }
  .delay {
    width: 44px; font-size: 9px; color: var(--c-tx-2, #b7b5ac); background: var(--c-bg, #100f0f);
    border: 1px solid var(--c-line-strong, #343331); border-radius: 3px; padding: 0 3px;
  }
  .total { font-size: 9px; color: var(--c-tx-3, #6f6e69); margin-left: auto; }
  .pv, .bx {
    width: 15px; height: 15px; padding: 0; flex: 0 0 auto;
    border: none; background: none; color: var(--c-tx-3, #6f6e69); cursor: pointer; font-size: 9px; opacity: 0;
  }
  .total + .pv, .total + .pv + .bx { margin-left: 0; }
  .pv { margin-left: auto; }
  .total ~ .pv { margin-left: 2px; }
  .col:hover .pv, .col:hover .bx { opacity: 1; }
  .pv:hover { color: var(--c-accent, #4385be); }
  .bx:hover { color: var(--c-danger, #d14d41); }
  .ruler { position: relative; height: 11px; border-bottom: 1px dashed color-mix(in oklab, var(--c-line, #282726) 70%, transparent); margin: 0 0 1px; }
  .rt {
    position: absolute; top: 0; font-size: 8px; color: var(--c-tx-faint, #575653);
    border-left: 1px solid var(--c-line, #282726); padding-left: 2px; line-height: 11px;
  }
  .rest { font-size: 10px; color: var(--c-tx-3, #6f6e69); font-style: italic; padding: 6px; }
  .lanes { position: relative; min-height: 26px; }
  .trk {
    position: absolute; display: flex; align-items: center; gap: 4px;
    font-size: 10.5px; padding: 0 4px; border-radius: 4px; cursor: grab;
    background: color-mix(in oklab, var(--pc) 16%, var(--c-bg-2, #1c1b1a));
    border: 1px solid color-mix(in oklab, var(--pc) 45%, transparent);
    overflow: visible; white-space: nowrap; user-select: none;
  }
  .trk:hover { background: color-mix(in oklab, var(--pc) 26%, var(--c-bg-2, #1c1b1a)); z-index: 2; }
  .trk.sel { outline: 1.5px solid var(--pc); z-index: 3; }
  .trk.dim { opacity: 0.35; cursor: default; }
  .trk.dis { opacity: 0.38; border-style: dashed; }
  .trk .dot { width: 6px; height: 6px; border-radius: 2px; background: var(--pc); flex: 0 0 auto; }
  .trk .dot.hollow { background: transparent; border: 1.5px solid var(--pc); }
  .trk .nm { color: var(--c-tx, #cecdc3); overflow: hidden; text-overflow: ellipsis; }
  .trk .tail {
    position: absolute; left: 100%; top: 30%; height: 40%; border-radius: 0 3px 3px 0;
    background: repeating-linear-gradient(-55deg, color-mix(in oklab, var(--pc) 55%, transparent) 0 3px, transparent 3px 6px);
    pointer-events: none;
  }
  .trk .edge { position: absolute; right: -2px; top: 0; width: 8px; height: 100%; cursor: ew-resize; }
  .lane-ins { position: absolute; left: 4px; right: 4px; height: 2px; background: var(--c-accent-2, #3aa99f); border-radius: 1px; z-index: 4; }
  .marquee {
    position: fixed; z-index: 60; pointer-events: none;
    border: 1px solid var(--c-accent, #4385be);
    background: color-mix(in oklab, var(--c-accent, #4385be) 12%, transparent);
  }
  .dragtip {
    position: fixed; z-index: 70; pointer-events: none;
    font-size: 10px; color: var(--c-tx-hi, #fff); background: var(--c-bg-2, #1c1b1a);
    border: 1px solid var(--c-accent, #4385be); border-radius: 4px; padding: 2px 6px;
  }
</style>
