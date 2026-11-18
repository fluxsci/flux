<script lang="ts">
  import { modalFocus } from "../../../lib/ui/modalFocus";
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
    /** A journal style: produces a submission manuscript (stage axis applies). */
    journal?: boolean;
  }
  export interface ExportPlan {
    format: ExportFormat["id"];
    style: string;
    outPath: string;
    /** Journal styles: the initial-submission file (figures beside their legends)
     *  or the revision text (legends only — figures go up as separate files). */
    stage?: "initial" | "final";
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
    documentTitle = "",
    onExport,
    onClose,
    onPickPath,
    onPickLibraryDocs,
    zoteroMatchSummary = "",
    onChange,
    onInstallQuarto,
    cslOptions = [],
    cslCurrent = "",
    onSetCsl,
  }: {
    formats: readonly ExportFormat[];
    styles: readonly ExportStyleOption[];
    engineLabel?: string;
    blockedReason?: string;
    /** Present when the block is a missing Quarto: offers the install right here. */
    onInstallQuarto?: () => void;
    initial: ExportPlan;
    /** The document being exported, shown in the header. */
    documentTitle?: string;
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
    /** Reference styles offered for the document's `csl:` (value → label). */
    cslOptions?: readonly { value: string; label: string }[];
    /** The document's current choice ("" = none: Pandoc's default). */
    cslCurrent?: string;
    /** Write the choice ("" removes `csl:`, CSL_LOAD opens a file picker);
     *  resolves to the new current value, or null when nothing changed. */
    onSetCsl?: (value: string) => Promise<string | null>;
  } = $props();

  /** The picker's "Load .csl file…" sentinel. */
  const CSL_LOAD = "__load__";
  // Follows the caller: its choices load while the dialog opens.
  let csl = $state("");
  $effect(() => {
    csl = cslCurrent;
  });
  let cslBusy = $state(false);
  async function chooseCsl(e: Event) {
    const select = e.currentTarget as HTMLSelectElement;
    const next = select.value;
    const before = csl;
    if (!onSetCsl) return;
    cslBusy = true;
    try {
      const result = await onSetCsl(next);
      csl = result ?? before;
    } finally {
      cslBusy = false;
      select.value = csl; // a cancelled "Load…" snaps back to the current style
      root?.focus();
    }
  }

  // The dialog is mounted fresh on each open (`{#if exportOpen}`), so `initial`
  // is a genuine seed rather than a live binding — untrack says so explicitly
  // and keeps the caller's plan from fighting local edits mid-session.
  let format = $state(untrack(() => initial.format));
  let style = $state(untrack(() => initial.style));
  let outPath = $state(untrack(() => initial.outPath));
  let zoteroFields = $state(untrack(() => initial.zoteroFields ?? false));
  let stage = $state<"initial" | "final">(untrack(() => initial.stage ?? "initial"));
  let zoteroLibraryDocs = $state<string[]>(untrack(() => initial.zoteroLibraryDocs ?? []));
  let root: HTMLDivElement | undefined = $state();

  const plan = (): ExportPlan => ({ format, style, outPath, stage, zoteroFields, zoteroLibraryDocs });

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
    if (next.stage !== undefined) stage = next.stage;
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

  // What each file is for, said once beside the format row.
  const FORMAT_NOTE: Record<ExportFormat["id"], string> = {
    pdf: "A typeset copy for reading and sending.",
    docx: "An editable Word file for co-authors and journals.",
    html: "One self-contained page for the web.",
  };
  // A style's blurb is a list ("Superscript citations · Fig. 1a,b · …"): show it as one.
  const rules = $derived((styleOf(style)?.blurb ?? "").split(" · ").map((r) => r.trim()).filter(Boolean));
  // The destination, split so the file name reads first and the folder clips from its start.
  const cut = $derived(Math.max(outPath.lastIndexOf("/"), outPath.lastIndexOf("\\")) + 1);
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="export-backdrop" onclick={onClose}></div>
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
  class="export-dialog"
  use:modalFocus
  role="dialog"
  aria-label="Export manuscript"
  aria-modal="true"
  tabindex="-1"
  bind:this={root}
  onkeydown={onKeydown}
  transition:popIn
