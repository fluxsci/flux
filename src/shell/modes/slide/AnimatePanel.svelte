<script lang="ts">
  // flux-slide — the Animator dock (Phase 2). The dedicated animation editor the
  // pillar is really about: a one-click ✨ Auto-animate that turns a plot's own
  // build hints into a beat sequence, and a real multi-track TIMELINE (beats as
  // columns, each showing the animations that fire on it) you scrub by clicking.
  // Replaces the thin numbered beat strip. The X-ray tri-state (2.2) and per-track
  // editing (2.3) layer onto this shell.
  import { deck as deckStore, activeSlideId, activeBeat, selection, commitDeck, focusedPart } from "../../../lib/slide/store";
  import { slideById, addBeat as addBeatOp, setPartVisibility, deleteBeat as deleteBeatOp, setAnimation } from "../../../lib/slide/ops";
  import { applyAutoAnimation, animatePart } from "../../../lib/slide/autobuild";
  import { buildPartTree, type XrayNode } from "../../../lib/plot/tree";
  import { morphCompatible } from "../../../lib/slide/player/morph";
  import { plotManifests } from "../../../lib/plot/store";
  import { slideLayout } from "./slideLayoutStore";
  import type { Track, PresetName, Stagger, Influence } from "../../../lib/slide/types";

  let { onPreview }: { onPreview?: () => void } = $props();

  const deck = $derived($deckStore);
  const slide = $derived(deck && $activeSlideId ? slideById(deck, $activeSlideId) : deck?.slides[0] ?? null);
  const sel = $derived($selection);
  const manifests = $derived($plotManifests);
  const selPlot = $derived.by(() => {
    if (sel.length !== 1 || !slide) return null;
    const el = slide.elements.find((e) => e.id === sel[0]);
    return el && el.type === "plot" ? el : null;
  });
  const selManifest = $derived(selPlot ? manifests[selPlot.assetId] : undefined);
  // When a slide carries >1 plot, tag each plot element P1/P2/… (in slide order)
  // so the timeline stays legible — two plots can both own a "setosa.points", and
  // the chip/editor disambiguate which plot a track animates. Single-plot slides
  // get no tags (kept clean).
  const plotTags = $derived.by(() => {
    const m = new Map<string, string>();
    const plots = slide?.elements.filter((e) => e.type === "plot") ?? [];
    if (plots.length > 1) plots.forEach((e, i) => m.set(e.id, `P${i + 1}`));
    return m;
  });
  // a track belongs to a different plot than the selected one → dim it so the
  // selected plot's tracks stand out in a shared, multi-plot timeline.
  const isOtherPlot = (t: Track) => !!selPlot && t.target !== selPlot.id && plotTags.has(t.target);

  // --- X-ray parts tree: per-part show / animate / mask (the figure X-ray, here) ---
  let collapsed = $state(new Set<string>());
  const xrayTree = $derived(selManifest ? buildPartTree(selManifest) : null);
  const xrayRows = $derived.by(() => {
    const rows: { node: XrayNode; depth: number }[] = [];
    const walk = (n: XrayNode, depth: number) => {
      rows.push({ node: n, depth });
      if (n.children.length && !collapsed.has(n.id)) for (const c of n.children) walk(c, depth + 1);
    };
    if (xrayTree) walk(xrayTree, 0);
    return rows;
  });
  function toggleCollapse(id: string) {
    const s = new Set(collapsed);
    if (s.has(id)) s.delete(id); else s.add(id);
    collapsed = s;
  }
  /** A part's resting state: masked (override hidden) → animated (has a LIVE
   *  track) → shown. Disabled tracks don't count — Mask/Show disable rather than
   *  delete them (non-destructive tri-state), so only enabled tracks mean A. */
  function partState(part: string): "show" | "animate" | "mask" {
    const plot = selPlot;
    if (!plot || !slide) return "show";
    if ((plot.overrides as Record<string, { hidden?: boolean }> | undefined)?.[part]?.hidden) return "mask";
    if (slide.beats.some((b) => b.tracks.some((t) => t.target === plot.id && t.part === part && !t.disabled))) return "animate";
    return "show";
  }
  function setVis(part: string, mode: "show" | "animate" | "mask") {
    const plot = selPlot;
    const sid = slide?.id;
    if (!plot || !sid) return;
    commitDeck((d) => {
      if (mode === "animate") animatePart(d, sid, plot.id, part, manifests[plot.assetId], $activeBeat);
      else setPartVisibility(d, plot.id, part, mode);
    });
  }

  // --- per-track editing (issue #5: many anims/beat + stagger + speed control) --
  const EDIT_PRESETS: PresetName[] = ["fade", "fadeRise", "popIn", "drawOn", "growBaseline", "stagger", "writeOn", "highlight", "dim"];
  const EASINGS = ["standard", "smooth", "enter", "exit", "linear"];
  // AE-style velocity presets (outgoing/incoming influence %). "ease" clears the
  // influence so the named easing applies again.
  const INFLUENCE_PRESETS: { name: string; in: number; out: number }[] = [
    { name: "ease", in: 0, out: 0 },
    { name: "subtle", in: 25, out: 25 },
    { name: "medium", in: 50, out: 50 },
    { name: "strong", in: 75, out: 75 },
    { name: "extreme", in: 95, out: 95 },
  ];
  // edit the influence pair (bulk); drop it entirely when both reach 0 (→ named ease)
  function setInfluence(p: Partial<Influence>) {
    withTracks((t) => {
      const next = { in: 0, out: 0, ...t.influence, ...p } as Influence;
      if (next.in <= 0 && next.out <= 0) delete t.influence;
      else t.influence = { in: Math.max(0, Math.min(100, next.in)), out: Math.max(0, Math.min(100, next.out)) };
    });
  }
  function applyInfluencePreset(p: { in: number; out: number }) {
    withTracks((t) => { if (p.in <= 0 && p.out <= 0) delete t.influence; else t.influence = { in: p.in, out: p.out }; });
  }
  const inflActive = (p: { in: number; out: number }) =>
    !!curTrack && (curTrack.influence ? curTrack.influence.in === p.in && curTrack.influence.out === p.out : p.in === 0 && p.out === 0);
  // Multi-select: a set of selected track ids (stable Track.id). The LAST entry is
  // the "primary" and drives the editor field VALUES; edits apply to ALL selected
  // (bulk). Shift/Ctrl/Cmd-click a chip to add/remove from the set.
  let selTrackIds = $state<string[]>([]);
  const selTracks = $derived.by(() => {
    if (!slide) return [] as Track[];
    const all = slide.beats.flatMap((b) => b.tracks);
    return selTrackIds.map((id) => all.find((t) => t.id === id)).filter((t): t is Track => !!t);
  });
  const curTrack = $derived.by(() => {
    const ids = selTrackIds;
    if (!ids.length || !slide) return null;
    const primary = ids[ids.length - 1];
    return slide.beats.flatMap((b) => b.tracks).find((t) => t.id === primary) ?? null;
  });
  // true when the selected tracks disagree on a field → the editor shows "mixed".
  function mixed<T>(get: (t: Track) => T): boolean {
    const vs = selTracks.map(get);
    return vs.length > 1 && vs.some((v) => v !== vs[0]);
  }
  function selectTrack(id: string | undefined, additive: boolean) {
    if (!id) return;
    if (additive) selTrackIds = selTrackIds.includes(id) ? selTrackIds.filter((x) => x !== id) : [...selTrackIds, id];
    else selTrackIds = [id];
  }
  // apply a mutation to EVERY selected track in ONE commit (bulk edit — e.g. set
  // stagger=80 on the three `.points` tracks at once).
  function withTracks(fn: (t: Track) => void) {
    const ids = selTrackIds;
    const sid = slide?.id;
    if (!ids.length || !sid) return;
    commitDeck((d) => {
      const s = slideById(d, sid);
      if (s) for (const b of s.beats) for (const t of b.tracks) if (t.id && ids.includes(t.id)) fn(t);
    });
  }
  const patchTrack = (p: Partial<Track>) => withTracks((t) => Object.assign(t, p));
  function patchStagger(p: Partial<Stagger>) {
    withTracks((t) => {
      if (p.perMs === 0) { delete t.stagger; return; }
      t.stagger = { perMs: t.stagger?.perMs ?? 40, ...t.stagger, ...p } as Stagger;
    });
  }
  function deleteTrack() {
    const ids = selTrackIds;
    const sid = slide?.id;
    if (!ids.length || !sid) return;
    commitDeck((d) => {
      const s = slideById(d, sid);
      if (s) for (const b of s.beats) b.tracks = b.tracks.filter((t) => !t.id || !ids.includes(t.id));
    });
    selTrackIds = [];
  }
  function removeBeat(beatId: string, bi: number) {
    const sid = slide?.id;
    if (!sid || bi === 0) return;
    commitDeck((d) => deleteBeatOp(d, sid, beatId));
    if ($activeBeat >= bi) activeBeat.set(Math.max(0, $activeBeat - 1));
    selTrackIds = [];
  }

  // --- keyboard cockpit (the "f-menu" for animations) -------------------------
  // Element-scoped (fires only when the Animator has focus), so it never fights
  // the stage/slide window shortcuts. ←/→ = beat, ↑/↓ = track, Enter = into the
  // editor, p/d/t/g/e jump to preset / dur / start / staGger / easE, Esc clears.
  let animEl = $state<HTMLDivElement | null>(null);
  function focusField(k: string) {
    (animEl?.querySelector(`[data-fld="${k}"]`) as HTMLElement | null)?.focus();
  }
  function navBeat(dir: number) {
    if (!slide) return;
    const next = Math.max(0, Math.min(slide.beats.length - 1, $activeBeat + dir));
    activeBeat.set(next);
    const first = slide.beats[next]?.tracks[0];
    selTrackIds = first?.id ? [first.id] : [];
  }
  function navTrack(dir: number) {
    if (!slide) return;
    const tracks = slide.beats[$activeBeat]?.tracks ?? [];
    if (!tracks.length) return;
    const curId = selTrackIds[selTrackIds.length - 1];
    const ci = tracks.findIndex((t) => t.id === curId);
    const ni = ci < 0 ? (dir > 0 ? 0 : tracks.length - 1) : Math.max(0, Math.min(tracks.length - 1, ci + dir));
    const t = tracks[ni];
    selTrackIds = t?.id ? [t.id] : [];
  }
  function onAnimKey(e: KeyboardEvent) {
    const tgt = e.target as HTMLElement;
    if (tgt && (tgt.tagName === "INPUT" || tgt.tagName === "SELECT" || tgt.tagName === "TEXTAREA")) {
      // inside a field: Enter/Esc hands focus back to the panel so nav keys resume
      if (e.key === "Enter" || e.key === "Escape") { e.preventDefault(); tgt.blur(); animEl?.focus({ preventScroll: true }); }
      return;
    }
    switch (e.key) {
      case "ArrowLeft": e.preventDefault(); navBeat(-1); break;
      case "ArrowRight": e.preventDefault(); navBeat(1); break;
      case "ArrowUp": e.preventDefault(); navTrack(-1); break;
      case "ArrowDown": e.preventDefault(); navTrack(1); break;
      case "Enter": e.preventDefault(); focusField("p"); break;
      case "Escape": e.preventDefault(); selTrackIds = []; break;
      case "p": case "d": case "t": case "g": case "e": case "o": e.preventDefault(); focusField(e.key); break;
    }
  }
  // Window-level, but only acts when focus is inside the Animator — avoids a div
  // keydown listener (a11y) while still never firing for the stage/slide shortcuts.
  function onWinKey(e: KeyboardEvent) {
    if (animEl && animEl.contains(document.activeElement)) onAnimKey(e);
  }

  // --- draggable top edge → the dock's max-height (C1). Drag up = taller dock —
  // all the way to a near-full-window animator (the stage keeps an 80px sliver).
  let dockResize = $state(false);
  const DOCK_DEFAULT_H = 300;
  const dockMaxH = () => Math.max(150, window.innerHeight - 160);
  let lastBigH = 0; // remembered across the ⇕ toggle (session-local)
  function startDockDrag(e: PointerEvent) {
    e.preventDefault();
    dockResize = true;
    window.addEventListener("pointermove", moveDockDrag);
    window.addEventListener("pointerup", endDockDrag);
  }
  function moveDockDrag(e: PointerEvent) {
    if (!dockResize || !animEl) return;
    const h = Math.max(150, Math.min(dockMaxH(), animEl.getBoundingClientRect().bottom - e.clientY));
    slideLayout.update((s) => ({ ...s, animatorH: Math.round(h) }));
  }
  /** Toggle default height ↔ the last tall height (or full) — dbl-click the gutter or the ⇕ button. */
  function toggleDockSize() {
    const cur = $slideLayout.animatorH;
    if (cur > DOCK_DEFAULT_H + 40) {
      lastBigH = cur;
      slideLayout.update((s) => ({ ...s, animatorH: DOCK_DEFAULT_H }));
    } else {
      slideLayout.update((s) => ({ ...s, animatorH: Math.min(dockMaxH(), lastBigH || dockMaxH()) }));
    }
  }
  function endDockDrag() {
    dockResize = false;
    window.removeEventListener("pointermove", moveDockDrag);
    window.removeEventListener("pointerup", endDockDrag);
  }

  // direct manipulation: a part clicked on the stage → open its track + reveal its
  // X-ray row (so clicking a scatter point jumps you straight to its animation).
  $effect(() => {
    const fp = $focusedPart;
    if (!fp || !slide || fp.elId !== selPlot?.id) return;
    for (let bi = 0; bi < slide.beats.length; bi++) {
      const t = slide.beats[bi].tracks.find((tk) => tk.target === fp.elId && tk.part === fp.part);
      if (t) { selTrackIds = t.id ? [t.id] : []; activeBeat.set(bi); break; }
    }
    queueMicrotask(() => document.querySelector(`.parts .row[data-part="${fp.part}"]`)?.scrollIntoView({ block: "nearest" }));
  });

  function focusDock() {
    animEl?.focus({ preventScroll: true });
  }
  function autoAnimate() {
    const sid = slide?.id;
    const plot = selPlot;
    if (!sid || !plot) return;
    const manifest = manifests[plot.assetId];
    let added = 0;
    commitDeck((d) => { added = applyAutoAnimation(d, sid, plot.id, manifest); });
    if (added) {
      activeBeat.set(1);
      // Hand the keyboard cockpit focus + a starting selection so the arrows/
      // letters work immediately (no hidden "click a track first" step).
      queueMicrotask(() => {
        const first = slide?.beats[1]?.tracks.find((t) => t.target === plot.id) ?? slide?.beats[1]?.tracks[0];
        selTrackIds = first?.id ? [first.id] : [];
        focusDock();
      });
    }
  }

  // --- camera + morph authoring (3.1) -----------------------------------------
  let morphOpen = $state(false);
  // other plots on this slide = morph targets (a plot's data → another's, in place). SLD-8: each
  // carries a friendly label (P-tag + plotType, not the raw assetId) and a compatibility flag so
  // the menu can disable structurally-incompatible targets instead of offering a silent mis-tween.
  const morphTargets = $derived.by(() => {
    type MT = { id: string; assetId: string; label: string; compatible: boolean };
    if (!selPlot || !slide) return [] as MT[];
    return slide.elements
      .filter((e) => e.type === "plot" && e.id !== selPlot.id)
      .map((e): MT => {
        const assetId = (e as { assetId: string }).assetId;
        const m = manifests[assetId];
        const label = [plotTags.get(e.id), m?.plotType].filter(Boolean).join(" · ") || assetId;
        return { id: e.id, assetId, label, compatible: morphCompatible(selManifest, m) };
      });
  });

  function addBeatWith(label: string, track: Track) {
    const sid = slide?.id;
    if (!sid) return;
    let idx = 0;
    commitDeck((d) => {
      const b = addBeatOp(d, sid, { label, advance: "click" });
      if (b) setAnimation(d, sid, b.id, track);
      idx = (slideById(d, sid)?.beats.length ?? 1) - 1;
    });
    if (idx > 0) activeBeat.set(idx);
  }
  function addCameraMove(kind: "zoom" | "reset") {
    const d0 = deck;
    if (!d0 || !slide) return;
    const st = d0.stage;
    if (kind === "reset") {
      addBeatWith("Reset view", { target: "@camera", preset: "camera", to: { zoom: 1, x: st.width / 2, y: st.height / 2 }, duration: 900, easing: "smooth" });
      return;
    }
    const el = sel.length ? slide.elements.find((e) => e.id === sel[0]) : null;
    if (!el) return;
    const zoom = Math.max(1.05, Math.min(st.width / el.width, st.height / el.height) * 0.82);
    addBeatWith("Zoom in", { target: "@camera", preset: "camera", to: { zoom, x: el.x + el.width / 2, y: el.y + el.height / 2 }, duration: 900, easing: "smooth" });
  }
  function addMorph(toAssetId: string) {
    morphOpen = false;
    const plot = selPlot;
    if (!plot) return;
    addBeatWith("Morph", { target: plot.id, preset: "morph", to: { assetId: toAssetId }, duration: 1200, easing: "smooth" });
  }

  function addBeat() {
    const sid = slide?.id;
    if (!sid) return;
    let idx = 0;
    commitDeck((d) => {
      const s = slideById(d, sid);
      const n = s?.beats.length ?? 1;
      addBeatOp(d, sid, { label: `Beat ${n}`, advance: "click" });
      idx = (slideById(d, sid)?.beats.length ?? 1) - 1;
    });
    if (idx > 0) activeBeat.set(idx);
  }

  // a compact label for a track on the timeline (prefixed with the plot tag when
  // the slide has multiple plots, so identical part names stay distinguishable).
  function chip(t: Track): string {
    if (t.target.startsWith("@")) return t.target.slice(1);
    const tag = plotTags.get(t.target);
    const pre = tag ? `${tag} · ` : "";
    if (t.part) return pre + t.part.split(".").slice(-2).join(".");
    if (t.selector?.blocks) return pre + "bullets";
    const el = slide?.elements.find((e) => e.id === t.target);
    return pre + (el?.type ?? "elem");
  }

  const PRESET_COLOR: Record<string, string> = {
    drawOn: "#4385be", fade: "#879a39", fadeRise: "#879a39", stagger: "#d14d41",
    growBaseline: "#d0a215", popIn: "#8b7ec8", writeOn: "#3aa99f", highlight: "#d0a215",
    dim: "#6f6e69", move: "#4385be", scale: "#4385be", rotate: "#4385be", morph: "#ce5d97", camera: "#a02f6f",
  };
