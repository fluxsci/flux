<script lang="ts">
  // The Become picker's bar (the edit state bar while a pick is armed): what
  // is waiting, what the pointer is over — named exactly as its lane will name
  // it — the picks as removable chips, Pair, Add, and the confirm/cancel pair.
  // Flexoki-green inset rail on a quiet tint (surface contract: never a solid fill).
  import { get } from "svelte/store";
  import { activeTool, importerOpen, embeddedProjectRoot, projectDir } from "../../../../lib/store";
  import { presetPicker } from "../../../../lib/presets";
  import { PAIR_POLICIES } from "../../../../lib/slide/targets";
  import type { PairPolicy } from "../../../../lib/slide/types";
  import TimelineMenu, { type MenuItem } from "../animator/TimelineMenu.svelte";
  import { chipRuns, type PickUnit, type UnitDescription } from "./pickModel";
  import type { BecomePicker } from "./pickState.svelte";

  let { picker, sourceLabel, stepLabel = "", describe, sourceHasContent = false, modelFeedback = null, onGallery }: {
    picker: BecomePicker;
    sourceLabel: string;
    /** "step 1" — the pick always lands After this step. */
    stepLabel?: string;
    describe: (u: PickUnit) => UnitDescription;
    sourceHasContent?: boolean;
    modelFeedback?: { label: string; reason?: string | null } | null;
    onGallery?: () => void;
  } = $props();

  const target = $derived(picker.target);
  const like = $derived(picker.like);
  const hover = $derived(picker.hover);
  const units = $derived(target?.units ?? []);
  const chips = $derived(chipRuns(units, describe));
  const verb = $derived(target?.kind === "appearFrom" ? "appears from…" : "becomes…");

  let addMenu = $state<{ x: number; y: number } | null>(null);
  const tool = (id: string) => () => { activeTool.set(id as never); };
  const addItems = $derived<MenuItem[]>([
    { label: "Rect", hint: "R", action: tool("rect") },
    { label: "Ellipse", hint: "O", action: tool("ellipse") },
    { label: "Line", hint: "L", action: tool("line") },
    { label: "Arrow", action: tool("arrow") },
    { label: "Pen", hint: "P", action: tool("pen") },
    { label: "Text", hint: "T", action: tool("text") },
    { label: "", divider: true },
    { label: "Preset…", hint: "Ctrl+P · from your preset library", action: () => presetPicker.set({ mode: "insert" }) },
    { label: "Plot…", hint: "Alt+G · from the plot gallery", disabled: !(get(embeddedProjectRoot) || get(projectDir)), action: () => importerOpen.set(true) },
  ]);
  function openAdd(e: MouseEvent) {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    addMenu = addMenu ? null : { x: r.left, y: r.bottom + 4 };
  }
</script>

