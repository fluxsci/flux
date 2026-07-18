<script lang="ts">
  import { get } from "svelte/store";
  import { onMount, getContext } from "svelte";
  import { project, selection, partSelection, activeFigureId, commit, mutate, figureRev, globalRev, lastArrangeRows, duplicateFigure, autoLetterPanels, embeddedProjectRoot } from "./store";
  import { pushToast, errMsg } from "./toast";
  import type { Element, Figure, Project, TextStyle } from "./types";
  import { doAlign, doDistribute, arrangeToRows, selectMatching, copyStyle, pasteStyle } from "./keyboard";
  import { validRowCounts, gridItemCount, balancedRows } from "./geometry";
  import * as ops from "./ops";
  import { exportFigurePng, exportFigureSvg, exportFigurePdf, exportFigureJournal } from "./io";
  import { JOURNAL_PRESETS, DPI_CHOICES, planExport, describeSize, MM_PER_INCH } from "./figure/journalSizing";
  import { applyTextLayout, reflowTexts } from "./text";
  import {
    globalTextStyles,
    loadGlobalTextStyles,
    saveStyleToLibrary,
    applyProjectStyle,
    applyLibraryStyle,
    libraryOnly,
  } from "./textStyles";
  import { plotManifests } from "./plot/store";
  import { buildPartIndex } from "./plot/parse";
  import { partBreadcrumb } from "./plot/partStyle";
  import { fluxFigMenuOpen } from "./settings";
  import ColorPalette from "./ColorPalette.svelte";
  import NumberField from "./NumberField.svelte";

  onMount(() => {
    loadGlobalTextStyles(); // machine-global style library (best-effort)
  });

  // Slide-migration: the shared editing surface, lightly slide-accented. In
  // slide mode the figure-only affordances (physical-mm/true-size readouts,
  // caption/panel-label, the Figure section, exports) are hidden — slide name/
  // background/stage live in the Slide/Deck panels instead. Strictly additive:
  // without the context (figure mode) this renders byte-identically.
  const slideMode = (getContext<"figure" | "slide" | undefined>("flux-editor-mode") ?? "figure") === "slide";

  // Reactive view of the current selection / active figure. Selections CAN
  // span figures (keyboard selectMatching "project" scope), so the scan stays
  // project-wide — but rev-gated (WS-1 Fix 4): it re-runs only when the
  // selection identity or a figure revision changes, not on every notify.
  const selMemoBox = { key: "", val: [] as Element[], sel: null as unknown, selGen: 0, revs: null as unknown, revGen: 0 };
  $: sel = (() => {
    if ($selection !== selMemoBox.sel) {
      selMemoBox.sel = $selection;
      selMemoBox.selGen++;
    }
    if ($figureRev !== selMemoBox.revs) {
      selMemoBox.revs = $figureRev;
      selMemoBox.revGen++;
    }
    const key = `${selMemoBox.selGen}|${selMemoBox.revGen}|${$globalRev}`;
    if (key === selMemoBox.key) return selMemoBox.val;
    const out: Element[] = [];
    for (const f of $project.figures)
      for (const e of f.elements) if ($selection.has(e.id)) out.push(e);
    selMemoBox.key = key;
    selMemoBox.val = out;
    return out;
  })();
  $: single = sel.length === 1 ? sel[0] : null;
  $: fig = $project.figures.find((f) => f.id === $activeFigureId) ?? null;

  // Physical-size truth (canvas px are 96/inch): the mm readout under W/H, and a
  // reset back to an asset's true physical size after a manual/legacy rescale.
  // For a CROPPED element (P5) the reference is the crop WINDOW's intrinsic
  // dims (crop px are assetDisplaySize units, i.e. already physical): "true
  // size" means the visible window renders 1:1, not the full content.
  const mmStr = (px: number) => ((px / 96) * MM_PER_INCH).toFixed(1);
  $: physSize = single && "assetId" in single ? ops.assetDisplaySize($project, single.assetId) : null;
  $: elCrop = single && (single.type === "image" || single.type === "plot") ? (single.crop ?? null) : null;
  $: physRef = elCrop ? { width: elCrop.width, height: elCrop.height } : physSize;
  $: atPhys =
    !!physRef &&
    !!single &&
    "width" in single &&
    Math.abs(single.width - physRef.width) < 0.5 &&
    Math.abs(single.height - physRef.height) < 0.5;
  function resetToPhysical() {
    const ps = physRef;
    if (!ps) return;
    updateSelected((el) => {
      if ("width" in el && "height" in el) {
        el.width = ps.width;
        el.height = ps.height;
      }
    });
  }
  // Remove the crop: the box returns to the FULL content at its current
  // content scale (ops.setCrop null — the gesture's inverse, content pinned).
  function resetCrop() {
    const id = single?.id;
    if (!id) return;
    commit((p) => ops.setCrop(p, id, null));
  }

  // Lock / hide state across the selection (F6): all-on drives the checkbox,
  // some-on shows the indeterminate dash.
  $: anyLocked = sel.some((e) => e.locked);
  $: allLocked = sel.length > 0 && sel.every((e) => e.locked);
  $: anyHidden = sel.some((e) => e.hidden);
  $: allHidden = sel.length > 0 && sel.every((e) => e.hidden);

  // Arrange controls (mouse equivalents of the Alt+G grid mode). `arrN` is the
  // number of layout cells (a group counts once); the section hides below 2.
  $: arrN = sel.length >= 2 ? gridItemCount(sel) : 0;
  // Exact-gap distribute (Feature 7): the gutter applied by the Gap H/V buttons.
  let gapVal = 24;
  // Proportional scale (Feature 5): one-shot "scale by %" of the selection.
  let scalePct = 100;
  function applyScale() {
    const ids = [...$selection];
    if (!ids.length || !(scalePct > 0)) return;
    commit((p) => ops.scaleElements(p, ids, scalePct / 100));
  }
  function stepRows(d: number) {
    const v = validRowCounts(arrN);
    let i = v.indexOf(get(lastArrangeRows));
    if (i < 0) i = 0;
    arrangeToRows(v[Math.max(0, Math.min(v.length - 1, i + d))]);
  }

  // --- selected plot part (role/identity from the manifest) ---
  $: plotEl = (() => {
    const ps = $partSelection;
    if (!ps) return null;
    for (const f of $project.figures)
      for (const e of f.elements) if (e.id === ps.elementId && e.type === "plot") return e;
    return null;
  })();
  $: partInfo = (() => {
    const ps = $partSelection;
    if (!ps || !plotEl || plotEl.type !== "plot") return null;
    const idx = buildPartIndex($plotManifests[plotEl.assetId]);
    return idx[ps.partId] ?? { id: ps.partId, role: "part" };
  })();
  // Display label: the extended part index's human label, a composed
  // role · series · #index for data entries, the raw id last.
  $: partLabel = partInfo
    ? (partInfo.label ??
      ([partInfo.role, partInfo.series, partInfo.index !== undefined ? `#${partInfo.index}` : null]
        .filter(Boolean)
        .join(" · ") ||
        partInfo.id))
    : "";
  // Hierarchy breadcrumb (parts-tree root → this part); empty without a tree.
  $: partCrumb =
    plotEl && plotEl.type === "plot" && $partSelection
      ? partBreadcrumb($plotManifests[plotEl.assetId], $partSelection.partId).join(" › ")
      : "";

  // Panel-label (caption) state across the selected text elements.
  $: textSel = sel.filter((e) => e.type === "text");
  $: labelAllOn = textSel.length > 0 && textSel.every((e) => e.type === "text" && e.panelLabel);
  $: labelMixed = textSel.some((e) => e.type === "text" && e.panelLabel) && !labelAllOn;

  function setPanelLabel(on: boolean) {
    updateSelected((el) => {
      if (el.type === "text") el.panelLabel = on;
    });
  }

  let dpi = 300;
  // Export pending state: a journal TIFF at 600–1200 dpi runs getImageData + a
  // synchronous encode on the UI thread for seconds. Disable all export buttons
  // while one runs (no double-submit) and label the running one "Exporting…".
  let exporting: string | null = null;
  async function runExport(kind: string, fn: (f: Figure) => Promise<void>) {
    const target = fig;
    if (!target || exporting) return;
    exporting = kind;
    try {
      await fn(target);
    } finally {
      exporting = null;
    }
  }
  // 3.1 journal-spec export: physical width (mm) + dpi + transparency.
  let widthPresetId = "double"; // matches JOURNAL_PRESETS Generic → double (190 mm)
  let customMm = 90;
  let journalDpi = 300;
  let transparentBg = false;
  const ALL_WIDTHS = JOURNAL_PRESETS.flatMap((g) => g.widths);
  $: selectedMm = widthPresetId === "custom" ? Math.max(1, customMm) : (ALL_WIDTHS.find((w) => w.id === widthPresetId)?.mm ?? 190);
  $: journalPlan = fig ? planExport(fig.width, fig.height, selectedMm, journalDpi) : null;

  function updateSelected(fn: (e: Element, p: Project) => void) {
    const ids = get(selection);
    commit((p) => {
      for (const f of p.figures)
        for (const e of f.elements)
          if (ids.has(e.id)) {
            fn(e, p);
            applyTextLayout(e);
          }
    });
  }
  function updateFigure(fn: (f: typeof fig & {}) => void) {
    const id = get(activeFigureId);
    commit((p) => {
      const f = p.figures.find((ff) => ff.id === id);
      if (f) fn(f);
    });
  }

  // Scrub setters mirror updateSelected/updateFigure but use `mutate` (no new
  // history entry): the scrub action already opened ONE beginGesture for the whole
  // drag, so a scrub is a single undo (Feature 8).
  function scrubSelected(fn: (e: Element, p: Project) => void) {
    const ids = get(selection);
    mutate((p) => {
      for (const f of p.figures)
        for (const e of f.elements)
          if (ids.has(e.id)) {
            fn(e, p);
            applyTextLayout(e);
          }
    });
  }
  function scrubFigure(fn: (f: typeof fig & {}) => void) {
    const id = get(activeFigureId);
    mutate((p) => {
      const f = p.figures.find((ff) => ff.id === id);
      if (f) fn(f);
    });
  }

  // Aspect-lock-aware W/H setter (shared with the FluxFig menu) — ops.setBoxDim.
  const setDim = ops.setBoxDim;

  // --- text styling (B/I/U, sizing mode, named styles) ---
  function toggleSelText(which: ops.TextToggle) {
    const list = [...get(selection)];
    if (!list.length) return;
    commit((p) => {
      ops.toggleTextStyle(p, list, which);
      reflowTexts(p, list);
    });
  }
  function setSizing(mode: "auto" | "auto-h" | "fixed") {
    updateSelected((el) => {
      if (el.type === "text") el.sizing = mode;
    });
  }

  // Named styles: project list from the model; the machine-global library on
  // top (project copies win — copy-on-apply). The ⚙ popover manages them.
  $: projStyles = $project.textStyles ?? [];
  $: libStyles = libraryOnly($project.textStyles, $globalTextStyles);
  let stylePopover = false;
  $: linkedStyleId = single && single.type === "text" ? (single.styleId ?? "") : "";

  function newStyleFromSelection() {
    if (!single || single.type !== "text") return;
    const id = single.id;
    const name = `Style ${(get(project).textStyles?.length ?? 0) + 1}`;
    commit((p) => {
      ops.textStyleFromElement(p, id, name);
    });
    stylePopover = true; // land in the manager so it can be renamed right away
  }
  function onStyleSelect(e: { currentTarget: HTMLSelectElement }) {
    const v = e.currentTarget.value;
    const ids = [...get(selection)];
    if (v === "__new__") {
      newStyleFromSelection();
      return;
    }
    if (v === "") {
      // back to None: keep the current look, drop the link
      updateSelected((el) => {
        if (el.type === "text") delete el.styleId;
      });
      return;
    }
    if (v.startsWith("lib:")) {
      const st = $globalTextStyles.find((s) => s.id === v.slice(4));
      if (st) applyLibraryStyle(ids, st); // copy-on-apply
      return;
    }
    applyProjectStyle(ids, v);
  }
  function styleRename(st: TextStyle, name: string) {
    if (!name.trim() || name === st.name) return;
    commit((p) => ops.renameTextStyle(p, st.id, name.trim()));
  }
  function styleUpdateFromSelection(st: TextStyle) {
    if (!single || single.type !== "text") return;
    const el = single;
    commit((p) => {
      ops.updateTextStyle(p, st.id, {
        fontFamily: el.fontFamily,
        fontSize: el.fontSize,
        fontWeight: el.fontWeight,
        fontStyle: el.fontStyle,
        underline: el.underline,
        lineHeight: el.lineHeight,
        color: el.color,
        align: el.align,
      });
      reflowTexts(p, p.figures.flatMap((f) => f.elements.filter((x) => x.type === "text" && x.styleId === st.id).map((x) => x.id)));
    });
  }
  function styleApply(st: TextStyle) {
    applyProjectStyle([...get(selection)], st.id);
  }
  function styleDelete(st: TextStyle) {
    commit((p) => ops.deleteTextStyle(p, st.id));
  }
  async function styleToLibrary(st: TextStyle) {
    await saveStyleToLibrary(st);
  }

  // --- Send to deck (slide-migration §3.9) — figure mode only; slide mode is
  // never resident then (tenancy), so the disk-level deck write cannot race.
  let sendDeckOpen = false;
  let sendDecks: { id: string; title: string }[] = [];
  async function openSendToDeck() {
    const root = get(embeddedProjectRoot);
    if (!root) return;
    try {
      const convert = await import("./project/convert"); // lazy: keep the deck bridge out of figure-mode startup
      sendDecks = await convert.listProjectDecks(root);
      sendDeckOpen = true;
    } catch (e) {
      pushToast("error", "Couldn't list decks", { detail: errMsg(e) });
    }
  }
  async function doSendToDeck(deckId: string | null) {
    sendDeckOpen = false;
    const root = get(embeddedProjectRoot);
    const f = fig;
    if (!root || !f) return;
    try {
      const convert = await import("./project/convert");
      const res = await convert.sendFigureToDeck(root, f, deckId);
      pushToast("info", `Sent "${f.name}" to deck "${res.title}"`, {
        detail: "Added as a new slide (native size — slides share the figure ruler).",
      });
    } catch (e) {
      pushToast("error", "Couldn't send to deck", { detail: errMsg(e) });
    }
  }

  // --- content scale (plot): the K tool's persisted geometric factor.
  // Plain resize keeps text/strokes pt-true; this is the explicit escape hatch.
  function setContentScale(v: number) {
    updateSelected((el) => {
      if (el.type === "plot") el.contentScale = Math.max(0.01, v);
    });
  }
  function resetContentScale() {
    updateSelected((el) => {
      if (el.type === "plot") delete el.contentScale;
    });
  }
