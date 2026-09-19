<script lang="ts">
  import { numericProperties, propertyValue, setNumericProperty, type NumericProperty } from "./interact/elementProperties";
  import { editSession } from "./interact/editSession";
  const textSession = editSession();
  onDestroy(() => textSession.finish());
  let textTarget: string | null = null;
  const dimensionBaselines = new Map<string, { w: number; h: number }>();
  function captureDimensions() {
    dimensionBaselines.clear();
    for (const el of sel) if ("width" in el && "height" in el) dimensionBaselines.set(el.id, { w: el.width, h: el.height });
  }
  import { selectionTargets } from "./interact/selectionTargets";
  import { buildMenuFields, fieldRange, type Field } from "./interact/propertyMenu";
  import { get } from "svelte/store";
  import { onMount, onDestroy, getContext } from "svelte";
  import { figureFramePreview, project, selection, partSelection, partSelections, activeFigureId, commit, mutate, figureRev, globalRev, lastArrangeRows, duplicateFigure, autoLetterPanels, embeddedProjectRoot, figNamer, figureCatalog } from "./store";
  import { familyById, formatFamilyRef } from "./figfamily";
  import { pushToast, errMsg } from "./toast";
  import type { Element, Figure, Project, TextAlign, TextStyle, TextVAlign } from "./types";
  import { doAlign, doDistribute, arrangeToRows, selectMatching, copyStyle, pasteStyle, openCascade } from "./keyboard";
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
  import { nameForHex } from "./colors";
  import { gradientCss, gradientLabel } from "./color/gradient";
  import type { GradientFill } from "./types";
  import { dissectKeyForElement, openDissectForSelection, dissectRoot } from "./dissect/state";
  import { countDissections } from "./dissect/loader";
  import { dissectionsRevision } from "../shell/scholar/revisions";
  import ColorPalette from "./ColorPalette.svelte";
  import ColorPicker from "./ColorPicker.svelte";
  import NumberField from "./NumberField.svelte";
  import { commitDeckLive } from "./slide/store";
  import { setVideoSettings } from "./slide/ops";

  onMount(() => {
    loadGlobalTextStyles(); // machine-global style library (best-effort)
  });

  // Slide-migration: the shared editing surface, lightly slide-accented. In
  // slide mode the figure-only affordances (physical-mm/true-size readouts,
  // caption/panel-label, the Figure section, exports) are hidden — slide name/
  // background/stage live in the Slide/Deck panels instead. Strictly additive:
  // without the context (figure mode) this renders byte-identically.
  const slideMode = (getContext<"figure" | "slide" | undefined>("flux-editor-mode") ?? "figure") === "slide";
  function updateVideoSettings(settings: { muted?: boolean; loop?: boolean }) {
    if (!slideMode || single?.type !== "video" || !modelFigure || selectionReadOnly) return;
    const id = single.id, slideId = modelFigure.id;
    commitDeckLive(deck => setVideoSettings(deck, slideId, id, settings));
  }

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
  $: modelFigure = $project.figures.find((f) => f.id === $activeFigureId) ?? null;
  $: fig = modelFigure && $figureFramePreview?.id === modelFigure.id
    ? { ...modelFigure, x: $figureFramePreview.x, y: $figureFramePreview.y, width: $figureFramePreview.w, height: $figureFramePreview.h }
    : modelFigure;

  // Physical-size truth (canvas px are 96/inch): the mm readout under W/H, and a
  // reset back to an asset's true physical size after a manual/legacy rescale.
  // For a CROPPED element (P5) the reference is the crop WINDOW's intrinsic
  // dims (crop px are assetDisplaySize units, i.e. already physical): "true
  // size" means the visible window renders 1:1, not the full content.
  const mmStr = (px: number) => ((px / 96) * MM_PER_INCH).toFixed(1);
  $: physSize = single && "assetId" in single ? ops.assetDisplaySize($project, single.assetId) : null;

  // Dissect: the selected asset's companion-folder count (plots/_dissections/<key>).
  // Async + memoized by (key, dissectionsRevision) — the Inspector never blocks on IO;
  // a stale response is dropped by the generation counter. Figure mode only (slide mode
  // has no plots/ tenancy).
  let dissectCount: number | null = null;
  const dissectMemo = { key: "", rev: -1, gen: 0 };
  $: dissectKey = !slideMode && single && "assetId" in single ? dissectKeyForElement(single) : "";
  $: {
    const rev = $dissectionsRevision;
    if (!dissectKey) {
      dissectMemo.key = "";
      dissectCount = null;
    } else if (dissectKey !== dissectMemo.key || rev !== dissectMemo.rev) {
      dissectMemo.key = dissectKey;
      dissectMemo.rev = rev;
      const my = ++dissectMemo.gen;
      void countDissections(dissectRoot(), dissectKey).then((n) => {
        if (my === dissectMemo.gen) dissectCount = n;
      });
    }
  }
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

  $: editableSel = editableSelection(sel, $figureRev, $globalRev);
  function editableSelection(elements: Element[], _revs: unknown, _global: number) {
    const ids = new Set(elements.map(e => e.id));
    return get(project).figures.flatMap(f => selectionTargets(f, ids, { editable: true }));
  }
  $: selectionReadOnly = sel.length > 0 && editableSel.length === 0;
  $: if (textTarget !== (single?.id ?? null)) { textSession.finish(); textTarget = single?.id ?? null; }

  // Lock / hide state across the selection (F6): all-on drives the checkbox,
  // some-on shows the indeterminate dash.
  $: anyLocked = sel.some((e) => e.locked);
  $: allLocked = sel.length > 0 && sel.every((e) => e.locked);
  $: anyHidden = sel.some((e) => e.hidden);
  $: allHidden = sel.length > 0 && sel.every((e) => e.hidden);

  // Arrange controls (mouse equivalents of the Alt+T grid mode). `arrN` is the
  // number of layout cells (a group counts once); the section hides below 2.
  $: arrN = sel.length >= 2 ? gridItemCount(sel) : 0;
  // Exact-gap distribute (Feature 7): the gutter applied by the Gap H/V buttons.
  let gapVal = 24;
  // Proportional scale (Feature 5): one-shot "scale by %" of the selection.
  let scalePct = 100;
  function applyScale() {
    const ids = editableIds();
    if (!ids.length || !(scalePct > 0)) return;
    commit((p) => ops.scaleElements(p, ids, scalePct / 100));
  }
  function stepRows(d: number) {
    const v = validRowCounts(arrN);
    let i = v.indexOf(get(lastArrangeRows));
    if (i < 0) i = 0;
    arrangeToRows(v[Math.max(0, Math.min(v.length - 1, i + d))]);
  }

  // --- selected plot part(s) (role/identity from the manifest) ---
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
  // The part FIELDS — the same list the property menu shows (one field model,
  // interact/propertyMenu.ts), applied to every selected part. The letter on
  // each row is its hotkey in the menu (F).
  $: partFields = partInfo ? buildMenuFields($project, $selection, $partSelections, $plotManifests, $globalTextStyles) : [];
  $: partCount = $partSelections.length;
  function runField(f: Field, v: string | number | boolean) {
    const s = editSession();
    s.run(() => f.apply(v));
    s.finish();
  }

  // --- appearance: fill / stroke / text colour with the palette picker ---
  // One inline picker at a time; it closes on apply/cancel or a selection change.
  let colorPop: "fill" | "stroke" | "text" | null = null;
  let colorPopKey = "";
  $: {
    const key = [...$selection].join(",") + "|" + $partSelections.map((p) => p.partId).join(",");
    if (key !== colorPopKey) { colorPopKey = key; colorPop = null; }
  }
  $: fillEl = sel.find((e) => e.type === "rect" || e.type === "ellipse" || e.type === "path");
  // a colormap gradient paints the swatch and names the map (color/gradient.ts)
  const paintCss = (hex: string, g?: GradientFill | null) => {
    const css = g ? gradientCss(g) : null;
    return css ? `background:${css}` : hex === "none" ? "" : `background:${hex}`;
  };
  const paintName = (hex: string, g?: GradientFill | null) => (g && gradientCss(g) ? gradientLabel(g) : swatchName(hex));
  $: strokeEl = sel.find((e) => e.type === "rect" || e.type === "ellipse" || e.type === "path" || e.type === "line");
  $: textEl = sel.find((e) => e.type === "text");
  const swatchName = (hex: string) => (hex === "none" ? "none" : (nameForHex(hex) ?? hex));

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
  // Capture once and encode in a worker. Disable all export buttons
  // while one runs (no double-submit) and label the running one "Exporting…".
  let exporting: string | null = null;
  let exportAbort: AbortController | null = null;
  onDestroy(() => exportAbort?.abort());
  async function runExport(kind: string, fn: (f: Figure, signal: AbortSignal) => Promise<void>) {
    const target = fig;
    if (!target || exporting) return;
    exporting = kind;
    exportAbort = new AbortController();
    try {
      await fn(target, exportAbort.signal);
    } finally {
      exporting = null;
      exportAbort = null;
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

  function editableIds() {
    return get(project).figures.flatMap(f => selectionTargets(f, get(selection), { editable: true }).map(e => e.id));
  }
  function updateSelected(fn: (e: Element, p: Project) => void, editable = true) {
    const ids = editable ? new Set(editableIds()) : get(selection);
    if (!ids.size) return;
    commit((p) => {
      for (const f of p.figures)
        for (const e of selectionTargets(f, ids, { editable })) {
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
        for (const e of selectionTargets(f, ids, { editable: true })) {
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

  // --- text styling (B/I/U, sizing mode, named styles) ---
  function toggleSelText(which: ops.TextToggle) {
    const list = editableIds();
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
    const ids = editableIds();
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
    applyProjectStyle(editableIds(), st.id);
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
  const arrowOf = (e: Element | undefined) => (e && (e.type === "line" || (e.type === "path" && !e.closed)) ? (e as Element & { arrowStart?: boolean; arrowEnd?: boolean; arrowStyle?: "filled" | "vee"; arrowSize?: number }) : null);
  function setArrow(patch: Partial<{ arrowStart: boolean; arrowEnd: boolean; arrowStyle: "filled" | "vee"; arrowSize: number }>) {
    const ids = editableIds();
    commit((p) => ops.setElementStyle(p, ids, patch));
  }
</script>

<aside class="inspector">
  <!-- SELECTED PLOT PART(S): the same fields the property menu shows, applied
       to every picked part (five series, or the x-axis of four plots). -->
  {#if partInfo}
    <section class="part">
      <h4>Plot part{partCount > 1 ? `s · ${partCount}` : ""}</h4>
      <div class="secbody">
        <div class="part-id">{partLabel}{#if partCount > 1}<span class="more">+{partCount - 1} more</span>{/if}</div>
        {#if partCrumb}
          <p class="crumb">{partCrumb}</p>
        {/if}
        {#if partInfo.x !== undefined && partInfo.y !== undefined}
          <p class="note">data: x = {partInfo.x}, y = {partInfo.y}</p>
        {/if}
        <div class="pfields">
          {#each partFields as f (f.key)}
            {@const range = fieldRange(f)}
            <div class="pf" data-key={f.key}>
              <span class="pk" title="hotkey in the property menu (F)">{f.key}</span>
              <span class="pl">{f.label}</span>
              <span class="pc">
                {#if f.kind === "number"}
                  <NumberField value={Number(f.get())} step={f.step ?? 1} min={f.min ?? null} max={f.max ?? null} mixed={!!f.mixed}
                    title={range ? `${f.label} (${range.min}–${range.max})` : f.label}
                    on:commit={(e) => runField(f, e.detail)}
                    on:scrub={(e) => f.apply(e.detail)} />
                {:else if f.kind === "select"}
                  <select value={String(f.get())} aria-label={f.label} on:change={(e) => runField(f, e.currentTarget.value)}>
                    {#each f.options ?? [] as o}<option value={o.value}>{o.label}</option>{/each}
                  </select>
                {:else if f.kind === "toggle"}
                  <button class="tgl" class:on={Boolean(f.get())} on:click={() => runField(f, true)}>{f.get() ? "on" : "off"}</button>
                {:else if f.kind === "color"}
                  {@const hex = String(f.get())}
                  <button class="swrow" on:click={() => (colorPop = colorPop === (f.target === "stroke" ? "stroke" : "fill") ? null : f.target === "stroke" ? "stroke" : "fill")} title="Pick from the palette">
                    <span class="sw" style={hex === "none" ? "" : `background:${hex}`}></span>
                    <span class="swname">{swatchName(hex)}</span>
                  </button>
                {:else}
                  <button class="tgl" on:click={() => runField(f, true)}>run</button>
                {/if}
              </span>
            </div>
          {/each}
        </div>
        {#if colorPop && (colorPop === "fill" || colorPop === "stroke")}
          <div class="pop"><ColorPicker target={colorPop} allowNone={false} autofocus={false} onDone={() => (colorPop = null)} onCancel={() => (colorPop = null)} /></div>
        {/if}
        <button class="fig-act" title="Open the property menu for this part (f)" on:click={() => fluxFigMenuOpen.set(true)}>Show properties</button>
        <p class="note">edits write override <code>{partInfo.id}</code> — they survive regeneration</p>
      </div>
    </section>
  {/if}

  {#if selectionReadOnly}<p class="note banner" role="status">Selection is locked or hidden. Unlock or show it in Layers to edit.</p>{/if}
  <fieldset disabled={selectionReadOnly}>
  <!-- POSITION / SIZE -->
  {#if single}
    <section>
      <h4>{single.type}</h4>
      <div class="secbody">
      <div class="row">
        <NumberField label="X" value={single.x}
          on:commit={(e) => updateSelected((el, p) => setNumericProperty(p, el, "x", e.detail))}
          on:scrub={(e) => scrubSelected((el, p) => setNumericProperty(p, el, "x", e.detail))} />
        <NumberField label="Y" value={single.y}
          on:commit={(e) => updateSelected((el, p) => setNumericProperty(p, el, "y", e.detail))}
          on:scrub={(e) => scrubSelected((el, p) => setNumericProperty(p, el, "y", e.detail))} />
      </div>
      {#if "width" in single && ops.supportsBoxDim(single.type)}
        <div class="row wh">
          <NumberField label="W" value={single.width} min={1}
            on:commit={(e) => updateSelected((el, p) => setNumericProperty(p, el, "width", e.detail))}
            on:scrubStart={captureDimensions}
            on:scrub={(e) => scrubSelected((el, p) => setNumericProperty(p, el, "width", e.detail, dimensionBaselines.get(el.id)))} />
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
            on:commit={(e) => updateSelected((el, p) => setNumericProperty(p, el, "height", e.detail))}
            on:scrubStart={captureDimensions}
            on:scrub={(e) => scrubSelected((el, p) => setNumericProperty(p, el, "height", e.detail, dimensionBaselines.get(el.id)))} />
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
      {#if dissectKey}
        <div class="row">
          <button
            class="fig-act"
            data-dissect-open
            title="View this plot's companion material — plots/_dissections/{dissectKey}/ (d)"
            on:click={openDissectForSelection}
          >
            Dissections{#if dissectCount}<span class="dcount">{dissectCount}</span>{/if}
          </button>
        </div>
      {/if}
      <div class="row">
        <NumberField label="Rotation°" value={single.rotation} step={1}
          on:commit={(e) => updateSelected((el, p) => setNumericProperty(p, el, "rotation", e.detail))}
          on:scrub={(e) => scrubSelected((el, p) => setNumericProperty(p, el, "rotation", e.detail))} />
        <NumberField label="Opacity" value={single.opacity ?? 1} step={0.05} min={0} max={1}
          on:commit={(e) => updateSelected((el, p) => setNumericProperty(p, el, "opacity", e.detail))}
          on:scrub={(e) => scrubSelected((el, p) => setNumericProperty(p, el, "opacity", e.detail))} />
      </div>
      </div>
    </section>
  {:else if sel.length > 1}
    <section><h4>{sel.length} selected</h4>
      <div class="secbody">
      {#each Object.entries(numericProperties) as [key, descriptor]}
        {@const value = propertyValue(editableSel, key as NumericProperty)}
        {#if value.count}
          <div class="row">
            <NumberField label={descriptor.shortLabel} value={value.value} mixed={value.mixed}
              step={descriptor.step} min={descriptor.min ?? null} max={descriptor.max ?? null}
              title={`Applies to ${value.count} of ${sel.length} selected objects; locked or hidden objects stay unchanged`}
              on:commit={(e) => updateSelected((el, p) => setNumericProperty(p, el, key as NumericProperty, e.detail))}
              on:scrubStart={captureDimensions}
              on:scrub={(e) => scrubSelected((el, p) => setNumericProperty(p, el, key as NumericProperty, e.detail, dimensionBaselines.get(el.id)))} />
          </div>
        {/if}
      {/each}
      </div>
    </section>
  {/if}

  <!-- APPEARANCE: the paints, always visible for anything that has them —
       swatch + palette name; click a swatch for the palette picker inline. -->
  {#if !partInfo && (fillEl || strokeEl || textEl)}
    <section class="appearance">
      <h4>Appearance</h4>
      <div class="secbody">
        {#if fillEl && (fillEl.type === "rect" || fillEl.type === "ellipse" || fillEl.type === "path")}
          <div class="arow">
            <span class="al">Fill</span>
            <button class="swrow" class:open={colorPop === "fill"} on:click={() => (colorPop = colorPop === "fill" ? null : "fill")} title="Fill colour — pick from the palette (F, then c)">
              <span class="sw" class:isnone={fillEl.fill === "none" && !fillEl.fillMap} style={paintCss(fillEl.fill, fillEl.fillMap)}></span>
              <span class="swname">{paintName(fillEl.fill, fillEl.fillMap)}</span>
              <span class="swhex">{fillEl.fill === "none" ? "" : fillEl.fill}</span>
            </button>
          </div>
          {#if colorPop === "fill"}<div class="pop"><ColorPicker target="fill" autofocus={false} onDone={() => (colorPop = null)} onCancel={() => (colorPop = null)} /></div>{/if}
        {/if}
        {#if strokeEl && "stroke" in strokeEl}
          <div class="arow">
            <span class="al">Stroke</span>
            <button class="swrow" class:open={colorPop === "stroke"} on:click={() => (colorPop = colorPop === "stroke" ? null : "stroke")} title="Stroke colour — pick from the palette (F, then k)">
              <span class="sw" class:isnone={strokeEl.stroke === "none" && !strokeEl.strokeMap} style={paintCss(strokeEl.stroke, strokeEl.strokeMap)}></span>
              <span class="swname">{paintName(strokeEl.stroke, strokeEl.strokeMap)}</span>
              <span class="swhex">{strokeEl.stroke === "none" ? "" : strokeEl.stroke}</span>
            </button>
          </div>
          {#if colorPop === "stroke"}<div class="pop"><ColorPicker target="stroke" autofocus={false} onDone={() => (colorPop = null)} onCancel={() => (colorPop = null)} /></div>{/if}
        {/if}
        {#if textEl && textEl.type === "text"}
          <div class="arow">
            <span class="al">Text</span>
            <button class="swrow" class:open={colorPop === "text"} on:click={() => (colorPop = colorPop === "text" ? null : "text")} title="Text colour — pick from the palette">
              <span class="sw" style={paintCss(textEl.color, textEl.fillMap)}></span>
              <span class="swname">{paintName(textEl.color, textEl.fillMap)}</span>
              <span class="swhex">{textEl.color}</span>
            </button>
          </div>
          {#if colorPop === "text"}<div class="pop"><ColorPicker target="fill" allowNone={false} autofocus={false} onDone={() => (colorPop = null)} onCancel={() => (colorPop = null)} /></div>{/if}
        {/if}
      </div>
    </section>
  {/if}

  {#if slideMode && single?.type === "video"}
    {@const videoAsset = $project.assets.find(asset => asset.id === single.assetId)}
    <section class="video-properties">
      <h4>Video clip</h4>
      <div class="secbody">
      <p class="note" title={videoAsset?.sourcePath ?? videoAsset?.name}>{videoAsset?.sourcePath ?? videoAsset?.name ?? "Video"}</p>
      <p class="note">{(single.durationMs / 1000).toLocaleString(undefined, { maximumFractionDigits: 2 })} seconds{videoAsset?.hasAudio ? " · includes audio" : " · no audio"}</p>
      <div class="row" style="gap:14px;">
        <label class="chk"><input type="checkbox" aria-label="Mute video" checked={single.muted ?? false}
          on:change={event => updateVideoSettings({ muted: event.currentTarget.checked })} />Mute</label>
        <label class="chk"><input type="checkbox" aria-label="Loop video" checked={single.loop ?? false}
          on:change={event => updateVideoSettings({ loop: event.currentTarget.checked })} />Loop</label>
      </div>
      <p class="note">Select a step in Animate, then choose <b>Start video</b>. <b>Appear</b> reveals the first frame separately.</p>
      </div>
    </section>
  {/if}

  </fieldset>
  <!-- LOCK / HIDE (F6) -->
  {#if sel.length >= 1}
    <section class="state">
      <div class="secbody">
      <div class="row" style="gap:14px;">
        <label class="chk">
          <input
            type="checkbox"
            checked={allLocked}
            indeterminate={anyLocked && !allLocked}
            on:change={(e) => updateSelected((el) => (el.locked = e.currentTarget.checked), false)} />
          Lock <span class="hk">⌘⇧L</span>
        </label>
        <label class="chk">
          <input
            type="checkbox"
            checked={allHidden}
            indeterminate={anyHidden && !allHidden}
            on:change={(e) => updateSelected((el) => (el.hidden = e.currentTarget.checked), false)} />
          Hide <span class="hk">x</span>
        </label>
      </div>
      </div>
    </section>
  {/if}

  <fieldset disabled={selectionReadOnly}>
  <!-- TYPE-SPECIFIC STYLE -->
  {#if single && single.type === "text"}
    <section>
      <h4>Text</h4>
      <div class="secbody">
      <textarea
        rows="3"
        value={single.text}
        on:input={(e) => { const value = e.currentTarget.value; textSession.run(() => scrubSelected((el) => { if (el.type === "text") el.text = value; })); }}
        on:blur={() => textSession.finish()}
        on:keydown={(e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); textSession.cancel(); e.currentTarget.blur(); } }}
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
          title={slideMode ? "Font size in points" : "Font size in points, as printed (journals typically want 5–8 pt)"}
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
          <select value={single.align} on:change={(e) => updateSelected((el, p) => { if (el.type === "text") { el.align = e.currentTarget.value as TextAlign; ops.detachOnManualEdit(p, el, ["align"]); } })}>
            <option value="left">Left</option><option value="center">Center</option><option value="right">Right</option><option value="justify">Justify</option>
          </select>
        </label>
      </div>
      <!-- Arrangement inside the box: vertical placement (visible while the box
           is taller than the text, i.e. Fixed) and the two typographic
           distances. Line height sits with B/I/U below. -->
      <div class="row">
        <label>Vertical
          <select value={single.valign ?? "top"} title="Where the text block sits in a box taller than itself (Fixed sizing)" aria-label="Vertical align"
            on:change={(e) => { const v = e.currentTarget.value as TextVAlign; updateSelected((el, p) => { if (el.type === "text") ops.setElementStyle(p, [el.id], { valign: v }); }); }}>
            <option value="top">Top</option><option value="middle">Middle</option><option value="bottom">Bottom</option>
          </select>
        </label>
        <NumberField label="Tracking (pt)" value={(single.letterSpacing ?? 0) * 0.75} step={0.1}
          title="Letter spacing in points — space added after every glyph (negative tightens)"
          on:commit={(e) => updateSelected((el, p) => setNumericProperty(p, el, "letterSpacing", e.detail))}
          on:scrub={(e) => scrubSelected((el, p) => setNumericProperty(p, el, "letterSpacing", e.detail))} />
      </div>
      <div class="row">
        <NumberField label="Para space (pt)" value={(single.paragraphSpacing ?? 0) * 0.75} min={0} step={0.5}
          title="Extra space before each new paragraph (a hard line break), in points"
          on:commit={(e) => updateSelected((el, p) => setNumericProperty(p, el, "paragraphSpacing", e.detail))}
          on:scrub={(e) => scrubSelected((el, p) => setNumericProperty(p, el, "paragraphSpacing", e.detail))} />
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
      </div>
    </section>
  {/if}

  <!-- PANEL LABEL (caption) — figure-only (captions belong to paper figures) -->
  {#if textSel.length > 0 && !slideMode}
    <section>
      <h4>Caption</h4>
      <div class="secbody">
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
      </div>
    </section>
  {/if}

  {#if single && (single.type === "rect" || single.type === "ellipse" || single.type === "line" || single.type === "path")}
    {@const arrow = arrowOf(single)}
    <section>
      <h4>Stroke / fill</h4>
      <div class="secbody">
      <div class="row">
        <NumberField label="Stroke W" value={single.strokeWidth} min={0} step={0.5}
          on:commit={(e) => updateSelected((el) => { if ("strokeWidth" in el) el.strokeWidth = e.detail; })}
          on:scrub={(e) => scrubSelected((el) => { if ("strokeWidth" in el) el.strokeWidth = e.detail; })} />
        {#if single.type === "rect"}
          <NumberField label="Radius" value={single.cornerRadius} min={0}
            on:commit={(e) => updateSelected((el) => { if (el.type === "rect") el.cornerRadius = e.detail; })}
            on:scrub={(e) => scrubSelected((el) => { if (el.type === "rect") el.cornerRadius = e.detail; })} />
        {:else if single.type === "path"}
          <!-- Geometric fillets (Figma corner radius) — must go through
               ops.setElementStyle so the refit re-emits d; a direct field
               write would leave the rendered geometry sharp. -->
          <NumberField label="Radius" value={single.cornerRadius ?? 0} min={0}
            on:commit={(e) => { const ids = editableIds(); commit((p) => ops.setElementStyle(p, ids, { cornerRadius: e.detail })); }}
            on:scrub={(e) => { const ids = editableIds(); mutate((p) => ops.setElementStyle(p, ids, { cornerRadius: e.detail })); }} />
        {/if}
      </div>
      {#if single.type === "line" || (single.type === "path" && !single.closed)}
        <div class="row">
          <label class="chk">Cap
            <select value={single.cap ?? "round"} on:change={(e) => { const cap = e.currentTarget.value as "butt" | "round" | "square"; const ids = editableIds(); commit((p) => ops.setElementStyle(p, ids, { cap })); }}>
              <option value="round">Round</option>
              <option value="butt">Flat</option>
              <option value="square">Square</option>
            </select>
          </label>
        </div>
      {/if}
      <!-- Dash: [len, gap] in canvas px on any stroked primitive; unchecking
           returns to solid (property deleted via ops.setElementStyle's rules). -->
      <div class="row">
        <label class="chk"><input type="checkbox" checked={!!single.dash?.length} on:change={(e) => { const on = e.currentTarget.checked; const ids = editableIds(); commit((p) => ops.setElementStyle(p, ids, { dash: on ? [6, 4] : [] })); }} />Dashed</label>
        {#if single.dash?.length}
          <NumberField label="Dash" value={single.dash[0] ?? 6} min={0.5} step={0.5}
            on:commit={(e) => { const gap = single.dash?.[1] ?? 4; const ids = editableIds(); commit((p) => ops.setElementStyle(p, ids, { dash: [e.detail, gap] })); }}
            on:scrub={(e) => { const gap = single.dash?.[1] ?? 4; const ids = editableIds(); mutate((p) => ops.setElementStyle(p, ids, { dash: [e.detail, gap] })); }} />
          <NumberField label="Gap" value={single.dash[1] ?? 4} min={0.5} step={0.5}
            on:commit={(e) => { const len = single.dash?.[0] ?? 6; const ids = editableIds(); commit((p) => ops.setElementStyle(p, ids, { dash: [len, e.detail] })); }}
            on:scrub={(e) => { const len = single.dash?.[0] ?? 6; const ids = editableIds(); mutate((p) => ops.setElementStyle(p, ids, { dash: [len, e.detail] })); }} />
        {/if}
      </div>
      {#if arrow}
        <div class="row">
          <label class="chk"><input type="checkbox" checked={!!arrow.arrowStart} on:change={(e) => setArrow({ arrowStart: e.currentTarget.checked })} />Arrow start</label>
          <label class="chk"><input type="checkbox" checked={!!arrow.arrowEnd} on:change={(e) => setArrow({ arrowEnd: e.currentTarget.checked })} />Arrow end</label>
        </div>
        {#if arrow.arrowStart || arrow.arrowEnd}
          <div class="row">
            <label>Arrowhead
              <select value={arrow.arrowStyle ?? "filled"} on:change={(e) => setArrow({ arrowStyle: e.currentTarget.value as "filled" | "vee" })}>
                <option value="filled">Filled</option>
                <option value="vee">V-line</option>
              </select>
            </label>
            <NumberField label="Head size" value={arrow.arrowSize ?? 4} min={1} step={0.5} title="Arrowhead size as a multiple of the stroke width"
              on:commit={(e) => setArrow({ arrowSize: Math.max(1, e.detail) })}
              on:scrub={(e) => { const ids = editableIds(); mutate((p) => ops.setElementStyle(p, ids, { arrowSize: Math.max(1, e.detail) })); }} />
          </div>
        {/if}
      {/if}
      {#if single.type === "path"}
        <!-- Close/open after the fact (pen-time closing = clicking the first
             node). Goes through ops.updatePath: adopts legacy d-only paths
             into nodes, regenerates d, refits the bbox. -->
        <div class="row">
          <label class="chk"><input type="checkbox" checked={single.closed} on:change={(e) => { const closed = e.currentTarget.checked; const id = single.id; commit((p) => ops.updatePath(p, id, { closed })); }} />Closed path</label>
        </div>
      {/if}
      </div>
    </section>
  {/if}

  <!-- FIGURE (+ exports) — figure-only: slide name/background are edited in
       the Slide panel, the stage in the Deck panel, and a deck exports as a
       presentation (.html), never as a per-frame raster. -->
  </fieldset>
  {#if fig && !slideMode}
    <section>
      <h4>Figure</h4>
      <div class="secbody">
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
      <p class="note mono">= {mmStr(fig.width)} × {mmStr(fig.height)} mm</p>

      <!-- Identity is family + number (figfamily.ts) — the name is derived, so
           the row opens the Figure Namer instead of editing text. The nickname
           stays inline-editable (it's free text). -->
      <button
        class="identity"
        title="Rename (Ctrl+R)"
        on:click={() => figNamer.set({ figId: fig.id })}>
        <b>{fig.name}</b>
        <span class="id-ref">{formatFamilyRef(familyById(fig.family, $project.figureFamilies), fig.number ?? 0)}</span>
      </button>
      <label class="full">Title
        <input
          value={fig.nickname ?? ""}
          placeholder="e.g. Growth curves"
          on:change={(e) => {
            const v = e.currentTarget.value.trim();
            updateFigure((f) => {
              if (v) f.nickname = v;
              else delete f.nickname;
            });
          }} />
      </label>
      <button class="full figure-details" on:click={() => figureCatalog.set({ figureId: fig.id })}>Reference, sources &amp; used in…</button>
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
      </div>
    </section>

  {/if}

  <details class="advanced" open={sel.length >= 2}>
    <summary>Align, arrange &amp; selection tools</summary>
  <!-- ALIGN -->
  <section>
    <h4>Align</h4>
    <div class="secbody">
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
    <div class="row">
      <button
        title="Cascade a property across the selection — each object steps by a delta (Ctrl+Shift+C)"
        disabled={sel.length < 2}
        on:click={openCascade}>Cascade… <span class="hk">⌃⇧C</span></button>
    </div>
    {#if sel.length >= 2}
      <div class="row gaprow">
        <NumberField history={false} label="Gap" value={gapVal} min={0}
          on:commit={(e) => (gapVal = e.detail)}
          on:scrub={(e) => (gapVal = e.detail)} />
        <button title="Exact gap horizontally" on:click={() => doDistribute("h", gapVal)}>Gap H</button>
        <button title="Exact gap vertically" on:click={() => doDistribute("v", gapVal)}>Gap V</button>
      </div>
    {/if}
    {#if sel.length >= 1}
      <div class="row gaprow">
        <NumberField history={false} label="Scale %" value={scalePct} min={1}
          on:commit={(e) => (scalePct = e.detail)}
          on:scrub={(e) => (scalePct = e.detail)} />
        <button title="Scale proportionally (geometry + stroke/font) about the selection centre" on:click={applyScale}>Apply</button>
      </div>
    {/if}
    </div>
  </section>

  <!-- SELECT SAME / STYLE (F9 + F10) -->
  {#if sel.length >= 1}
    <section>
      <h4>Select &amp; style</h4>
      <div class="secbody">
      {#if single}
        <div class="row" style="flex-wrap:wrap;gap:4px;">
          <span class="rowlbl">Select same…</span>
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
      </div>
    </section>
  {/if}

  <!-- ARRANGE -->
  {#if arrN >= 2}
    <section>
      <h4>Arrange <span class="hk">Alt+T</span></h4>
      <div class="secbody">
      <div class="grid6">
        <button title="Single row" on:click={() => arrangeToRows(1)}>Row</button>
        <button title="Balanced grid" on:click={() => arrangeToRows(balancedRows(arrN))}>Grid</button>
        <button title="Single column" on:click={() => arrangeToRows(arrN)}>Column</button>
      </div>
      <div class="row" style="align-items:center;gap:8px;">
        <span class="rowlbl">Rows</span>
        <button title="Fewer rows" on:click={() => stepRows(-1)}>−</button>
        <span class="rowsval">{$lastArrangeRows}</span>
        <button title="More rows" on:click={() => stepRows(1)}>+</button>
      </div>
      </div>
    </section>
  {/if}

  </details>

  <!-- COLOR PALETTE -->
  <details class="slide-colors"><summary>Color palette</summary><div class="secbody"><ColorPalette /></div></details>

  {#if fig && !slideMode}
    <!-- EXPORT -->
    <section>
      <h4>Export “{fig.name}”</h4>
      <div class="secbody">
      {#if exporting && ["png", "tiff", "jpng"].includes(exporting)}
        <div class="row" role="status"><span>Preparing export…</span><button on:click={() => exportAbort?.abort()}>Cancel export</button></div>
      {/if}
      <div class="row">
        <button disabled={!!exporting} on:click={() => runExport("png", (f, signal) => exportFigurePng(f, dpi / 96, signal))} title="Quick PNG at {dpi} dpi (design px × {(dpi / 96).toFixed(1)})">{exporting === "png" ? "Exporting…" : "PNG"}</button>
        <button disabled={!!exporting} on:click={() => runExport("svg", (f) => exportFigureSvg(f))} title="Vector SVG">{exporting === "svg" ? "Exporting…" : "SVG"}</button>
        <button disabled={!!exporting} on:click={() => runExport("pdf", (f) => exportFigurePdf(f))} title="Vector PDF">{exporting === "pdf" ? "Exporting…" : "PDF"}</button>
      </div>

      <details class="journal-export"><summary>Journal-spec raster</summary>
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
        <button class="prim" disabled={!!exporting} on:click={() => runExport("tiff", (f, signal) => exportFigureJournal(f, { signal, format: "tiff", mm: selectedMm, dpi: journalDpi, transparent: transparentBg }))}>{exporting === "tiff" ? "Exporting…" : "TIFF"}</button>
        <button class="prim" disabled={!!exporting} on:click={() => runExport("jpng", (f, signal) => exportFigureJournal(f, { signal, format: "png", mm: selectedMm, dpi: journalDpi, transparent: transparentBg }))}>{exporting === "jpng" ? "Exporting…" : "PNG"}</button>
      </div>
      </details>
      </div>
    </section>
  {/if}
</aside>

<style>
  /* The right rail (2026-09-15 surface redesign): a raised strip of
     hairline-separated sections, each a 28px mono eyebrow over dense
     label/value rows; mono values, square controls, quiet tints. Every class,
     aria-label, data attribute and text label the gates pin is unchanged. */
  fieldset { border: 0; margin: 0; padding: 0; min-width: 0; }
  fieldset:disabled { opacity: .55; }
  .journal-export { margin-top: 8px; }
  .journal-export > summary { cursor: var(--cursor-cross-hover); color: var(--c-tx-2); margin-bottom: 6px; font-size: 11px; }
  .advanced > summary { cursor: var(--cursor-cross-hover); font: 600 10.5px var(--font-mono); text-transform: uppercase; letter-spacing: 0.08em; color: var(--c-tx-muted); height: 28px; display: flex; align-items: center; padding: 0 10px; border-bottom: 1px solid var(--c-line); }
  .advanced > summary::marker { color: var(--c-tx-faint); }
  .slide-colors { border-top: 1px solid var(--c-line); border-bottom: 1px solid var(--c-line); }
  .slide-colors summary { cursor: var(--cursor-cross-hover); font: 600 10.5px var(--font-mono); text-transform: uppercase; letter-spacing: 0.08em; color: var(--c-tx-muted); height: 28px; display: flex; align-items: center; padding: 0 10px; }
  .figure-details { font: 12px var(--font-ui); height: 24px; margin-top: 6px; color: var(--c-accent-bright); background: transparent; border: 1px solid var(--c-line-strong); border-radius: var(--r-ui); cursor: var(--cursor-cross-hover); }
  .figure-details:hover { border-color: var(--c-accent); }
  .inspector {
    /* Width var set by the host mode (FigureMode drag-resize). SlideMode's
       `.rail :global(.inspector){width:100%}` override still wins there. */
    width: var(--insp-w, 248px);
    flex: 0 0 var(--insp-w, 248px);
    background: var(--c-bg-raised);
    border-left: 1px solid var(--c-line);
    overflow-y: auto;
    padding: 0 0 24px;
    font: 12px var(--font-ui);
    -webkit-font-smoothing: antialiased;
    color: var(--c-tx);
  }
  section {
    border-bottom: 1px solid var(--c-line);
  }
  section.state { border-bottom: 1px solid var(--c-line); }
  .secbody { padding: 8px 10px 10px; }
  h4 {
    margin: 0;
    height: 28px;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 10px;
    font: 600 10.5px var(--font-mono);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--c-tx-muted);
    border-bottom: 1px solid var(--c-line);
  }
  .banner { padding: 8px 10px; margin: 0; border-bottom: 1px solid var(--c-line); }
  .sizeread {
    margin: 2px 0 6px;
    font: 10px var(--font-mono);
    color: var(--c-tx-muted);
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
  .row:last-child { margin-bottom: 0; }
  .row.wh {
    align-items: flex-end;
  }
  .rowlbl { color: var(--c-tx-muted); font-size: 11px; width: 100%; }
  .rowsval { min-width: 18px; text-align: center; font: 12px var(--font-mono); font-variant-numeric: tabular-nums; }
  .ratio {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    padding: 0;
    color: var(--c-tx-muted);
    line-height: 1;
  }
  .ratio.on {
    color: var(--c-tx-hi);
    background: var(--c-accent-tint);
    border-color: var(--c-accent);
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 2px;
    flex: 1;
    font: 10.5px var(--font-ui);
    color: var(--c-tx-muted);
    letter-spacing: 0.02em;
  }
  label.full {
    width: 100%;
    margin-top: 6px;
  }
  label.chk {
    flex-direction: row;
    align-items: center;
    gap: 5px;
    font-size: 12px;
    color: var(--c-tx);
  }
  .hk {
    margin-left: auto;
    font: 10px var(--font-mono);
    color: var(--c-tx-faint);
  }
  h4 .hk { margin-left: 0; }
  .note.phys {
    display: flex;
    align-items: center;
    gap: 6px;
    font-family: var(--font-mono);
    font-variant-numeric: tabular-nums;
  }
  .note.phys .off-phys {
    color: var(--c-warning);
  }
  .note.phys .true-size {
    margin-left: auto;
    height: 20px;
    font-size: 11px;
    padding: 0 7px;
  }
  .note {
    margin: 6px 0 0;
    font-size: 11px;
    line-height: 1.4;
    color: var(--c-tx-muted);
  }
  .note.mono { font-family: var(--font-mono); }
  .video-properties .note { overflow-wrap: anywhere; }
  .part-id {
    display: flex;
    align-items: baseline;
    gap: 8px;
    font: 12px var(--font-mono);
    color: var(--c-accent-bright);
    margin-bottom: 4px;
    word-break: break-all;
  }
  .part-id .more { font-size: 10.5px; color: var(--c-tx-muted); }
  .crumb {
    margin: 0 0 6px;
    font-size: 11px;
    line-height: 1.5;
    color: var(--c-tx-muted);
  }
  code {
    font: 10px var(--font-mono);
  }
  input,
  select,
  textarea {
    background: var(--c-bg);
    border: 1px solid var(--c-line-strong);
    color: var(--c-tx);
    border-radius: var(--r-ui);
    height: 24px;
    padding: 0 6px;
    font: 12px var(--font-ui);
    width: 100%;
    box-sizing: border-box;
  }
  input:focus, select:focus, textarea:focus { outline: none; border-color: var(--c-accent); }
  input[type="checkbox"] {
    width: auto;
    height: auto;
    margin: 0;
    accent-color: var(--c-accent);
  }
  input[type="color"] { padding: 1px 2px; }
  textarea {
    resize: vertical;
    height: auto;
    padding: 4px 6px;
    line-height: 1.4;
    font-family: var(--font-ui);
  }
  .grid6 {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 3px;
    margin-bottom: 6px;
  }
  button {
    height: 24px;
    background: transparent;
    color: var(--c-tx-2);
    border: 1px solid var(--c-line-strong);
    border-radius: var(--r-ui);
    padding: 0 8px;
    font: 12px var(--font-ui);
    cursor: var(--cursor-cross-hover);
  }
  button:hover:not(:disabled) {
    border-color: var(--c-tx-muted);
    color: var(--c-tx-hi);
  }
  button:disabled {
    opacity: 0.4;
    cursor: var(--cursor-cross);
  }
  button.prim:hover:not(:disabled) {
    background: var(--c-accent-bright);
    border-color: var(--c-accent-bright);
    color: var(--c-on-accent);
  }
  .fig-act {
    width: 100%;
    margin-top: 6px;
  }
  /* Dissection count on the Dissections button (0 = no pill, the button still opens
     the create-folder empty state). */
  .dcount {
    margin-left: 6px;
    font: 10px var(--font-mono);
    color: var(--c-accent-bright);
    border: 1px solid var(--c-accent-tint);
    border-radius: var(--r-ui);
    padding: 0 5px;
  }
  /* Figure identity row — opens the Figure Namer (Ctrl+R). */
  .identity {
    display: flex;
    align-items: center; /* sans name + mono ref sit on one visual centre line, not two baselines */
    line-height: 1;
    gap: 8px;
    width: 100%;
    text-align: left;
    background: var(--c-bg);
    border: 1px solid var(--c-line-strong);
    border-radius: var(--r-ui);
    color: var(--c-tx);
    font: 12px var(--font-ui);
    height: 26px;
    padding: 0 8px;
    cursor: var(--cursor-cross-hover);
    margin-top: 6px;
  }
  .identity:hover {
    border-color: var(--c-accent);
  }
  .identity b {
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .identity .id-ref {
    margin-left: auto;
    color: var(--c-accent);
    font: 11px/1 var(--font-mono);
    flex: 0 0 auto;
    padding-top: 1px; /* optical: mono digits sit a hair high next to the sans name */
  }
  /* B/I/U toggles */
  .biu-row {
    align-items: flex-end;
  }
  .biu {
    flex: 0 0 auto;
    min-width: 26px;
    padding: 0 7px;
    line-height: 1;
  }
  .biu[aria-pressed="true"] {
    background: var(--c-accent-tint);
    border-color: var(--c-accent);
    color: var(--c-tx-hi);
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
    border-radius: var(--r-ui) 0 0 var(--r-ui);
  }
  .seg button:last-child {
    border-radius: 0 var(--r-ui) var(--r-ui) 0;
    border-right-width: 1px;
  }
  .seg button.on {
    background: var(--c-accent-tint);
    border-color: var(--c-accent);
    color: var(--c-tx-hi);
  }
  /* named-style picker + manage popover */
  .stylerow {
    display: flex;
    gap: 4px;
    align-items: center;
  }
  .gear {
    flex: 0 0 auto;
    padding: 0 7px;
  }
  .style-pop {
    margin: 6px 0;
    padding: 4px;
    border: 1px solid var(--c-line-strong);
    border-radius: var(--r-panel);
    background: var(--c-surface);
  }
  .style-row {
    display: flex;
    gap: 3px;
    align-items: center;
    margin-bottom: 3px;
  }
  .style-row .sname {
    flex: 1 1 60px;
    min-width: 40px;
  }
  .style-row button {
    flex: 0 0 auto;
    padding: 0 6px;
    font-size: 11px;
    height: 22px;
  }
  /* appearance rows: label · swatch · palette name · hex */
  .arow { display: flex; align-items: center; gap: 8px; min-height: 26px; }
  .al { width: 42px; flex: none; font-size: 11px; color: var(--c-tx-muted); }
  .swrow { flex: 1; display: flex; align-items: center; gap: 7px; height: 24px; padding: 0 6px; background: transparent; border: 1px solid transparent; text-align: left; min-width: 0; }
  .swrow:hover, .swrow.open { border-color: var(--c-line-strong); }
  .sw { width: 14px; height: 14px; border-radius: var(--r-ui); border: 1px solid color-mix(in oklab, var(--c-tx-hi) 14%, transparent); flex: none; }
  .sw.isnone { background: repeating-linear-gradient(-45deg, transparent 0 3px, var(--c-line-strong) 3px 4px); }
  .swname { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--c-tx); }
  .swhex { font: 10.5px var(--font-mono); color: var(--c-tx-muted); }
  .pop { margin: 4px 0 8px; padding: 8px; border: 1px solid var(--c-line-strong); border-radius: var(--r-panel); background: var(--c-surface); }
  /* the part fields: menu-letter · label · control */
  .pfields { display: flex; flex-direction: column; gap: 3px; margin: 6px 0; }
  .pf { display: grid; grid-template-columns: 16px minmax(0, 1fr) 96px; align-items: center; gap: 6px; min-height: 24px; }
  .pk { display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; font: 600 10px var(--font-mono); color: var(--c-accent); background: var(--c-accent-tint); border-radius: var(--r-ui); }
  .pl { font-size: 11.5px; color: var(--c-tx-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pc { display: flex; justify-content: flex-end; min-width: 0; }
  .pc :global(.nf) { flex: 1; }
  .pc :global(.nf .lb) { display: none; }
  .tgl { min-width: 44px; }
  .tgl.on { background: var(--c-accent-tint); border-color: var(--c-accent); color: var(--c-tx-hi); }
  .pf .swrow { width: 100%; }
</style>
