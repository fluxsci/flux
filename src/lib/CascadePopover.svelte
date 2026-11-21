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
  // we've been redesigning"): the property menu's sibling. Its plate, its card, one line per thing, a number
  // without a box until the hand is on it, paper keys in the menu's blue for what is on or off, one lit key
  // (Apply) and one hint line. The one thing ADDED is the ladder: what each unit gets, written out. Behaviour,
  // keys and the hooks the gates and the keyboard use (`.cascade-pop`, `select.prop`, `select.ord`,
  // `input.delta/.factor/.dl/.dc/.dh`, `.mode button`, `label.chk.rev/.ff input`, `.n`, `.ghost`, `.prime`)
  // are as they were. Tokens: the menu's (--fm-*, on :root in tokens.css).
  import { onDestroy } from "svelte";
  import { logoImageUrl } from "../shell/logoImage";
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
  const MARK = logoImageUrl();

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
  $: idle = colorMode ? !dL && !dC && !dH : mode === "mul" ? factor === 1 : !delta;
  $: ladder = open ? cascadeLadder({ mode, delta: +delta || 0, factor: +factor || 0, color: colorMode ? { dL: +dL || 0, dC: +dC || 0, dH: +dH || 0 } : null, firstFixed }, applyCount) : [];

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
      <img class="mark" src={MARK} alt="" width="14" height="14" />
      <span class="vsep"></span>
      <span class="ttl">Cascade</span>
      <span class="n" class:part={applyCount < totalCount}>
        {totalCount}
        {kind === "tracks" ? "tracks" : "units"}{#if applyCount < totalCount}&nbsp;· {applyCount} apply{/if}
      </span>
    </div>

    <div class="card">
      <label class="row">
        <span class="lb">property</span>
        <span class="ctl">
          <span class="sel">
            <select class="prop" bind:value={prop} on:change={preview}>
              {#each propOptions as pr}
                <option value={pr}>{kind === "elements" ? ELEMENT_LABELS[pr as ElementCascadeProp] : TRACK_LABELS[pr as TrackCascadeProp]}</option>
              {/each}
            </select><i class="chev"></i>
          </span>
        </span>
      </label>

      <div class="row">
        <span class="lb">each step</span>
        <span class="ctl">
          {#if colorMode}
            <label class="fld sm" title="Lightness per step (OKLCh, 0 to 1)"><span class="lead">L</span><input class="dl" type="number" step="0.02" bind:value={dL} on:input={preview} /></label>
            <label class="fld sm" title="Chroma per step (OKLCh)"><span class="lead">C</span><input class="dc" type="number" step="0.01" bind:value={dC} on:input={preview} /></label>
            <label class="fld sm" title="Hue per step, in degrees"><span class="lead">H°</span><input class="dh" type="number" step="5" bind:value={dH} on:input={preview} /></label>
          {:else}
            <div class="mode" role="radiogroup" aria-label="Mode">
              <button class="pk" class:on={mode === "add"} role="radio" aria-checked={mode === "add"} on:click={() => ((mode = "add"), preview())} title="Add a delta per step">+</button>
              <button class="pk" class:on={mode === "mul"} role="radio" aria-checked={mode === "mul"} on:click={() => ((mode = "mul"), preview())} title="Multiply by a factor per step">×</button>
            </div>
            {#if mode === "add"}
              <label class="fld sm" title="Added per step">
                <span class="lead">Δ</span>
                <input class="delta" type="number" step={STEP[prop] ?? 1} bind:value={delta} on:input={preview} />{#if unit}<span class="unit">{unit}</span>{/if}
              </label>
            {:else}
              <label class="fld sm" title="Multiplied per step">
                <span class="lead">×</span>
                <input class="factor" type="number" step="0.05" min="0.01" bind:value={factor} on:input={preview} />
              </label>
            {/if}
          {/if}
        </span>
      </div>

      <div class="row">
        <span class="lb">order</span>
        <span class="ctl">
          <span class="sel">
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
            </select><i class="chev"></i>
          </span>
          <label class="chk rev pk" class:on={reverse} title="Reverse the order"><input type="checkbox" bind:checked={reverse} on:change={preview} />reverse</label>
          <label class="chk ff pk" class:on={firstFixed} title="Rank 0 keeps its value; the cascade starts at the second unit">
            <input type="checkbox" bind:checked={firstFixed} on:change={preview} />first stays
          </label>
        </span>
      </div>

      <!-- The ladder: what each unit gets, in the cascade's order. -->
      <div class="ladder" class:idle aria-label="What each {kind === 'tracks' ? 'track' : 'unit'} gets">
        <span class="lb">gives</span>
        <span class="rungs">{#each ladder as r}{#if r}<b class:still={r.still}>{r.text}</b>{:else}<i>…</i>{/if}{/each}</span>
      </div>
    </div>

    <div class="ftr">
      <span class="hints">{idle ? "set a step to begin" : "live · one undo step"}</span>
      <button class="ghost hkey" on:click={cancel}>Cancel <kbd>esc</kbd></button>
      <button class="prime pk on" on:click={apply}>Apply <kbd>↵</kbd></button>
    </div>
  </div>
{/if}

<style>
  /* The property menu's sibling (see the script's head): its plate and card, its blue, its keys. Always dark, like
     the menu, so the native lists and steppers are asked for dark too. Where it stands is as it was. */
  .cascade-pop {
    position: absolute; top: 16px; left: 50%; transform: translateX(-50%); z-index: 31;
    display: flex; flex-direction: column; gap: 4px; box-sizing: border-box; width: 348px; max-width: calc(100% - 16px); padding: 4px;
    color: var(--fm-tx); font: 12.5px var(--font-serif); color-scheme: dark; user-select: none;
    background: var(--fm-plate); border: 1px solid var(--fm-line); border-radius: 12px;
    box-shadow: 0 10px 26px -10px rgba(0, 0, 0, 0.7), 0 2px 6px rgba(0, 0, 0, 0.4);
    animation: cascade-in 70ms var(--ease-standard, ease-out) 1;
  }
  @media (prefers-reduced-motion: reduce) { .cascade-pop { animation: none; } }
  @keyframes cascade-in { from { opacity: 0; } to { opacity: 1; } }

  /* the head: the mark, the tool's name, what it is working on */
  .hdr { flex: none; display: flex; align-items: center; gap: 8px; height: 30px; padding: 0 9px; }
  .mark { display: block; width: 14px; height: 14px; flex: none; }
  .vsep { width: 1px; height: 14px; background: var(--fm-line-2); flex: none; }
  .ttl { font: 600 13.5px var(--font-serif); color: var(--fm-tx-hi); white-space: nowrap; }
  .n { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: right; color: var(--fm-tx-dim); font: 10px var(--font-mono); font-variant-numeric: tabular-nums; }
  /* Some of the selection cannot take this property: say so in the menu's blue. */
  .n.part { color: var(--fm-blue-hi); }

  /* the card: one line per thing */
  .card { border-radius: 8px; background: var(--fm-card); border: 1px solid var(--fm-line); box-shadow: var(--fm-lift); padding: 3px 0 0; }
  .row { display: grid; grid-template-columns: 62px minmax(0, 1fr); align-items: center; column-gap: 7px; min-height: 26px; padding: 0 6px 0 9px; margin: 0 2px; border-radius: 5px; }
  .row:hover { background: rgba(255, 252, 240, 0.04); }
  .lb { color: var(--fm-tx); white-space: nowrap; }
  .row:hover > .lb { color: var(--fm-tx-hi); }
  .ctl { display: flex; align-items: center; justify-content: flex-end; gap: 6px; min-width: 0; }

  /* a choice: the list is the system's, the face is the menu's */
  .sel { position: relative; display: inline-flex; min-width: 0; }
  select {
    appearance: none; min-width: 0; max-width: 100%; height: 20px; margin: 0; padding: 0 20px 0 7px; background: transparent; border: 0; border-radius: 5px;
    color: var(--fm-tx-hi); font: 12px var(--font-serif); box-shadow: inset 0 0 0 1px var(--fm-line-2); cursor: var(--cursor-cross-hover); outline: none; text-overflow: ellipsis;
  }
  select:hover, select:focus-visible { background: var(--fm-well); box-shadow: inset 0 0 0 1px var(--fm-blue); }
  option { background: var(--fm-card); color: var(--fm-tx-hi); }
  .chev { position: absolute; right: 8px; top: 5px; width: 6px; height: 6px; border: solid var(--fm-tx-dim); border-width: 0 1.5px 1.5px 0; transform: rotate(45deg); pointer-events: none; }

  /* a number: no box until the hand is on it */
  .fld { display: inline-flex; align-items: center; gap: 3px; min-width: 0; }
  .lead { color: var(--fm-tx-dim); font: 10.5px var(--font-mono); }
  input[type="number"] {
    appearance: textfield; -moz-appearance: textfield; field-sizing: content; box-sizing: content-box; min-width: 3ch; max-width: 9ch; height: 18px; margin: 0; padding: 0 4px;
    background: var(--fm-well); border: 0; border-radius: 4px; color: var(--fm-tx-hi); font: 12px/18px var(--font-mono); font-variant-numeric: tabular-nums; text-align: right; outline: none;
    box-shadow: inset 0 0 0 1px rgba(255, 252, 240, 0.12);
  }
  input[type="number"]::-webkit-inner-spin-button, input[type="number"]::-webkit-outer-spin-button { appearance: none; margin: 0; }
  input[type="number"]:hover { box-shadow: inset 0 0 0 1px rgba(255, 252, 240, 0.26); }
  input[type="number"]:focus { box-shadow: inset 0 0 0 1px var(--fm-blue); }
  .unit { margin-left: 1px; color: var(--fm-tx-dim); font: 10.5px var(--font-mono); }

  /* Paper keys (the menu's): proud at rest, down when pressed, lit when on. */
  .pk {
    position: relative; display: inline-flex; align-items: center; justify-content: center; gap: 5px; flex: none; box-sizing: border-box; height: 20px; min-width: 22px; margin: 0; padding: 0 6px; border-radius: 5px;
    background: var(--fm-paper); color: var(--fm-blue-deep); border: 1px solid color-mix(in oklab, var(--fm-blue) 45%, transparent); box-shadow: 0 1.5px 2.5px rgba(0, 0, 0, 0.5);
    font: 600 10.5px/1 var(--font-mono); white-space: nowrap; cursor: var(--cursor-cross-hover); transition: background-color 80ms linear, border-color 80ms linear, color 80ms linear;
  }
  .pk:hover { background: color-mix(in oklab, var(--fm-blue) 16%, var(--fm-paper)); border-color: var(--fm-blue); }
  .pk:active { transform: translateY(1px); box-shadow: 0 0 1px rgba(0, 0, 0, 0.6); background: color-mix(in oklab, var(--fm-blue) 30%, var(--fm-paper)); }
  .pk.on { background: var(--fm-blue); border-color: color-mix(in oklab, var(--fm-paper) 60%, var(--fm-blue)); color: var(--fm-paper); }
  .pk.on:hover { background: color-mix(in oklab, var(--fm-paper) 14%, var(--fm-blue)); }
  .pk:focus-visible, .pk:has(input:focus-visible) { outline: 1.5px solid var(--fm-blue-hi); outline-offset: 1px; }
  /* add | multiply: two keys of one switch */
  .mode { display: inline-flex; flex: none; }
  .mode .pk { width: 24px; padding: 0; font-size: 13px; }
  .mode .pk:first-child { border-radius: 5px 0 0 5px; }
  .mode .pk:last-child { border-radius: 0 5px 5px 0; margin-left: -1px; }
  /* An on/off key is its checkbox, laid over the whole face: the key reads it, the hand presses it. */
  .chk input { position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; opacity: 0; cursor: inherit; }

  /* the ladder: what each unit gets */
  .ladder { display: grid; grid-template-columns: 62px minmax(0, 1fr); align-items: center; column-gap: 7px; min-height: 24px; margin-top: 3px; padding: 0 9px 0 11px; border-top: 1px solid var(--fm-line); border-radius: 0 0 7px 7px; background: rgba(0, 0, 0, 0.18); }
  .ladder .lb { color: var(--fm-tx-dim); font-style: italic; }
  .rungs { display: flex; justify-content: flex-end; gap: 10px; min-width: 0; overflow: hidden; white-space: nowrap; font: 10.5px var(--font-mono); font-variant-numeric: tabular-nums; }
  .rungs b { font-weight: 600; color: var(--fm-blue-hi); }
  .rungs b.still, .ladder.idle .rungs b, .rungs i { font-weight: 400; font-style: normal; color: var(--fm-tx-dim); }

  /* the foot: one line of where things stand, then the two ways out */
  .ftr { flex: none; display: flex; align-items: center; gap: 6px; height: 24px; padding: 0 1px 0 8px; }
  .hints { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fm-tx-dim); font: 10px var(--font-mono); }
  .hkey {
    flex: none; display: inline-flex; align-items: center; gap: 5px; height: 20px; margin: 0; padding: 0 6px; background: transparent; border: 1px solid transparent; border-radius: 5px;
    color: var(--fm-tx); font: 11px var(--font-ui); cursor: var(--cursor-cross-hover); transition: background-color 80ms linear, color 80ms linear, border-color 80ms linear;
  }
  .hkey:hover { background: rgba(255, 252, 240, 0.07); border-color: var(--fm-line-2); color: var(--fm-tx-hi); }
  .hkey:focus-visible { outline: 1.5px solid var(--fm-blue-hi); outline-offset: 1px; }
  kbd { min-width: 14px; height: 14px; padding: 0 3px; font-size: 9px; line-height: 11px; color: inherit; }
  .hkey kbd { color: var(--fm-tx-dim); }
  .prime { padding: 0 5px 0 8px; font: 600 11px var(--font-ui); }
  .prime kbd { border-color: color-mix(in oklab, var(--fm-paper) 55%, transparent); }
</style>
