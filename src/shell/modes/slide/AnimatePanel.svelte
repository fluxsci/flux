<script lang="ts">
  // flux-slide — the Animator dock: the shell that composes the whole-slide
  // PartsTree (S/A/M + animate in/out for EVERY element), the temporal
  // BeatTimeline (mini-Gantt per beat, full direct manipulation), and the
  // TrackEditor strip — plus the toolbar (✨ auto-animate, beats, camera, morph,
  // preview), the resizable top edge, and the keyboard cockpit.
  import { deck as deckStore, activeSlideId, activeBeat, selection, commitDeck, focusedPart, selTrackIds } from "../../../lib/slide/store";
  import { slideById, addBeat as addBeatOp, setAnimation } from "../../../lib/slide/ops";
  import { applyAutoAnimation } from "../../../lib/slide/autobuild";
  import { morphCompatible } from "../../../lib/slide/player/morph";
  import { plotManifests } from "../../../lib/plot/store";
  import { slideLayout } from "./slideLayoutStore";
  import type { Track } from "../../../lib/slide/types";
  import PartsTree from "./animator/PartsTree.svelte";
  import BeatTimeline from "./animator/BeatTimeline.svelte";
  import TrackEditor from "./animator/TrackEditor.svelte";
  import { timelinePxPerMs } from "./animator/animatorState";
  import {
    deleteSelectedTracks, duplicateSelectedTracks, toggleSelectedDisabled,
    nudgeSelected, moveSelectedToAdjacentBeat,
  } from "./animator/trackActions";

  let { onPreview }: { onPreview?: (startBeat?: number) => void } = $props();

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
  // so the timeline stays legible; single-plot slides get no tags.
  const plotTags = $derived.by(() => {
    const m = new Map<string, string>();
    const plots = slide?.elements.filter((e) => e.type === "plot") ?? [];
    if (plots.length > 1) plots.forEach((e, i) => m.set(e.id, `P${i + 1}`));
    return m;
  });
  const manifestFor = (target: string) => {
    const el = slide?.elements.find((e) => e.id === target);
    return el && "assetId" in el ? manifests[(el as { assetId: string }).assetId] : undefined;
  };

  // --- keyboard cockpit ---------------------------------------------------------
  let animEl = $state<HTMLDivElement | null>(null);
  function focusField(k: string) {
    (animEl?.querySelector(`[data-fld="${k}"]`) as HTMLElement | null)?.focus();
  }
  function navBeat(dir: number) {
    if (!slide) return;
    const next = Math.max(0, Math.min(slide.beats.length - 1, $activeBeat + dir));
    activeBeat.set(next);
    const first = slide.beats[next]?.tracks[0];
    selTrackIds.set(first?.id ? [first.id] : []);
  }
  function navTrack(dir: number) {
    if (!slide) return;
    const tracks = slide.beats[$activeBeat]?.tracks ?? [];
    if (!tracks.length) return;
    const ids = $selTrackIds;
    const curId = ids[ids.length - 1];
    const ci = tracks.findIndex((t) => t.id === curId);
    const ni = ci < 0 ? (dir > 0 ? 0 : tracks.length - 1) : Math.max(0, Math.min(tracks.length - 1, ci + dir));
    const t = tracks[ni];
    selTrackIds.set(t?.id ? [t.id] : []);
  }
  function onAnimKey(e: KeyboardEvent) {
    const tgt = e.target as HTMLElement;
    if (tgt && (tgt.tagName === "INPUT" || tgt.tagName === "SELECT" || tgt.tagName === "TEXTAREA")) {
      if (e.key === "Enter" || e.key === "Escape") { e.preventDefault(); tgt.blur(); animEl?.focus({ preventScroll: true }); }
      return;
    }
    const mod = e.metaKey || e.ctrlKey;
    if (mod && (e.key === "d" || e.key === "D")) { e.preventDefault(); duplicateSelectedTracks(); return; }
    if (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      e.preventDefault();
      nudgeSelected(e.shiftKey ? "duration" : "start", e.key === "ArrowRight" ? 50 : -50);
      return;
    }
    switch (e.key) {
      case "ArrowLeft": e.preventDefault(); navBeat(-1); break;
      case "ArrowRight": e.preventDefault(); navBeat(1); break;
      case "ArrowUp": e.preventDefault(); navTrack(-1); break;
      case "ArrowDown": e.preventDefault(); navTrack(1); break;
      case "Enter": e.preventDefault(); focusField("p"); break;
      case "Escape": e.preventDefault(); selTrackIds.set([]); break;
      case "Delete": case "Backspace": e.preventDefault(); deleteSelectedTracks(); break;
      case "x": if (!mod) { e.preventDefault(); toggleSelectedDisabled(); } break;
      case "[": e.preventDefault(); moveSelectedToAdjacentBeat(-1); break;
      case "]": e.preventDefault(); moveSelectedToAdjacentBeat(1); break;
      case "p": case "d": case "t": case "g": case "e": case "o":
        if (!mod) { e.preventDefault(); focusField(e.key); }
        break;
    }
  }
  function onWinKey(e: KeyboardEvent) {
    if (animEl && animEl.contains(document.activeElement)) onAnimKey(e);
  }

  // --- draggable top edge → the dock's max-height. Drag up = taller dock — all
  // the way to a near-full-window animator (the stage keeps an 80px sliver).
  let dockResize = $state(false);
  const DOCK_DEFAULT_H = 300;
  const dockMaxH = () => Math.max(150, window.innerHeight - 160);
  let lastBigH = 0;
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
  const compact = $derived($slideLayout.animatorH < 220);

  // direct manipulation: a part clicked on the stage → select its track (if any)
  $effect(() => {
    const fp = $focusedPart;
    if (!fp || !slide) return;
    for (let bi = 0; bi < slide.beats.length; bi++) {
      const t = slide.beats[bi].tracks.find((tk) => tk.target === fp.elId && tk.part === fp.part);
      if (t) { selTrackIds.set(t.id ? [t.id] : []); activeBeat.set(bi); break; }
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
      queueMicrotask(() => {
        const first = slide?.beats[1]?.tracks.find((t) => t.target === plot.id) ?? slide?.beats[1]?.tracks[0];
        selTrackIds.set(first?.id ? [first.id] : []);
        focusDock();
      });
    }
  }

  // --- camera + morph authoring --------------------------------------------------
  let morphOpen = $state(false);
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
</script>

<svelte:window onkeydown={onWinKey} />
{#if slide}
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <div class="animator" bind:this={animEl} tabindex="0" role="group" aria-label="Animation timeline" style={`--anim-h:${$slideLayout.animatorH}px`}>
    <div class="dock-gutter" class:active={dockResize} role="separator" aria-orientation="horizontal"
      aria-label="Resize animator" onpointerdown={startDockDrag} ondblclick={toggleDockSize}><span class="grip"></span></div>
    <div class="bar">
      <strong class="ttl">Animation</strong>
      {#if selPlot}
        <button class="magic" onclick={autoAnimate} disabled={!selManifest}
          title={selManifest ? "Build a beat sequence from this plot's own animation hints" : "This plot has no build manifest to auto-animate"}>✨ Auto-animate</button>
      {/if}
      <button class="b" onclick={addBeat} title="Add a beat (hover between columns to insert one anywhere)">+ Beat</button>
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
        <button class="b play" onclick={() => onPreview?.()} title="Play this slide's build on the stage (▶ on a beat plays from there)">▶ Preview</button>
      {/if}
      <span class="spacer"></span>
      {#if $timelinePxPerMs != null}
        <button class="b" onclick={() => timelinePxPerMs.set(null)} title="Reset the timeline zoom to auto-fit">fit ⟲</button>
      {/if}
      <button class="b" onclick={toggleDockSize} title="Toggle animator size (or double-click the top edge)">⇕</button>
      <span class="keyhint" title="When the Animator has focus: ←→ beat · ↑↓ track · ⌫ delete · ⌘D duplicate · x disable · Alt+←→ retime · [ ] move across beats · letters jump to fields">
        <kbd>←→</kbd>beat <kbd>↑↓</kbd>track <kbd>⌫</kbd>del <kbd>⌘D</kbd>dup
      </span>
    </div>

    <div class="dock-body">
      <PartsTree {slide} {manifests} {plotTags} />
      <BeatTimeline {slide} {plotTags} selPlotId={selPlot?.id ?? null} {manifestFor} {compact}
        onFocusDock={focusDock} onPreviewFrom={onPreview ? (b) => onPreview?.(b) : undefined} />
    </div>

    <TrackEditor {slide} {plotTags} />
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
    /* FIXED height (not max): dragging the gutter up must actually GIVE the
       animator that space — the tree/timeline/editor stretch into it (flex) —
       all the way to a near-full-window editor. */
    height: min(var(--anim-h, 300px), calc(100vh - 160px));
    outline: none;
    position: relative;
  }
  .animator:focus-within { box-shadow: inset 0 2px 0 0 var(--c-accent, #4385be); }
  .animator:focus-within .keyhint { color: var(--c-tx-2, #878580); }
  .animator:focus-within .keyhint kbd { border-color: color-mix(in oklab, var(--c-accent, #4385be) 45%, var(--c-line, #403e3c)); }
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
  .keyhint { font-size: 10px; color: var(--c-tx-3, #6f6e69); white-space: nowrap; }
  .keyhint kbd {
    margin: 0 2px 0 6px; padding: 0 3px; border-radius: 3px;
    font: 600 9px/1.5 var(--font-mono, ui-monospace, monospace);
    color: var(--c-tx-2, #878580); background: var(--c-bg-2, #1c1b1a);
    border: 1px solid var(--c-line, #403e3c);
  }
</style>
