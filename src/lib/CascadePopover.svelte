<script lang="ts">
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
  import { get } from "svelte/store";
  import {
    cascadeState,
    selection,
    activeFigureId,
    project,
    beginGesture,
    mutate,
    rollbackGesture,
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
    "stagger.perMs": "Stagger per-item (ms)",
  };
  const STEP: Partial<Record<string, number>> = {
    opacity: 0.05,
    strokeWidth: 0.5,
    fontSize: 0.5,
    rotation: 1,
    start: 50,
    duration: 50,
    "stagger.perMs": 25,
    "influence.in": 5,
    "influence.out": 5,
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
      sess.targets = [...get(selection)];
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
      : prop === "stagger.perMs"
        ? (trackApplies?.["stagger.perMs"] ?? 0)
        : trackTotal;
  $: totalCount = kind === "elements" ? (elInfo?.total ?? 0) : trackTotal;
  $: colorMode = kind === "elements" && isColorProp(prop as ElementCascadeProp);

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
      beginGesture();
      // A foreign edit landed since our last preview: the old entry stays a
      // valid undo point; rebase the baseline on the current model so the new
      // gesture previews against what the user now sees.
      if (sess.began) sess.baseline = new Map();
      sess.began = true;
    }
    const spec = buildElSpec();
    mutate((p) => {
      ops.cascadeElements(p, sess.figId, sess.targets, spec, sess.baseline);
      reflowTexts(p, sess.targets);
    });
    sess.gen = editGen.n;
  }

  function apply() {
    if (!open) return;
    if (kind === "tracks") tracks?.commit();
    // Elements: the gesture entry (if any) simply stands — ONE undo step.
    sess.began = false;
    cascadeState.set(null);
  }

  function cancel() {
    if (!open) return;
    if (kind === "tracks") {
      tracks?.cancel();
    } else if (sess.began && editGen.n === sess.gen) {
      // Only roll back when nothing landed after our last preview — never eat
      // a foreign entry (store.ts rollbackGesture pops unconditionally).
      rollbackGesture();
    }
    sess.began = false;
    cascadeState.set(null);
  }

  function onWin(e: KeyboardEvent) {
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
      <span class="n">
        {totalCount}
        {kind === "tracks" ? "tracks" : "units"}{#if applyCount < totalCount}&nbsp;· {applyCount} apply{/if}
      </span>
    </div>

    <div class="row">
      <label class="fld">
        <span class="lb">Property</span>
        <select class="prop" bind:value={prop} on:change={preview}>
          {#each propOptions as pr}
            <option value={pr}>{kind === "elements" ? ELEMENT_LABELS[pr as ElementCascadeProp] : TRACK_LABELS[pr as TrackCascadeProp]}</option>
          {/each}
        </select>
      </label>

      {#if colorMode}
        <label class="fld sm">
          <span class="lb">ΔL</span>
          <input class="dl" type="number" step="0.02" bind:value={dL} on:input={preview} />
        </label>
        <label class="fld sm">
          <span class="lb">ΔC</span>
          <input class="dc" type="number" step="0.01" bind:value={dC} on:input={preview} />
        </label>
        <label class="fld sm">
          <span class="lb">ΔH°</span>
          <input class="dh" type="number" step="5" bind:value={dH} on:input={preview} />
        </label>
      {:else}
        <div class="mode" role="radiogroup" aria-label="Mode">
          <button class:on={mode === "add"} on:click={() => ((mode = "add"), preview())} title="Add a delta per step">+</button>
          <button class:on={mode === "mul"} on:click={() => ((mode = "mul"), preview())} title="Multiply by a factor per step">×</button>
        </div>
        {#if mode === "add"}
          <label class="fld sm">
            <span class="lb">Δ / step</span>
            <input class="delta" type="number" step={STEP[prop] ?? 1} bind:value={delta} on:input={preview} />
          </label>
        {:else}
          <label class="fld sm">
            <span class="lb">× / step</span>
            <input class="factor" type="number" step="0.05" min="0.01" bind:value={factor} on:input={preview} />
          </label>
        {/if}
      {/if}
    </div>

    <div class="row">
      <label class="fld">
        <span class="lb">Order</span>
        <select class="ord" bind:value={order} on:change={preview}>
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
      </label>
      <label class="chk rev"><input type="checkbox" bind:checked={reverse} on:change={preview} /> Reverse</label>
      <label class="chk ff" title="Rank 0 keeps its value; the cascade starts at the second unit">
        <input type="checkbox" bind:checked={firstFixed} on:change={preview} /> First stays fixed
      </label>
    </div>

    <div class="ftr">
      <button class="ghost" on:click={cancel}>Cancel <kbd>esc</kbd></button>
      <button class="prime" on:click={apply}>Apply <kbd>↵</kbd></button>
    </div>
  </div>
{/if}

<style>
  .cascade-pop {
    position: absolute;
    top: 16px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 31;
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px 12px;
    background: var(--c-surface);
    border: 1px solid var(--c-line-strong);
    border-radius: 10px;
    box-shadow: var(--elev-3);
    color: var(--c-tx);
    font-size: 12px;
    user-select: none;
    min-width: 380px;
  }
  .hdr {
    display: flex;
    align-items: baseline;
    gap: 10px;
  }
  .ttl {
    text-transform: uppercase;
    letter-spacing: 0.6px;
    font-size: 11px;
    font-weight: 600;
    color: var(--c-accent-bright, var(--c-accent));
  }
  .n {
    opacity: 0.55;
  }
  .row {
    display: flex;
    align-items: flex-end;
    gap: 8px;
  }
  .fld {
    display: flex;
    flex-direction: column;
    gap: 3px;
    flex: 1;
    min-width: 0;
  }
  .fld.sm {
    flex: 0 0 74px;
  }
  .lb {
    opacity: 0.7;
  }
  select,
  input[type="number"] {
    background: var(--c-bg-raised);
    border: 1px solid var(--c-line-strong);
    color: var(--c-tx);
    border-radius: 4px;
    padding: 4px 6px;
    font-size: 12px;
    font-family: inherit;
    width: 100%;
  }
  select:focus,
  input:focus {
    border-color: var(--c-accent);
    outline: none;
  }
  .mode {
    display: flex;
    border: 1px solid var(--c-line-strong);
    border-radius: 6px;
    overflow: hidden;
    flex: 0 0 auto;
  }
  .mode button {
    background: var(--c-bg-raised);
    color: var(--c-tx-2);
    border: none;
    width: 28px;
    padding: 4px 0;
    font-size: 13px;
    cursor: pointer;
  }
  .mode button.on {
    background: var(--c-accent);
    color: var(--c-bg, #fff);
  }
  .chk {
    display: flex;
    align-items: center;
    gap: 5px;
    white-space: nowrap;
    opacity: 0.85;
    padding-bottom: 5px;
  }
  .ftr {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
  .ftr button {
    display: flex;
    align-items: center;
    gap: 6px;
    border-radius: 6px;
    padding: 4px 10px;
    font-size: 12px;
    cursor: pointer;
    border: 1px solid var(--c-line-strong);
    background: var(--c-bg-raised);
    color: var(--c-tx);
  }
  .ftr .prime {
    background: var(--c-accent);
    border-color: var(--c-accent);
    color: var(--c-bg, #fff);
  }
  kbd {
    background: rgba(0, 0, 0, 0.15);
    border-radius: 3px;
    padding: 0 4px;
    font-family: var(--font-mono, monospace);
    font-size: 10px;
  }
</style>
