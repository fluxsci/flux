<script lang="ts">
  import { yieldsToShellModal, isAnnotateChord } from "../shell/agent/annotationVisibility";

  // Cascade popover (Ctrl+Shift+C): apply a stepped delta across the selected
  // ELEMENTS (figure/slide canvas) or the animator's selected TRACKS. One
  // component serves both flavors; the track flavor is driven through the
  // injected `tracks` adapter so src/lib never imports slide-mode code.
  //
  // Session lifecycle (the Arrange-mode law, keyboard.ts:115):
  //   open → capture targets + (lazily) a baseline → first real change opens
  //   ONE gesture (beginGesture) → every change re-applies ABSOLUTE targets
  //   from the baseline via mutate() (idempotent; a property switch reverts
  //   the previous property's writes) → Enter/outside-click keep the gesture
  //   (one undo step) → Esc rolls it back. The editGen guard (the nudgeSession
  //   pattern) keeps a foreign mid-session edit from being mutated into or
  //   rolled back with our entry.
  //
  // THE LOOK (2026-11-20; the owner: "redesign it so it fits the same style of all of the other flux components
  // we've been redesigning"): the property menu's sibling. Its plate, its card, one line per thing, a number in
  // a well, paper keys in the menu's blue for what is on or off, one lit key (Apply) and one hint line. The one
  // thing ADDED is the ladder: what each unit gets, written out. Behaviour, keys and the hooks the gates and the
  // keyboard use (`.cascade-pop`, `select.prop`, `select.ord`, `input.delta/.factor/.dl/.dc/.dh`,
  // `.mode button`, `label.chk.rev/.ff input`, `.n`, `.ghost`, `.prime`) are as they were. Tokens: the menu's
  // (--fm-*, on :root in tokens.css). It costs what the old pop-up cost to open (see the note in the styles).
  import { onDestroy } from "svelte";
  import { cascadeLadder, unitOfLabel } from "./interact/cascadeLook";
  import { editSession } from "./interact/editSession";
  import { selectionTargets } from "./interact/selectionTargets";
  const edits = editSession();
  onDestroy(() => edits.finish());
  import { get } from "svelte/store";
  import {
    cascadeState,
    selection,
    activeFigureId,
    project,
    mutate,
    editGen,
  } from "./store";
  import type { Project, Element, Figure } from "./types";
  import * as ops from "./ops";
  import { reflowTexts } from "./text";
  import {
    cascadeUnits,
    unitAccepts,
    isColorProp,
    ELEMENT_CASCADE_PROPS,
    TRACK_CASCADE_PROPS,
    type ElementCascadeProp,
    type TrackCascadeProp,
    type CascadeSpec,
    type TrackCascadeSpec,
    type CascadeMode,
    type TrackCascadeAdapter,
  } from "./cascade";

  export let tracks: TrackCascadeAdapter | null = null;

  const ELEMENT_LABELS: Record<ElementCascadeProp, string> = {
    orbitAzimuth: "Azimuth (°)", orbitElevation: "Elevation (°)", orbitRoll: "Roll (°)", orbitZoom: "Zoom (×)", orbitPanX: "Pan X", orbitPanY: "Pan Y", orbitFov: "FOV (°)",
    x: "X",
    y: "Y",
    rotation: "Rotation (°)",
    opacity: "Opacity",
    width: "Width",
    height: "Height",
    strokeWidth: "Stroke width",
    cornerRadius: "Corner radius",
    fontSize: "Font size (pt)",
    fill: "Fill color",
    stroke: "Stroke color",
    color: "Text color",
  };
  const TRACK_LABELS: Record<TrackCascadeProp, string> = {
    start: "Start (ms)",
    duration: "Duration (ms)",
    "influence.in": "Ease-in influence (%)",
    "influence.out": "Ease-out influence (%)",
    "curve.bounce": "Spring bounce",
    "stagger.perMs": "Stagger per-item (ms)",
    "stagger.totalMs": "Stagger total (ms)",
    arc: "Arc",
  };
  const STEP: Partial<Record<string, number>> = {
    orbitAzimuth: 5, orbitElevation: 5, orbitRoll: 5, orbitZoom: .1, orbitPanX: .05, orbitPanY: .05, orbitFov: 5,
    opacity: 0.05,
    strokeWidth: 0.5,
    fontSize: 0.5,
    rotation: 1,
    start: 50,
    duration: 50,
    "stagger.perMs": 25,
    "stagger.totalMs": 50,
    arc: 0.1,
    "influence.in": 5,
    "influence.out": 5,
    "curve.bounce": 0.05,
  };

  // Non-reactive session box (guide §9: $: blocks must not read+reassign the
  // same reactive let — the memo lives outside reactivity).
  const sess = {
    for: null as unknown,
    kind: "elements" as "elements" | "tracks",
    figId: "",
    targets: [] as string[],
    baseline: new Map<string, Element>(),
    began: false,
    gen: -1,
  };

  // UI state (reset per session by startSession).
  let prop: string = "x";
  let mode: CascadeMode = "add";
  let delta = 0;
  let factor = 1;
  let dL = 0;
  let dC = 0;
  let dH = 0;
  let order: "selection" | "layer" | "x" | "y" | "timeline" | "list" = "selection";
  let reverse = false;
  let firstFixed = false;
  let trackTotal = 0;
  let trackApplies: Record<TrackCascadeProp, number> | null = null;
  let panelEl: HTMLElement | null = null;

  $: open = $cascadeState !== null;
  $: kind = $cascadeState?.kind ?? "elements";

  // One start/end per state transition, guarded by the non-reactive box.
  $: if ($cascadeState !== sess.for) {
    const prev = sess.for;
    sess.for = $cascadeState;
    if (prev && sess.began) {
      // Closed by an external actor (mode switch/eviction) mid-session: the
      // previewed state simply stands as the one undo entry.
      edits.finish();
      sess.began = false;
    }
    if ($cascadeState) startSession($cascadeState.kind);
  }

  function startSession(k: "elements" | "tracks") {
    sess.kind = k;
    sess.baseline = new Map();
    sess.began = false;
    sess.gen = -1;
    mode = "add";
    delta = 0;
    factor = 1;
    dL = 0;
    dC = 0;
    dH = 0;
    reverse = false;
    firstFixed = false;
    if (k === "elements") {
      sess.figId = get(activeFigureId) ?? "";
      const fig = get(project).figures.find(f => f.id === sess.figId);
      sess.targets = fig ? selectionTargets(fig, get(selection), { editable: true }).map(e => e.id) : [];
      order = "selection";
      if (!ELEMENT_LABELS[prop as ElementCascadeProp]) prop = "x";
    } else {
      order = "timeline";
      prop = "start";
      tracks?.begin();
      const info = tracks?.info();
      trackTotal = info?.total ?? 0;
      trackApplies = info?.applies ?? null;
    }
  }

  // --- elements flavor: applicability info ("n of m apply") -------------------
  function figOf(p: Project): Figure | null {
    return p.figures.find((f) => f.id === sess.figId) ?? null;
  }
  $: elInfo = open && kind === "elements" ? computeElInfo($project) : null;
  function computeElInfo(p: Project) {
    const f = figOf(p);
    if (!f) return null;
    const units = cascadeUnits(f, sess.targets);
    const applies: Partial<Record<ElementCascadeProp, number>> = {};
    for (const pr of ELEMENT_CASCADE_PROPS) applies[pr] = units.filter((u) => unitAccepts(u, pr)).length;
    return { total: units.length, applies };
  }
  $: propOptions =
    kind === "elements"
      ? ELEMENT_CASCADE_PROPS.filter((pr) => (elInfo?.applies[pr] ?? 0) > 0)
      : TRACK_CASCADE_PROPS.filter((pr) => (trackApplies?.[pr] ?? trackTotal) > 0);
  $: applyCount =
    kind === "elements"
      ? (elInfo?.applies[prop as ElementCascadeProp] ?? 0)
      : (trackApplies?.[prop as TrackCascadeProp] ?? trackTotal);
  $: totalCount = kind === "elements" ? (elInfo?.total ?? 0) : trackTotal;
  $: colorMode = kind === "elements" && isColorProp(prop as ElementCascadeProp);

  // What the pop-up says about the cascade in hand (look only: nothing here reaches the model).
  $: propLabel = kind === "elements" ? (ELEMENT_LABELS[prop as ElementCascadeProp] ?? "") : (TRACK_LABELS[prop as TrackCascadeProp] ?? "");
  $: unit = colorMode || mode === "mul" ? "" : unitOfLabel(propLabel);
  // The ladder is ONE run of text (not an element a rung): the pop-up is opened and closed whole, and every
  // element in it is paid for each time.
  $: ladder = open ? cascadeLadder({ mode, delta: +delta || 0, factor: +factor || 0, color: colorMode ? { dL: +dL || 0, dC: +dC || 0, dH: +dH || 0 } : null, firstFixed }, applyCount).map((r) => (r ? r.text : "…")).join("  ") : "";

  function isNoop(): boolean {
    if (colorMode) return !dL && !dC && !dH;
    return mode === "mul" ? factor === 1 : !delta;
  }

  function buildElSpec(): CascadeSpec {
    const p = prop as ElementCascadeProp;
    return {
      property: p,
      mode,
      delta,
      factor,
      ...(isColorProp(p) ? { color: { dL, dC, dH } } : {}),
      order: order as CascadeSpec["order"],
      reverse,
      firstFixed,
    };
  }
  function buildTrackSpec(): TrackCascadeSpec {
    return {
      property: prop as TrackCascadeProp,
      mode,
      delta,
      factor,
      order: order === "timeline" ? "timeline" : "list",
      reverse,
      firstFixed,
    };
  }

  function preview() {
    if (!open) return;
    if (kind === "tracks") {
      if (!sess.began && isNoop()) return;
      sess.began = true;
      tracks?.preview(buildTrackSpec());
      return;
    }
    if (!sess.began && isNoop()) return;
    if (mode === "mul" && !(factor > 0)) return;
    if (!sess.began || editGen.n !== sess.gen) {
      // A foreign edit landed since our last preview: the old entry stays a
      // valid undo point; rebase the baseline on the current model so the new
      // gesture previews against what the user now sees.
      if (sess.began) sess.baseline = new Map();
      sess.began = true;
    }
    const spec = buildElSpec();
    edits.run(() => mutate((p) => {
      ops.cascadeElements(p, sess.figId, sess.targets, spec, sess.baseline);
      reflowTexts(p, sess.targets);
    }));
    sess.gen = editGen.n;
  }

  function apply() {
    if (!open) return;
    if (kind === "tracks") tracks?.commit();
    else edits.finish();
    // One undo step for the completed preview.
    sess.began = false;
    cascadeState.set(null);
  }

  function cancel() {
    if (!open) return;
    if (kind === "tracks") {
      tracks?.cancel();
    } else edits.cancel();
    sess.began = false;
    cascadeState.set(null);
  }

  function onWin(e: KeyboardEvent) {
    if (yieldsToShellModal(e) || isAnnotateChord(e)) return;
    if (!open) return;
    // The popover owns the keyboard while open (f-menu pattern); handleKey is
    // additionally gated on cascadeState — belt and suspenders.
    e.stopImmediatePropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      cancel();
    } else if (e.key === "Enter") {
      // A NumberField input's own keydown has already blurred + committed the
      // field (its change → preview ran synchronously) before this bubbles.
      e.preventDefault();
      apply();
    }
  }

  function onWinPointerDown(e: PointerEvent) {
    if (yieldsToShellModal(e)) return;
    if (!open || !panelEl) return;
    // Outside interaction = Enter semantics: keep the preview, close, and let
    // the pointer proceed into the canvas — a foreign gesture can then never
    // interleave with an open cascade session.
    if (!panelEl.contains(e.target as Node)) apply();
  }
