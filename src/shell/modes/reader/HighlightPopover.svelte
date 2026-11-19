<script lang="ts">
  // Click-a-highlight popover: comment, recolor, copy, annotate, delete. Anchored
  // at fixed viewport coords computed by ReaderMode (clamped; `place` flips it above/
  // below the highlight). A dirty note is saved on ANY close path (outside click,
  // explicit ✕, Save, Esc/teardown — the onDestroy flush) so a half-typed comment
  // never silently vanishes.
  import { annotationDraft, type AnnotationDraft } from "./annotationDrafts";
  import { onMount, onDestroy } from "svelte";
  import { pushToast } from "../../../lib/toast";
  import { ANNOTATION_COLORS, type Annotation } from "../../../lib/references/annotations";
  import { hlSwatch } from "../../../lib/references/annotationColors";
  import FluxAiMark from "../../agent/FluxAiMark.svelte";

  let {
    annotation,
    draftKey,
    paneId = "",
    x,
    y,
    place = "below",
    onSaveNote,
    onRecolor,
    onCopy,
    onAnnotate,
    onAsk,
    onDelete,
    onClose,
  }: {
    annotation: Annotation;
    draftKey: string;
    paneId?: string;
    x: number;
    y: number;
    place?: "above" | "below";
    onSaveNote?: (note: string) => Promise<void>;
    onRecolor?: (color: string) => void;
    /** Returns the clipboard promise — "Copied ✓" shows only when it resolves. */
    onCopy?: () => void | Promise<void>;
    onAsk?: () => void;
    onAnnotate?: () => void;
    onDelete?: () => void;
    onClose?: () => void;
  } = $props();

  let note = $state("");
  let noteEl = $state<HTMLTextAreaElement | undefined>();
  let copied = $state(false);
  let copiedTimer: ReturnType<typeof setTimeout> | undefined;

  // Re-seed the draft when the popover is pointed at a DIFFERENT annotation (the
  // component instance is reused across highlight clicks) — but not when the same
  // annotation's note updates underneath a save (the draft is already current).
  // `lastSaved` is the persisted baseline: it makes the destroy-time flush below
  // idempotent with save() (no double-save when ✕/outside-click already saved).
  let seededFor: string | null = null;
  let lastSaved = $state("");
  let saving = $state(false);
  let saveError = $state("");
  let draft: AnnotationDraft | null = null;
  $effect(() => {
    if (seededFor !== annotation.id) {
      draft?.dispose();
      seededFor = annotation.id;
      const persist = onSaveNote;
      draft = annotationDraft(draftKey, paneId, annotation.note ?? "", async text => { await persist?.(text); });
      note = draft.text;
      lastSaved = draft.saved;
      saveError = draft.error;
    }
  });
  $effect(() => { if (draft) draft.text = note; });
  const dirty = $derived(note !== lastSaved);
  async function save(): Promise<boolean> {
    if (!draft || saving) return false;
    draft.text = note;
    saving = true;
    try { await draft.flush(); lastSaved = draft.saved; saveError = ""; return true; }
    catch (error) { saveError = String(error instanceof Error ? error.message : error); return false; }
    finally { saving = false; }
  }
  async function requestClose() {
    if (await save()) onClose?.();
  }
  function copy() {
    void Promise.resolve(onCopy?.()).then(
      () => {
        copied = true;
        clearTimeout(copiedTimer);
        copiedTimer = setTimeout(() => (copied = false), 1200);
      },
      () => pushToast("error", "Copy failed"),
    );
  }
  function del() {
    skipDestroySave = true; // the highlight is going away — don't flush a note onto it
    onDelete?.();
  }
  /** How Save is spelled on this machine. */
  const saveChord = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘ Enter" : "Ctrl Enter";
  function noteKey(e: KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      save();
    }
  }

  onMount(() => noteEl?.focus());

  // The contract above holds by construction: close paths that bypass requestClose
  // (Esc in ReaderMode just sets popover = null) land here and flush a dirty draft.
  let skipDestroySave = false;
  onDestroy(() => {
    if (!draft) return;
    if (skipDestroySave) { draft.text = draft.saved; draft.dispose(); return; }
    draft.text = note;
    // Registry retains failed drafts; teardown alone never reports success.
    void draft.flush().then(() => draft?.dispose()).catch(() => {});
  });

  $effect(() => () => clearTimeout(copiedTimer));
</script>

<svelte:window onmousedown={requestClose} />

<!-- The same strip as the selection's menu (five swatches, Annotate, Ask), then the passage
     and your note. -->
