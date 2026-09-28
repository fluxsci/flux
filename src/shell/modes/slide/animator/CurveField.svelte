<script module lang="ts">
  import { resolveCurve, type ResolvedCurve, type Curve } from "../../../../lib/slide/curves";
  import type { EasingToken, Influence } from "../../../../lib/slide/types";

  export type CurveEdit = Curve | EasingToken | { influence: Influence };
  // Unit coordinates serve both the thumbnail and the rail. Bounded to avoid
  // retaining every intermediate handle position for the lifetime of a deck.
  const paths = new Map<string, string>();
  export function curvePath(curve: ResolvedCurve): string {
    const cached = paths.get(curve.key);
    if (cached) return cached;
    const path = Array.from({ length: 24 }, (_, i) => {
      const t = i / 23;
      return `${i ? "L" : "M"}${t.toFixed(5)},${(1 - curve.fn(t)).toFixed(5)}`;
    }).join(" ");
    if (paths.size >= 256) paths.delete(paths.keys().next().value!);
    paths.set(curve.key, path);
    return path;
  }
</script>

<script lang="ts">
  import { onDestroy, tick, untrack } from "svelte";
  import { CURVE_CATALOG, catalogMatch, parseCurve, formatCurve } from "../../../../lib/slide/curves";
  import { influenceToBezier } from "../../../../lib/motion/tokens";
  import { defaultEasingFor } from "../../../../lib/slide/presetCatalog";
  import { familyOf } from "../../../../lib/slide/family";
  import { trackDuration } from "../../../../lib/slide/timing";
  import type { Track } from "../../../../lib/slide/types";
  import { mutate } from "../../../../lib/store";
  import { sealHistory } from "../../../../lib/slide/store";
  import { editSession } from "../../../../lib/interact/editSession";
  import { yieldsToShellModal, isAnnotateChord } from "../../../agent/annotationVisibility";

  let { tracks, contextKey, onChange }: {
    tracks: Track[]; contextKey: string;
    onChange: (curve: CurveEdit, keepArrival: boolean) => void;
  } = $props();
  const groups = [...new Set(CURVE_CATALOG.map(c => c.group))];
  const tiles = CURVE_CATALOG.map(c => ({ ...c, resolved: resolveCurve(typeof c.spec === "string" ? { easing: c.spec } : { curve: c.spec }) }));
  const track = $derived(tracks.at(-1)!);
  const resolved = $derived(resolveCurve(track, familyOf(track)));
  const mixed = $derived(tracks.some(t => resolveCurve(t, familyOf(t)).key !== resolved.key));
  const spec = $derived(track.curve ?? track.easing ?? defaultEasingFor(track.preset));
  const influence = $derived(!track.curve && track.influence && (track.influence.in > 0 || track.influence.out > 0) ? track.influence : undefined);
  const name = $derived(mixed ? "Mixed" : influence ? "Custom" : CURVE_CATALOG.find(c => c.id === catalogMatch(spec))?.label ?? "Custom");
  const duration = $derived(trackDuration(track));
  const mixedDuration = $derived(tracks.some(t => trackDuration(t) !== duration));
  const points = $derived(track.curve?.kind === "bezier" ? track.curve.p : influence ? influenceToBezier(influence) : null);
  const samples = $derived(Array.from({ length: 13 }, (_, i) => resolved.fn(i / 12)));
  const peak = $derived(Math.max(0, ...Array.from({ length: 49 }, (_, i) => resolved.fn(i / 48) - 1)));
  let open = $state(false), keepArrival = $state(true), error = $state(""), pasteText = $state("");
  let group = $state<(typeof groups)[number]>("Ease");
  let trigger = $state<HTMLButtonElement>(), panel = $state<HTMLDivElement>(), graph = $state<SVGSVGElement>();
  let pos = $state({ left: 0, top: 0 });
  let previewId = $state<string | null>(null);
  const session = editSession();
  let openingKey = "", suppressFocus = false, previewFrame = 0;
  
  let drag: { index: number; rect: DOMRect; pointerId: number; node: SVGEllipseElement } | null = null;

  $effect(() => {
    const key = contextKey;
    if (open && key !== openingKey) untrack(() => close(false, false));
  });
  function place() {
    if (!trigger) return;
    const r = trigger.getBoundingClientRect(), w = 374, h = panel?.offsetHeight ?? 600;
    pos = { left: Math.max(8, Math.min(innerWidth - w - 8, r.left - w - 8)), top: Math.max(8, Math.min(innerHeight - h - 8, r.top)) };
  }
  async function show() {
    if (open || suppressFocus) return;
    sealHistory(); openingKey = contextKey; error = ""; pasteText = ""; keepArrival = true;
    group = CURVE_CATALOG.find(c => c.id === catalogMatch(spec))?.group ?? "Ease";
    place(); open = true;
    await tick();
    if (open) { place(); panel?.focus({ preventScroll: true }); }
  }
  function stopPreview() {
    if (previewFrame) cancelAnimationFrame(previewFrame);
    previewFrame = 0; previewId = null;
  }
  function endDrag() {
    if (drag?.node.hasPointerCapture(drag.pointerId)) drag.node.releasePointerCapture(drag.pointerId);
    drag = null;
  }
  function close(cancel: boolean, restoreFocus = true) {
    if (!open) return;
    stopPreview(); endDrag();
    if (cancel) session.cancel(); else session.finish();
    open = false;
    if (restoreFocus) {
      suppressFocus = true; trigger?.focus({ preventScroll: true }); suppressFocus = false;
    }
  }
  function change(value: CurveEdit) {
    error = "";
    // The outer mutation lets commitDeckLive's nested operation join our owned
    // checkpoint; cancel restores redo and dirty state as well as the curve.
    session.run(() => mutate(() => onChange(value, keepArrival)));
  }
  function paste(value: string) {
    const parsed = parseCurve(value);
    if (!parsed) { error = "Not a curve. Try spring(0.35), cubic-bezier(.2,1.4,.4,1), or a preset name."; return; }
    change(parsed); pasteText = "";
  }
  function onPaste(e: ClipboardEvent) {
    if (!open) return;
    e.preventDefault(); e.stopPropagation(); paste(e.clipboardData?.getData("text/plain") ?? "");
  }
  async function copy() {
    try { await navigator.clipboard.writeText(formatCurve(influence ? { kind: "bezier", p: influenceToBezier(influence) } : spec)); }
    catch { error = "Clipboard is unavailable. Select and copy the curve text below."; pasteText = formatCurve(influence ? { kind: "bezier", p: influenceToBezier(influence) } : spec); }
  }
  function editPoint(index: number, value: number) {
    if (!points || !Number.isFinite(value)) return;
    const p = [...points] as [number, number, number, number];
    p[index] = Math.max(index % 2 ? -1 : 0, Math.min(index % 2 ? 2 : 1, value));
    if (influence && p[1] === 0 && p[3] === 1) change({ influence: { out: p[0] * 100, in: (1 - p[2]) * 100 } });
    else change({ kind: "bezier", p });
  }
  function startDrag(e: PointerEvent, index: number) {
    if (e.button !== 0 || !graph) return;
    e.preventDefault(); e.stopPropagation();
    const node = e.currentTarget as SVGEllipseElement;
    node.focus(); node.setPointerCapture(e.pointerId);
    drag = { index, rect: graph.getBoundingClientRect(), pointerId: e.pointerId, node };
  }
  function moveDrag(e: PointerEvent) {
    if (!drag || !points) return;
    const { index, rect } = drag;
    const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const y = Math.max(-1, Math.min(2, 1.2 - (e.clientY - rect.top) / rect.height * 1.4));
    const p = [...points] as [number, number, number, number];
    p[index] = x;
    // A small vertical snap makes the legacy horizontal influence rail usable.
    p[index + 1] = influence && Math.abs(y - (index ? 1 : 0)) < .025 ? (index ? 1 : 0) : y;
    if (influence && p[1] === 0 && p[3] === 1) change({ influence: { out: p[0] * 100, in: (1 - p[2]) * 100 } });
    else change({ kind: "bezier", p });
  }
  function handleKey(e: KeyboardEvent, index: number) {
    if (!points || !e.key.startsWith("Arrow")) return;
    e.preventDefault(); e.stopPropagation();
    const axis = e.key === "ArrowLeft" || e.key === "ArrowRight" ? index : index + 1;
    editPoint(axis, points[axis] + (e.shiftKey ? .1 : .01) * (e.key === "ArrowLeft" || e.key === "ArrowDown" ? -1 : 1));
  }
  async function preview(e: PointerEvent, tile: typeof tiles[number]) {
    stopPreview(); group = tile.group;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    previewId = tile.id;
    const node = e.currentTarget as HTMLButtonElement;
    await tick();
    if (!open || previewId !== tile.id) return;
    const dot = node.querySelector("circle"), start = performance.now(), fn = tile.resolved.fn;
    const frame = (now: number) => {
      const t = Math.min(1, (now - start) / 650);
      dot?.setAttribute("cx", String(t)); dot?.setAttribute("cy", String(1 - fn(t)));
      if (t < 1) previewFrame = requestAnimationFrame(frame); else { previewFrame = 0; }
    };
    previewFrame = requestAnimationFrame(frame);
  }
  function key(e: KeyboardEvent) {
    if (!open || yieldsToShellModal(e) || isAnnotateChord(e)) return;
    e.stopPropagation();
    if (e.key === "Escape") { e.preventDefault(); close(true); }
    else if (e.key === "Enter") {
      e.preventDefault();
      if (pasteText.trim()) paste(pasteText); else close(false);
    } else if (/^[1-9]$/.test(e.key) && !(e.target instanceof HTMLInputElement) && !e.ctrlKey && !e.metaKey) {
      e.preventDefault(); const tile = tiles.filter(t => t.group === group)[Number(e.key) - 1]; if (tile) change(tile.spec);
    } else if (e.key === "Tab" && panel) {
      const nodes = [...panel.querySelectorAll<HTMLElement>('button,input,select,[tabindex="0"]')];
      const at = nodes.indexOf(document.activeElement as HTMLElement);
      if (e.shiftKey && at <= 0) { e.preventDefault(); nodes.at(-1)?.focus(); }
      else if (!e.shiftKey && at === nodes.length - 1) { e.preventDefault(); nodes[0]?.focus(); }
    }
  }
  function outside(e: PointerEvent) {
    if (open && !yieldsToShellModal(e) && !panel?.contains(e.target as Node) && !trigger?.contains(e.target as Node)) close(false, false);
  }
  onDestroy(() => { stopPreview(); endDrag(); session.finish(); });
