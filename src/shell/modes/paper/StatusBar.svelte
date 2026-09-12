<script lang="ts">
  // Persistent, glanceable status — a slim translucent pill bottom-right of
  // the editor column (Obsidian's placement). Dumb component: PaperMode feeds
  // it already-computed values (words from the 150ms-debounced latestIdle —
  // nothing here touches the typing hot path). Vim's mode indicator lives in
  // vim's own bottom panel, not here.
  //
  // It also carries the TEXT SIZE control (Word's bottom-right zoom slider):
  // − / slider / + / a percentage readout that opens the scope popover. The
  // readout is the "toggle" — clicking it says WHICH panels the slider and the
  // Ctrl+/− chords resize; the slider itself stays a plain drag.
  import {
    PAPER_PANELS,
    PANEL_LABELS,
    SCALE_MAX,
    SCALE_MIN,
    SCALE_SLIDER_STEP,
    allTargeted,
    representativeScale,
    setTarget,
    scalePercent,
    targetsMixed,
    type PaperPanelId,
    type PaperTextScaleState,
  } from "./view-mode/paperTextScale";

  let {
    words,
    status,
    onStats,
    onExport,
    exporting = false,
    correctionStatus,
    onToggleCorrections,
    textScale,
    onTextScale,
    onTextScaleStep,
    onTextScaleReset,
    onTextScaleTarget,
    onTextScaleAllTargets,
  }: {
    words: number;
    status: "demo" | "saved" | "saving" | "error";
    onStats: () => void;
    onExport: () => void;
    exporting?: boolean;
    correctionStatus: "off" | "loading" | "ready" | "error";
    onToggleCorrections: () => void;
    textScale: PaperTextScaleState;
    onTextScale: (value: number) => void;
    onTextScaleStep: (dir: 1 | -1) => void;
    onTextScaleReset: () => void;
    onTextScaleTarget: (panel: PaperPanelId, on: boolean) => void;
    onTextScaleAllTargets: () => void;
  } = $props();

  const percent = $derived(scalePercent(representativeScale(textScale)));
  const mixed = $derived(targetsMixed(textScale));
  const scopeSummary = $derived(
    allTargeted(textScale)
      ? "all panels"
      : PAPER_PANELS.filter((p) => textScale.targets[p])
          .map((p) => PANEL_LABELS[p].toLowerCase())
          .join(" + "),
  );

  // The core REFUSES to empty the scope. A checkbox is uncontrolled once the
  // user clicks it, so a refusal that changes no state would leave the box
  // showing the refused value forever — re-assert the truth on the element
  // itself, using the same pure function the parent will apply.
  function toggleTarget(panel: PaperPanelId, el: HTMLInputElement) {
    const want = el.checked;
    el.checked = setTarget(textScale, panel, want).targets[panel];
    onTextScaleTarget(panel, want);
  }

  let scopeOpen = $state(false);
  let zoomEl = $state<HTMLDivElement | undefined>(undefined);
  let scopeEl = $state<HTMLDivElement | undefined>(undefined);

  // Dismissal: anywhere outside, or Esc. Capture phase so a click that also
  // lands on an editor handler still closes the popover first.
  $effect(() => {
    if (!scopeOpen) return;
    const away = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (t && (scopeEl?.contains(t) || zoomEl?.contains(t))) return;
      scopeOpen = false;
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      scopeOpen = false;
    };
    window.addEventListener("pointerdown", away, true);
    window.addEventListener("keydown", esc, true);
    return () => {
      window.removeEventListener("pointerdown", away, true);
      window.removeEventListener("keydown", esc, true);
    };
  });
</script>

