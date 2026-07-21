<script lang="ts">
  // The Animator's beats rail (animation rework §6 — the mockups' layout):
  // every beat renders as a compact CHIP (label + stacked micro-bars colored
  // by family + advance glyph); exactly ONE beat — the active one — expands
  // into the full within-beat timeline: collapsible TRACK GROUPS, one lane
  // per track (appearance bars; transform lanes with t₁/t₂ endpoint
  // handles), and a beat-local ms ruler, all on one px-per-ms scale.
  // Direct manipulation carried over from the old BeatTimeline (drag = retime,
  // right edge = duration, drag out = move to another beat/chip — Alt copies,
  // marquee select, beat-header drag = reorder, hover-between = insert,
  // double-click label = rename, advance-mode cycle, context menus), and
  // preview commits exactly once on release.
  //
  // (The plan sketched BeatChip/BeatExpanded/TrackGroupBox/TrackBar/
  // TransformBar/TimeRuler as separate files; they are render SECTIONS of
  // this one component so the drag state machine stays whole.)
  import { activeBeat, selTrackIds, commitDeckLive, sealHistory, endpointEdit, enterEndpointEdit } from "../../../../lib/slide/store";
  import { familyOf } from "../../../../lib/slide/family";
  import {
    slideById, addBeat as addBeatOp, deleteBeat as deleteBeatOp, duplicateBeat as duplicateBeatOp,
    reorderBeats, reorderTracks, moveTrackToBeat, duplicateTrack, setBeat, setTrackGroup,
    groupTracks as groupTracksOp, ungroupTracks as ungroupTracksOp,
  } from "../../../../lib/slide/ops";
  import type { Slide, Track, Beat, TrackGroup } from "../../../../lib/slide/types";
  import type { FluxPlotManifest } from "../../../../lib/plot/types";
  import { PRESET_COLOR, chipLabel, trackFanout, beatEndMs, autoPxPerMs, snapMs, isDanglingTrack } from "./shared";
  import { hoverTrackId, timelinePxPerMs, requestFlash } from "./animatorState";
  import { toggleSelectedDisabled, deleteSelectedTracks, duplicateSelectedTracks, moveSelectedToBeat } from "./trackActions";
  import { openTrackCascade } from "./cascadeTracks";
  import TimelineMenu, { type MenuItem } from "./TimelineMenu.svelte";

  let {
    slide, plotTags, manifestFor, onFocusDock, onPreviewFrom,
  }: {
    slide: Slide;
    plotTags: Map<string, string>;
    manifestFor: (target: string) => FluxPlotManifest | undefined;
    onFocusDock: () => void;
    onPreviewFrom?: (beat: number) => void;
  } = $props();

  const sid = $derived(slide.id);

  // --- the ONE temporal scale --------------------------------------------------
  const beatEnds = $derived(slide.beats.map((b, i) => (i === 0 ? 0 : beatEndMs(b.tracks, slide, manifestFor))));
  const pxPerMs = $derived($timelinePxPerMs ?? autoPxPerMs(Math.max(...beatEnds, 1)));
  const LANE_H = 20;
  const PAD_X = 8;
  const rulerStep = $derived(pxPerMs >= 0.2 ? 100 : pxPerMs >= 0.08 ? 250 : 500);
  const rulerTicks = (bi: number): number[] => {
    const out: number[] = [];
    for (let t = rulerStep; t <= beatEnds[bi]; t += rulerStep) out.push(t);
    return out;
  };
  const fmtMs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(ms % 1000 ? 1 : 0)}s` : `${ms}`);
  function onWheel(e: WheelEvent) {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    const cur = pxPerMs;
    timelinePxPerMs.set(Math.max(0.02, Math.min(0.8, cur * Math.exp(-e.deltaY * 0.002))));
  }

  // --- chip geometry -------------------------------------------------------------
  const chipX = (t: Track) => PAD_X + Math.round((t.start ?? 0) * pxPerMs);
  const chipW = (t: Track) => Math.max(18, Math.round((t.duration ?? 400) * pxPerMs));
  const tailW = (t: Track) => Math.round((t.stagger?.perMs ?? 0) * Math.max(0, trackFanout(t, slide, manifestFor(t.target)) - 1) * pxPerMs);
  const trackColor = (t: Track) => PRESET_COLOR[t.preset ?? "fade"] ?? "#888";

  // --- the expanded beat's ROW model (groups + lanes) ---------------------------
  type LaneRow =
    | { kind: "group"; group: TrackGroup; tracks: Track[]; collapsed: boolean }
    | { kind: "track"; track: Track; inGroup: boolean };
  function rowsOf(b: Beat): LaneRow[] {
    const rows: LaneRow[] = [];
    const seenGroups = new Set<string>();
    for (const t of b.tracks) {
      const gid = t.groupId;
      const g = gid ? b.groups?.find((x) => x.id === gid) : undefined;
      if (g) {
        if (seenGroups.has(g.id)) continue; // group emitted at its first member
        seenGroups.add(g.id);
        const members = b.tracks.filter((x) => x.groupId === g.id);
        rows.push({ kind: "group", group: g, tracks: members, collapsed: !!g.collapsed });
        if (!g.collapsed) for (const m of members) rows.push({ kind: "track", track: m, inGroup: true });
      } else {
        rows.push({ kind: "track", track: t, inGroup: false });
      }
    }
    return rows;
  }
  const groupSpan = (tracks: Track[]) => {
    let lo = Infinity, hi = 1;
    for (const t of tracks) {
      lo = Math.min(lo, t.start ?? 0);
      hi = Math.max(hi, (t.start ?? 0) + (t.duration ?? 400) + (t.stagger?.perMs ?? 0) * Math.max(0, trackFanout(t, slide, manifestFor(t.target)) - 1));
    }
    return { lo: Number.isFinite(lo) ? lo : 0, hi };
  };
  const activeRows = $derived(slide.beats[$activeBeat] ? rowsOf(slide.beats[$activeBeat]) : []);

  // --- micro-bars for collapsed chips -------------------------------------------
  const MICRO_MAX = 5;
  function microBars(b: Beat, bi: number): { color: string; x: number; w: number }[] {
    const end = Math.max(1, beatEnds[bi]);
    return b.tracks.slice(0, MICRO_MAX).map((t) => ({
      color: trackColor(t),
      x: Math.min(86, ((t.start ?? 0) / end) * 46),
      w: Math.max(6, Math.min(46, ((t.duration ?? 400) / end) * 46)),
    }));
  }

  // --- selection -------------------------------------------------------------------
  function selectChip(t: Track, additive: boolean) {
    if (!t.id) return;
    if (additive) selTrackIds.update((ids) => (ids.includes(t.id!) ? ids.filter((x) => x !== t.id) : [...ids, t.id!]));
    else if (!$selTrackIds.includes(t.id)) selTrackIds.set([t.id]);
  }
  function selectGroup(g: TrackGroup, tracks: Track[]) {
    selTrackIds.set(tracks.map((t) => t.id!).filter(Boolean));
    void g;
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
  let railEl = $state<HTMLDivElement | null>(null);

  function chipDown(e: PointerEvent, t: Track, bi: number) {
    if (e.button !== 0 || !t.id) return;
    e.stopPropagation();
    const additive = e.shiftKey || e.metaKey || e.ctrlKey;
    selectChip(t, additive);
    onFocusDock();
    if (additive) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const zone: "body" | "edge" = e.clientX > rect.right - 8 ? "edge" : "body";
    const ids = $selTrackIds.includes(t.id) ? $selTrackIds : [t.id];
    const all = slide.beats.flatMap((b, i) => b.tracks.map((tk) => ({ tk, i })));
    const origs: ChipOrig[] = ids
      .map((id) => all.find((x) => x.tk.id === id))
      .filter((x): x is { tk: Track; i: number } => !!x)
      .map(({ tk, i }) => ({ id: tk.id!, start: tk.start ?? 0, duration: tk.duration ?? 400, beatIndex: i }));
    const primary = origs.find((o) => o.id === t.id)!;
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

  function lanesDown(e: PointerEvent) {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest(".trk, .grp-row, .head, .between, button, input, select")) return;
    const rects = Array.from(railEl?.querySelectorAll<HTMLElement>("[data-track-id]") ?? [])
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
        const over = beatIndexAt(e.clientX, e.clientY);
        if (d.mode === "start" && ((over != null && over !== d.beatIndex) || (over === null && Math.abs(dy) > 34))) {
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
        if (d.overBeat != null && d.overBeat === $activeBeat) {
          const lanes = railEl?.querySelector<HTMLElement>(".lanes");
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
        if ($selTrackIds.length > 1 && $selTrackIds.includes(d.primary.id)) selTrackIds.set([d.primary.id]);
        requestFlash(d.primary.id);
        return;
      }
      if ((d.mode === "start" || d.mode === "dur") && d.dxMs !== 0) {
        const field = d.mode === "start" ? "start" : "duration";
        const byId = new Map(d.origs.map((o) => [o.id, o] as const));
        commitDeckLive((dd) => {
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
          commitDeckLive((dd) => {
            for (const o of d.origs) {
              const nid = duplicateTrack(dd, sid, o.id);
              if (nid) { moveTrackToBeat(dd, sid, nid, toId, d.overLane ?? undefined); copies.push(nid); }
            }
          });
          if (copies.length) selTrackIds.set(copies);
        } else if (d.overBeat === d.beatIndex && d.overLane != null) {
          const ids = slide.beats[d.beatIndex].tracks.map((t) => t.id!).filter(Boolean);
          const moving = d.origs.map((o) => o.id);
          const rest = ids.filter((id) => !moving.includes(id));
          const at = Math.max(0, Math.min(rest.length, d.overLane - moving.filter((id) => ids.indexOf(id) < d.overLane!).length));
          rest.splice(at, 0, ...moving);
          commitDeckLive((dd) => reorderTracks(dd, sid, toId, rest));
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
      commitDeckLive((dd) => reorderBeats(dd, sid, movable));
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
    commitDeckLive((d) => setBeat(d, sid, b.id, { label: v.trim() }), { coalesce: `beat-label:${b.id}` });
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
    commitDeckLive((d) => setBeat(d, sid, b.id, { advance: next, ...(next === "auto" ? { autoDelayMs: b.autoDelayMs ?? 600 } : {}) }));
  }
  function setAutoDelay(b: Beat, v: number) {
    commitDeckLive((d) => setBeat(d, sid, b.id, { autoDelayMs: Math.max(0, v) }), { coalesce: `auto-delay:${b.id}` });
  }
  function insertBeatAt(at: number) {
    commitDeckLive((d) => { addBeatOp(d, sid, { advance: "click", at }); });
    activeBeat.set(at);
  }
  function removeBeat(beatId: string, bi: number) {
    if (bi === 0) return;
    commitDeckLive((d) => deleteBeatOp(d, sid, beatId));
    if ($activeBeat >= bi) activeBeat.set(Math.max(0, $activeBeat - 1));
    selTrackIds.set([]);
  }
  function toggleGroupCollapsed(g: TrackGroup) {
    const beatId = slide.beats[$activeBeat]?.id;
    if (!beatId) return;
    commitDeckLive((d) => setTrackGroup(d, sid, beatId, g.id, { collapsed: !g.collapsed }));
  }

  // group / ungroup the current lane selection (Ctrl+G / Ctrl+Shift+G land in
  // the dock cockpit — these are also reachable from the context menu)
  export function groupSelection() {
    const beatId = slide.beats[$activeBeat]?.id;
    const ids = $selTrackIds;
    if (!beatId || ids.length < 1) return;
    commitDeckLive((d) => groupTracksOp(d, sid, beatId, ids, "Group"));
  }
  export function ungroupSelection() {
    const beatId = slide.beats[$activeBeat]?.id;
    const ids = $selTrackIds;
    if (!beatId || !ids.length) return;
    commitDeckLive((d) => ungroupTracksOp(d, sid, beatId, ids));
  }

  // --- context menus -----------------------------------------------------------------
  let menu = $state<{ x: number; y: number; items: MenuItem[] } | null>(null);
  function chipCtx(e: MouseEvent, t: Track) {
    e.preventDefault();
    e.stopPropagation();
    if (!t.id) return;
    if (!$selTrackIds.includes(t.id)) selTrackIds.set([t.id]);
    const n = $selTrackIds.length;
    const anyEnabled = slide.beats.flatMap((b) => b.tracks).filter((x) => x.id && $selTrackIds.includes(x.id)).some((x) => !x.disabled);
    const anyGrouped = slide.beats.flatMap((b) => b.tracks).filter((x) => x.id && $selTrackIds.includes(x.id)).some((x) => x.groupId);
    const items: MenuItem[] = [
      { label: `Duplicate${n > 1 ? ` ${n}` : ""} (⌘D)`, action: () => duplicateSelectedTracks() },
      { label: anyEnabled ? "Disable (x)" : "Enable (x)", action: () => toggleSelectedDisabled() },
      ...(n > 1 ? [{ label: `Cascade ${n}… (⌃⇧C)`, action: () => openTrackCascade() }] : []),
      { label: `Group${n > 1 ? ` ${n}` : ""} (⌘G)`, action: () => groupSelection() },
      ...(anyGrouped ? [{ label: "Ungroup (⌘⇧G)", action: () => ungroupSelection() }] : []),
      { divider: true, label: "" },
      ...slide.beats.slice(1).map((b, i): MenuItem => ({
        label: `Move to beat ${i + 1}${b.label ? ` · ${b.label}` : ""}`,
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
        { label: "Duplicate beat", action: () => commitDeckLive((d) => void duplicateBeatOp(d, sid, b.id)) },
        { label: "Insert beat before", action: () => insertBeatAt(bi) },
        { label: "Insert beat after", action: () => insertBeatAt(bi + 1) },
        { divider: true, label: "" },
        { label: "Delete beat", danger: true, action: () => removeBeat(b.id, bi) },
      ],
    };
  }
  function endpointOn(t: Track, end: "t1" | "t2"): boolean {
    const ee = $endpointEdit;
    if (!ee || ee.end !== end || !t.id) return false;
    return ee.entries.some((en) => en.trackId === t.id || (end === "t1" && en.target === t.target));
  }
</script>

<svelte:window onkeydown={onKeyCancel} />
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="beatrail" bind:this={railEl} onwheel={onWheel}
  title="Click a beat to expand it · Ctrl+wheel zooms the time scale">
  {#each slide.beats as b, bi (b.id)}
    {#if bi > 0}
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <div class="between" onclick={() => insertBeatAt(bi)} title="Insert a beat here" role="button" tabindex="-1">
        <span class="plus">+</span>
      </div>
    {/if}
    {#if bi === $activeBeat}
      <!-- ═══ the EXPANDED beat ═══ -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="beat-x" class:chain={b.advance === "with-prev"}
        class:drop={drag?.kind === "chip" && drag.mode === "move" && drag.overBeat === bi}
        class:beat-over={drag?.kind === "beat" && drag.mode === "move" && drag.over === bi}
        data-beat-index={bi}>
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div class="head" onpointerdown={(e) => headDown(e, b, bi)} oncontextmenu={(e) => beatCtx(e, b, bi)}
          title={bi > 0 ? "Drag to reorder beats · double-click the name to rename · right-click for more" : "The slide's resting state"}>
          <span class="bi">{bi === 0 ? "Start" : `Beat ${bi}`}</span>
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
          <div class="rest">resting state — everything is visible; animations live on the beats to the right</div>
        {:else}
          <div class="ruler">
            {#each rulerTicks(bi) as tk (tk)}
              <span class="rt" style={`left:${PAD_X + tk * pxPerMs}px`}>{fmtMs(tk)}</span>
            {/each}
          </div>
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div class="lanes" onpointerdown={lanesDown} style={`height:${Math.max(1, activeRows.length) * LANE_H + 8}px; min-width:${Math.round(beatEnds[bi] * pxPerMs) + PAD_X * 2 + 24}px`}>
            {#if !activeRows.length}
              <div class="rest">no animations — select an object and press ⌃⇧A (appear), ⌃⇧D (disappear) or ⌃⇧T (transform)</div>
            {/if}
            {#each activeRows as row, ri (row.kind === "group" ? "g:" + row.group.id : row.track.id ?? ri)}
              {#if row.kind === "group"}
                {@const span = groupSpan(row.tracks)}
                <!-- svelte-ignore a11y_no_static_element_interactions -->
                <div class="grp-row" class:collapsed={row.collapsed}
                  style={`top:${ri * LANE_H + 3}px; left:${PAD_X + Math.round(span.lo * pxPerMs)}px; width:${Math.max(40, Math.round((span.hi - span.lo) * pxPerMs))}px; height:${LANE_H - 5}px`}
                  title={`${row.group.label} — ${row.tracks.length} track${row.tracks.length > 1 ? "s" : ""}. Click the chevron to ${row.collapsed ? "expand" : "collapse"}.`}
                  onpointerdown={(e) => { if (e.button === 0) { e.stopPropagation(); selectGroup(row.group, row.tracks); onFocusDock(); } }}>
                  <button class="chev" onpointerdown={(e) => e.stopPropagation()} onclick={(e) => { e.stopPropagation(); toggleGroupCollapsed(row.group); }}>{row.collapsed ? "▸" : "▾"}</button>
                  <span class="gl">{row.group.label}</span>
                  <span class="gn">{row.tracks.length}</span>
                </div>
              {:else}
                {@const t = row.track}
                {@const isTransform = familyOf(t) === "transform"}
                <!-- svelte-ignore a11y_no_static_element_interactions -->
                <div class="trk" class:sel={!!t.id && $selTrackIds.includes(t.id)} class:dis={t.disabled} class:missing={isDanglingTrack(t, slide)}
                  class:ingrp={row.inGroup} class:tx={isTransform}
                  data-track-id={t.id}
                  style={`--pc:${trackColor(t)}; left:${chipX(t) + (row.inGroup ? 10 : 0)}px; top:${ri * LANE_H + 3}px; width:${chipW(t)}px; height:${LANE_H - 4}px; ${dragging(t)}`}
                  title={isDanglingTrack(t, slide)
                    ? `${chipLabel(t, slide, plotTags)} · MISSING TARGET — its element was deleted. The track is kept (undo the deletion to restore it) and plays as a no-op.`
                    : isTransform
                    ? `${chipLabel(t, slide, plotTags)} · transform\nt₁/t₂ select an endpoint to edit on the canvas · drag = retime · right edge = duration`
                    : `${chipLabel(t, slide, plotTags)} · ${t.preset ?? "fade"}${t.disabled ? " · disabled" : ""}\ndrag = retime · right edge = duration · drag out = move to another beat (Alt copies)`}
                  onpointerdown={(e) => chipDown(e, t, bi)}
                  oncontextmenu={(e) => chipCtx(e, t)}
                  onpointerenter={() => hoverTrackId.set(t.id ?? null)}
                  onpointerleave={() => hoverTrackId.set(null)}>
                  {#if isTransform && t.id}
                    <button class="ep t1" class:on={endpointOn(t, "t1")}
                      title="Edit t₁ — the state the object transforms FROM (edits the previous transform when chained)"
                      onpointerdown={(e) => e.stopPropagation()}
                      onclick={(e) => { e.stopPropagation(); enterEndpointEdit([t.id!], "t1"); }}>t₁</button>
                    <span class="txline"></span>
                    <span class="nm txnm">{chipLabel(t, slide, plotTags)}</span>
                    <span class="txline"></span>
                    <button class="ep t2" class:on={endpointOn(t, "t2")}
                      title="Edit t₂ — sculpt how the object looks AFTER the transform, with every canvas tool"
                      onpointerdown={(e) => e.stopPropagation()}
                      onclick={(e) => { e.stopPropagation(); enterEndpointEdit([t.id!], "t2"); }}>t₂</button>
                  {:else}
                    <span class="dot" class:hollow={t.disabled}></span>
                    {#if isDanglingTrack(t, slide)}<span class="miss" title="missing target">⚠</span>{/if}
                    <span class="nm">{chipLabel(t, slide, plotTags)}</span>
                    {#if tailW(t) > 2}<span class="tail" style={`width:${tailW(t)}px`} title="stagger fan-out"></span>{/if}
                  {/if}
                  <span class="edge"></span>
                </div>
              {/if}
              {#if drag?.kind === "chip" && drag.mode === "move" && drag.overBeat === bi && drag.overLane === ri}
                <div class="lane-ins" style={`top:${ri * LANE_H + 1}px`}></div>
              {/if}
            {/each}
            {#if drag?.kind === "chip" && drag.mode === "move" && drag.overBeat === bi && drag.overLane === activeRows.length}
              <div class="lane-ins" style={`top:${activeRows.length * LANE_H + 1}px`}></div>
            {/if}
          </div>
        {/if}
      </div>
    {:else}
      <!-- ═══ a collapsed beat CHIP ═══ -->
      <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
      <div class="beat-c" class:chain={b.advance === "with-prev"}
        class:drop={drag?.kind === "chip" && drag.mode === "move" && drag.overBeat === bi}
        class:beat-over={drag?.kind === "beat" && drag.mode === "move" && drag.over === bi}
        data-beat-index={bi} role="button" tabindex="-1"
        onpointerdown={(e) => headDown(e, b, bi)}
        oncontextmenu={(e) => beatCtx(e, b, bi)}
        onclick={() => { activeBeat.set(bi); onFocusDock(); }}
        title={bi === 0 ? "The slide's resting state — click to view" : `${b.label || `Beat ${bi}`} — ${b.tracks.length} track${b.tracks.length === 1 ? "" : "s"}. Click to expand.`}>
        <span class="cb-l">{bi === 0 ? "Start" : `B${bi}`}</span>
        {#if bi > 0}<span class="cb-adv">{ADV_ICON[b.advance ?? "click"]}</span>{/if}
        <span class="cb-bars">
          {#each microBars(b, bi) as m, i (i)}
            <span class="mb" style={`background:${m.color}; margin-left:${m.x}px; width:${m.w}px`}></span>
          {/each}
          {#if b.tracks.length > MICRO_MAX}<span class="cb-more">+{b.tracks.length - MICRO_MAX}</span>{/if}
          {#if bi === 0}<span class="cb-rest">rest</span>{/if}
        </span>
      </div>
    {/if}
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
  .beatrail {
    flex: 1; min-width: 0;
    display: flex; gap: 3px; overflow-x: auto; overflow-y: auto; padding: 2px 2px 4px;
    align-items: stretch; min-height: 96px; position: relative;
  }
  /* ── collapsed chips ── */
  .beat-c {
    flex: 0 0 64px; display: flex; flex-direction: column; gap: 3px;
    border: 1px solid var(--c-line, #282726); border-radius: 7px;
    background: var(--c-bg-2, #16100f00); cursor: pointer; padding: 5px 7px;
  }
  .beat-c:hover { border-color: var(--c-accent, #4385be); }
  .beat-c.chain { border-left-style: dashed; }
  .beat-c.drop, .beat-x.drop { border-color: var(--c-guide-2); box-shadow: inset 0 0 0 1px var(--c-guide-2); }
  .beat-c.beat-over, .beat-x.beat-over { outline: 2px dashed var(--c-accent, #4385be); outline-offset: 1px; }
  .cb-l { font-size: 13px; font-weight: 700; color: var(--c-tx-hi, #cecdc3); font-style: italic; }
  .cb-adv { font-size: 9px; opacity: 0.7; }
  .cb-bars { display: flex; flex-direction: column; gap: 2px; margin-top: 1px; }
  .mb { height: 4px; border-radius: 2px; }
  .cb-more, .cb-rest { font-size: 9px; color: var(--c-tx-3, #6f6e69); }
  /* ── the expanded beat ── */
  .beat-x {
    flex: 0 0 auto; max-width: 72%;
    border: 1.5px solid var(--c-tx-3, #878580); border-radius: 8px;
    background: var(--c-bg-2, #16100f00); overflow: auto;
    display: flex; flex-direction: column;
  }
  .beat-x.chain { border-left-style: dashed; }
  .head {
    display: flex; align-items: center; gap: 5px; padding: 3px 8px; position: sticky; top: 0; z-index: 3;
    background: var(--c-bg-3, #1c1b1a); border-bottom: 1px solid var(--c-line, #282726);
    min-height: 23px;
  }
  .bi { font-size: 12.5px; font-weight: 700; font-style: italic; color: var(--c-tx-hi, #cecdc3); }
  .lab { font-size: 10px; color: var(--c-tx-3, #878580); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 140px; min-width: 8px; }
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
  .pv { margin-left: auto; }
  .total ~ .pv { margin-left: 2px; }
  .beat-x:hover .pv, .beat-x:hover .bx { opacity: 1; }
  .pv:hover { color: var(--c-accent, #4385be); }
  .bx:hover { color: var(--c-danger, #d14d41); }
  .ruler { position: relative; height: 11px; border-bottom: 1px dashed color-mix(in oklab, var(--c-line, #282726) 70%, transparent); margin: 0 0 1px; }
  .rt {
    position: absolute; top: 0; font-size: 8px; color: var(--c-tx-faint, #575653);
    border-left: 1px solid var(--c-line, #282726); padding-left: 2px; line-height: 11px;
  }
  .rest { font-size: 10px; color: var(--c-tx-3, #6f6e69); font-style: italic; padding: 8px; }
  .lanes { position: relative; min-height: 26px; }
  /* group rows */
  .grp-row {
    position: absolute; display: flex; align-items: center; gap: 4px;
    font-size: 10px; padding: 0 4px; border-radius: 4px; cursor: pointer;
    background: color-mix(in oklab, var(--c-tx-3, #878580) 14%, var(--c-bg-2, #1c1b1a));
    border: 1px solid color-mix(in oklab, var(--c-tx-3, #878580) 40%, transparent);
    white-space: nowrap; user-select: none; overflow: hidden;
  }
  .grp-row.collapsed { background: color-mix(in oklab, var(--c-tx-3, #878580) 24%, var(--c-bg-2, #1c1b1a)); }
  .grp-row .chev { border: none; background: none; color: var(--c-tx-2, #b7b5ac); cursor: pointer; font-size: 9px; padding: 0 1px; }
  .grp-row .gl { color: var(--c-tx, #cecdc3); font-weight: 600; overflow: hidden; text-overflow: ellipsis; }
  .grp-row .gn {
    font-size: 8.5px; color: var(--c-tx-3, #878580);
    border: 1px solid var(--c-line, #403e3c); border-radius: 7px; padding: 0 4px;
  }
  /* track lanes */
  .trk {
    position: absolute; display: flex; align-items: center; gap: 4px;
    font-size: 10.5px; padding: 0 4px; border-radius: 4px; cursor: grab;
    background: color-mix(in oklab, var(--pc) 16%, var(--c-bg-2, #1c1b1a));
    border: 1px solid color-mix(in oklab, var(--pc) 45%, transparent);
    overflow: visible; white-space: nowrap; user-select: none;
  }
  .trk:hover { background: color-mix(in oklab, var(--pc) 26%, var(--c-bg-2, #1c1b1a)); z-index: 2; }
  .trk.sel { outline: 1.5px solid var(--pc); z-index: 3; }
  .trk.dis { opacity: 0.38; border-style: dashed; }
  .trk.missing { border-color: var(--c-warning, #d0a215); }
  .trk .miss { color: var(--c-warning, #d0a215); font-size: 9px; flex: 0 0 auto; }
  .trk .dot { width: 6px; height: 6px; border-radius: 2px; background: var(--pc); flex: 0 0 auto; }
  .trk .dot.hollow { background: transparent; border: 1.5px solid var(--pc); }
  .trk .nm { color: var(--c-tx, #cecdc3); overflow: hidden; text-overflow: ellipsis; }
  .trk .tail {
    position: absolute; left: 100%; top: 30%; height: 40%; border-radius: 0 3px 3px 0;
    background: repeating-linear-gradient(-55deg, color-mix(in oklab, var(--pc) 55%, transparent) 0 3px, transparent 3px 6px);
    pointer-events: none;
  }
  .trk .edge { position: absolute; right: -2px; top: 0; width: 8px; height: 100%; cursor: ew-resize; }
  /* transform lanes — the green t₁ ─── label ─── t₂ form */
  .trk.tx { background: transparent; border-color: transparent; padding: 0 1px; }
  .trk.tx:hover { background: color-mix(in oklab, var(--pc) 10%, transparent); }
  .trk.tx.sel { outline: 1px dashed var(--pc); }
  .trk .txline { flex: 1; height: 0; border-top: 1.5px solid var(--pc); min-width: 4px; }
  .trk .txnm {
    flex: 0 1 auto; font-size: 9.5px; color: var(--pc); font-style: italic;
    border: 1px solid color-mix(in oklab, var(--pc) 50%, transparent); border-radius: 8px; padding: 0 6px;
  }
  .trk .ep {
    flex: 0 0 auto; width: 16px; height: 14px; padding: 0; line-height: 1;
    font: 600 8.5px var(--font-mono, ui-monospace, monospace); cursor: pointer;
    color: var(--pc); background: var(--c-bg, #100f0f);
    border: 1px solid color-mix(in oklab, var(--pc) 60%, transparent); border-radius: 3px;
  }
  .trk .ep:hover { background: color-mix(in oklab, var(--pc) 25%, var(--c-bg, #100f0f)); }
  .trk .ep.on { color: var(--c-bg, #100f0f); background: var(--pc); }
  .lane-ins { position: absolute; left: 4px; right: 4px; height: 2px; background: var(--c-guide-2); border-radius: 1px; z-index: 4; }
  /* shared */
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
