<script lang="ts">
  // Plot X-Ray (Alt+P): a floating cockpit over the selected semantic plot. The
  // left pane is the full grouped parts tree (axes → ticks/labels/gridlines/spine;
  // series → line/points/bars; legend → entries) with a visibility eye on every
  // node; the right pane edits the selected part's (or group's) properties. Edits
  // are durable overrides keyed by the part's stable semantic id (survive
  // save/reload AND regeneration). Mirrors Forgery's glass + self-drawing frame.
  import { fade } from "svelte/transition";
  import { get } from "svelte/store";
  import { project, selection, partSelection, xrayOpen } from "./store";
  import type { PartOverride, SemanticPlotElement } from "./types";
  import { plotManifests } from "./plot/store";
  import { buildPartTree, type XrayNode } from "./plot/tree";
  import { applyPartStyleTo } from "./colors";
  import { smoothstep } from "./motion/tokens";
  import { prefersReducedMotion } from "./motion/motion";
  import ColorSearch from "./ColorSearch.svelte";

  // The single selected semantic plot the X-Ray operates on.
  $: plotEl = (() => {
    const sel = $selection;
    if (sel.size !== 1) return null;
    for (const f of $project.figures)
      for (const e of f.elements) if (sel.has(e.id) && e.type === "plot") return e as SemanticPlotElement;
    return null;
  })();
  $: manifest = plotEl ? $plotManifests[plotEl.assetId] : undefined;
  $: tree = buildPartTree(manifest);

  let expanded = new Set<string>();
  let selectedId: string | null = null;
  let search = "";
  let mode: "tree" | "color" | "search" = "tree";
  let colorTargetKind: "fill" | "stroke" = "fill";
  let panelEl: HTMLDivElement;
  let searchEl: HTMLInputElement;
  let frameW = 0;
  let frameH = 0;

  let prevOpen = false;
  $: {
    if ($xrayOpen && !prevOpen) reset();
    prevOpen = $xrayOpen;
  }
  function reset() {
    search = "";
    mode = "tree";
    selectedId = null;
    const exp = new Set<string>();
    if (tree) {
      const seed = (n: XrayNode, d: number) => {
        if (d < 2 && n.children.length) exp.add(n.id);
        n.children.forEach((c) => seed(c, d + 1));
      };
      seed(tree, 0);
    }
    expanded = exp; // single assignment → tracked dependency fires once, fully seeded
    requestAnimationFrame(() => panelEl?.focus());
  }

  interface Row {
    node: XrayNode;
    depth: number;
  }
  function flatten(n: XrayNode, depth: number, out: Row[], exp: Set<string>) {
    out.push({ node: n, depth });
    if (n.children.length && exp.has(n.id)) for (const c of n.children) flatten(c, depth + 1, out, exp);
  }
  function searchRows(n: XrayNode, out: Row[], query: string) {
    if (n.label.toLowerCase().includes(query)) out.push({ node: n, depth: 0 });
    for (const c of n.children) searchRows(c, out, query);
  }
  $: q = search.trim().toLowerCase();
  // NOTE: `tree`, `q`, and `expanded` are passed as ARGUMENTS (not read inside the
  // helpers) so Svelte's `$:` dependency analysis tracks them — otherwise reads
  // hidden inside flatten() aren't seen and expand/collapse never re-renders.
  $: rows = buildRows(tree, q, expanded);
  function buildRows(t: XrayNode | null, query: string, exp: Set<string>): Row[] {
    if (!t) return [];
    const out: Row[] = [];
    if (query) searchRows(t, out, query);
    else flatten(t, 0, out, exp);
    return out;
  }

  function findNode(n: XrayNode | null, id: string | null): XrayNode | null {
    if (!n || !id) return null;
    if (n.id === id) return n;
    for (const c of n.children) {
      const r = findNode(c, id);
      if (r) return r;
    }
    return null;
  }
  $: selNode = findNode(tree, selectedId);
  // override map for the selected node (reactive on the element's overrides)
  $: ov = (plotEl && selectedId ? plotEl.overrides?.[selectedId] : undefined) ?? ({} as PartOverride);

  const TEXT = new Set(["axis-title", "title", "tick-label", "legend-label"]);
  const LINEY = new Set(["line", "reference-line", "gridline", "spine", "errorbar", "tick", "axis"]);
  const CONTAINER = new Set(["series", "plot-area", "figure", "legend", "legend-entry"]);
  $: kind = !selNode
    ? "none"
    : TEXT.has(selNode.role)
      ? "text"
      : CONTAINER.has(selNode.role)
        ? "container"
        : LINEY.has(selNode.role)
          ? "line"
          : "shape";

  function select(n: XrayNode) {
    selectedId = n.id;
    mode = "tree";
    if (plotEl) partSelection.set({ elementId: plotEl.id, partId: n.id });
  }
  function toggleExpand(n: XrayNode) {
    if (!n.children.length) return;
    if (expanded.has(n.id)) expanded.delete(n.id);
    else expanded.add(n.id);
    expanded = expanded;
  }
  function isHidden(n: XrayNode): boolean {
    return Boolean(plotEl?.overrides?.[n.id]?.hidden);
  }
  function toggleHidden(n: XrayNode) {
    if (plotEl) applyPartStyleTo(plotEl.id, n.id, { hidden: !isHidden(n) });
  }
  function patch(p: PartOverride) {
    if (plotEl && selectedId) applyPartStyleTo(plotEl.id, selectedId, p);
  }
  function numOr(v: unknown, fallback: string | number = ""): string | number {
    return typeof v === "number" ? v : fallback;
  }

  function openColor(t: "fill" | "stroke") {
    if (!selNode) return;
    colorTargetKind = t;
    mode = "color";
  }
  function backToTree() {
    mode = "tree";
    requestAnimationFrame(() => panelEl?.focus());
  }
  function enterSearch() {
    mode = "search";
    requestAnimationFrame(() => searchEl?.focus());
  }
  function close() {
    xrayOpen.set(false);
  }

  function onWin(e: KeyboardEvent) {
    if (!$xrayOpen || mode !== "tree") return;
    const k = e.key;
    if (k === "Escape" || k.toLowerCase() === "p") {
      e.preventDefault();
      e.stopImmediatePropagation();
      close();
      return;
    }
    if (k.toLowerCase() === "s") {
      e.preventDefault();
      e.stopImmediatePropagation();
      enterSearch();
      return;
    }
    if (k === "ArrowDown" || k === "ArrowUp") {
      e.preventDefault();
      const i = rows.findIndex((r) => r.node.id === selectedId);
      const ni = k === "ArrowDown" ? Math.min(rows.length - 1, i + 1) : Math.max(0, i - 1);
      if (rows[ni]) select(rows[ni].node);
    } else if (k === "ArrowRight" && selNode) {
      expanded.add(selNode.id);
      expanded = expanded;
    } else if (k === "ArrowLeft" && selNode) {
      expanded.delete(selNode.id);
      expanded = expanded;
    } else if (k.toLowerCase() === "x" && selNode) {
      e.preventDefault();
      toggleHidden(selNode);
    }
  }
  function onSearchKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      search = "";
      backToTree();
    } else if (e.key === "Enter" && rows[0]) {
      e.preventDefault();
      select(rows[0].node);
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const i = rows.findIndex((r) => r.node.id === selectedId);
      const ni = e.key === "ArrowDown" ? Math.min(rows.length - 1, i + 1) : Math.max(0, i - 1);
      if (rows[ni]) selectedId = rows[ni].node.id;
    }
  }

  // --- the self-drawing accent frame (from Forgery) ---
  const R3 = 14;
  function halfFrame(w: number, h: number, right: boolean, inset = 1.4): string {
    if (!w || !h) return "";
    const x0 = inset, y0 = inset, x1 = w - inset, y1 = h - inset;
    const r = Math.max(0, Math.min(R3 - inset, (x1 - x0) / 2, (y1 - y0) / 2));
    const cx = w / 2;
    return right
      ? `M ${cx} ${y0} L ${x1 - r} ${y0} A ${r} ${r} 0 0 1 ${x1} ${y0 + r} L ${x1} ${y1 - r} A ${r} ${r} 0 0 1 ${x1 - r} ${y1} L ${cx} ${y1}`
      : `M ${cx} ${y0} L ${x0 + r} ${y0} A ${r} ${r} 0 0 0 ${x0} ${y0 + r} L ${x0} ${y1 - r} A ${r} ${r} 0 0 0 ${x0 + r} ${y1} L ${cx} ${y1}`;
  }
  $: pathR = halfFrame(frameW, frameH, true);
  $: pathL = halfFrame(frameW, frameH, false);
  function forge(_node: HTMLElement) {
    if (prefersReducedMotion()) return { duration: 0 };
    const seg = (a: number, b: number, t: number) => smoothstep(Math.min(1, Math.max(0, (t - a) / (b - a))));
    return {
      duration: 180,
      css: (t: number) => {
        const panel = seg(0, 0.16, t);
        const draw = seg(0.04, 0.82, t);
        const content = seg(0.42, 1, t);
        return `opacity:${panel}; --draw:${draw}; --content:${content}; transform: scale(${0.978 + 0.022 * panel});`;
      },
    };
  }

  const FONTS = ["Lato", "Latin Modern Roman", "Arial", "Helvetica", "Georgia", "Times New Roman", "DejaVu Sans"];
