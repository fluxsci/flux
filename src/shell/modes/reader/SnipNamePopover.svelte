<script lang="ts">
  // Paper-snip naming popover: appears the instant a ctrl+alt+drag marquee ends,
  // pre-filled with the deduped auto-name (select-all, so typing replaces it
  // wholesale). Enter saves, Esc / outside-click cancels — a snip is cheap to
  // re-drag, so unlike HighlightPopover nothing is flushed on close. The 4×
  // capture render happens on Enter, not at open: the popover itself must be
  // instantaneous (§6); the thumbnail preview arrives async and never blocks.
  import { onMount } from "svelte";

  let {
    name = "",
    dir,
    citation,
    page,
    preview = null,
    saving = false,
    error = "",
    onSave,
    onCancel,
    x,
    y,
  }: {
    /** The deduped auto-name the input opens with. */
    name?: string;
    /** Project-relative save dir, shown in the caption (plots/paper_snips). */
    dir: string;
    /** Pre-formatted citation line, e.g. "Driessen et al., 2026, Nat. Neurosci." */
    citation: string;
    page: number;
    /** Async low-res region thumbnail (data URL); null while rendering. */
    preview?: string | null;
    saving?: boolean;
    /** Save-failure message — the popover stays open so the user can retry. */
    error?: string;
    onSave: (name: string) => void;
    onCancel: () => void;
    /** Marquee-end anchor (client coords); clamped to the viewport. */
    x: number;
    y: number;
  } = $props();

  // The popover mounts only after the deduped auto-name is computed (ReaderMode
  // sets snipReq with it), so seeding at init is safe — and it must happen before
  // onMount's select(), or the select-all lands on an empty input. The initial-
  // value capture is deliberate: the field is a user draft from the first frame.
  // svelte-ignore state_referenced_locally
  let value = $state(name);
  let inputEl = $state<HTMLInputElement | undefined>();

  // Clamp the fixed-position card into the viewport (the marquee can end anywhere,
  // including flush against the right/bottom edge).
  const W = 280;
  const pad = 8;
  const left = $derived(Math.max(pad, Math.min(x, (typeof window !== "undefined" ? window.innerWidth : 1200) - W - pad)));
  const flipUp = $derived(typeof window !== "undefined" && y > window.innerHeight - 220);

  function onKey(e: KeyboardEvent) {
    e.stopPropagation(); // reader shortcuts (find, nav) must not fire while naming
    if (e.key === "Enter") {
      e.preventDefault();
      if (!saving) onSave(value);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    }
  }

  onMount(() => {
    inputEl?.focus();
    inputEl?.select();
  });
</script>

<svelte:window onmousedown={onCancel} />

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="snip-pop"
  class:above={flipUp}
  data-testid="snip-popover"
  role="dialog"
  aria-label="Save paper snip"
  tabindex="-1"
  style:left="{left}px"
  style:top="{y}px"
  onmousedown={(e) => e.stopPropagation()}>
  <div class="srow">
    <span class="stitle">Save snip · p{page}</span>
    <button class="sico" title="Cancel" aria-label="Cancel" onclick={onCancel}>✕</button>
  </div>
  {#if preview}
    <img class="sprev" src={preview} alt="Snip preview" />
  {/if}
  <input
    class="sname"
    bind:this={inputEl}
    bind:value
    data-testid="snip-name"
    spellcheck="false"
    aria-label="Snip name"
    onkeydown={onKey} />
  <div class="spath">→ {dir}/{value || "…"}.png</div>
  <div class="scite" title={citation}>{citation}</div>
  {#if error}
    <div class="serr">{error}</div>
  {/if}
  <div class="sactions">
    <button class="sbtn save" data-testid="snip-save" disabled={saving} onclick={() => onSave(value)}>
      {saving ? "Saving…" : "Save (Enter)"}
    </button>
    <button class="sbtn" onclick={onCancel}>Cancel</button>
  </div>
</div>

<style>
  .snip-pop {
    position: fixed;
    width: 280px;
    z-index: 80; /* above the R5 figure panels (they climb from 70) */
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px 10px;
    background: var(--c-surface);
    border: 1px solid var(--c-line-strong);
    border-radius: var(--r-2, 8px);
    box-shadow: var(--elev-2, 0 4px 16px rgba(0, 0, 0, 0.35));
  }
  .snip-pop.above {
    transform: translate(0, -100%);
  }
  .srow {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .stitle {
    flex: 1 1 auto;
    font-size: var(--ts-xs);
    color: var(--c-tx-2);
    font-weight: 600;
  }
  .sico {
    border: none;
    background: none;
    color: var(--c-tx-faint);
    cursor: pointer;
    font-size: var(--ts-sm);
    padding: 0 2px;
    line-height: 1;
  }
  .sico:hover {
    color: var(--c-tx-1);
  }
  .sprev {
    max-width: 100%;
    max-height: 120px;
    object-fit: contain;
    border: 1px solid var(--c-line);
    border-radius: var(--r-1);
    background: #fff;
    align-self: center;
  }
  .sname {
    width: 100%;
    background: var(--c-bg);
    color: var(--c-tx);
    border: 1px solid var(--c-line-strong);
    border-radius: var(--r-1);
    padding: 5px 7px;
    font: inherit;
    font-size: var(--ts-xs);
  }
  .sname:focus {
    outline: none;
    border-color: var(--c-accent);
  }
  .spath {
    font-size: var(--ts-xs);
    color: var(--c-tx-faint);
    font-variant-numeric: tabular-nums;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .scite {
    font-family: var(--font-serif);
    font-style: italic;
    font-size: var(--ts-xs);
    color: var(--c-tx-2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .serr {
    font-size: var(--ts-xs);
    color: var(--c-danger);
  }
  .sactions {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .sbtn {
    border: 1px solid var(--c-line-strong);
    background: transparent;
    color: var(--c-tx-2);
    border-radius: var(--r-1);
    padding: 3px 8px;
    font: inherit;
    font-size: var(--ts-xs);
    cursor: pointer;
    white-space: nowrap;
  }
  .sbtn:hover {
    border-color: var(--c-accent);
    color: var(--c-accent);
  }
  .sbtn.save {
    border-color: var(--c-accent);
    background: var(--c-accent-tint);
    color: var(--c-accent);
  }
  .sbtn:disabled {
    opacity: 0.6;
    cursor: default;
  }
</style>
