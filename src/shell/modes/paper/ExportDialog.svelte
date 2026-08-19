<script lang="ts">
  // The export dialog — two orthogonal axes: FILE FORMAT and JOURNAL STYLE.
  //
  // Replaces the old three-button popover, which had no options at all: Word
  // landed beside the .qmd with no say in the matter, there was no progress and
  // no way to cancel a multi-second Quarto render.
  //
  // The style axis is deliberately export-only. Flux's writer keeps its own
  // conventions no matter which journal is selected (see the engineering guide
  // + verify-writer-neutral); a style changes the OUTPUT and the preview, never
  // what you type against.
  import { untrack } from "svelte";
  import { popIn } from "../../../lib/motion/actions";

  export interface ExportFormat {
    id: "pdf" | "docx" | "html";
    label: string;
    ext: string;
  }
  export interface ExportStyleOption {
    id: string;
    label: string;
    /** One line describing what the style does to the output. */
    blurb?: string;
    /** Formats this style can produce; others are disabled with a reason. */
    formats?: readonly ExportFormat["id"][];
  }
  export interface ExportPlan {
    format: ExportFormat["id"];
    style: string;
    outPath: string;
    /** Word only: write citations as live Zotero fields rather than baked text. */
    zoteroFields?: boolean;
    /** Word documents already written through Zotero, whose item identities bind our
     *  citations to that library. Absolute paths; empty means "embed everything". */
    zoteroLibraryDocs?: string[];
  }

  let {
    formats,
    styles,
    /** Which engine will run, e.g. "Quarto → LaTeX" — derived by the caller. */
    engineLabel = "",
    /** Non-empty when the chosen combination cannot run (missing Quarto/TeX). */
    blockedReason = "",
    initial,
    onExport,
    onClose,
    onPickPath,
    onPickLibraryDocs,
    zoteroMatchSummary = "",
    onChange,
  }: {
    formats: readonly ExportFormat[];
    styles: readonly ExportStyleOption[];
    engineLabel?: string;
    blockedReason?: string;
    initial: ExportPlan;
    onExport: (plan: ExportPlan) => void;
    onClose: () => void;
    /** Opens the OS save dialog; resolves to null when cancelled. */
    onPickPath: (plan: ExportPlan) => Promise<string | null>;
    /** Opens a picker for .docx files containing Zotero citations; null when cancelled. */
    onPickLibraryDocs?: () => Promise<string[] | null>;
    /** e.g. "98 of 102 references matched" — computed by the caller after a pick. */
    zoteroMatchSummary?: string;
    /** Fires whenever the plan changes so the caller can recompute engine/path.
     *  It may return a REVISED plan — the caller owns the default destination,
     *  and returning it here is how a format switch re-derives the file name
     *  (`report.pdf` → `report.docx`) instead of exporting Word bytes to a
     *  `.pdf`. Anything it returns for outPath is adopted. */
    onChange?: (plan: ExportPlan) => ExportPlan | void;
  } = $props();

  // The dialog is mounted fresh on each open (`{#if exportOpen}`), so `initial`
  // is a genuine seed rather than a live binding — untrack says so explicitly
  // and keeps the caller's plan from fighting local edits mid-session.
  let format = $state(untrack(() => initial.format));
  let style = $state(untrack(() => initial.style));
  let outPath = $state(untrack(() => initial.outPath));
  let zoteroFields = $state(untrack(() => initial.zoteroFields ?? false));
  let zoteroLibraryDocs = $state<string[]>(untrack(() => initial.zoteroLibraryDocs ?? []));
  let root: HTMLDivElement | undefined = $state();

  const plan = (): ExportPlan => ({ format, style, outPath, zoteroFields, zoteroLibraryDocs });

  /** Publish the plan and adopt the destination the caller derives for it. The
   *  dialog seeds `outPath` from `initial` once (untracked), so without this
   *  the path shown — and exported to — kept the extension of whichever format
   *  the dialog happened to OPEN on. */
  function publish() {
    const revised = onChange?.(plan());
    if (revised?.outPath) outPath = revised.outPath;
  }

  // A style may not support every format (no journal HTML, say). Selecting an
  // unsupported combination is impossible rather than merely discouraged.
  const styleOf = (id: string) => styles.find((s) => s.id === id);
  const supports = (f: ExportFormat["id"], sid: string) => {
    const allowed = styleOf(sid)?.formats;
    return !allowed || allowed.includes(f);
  };
  const disabled = $derived(!!blockedReason || !supports(format, style));

  function pick(next: Partial<ExportPlan>) {
    if (next.format !== undefined) format = next.format;
    if (next.style !== undefined) {
      style = next.style;
      // Moving to a style that can't make the current format snaps the format
      // to the first one it can, rather than leaving a dead Export button.
      if (!supports(format, style)) {
        const fallback = formats.find((f) => supports(f.id, style));
        if (fallback) format = fallback.id;
      }
    }
    publish();
  }

  async function chooseLibraryDocs() {
    const picked = await onPickLibraryDocs?.();
    if (picked) {
      zoteroLibraryDocs = picked;
      publish();
    }
  }

  async function choosePath() {
    const p = await onPickPath(plan());
    if (!p) return;
    outPath = p;
    // Tell the caller too: a path the USER chose must survive the next format
    // switch, and the caller can only tell it apart from its own default by
    // seeing it.
    publish();
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }
    // Enter exports — unless focus is on a button, which owns its own action.
    if (e.key === "Enter" && !(e.target instanceof HTMLButtonElement) && !disabled) {
      e.preventDefault();
      onExport(plan());
    }
  }

  $effect(() => {
    // Focus the panel so Esc/Enter land here and not in the editor behind it.
    root?.focus();
  });
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="export-backdrop" onclick={onClose}></div>
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
  class="export-dialog"
  role="dialog"
  aria-label="Export manuscript"
  aria-modal="true"
  tabindex="-1"
  bind:this={root}
  onkeydown={onKeydown}
  transition:popIn