>
  <header class="xhead">
    <strong class="xtitle">Export</strong>
    {#if documentTitle}<span class="xdoc" title={documentTitle}>{documentTitle}</span>{/if}
    <span class="xgrow"></span>
    <button class="xclose" onclick={onClose} aria-label="Close export" title="Close (Esc)">
      <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true"><path d="M1.5 1.5l7 7M8.5 1.5l-7 7" /></svg>
    </button>
  </header>

  <div class="xbody">
    <div class="row">
      <span class="lbl">Format</span>
      <div class="col">
        <div class="segments formats" role="group" aria-label="File format">
          {#each formats as f (f.id)}
            <button
              class="seg"
              class:on={format === f.id}
              disabled={!supports(f.id, style)}
              title={supports(f.id, style) ? "" : `${styleOf(style)?.label ?? "This style"} does not produce ${f.label}`}
              aria-pressed={format === f.id}
              onclick={() => pick({ format: f.id })}
              ><svg class="fico" viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"
                ><path d="M4 1.5h5.5L12.5 4.5v10h-8.5z" /><path d="M9.5 1.5v3h3" />{#if f.id === "pdf"}<path d="M6 8.5h4.5M6 10.5h4.5M6 12.5h3" />{:else if f.id === "docx"}<path d="M5.8 8.2l1.1 4.2 1.1-3.6 1.1 3.6 1.1-4.2" />{:else}<path d="M7.3 8.3L5.8 10.3 7.3 12.3M8.9 8.3l1.5 2-1.5 2" />{/if}</svg
              >{f.label}</button
            >
          {/each}
        </div>
        <p class="hint">{FORMAT_NOTE[format]}</p>
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
        {#if rules.length > 1}
          <ul class="rules" aria-label="What this style does">
            {#each rules as rule (rule)}<li>{rule}</li>{/each}
          </ul>
        {:else if rules.length}
          <p class="hint">{rules[0]}</p>
        {/if}
      </div>
    </div>

    {#if styleOf(style)?.journal}
      <div class="row">
        <span class="lbl">Stage</span>
        <div class="col">
          <div class="segments" role="group" aria-label="Submission stage">
            <button class="seg" class:on={stage === "initial"} aria-pressed={stage === "initial"} data-stage="initial" onclick={() => pick({ stage: "initial" })}>Initial submission</button>
            <button class="seg" class:on={stage === "final"} aria-pressed={stage === "final"} data-stage="final" onclick={() => pick({ stage: "final" })}>Revision files</button>
          </div>
          <p class="hint">
            {stage === "initial"
              ? "One file to submit: figures sit beside their legends, at 300 dpi."
              : "The revision text: legends listed after the references, figures uploaded as separate files."}
            A summary of what to check is written beside the export.
          </p>
        </div>
      </div>
    {/if}

    {#if onSetCsl && !styleOf(style)?.journal}
      <div class="row">
        <span class="lbl">References</span>
        <div class="col">
          <select aria-label="Reference style" value={csl} disabled={cslBusy} onchange={chooseCsl}>
            <option value="">Pandoc default (Chicago author–date)</option>
            {#each cslOptions as o (o.value)}
              <option value={o.value}>{o.label}</option>
            {/each}
            <option value={CSL_LOAD}>Load .csl file…</option>
          </select>
          <p class="hint">
            Saved in this document as <code>csl:</code>.
            {format === "docx"
              ? "Word exports format citations and the reference list in this style."
              : "Word exports use it; the in-app PDF and HTML keep Flux's own reference format."}
            The editor is unchanged.
          </p>
        </div>
      </div>
    {/if}

    {#if format === "docx"}
      <div class="row">
        <span class="lbl">Citations</span>
        <div class="col">
          <label class="check">
            <input
              type="checkbox"
              bind:checked={zoteroFields}
              onchange={() => publish()} />
            <span class="switch" aria-hidden="true"></span>
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
                    ? `: ${zoteroMatchSummary}`
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
  </div>

  <!-- Where it goes and what makes it: the last thing to read before Export. -->
  <div class="xdest" class:blocked={!!blockedReason}>
    <div class="row">
      <span class="lbl">Output</span>
      <div class="path">
        <span class="path-text" title={outPath}><bdo dir="ltr"><span class="dir">{outPath.slice(0, cut)}</span><b class="file">{outPath.slice(cut)}</b></bdo></span>
        <button class="ghost" onclick={choosePath}>Change…</button>
      </div>
    </div>
    {#if engineLabel || blockedReason}
      <div class="row">
        <span class="lbl">Engine</span>
        <div class="col">
          <p class="engine" class:warn={!!blockedReason}>{engineLabel}</p>
          {#if blockedReason}<p class="hint warn">{blockedReason}</p>{/if}
          {#if blockedReason && onInstallQuarto}<button class="ghost install-quarto" type="button" data-install-quarto onclick={onInstallQuarto}>Install Quarto…</button>{/if}
        </div>
      </div>
    {/if}
  </div>

  <div class="actions">
    <span class="keys"><kbd>Esc</kbd>cancel<span class="sep">·</span><kbd>↵</kbd>export</span>
    <button class="ghost" onclick={onClose}>Cancel</button>
    <button class="primary" {disabled} onclick={() => onExport(plan())}>Export</button>
  </div>
</div>

<style>
  .export-backdrop {
    position: absolute;
    inset: 0;
    z-index: 70;
    background: color-mix(in oklab, var(--flx-black) 26%, transparent);
  }
  .export-dialog {
    position: absolute;
    z-index: 71;
    top: 11vh;
    left: 50%;
    transform: translateX(-50%);
    width: min(560px, 92%);
    max-height: 80vh;
    display: flex;
    flex-direction: column;
    background: var(--flx-paper);
    border: 1.5px solid var(--c-edge);
    border-radius: var(--r-3);
    box-shadow:
      0 24px 60px -18px rgba(40, 30, 10, 0.5),
      0 6px 16px -6px rgba(40, 30, 10, 0.28);
    color: var(--c-tx);
    font-family: var(--font-serif);
    font-size: var(--ts-sm);
    overflow: hidden;
    outline: none;
  }

  /* ---- header ---------------------------------------------------------------------------- */
  .xhead {
    flex: 0 0 auto;
    display: flex;
    align-items: baseline;
    gap: 10px;
    padding: 13px 12px 11px 18px;
    border-bottom: 1px solid var(--c-line-strong);
  }
  .xtitle {
    font-size: var(--ts-md);
    font-weight: 600;
    letter-spacing: -0.005em;
    color: var(--c-tx-hi);
  }
  .xdoc {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-style: italic;
    color: var(--c-tx-muted);
  }
  .xgrow {
    flex: 1;
  }
  .xclose {
    align-self: center;
    display: inline-grid;
    place-items: center;
    width: 24px;
    height: 24px;
    padding: 0;
    border: 0;
    border-radius: var(--r-1);
    background: transparent;
    color: var(--c-tx-muted);
    cursor: var(--cursor-cross-hover);
    transition:
      background 80ms linear,
      color 80ms linear;
  }
  .xclose svg {
    fill: none;
    stroke: currentColor;
    stroke-width: 1.4;
    stroke-linecap: round;
  }
  .xclose:hover {
    background: var(--c-ui);
    color: var(--c-tx);
  }

  /* ---- the choices ------------------------------------------------------------------------ */
  .xbody {
    flex: 1 1 auto;
    min-height: 0;
    overflow: auto;
    display: grid;
    gap: 14px;
    padding: 16px 18px 16px;
    scrollbar-width: thin;
  }
  .row {
    display: grid;
    grid-template-columns: 84px minmax(0, 1fr);
    column-gap: 14px;
    align-items: start;
  }
  .lbl {
    padding-top: 9px;
    font: 600 10px/1.2 var(--font-mono);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--c-tx-muted);
  }
  .col {
    min-width: 0;
    display: grid;
    gap: 6px;
  }
  .segments {
    display: inline-flex;
    justify-self: start;
    max-width: 100%;
    border: 1px solid var(--c-line-strong);
    border-radius: var(--r-1);
    background: #fffefa;
    overflow: hidden;
  }
  .seg {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    height: 32px;
    padding: 0 14px;
    border: 0;
    border-right: 1px solid var(--c-line);
    background: transparent;
    color: var(--c-tx-2);
    font: 600 var(--ts-sm) var(--font-serif);
    white-space: nowrap;
    cursor: var(--cursor-cross-hover);
    transition:
      background 80ms linear,
      color 80ms linear,
      box-shadow 80ms linear;
  }
  .seg:last-child {
    border-right: 0;
  }
  .formats .seg {
    min-width: 86px;
    justify-content: center;
  }
  .fico {
    flex: 0 0 auto;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.1;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .seg:hover:not(:disabled):not(.on) {
    background: var(--c-accent-tint-2);
    color: var(--c-tx);
  }
  .seg:active:not(:disabled) {
    background: var(--c-accent-tint);
  }
  /* The chosen one: a tint and a rail under it, never a solid fill. */
  .seg.on {
    background: var(--c-accent-tint-2);
    color: var(--c-accent);
    box-shadow: inset 0 -2px 0 var(--c-accent);
  }
  .seg:disabled {
    color: var(--c-tx-faint);
    opacity: 0.55;
    cursor: var(--cursor-cross);
  }
  .seg:focus-visible,
  select:focus-visible,
  .ghost:focus-visible,
  .primary:focus-visible,
  .xclose:focus-visible {
    outline: 2px solid var(--c-accent);
    outline-offset: 1px;
  }
  select {
    appearance: none;
    box-sizing: border-box;
    width: 100%;
    height: 34px;
    padding: 0 30px 0 11px;
    border: 1px solid var(--c-line-strong);
    border-radius: var(--r-1);
    background-color: #fffefa;
    background-image:
      linear-gradient(45deg, transparent 50%, var(--c-tx-muted) 50%),
      linear-gradient(135deg, var(--c-tx-muted) 50%, transparent 50%);
    background-position:
      calc(100% - 16px) 50%,
      calc(100% - 11px) 50%;
    background-size:
      5px 5px,
      5px 5px;
    background-repeat: no-repeat;
    color: var(--c-tx);
    font: var(--ts-sm) var(--font-serif);
    cursor: var(--cursor-cross-hover);
    transition:
      border-color 80ms linear,
      box-shadow 80ms linear;
  }
  select:hover:not(:disabled) {
    border-color: color-mix(in oklab, var(--c-accent) 45%, var(--c-line-strong));
  }
  select:focus {
    border-color: var(--c-accent);
    box-shadow: 0 0 0 3px var(--c-accent-tint-2);
    outline: none;
  }
  .hint {
    margin: 0;
    color: var(--c-tx-muted);
    font-size: var(--ts-xs);
    line-height: 1.45;
  }
  .hint code {
    padding: 0 4px;
    border-radius: var(--r-ui);
    background: var(--c-surface);
    font: 0.95em var(--font-mono);
  }
  .hint.warn {
    color: var(--c-danger);
  }
  /* What a journal style does, as a list you can scan. */
  .rules {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 5px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .rules li {
    padding: 2px 8px;
    border: 1px solid var(--c-line-strong);
    border-radius: var(--r-pill);
    background: #fffefa;
    color: var(--c-tx-2);
    font-size: var(--ts-xs);
    line-height: 1.4;
  }
  .check {
    display: inline-flex;
    align-items: center;
    gap: 9px;
    justify-self: start;
    min-height: 32px;
    color: var(--c-tx);
    cursor: var(--cursor-cross-hover);
  }
  .check input {
    position: absolute;
    opacity: 0;
    pointer-events: none;
  }
  .switch {
    position: relative;
    flex: 0 0 auto;
    width: 30px;
    height: 17px;
    border: 1px solid var(--c-line-strong);
    border-radius: var(--r-pill);
    background: var(--c-ui);
    transition:
      background 80ms linear,
      border-color 80ms linear;
  }
  .switch::after {
    content: "";
    position: absolute;
    top: 2px;
    left: 2px;
    width: 11px;
    height: 11px;
    border-radius: 50%;
    background: var(--flx-paper);
    box-shadow: 0 1px 2px rgba(16, 15, 15, 0.35);
    transition: transform 90ms var(--ease-standard);
  }
  .check input:checked + .switch {
    background: var(--c-accent);
    border-color: var(--c-accent);
  }
  .check input:checked + .switch::after {
    transform: translateX(13px);
  }
  .check input:focus-visible + .switch {
    outline: 2px solid var(--c-accent);
    outline-offset: 2px;
  }
  .sub {
    display: flex;
    align-items: flex-start;
    gap: 10px;
  }
  .sub .ghost {
    flex: 0 0 auto;
  }

  /* ---- destination ------------------------------------------------------------------------ */
  .xdest {
    flex: 0 0 auto;
    display: grid;
    gap: 6px;
    padding: 11px 18px 12px;
    border-top: 1px solid var(--c-line-strong);
    background: var(--c-surface);
  }
  .xdest .lbl {
    padding-top: 8px;
  }
  .path {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
  }
  /* Clipped from its START, so the file name is always the part you can read. The inner
     <bdo> keeps every character in reading order (a bare rtl run moved the leading slash to
     the end: "…/round-1.pdf/"). */
  .path-text {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    direction: rtl;
    text-align: left;
    font: 11.5px/1.4 var(--font-mono);
    color: var(--c-tx-muted);
  }
  .path-text .file {
    color: var(--c-tx);
    font-weight: 600;
  }
  .engine {
    margin: 0;
    padding-top: 7px;
    color: var(--c-tx-2);
    font-size: var(--ts-xs);
    line-height: 1.45;
  }
  .engine.warn {
    color: var(--c-tx-muted);
    text-decoration: line-through;
  }
  .install-quarto {
    justify-self: start;
  }

  /* ---- actions ---------------------------------------------------------------------------- */
  .actions {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 11px 14px 12px 18px;
    border-top: 1px solid var(--c-line-strong);
  }
  .keys {
    flex: 1 1 auto;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    color: var(--c-tx-faint);
    font-size: var(--ts-xs);
  }
  .keys > * {
    flex: 0 0 auto;
  }
  .keys kbd {
    color: var(--c-tx-faint);
  }
  .keys .sep {
    opacity: 0.55;
  }
  .ghost,
  .primary {
    flex: 0 0 auto;
    height: 30px;
    padding: 0 14px;
    border: 1px solid var(--c-line-strong);
    border-radius: var(--r-1);
    background: transparent;
    color: var(--c-tx-2);
    font: 600 var(--ts-sm) var(--font-serif);
    white-space: nowrap;
    cursor: var(--cursor-cross-hover);
    transition:
      background 80ms linear,
      border-color 80ms linear,
      color 80ms linear,
      transform 60ms linear;
  }
  .ghost:hover {
    background: var(--c-ui);
    color: var(--c-tx);
  }
  .ghost:active,
  .primary:active:not(:disabled) {
    transform: translateY(0.5px) scale(0.985);
  }
  .primary {
    min-width: 92px;
    border-color: var(--c-accent);
    background: var(--c-accent);
    color: var(--c-on-accent);
  }
  .primary:hover:not(:disabled) {
    background: var(--c-accent-bright);
    border-color: var(--c-accent-bright);
  }
  .primary:disabled {
    opacity: 0.4;
    cursor: var(--cursor-cross);
  }
</style>
