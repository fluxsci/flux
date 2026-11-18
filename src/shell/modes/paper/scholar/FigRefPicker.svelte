<script lang="ts">
  // `@@`: cite a figure, or some of its panels. Two steps in the margin card's chrome
  // (PickerShell): find the figure (FigureFinder), then look at it on the same stage the
  // Figures card uses and press its panels' letters. Both steps are fully keyboard-driven.
  // 2026-11-18 (owner: "update this @@ popup so that it gets the same ui/ux, look, feel
  // improvements you made to the alt-f card … make the icons more compact, make it feel more
  // tactile/responsive/coherent"): the same card, stage, caption line, panel letters and
  // buttons as the Figures card; cells a third smaller; Insert is also a button.
  import { yieldsToShellModal, isAnnotateChord } from "../../../agent/annotationVisibility";
  import { tick } from "svelte";
  import { resolveFigure, figRefText, type FigureRef } from "./figures";
  import { plainCaption } from "./figText";
  import PickerShell from "./PickerShell.svelte";
  import FigureFinder from "./FigureFinder.svelte";
  import FigureStage from "./FigureStage.svelte";

  let {
    figures,
    canvases = [],
    nums,
    onInsert,
    onClose,
  }: {
    figures: FigureRef[];
    /** Project canvas list (id + display name, canonical order) for the
     *  scope dropdown; with 0–1 canvases the dropdown is not shown. */
    canvases?: { id: string; name: string }[];
    /** WS-4.2: the owning editor's numbering instance (tbl/eq cross-refs). */
    nums?: import("./numberingFacet").PaperNumbering;
    /** Called with the full reference text to insert, e.g. "@fig-x-a,c". */
    onInsert: (text: string) => void;
    onClose: () => void;
  } = $props();

  let stage = $state<"figure" | "panels">("figure");
  // Held here so going on to the panels and back keeps what you typed.
  let query = $state("");
  let canvasSel = $state(""); // "" = all canvases
  let finder = $state<ReturnType<typeof FigureFinder> | undefined>(undefined);
  let panelsEl = $state<HTMLElement | undefined>(undefined);

  let figId = $state<string | null>(null);
  const fig = $derived(figures.find((f) => f.id === figId) ?? null);
  let priorPanels = "";
  $effect(() => {
    const signature = `${fig?.id ?? ""}:${fig?.panels.join(",") ?? ""}`;
    if (signature !== priorPanels) { priorPanels = signature; picked = new Set(); hl = 0; }
    if (figId && !fig) { figId = null; stage = "figure"; }
  });
  let hl = $state(0); // where the keyboard is among the panel letters
  let picked = $state<Set<string>>(new Set());

  // What Enter will insert, resolved live through the same registry the chips
  // use — the previewed text IS the text the chip will show ("Fig. S4a–c").
  const resultText = $derived(fig ? figRefText(fig, picked) : "");
  const resultDisplay = $derived(
    fig ? (resolveFigure(resultText.slice(1), nums)?.display ?? fig.display) : "",
  );

  function choose(f: FigureRef) {
    if (f.panels.length) {
      figId = f.id;
      picked = new Set();
      hl = 0;
      stage = "panels";
      // Letters must toggle panels, not type into the search box.
      void tick().then(() => panelsEl?.focus());
    } else {
      onInsert("@" + f.label); // no known panels — whole figure, done
    }
  }
  function backToFigures() {
    stage = "figure";
    figId = null;
    void tick().then(() => finder?.focus());
  }
  function togglePanel(p: string) {
    const next = new Set(picked);
    if (next.has(p)) next.delete(p);
    else next.add(p);
    picked = next;
  }

  function onkeydown(e: KeyboardEvent) {
    if (yieldsToShellModal(e) || isAnnotateChord(e)) return;
    // The keydown that OPENED the picker (e.g. Enter accepting /cross-reference)
    // is still bubbling when this window listener mounts.
    if (e.defaultPrevented) return;
    // The canvas dropdown owns its own keyboard when focused (native arrow/
    // Enter behavior) — only Escape still closes the picker from there.
    if (e.target instanceof HTMLSelectElement && e.key !== "Escape") return;
    if (stage === "figure") {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      } else finder?.handleKey(e);
      return;
    }
    // ---- panels stage ------------------------------------------------------
    if (!fig) return;
    if (e.key === "Escape" || e.key === "Backspace") {
      e.preventDefault();
      e.stopPropagation();
      backToFigures();
    } else if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      e.preventDefault();
      hl = Math.min(fig.panels.length - 1, hl + 1);
    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      e.preventDefault();
      hl = Math.max(0, hl - 1);
    } else if (e.key === " ") {
      e.preventDefault();
      togglePanel(fig.panels[hl]);
    } else if (e.key === "Enter") {
      e.preventDefault();
      onInsert(resultText);
    } else if (/^[a-z0-9]$/.test(e.key)) {
      // Direct toggle: press the panel's own letter. Where panels are sub-numbered
      // (b1..b5) a bare letter cannot name one, so it moves the highlight to that
      // letter's first panel instead of toggling — arrows/space then pick within it.
      const exact = fig.panels.indexOf(e.key);
      if (exact >= 0) {
        e.preventDefault();
        togglePanel(e.key);
        hl = exact;
      } else {
        const first = fig.panels.findIndex((p) => p.startsWith(e.key));
        if (first >= 0) {
          e.preventDefault();
          hl = first;
        }
      }
    }
  }
