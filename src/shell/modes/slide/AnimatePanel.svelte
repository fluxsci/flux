<script lang="ts">
  // flux-slide — the ANIMATOR dock (animation rework §6): the shell that
  // composes the Properties mini-pane (the selected track's parameters) and
  // the BeatRail (collapsed beat chips + one expanded beat with grouped,
  // time-positioned lanes) — plus the toolbar (✨ auto-animate, beats,
  // camera, morph, preview), the resizable top edge, and the keyboard
  // cockpit. There is NO parts tree and NO S/A/M tri-state: everything is
  // visible by default (hide statically via the X-ray/Layers), and a track
  // exists only when an object animates — select an object anywhere and
  // press ⌃⇧A / ⌃⇧D / ⌃⇧T.
  import { pointerDrag } from "../../../lib/ui/pointerDrag";
  import { get } from "svelte/store";
  import { onDestroy, untrack } from "svelte";
  import { deckOverlay, activeBeat, commitDeckLive, selTrackIds, exitEndpointEdit } from "../../../lib/slide/store";
  import { selection, partSelection } from "../../../lib/store";
  import { slideById, addBeat as addBeatOp, setAnimation } from "../../../lib/slide/ops";
  import { applyAutoAnimation, animateElement } from "../../../lib/slide/autobuild";
    import { plotManifests } from "../../../lib/plot/store";
  import { slideLayout } from "./slideLayoutStore";
  import type { Slide, Track } from "../../../lib/slide/types";

  import BeatRail from "./animator/BeatRail.svelte";
  import AnimLibrary from "./animator/AnimLibrary.svelte";
  import { timelinePxPerMs } from "./animator/animatorState";
  import {
    deleteSelectedTracks, duplicateSelectedTracks, toggleSelectedDisabled,
    nudgeSelected, moveSelectedToAdjacentBeat,
  } from "./animator/trackActions";

  let { slide, onPreview, onAction, onSeek, onPause, onStop, onResume, onUndo, onRedo, onSave, onChooseMorph, time = 0, playing = false, previewing = false, loop = false, onLoop }: {
    slide: Slide | null; onPreview?: (startBeat?: number, range?: "step" | "from" | "slide") => void;
    onAction?: (action: "appear" | "change" | "ghost" | "emphasize" | "disappear") => void;
    onSeek?: (beat: number, time: number) => void; onPause?: () => void; onStop?: () => void; onResume?: () => void;
    onUndo?: () => void; onRedo?: () => void; onSave?: () => void;
    onChooseMorph?: (targetId: string, trackId?: string) => void;
    time?: number; playing?: boolean; previewing?: boolean; loop?: boolean; onLoop?: () => void;
  } = $props();

  let railRef = $state<{ groupSelection(): void; ungroupSelection(): void; cascadeSelection(): void } | null>(null);
  let libOpen = $state(false);

  const deck = $derived($deckOverlay); // stage/meta only — slide comes composed
  const sel = $derived([...$selection]);
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
    (document.querySelector(`.slide-mode .props [data-fld="${k}"]`) as HTMLElement | null)?.focus();
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
    if(t){selection.set(new Set(t.target.startsWith("@")?[]:[t.target]));partSelection.set(t.part?{elementId:t.target,partId:t.part}:null);requestAnimationFrame(()=>document.querySelector(`[data-track-id="${t.id}"]`)?.scrollIntoView({block:"nearest"}));}
  }
  function onAnimKey(e: KeyboardEvent) {
    const tgt = e.target as HTMLElement;
    if (tgt && (tgt.tagName === "INPUT" || tgt.tagName === "SELECT" || tgt.tagName === "TEXTAREA")) {
      if (e.key === "Enter" || e.key === "Escape") { e.preventDefault(); tgt.blur(); animEl?.focus({ preventScroll: true }); }
      return;
    }
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === "a") { e.preventDefault(); const tracks=slide?.beats[$activeBeat]?.tracks??[]; selTrackIds.set(tracks.map(t=>t.id!).filter(Boolean)); selection.set(new Set(tracks.filter(t=>!t.target.startsWith("@")).map(t=>t.target))); partSelection.set(null); return; }
    if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? onRedo?.() : onUndo?.(); return; }
    if (mod && e.key.toLowerCase() === "s") { e.preventDefault(); onSave?.(); return; }
    if (e.code === "Space") { e.preventDefault(); playing ? onPause?.() : previewing ? onResume?.() : onPreview?.($activeBeat); return; }
    if (mod && (e.key === "d" || e.key === "D") && !e.shiftKey) { e.preventDefault(); duplicateSelectedTracks(); return; }
    if (mod && e.shiftKey && e.key.toLowerCase() === "c") { e.preventDefault(); railRef?.cascadeSelection(); return; }
    if (mod && (e.key === "g" || e.key === "G")) {
      e.preventDefault();
      if (e.shiftKey) railRef?.ungroupSelection();
      else railRef?.groupSelection();
      return;
    }
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
      case "Escape": e.preventDefault(); if(previewing)onStop?.();else{selTrackIds.set([]);exitEndpointEdit();} break;
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
    if (animEl && document.activeElement?.closest('[data-command-scope="animation"]')) onAnimKey(e);
  }

  // --- draggable top edge → the dock's max-height. Drag up = taller dock — all
  // the way to a near-full-window animator (the stage keeps an 80px sliver).
  let dockResize = $state(false);
  let cancelDockResize: (() => void) | null = null;
  const DOCK_DEFAULT_H = 360;
  const dockMaxH = () => Math.max(150, window.innerHeight - 160);
  let lastBigH = 0;
  function startDockDrag(e: PointerEvent) {
    if (e.button !== 0) return;
    cancelDockResize?.();
    const original = get(slideLayout).animatorH;
    dockResize = true;
    cancelDockResize = pointerDrag(e, moveDockDrag,
      () => slideLayout.update(s => ({ ...s, animatorH: original })), endDockDrag);
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
    cancelDockResize = null;
  }
  onDestroy(() => cancelDockResize?.());

  // Canvas selection only identifies effects within the selected step.
  // Never jump to an earlier step just because a part was animated there.
  let lastSyncedSel = "";
  $effect(() => {
    const ids = [...$selection]; const part = $partSelection;
    const key = ids.join(",") + ":" + (part?.partId ?? "");
    if (key === lastSyncedSel) return;
    lastSyncedSel = key;
    const current = untrack(() => $selTrackIds);
    const tracks = slide?.beats[untrack(() => $activeBeat)]?.tracks ?? [];
    if (current.some(id => tracks.some(t => t.id === id && ids.includes(t.target) && (!part || t.part === part.partId)))) return;
    selTrackIds.set(tracks.filter(t => ids.includes(t.target) && (!part || t.part === part.partId)).map(t => t.id!).filter(Boolean));
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
    // Held in an object so TS keeps the union type across the commitDeck closure.
    const hold: { fb: { beatIndex: number; trackId: string } | null } = { fb: null };
    commitDeckLive((d) => {
      added = applyAutoAnimation(d, sid, plot.id, manifest);
      // Pre-0.2.0 plots have no parts tree → applyAutoAnimation adds nothing.
      // Fall back to a whole-element fade so the button always animates something.
      if (!added) hold.fb = animateElement(d, sid, plot.id, {});
    });
    const fb = hold.fb;
    const bi = added ? 1 : fb?.beatIndex ?? null;
    if (bi == null) return;
    activeBeat.set(bi);
    queueMicrotask(() => {
      const b = slide?.beats[bi];
      const first = b?.tracks.find((t) => t.target === plot.id) ?? b?.tracks[0];
      const id = first?.id ?? fb?.trackId;
      selTrackIds.set(id ? [id] : []);
      focusDock();
    });
  }

  // --- camera + morph authoring --------------------------------------------------
  function addBeatWith(label: string, track: Track) {
    const sid = slide?.id;
    if (!sid) return;
    let idx = 0;
    commitDeckLive((d) => {
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
  function addBeat() {
    const sid = slide?.id;
    if (!sid) return;
    let idx = 0;
    commitDeckLive((d) => {
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
  <div class="animator" bind:this={animEl} tabindex="0" role="group" data-command-scope="animation" aria-label="Animation timeline" style={`--anim-h:${$slideLayout.animatorH}px`}>
    <div class="dock-gutter" class:active={dockResize} role="separator" aria-orientation="horizontal"
      aria-label="Resize animator" onpointerdown={startDockDrag} ondblclick={toggleDockSize}><span class="grip"></span></div>
    <div class="bar">
      <strong class="ttl">Animate</strong>
      <div class="actions" aria-label="Add animation">
        <button class="b" disabled={!sel.length} onclick={() => onAction?.("appear")} title="Add an entrance · Cmd/Ctrl+Shift+A">Appear</button>
        <button class="b" disabled={!sel.length} onclick={() => onAction?.("change")} title="Edit a change at this step · Cmd/Ctrl+Shift+T">Change</button>
        <button class="b" disabled={sel.length !== 1} onclick={() => onAction?.("ghost")} title="Create copies which start together and transform independently">Ghost transform…</button>
        <button class="b" disabled={!sel.length} onclick={() => onAction?.("emphasize")} title="Highlight the selection">Emphasize</button>
        <button class="b" disabled={!sel.length} onclick={() => onAction?.("disappear")} title="Add an exit · Cmd/Ctrl+Shift+D">Disappear</button>
      </div>
      {#if selPlot}
        <button class="magic" onclick={autoAnimate} disabled={!selManifest}
          title={selManifest ? "Build a beat sequence from this plot's own animation hints" : "This plot has no build manifest to auto-animate"}>✨ Auto-animate</button>
      {/if}

      {#if sel.length === 1}
        <button class="b" onclick={() => addCameraMove("zoom")} title="Camera: zoom in to the selected element">🎥 Zoom</button>
      {/if}
      {#if slide.beats.length > 1}
        <button class="b" onclick={() => addCameraMove("reset")} title="Camera: pull back to the full slide">⤢ Reset</button>
      {/if}
      {#if selPlot}
        <button class="b" onclick={() => onChooseMorph?.(selPlot!.id)} title="Choose the plot's next data state from the project">Data morph…</button>
      {/if}
      {#if onPreview && slide.beats.length > 1}
        <div class="transport" aria-label="Playback controls">
          <button class="b play" onclick={() => playing ? onPause?.() : previewing ? onResume?.() : onPreview?.($activeBeat)} title="Play from the selected step, or pause · Space">{playing ? "Ⅱ Pause" : "▶ Play"}</button>
          <button class="b" onclick={() => onPreview?.(0)} title="Play the entire slide">Slide</button>
          <button class="b" onclick={onStop} disabled={!previewing} title="Return to editing">■ Stop</button>
          <button class="b" class:active={loop} onclick={onLoop} title="Repeat the chosen playback range (Step, Play from here, or Slide)">↻ Loop</button>
        </div>
      {/if}
      <span class="lib-wrap">
        <button class="b" class:active={libOpen} onclick={() => (libOpen = !libOpen)}
          title="Animation presets & templates — reusable track settings and preset bundles that auto-map onto matching objects">☆ Library</button>
        {#if libOpen}
          <AnimLibrary {slide} onClose={() => (libOpen = false)} />
        {/if}
      </span>
      <span class="spacer"></span>
      {#if $timelinePxPerMs != null}
        <button class="b" onclick={() => timelinePxPerMs.set(null)} title="Reset the timeline zoom to auto-fit">fit ⟲</button>
      {/if}
      <button class="b" onclick={toggleDockSize} title="Toggle animator size (or double-click the top edge)">⇕</button>
      <span class="keyhint" title="Cmd/Ctrl+Shift+A appear · +D disappear · +T change. Timeline: arrows navigate, Delete removes effects, Cmd/Ctrl+D duplicates, Cmd/Ctrl+G groups, Alt+arrows retime, Space plays/pauses.">Keyboard ⌨</span>
    </div>

    <div class="dock-body">
      <BeatRail bind:this={railRef} {slide} {plotTags} {manifestFor}
        onFocusDock={focusDock} onPreviewFrom={onPreview ? (b) => onPreview?.(b,"step") : undefined} {onSeek} {time} {playing} />
    </div>
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
  .dock-gutter {
    position: absolute; top: -3px; left: 0; right: 0; height: 7px;
    cursor: row-resize; z-index: 6; display: flex; align-items: center; justify-content: center;
  }
  .dock-gutter .grip { width: 100%; height: 1px; background: transparent; transition: background 0.12s; }
  .dock-gutter:hover .grip, .dock-gutter.active .grip { background: var(--c-accent, #4385be); height: 2px; }
  .bar { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .actions, .transport { display: flex; gap: 3px; align-items: center; }
  .transport { margin-left: auto; }
  .b:disabled { opacity: .4; cursor: default; }
  .ttl { font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--c-tx-3, #878580); }
  .spacer { flex: 1; }
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
  .lib-wrap { position: relative; display: inline-flex; }
  .b.active { border-color: var(--c-accent, #4385be); color: var(--c-tx-hi, #fff); }
  .dock-body { display: flex; gap: 10px; min-height: 0; flex: 1; }
  .keyhint { font-size: 10px; color: var(--c-tx-3, #6f6e69); white-space: nowrap; }

</style>