</script>

<svelte:window on:keydown={onWin} />

{#if $xrayOpen}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="xbackdrop" transition:fade={{ duration: 110 }} on:pointerdown={close}></div>
  <div class="xwrap">
    <!-- svelte-ignore a11y_no_noninteractive_tabindex a11y_no_static_element_interactions -->
    <div
      class="xray"
      bind:this={panelEl}
      bind:clientWidth={frameW}
      bind:clientHeight={frameH}
      tabindex="-1"
      transition:forge
      on:pointerdown|stopPropagation
    >
      <svg class="frame" viewBox={`0 0 ${frameW || 1} ${frameH || 1}`} preserveAspectRatio="none" aria-hidden="true">
        <path class="fline" d={pathL} pathLength="100" />
        <path class="fline" d={pathR} pathLength="100" />
      </svg>
      <div class="xcontent">
        <div class="xhead">
          <span class="ttl">Plot X-Ray</span>
          <span class="sub">{plotEl ? plotEl.source?.svgPath ?? "plot" : "no plot selected"}</span>
        </div>

        {#if !plotEl || !tree}
          <div class="empty big">Select a single semantic plot, then press <b class="hk">P</b>.</div>
        {:else}
          <div class="search-row" class:active={mode === "search"}>
            <span class="hk">s</span>
            <input
              bind:this={searchEl}
              bind:value={search}
              class="search-in"
              placeholder="Search parts…"
              spellcheck="false"
              on:focus={() => (mode = "search")}
              on:keydown={onSearchKey}
            />
          </div>

          <div class="panes">
            <!-- LEFT: parts tree -->
            <div class="tree">
              {#each rows as r (r.node.id)}
                <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
                <div
                  class="row"
                  class:sel={selectedId === r.node.id}
                  style={`padding-left:${6 + r.depth * 14}px`}
                  on:click={() => select(r.node)}
                >
                  {#if r.node.children.length && !q}
                    <!-- svelte-ignore a11y_consider_explicit_label -->
                    <button class="tw" on:click|stopPropagation={() => toggleExpand(r.node)}>
                      {expanded.has(r.node.id) ? "▾" : "▸"}
                    </button>
                  {:else}
                    <span class="tw"></span>
                  {/if}
                  <button
                    class="eye"
                    class:off={isHidden(r.node)}
                    title="Show / hide (x)"
                    on:click|stopPropagation={() => toggleHidden(r.node)}>{isHidden(r.node) ? "○" : "◉"}</button
                  >
                  <span class="rlabel" class:dim={isHidden(r.node)}>{r.node.label}</span>
                  {#if r.node.isGroup && r.node.targets.length > 1}<span class="count">{r.node.targets.length}</span>{/if}
                </div>
              {/each}
            </div>

            <!-- RIGHT: properties -->
            <div class="props">
              {#if mode === "color" && selNode}
                <div class="phead">{colorTargetKind} colour</div>
                <ColorSearch target={colorTargetKind} onDone={backToTree} onCancel={backToTree} />
              {:else if selNode}
                <div class="phead">{selNode.label}<span class="prole">{selNode.role}</span></div>

                <div class="field">
                  <span class="label">visible</span>
                  <button class="toggle" class:on={!ov.hidden} on:click={() => patch({ hidden: !ov.hidden })}>
                    {ov.hidden ? "hidden" : "shown"}
                  </button>
                </div>
                <div class="field">
                  <span class="label">opacity</span>
                  <input
                    class="nin"
                    type="number"
                    min="0"
                    max="1"
                    step="0.05"
                    value={numOr(ov.opacity, 1)}
                    on:change={(e) => patch({ opacity: Number(e.currentTarget.value) })}
                  />
                </div>

                {#if kind === "text"}
                  <div class="field">
                    <span class="label">font size</span>
                    <input class="nin" type="number" min="1" step="1" value={numOr(ov.fontSize)} placeholder="—"
                      on:change={(e) => patch({ fontSize: Number(e.currentTarget.value) })} />
                  </div>
                  <div class="field">
                    <span class="label">font</span>
                    <select value={String(ov.fontFamily ?? "")} on:change={(e) => patch({ fontFamily: e.currentTarget.value })}>
                      <option value="">— default —</option>
                      {#each FONTS as f}<option value={f}>{f}</option>{/each}
                    </select>
                  </div>
                  <div class="field">
                    <span class="label">weight</span>
                    <select value={String(ov.fontWeight ?? "")} on:change={(e) => patch({ fontWeight: Number(e.currentTarget.value) })}>
                      <option value="">—</option>
                      <option value="400">Regular</option>
                      <option value="700">Bold</option>
                    </select>
                  </div>
                  <button class="colorbtn" on:click={() => openColor("fill")}>
                    <span class="dot" style={`background:${ov.fill ?? "transparent"}`}></span> text colour
                  </button>
                {:else if kind === "line"}
                  <button class="colorbtn" on:click={() => openColor("stroke")}>
                    <span class="dot" style={`background:${ov.stroke ?? "transparent"}`}></span> stroke colour
                  </button>
                  <div class="field">
                    <span class="label">stroke width</span>
                    <input class="nin" type="number" min="0" step="0.25" value={numOr(ov.strokeWidth)} placeholder="—"
                      on:change={(e) => patch({ strokeWidth: Number(e.currentTarget.value) })} />
                  </div>
                {:else if kind === "shape"}
                  <button class="colorbtn" on:click={() => openColor("fill")}>
                    <span class="dot" style={`background:${ov.fill ?? "transparent"}`}></span> fill colour
                  </button>
                  <button class="colorbtn" on:click={() => openColor("stroke")}>
                    <span class="dot" style={`background:${ov.stroke ?? "transparent"}`}></span> stroke colour
                  </button>
                  <div class="field">
                    <span class="label">stroke width</span>
                    <input class="nin" type="number" min="0" step="0.25" value={numOr(ov.strokeWidth)} placeholder="—"
                      on:change={(e) => patch({ strokeWidth: Number(e.currentTarget.value) })} />
                  </div>
                {:else}
                  <div class="note">A container — hide/opacity apply to everything inside.</div>
                {/if}
              {:else}
                <div class="empty">Select a part on the left.</div>
              {/if}
            </div>
          </div>
        {/if}

        <div class="foot">
          <span><b class="hk">↑↓</b> navigate</span>
          <span><b class="hk">x</b> hide</span>
          <span><b class="hk">s</b> search</span>
          <span><b class="hk">p</b>/esc close</span>
        </div>
      </div>
    </div>
  </div>
{/if}

<style>
  .xbackdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.14);
    z-index: 300;
  }
  .xwrap {
    position: fixed;
    inset: 0;
    z-index: 301;
    display: flex;
    align-items: center;
    justify-content: flex-end;
    padding-right: 26px;
    pointer-events: none;
  }
  @property --draw {
    syntax: "<number>";
    inherits: true;
    initial-value: 1;
  }
  @property --content {
    syntax: "<number>";
    inherits: true;
    initial-value: 1;
  }
  .xray {
    pointer-events: auto;
    position: relative;
    width: 560px;
    border-radius: var(--r-3);
    color: var(--c-tx);
    font-family: var(--font-serif);
    outline: none;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    max-height: 82vh;
    will-change: transform, opacity;
    background:
      linear-gradient(180deg, color-mix(in oklab, var(--c-tx-hi) 6%, transparent), transparent 42%),
      color-mix(in oklab, var(--c-surface) 95%, transparent);
    backdrop-filter: blur(16px) saturate(120%);
    -webkit-backdrop-filter: blur(16px) saturate(120%);
    box-shadow: var(--elev-3), 0 0 26px -6px var(--c-accent-glow);
  }
  .frame {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    z-index: 3;
    pointer-events: none;
    overflow: visible;
  }
  .fline {
    fill: none;
    stroke: var(--c-accent-bright);
    stroke-width: 2;
    stroke-linecap: round;
    vector-effect: non-scaling-stroke;
    stroke-dasharray: 100;
    stroke-dashoffset: calc((1 - var(--draw, 1)) * 100);
    filter: drop-shadow(0 0 2.5px var(--c-accent-glow));
  }
  .xcontent {
    display: flex;
    flex-direction: column;
    flex: 1 1 auto;
    min-height: 0;
    opacity: var(--content, 1);
    transform: translateY(calc((1 - var(--content, 1)) * 6px));
  }
  .hk {
    color: var(--c-accent-bright);
    font-weight: 700;
  }
  .xhead {
    display: flex;
    align-items: baseline;
    gap: 10px;
    padding: 14px 16px 4px;
  }
  .ttl {
    font-size: 18px;
    color: var(--c-tx-hi);
  }
  .sub {
    font-size: 12px;
    color: var(--c-tx-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .search-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 8px 12px;
    padding: 7px 12px;
    background: color-mix(in oklab, var(--c-tx-hi) 4%, transparent);
    border: 1px solid var(--c-line);
    border-radius: 8px;
  }
  .search-row.active {
    border-color: var(--c-accent);
    box-shadow: 0 0 0 2px var(--c-accent-tint);
  }
  .search-in {
    flex: 1;
    background: none;
    border: none;
    outline: none;
    color: var(--c-tx);
    font-size: 15px;
    font-family: inherit;
  }
  .panes {
    display: grid;
    grid-template-columns: 1fr 220px;
    gap: 0;
    min-height: 0;
    flex: 1 1 auto;
  }
  .tree {
    overflow-y: auto;
    padding: 4px 4px 8px;
    border-right: 1px solid var(--c-line);
  }
  .row {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 3px 6px;
    border-radius: 6px;
    cursor: pointer;
    font-size: 13.5px;
  }
  .row:hover {
    background: var(--c-surface-2);
  }
  .row.sel {
    background: var(--c-accent);
    color: var(--c-on-accent);
  }
  .tw {
    width: 14px;
    flex: 0 0 14px;
    background: none;
    border: none;
    color: inherit;
    cursor: pointer;
    font-size: 10px;
    padding: 0;
    opacity: 0.7;
  }
  .eye {
    width: 16px;
    flex: 0 0 16px;
    background: none;
    border: none;
    color: var(--c-accent-bright);
    cursor: pointer;
    padding: 0;
    font-size: 12px;
  }
  .row.sel .eye {
    color: var(--c-on-accent);
  }
  .eye.off {
    color: var(--c-tx-faint);
  }
  .rlabel {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .rlabel.dim {
    opacity: 0.45;
    text-decoration: line-through;
  }
  .count {
    font-size: 11px;
    opacity: 0.5;
    font-variant-numeric: tabular-nums;
  }
  .props {
    overflow-y: auto;
    padding: 8px 12px;
  }
  .phead {
    font-style: italic;
    font-size: 14px;
    color: var(--c-tx-hi);
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    margin-bottom: 8px;
  }
  .prole {
    font-size: 11px;
    font-style: normal;
    color: var(--c-tx-muted);
  }
  .field {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 7px;
  }
  .label {
    font-style: italic;
    font-size: 13px;
  }
  .nin,
  select {
    width: 110px;
    background: var(--c-bg-raised);
    border: 1px solid var(--c-line-strong);
    border-radius: 6px;
    color: var(--c-tx);
    padding: 4px 7px;
    font-size: 13px;
    font-family: inherit;
    outline: none;
  }
  .nin:focus,
  select:focus {
    border-color: var(--c-accent);
  }
  .toggle {
    width: 110px;
    background: var(--c-bg-raised);
    border: 1px solid var(--c-line-strong);
    border-radius: 6px;
    color: var(--c-tx);
    padding: 4px 7px;
    cursor: pointer;
    font-family: inherit;
    font-style: italic;
  }
  .toggle.on {
    background: var(--c-accent);
    border-color: var(--c-accent);
    color: var(--c-on-accent);
  }
  .colorbtn {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    background: var(--c-bg-raised);
    border: 1px solid var(--c-line-strong);
    border-radius: 6px;
    color: var(--c-tx);
    cursor: pointer;
    font-family: inherit;
    font-style: italic;
    padding: 5px 8px;
    margin-bottom: 7px;
  }
  .dot {
    width: 15px;
    height: 15px;
    border-radius: 50%;
    border: 1px solid var(--c-line-strong);
  }
  .note {
    font-size: 12px;
    color: var(--c-tx-muted);
    font-style: italic;
    padding: 4px 0;
  }
  .empty {
    color: var(--c-tx-muted);
    padding: 12px 4px;
    font-style: italic;
  }
  .empty.big {
    padding: 30px 16px;
    text-align: center;
  }
  .foot {
    display: flex;
    gap: 14px;
    padding: 8px 16px;
    border-top: 1px solid var(--c-line);
    font-size: 12px;
    color: var(--c-tx-muted);
  }
</style>