>
  <div class="row">
    <span class="lbl">Format</span>
    <div class="segments" role="group" aria-label="File format">
      {#each formats as f (f.id)}
        <button
          class="seg"
          class:on={format === f.id}
          disabled={!supports(f.id, style)}
          title={supports(f.id, style) ? "" : `${styleOf(style)?.label ?? "This style"} does not produce ${f.label}`}
          aria-pressed={format === f.id}
          onclick={() => pick({ format: f.id })}>{f.label}</button
        >
      {/each}
    </div>
  </div>

  <div class="row">
    <span class="lbl">Style</span>
    <div class="col">
      <select aria-label="Journal style" bind:value={style} onchange={() => pick({ style })}>
        {#each styles as s (s.id)}
          <option value={s.id}>{s.label}</option>
        {/each}
      </select>
      {#if styleOf(style)?.blurb}
        <p class="hint">{styleOf(style)!.blurb}</p>
      {/if}
    </div>
  </div>

  {#if format === "docx"}
    <div class="row">
      <span class="lbl">Citations</span>
      <div class="col">
        <label class="check">
          <input
            type="checkbox"
            bind:checked={zoteroFields}
            onchange={() => publish()} />
          Live Zotero citations
        </label>
        <p class="hint">
          Citations stay editable in Word: refresh, restyle, renumber, and cite alongside
          them. Without this they are plain text.
        </p>
        {#if zoteroFields}
          <div class="sub">
            <button class="ghost" onclick={chooseLibraryDocs}>
              {zoteroLibraryDocs.length ? "Change documents…" : "Link to library from…"}
            </button>
            {#if zoteroLibraryDocs.length}
              <span class="hint"
                >{zoteroLibraryDocs.length} document{zoteroLibraryDocs.length === 1 ? "" : "s"}{zoteroMatchSummary
                  ? ` — ${zoteroMatchSummary}`
                  : ""}</span>
            {:else}
              <span class="hint"
                >Optional. Pick Word files that already use Zotero, and citations to the same
                works arrive linked to that library instead of embedded.</span>
            {/if}
          </div>
        {/if}
      </div>
    </div>
  {/if}

  {#if engineLabel || blockedReason}
    <div class="row">
      <span class="lbl">Engine</span>
      <div class="col">
        <p class="hint" class:warn={!!blockedReason}>{engineLabel}</p>
        {#if blockedReason}<p class="hint warn">{blockedReason}</p>{/if}
      </div>
    </div>
  {/if}

  <div class="row">
    <span class="lbl">Output</span>
    <div class="path">
      <span class="path-text" title={outPath}>{outPath}</span>
      <button class="ghost" onclick={choosePath}>Change…</button>
    </div>
  </div>

  <div class="actions">
    <button class="ghost" onclick={onClose}>Cancel</button>
    <button class="primary" {disabled} onclick={() => onExport(plan())}>Export</button>
  </div>
</div>

<style>
  .check {
    display: flex;
    align-items: center;
    gap: 0.5em;
    cursor: pointer;
  }
  .sub {
    display: flex;
    align-items: center;
    gap: 0.6em;
    flex-wrap: wrap;
    margin-top: 0.35em;
  }
  .export-backdrop {
    position: absolute;
    inset: 0;
    z-index: 70;
    background: rgba(0, 0, 0, 0.18);
  }
  .export-dialog {
    position: absolute;
    z-index: 71;
    top: 14vh;
    left: 50%;
    transform: translateX(-50%);
    width: min(520px, 92%);
    display: flex;
    flex-direction: column;
    gap: var(--sp-3);
    padding: var(--sp-4);
    background: var(--c-surface, #fff);
    border: 1px solid var(--c-line-strong, #ccc);
    border-radius: 10px;
    box-shadow: var(--elev-2);
    outline: none;
  }
  .row {
    display: flex;
    align-items: baseline;
    gap: var(--sp-3);
  }
  .lbl {
    flex: 0 0 64px;
    font-size: var(--ts-sm);
    color: var(--c-tx-2);
  }
  .col {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: var(--sp-1);
  }
  .segments {
    display: flex;
    gap: var(--sp-1);
  }
  .seg {
    padding: var(--sp-1) var(--sp-3);
    border: 1px solid var(--c-line, #ddd);
    border-radius: 6px;
    background: transparent;
    color: inherit;
    font: inherit;
    font-size: var(--ts-sm);
    cursor: pointer;
  }
  .seg.on {
    border-color: var(--c-accent-bright);
    color: var(--c-accent-bright);
  }
  .seg:disabled {
    opacity: 0.42;
    cursor: default;
  }
  select {
    width: 100%;
    box-sizing: border-box;
    padding: var(--sp-2) var(--sp-3);
    border: 1px solid var(--c-line-strong, #ccc);
    border-radius: 6px;
    background: var(--c-surface, #fff);
    color: inherit;
    font-size: var(--ts-base, 0.95rem);
  }
  .hint {
    margin: 0;
    font-size: var(--ts-sm);
    color: var(--c-tx-2);
  }
  .hint.warn {
    color: var(--c-danger, #d14d41);
  }
  .path {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: var(--sp-2);
  }
  .path-text {
    flex: 1 1 auto;
    min-width: 0;
    font-size: var(--ts-sm);
    color: var(--c-tx-2);
    /* Long project paths must not widen the dialog — clip from the LEFT so the
       filename, the part that identifies the artifact, stays visible. */
    overflow: hidden;
    white-space: nowrap;
    direction: rtl;
    text-align: left;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--sp-2);
    margin-top: var(--sp-1);
  }
  .ghost,
  .primary {
    padding: var(--sp-1) var(--sp-3);
    border-radius: 6px;
    font: inherit;
    font-size: var(--ts-sm);
    cursor: pointer;
  }
  .ghost {
    border: 1px solid var(--c-line, #ddd);
    background: transparent;
    color: inherit;
  }
  .primary {
    border: 1px solid var(--c-accent-bright);
    background: var(--c-accent-bright);
    color: var(--c-bg);
  }
  .primary:disabled {
    opacity: 0.45;
    cursor: default;
  }
</style>