</script>

<svelte:window {onkeydown} />

<PickerShell title="Reference a figure" {onClose}>
  {#if stage === "figure"}
    <FigureFinder
      bind:this={finder}
      bind:query
      bind:canvas={canvasSel}
      {figures}
      {canvases}
      gridId="figref-grid"
      optionPrefix="figrefopt-"
      note="A reference follows its figure when numbers change."
      onChoose={choose} />
  {:else if fig}
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <div class="panelstage mk-pane" bind:this={panelsEl} tabindex="-1">
      <div class="which">
        <button class="back mk-btn sm" onclick={backToFigures} title="Back to all figures (Esc)"><svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M9.5 3.5 5 8l4.5 4.5" /></svg>Figures</button>
        <span class="ttl mk-clip">{fig.nickname || fig.name}</span>
        <span class="nm hd mk-clip">{fig.display} · @{fig.label}</span>
      </div>
      <div class="pv"><FigureStage figureId={fig.id || null} /></div>
      {#if fig.caption || fig.captionLabel}<p class="cap" title={plainCaption(fig.caption)}><b>{fig.captionLabel.trimEnd()}</b> {plainCaption(fig.caption) || "No caption yet."}</p>{/if}
      <div class="panels">
        <span class="mk-eyebrow">Panels</span>
        <div class="pills mk-letters" role="listbox" aria-label="Panels" aria-multiselectable="true">
          {#each fig.panels as p, i (p)}
            <button
              class="pill mk-letter"
              class:on={picked.has(p)}
              class:hl={i === hl}
              role="option"
              aria-selected={picked.has(p)}
              onclick={() => {
                togglePanel(p);
                hl = i;
              }}>
              {p}
            </button>
          {/each}
        </div>
        {#if picked.size === 0}<span class="whole">none chosen: the whole figure</span>{/if}
      </div>
      <div class="foot mk-foot">
        <span class="keys mk-hint mk-grow"><kbd>a</kbd>–<kbd>z</kbd>panel<span class="sep">·</span><kbd>←</kbd><kbd>→</kbd><kbd>Space</kbd>walk and toggle<span class="sep">·</span><kbd>Esc</kbd>back</span>
        <button class="will mk-btn primary" onclick={() => onInsert(resultText)} title={`Insert ${resultText} (Enter)`}>Insert <b class="chip">{resultDisplay}</b><kbd>↵</kbd></button>
      </div>
    </div>
  {/if}
</PickerShell>

<style>
  .panelstage {
    flex: 0 1 auto;
    height: auto;
    min-height: 0;
    overflow: auto;
    outline: none;
  }
  .which {
    flex: 0 0 auto;
    display: flex;
    align-items: baseline;
    gap: 9px;
    min-width: 0;
  }
  .back {
    align-self: center;
    padding: 0 9px 0 6px;
    gap: 3px;
  }
  .back svg {
    fill: none;
    stroke: currentColor;
    stroke-width: 1.6;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .ttl {
    flex: 0 1 auto;
    min-width: 0;
    font: 600 var(--ts-sm) var(--font-serif);
    color: var(--c-tx-hi, var(--c-tx));
  }
  .nm.hd {
    flex: 1 1 0;
    min-width: 0;
    font: calc(10px * var(--ts-scale, 1)) var(--font-mono);
    color: var(--c-tx-faint);
  }
  /* The same stage as the Figures card, given a fixed share of the picker. */
  .pv {
    flex: 0 0 auto;
    display: flex;
    height: min(46vh, 330px);
  }
  .cap {
    flex: 0 0 auto;
    margin: 0;
    color: var(--c-tx-2);
    font-size: var(--ts-sm);
    line-height: 1.4;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .cap b {
    color: var(--pane-c);
    font-weight: 600;
  }
  .panels {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 9px;
    min-width: 0;
  }
  .whole {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font: italic var(--ts-xs) var(--font-serif);
    color: var(--c-tx-faint);
  }
  .will {
    gap: 7px;
  }
  /* What will be written, as the chip it becomes; the key that does it, on the button. */
  .will .chip {
    font: 600 var(--ts-xs) var(--font-serif);
  }
  .will kbd {
    border-color: color-mix(in oklab, var(--flx-paper) 55%, transparent);
    color: var(--flx-paper);
    background: transparent;
  }
</style>