<!-- svelte-ignore a11y_no_static_element_interactions, a11y_no_noninteractive_element_interactions -->
<div
  class="hl-pop"
  class:above={place === "above"}
  data-testid="hl-popover"
  role="dialog"
  aria-label="Edit highlight"
  tabindex="-1"
  style:left="{x}px"
  style:top="{y}px"
  style:--ink={hlSwatch(annotation.color)}
  onmousedown={(e) => e.stopPropagation()}>
  <div class="prow">
    <div class="colors" role="group" aria-label="Highlight colour">
      {#each ANNOTATION_COLORS as c}
        <button
          class="pdot"
          class:active={annotation.color === c}
          style:--ink={hlSwatch(c)}
          title="Recolor ({c})"
          aria-label={`Recolor ${c}`}
          aria-pressed={annotation.color === c}
          onclick={() => onRecolor?.(c)}></button>
      {/each}
    </div>
    {#if onAnnotate || onAsk}<span class="psep" aria-hidden="true"></span>{/if}
    {#if onAnnotate}<button class="pact annotate" title="Annotate this passage: a note for your agents" aria-label="Annotate this passage" onclick={onAnnotate}><FluxAiMark still size={14} tone="live" />Annotate</button>{/if}
    {#if onAsk}<button class="pact" title="Ask about this passage" aria-label="Ask about this passage" onclick={onAsk}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" /></svg>Ask</button>{/if}
    <span class="spacer"></span>
    <span class="ppage">p.{annotation.page}</span>
    <button class="pico" title="Close (Esc)" aria-label="Close" onclick={requestClose}><svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 2.5l7 7M9.5 2.5l-7 7" /></svg></button>
  </div>

  <div class="pquote" title={annotation.anchor.quote}>{annotation.anchor.quote}</div>

  <textarea
    class="pnote"
    bind:this={noteEl}
    bind:value={note}
    rows="3"
    placeholder="Add a note"
    aria-label="Highlight comment"
    onkeydown={noteKey}></textarea>

  {#if saveError}<div role="alert" class="perr">Save failed: {saveError}. Your draft is retained; retry Save.</div>{/if}
  <div class="pactions">
    <button class="pbtn" onclick={copy}>{copied ? "Copied" : "Copy text"}</button>
    <button class="pbtn danger" title="Delete highlight" onclick={del}>Delete</button>
    <span class="spacer"></span>
    {#if dirty}
      <span class="phint"><kbd>{saveChord}</kbd></span>
      <button class="pbtn save" disabled={saving} onclick={save}>{saving ? "Saving…" : "Save"}</button>
    {:else if lastSaved}
      <span class="phint saved">Saved</span>
    {/if}
  </div>
</div>

<style>
  /* The popover is the selection menu grown a note: same panel, same square swatches, same
     Annotate and Ask; the passage in the paper's voice on a rail of its own colour. */
  .hl-pop {
    position: fixed;
    translate: -50% 0;
    width: 340px;
    box-sizing: border-box;
    z-index: 60;
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 8px 10px 10px;
    background: var(--c-surface);
    border: 1px solid var(--c-line-strong);
    border-radius: var(--r-panel);
    box-shadow: var(--elev-3);
    color: var(--c-tx);
    font: 12.5px var(--font-serif);
    animation: hl-pop-in 90ms ease-out;
  }
  .hl-pop.above {
    translate: -50% -100%;
  }
  @keyframes hl-pop-in {
    from {
      opacity: 0;
      transform: translateY(3px);
    }
  }
  .hl-pop.above {
    animation-name: hl-pop-in-above;
  }
  @keyframes hl-pop-in-above {
    from {
      opacity: 0;
      transform: translateY(-3px);
    }
  }
  .hl-pop svg {
    display: block;
    flex-shrink: 0;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.3;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .prow {
    display: flex;
    align-items: center;
    gap: 6px;
    height: 24px;
  }
  .colors {
    display: flex;
    gap: 5px;
    flex: 0 0 auto;
  }
  /* Swatches as in the selection menu: squares of the highlight's ink, the chosen one ringed. */
  .pdot {
    width: 18px;
    height: 18px;
    padding: 0;
    border: 1px solid color-mix(in oklab, var(--ink) 70%, #000);
    border-radius: var(--r-ui);
    background: var(--ink);
    cursor: var(--cursor-cross-hover);
    transition: transform 80ms ease-out, box-shadow 80ms linear;
  }
  .pdot:hover,
  .pdot:focus-visible {
    outline: none;
    transform: translateY(-1px);
    box-shadow: 0 0 0 1px var(--c-surface), 0 0 0 2px var(--ink);
  }
  .pdot.active {
    box-shadow: 0 0 0 1px var(--c-surface), 0 0 0 2px var(--c-tx-hi);
  }
  .pdot:active {
    transform: none;
  }
  .psep {
    flex: 0 0 1px;
    height: 16px;
    margin: 0 2px;
    background: var(--c-line-strong);
  }
  .pact {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    height: 24px;
    padding: 0 6px;
    border: 1px solid transparent;
    border-radius: var(--r-ui);
    background: transparent;
    color: var(--c-tx);
    font: inherit;
    cursor: var(--cursor-cross-hover);
    transition: background-color 80ms linear, border-color 80ms linear, color 80ms linear;
  }
  .pact svg {
    width: 14px;
    height: 14px;
    stroke: var(--c-accent-bright);
  }
  .pact:hover,
  .pact:focus-visible {
    outline: none;
    background: var(--c-surface-2);
    border-color: var(--c-line-strong);
    color: var(--c-tx-hi);
  }
  .pact:active {
    background: var(--c-accent-tint);
    border-color: var(--c-accent);
  }
  .spacer {
    flex: 1 1 auto;
  }
  .ppage {
    font: 10.5px var(--font-mono);
    font-variant-numeric: tabular-nums;
    color: var(--c-tx-muted);
  }
  .pico {
    display: grid;
    place-items: center;
    width: 20px;
    height: 20px;
    padding: 0;
    border: none;
    border-radius: var(--r-ui);
    background: none;
    color: var(--c-tx-muted);
    cursor: var(--cursor-cross-hover);
  }
  .pico svg {
    width: 10px;
    height: 10px;
    stroke-width: 1.6;
  }
  .pico:hover {
    background: var(--c-surface-2);
    color: var(--c-tx-hi);
  }
  /* The passage, on a rail of its highlight's colour. */
  .pquote {
    padding-left: 9px;
    box-shadow: inset 3px 0 0 var(--ink);
    font: italic 12.5px/1.4 var(--font-serif);
    color: var(--c-tx-2);
    display: -webkit-box;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .pnote {
    width: 100%;
    box-sizing: border-box;
    resize: vertical;
    min-height: 62px;
    max-height: 40vh;
    padding: 6px 8px;
    background: var(--c-bg);
    color: var(--c-tx-hi);
    border: 1px solid var(--c-line-strong);
    border-radius: var(--r-ui);
    font: 13px/1.45 var(--font-serif);
    transition: border-color 80ms linear;
  }
  .pnote::placeholder {
    color: var(--c-tx-faint);
    font-style: italic;
  }
  .pnote:hover {
    border-color: var(--c-tx-muted);
  }
  .pnote:focus {
    outline: none;
    border-color: var(--c-accent);
    box-shadow: 0 0 0 3px var(--c-accent-tint-2);
  }
  .perr {
    padding: 5px 8px;
    background: color-mix(in oklab, var(--c-danger) 10%, transparent);
    box-shadow: inset 2px 0 0 var(--c-danger);
    color: var(--c-tx);
    font: 12px/1.4 var(--font-serif);
  }
  .pactions {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .pbtn {
    height: 24px;
    padding: 0 9px;
    border: 1px solid var(--c-line-strong);
    border-radius: var(--r-ui);
    background: transparent;
    color: var(--c-tx-2);
    font: 12px var(--font-serif);
    cursor: var(--cursor-cross-hover);
    white-space: nowrap;
    transition: background-color 80ms linear, border-color 80ms linear, color 80ms linear;
  }
  .pbtn:hover:not(:disabled) {
    background: var(--c-surface-2);
    border-color: var(--c-tx-muted);
    color: var(--c-tx-hi);
  }
  .pbtn:active:not(:disabled) {
    background: var(--c-accent-tint);
    border-color: var(--c-accent);
  }
  .pbtn.save {
    border-color: color-mix(in oklab, var(--c-accent) 60%, transparent);
    background: var(--c-accent-tint);
    color: var(--c-tx-hi);
  }
  .pbtn.save:hover:not(:disabled) {
    background: color-mix(in oklab, var(--c-accent) 28%, transparent);
    border-color: var(--c-accent);
  }
  .pbtn:disabled {
    opacity: 0.5;
  }
  .pbtn.danger:hover {
    background: color-mix(in oklab, var(--c-danger) 12%, transparent);
    border-color: var(--c-danger);
    color: var(--c-danger);
  }
  .phint {
    color: var(--c-tx-muted);
    font: 10.5px var(--font-mono);
  }
  .phint.saved {
    color: var(--c-tx-faint);
  }
  @media (prefers-reduced-motion: reduce) {
    .hl-pop {
      animation: none;
    }
    .pdot,
    .pact,
    .pnote,
    .pbtn {
      transition: none;
    }
  }
</style>