</script>

<aside class="inspector">
  <!-- ALIGN -->
  <section>
    <h4>Align</h4>
    {#if sel.length === 0}
      <p class="note">Select elements to edit</p>
    {/if}
    <div class="grid6">
      <button title="Left (Alt+A)" aria-label="Align left" disabled={sel.length < 2} on:click={() => doAlign("left")}>⊢</button>
      <button title="Center H (Alt+H)" aria-label="Align horizontal centers" disabled={sel.length < 2} on:click={() => doAlign("centerH")}>↔</button>
      <button title="Right (Alt+D)" aria-label="Align right" disabled={sel.length < 2} on:click={() => doAlign("right")}>⊣</button>
      <button title="Top (Alt+W)" aria-label="Align top" disabled={sel.length < 2} on:click={() => doAlign("top")}>⊤</button>
      <button title="Middle V (Alt+V)" aria-label="Align vertical middles" disabled={sel.length < 2} on:click={() => doAlign("centerV")}>↕</button>
      <button title="Bottom (Alt+S)" aria-label="Align bottom" disabled={sel.length < 2} on:click={() => doAlign("bottom")}>⊥</button>
    </div>
    <div class="row">
      <button disabled={sel.length < 2} on:click={() => doDistribute("h")}>Distribute H</button>
      <button disabled={sel.length < 2} on:click={() => doDistribute("v")}>Distribute V</button>
    </div>
    {#if sel.length >= 2}
      <div class="row gaprow">
        <NumberField label="Gap" value={gapVal} min={0}
          on:commit={(e) => (gapVal = e.detail)}
          on:scrub={(e) => (gapVal = e.detail)} />
        <button title="Exact gap horizontally" on:click={() => doDistribute("h", gapVal)}>Gap H</button>
        <button title="Exact gap vertically" on:click={() => doDistribute("v", gapVal)}>Gap V</button>
      </div>
    {/if}
    {#if sel.length >= 1}
      <div class="row gaprow">
        <NumberField label="Scale %" value={scalePct} min={1}
          on:commit={(e) => (scalePct = e.detail)}
          on:scrub={(e) => (scalePct = e.detail)} />
        <button title="Scale proportionally (geometry + stroke/font) about the selection centre" on:click={applyScale}>Apply</button>
      </div>
    {/if}
  </section>

  <!-- SELECT SAME / STYLE (F9 + F10) -->
  {#if sel.length >= 1}
    <section>
      <h4>Select &amp; style</h4>
      {#if single}
        <div class="row" style="flex-wrap:wrap;gap:4px;">
          <span style="opacity:.6;font-size:11px;width:100%;">Select same…</span>
          <button title="Select all with the same fill (Cmd/Ctrl+Alt+A)" on:click={() => selectMatching("fill")}>Fill</button>
          <button title="Select all with the same stroke" on:click={() => selectMatching("stroke")}>Stroke</button>
          <button title="Select all with the same font" on:click={() => selectMatching("font")}>Font</button>
          <button title="Select all of the same type" on:click={() => selectMatching("type")}>Type</button>
        </div>
      {/if}
      <div class="row">
        <button title="Copy style (Cmd/Ctrl+Alt+C)" disabled={!single} on:click={copyStyle}>Copy style</button>
        <button title="Paste style (Cmd/Ctrl+Alt+V)" on:click={pasteStyle}>Paste style</button>
      </div>
    </section>
  {/if}

  <!-- ARRANGE -->
  {#if arrN >= 2}
    <section>
      <h4 style="display:flex;align-items:baseline;">Arrange <span class="hk">Alt+G</span></h4>
      <div class="grid6">
        <button title="Single row" on:click={() => arrangeToRows(1)}>Row</button>
        <button title="Balanced grid" on:click={() => arrangeToRows(balancedRows(arrN))}>Grid</button>
        <button title="Single column" on:click={() => arrangeToRows(arrN)}>Column</button>
      </div>
      <div class="row" style="align-items:center;gap:8px;">
        <span style="opacity:.6;font-size:11px;">Rows</span>
        <button title="Fewer rows" on:click={() => stepRows(-1)}>−</button>
        <span style="min-width:18px;text-align:center;font-variant-numeric:tabular-nums;">{$lastArrangeRows}</span>
        <button title="More rows" on:click={() => stepRows(1)}>+</button>
      </div>
    </section>
  {/if}

  <!-- SELECTED PLOT PART -->
  {#if partInfo}
    <section class="part">
      <h4>Plot part</h4>
      <div class="part-id">{partLabel}</div>
      {#if partCrumb}
        <p class="crumb">{partCrumb}</p>
      {/if}
      {#if partInfo.x !== undefined && partInfo.y !== undefined}
        <p class="note">data: x = {partInfo.x}, y = {partInfo.y}</p>
      {/if}
      <button class="fig-act" title="Open the property menu for this part (f)" on:click={() => fluxFigMenuOpen.set(true)}>Show properties</button>
      <p class="note">edits write override <code>{partInfo.id}</code> — they survive regeneration</p>
    </section>
  {/if}

  <!-- POSITION / SIZE -->
  {#if single}
    <section>
      <h4>{single.type}</h4>
      <div class="row">
        <NumberField label="X" value={single.x}
          on:commit={(e) => updateSelected((el) => (el.x = e.detail))}
          on:scrub={(e) => scrubSelected((el) => (el.x = e.detail))} />
        <NumberField label="Y" value={single.y}
          on:commit={(e) => updateSelected((el) => (el.y = e.detail))}
          on:scrub={(e) => scrubSelected((el) => (el.y = e.detail))} />
      </div>
      {#if "width" in single && single.type !== "line"}
        <div class="row wh">
          <NumberField label="W" value={single.width} min={1}
            on:commit={(e) => updateSelected((el) => setDim(el, "w", e.detail))}
            on:scrub={(e) => scrubSelected((el) => setDim(el, "w", e.detail))} />
          <button
            class="ratio"
            class:on={single.lockAspect}
            title={single.lockAspect ? "Unlock aspect ratio" : "Lock aspect ratio (constrain proportions)"}
            aria-label="Lock aspect ratio"
            on:click={() => updateSelected((el) => (el.lockAspect = !el.lockAspect))}
          >
            {#if single.lockAspect}
              <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M6.6 9.4a2.4 2.4 0 0 1 0-3.4l1.4-1.4a2.4 2.4 0 1 1 3.4 3.4l-.9.9" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" /><path d="M9.4 6.6a2.4 2.4 0 0 1 0 3.4l-1.4 1.4a2.4 2.4 0 1 1-3.4-3.4l.9-.9" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" /></svg>
            {:else}
              <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M6.6 9.4a2.4 2.4 0 0 1 0-3.4l1-1" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" /><path d="M9.4 6.6a2.4 2.4 0 0 1 0 3.4l-1 1" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" /></svg>
            {/if}
          </button>
          <NumberField label="H" value={single.height} min={1}
            on:commit={(e) => updateSelected((el) => setDim(el, "h", e.detail))}
            on:scrub={(e) => scrubSelected((el) => setDim(el, "h", e.detail))} />
        </div>
        {#if !slideMode}
          <!-- Physical units stay hidden in slide mode: a slide shares the 96/in
               ruler but has no FIXED physical size (it projects at any scale). -->
          <p class="note phys">
            {mmStr(single.width)} × {mmStr(single.height)} mm
            {#if physRef && !atPhys}
              <span class="off-phys">· {Math.round((single.width / physRef.width) * 100)}% of true size</span>
              <button class="true-size" title="Reset to the {elCrop ? 'crop window' : 'source'}'s true physical size ({mmStr(physRef.width)} × {mmStr(physRef.height)} mm)" on:click={resetToPhysical}>True size</button>
            {/if}
          </p>
        {/if}
        {#if elCrop && physSize}
          <p class="note phys">
            {#if slideMode}cropped{:else}cropped from {mmStr(physSize.width)} × {mmStr(physSize.height)} mm{/if}
            <button class="true-size" title="Remove the crop — show the full content at its current scale" on:click={resetCrop}>Reset crop</button>
          </p>
        {/if}
        {#if single.type === "plot"}
          <!-- The K/Scale tool's persisted geometric factor: plain resize keeps
               text/strokes pt-true; content scale multiplies glyphs + strokes. -->
          <div class="row wh">
            <NumberField label="Content scale" value={single.contentScale ?? 1} min={0.01} step={0.05}
              title="Geometric scale of the plot's text/strokes (the K tool writes this; 1 = true point sizes)"
              on:commit={(e) => setContentScale(e.detail)}
              on:scrub={(e) => scrubSelected((el) => { if (el.type === "plot") el.contentScale = Math.max(0.01, e.detail); })} />
            {#if (single.contentScale ?? 1) !== 1}
              <button class="true-size" title="Reset content scale to 1 (true point sizes)" on:click={resetContentScale}>1×</button>
            {/if}
          </div>
        {/if}
      {/if}
      <div class="row">
        <NumberField label="Rotation°" value={single.rotation} step={1}
          on:commit={(e) => updateSelected((el) => (el.rotation = e.detail))}
          on:scrub={(e) => scrubSelected((el) => (el.rotation = e.detail))} />
        <NumberField label="Opacity" value={single.opacity ?? 1} step={0.05} min={0} max={1}
          on:commit={(e) => updateSelected((el) => (el.opacity = e.detail))}
          on:scrub={(e) => scrubSelected((el) => (el.opacity = e.detail))} />
      </div>
    </section>
  {:else if sel.length > 1}
    <section><h4>{sel.length} selected</h4></section>
  {/if}

  <!-- LOCK / HIDE (F6) -->
  {#if sel.length >= 1}
    <section>
      <div class="row" style="gap:14px;">
        <label class="chk">
          <input
            type="checkbox"
            checked={allLocked}
            indeterminate={anyLocked && !allLocked}
            on:change={(e) => updateSelected((el) => (el.locked = e.currentTarget.checked))} />
          Lock <span class="hk">⌘⇧L</span>
        </label>
        <label class="chk">
          <input
            type="checkbox"
            checked={allHidden}
            indeterminate={anyHidden && !allHidden}
            on:change={(e) => updateSelected((el) => (el.hidden = e.currentTarget.checked))} />
          Hide
        </label>
      </div>
    </section>
  {/if}

  <!-- TYPE-SPECIFIC STYLE -->
  {#if single && single.type === "text"}
    <section>
      <h4>Text</h4>
      <textarea
        rows="3"
        value={single.text}
        on:input={(e) => updateSelected((el) => { if (el.type === "text") el.text = e.currentTarget.value; })}
      ></textarea>
      <label class="full">Style
        <span class="stylerow">
          <select value={linkedStyleId} on:change={onStyleSelect} aria-label="Text style">
            <option value="">— None —</option>
            {#if projStyles.length}
              <optgroup label="Project">
                {#each projStyles as st (st.id)}<option value={st.id}>{st.name}</option>{/each}
              </optgroup>
            {/if}
            {#if libStyles.length}
              <optgroup label="Library">
                {#each libStyles as st (st.id)}<option value={"lib:" + st.id}>{st.name}</option>{/each}
              </optgroup>
            {/if}
            <option value="__new__">New from selection…</option>
          </select>
          <button class="gear" title="Manage text styles" aria-label="Manage text styles" on:click={() => (stylePopover = !stylePopover)}>⚙</button>
        </span>
      </label>
      {#if stylePopover}
        <div class="style-pop">
          {#each projStyles as st (st.id)}
            <div class="style-row">
              <input class="sname" value={st.name} title="Rename" on:change={(e) => styleRename(st, e.currentTarget.value)} />
              <button title="Apply to selection" on:click={() => styleApply(st)}>Apply</button>
              <button title="Update this style from the selected text (re-applies to every linked text)" on:click={() => styleUpdateFromSelection(st)}>Update</button>
              <button title="Save to the machine-global library" on:click={() => styleToLibrary(st)}>→ Lib</button>
              <button title="Delete (linked texts keep their look)" on:click={() => styleDelete(st)}>✕</button>
            </div>
          {/each}
          {#if !projStyles.length}<p class="note">No project styles yet.</p>{/if}
          <button class="fig-act" on:click={newStyleFromSelection}>New from selection…</button>
        </div>
      {/if}
      <div class="row">
        <!-- Font size is EDITED IN POINTS (1 pt = 1/72 in — the unit journal specs use;
             type 7 → true 7 pt in print) but STORED in canvas px (1/96 in): px = pt × 4/3.
             Storage is untouched so old documents render identically. -->
        <NumberField label="Size (pt)" value={single.fontSize * 0.75} min={1} step={0.5}
          title="Font size in points, as printed (journals typically want 5–8 pt)"
          on:commit={(e) => updateSelected((el, p) => { if (el.type === "text") { el.fontSize = e.detail * (4 / 3); ops.detachOnManualEdit(p, el, ["fontSize"]); } })}
          on:scrub={(e) => scrubSelected((el, p) => { if (el.type === "text") { el.fontSize = e.detail * (4 / 3); ops.detachOnManualEdit(p, el, ["fontSize"]); } })} />
        <label>Weight
          <select value={single.fontWeight} on:change={(e) => updateSelected((el, p) => { if (el.type === "text") { el.fontWeight = parseInt(e.currentTarget.value); ops.detachOnManualEdit(p, el, ["fontWeight"]); } })}>
            <option value="400">Regular</option>
            <option value="700">Bold</option>
          </select>
        </label>
      </div>
      <div class="row">
        <label>Font
          <select value={single.fontFamily} on:change={(e) => updateSelected((el, p) => { if (el.type === "text") { el.fontFamily = e.currentTarget.value; ops.detachOnManualEdit(p, el, ["fontFamily"]); } })}>
            <option>Arial</option><option>Helvetica</option><option>Times New Roman</option>
            <option>Georgia</option><option>Courier New</option><option>Verdana</option>
          </select>
        </label>
        <label>Align
          <select value={single.align} on:change={(e) => updateSelected((el, p) => { if (el.type === "text") { el.align = e.currentTarget.value as "left" | "center" | "right"; ops.detachOnManualEdit(p, el, ["align"]); } })}>
            <option value="left">Left</option><option value="center">Center</option><option value="right">Right</option>
          </select>
        </label>
      </div>
      <div class="row biu-row">
        <button class="biu" aria-pressed={single.fontWeight >= 600} title="Bold (Ctrl+B)" on:click={() => toggleSelText("bold")}><b>B</b></button>
        <button class="biu" aria-pressed={single.fontStyle === "italic"} title="Italic (Ctrl+I)" on:click={() => toggleSelText("italic")}><i>I</i></button>
        <button class="biu" aria-pressed={!!single.underline} title="Underline (Ctrl+U)" on:click={() => toggleSelText("underline")}><u>U</u></button>
        <NumberField label="Line height" value={single.lineHeight ?? 1.2} min={0.5} step={0.05}
          title="Line height as a multiple of the font size"
          on:commit={(e) => updateSelected((el, p) => { if (el.type === "text") { el.lineHeight = e.detail; ops.detachOnManualEdit(p, el, ["lineHeight"]); } })}
          on:scrub={(e) => scrubSelected((el, p) => { if (el.type === "text") { el.lineHeight = e.detail; ops.detachOnManualEdit(p, el, ["lineHeight"]); } })} />
      </div>
      <!-- Sizing: Auto = hug (no wrap) · Auto H = wrap at width, height hugs · Fixed = box pinned -->
      <div class="seg" role="group" aria-label="Text sizing">
        <button class:on={single.sizing === "auto"} title="Box hugs the text (no wrapping)" on:click={() => setSizing("auto")}>Auto</button>
        <button class:on={single.sizing === "auto-h"} title="Wrap at the box width; height hugs" on:click={() => setSizing("auto-h")}>Auto H</button>
        <button class:on={single.sizing === "fixed"} title="Fixed box (overflow renders unclipped)" on:click={() => setSizing("fixed")}>Fixed</button>
      </div>
    </section>
  {/if}

  <!-- PANEL LABEL (caption) — figure-only (captions belong to paper figures) -->
  {#if textSel.length > 0 && !slideMode}
    <section>
      <h4>Caption</h4>
      <label class="chk">
        <input
          type="checkbox"
          checked={labelAllOn}
          indeterminate={labelMixed}
          on:change={(e) => setPanelLabel(e.currentTarget.checked)}
        />
        Panel label <span class="hk">Alt+L</span>
      </label>
      <p class="note">Marked text becomes a block in the caption editor (Alt+C).</p>
    </section>
  {/if}

  {#if single && (single.type === "rect" || single.type === "ellipse" || single.type === "line" || single.type === "path")}
    <section>
      <h4>Stroke / fill</h4>
      <div class="row">
        <NumberField label="Stroke W" value={single.strokeWidth} min={0} step={0.5}
          on:commit={(e) => updateSelected((el) => { if ("strokeWidth" in el) el.strokeWidth = e.detail; })}
          on:scrub={(e) => scrubSelected((el) => { if ("strokeWidth" in el) el.strokeWidth = e.detail; })} />
        {#if single.type === "rect"}
          <NumberField label="Radius" value={single.cornerRadius} min={0}
            on:commit={(e) => updateSelected((el) => { if (el.type === "rect") el.cornerRadius = e.detail; })}
            on:scrub={(e) => scrubSelected((el) => { if (el.type === "rect") el.cornerRadius = e.detail; })} />
        {/if}
      </div>
      <!-- Dash: [len, gap] in canvas px on any stroked primitive; unchecking
           returns to solid (property deleted via ops.setElementStyle's rules). -->
      <div class="row">
        <label class="chk"><input type="checkbox" checked={!!single.dash?.length} on:change={(e) => { const on = e.currentTarget.checked; const ids = [...$selection]; commit((p) => ops.setElementStyle(p, ids, { dash: on ? [6, 4] : [] })); }} />Dashed</label>
        {#if single.dash?.length}
          <NumberField label="Dash" value={single.dash[0] ?? 6} min={0.5} step={0.5}
            on:commit={(e) => { const gap = single.dash?.[1] ?? 4; const ids = [...$selection]; commit((p) => ops.setElementStyle(p, ids, { dash: [e.detail, gap] })); }} />
          <NumberField label="Gap" value={single.dash[1] ?? 4} min={0.5} step={0.5}
            on:commit={(e) => { const len = single.dash?.[0] ?? 6; const ids = [...$selection]; commit((p) => ops.setElementStyle(p, ids, { dash: [len, e.detail] })); }} />
        {/if}
      </div>
      {#if single.type === "line"}
        <div class="row">
          <label class="chk"><input type="checkbox" checked={single.arrowStart} on:change={(e) => updateSelected((el) => { if (el.type === "line") el.arrowStart = e.currentTarget.checked; })} />Arrow start</label>
          <label class="chk"><input type="checkbox" checked={single.arrowEnd} on:change={(e) => updateSelected((el) => { if (el.type === "line") el.arrowEnd = e.currentTarget.checked; })} />Arrow end</label>
        </div>
      {/if}
      {#if single.type === "path"}
        <!-- Close/open after the fact (pen-time closing = clicking the first
             node). Goes through ops.updatePath: adopts legacy d-only paths
             into nodes, regenerates d, refits the bbox. -->
        <div class="row">
          <label class="chk"><input type="checkbox" checked={single.closed} on:change={(e) => { const closed = e.currentTarget.checked; const id = single.id; commit((p) => ops.updatePath(p, id, { closed })); }} />Closed path</label>
        </div>
        {#if !single.closed}
          <!-- Arrowheads on open paths — same semantics as lines. -->
          <div class="row">
            <label class="chk"><input type="checkbox" checked={!!single.arrowStart} on:change={(e) => updateSelected((el) => { if (el.type === "path") el.arrowStart = e.currentTarget.checked; })} />Arrow start</label>
            <label class="chk"><input type="checkbox" checked={!!single.arrowEnd} on:change={(e) => updateSelected((el) => { if (el.type === "path") el.arrowEnd = e.currentTarget.checked; })} />Arrow end</label>
          </div>
        {/if}
      {/if}
    </section>
  {/if}

  <!-- COLOR PALETTE -->
  <ColorPalette />

  <!-- FIGURE (+ exports) — figure-only: slide name/background are edited in
       the Slide panel, the stage in the Deck panel, and a deck exports as a
       presentation (.html), never as a per-frame raster. -->
  {#if fig && !slideMode}
    <section>
      <h4>Figure</h4>
      <label class="full">Name<input value={fig.name} on:change={(e) => updateFigure((f) => (f.name = e.currentTarget.value))} /></label>
      <div class="row">
        <NumberField label="X" value={fig.x}
          on:commit={(e) => updateFigure((f) => (f.x = e.detail))}
          on:scrub={(e) => scrubFigure((f) => (f.x = e.detail))} />
        <NumberField label="Y" value={fig.y}
          on:commit={(e) => updateFigure((f) => (f.y = e.detail))}
          on:scrub={(e) => scrubFigure((f) => (f.y = e.detail))} />
      </div>
      <div class="row">
        <NumberField label="W" value={fig.width} min={1}
          on:commit={(e) => updateFigure((f) => (f.width = e.detail))}
          on:scrub={(e) => scrubFigure((f) => (f.width = e.detail))} />
        <NumberField label="H" value={fig.height} min={1}
          on:commit={(e) => updateFigure((f) => (f.height = e.detail))}
          on:scrub={(e) => scrubFigure((f) => (f.height = e.detail))} />
      </div>
      <p class="note">= {mmStr(fig.width)} × {mmStr(fig.height)} mm</p>
      <label class="full">Background
        <input type="color" value={fig.background === "transparent" ? "#ffffff" : fig.background} on:change={(e) => updateFigure((f) => (f.background = e.currentTarget.value))} />
      </label>
      <button class="fig-act" on:click={() => duplicateFigure(fig.id)}>Duplicate figure</button>
      <button class="fig-act" on:click={() => autoLetterPanels(fig.id)}>Auto-letter panels (a, b, c)</button>
      {#if $embeddedProjectRoot}
        <!-- Send to deck (slide-migration §3.9): copy this figure's content to a
             deck as a new slide (fresh ids, native size — the shared 96/in ruler). -->
        <button class="fig-act" on:click={openSendToDeck} title="Copy this figure's content to a slide deck (a new slide; native size)">Send to deck…</button>
        {#if sendDeckOpen}
          <div class="style-pop">
            {#each sendDecks as d (d.id)}
              <div class="style-row"><button style="flex:1;text-align:left" on:click={() => doSendToDeck(d.id)}>{d.title}</button></div>
            {/each}
            <div class="style-row"><button style="flex:1;text-align:left" on:click={() => doSendToDeck(null)}>+ New deck</button></div>
            <div class="style-row"><button style="flex:1;text-align:left;opacity:.6" on:click={() => (sendDeckOpen = false)}>Cancel</button></div>
          </div>
        {/if}
      {/if}
    </section>

    <!-- EXPORT -->
    <section>
      <h4>Export “{fig.name}”</h4>
      <div class="row">
        <button disabled={!!exporting} on:click={() => runExport("png", (f) => exportFigurePng(f, dpi / 96))} title="Quick PNG at {dpi} dpi (design px × {(dpi / 96).toFixed(1)})">{exporting === "png" ? "Exporting…" : "PNG"}</button>
        <button disabled={!!exporting} on:click={() => runExport("svg", (f) => exportFigureSvg(f))} title="Vector SVG">{exporting === "svg" ? "Exporting…" : "SVG"}</button>
        <button disabled={!!exporting} on:click={() => runExport("pdf", (f) => exportFigurePdf(f))} title="Vector PDF">{exporting === "pdf" ? "Exporting…" : "PDF"}</button>
      </div>

      <h4 class="sub">Journal-spec raster</h4>
      <label class="full">Width
        <select bind:value={widthPresetId}>
          {#each JOURNAL_PRESETS as g}
            <optgroup label={g.family}>
              {#each g.widths as w}<option value={w.id}>{w.label}</option>{/each}
            </optgroup>
          {/each}
          <option value="custom">Custom…</option>
        </select>
      </label>
      {#if widthPresetId === "custom"}
        <label class="full">Width (mm)
          <input type="number" min="1" step="1" bind:value={customMm} />
        </label>
      {/if}
      <label class="full">Resolution
        <select bind:value={journalDpi}>
          {#each DPI_CHOICES as d}<option value={d}>{d} dpi</option>{/each}
        </select>
      </label>
      <label class="chk"><input type="checkbox" bind:checked={transparentBg} /> Transparent background</label>
      {#if journalPlan}
        <p class="sizeread">{describeSize(journalPlan.pxWidth, journalPlan.pxHeight, journalDpi)} · {journalPlan.pxWidth}×{journalPlan.pxHeight} px</p>
      {/if}
      <div class="row">
        <button class="prim" disabled={!!exporting} on:click={() => runExport("tiff", (f) => exportFigureJournal(f, { format: "tiff", mm: selectedMm, dpi: journalDpi, transparent: transparentBg }))}>{exporting === "tiff" ? "Exporting…" : "TIFF"}</button>
        <button class="prim" disabled={!!exporting} on:click={() => runExport("jpng", (f) => exportFigureJournal(f, { format: "png", mm: selectedMm, dpi: journalDpi, transparent: transparentBg }))}>{exporting === "jpng" ? "Exporting…" : "PNG"}</button>
      </div>
    </section>
  {/if}
</aside>

<style>
  .inspector {
    width: 248px;
    background: var(--c-surface);
    border-left: 1px solid var(--c-line);
    overflow-y: auto;
    padding: 4px 10px 24px;
    font-size: 12px;
    color: var(--c-tx);
  }
  section {
    padding: 10px 0;
    border-bottom: 1px solid var(--c-line);
  }
  h4 {
    margin: 0 0 8px;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    opacity: 0.6;
  }
  h4.sub {
    margin-top: 12px;
    font-size: 10px;
  }
  .sizeread {
    margin: 2px 0 6px;
    font-size: 10px;
    font-family: var(--font-mono);
    opacity: 0.6;
  }
  button.prim {
    background: var(--c-accent);
    border-color: var(--c-accent);
    color: var(--c-on-accent);
  }
  .row {
    display: flex;
    gap: 6px;
    margin-bottom: 6px;
  }
  .row.wh {
    align-items: flex-end;
  }
  .ratio {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 5px;
    color: var(--c-tx-muted);
    line-height: 1;
  }
  .ratio.on {
    color: var(--c-on-accent);
    background: var(--c-accent);
    border-color: var(--c-accent);
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 3px;
    flex: 1;
    opacity: 0.85;
  }
  label.full {
    width: 100%;
  }
  label.chk {
    flex-direction: row;
    align-items: center;
    gap: 4px;
  }
  .hk {
    margin-left: auto;
    font-size: 10px;
    font-family: var(--font-mono);
    opacity: 0.5;
  }
  .note.phys {
    display: flex;
    align-items: center;
    gap: 6px;
    font-variant-numeric: tabular-nums;
  }
  .note.phys .off-phys {
    color: var(--warn, #c77d00);
    opacity: 0.9;
  }
  .note.phys .true-size {
    margin-left: auto;
    font-size: 11px;
    padding: 1px 7px;
  }
  .note {
    margin: 6px 0 0;
    font-size: 11px;
    line-height: 1.4;
    opacity: 0.5;
  }
  .part-id {
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--c-accent-bright);
    margin-bottom: 4px;
    word-break: break-all;
  }
  .crumb {
    margin: 0 0 6px;
    font-size: 11px;
    line-height: 1.5;
    opacity: 0.65;
  }
  code {
    font-family: var(--font-mono);
    font-size: 10px;
  }
  input,
  select,
  textarea {
    background: var(--c-bg-raised);
    border: 1px solid var(--c-line-strong);
    color: var(--c-tx);
    border-radius: 4px;
    padding: 4px 6px;
    font-size: 12px;
    width: 100%;
  }
  input[type="checkbox"] {
    width: auto;
  }
  textarea {
    resize: vertical;
    font-family: inherit;
  }
  .grid6 {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 4px;
    margin-bottom: 6px;
  }
  button {
    background: var(--c-ui);
    color: var(--c-tx);
    border: 1px solid var(--c-line-strong);
    border-radius: 5px;
    padding: 5px 8px;
    font-size: 12px;
    cursor: pointer;
  }
  button:hover {
    background: var(--c-ui-hover);
  }
  button:disabled {
    opacity: 0.45;
    cursor: default;
  }
  button:disabled:hover {
    background: var(--c-ui);
  }
  button.prim:disabled:hover {
    background: var(--c-accent);
  }
  .fig-act {
    width: 100%;
    margin-top: 6px;
  }
  /* B/I/U toggles */
  .biu-row {
    align-items: flex-end;
  }
  .biu {
    flex: 0 0 auto;
    min-width: 26px;
    padding: 4px 7px;
    line-height: 1;
  }
  .biu[aria-pressed="true"] {
    background: var(--c-accent);
    border-color: var(--c-accent);
    color: var(--c-on-accent);
  }
  /* 3-way sizing segmented control */
  .seg {
    display: flex;
    gap: 0;
    margin-top: 6px;
  }
  .seg button {
    flex: 1;
    border-radius: 0;
    border-right-width: 0;
  }
  .seg button:first-child {
    border-radius: 5px 0 0 5px;
  }
  .seg button:last-child {
    border-radius: 0 5px 5px 0;
    border-right-width: 1px;
  }
  .seg button.on {
    background: var(--c-accent);
    border-color: var(--c-accent);
    color: var(--c-on-accent);
  }
  /* named-style picker + manage popover */
  .stylerow {
    display: flex;
    gap: 4px;
    align-items: center;
  }
  .gear {
    flex: 0 0 auto;
    padding: 4px 7px;
  }
  .style-pop {
    margin: 6px 0;
    padding: 6px;
    border: 1px solid var(--c-line-strong);
    border-radius: 6px;
    background: var(--c-bg-raised);
  }
  .style-row {
    display: flex;
    gap: 3px;
    align-items: center;
    margin-bottom: 4px;
  }
  .style-row .sname {
    flex: 1 1 60px;
    min-width: 40px;
  }
  .style-row button {
    flex: 0 0 auto;
    padding: 3px 6px;
    font-size: 11px;
  }
</style>
