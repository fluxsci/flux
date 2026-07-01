<script lang="ts">
  import { get } from "svelte/store";
  import { project, selection, partSelection, activeFigureId, commit, mutate, lastArrangeRows, duplicateFigure, autoLetterPanels } from "./store";
  import type { Element } from "./types";
  import { doAlign, doDistribute, arrangeToRows } from "./keyboard";
  import { validRowCounts, gridItemCount, balancedRows } from "./geometry";
  import { exportFigurePng, exportFigureSvg, exportFigurePdf } from "./io";
  import { applyAutoWidth } from "./text";
  import { applyPartStyle } from "./colors";
  import { plotManifests } from "./plot/store";
  import { buildPartIndex } from "./plot/parse";
  import ColorPalette from "./ColorPalette.svelte";
  import NumberField from "./NumberField.svelte";

  // Reactive view of the current selection / active figure.
  $: sel = (() => {
    const out: Element[] = [];
    for (const f of $project.figures)
      for (const e of f.elements) if ($selection.has(e.id)) out.push(e);
    return out;
  })();
  $: single = sel.length === 1 ? sel[0] : null;
  $: fig = $project.figures.find((f) => f.id === $activeFigureId) ?? null;

  // Arrange controls (mouse equivalents of the Alt+G grid mode). `arrN` is the
  // number of layout cells (a group counts once); the section hides below 2.
  $: arrN = sel.length >= 2 ? gridItemCount(sel) : 0;
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
  $: partLabel = partInfo
    ? [partInfo.role, partInfo.series, partInfo.index !== undefined ? `#${partInfo.index}` : null]
        .filter(Boolean)
        .join(" · ")
    : "";
  $: partColor = (() => {
    const ps = $partSelection;
    if (!ps || !plotEl || plotEl.type !== "plot") return "#cc0000";
    const ov = plotEl.overrides?.[ps.partId];
    return (ov?.fill as string) || (ov?.stroke as string) || "#cc0000";
  })();

  const TEXT_ROLES = new Set(["axis-title", "tick-label", "title", "label", "legend-label"]);
  const LINE_ROLES = new Set(["line", "reference-line", "axis", "gridline", "spine", "errorbar"]);
  function recolorPart(hex: string) {
    const role = partInfo?.role ?? "";
    if (TEXT_ROLES.has(role)) applyPartStyle({ fill: hex });
    else if (LINE_ROLES.has(role)) applyPartStyle({ stroke: hex });
    else applyPartStyle({ fill: hex, stroke: hex });
  }

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

  function updateSelected(fn: (e: Element) => void) {
    const ids = get(selection);
    commit((p) => {
      for (const f of p.figures)
        for (const e of f.elements)
          if (ids.has(e.id)) {
            fn(e);
            applyAutoWidth(e);
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
  function scrubSelected(fn: (e: Element) => void) {
    const ids = get(selection);
    mutate((p) => {
      for (const f of p.figures)
        for (const e of f.elements)
          if (ids.has(e.id)) {
            fn(e);
            applyAutoWidth(e);
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
</script>

<aside class="inspector">
  <!-- ALIGN -->
  <section>
    <h4>Align</h4>
    <div class="grid6">
      <button title="Left (Alt+A)" on:click={() => doAlign("left")}>⊢</button>
      <button title="Center H (Alt+H)" on:click={() => doAlign("centerH")}>↔</button>
      <button title="Right (Alt+D)" on:click={() => doAlign("right")}>⊣</button>
      <button title="Top (Alt+W)" on:click={() => doAlign("top")}>⊤</button>
      <button title="Middle V (Alt+V)" on:click={() => doAlign("centerV")}>↕</button>
      <button title="Bottom (Alt+S)" on:click={() => doAlign("bottom")}>⊥</button>
    </div>
    <div class="row">
      <button on:click={() => doDistribute("h")}>Distribute H</button>
      <button on:click={() => doDistribute("v")}>Distribute V</button>
    </div>
  </section>

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
      {#if partInfo.x !== undefined && partInfo.y !== undefined}
        <p class="note">data: x = {partInfo.x}, y = {partInfo.y}</p>
      {/if}
      <label class="full">Colour
        <input type="color" value={partColor} on:change={(e) => recolorPart(e.currentTarget.value)} />
      </label>
      <p class="note">override <code>{partInfo.id}</code> — survives regeneration</p>
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
        <div class="row">
          <NumberField label="W" value={single.width} min={1}
            on:commit={(e) => updateSelected((el) => { if ("width" in el) el.width = e.detail; })}
            on:scrub={(e) => scrubSelected((el) => { if ("width" in el) el.width = e.detail; })} />
          <NumberField label="H" value={single.height} min={1}
            on:commit={(e) => updateSelected((el) => { if ("height" in el) el.height = e.detail; })}
            on:scrub={(e) => scrubSelected((el) => { if ("height" in el) el.height = e.detail; })} />
        </div>
      {/if}
    </section>
  {:else if sel.length > 1}
    <section><h4>{sel.length} selected</h4></section>
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
      <div class="row">
        <NumberField label="Size" value={single.fontSize} min={1}
          on:commit={(e) => updateSelected((el) => { if (el.type === "text") el.fontSize = e.detail; })}
          on:scrub={(e) => scrubSelected((el) => { if (el.type === "text") el.fontSize = e.detail; })} />
        <label>Weight
          <select value={single.fontWeight} on:change={(e) => updateSelected((el) => { if (el.type === "text") el.fontWeight = parseInt(e.currentTarget.value); })}>
            <option value="400">Regular</option>
            <option value="700">Bold</option>
          </select>
        </label>
      </div>
      <div class="row">
        <label>Font
          <select value={single.fontFamily} on:change={(e) => updateSelected((el) => { if (el.type === "text") el.fontFamily = e.currentTarget.value; })}>
            <option>Arial</option><option>Helvetica</option><option>Times New Roman</option>
            <option>Georgia</option><option>Courier New</option><option>Verdana</option>
          </select>
        </label>
        <label>Align
          <select value={single.align} on:change={(e) => updateSelected((el) => { if (el.type === "text") el.align = e.currentTarget.value as "left" | "center" | "right"; })}>
            <option value="left">Left</option><option value="center">Center</option><option value="right">Right</option>
          </select>
        </label>
      </div>
      <label class="chk">
        <input
          type="checkbox"
          checked={single.autoWidth}
          on:change={(e) => updateSelected((el) => { if (el.type === "text") el.autoWidth = e.currentTarget.checked; })}
        />
        Auto width
      </label>
    </section>
  {/if}

  <!-- PANEL LABEL (caption) -->
  {#if textSel.length > 0}
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
      {#if single.type === "line"}
        <div class="row">
          <label class="chk"><input type="checkbox" checked={single.arrowStart} on:change={(e) => updateSelected((el) => { if (el.type === "line") el.arrowStart = e.currentTarget.checked; })} />Arrow start</label>
          <label class="chk"><input type="checkbox" checked={single.arrowEnd} on:change={(e) => updateSelected((el) => { if (el.type === "line") el.arrowEnd = e.currentTarget.checked; })} />Arrow end</label>
        </div>
      {/if}
    </section>
  {/if}

  <!-- COLOR PALETTE -->
  <ColorPalette />

  <!-- FIGURE -->
  {#if fig}
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
      <label class="full">Background
        <input type="color" value={fig.background === "transparent" ? "#ffffff" : fig.background} on:change={(e) => updateFigure((f) => (f.background = e.currentTarget.value))} />
      </label>
      <button class="fig-act" on:click={() => duplicateFigure(fig.id)}>Duplicate figure</button>
      <button class="fig-act" on:click={() => autoLetterPanels(fig.id)}>Auto-letter panels (a, b, c)</button>
    </section>

    <!-- EXPORT -->
    <section>
      <h4>Export “{fig.name}”</h4>
      <label class="full">PNG resolution
        <select bind:value={dpi}>
          <option value={150}>150 dpi</option>
          <option value={300}>300 dpi</option>
          <option value={600}>600 dpi</option>
        </select>
      </label>
      <div class="row">
        <button on:click={() => exportFigurePng(fig, dpi / 96)}>PNG</button>
        <button on:click={() => exportFigureSvg(fig)}>SVG</button>
        <button on:click={() => exportFigurePdf(fig)}>PDF</button>
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
  .row {
    display: flex;
    gap: 6px;
    margin-bottom: 6px;
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
  .fig-act {
    width: 100%;
    margin-top: 6px;
  }
</style>