{#if like}
  <span class="become-bar like" role="status" aria-label="Animate like pick" data-pick-bar="like">
    <span class="become-msg"><strong>Animate like…</strong> pick the object whose effect {like.trackIds.length === 1 ? "this effect copies" : `these ${like.trackIds.length} effects copy`}</span>
    <span class="pb-hover" data-pick-readout>{#if hover}<b>{hover.label}</b>{#if hover.detail}<i>{hover.detail}</i>{/if}{:else}<i>hover an object</i>{/if}</span>
    <button class="become-btn" onclick={() => picker.cancel()} title="Escape">Cancel <kbd>Esc</kbd></button>
  </span>
{:else if target}
  <span class="become-bar" class:adding={picker.adding} role="status" aria-label="Become pick" data-pick-bar={picker.adding ? "add" : "pick"}>
    <span class="become-msg" title={`${sourceLabel} ${verb}${stepLabel ? ` at ${stepLabel}` : ""}`}><strong>{sourceLabel}</strong> {verb}{#if stepLabel}<small>{stepLabel}</small>{/if}</span>
    {#if picker.adding}
      <span class="pb-hover adding" data-pick-readout><b>Adding</b><i>draw or insert objects; each one joins the pick</i></span>
    {:else}
      <span class="pb-hover" data-pick-readout title={hover ? [hover.label, hover.readout, hover.detail].filter(Boolean).join(" · ") : ""}>
        {#if hover}<b>{hover.label}</b>{#if hover.context}<span class="ctx">{hover.context}</span>{/if}{#if hover.readout}<span class="ro">{hover.readout}</span>{/if}{#if hover.detail}<i>{hover.detail}</i>{/if}
        {:else if units.length}<i>click toggles · drag a box · <kbd>a</kbd> siblings · Alt+click whole object</i>
        {:else}<i>click parts or objects · drag a box around them · Alt+R X-ray</i>{/if}
      </span>
    {/if}
    {#if modelFeedback}<span class="morph-badge" data-model-morph-badge title={modelFeedback.reason ?? "Same mesh structure — the shape morphs smoothly."}>{modelFeedback.label}</span>{/if}
    {#if units.length}
      <span class="pb-chips" data-pick-chips>
        {#each chips.chips as c (c.key)}
          <span class="pb-chip" data-pick-chip={c.label}>{c.label}<button aria-label={`Remove ${c.label}`} title="Remove from the pick" onclick={() => picker.remove(c.units)}>×</button></span>
        {/each}
        {#if chips.more}<span class="pb-more">+{chips.more}</span>{/if}
      </span>
      <span class="pick-count" data-pick-count={units.length}>{units.length} picked</span>
    {/if}
    <label class="pair-label">Pair <select aria-label="Become pairing" value={target.pair} onchange={(e) => picker.setPair(e.currentTarget.value as PairPolicy)}>
      {#each PAIR_POLICIES as p (p.id)}<option value={p.id}>{p.label}</option>{/each}
    </select></label>
    {#if sourceHasContent && !picker.adding}<button class="become-btn" onclick={() => onGallery?.()} title="Keep the frame; choose the next content from the gallery">From gallery…</button>{/if}
    {#if picker.adding}
      <button class="become-btn pb-go" onclick={() => picker.exitAdd()} title="Back to picking, with everything you added picked (Enter)">Done <kbd>Enter</kbd></button>
    {:else}
      <span class="pb-add"><button class="become-btn" aria-haspopup="menu" aria-expanded={!!addMenu} onclick={openAdd} title="Draw or insert something for it to become; it joins the pick">Add ▾</button>
        {#if addMenu}<TimelineMenu x={addMenu.x} y={addMenu.y} items={addItems} onClose={() => (addMenu = null)} />{/if}</span>
      <button class="become-btn pb-go" disabled={!units.length} onclick={() => picker.confirm()} title="Confirm the pick (b or Enter)">{target.kind === "appearFrom" ? "Appear from" : "Become"} <kbd>b</kbd></button>
    {/if}
    <button class="become-btn" onclick={() => picker.cancel()} title="Leave without a transform (Escape)">Cancel <kbd>Esc</kbd></button>
  </span>
{/if}

<style>
  .become-bar {
    display: flex; align-items: center; gap: 8px; min-width: 0; flex: 1; height: 24px; padding: 0 6px 0 9px;
    border: 1px solid color-mix(in oklab, var(--c-pick) 45%, transparent); border-radius: var(--r-ui);
    background: color-mix(in oklab, var(--c-pick) 9%, transparent); box-shadow: inset 2px 0 0 var(--c-pick);
    color: var(--c-tx); font: 12px var(--font-ui); animation: pb-in 160ms ease-out;
  }
  @keyframes pb-in { from { opacity: 0; } to { opacity: 1; } }
  @media (prefers-reduced-motion: reduce) { .become-bar { animation: none; } }
  .become-bar.adding { background: color-mix(in oklab, var(--c-pick) 5%, transparent); border-style: dashed; }
  .become-msg { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--c-tx-2); }
  .become-msg strong { color: var(--c-pick-text); font: 600 10.5px var(--font-mono); letter-spacing: .06em; text-transform: uppercase; }
  .pb-hover { flex: 1 1 120px; min-width: 60px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: flex; align-items: baseline; gap: 6px; padding-left: 8px; border-left: 1px solid var(--c-line); }
  .pb-hover b { font: 500 11px var(--font-mono); color: var(--c-tx-hi); white-space: nowrap; }
  .become-msg small { font: 10px var(--font-mono); color: var(--c-tx-muted); margin-left: 6px; }
  .pb-hover .ctx { font: 10.5px var(--font-mono); color: var(--c-pick-text); white-space: nowrap; }
  .pb-hover .ro { font: 10.5px var(--font-mono); color: var(--c-tx-2); white-space: nowrap; }
  .pb-hover i { font-style: normal; color: var(--c-tx-muted); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .pb-hover.adding b { color: var(--c-pick-text); font: 600 10.5px var(--font-mono); letter-spacing: .06em; text-transform: uppercase; }
  kbd { font: 9.5px var(--font-mono); color: var(--c-tx-muted); border: 1px solid var(--c-line-strong); border-radius: 2px; padding: 0 3px; margin-left: 2px; }
  .pb-chips { display: flex; gap: 4px; min-width: 0; overflow: hidden; flex: 0 1 auto; }
  .pb-chip { display: inline-flex; align-items: center; gap: 2px; height: 18px; padding: 0 2px 0 6px; white-space: nowrap; font: 10.5px var(--font-mono); color: var(--c-tx);
    border: 1px solid color-mix(in oklab, var(--c-pick) 55%, transparent); border-radius: var(--r-ui); background: color-mix(in oklab, var(--c-pick) 14%, transparent); }
  .pb-chip button { width: 14px; height: 14px; padding: 0; border: 0; background: transparent; color: var(--c-tx-muted); font: 12px/1 var(--font-ui); cursor: var(--cursor-cross-hover); }
  .pb-chip button:hover { color: var(--c-tx-hi); }
  .pb-more { font: 10px var(--font-mono); color: var(--c-tx-muted); align-self: center; }
  .pick-count { font: 10px var(--font-mono); white-space: nowrap; color: var(--c-tx-2); }
  .pair-label { display: flex; align-items: center; gap: 4px; white-space: nowrap; color: var(--c-tx-2); font-size: 11px; }
  .pair-label select { font: 11px var(--font-mono); height: 20px; border: 1px solid var(--c-line-strong); border-radius: var(--r-ui); background: var(--c-bg-raised); color: var(--c-tx); }
  .morph-badge { font: 11px var(--font-ui); white-space: nowrap; padding: 0 6px; line-height: 16px; border: 1px solid var(--c-line-strong); border-radius: 9px; color: var(--c-tx); }
  .become-btn { font: 11px var(--font-ui); color: var(--c-tx); background: transparent; border: 1px solid var(--c-line-strong); border-radius: var(--r-ui); height: 20px; padding: 0 7px; white-space: nowrap; cursor: var(--cursor-cross-hover); transition: border-color 80ms, color 80ms; }
  .become-btn:hover:not(:disabled) { border-color: var(--c-pick); color: var(--c-tx-hi); }
  .become-btn:disabled { opacity: .4; cursor: var(--cursor-cross); }
  .pb-go { border-color: color-mix(in oklab, var(--c-pick) 70%, transparent); background: color-mix(in oklab, var(--c-pick) 16%, transparent); color: var(--c-tx-hi); }
  .pb-go kbd { color: var(--c-tx-2); }
  .pb-add { display: contents; }
</style>