</script>

<svelte:window onkeydown={onWinKey} />
{#if slide}
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <div class="animator" bind:this={animEl} tabindex="0" role="group" aria-label="Animation timeline" style={`--anim-h:${$slideLayout.animatorH}px`}>
    <!-- drag the top edge to resize the dock (C1) -->
    <div class="dock-gutter" class:active={dockResize} role="separator" aria-orientation="horizontal"
      aria-label="Resize animator" onpointerdown={startDockDrag} ondblclick={toggleDockSize}><span class="grip"></span></div>
    <div class="bar">
      <strong class="ttl">Animation</strong>
      {#if selPlot}
        <button class="magic" onclick={autoAnimate} disabled={!selManifest}
          title={selManifest ? "Build a beat sequence from this plot's own animation hints" : "This plot has no build manifest to auto-animate"}>✨ Auto-animate</button>
      {/if}
      <button class="b" onclick={addBeat} title="Add a beat">+ Beat</button>
      {#if sel.length === 1}
        <button class="b" onclick={() => addCameraMove("zoom")} title="Camera: zoom in to the selected element">🎥 Zoom</button>
      {/if}
      {#if slide.beats.length > 1}
        <button class="b" onclick={() => addCameraMove("reset")} title="Camera: pull back to the full slide">⤢ Reset</button>
      {/if}
      {#if selPlot && morphTargets.length}
        <span class="morph-wrap">
          <button class="b" onclick={() => (morphOpen = !morphOpen)} title="Morph this plot's data into another plot on the slide">⇄ Morph ▾</button>
          {#if morphOpen}
            <div class="morph-menu">
              {#each morphTargets as m (m.id)}
                <button
                  onclick={() => addMorph(m.assetId)}
                  disabled={!m.compatible}
                  class:incompat={!m.compatible}
                  title={m.compatible
                    ? `Morph this plot's data into ${m.label}`
                    : `Incompatible structure — can't morph into ${m.label}`}>
                  → {m.label}{#if !m.compatible} <span class="tag">incompatible</span>{/if}
                </button>
              {/each}
            </div>
          {/if}
        </span>
      {/if}
      {#if onPreview && slide.beats.length > 1}
        <button class="b play" onclick={() => onPreview?.()} title="Play this slide's build on the stage">▶ Preview</button>
      {/if}
      <span class="spacer"></span>
      <button class="b" onclick={toggleDockSize} title="Toggle animator size (or double-click the top edge)">⇕</button>
      <span class="keyhint" title="When the Animator has focus (click a track first): arrows navigate, Enter edits, letters jump to fields">
        <kbd>←→</kbd>beat <kbd>↑↓</kbd>track <kbd>↵</kbd>edit
      </span>
      {#if selPlot}<span class="tag">plot selected — try ✨</span>{:else}<span class="tag dim">select a plot to auto-animate</span>{/if}
    </div>

    <div class="dock-body">
      {#if xrayTree}
        <div class="parts">
          <div class="ph">Parts <span class="ph-hint">show · animate · mask</span></div>
          <div class="tree">
            {#each xrayRows as { node, depth } (node.id)}
              {@const st = partState(node.id)}
              <div class="row" class:focus={$focusedPart?.elId === selPlot?.id && $focusedPart?.part === node.id}
                data-part={node.id} style={`padding-left:${depth * 11 + 2}px`}>
                {#if node.children.length}
                  <button class="tw" onclick={() => toggleCollapse(node.id)} aria-label="collapse">{collapsed.has(node.id) ? "▸" : "▾"}</button>
                {:else}<span class="tw"></span>{/if}
                <span class="pl" title={node.id}>{node.label}</span>
                <span class="tri">
                  <button class:on={st === "show"} title="Show from the start" onclick={() => setVis(node.id, "show")}>S</button>
                  <button class:on={st === "animate"} title="Animate in (add a reveal track)" onclick={() => setVis(node.id, "animate")}>A</button>
                  <button class:on={st === "mask"} title="Mask (hide entirely)" onclick={() => setVis(node.id, "mask")}>M</button>
                </span>
              </div>
            {/each}
          </div>
        </div>
      {/if}
      <div class="timeline">
      {#each slide.beats as b, bi (b.id)}
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div class="col" class:cur={bi === $activeBeat} onclick={() => { activeBeat.set(bi); focusDock(); }}>
          <div class="head">
            <span class="bi">{bi === 0 ? "Start" : bi}</span>
            {#if b.label && bi > 0}<span class="lab">{b.label}</span>{/if}
            {#if bi > 0}<button class="bx" title="Delete this beat" onclick={(e) => { e.stopPropagation(); removeBeat(b.id, bi); }}>✕</button>{/if}
          </div>
          <div class="body">
            {#if bi === 0}
              <div class="rest">resting state</div>
            {:else if !b.tracks.length}
              <div class="rest">no animations</div>
            {:else}
              {#each b.tracks as t, ti (t.id ?? ti)}
                <!-- svelte-ignore a11y_click_events_have_key_events -->
                <!-- svelte-ignore a11y_no_static_element_interactions -->
                <div class="trk" class:sel={!!t.id && selTrackIds.includes(t.id)} class:dim={isOtherPlot(t)}
                  style={`--pc:${PRESET_COLOR[t.preset ?? "fade"] ?? "#888"}`}
                  title={isOtherPlot(t) ? "Belongs to another plot — select that plot to edit it" : "Click to select · Shift/Ctrl-click to multi-select for bulk edits"}
                  onclick={(e) => { e.stopPropagation(); selectTrack(t.id, e.shiftKey || e.metaKey || e.ctrlKey); activeBeat.set(bi); animEl?.focus({ preventScroll: true }); }}>
                  <span class="dot"></span>
                  <span class="nm" title={t.part ?? t.target}>{chip(t)}</span>
                  <span class="ps">{t.preset ?? "fade"}</span>
                </div>
              {/each}
            {/if}
          </div>
        </div>
      {/each}
      </div>
    </div>

    {#if curTrack}
      <div class="track-editor">
        <span class="te-nm" style={`--pc:${PRESET_COLOR[curTrack.preset ?? "fade"] ?? "#888"}`}>{selTracks.length > 1 ? `${selTracks.length} tracks` : chip(curTrack)}</span>
        {#if selTracks.length > 1 && (mixed((t) => t.preset) || mixed((t) => t.duration ?? 400) || mixed((t) => t.start ?? 0) || mixed((t) => t.stagger?.perMs ?? 0) || mixed((t) => t.easing ?? "standard"))}
          <span class="te-mixed" title="Selected tracks differ on some fields — editing a field sets it on ALL of them">mixed</span>
        {/if}
        <label>preset<kbd class="kc" title="shortcut: p">p</kbd>
          <select data-fld="p" value={curTrack.preset ?? "fade"} onchange={(e) => patchTrack({ preset: e.currentTarget.value as PresetName })}>
            {#each EDIT_PRESETS as p (p)}<option value={p}>{p}</option>{/each}
          </select>
        </label>
        <label>dur<kbd class="kc" title="shortcut: d">d</kbd> <input data-fld="d" type="number" min="0" step="50" value={curTrack.duration ?? 400} onchange={(e) => patchTrack({ duration: +e.currentTarget.value })} /><small>ms</small></label>
        <label>start<kbd class="kc" title="shortcut: t">t</kbd> <input data-fld="t" type="number" min="0" step="50" value={curTrack.start ?? 0} onchange={(e) => patchTrack({ start: +e.currentTarget.value })} /><small>ms</small></label>
        <label>stagger<kbd class="kc" title="shortcut: g">g</kbd> <input data-fld="g" type="number" min="0" step="10" value={curTrack.stagger?.perMs ?? 0} onchange={(e) => patchStagger({ perMs: +e.currentTarget.value })} /><small>ms</small></label>
        {#if curTrack.stagger?.perMs}
          <label>by
            <select value={curTrack.stagger?.by ?? "index"} onchange={(e) => patchStagger({ by: e.currentTarget.value as Stagger["by"] })}>
              <option value="index">order</option><option value="x">x →</option><option value="y">y ↑</option>
            </select>
          </label>
          <label>from
            <select value={curTrack.stagger?.from ?? "start"} onchange={(e) => patchStagger({ from: e.currentTarget.value as Stagger["from"] })}>
              <option value="start">start</option><option value="end">end</option><option value="center">center</option><option value="edges">edges</option>
            </select>
          </label>
        {/if}
        <label>ease<kbd class="kc" title="shortcut: e">e</kbd>
          <select data-fld="e" value={curTrack.easing ?? "standard"} onchange={(e) => patchTrack({ easing: e.currentTarget.value as Track["easing"] })}>
            {#each EASINGS as ee (ee)}<option value={ee}>{ee}</option>{/each}
          </select>
        </label>
        <span class="infl" title="Velocity profile (After Effects influence). out = slow-out at the start, in = slow-in at the end. When either is > 0 it overrides the named ease.">
          <small>infl</small>
          <input data-fld="o" type="number" min="0" max="100" step="5" value={curTrack.influence?.out ?? 0} onchange={(e) => setInfluence({ out: +e.currentTarget.value })} /><small>out<kbd class="kc" title="shortcut: o">o</kbd></small>
          <input type="number" min="0" max="100" step="5" value={curTrack.influence?.in ?? 0} onchange={(e) => setInfluence({ in: +e.currentTarget.value })} /><small>in</small>
          <span class="ipresets">
            {#each INFLUENCE_PRESETS as p (p.name)}
              <button class="ichip" class:on={inflActive(p)} title={`out ${p.out} · in ${p.in}`} onclick={() => applyInfluencePreset(p)}>{p.name}</button>
            {/each}
          </span>
        </span>
        <span class="spacer"></span>
        <button class="del" onclick={deleteTrack}>Delete</button>
        <button class="closex" title="Close editor" onclick={() => (selTrackIds = [])}>✕</button>
      </div>
    {/if}
  </div>
{/if}

<style>
  .animator {
    flex: 0 0 auto;
    display: flex;
    flex-direction: column;
    gap: 6px;
    border-top: 1px solid var(--c-line, #282726);
    padding: 8px 10px 10px;
    background: var(--c-bg, #100f0f);
    max-height: min(var(--anim-h, 300px), calc(100vh - 160px));
    outline: none;
    position: relative;
  }
  /* keyboard-cockpit affordance: a thin accent edge whenever the dock holds focus
     (programmatic focus after auto-animate / a click counts, so the keys feel live) */
  .animator:focus-within { box-shadow: inset 0 2px 0 0 var(--c-accent, #4385be); }
  .animator:focus-within .keyhint { color: var(--c-tx-2, #878580); }
  .animator:focus-within .keyhint kbd { border-color: color-mix(in oklab, var(--c-accent, #4385be) 45%, var(--c-line, #403e3c)); }
  /* draggable top edge (C1) — a hit-strip straddling the dock's top border */
  .dock-gutter {
    position: absolute; top: -3px; left: 0; right: 0; height: 7px;
    cursor: row-resize; z-index: 6; display: flex; align-items: center; justify-content: center;
  }
  .dock-gutter .grip { width: 100%; height: 1px; background: transparent; transition: background 0.12s; }
  .dock-gutter:hover .grip, .dock-gutter.active .grip { background: var(--c-accent, #4385be); height: 2px; }
  .bar { display: flex; align-items: center; gap: 8px; }
  .ttl { font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--c-tx-3, #878580); }
  .spacer { flex: 1; }
  .tag { font-size: 11px; color: var(--c-accent, #4385be); }
  .tag.dim { color: var(--c-tx-3, #6f6e69); }
  .magic {
    font-size: 12px; font-weight: 600;
    color: var(--c-bg, #100f0f); background: var(--c-accent, #4385be);
    border: none; border-radius: 5px; padding: 5px 11px; cursor: pointer;
  }
  .magic:hover:not(:disabled) { background: var(--c-accent-bright, #5a96c9); }
  .magic:disabled { opacity: 0.4; cursor: default; }
  .b {
    font-size: 12px; color: var(--c-tx-2, #b7b5ac);
    background: var(--c-bg-2, #1c1b1a); border: 1px solid var(--c-line-strong, #343331);
    border-radius: 5px; padding: 5px 10px; cursor: pointer;
  }
  .b:hover { border-color: var(--c-accent, #4385be); color: var(--c-tx-hi, #fff); }
  .morph-wrap { position: relative; display: inline-flex; }
  .morph-menu {
    position: absolute; bottom: calc(100% + 4px); left: 0; z-index: 25; min-width: 150px;
    background: var(--c-bg-2, #1c1b1a); border: 1px solid var(--c-line-strong, #343331);
    border-radius: 6px; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4); padding: 4px; display: flex; flex-direction: column; gap: 1px;
  }
  .morph-menu button {
    text-align: left; border: none; background: none; color: var(--c-tx-2, #b7b5ac);
    border-radius: 4px; padding: 4px 8px; cursor: pointer; font-size: 11px;
  }
  .morph-menu button:hover:not(:disabled) { background: color-mix(in oklab, var(--c-accent, #4385be) 18%, transparent); color: var(--c-tx-hi, #fff); }
  .morph-menu button.incompat { color: var(--c-tx-faint, #6f6e69); cursor: default; }
  .morph-menu .tag {
    font-size: 9px; text-transform: uppercase; letter-spacing: 0.04em;
    color: var(--c-tx-faint, #6f6e69); border: 1px solid var(--c-line, #282726);
    border-radius: 3px; padding: 0 3px; margin-left: 4px;
  }

  .dock-body { display: flex; gap: 10px; min-height: 0; flex: 1; }
  .parts {
    flex: 0 0 234px; display: flex; flex-direction: column; min-height: 0;
    border: 1px solid var(--c-line, #282726); border-radius: 6px; overflow: hidden;
  }
  .ph {
    font-size: 10px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--c-tx-3, #878580);
    padding: 4px 8px; background: var(--c-bg-3, #1c1b1a); border-bottom: 1px solid var(--c-line, #282726);
    display: flex; justify-content: space-between; align-items: baseline;
  }
  .ph-hint { font-size: 9px; text-transform: none; letter-spacing: 0; opacity: 0.6; }
  .tree { overflow-y: auto; padding: 4px; display: flex; flex-direction: column; gap: 1px; }
  .row { display: flex; align-items: center; gap: 4px; font-size: 11px; height: 20px; flex: 0 0 auto; border-radius: 3px; }
  .row.focus { background: color-mix(in oklab, var(--c-accent, #4385be) 22%, transparent); outline: 1px solid var(--c-accent, #4385be); }
  .tw {
    width: 12px; flex: 0 0 auto; background: none; border: none; color: var(--c-tx-3, #6f6e69);
    cursor: pointer; font-size: 8px; padding: 0; line-height: 1;
  }
  .pl { flex: 1; color: var(--c-tx, #cecdc3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tri { display: inline-flex; gap: 2px; flex: 0 0 auto; }
  .tri button {
    width: 17px; height: 16px; font-size: 9px; font-weight: 600; padding: 0; cursor: pointer;
    border: 1px solid var(--c-line-strong, #343331); background: var(--c-bg-2, #1c1b1a);
    color: var(--c-tx-3, #6f6e69); border-radius: 3px;
  }
  .tri button:hover { color: var(--c-tx-hi, #fff); border-color: var(--c-accent, #4385be); }
  .tri button.on { background: var(--c-accent, #4385be); color: var(--c-bg, #100f0f); border-color: var(--c-accent, #4385be); }
  .timeline {
    flex: 1; min-width: 0;
    display: flex; gap: 6px; overflow-x: auto; padding-bottom: 4px;
    align-items: stretch; min-height: 96px;
  }
  .col {
    flex: 0 0 auto; min-width: 124px; max-width: 200px;
    border: 1px solid var(--c-line, #282726); border-radius: 6px;
    background: var(--c-bg-2, #16100f00); cursor: pointer; overflow: hidden;
    display: flex; flex-direction: column;
  }
  .col:hover { border-color: var(--c-line-strong, #343331); }
  .col.cur { border-color: var(--c-accent, #4385be); box-shadow: inset 0 0 0 1px var(--c-accent, #4385be); }
  .head {
    display: flex; align-items: baseline; gap: 6px; padding: 4px 8px;
    background: var(--c-bg-3, #1c1b1a); border-bottom: 1px solid var(--c-line, #282726);
  }
  .bi { font-size: 12px; font-weight: 700; color: var(--c-tx-hi, #cecdc3); }
  .lab { font-size: 10px; color: var(--c-tx-3, #878580); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .body { display: flex; flex-direction: column; gap: 3px; padding: 6px; }
  .rest { font-size: 10px; color: var(--c-tx-3, #6f6e69); font-style: italic; padding: 2px; }
  .trk {
    display: flex; align-items: center; gap: 6px;
    font-size: 11px; padding: 2px 4px; border-radius: 4px; cursor: pointer;
    background: color-mix(in oklab, var(--pc) 12%, transparent);
  }
  .trk:hover { background: color-mix(in oklab, var(--pc) 22%, transparent); }
  .trk.sel { outline: 1px solid var(--pc); background: color-mix(in oklab, var(--pc) 26%, transparent); }
  /* tracks owned by a non-selected plot recede so the selected plot's stand out */
  .trk.dim { opacity: 0.4; }
  .trk.dim:hover { opacity: 0.72; }
  /* keyboard-shortcut badges next to each editor field (the cockpit cues) */
  .kc {
    margin-left: 3px; padding: 0 3px; border-radius: 3px; vertical-align: middle;
    font: 600 9px/1.5 var(--font-mono, ui-monospace, monospace);
    color: var(--c-accent, #4385be);
    background: color-mix(in oklab, var(--c-accent, #4385be) 16%, transparent);
    border: 1px solid color-mix(in oklab, var(--c-accent, #4385be) 32%, transparent);
  }
  .keyhint { font-size: 10px; color: var(--c-tx-3, #6f6e69); white-space: nowrap; }
  .keyhint kbd {
    margin: 0 2px 0 6px; padding: 0 3px; border-radius: 3px;
    font: 600 9px/1.5 var(--font-mono, ui-monospace, monospace);
    color: var(--c-tx-2, #878580); background: var(--c-bg-2, #1c1b1a);
    border: 1px solid var(--c-line, #403e3c);
  }
  .head { position: relative; }
  .bx {
    margin-left: auto; width: 15px; height: 15px; padding: 0; flex: 0 0 auto;
    border: none; background: none; color: var(--c-tx-3, #6f6e69); cursor: pointer; font-size: 9px; opacity: 0;
  }
  .col:hover .bx { opacity: 1; }
  .bx:hover { color: var(--c-danger, #d14d41); }
  .track-editor {
    flex: 0 0 auto; display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
    padding: 6px 8px; border: 1px solid var(--c-accent, #4385be); border-radius: 6px;
    background: color-mix(in oklab, var(--c-accent, #4385be) 8%, var(--c-bg-2, #1c1b1a));
    font-size: 11px;
  }
  .te-nm {
    font-weight: 600; color: var(--c-tx-hi, #cecdc3);
    border-left: 3px solid var(--pc); padding-left: 6px;
  }
  .te-mixed {
    font-size: 9px; text-transform: uppercase; letter-spacing: 0.04em;
    color: var(--c-tx-3, #878580); border: 1px solid var(--c-line, #403e3c);
    border-radius: 3px; padding: 0 4px;
  }
  .track-editor label { display: inline-flex; align-items: center; gap: 4px; color: var(--c-tx-3, #878580); }
  .track-editor small { color: var(--c-tx-3, #6f6e69); }
  .track-editor select, .track-editor input {
    font-size: 11px; color: var(--c-tx, #cecdc3); background: var(--c-bg, #100f0f);
    border: 1px solid var(--c-line-strong, #343331); border-radius: 4px; padding: 2px 5px;
  }
  .track-editor input { width: 52px; }
  /* influence (F): two 0–100 inputs + intensity preset chips */
  .infl { display: inline-flex; align-items: center; gap: 3px; color: var(--c-tx-3, #878580); }
  .infl input { width: 42px; }
  .ipresets { display: inline-flex; gap: 2px; margin-left: 4px; }
  .ichip {
    font-size: 10px; color: var(--c-tx-3, #878580); background: var(--c-bg, #100f0f);
    border: 1px solid var(--c-line, #403e3c); border-radius: 3px; padding: 1px 5px; cursor: pointer;
  }
  .ichip:hover { color: var(--c-tx-hi, #cecdc3); border-color: var(--c-tx-3, #878580); }
  .ichip.on { color: var(--c-on-accent, #fff); background: var(--c-accent, #4385be); border-color: var(--c-accent, #4385be); }
  .del {
    font-size: 11px; color: var(--c-danger, #d14d41); background: none;
    border: 1px solid color-mix(in oklab, var(--c-danger, #d14d41) 50%, transparent);
    border-radius: 4px; padding: 3px 9px; cursor: pointer;
  }
  .del:hover { background: color-mix(in oklab, var(--c-danger, #d14d41) 14%, transparent); }
  .closex { border: none; background: none; color: var(--c-tx-3, #6f6e69); cursor: pointer; font-size: 11px; padding: 2px; }
  .dot { width: 7px; height: 7px; border-radius: 2px; background: var(--pc); flex: 0 0 auto; }
  .nm { color: var(--c-tx, #cecdc3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
  .ps { color: var(--c-tx-3, #878580); font-size: 10px; flex: 0 0 auto; }
</style>
