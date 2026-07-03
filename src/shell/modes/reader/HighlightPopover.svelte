<script lang="ts">
  // Click-a-highlight popover: comment, recolor, copy, ask Claude, delete. Anchored
  // at fixed viewport coords computed by ReaderMode (clamped; `place` flips it above/
  // below the highlight). A dirty note is saved on ANY close path (outside click,
  // explicit ✕, Save) so a half-typed comment never silently vanishes.
  import { ANNOTATION_COLORS, type Annotation } from "../../../lib/references/annotations";
  import { hlSwatch } from "../../../lib/references/annotationColors";

  let {
    annotation,
    x,
    y,
    place = "below",
    onSaveNote,
    onRecolor,
    onCopy,
    onAsk,
    onDelete,
    onClose,
  }: {
    annotation: Annotation;
    x: number;
    y: number;
    place?: "above" | "below";
    onSaveNote?: (note: string) => void;
    onRecolor?: (color: string) => void;
    onCopy?: () => void;
    onAsk?: () => void;
    onDelete?: () => void;
    onClose?: () => void;
  } = $props();

  let note = $state("");
  let copied = $state(false);
  let copiedTimer: ReturnType<typeof setTimeout> | undefined;

  // Re-seed the draft when the popover is pointed at a DIFFERENT annotation (the
  // component instance is reused across highlight clicks) — but not when the same
  // annotation's note updates underneath a save (the draft is already current).
  let seededFor: string | null = null;
  $effect(() => {
    if (seededFor !== annotation.id) {
      seededFor = annotation.id;
      note = annotation.note ?? "";
    }
  });

  const dirty = $derived(note !== (annotation.note ?? ""));

  function save() {
    note = note.trim();
    if (note !== (annotation.note ?? "")) onSaveNote?.(note);
  }
  function requestClose() {
    save();
    onClose?.();
  }
  function copy() {
    onCopy?.();
    copied = true;
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => (copied = false), 1200);
  }
  function noteKey(e: KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      save();
    }
  }

  $effect(() => () => clearTimeout(copiedTimer));
</script>

<svelte:window onmousedown={requestClose} />

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="hl-pop"
  class:above={place === "above"}
  data-testid="hl-popover"
  style:left="{x}px"
  style:top="{y}px"
  onmousedown={(e) => e.stopPropagation()}>
  <div class="prow">
    <div class="colors">
      {#each ANNOTATION_COLORS as c}
        <button
          class="pdot"
          class:active={annotation.color === c}
          style:background={hlSwatch(c)}
          title="Recolor ({c})"
          aria-label={`Recolor ${c}`}
          onclick={() => onRecolor?.(c)}></button>
      {/each}
    </div>
    <span class="ppage">p{annotation.page}</span>
    <button class="pico" title="Close" aria-label="Close" onclick={requestClose}>✕</button>
  </div>

  <div class="pquote" title={annotation.anchor.quote}>{annotation.anchor.quote}</div>

  <textarea
    class="pnote"
    bind:value={note}
    rows="3"
    placeholder="Add a comment… (⌘/Ctrl-Enter to save)"
    aria-label="Highlight comment"
    onkeydown={noteKey}></textarea>

  <div class="pactions">
    <button class="pbtn" onclick={copy}>{copied ? "Copied ✓" : "Copy text"}</button>
    <button class="pbtn" title="Ask Claude about this highlight" onclick={() => onAsk?.()}>✦ Ask Claude</button>
    <span class="spacer"></span>
    {#if dirty}
      <button class="pbtn save" onclick={save}>Save</button>
    {/if}
    <button class="pbtn danger" title="Delete highlight" onclick={() => onDelete?.()}>Delete</button>
  </div>
</div>

<style>
  .hl-pop {
    position: fixed;
    transform: translate(-50%, 0);
    width: 300px;
    z-index: 60;
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px 10px;
    background: var(--c-surface);
    border: 1px solid var(--c-line-strong);
    border-radius: var(--r-2, 8px);
    box-shadow: var(--elev-2, 0 4px 16px rgba(0, 0, 0, 0.35));
  }
  .hl-pop.above {
    transform: translate(-50%, -100%);
  }
  .prow {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .colors {
    display: flex;
    gap: 5px;
    flex: 1 1 auto;
  }
  .pdot {
    width: 15px;
    height: 15px;
    border-radius: 50%;
    border: 1px solid var(--c-line);
    cursor: pointer;
    padding: 0;
  }
  .pdot:hover {
    transform: scale(1.15);
  }
  .pdot.active {
    outline: 2px solid var(--c-accent);
    outline-offset: 1px;
  }
  .ppage {
    font-size: var(--ts-xs);
    color: var(--c-tx-faint);
    font-variant-numeric: tabular-nums;
  }
  .pico {
    border: none;
    background: none;
    color: var(--c-tx-faint);
    cursor: pointer;
    font-size: var(--ts-sm);
    padding: 0 2px;
    line-height: 1;
  }
  .pico:hover {
    color: var(--c-tx-1);
  }
  .pquote {
    font-family: var(--font-serif);
    font-style: italic;
    font-size: var(--ts-xs);
    color: var(--c-tx-2);
    line-height: 1.35;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .pnote {
    width: 100%;
    resize: vertical;
    min-height: 3.2em;
    background: var(--c-bg);
    color: var(--c-tx);
    border: 1px solid var(--c-line-strong);
    border-radius: var(--r-1);
    padding: 5px 7px;
    font: inherit;
    font-size: var(--ts-xs);
    line-height: 1.4;
  }
  .pnote:focus {
    outline: none;
    border-color: var(--c-accent);
  }
  .pactions {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .spacer {
    flex: 1 1 auto;
  }
  .pbtn {
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
  .pbtn:hover {
    border-color: var(--c-accent);
    color: var(--c-accent);
  }
  .pbtn.save {
    border-color: var(--c-accent);
    background: var(--c-accent-tint);
    color: var(--c-accent);
  }
  .pbtn.danger:hover {
    border-color: var(--c-danger);
    color: var(--c-danger);
  }
</style>