</script>

<svelte:window onpointerdowncapture={outside} onresize={place} />
<div class="curve-field">
  <div class="field-label">Easing <kbd>e</kbd></div>
  <button class="curve-trigger" data-fld="e" bind:this={trigger} aria-label="Easing curve" aria-haspopup="dialog" aria-expanded={open}
    onfocus={() => void show()} onclick={() => void show()} onkeydown={e => {
      if (!e.ctrlKey && !e.metaKey && ["e", "Enter", " "].includes(e.key)) { e.preventDefault(); e.stopPropagation(); void show(); }
    }}>
    <svg width="28" height="16" viewBox="0 -.2 1 1.4" preserveAspectRatio="none" aria-hidden="true"><path d={curvePath(resolved)} /></svg>
    <span class="curve-name">{name}</span>
    <span class="readout">{mixed || mixedDuration ? "Timing varies" : `arrives ${Math.round(resolved.arrival * duration)} ms · settles ${Math.round(duration)} ms`}</span>
  </button>
</div>
{#if open}
  <div class="curve-popover" bind:this={panel} style={`left:${pos.left}px;top:${pos.top}px`} role="dialog" aria-label="Easing curve editor" aria-modal="false" tabindex="-1" onkeydown={key} onpaste={onPaste}>
    <header><strong>Easing</strong><span>{name}</span><button aria-label="Commit easing" onclick={() => close(false)}>Done</button></header>
    <div class="curve-groups">
      {#each groups as g}
        <div class="curve-group" data-group={g}>
          <button class="group-name" class:on={group === g} onfocus={() => group = g} onclick={() => group = g}>{g}</button>
          <div class="tiles">
            {#each tiles.filter(t => t.group === g) as tile, i}
              <button class="curve-tile" data-curve={tile.id} class:on={!mixed && resolved.key === tile.resolved.key} aria-pressed={!mixed && resolved.key === tile.resolved.key}
                title={`${i + 1} · ${formatCurve(tile.spec)}`} onfocus={() => group = g} onpointerenter={e => void preview(e, tile)} onpointerleave={stopPreview} onclick={() => change(tile.spec)}>
                <svg viewBox="0 -.2 1 1.4" preserveAspectRatio="none" aria-hidden="true"><path d={curvePath(tile.resolved)} />{#if previewId === tile.id}<circle cx="0" cy="1" r=".055" />{/if}</svg>
                <span>{tile.label}</span>
              </button>
            {/each}
          </div>
        </div>
      {/each}
    </div>
    <div class="graph-row">
      <svg class="curve-graph" data-kind={influence ? "influence" : track.curve?.kind ?? "token"} bind:this={graph} width="160" height="120" viewBox="0 -.2 1 1.4" preserveAspectRatio="none" aria-label="Timing curve" role="img">
        <path class="guides" d="M0,0 H1 M0,1 H1 M0,0 V1 M1,0 V1" />
        {#if points}
          <path class="handles" d={`M0,1 L${points[0]},${1 - points[1]} M1,0 L${points[2]},${1 - points[3]}`} />
        {/if}
        <path class="graph-path" d={curvePath(resolved)} />
        {#if points}
          {#each [0, 2] as i}
            <ellipse class="handle" data-handle={i / 2} cx={points[i]} cy={1 - points[i + 1]} rx=".025" ry=".047" role="slider" tabindex="0" aria-label={`${i ? "End" : "Start"} handle`} aria-valuemin="0" aria-valuemax="1" aria-valuenow={points[i]} aria-valuetext={`x ${points[i].toFixed(2)}, y ${points[i + 1].toFixed(2)}`} onpointerdown={e => startDrag(e, i)} onpointermove={moveDrag} onpointerup={endDrag} onpointercancel={endDrag} onkeydown={e => handleKey(e, i)} />
          {/each}
        {/if}
      </svg>
      <div class="parameters">
        {#if track.curve?.kind === "spring"}
          <label>Bounce <output>{track.curve.bounce.toFixed(2)}</output><input aria-label="Bounce" type="range" min="-0.5" max="0.8" step="0.01" value={track.curve.bounce} oninput={e => change({ kind: "spring", bounce: +e.currentTarget.value, ...(track.curve?.kind === "spring" && track.curve.velocity != null ? { velocity: track.curve.velocity } : {}) })}/></label>
          <label>Velocity <input aria-label="Spring velocity" type="number" step="0.1" value={track.curve.velocity ?? 0} oninput={e => { const n = e.currentTarget.valueAsNumber; if (Number.isFinite(n) && track.curve?.kind === "spring") change({ ...track.curve, velocity: n }); }}/></label>
        {:else if points}
          {#each ["x1", "y1", "x2", "y2"] as label, i}<label>{label}<input aria-label={label} type="number" step="0.01" min={i % 2 ? -1 : 0} max={i % 2 ? 2 : 1} value={+points[i].toFixed(3)} oninput={e => editPoint(i, e.currentTarget.valueAsNumber)} /></label>{/each}
          {#if influence}<small>Drag vertically to free a handle.</small>{/if}
        {:else if track.curve?.kind === "steps"}
          <label>Steps <input aria-label="Steps" type="number" min="1" max="60" value={track.curve.n} oninput={e => { const n = e.currentTarget.valueAsNumber; if (Number.isFinite(n) && track.curve?.kind === "steps") change({ ...track.curve, n: Math.max(1, Math.min(60, Math.round(n))) }); }}/></label>
        {:else}<small>Pick Gentle to edit handles, or a Spring to tune bounce.</small>{/if}
      </div>
    </div>
    <div class="spacing-block"><span class="eyebrow">Spacing · equal time</span>
      <svg class="spacing-chart" viewBox="0 0 352 28" role="img" aria-label="13 positions at equal time intervals">
        <path class="guides" d="M32,14 H330" /><path class="target-tick" d="M272,5 V23" />
        {#each samples as x}<circle cx={32 + x * 240} cy="14" r="2.5" />{/each}
      </svg>
    </div>
    <div class="readout timing-readout">{mixed || mixedDuration ? "Timing varies per effect" : `arrives ${Math.round(resolved.arrival * duration)} ms · settles ${Math.round(duration)} ms`}{#if peak > .00001}<span class="overshoot-readout">overshoot {(peak * 100).toFixed(1)}%</span>{/if}</div>
    <label class="keep"><input type="checkbox" bind:checked={keepArrival} />Keep arrival <small>Adjust duration to preserve arrival time</small></label>
    <div class="clipboard"><input aria-label="Paste curve" placeholder="Paste a curve…" bind:value={pasteText} /><button onclick={() => paste(pasteText)}>Paste</button><button onclick={() => void copy()}>Copy</button></div>
    {#if error}<div class="curve-error" role="alert">{error}</div>{/if}
    <footer>1–9 choose in {group} · Enter commits · Esc reverts</footer>
  </div>
{/if}

<style>
  .curve-field { border-top: 1px solid var(--c-line); padding-top: 6px; }
  .field-label { display: flex; gap: 6px; color: var(--c-tx-muted); font: 12px var(--font-ui); margin-bottom: 4px; }
  kbd, .readout, output, input, .eyebrow, footer { font: 10px/1.5 var(--font-mono); font-variant-numeric: tabular-nums; }
  button { font: 11px var(--font-ui); color: var(--c-tx); border: 1px solid var(--c-line-strong); border-radius: var(--r-ui); background: transparent; cursor: var(--cursor-cross-hover); }
  button:hover { background: var(--c-accent-tint); }
  button:focus-visible, input:focus-visible { outline: 1px solid var(--c-accent); outline-offset: 1px; }
  .curve-trigger { display: flex; flex-wrap: wrap; align-items: center; gap: 5px; width: 100%; padding: 4px 6px; text-align: left; }
  .curve-trigger .readout { width: 100%; color: var(--c-tx-muted); white-space: nowrap; }
  svg { display: block; overflow: visible; }
  path { fill: none; stroke: currentColor; stroke-width: 1.2px; vector-effect: non-scaling-stroke; }
  .curve-popover { position: fixed; z-index: 90; width: 374px; box-sizing: border-box; max-height: calc(100vh - 16px); overflow-y: auto; padding: 10px; background: var(--c-surface); border: 1px solid var(--c-line-strong); border-radius: var(--r-ui); box-shadow: var(--elev-2); color: var(--c-tx); font: 12px/1.35 var(--font-ui); outline: none; }
  header { display: flex; align-items: center; gap: 8px; padding-bottom: 7px; border-bottom: 1px solid var(--c-line); }
  header span { color: var(--c-tx-muted); } header button { margin-left: auto; padding: 3px 8px; }
  .curve-group { margin-top: 5px; }
  .group-name { border: 0; padding: 3px 0; color: var(--c-tx-muted); }
  .group-name.on { color: var(--c-accent); }
  .tiles { display: grid; grid-template-columns: repeat(6, 1fr); gap: 3px; }
  .curve-tile { min-height: 46px; padding: 3px; display: flex; flex-direction: column; align-items: center; gap: 3px; min-width: 0; font-size: 9px; }
  .curve-tile svg { width: 28px; height: 16px; }
  .curve-tile.on { background: var(--c-accent-tint); box-shadow: inset 2px 0 var(--c-accent); border-color: var(--c-accent); }
  .curve-tile circle, .spacing-chart circle { fill: var(--c-accent); }
  .graph-row { display: flex; gap: 16px; margin-top: 10px; border-top: 1px solid var(--c-line); padding: 12px 6px 4px; }
  .curve-graph { flex: 0 0 160px; touch-action: none; }
  .guides, .handles { stroke: var(--c-line-strong); stroke-width: 1px; }
  .graph-path { stroke: var(--c-accent); }
  .handle { fill: var(--c-surface); stroke: var(--c-accent); stroke-width: 1.5px; vector-effect: non-scaling-stroke; cursor: grab; }
  .handle:focus { fill: var(--c-accent); outline: none; }
  .parameters { flex: 1; display: flex; flex-direction: column; gap: 4px; }
  .parameters label { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 3px; font-size: 11px; }
  input { min-width: 0; border: 1px solid var(--c-line-strong); border-radius: var(--r-ui); background: var(--c-bg); color: var(--c-tx); padding: 2px 4px; height: 22px; box-sizing: border-box; }
  .parameters input[type="number"] { width: 67px; } .parameters input[type="range"] { width: 100%; padding: 0; accent-color: var(--c-accent); }
  small, footer { color: var(--c-tx-muted); font-size: 10px; }
  .spacing-block { border-top: 1px solid var(--c-line); margin-top: 7px; padding-top: 6px; }
  .eyebrow { color: var(--c-tx-muted); } .spacing-chart { width: 100%; height: 28px; }
  .target-tick { stroke: var(--c-tx-muted); opacity: .45; }
  .timing-readout { padding: 4px 0; } .overshoot-readout { display: block; color: var(--c-accent); }
  .keep { display: flex; align-items: center; gap: 5px; margin: 5px 0; font-size: 11px; }
  .keep input { width: 13px; height: 13px; accent-color: var(--c-accent); } .keep small { margin-left: auto; }
  .clipboard { display: flex; gap: 4px; } .clipboard input { flex: 1; } .clipboard button { padding: 2px 6px; }
  .curve-error { color: var(--c-danger); font-size: 11px; margin-top: 5px; } footer { margin-top: 7px; }
</style>