</script>

<svelte:window on:keydown={onWin} on:pointerdown|capture={onWinPointerDown} />

{#if open}
  <div class="cascade-pop" bind:this={panelEl} role="dialog" aria-label="Cascade">
    <div class="hdr">
      <span class="ttl">Cascade</span>
      <span class="n" class:part={applyCount < totalCount}>
        {totalCount}
        {kind === "tracks" ? "tracks" : "units"}{#if applyCount < totalCount}&nbsp;· {applyCount} apply{/if}
      </span>
    </div>

    <div class="card">
      <label class="row">
        <span class="lb">property</span>
        <select class="prop" bind:value={prop} on:change={preview}>
          {#each propOptions as pr}
            <option value={pr}>{kind === "elements" ? ELEMENT_LABELS[pr as ElementCascadeProp] : TRACK_LABELS[pr as TrackCascadeProp]}</option>
          {/each}
        </select>
      </label>

      <div class="row">
        <span class="lb">each step</span>
        {#if colorMode}
          <label class="fld" data-lead="L" title="Lightness per step (OKLCh, 0 to 1)"><input class="dl" type="number" step="0.02" bind:value={dL} on:input={preview} /></label>
          <label class="fld" data-lead="C" title="Chroma per step (OKLCh)"><input class="dc" type="number" step="0.01" bind:value={dC} on:input={preview} /></label>
          <label class="fld" data-lead="H°" title="Hue per step, in degrees"><input class="dh" type="number" step="5" bind:value={dH} on:input={preview} /></label>
        {:else}
          <div class="mode" role="group" aria-label="Mode">
            <button class="pk" class:on={mode === "add"} on:click={() => ((mode = "add"), preview())} title="Add a delta per step">+</button>
            <button class="pk" class:on={mode === "mul"} on:click={() => ((mode = "mul"), preview())} title="Multiply by a factor per step">×</button>
          </div>
          {#if mode === "add"}
            <label class="fld" data-lead="Δ" data-unit={unit} title="Added per step"><input class="delta" type="number" step={STEP[prop] ?? 1} bind:value={delta} on:input={preview} /></label>
          {:else}
            <label class="fld" data-lead="×" title="Multiplied per step"><input class="factor" type="number" step="0.05" min="0.01" bind:value={factor} on:input={preview} /></label>
          {/if}
        {/if}
      </div>

      <div class="row">
        <span class="lb">order</span>
        <select class="ord" aria-label="Order" bind:value={order} on:change={preview}>
          {#if kind === "elements"}
            <option value="selection">Selection</option>
            <option value="layer">Layers</option>
            <option value="x">Left → right</option>
            <option value="y">Top → bottom</option>
          {:else}
            <option value="timeline">Timeline</option>
            <option value="list">Selection</option>
          {/if}
        </select>
        <label class="chk rev" title="Reverse the order"><input class="pk" type="checkbox" aria-label="Reverse" data-says="reverse" bind:checked={reverse} on:change={preview} /></label>
        <label class="chk ff" title="Rank 0 keeps its value; the cascade starts at the second unit"><input class="pk" type="checkbox" aria-label="First stays fixed" data-says="first stays" bind:checked={firstFixed} on:change={preview} /></label>
      </div>

      <!-- The ladder: what each unit gets, in the cascade's order (its name, "gives", is drawn by the rule). -->
      <div class="ladder">{ladder}</div>
    </div>

    <div class="ftr">
      <button class="ghost hkey" on:click={cancel}>Cancel <kbd>esc</kbd></button>
      <button class="prime pk on" on:click={apply}>Apply <kbd>↵</kbd></button>
    </div>
  </div>
{/if}

<style>
  /* The property menu's sibling (see the script's head): its plate and card, its blue, its keys. Where it stands
     is as it was. It is opened and closed whole, so it is built from as few elements as the old pop-up (a choice's
     arrow, a number's lead, a key's word and the hint are drawn by rules; the ladder is one run of text), it has
     no image and it does not fade in: measured on production bundles, a first version with a wrapper per
     control, the Flux mark and an entrance fade cost a quarter more per open than the pop-up it replaced. */
  .cascade-pop {
    position: absolute; top: 16px; left: 50%; transform: translateX(-50%); z-index: 31;
    display: flex; flex-direction: column; gap: 4px; box-sizing: border-box; width: 348px; max-width: calc(100% - 16px); padding: 4px;
    color: var(--fm-tx); font: 12.5px var(--font-serif); user-select: none;
    background: var(--fm-plate); border: 1px solid var(--fm-line); border-radius: 12px;
    box-shadow: 0 10px 26px -10px rgba(0, 0, 0, 0.7), 0 2px 6px rgba(0, 0, 0, 0.4);
  }

  /* the head: the tool's name, what it is working on */
  .hdr { flex: none; display: flex; align-items: center; gap: 8px; height: 30px; padding: 0 9px 0 10px; }
  .ttl { font: 600 13.5px var(--font-serif); color: var(--fm-tx-hi); white-space: nowrap; }
  .n { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: right; color: var(--fm-tx-dim); font: 10px var(--font-mono); font-variant-numeric: tabular-nums; }
  /* Some of the selection cannot take this property: say so in the menu's blue. */
  .n.part { color: var(--fm-blue-hi); }

  /* the card: one line per thing */
  .card { border-radius: 8px; background: var(--fm-card); border: 1px solid var(--fm-line); box-shadow: var(--fm-lift); padding: 3px 0 0; }
  .row { display: flex; align-items: center; gap: 6px; min-height: 26px; padding: 0 6px 0 9px; margin: 0 2px; border-radius: 5px; }
  .row:hover { background: rgba(255, 252, 240, 0.04); }
  .lb { flex: 1; min-width: 56px; color: var(--fm-tx); white-space: nowrap; }
  .row:hover > .lb { color: var(--fm-tx-hi); }

  /* A choice: the list is the system's, the face is the menu's; its arrow is drawn (two gradients: nothing to
     fetch or decode, and no element). */
  select {
    appearance: none; min-width: 0; height: 20px; margin: 0; padding: 0 20px 0 7px; border: 0; border-radius: 5px;
    color: var(--fm-tx-hi); font: 12px var(--font-serif); box-shadow: inset 0 0 0 1px var(--fm-line-2); cursor: var(--cursor-cross-hover); outline: none; text-overflow: ellipsis;
    background: linear-gradient(45deg, transparent 50%, var(--fm-tx-dim) 50%) calc(100% - 11px) 8px / 4px 4px no-repeat, linear-gradient(135deg, var(--fm-tx-dim) 50%, transparent 50%) calc(100% - 7px) 8px / 4px 4px no-repeat;
  }
  select:hover, select:focus-visible { background-color: var(--fm-well); box-shadow: inset 0 0 0 1px var(--fm-blue); }
  option { background: var(--fm-card); color: var(--fm-tx-hi); }

  /* A number in its well, led by what it is (Δ, ×, L, C, H°) and followed by its unit: both drawn by rules. */
  .fld { display: inline-flex; align-items: center; gap: 3px; min-width: 0; color: var(--fm-tx-dim); font: 10.5px var(--font-mono); }
  .fld::before { content: attr(data-lead); }
  .fld[data-unit]::after { content: attr(data-unit); }
  input[type="number"] {
    appearance: textfield; -moz-appearance: textfield; field-sizing: content; box-sizing: content-box; min-width: 3ch; max-width: 9ch; height: 18px; margin: 0; padding: 0 4px;
    background: var(--fm-well); border: 0; border-radius: 4px; color: var(--fm-tx-hi); font: 12px/18px var(--font-mono); font-variant-numeric: tabular-nums; text-align: right; outline: none;
    box-shadow: inset 0 0 0 1px rgba(255, 252, 240, 0.12);
  }
  input[type="number"]::-webkit-inner-spin-button, input[type="number"]::-webkit-outer-spin-button { appearance: none; margin: 0; }
  input[type="number"]:hover { box-shadow: inset 0 0 0 1px rgba(255, 252, 240, 0.26); }
  input[type="number"]:focus { box-shadow: inset 0 0 0 1px var(--fm-blue); }

  /* Paper keys (the menu's): proud at rest, down when pressed, lit when on. */
  .pk {
    position: relative; display: inline-flex; align-items: center; justify-content: center; gap: 5px; flex: none; box-sizing: border-box; height: 20px; min-width: 22px; margin: 0; padding: 0 6px; border-radius: 5px;
    background: var(--fm-paper); color: var(--fm-blue-deep); border: 1px solid color-mix(in oklab, var(--fm-blue) 45%, transparent); box-shadow: 0 1.5px 2.5px rgba(0, 0, 0, 0.5);
    font: 600 10.5px/1 var(--font-mono); white-space: nowrap; cursor: var(--cursor-cross-hover);
  }
  .pk:hover { background: color-mix(in oklab, var(--fm-blue) 16%, var(--fm-paper)); border-color: var(--fm-blue); }
  .pk:active { transform: translateY(1px); box-shadow: 0 0 1px rgba(0, 0, 0, 0.6); }
  .pk.on { background: var(--fm-blue); border-color: color-mix(in oklab, var(--fm-paper) 60%, var(--fm-blue)); color: var(--fm-paper); }
  .pk.on:hover { background: color-mix(in oklab, var(--fm-paper) 14%, var(--fm-blue)); }
  .pk:focus-visible { outline: 1.5px solid var(--fm-blue-hi); outline-offset: 1px; }
  /* add | multiply: two keys of one switch */
  .mode { display: inline-flex; flex: none; }
  .mode .pk { width: 24px; padding: 0; font-size: 13px; border-radius: 5px 0 0 5px; }
  .mode .pk + .pk { border-radius: 0 5px 5px 0; margin-left: -1px; }
  /* An on/off key IS its checkbox, drawn as the key: it says what it is, and is lit when checked (no class to
     keep in step, no element beside it). */
  .chk { display: inline-flex; flex: none; }
  .chk .pk { appearance: none; }
  .chk .pk::after { content: attr(data-says); }
  .chk .pk:checked { background: var(--fm-blue); border-color: color-mix(in oklab, var(--fm-paper) 60%, var(--fm-blue)); color: var(--fm-paper); }
  .chk .pk:checked:hover { background: color-mix(in oklab, var(--fm-paper) 14%, var(--fm-blue)); }

  /* the ladder: what each unit gets */
  .ladder { display: flex; align-items: center; gap: 10px; height: 24px; margin-top: 3px; padding: 0 9px 0 11px; border-top: 1px solid var(--fm-line); border-radius: 0 0 7px 7px; background: rgba(0, 0, 0, 0.18);
    color: var(--fm-blue-hi); font: 600 10.5px var(--font-mono); font-variant-numeric: tabular-nums; white-space: pre; overflow: hidden; }
  .ladder::before { content: "gives"; flex: 1; color: var(--fm-tx-dim); font: italic 12.5px var(--font-serif); }

  /* the foot: one line of what is true while it is open (drawn by the rule), then the two ways out */
  .ftr { flex: none; display: flex; align-items: center; gap: 6px; height: 24px; padding: 0 1px 0 8px; }
  .ftr::before { content: "live · one undo step"; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fm-tx-dim); font: 10px var(--font-mono); }
  .hkey { flex: none; display: inline-flex; align-items: center; gap: 5px; height: 20px; margin: 0; padding: 0 6px; background: transparent; border: 1px solid transparent; border-radius: 5px; color: var(--fm-tx); font: 11px var(--font-ui); cursor: var(--cursor-cross-hover); }
  .hkey:hover { background: rgba(255, 252, 240, 0.07); border-color: var(--fm-line-2); color: var(--fm-tx-hi); }
  .hkey:focus-visible { outline: 1.5px solid var(--fm-blue-hi); outline-offset: 1px; }
  kbd { min-width: 14px; height: 14px; padding: 0 3px; font-size: 9px; line-height: 11px; color: inherit; }
  .hkey kbd { color: var(--fm-tx-dim); }
  .prime { padding: 0 5px 0 8px; font: 600 11px var(--font-ui); }
  .prime kbd { border-color: color-mix(in oklab, var(--fm-paper) 55%, transparent); }
</style>