<div class="statusbar ts-scaled">
  <!-- Two stacked rows so the pill stays narrow: at ~190px it covers a third of
       the prose the single wide row used to sit over. Zoom on top, the
       status/actions row underneath. -->
  <div class="row zoomrow">
    <div class="zoom" bind:this={zoomEl} data-text-scale={percent}>
      <button
        class="seg step minus"
        onclick={() => onTextScaleStep(-1)}
        title="Smaller text (Ctrl −)"
        aria-label="Smaller text">−</button>
      <input
        class="zslider"
        type="range"
        min={Math.round(SCALE_MIN * 100)}
        max={Math.round(SCALE_MAX * 100)}
        step={Math.round(SCALE_SLIDER_STEP * 100)}
        value={percent}
        aria-label="Text size"
        title={`Text size — applies to ${scopeSummary}`}
        oninput={(e) => onTextScale(Number(e.currentTarget.value) / 100)} />
      <button
        class="seg step plus"
        onclick={() => onTextScaleStep(1)}
        title="Larger text (Ctrl +)"
        aria-label="Larger text">+</button>
      <button
        class="seg pct"
        class:open={scopeOpen}
        aria-haspopup="dialog"
        aria-expanded={scopeOpen}
        onclick={() => (scopeOpen = !scopeOpen)}
        title={`Text size ${percent}% — applies to ${scopeSummary}. Click to choose which panels.`}>
        {percent}%{#if mixed}<span class="mixed" aria-hidden="true">·</span>{/if}<span
          class="chev"
          aria-hidden="true">▾</span>
      </button>
    </div>
  </div>
  <div class="row mainrow">
    <button
      class="seg corrections"
      class:on={correctionStatus === "ready"}
      class:error={correctionStatus === "error"}
      data-correction-status={correctionStatus}
      onclick={onToggleCorrections}
      aria-pressed={correctionStatus !== "off"}
      title={correctionStatus === "off"
        ? "Local corrections off — click to enable"
        : correctionStatus === "loading"
          ? "Local corrections are warming up on this device"
          : correctionStatus === "error"
            ? "Local corrections unavailable — click to retry"
            : "Local corrections on — private and on-device"}>
      <span class="correction-dot" aria-hidden="true"></span>
      Local
    </button>
    <button class="seg" onclick={onExport} disabled={exporting} title="Export — PDF · HTML · Word (also in ⌘K)">
      {exporting ? "Exporting…" : "Export"}
    </button>
    <button class="seg" onclick={onStats} title="Statistics (⌘K → Statistics)">
      {words.toLocaleString()} words
    </button>
    {#if status !== "saved"}
      <span class="seg state" class:error={status === "error"}>
        {status === "saving" ? "saving…" : status}
      </span>
    {/if}
  </div>

  <!-- Inside the pill and anchored to its top edge, so it follows the pill
       wherever it sits (taller rows, the vim panel's shift) with no second
       hard-coded offset to keep in sync. -->
  {#if scopeOpen}
    <div class="scope ts-scaled" bind:this={scopeEl} role="dialog" aria-label="Text size scope">
      <div class="scope-head">Resize the text of</div>
      <label class="scope-row all">
        <input
          type="checkbox"
          checked={allTargeted(textScale)}
          onchange={onTextScaleAllTargets} />
        <span>All panels together</span>
      </label>
      <div class="scope-rule"></div>
      {#each PAPER_PANELS as panel (panel)}
        <label class="scope-row">
          <input
            type="checkbox"
            data-panel={panel}
            checked={textScale.targets[panel]}
            onchange={(e) => toggleTarget(panel, e.currentTarget)} />
          <span>{PANEL_LABELS[panel]}</span>
          <span class="scope-pct">{scalePercent(textScale.scale[panel])}%</span>
        </label>
      {/each}
      <div class="scope-rule"></div>
      <div class="scope-foot">
        <!-- nbsp inside each chord so a wrap can only fall BETWEEN shortcuts,
             never between "Ctrl +" and its key. -->
        <span class="scope-hint">Ctrl&nbsp;+ / Ctrl&nbsp;− · Ctrl&nbsp;0 resets</span>
        <button class="scope-reset" onclick={onTextScaleReset}>Reset</button>
      </div>
    </div>
  {/if}
</div>

<style>
  .statusbar {
    position: absolute;
    right: 14px;
    /* Low in the column, but lifted clear of the editor's horizontal scrollbar
       whenever one is present (PaperMode measures it into --hscroll-h). */
    bottom: calc(11px + var(--hscroll-h, 0px));
    transition: bottom var(--dur-instant) var(--ease-standard);
    z-index: 30;
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 1px;
    padding: 3px 4px;
    border: 1px solid var(--c-line);
    /* A stadium radius reads as a lozenge once the pill is two rows tall — a
       soft rounded rect is the same chrome at this height. */
    border-radius: var(--r-2);
    background: color-mix(in srgb, var(--c-surface) 85%, transparent);
    backdrop-filter: blur(3px);
    font-size: var(--ts-xs);
    color: var(--c-tx-faint);
    pointer-events: none;
    /* Chrome, not content: .ts-scaled + scale 1 re-derives the type scale
       locally, so the status bar (and its slider) keeps its own size while the
       manuscript panel around it grows. */
    --ts-scale: 1;
  }
  /* Vim's bottom status panel spans the column and would cover the pill —
     ride above it whenever the panel is in the DOM. */
  :global(.editor-col:has(.cm-vim-panel)) .statusbar {
    bottom: 30px;
  }
  .row {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 2px;
  }
  .seg {
    pointer-events: auto;
    background: none;
    border: none;
    font: inherit;
    color: inherit;
    padding: 2px 7px;
    border-radius: var(--r-pill);
    cursor: pointer;
    font-variant-numeric: tabular-nums;
  }
  .seg:hover:not(:disabled) {
    color: var(--c-tx-2);
    background: var(--c-surface);
  }
  .seg:disabled {
    opacity: 0.55;
    cursor: default;
  }
  .state {
    cursor: default;
    pointer-events: none;
  }
  .state.error {
    color: var(--c-danger);
  }
  .corrections {
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }
  .correction-dot {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: currentColor;
    opacity: 0.45;
  }
  .corrections.on {
    color: var(--c-accent);
  }
  .corrections.on .correction-dot {
    opacity: 1;
    box-shadow: 0 0 0 2px var(--c-accent-tint);
  }
  .corrections.error {
    color: var(--c-warning);
  }

  /* ---- text size ------------------------------------------------------- */
  .zoom {
    display: inline-flex;
    align-items: center;
    gap: 1px;
  }
  .step {
    padding: 2px 5px;
    line-height: 1;
    font-size: 1.15em;
  }
  .zslider {
    pointer-events: auto;
    appearance: none;
    -webkit-appearance: none;
    width: 74px;
    height: 14px;
    margin: 0 2px;
    background: transparent;
    cursor: pointer;
  }
  .zslider::-webkit-slider-runnable-track {
    height: 3px;
    border-radius: 2px;
    background: var(--c-line-strong);
  }
  .zslider::-webkit-slider-thumb {
    appearance: none;
    -webkit-appearance: none;
    width: 11px;
    height: 11px;
    margin-top: -4px;
    border-radius: 50%;
    border: none;
    background: var(--c-tx-faint);
  }
  .zslider:hover::-webkit-slider-thumb,
  .zslider:focus-visible::-webkit-slider-thumb {
    background: var(--c-accent);
  }
  .pct {
    display: inline-flex;
    align-items: center;
    gap: 1px;
    min-width: 44px;
    justify-content: flex-end;
  }
  .pct.open {
    color: var(--c-tx-2);
    background: var(--c-surface);
  }
  .chev {
    font-size: 0.85em;
    opacity: 0.7;
  }
  .mixed {
    color: var(--c-accent);
    font-weight: 700;
  }

  .scope {
    position: absolute;
    right: 0;
    /* The pill is the containing block (backdrop-filter establishes one), so
       this tracks its top edge at any row height. */
    bottom: calc(100% + 7px);
    z-index: 40;
    pointer-events: auto;
    width: 248px;
    padding: 8px;
    border: 1px solid var(--c-line-strong);
    border-radius: var(--r-2);
    background: var(--c-surface);
    box-shadow: 0 10px 28px rgb(0 0 0 / 24%);
    font-size: var(--ts-xs);
    color: var(--c-tx-2);
    /* Georgia's default old-style figures render 0 as a small o — unreadable in
       a line that spells out a shortcut. */
    font-variant-numeric: lining-nums tabular-nums;
    --ts-scale: 1;
  }
  .scope-head {
    padding: 1px 4px 6px;
    color: var(--c-tx-faint);
    text-transform: uppercase;
    letter-spacing: var(--tracking-wide);
    font-size: 0.9em;
  }
  .scope-row {
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 4px;
    border-radius: var(--r-1);
    cursor: pointer;
  }
  .scope-row:hover {
    background: var(--c-surface-2);
  }
  .scope-row.all {
    font-weight: 600;
    color: var(--c-tx);
  }
  .scope-row input {
    accent-color: var(--c-accent);
    margin: 0;
  }
  .scope-row span:nth-of-type(1) {
    flex: 1;
  }
  .scope-pct {
    color: var(--c-tx-faint);
    font-variant-numeric: tabular-nums;
  }
  .scope-rule {
    height: 1px;
    margin: 5px 2px;
    background: var(--c-line);
  }
  .scope-foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 1px 4px;
    color: var(--c-tx-faint);
  }
  .scope-hint {
    line-height: 1.4;
  }
  .scope-reset {
    flex: none;
    font: inherit;
    color: var(--c-tx-2);
    background: none;
    border: 1px solid var(--c-line);
    border-radius: var(--r-pill);
    padding: 2px 9px;
    cursor: pointer;
  }
  .scope-reset:hover {
    color: var(--c-accent);
    border-color: var(--c-accent);
  }
</style>
