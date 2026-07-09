<script lang="ts">
  // X-Ray (Alt+P) — figure-v1 P8. One radiograph panel over ANY x-rayable
  // target: a semantic plot (its manifest part tree), a group (nested child
  // groups + member elements, plots expanding in place under their own figure
  // root), or a single element. STRUCTURE + SHOW/HIDE ONLY — the property
  // editors are gone; "Show Properties" (Enter) sets the selection for the row
  // and opens the FluxFig Menu ON TOP. Ctrl-click / Ctrl+Enter re-roots the
  // panel on that row's node "as if x-rayed alone" (breadcrumb + Backspace pop
  // the root stack). Eye / 'x' dispatch per row kind: part → id-keyed override,
  // element → hidden flag, group → GroupDef eye. Regenerate stays, gated on a
  // recipe-backed plot root. Always dark — an x-ray screen by nature.
  import { fade } from "svelte/transition";
  import { get } from "svelte/store";
  import {
    project,
    selection,
    partSelection,
    xrayOpen,
    xrayRoot,
    selectOnly,
    commit,
  } from "./store";
  import type { SemanticPlotElement } from "./types";
  import { plotManifests, plotRecipes } from "./plot/store";
  import { buildXrayTree, targetLabel, type XRow, type XrayTarget } from "./xray/buildXrayTree";
  import { membersDeep } from "./groups";
  import { applyPartStyleTo } from "./colors";
  import * as ops from "./ops";
  import { halfFrame, drawForge as forge } from "./motion/selfDraw";
  import { reimportPlot } from "./io";
  import { fileBridge } from "./project/types";
  import { fluxFigMenuOpen, settings, popupLayout } from "./settings";
  import type { FluxPlotManifest } from "./plot/types";

  // --- the pinned root + its tree -----------------------------------------
  $: root = $xrayRoot;
  $: tree = buildXrayTree($project, root, $plotManifests);

  // Parents of the current root (ctrl-click re-root pushes; Backspace pops).
  let rootStack: XrayTarget[] = [];
  $: crumbs = [...rootStack, ...(root ? [root] : [])].map((t) => targetLabel($project, t, $plotManifests));

  // The root ELEMENT when rooted on a plot (drives the sub-line + Regenerate).
  $: rootPlot = (() => {
    if (!root || root.kind !== "element") return null;
    const f = $project.figures.find((ff) => ff.id === root.figId);
    const el = f?.elements.find((e) => e.id === root.elementId);
    return el && el.type === "plot" ? (el as SemanticPlotElement) : null;
  })();

  // F2 Regenerate: re-run the plot's recipe and hot-swap the result in place,
  // preserving the id-keyed overrides. Gated behind this explicit action (never
  // auto-runs user code) AND on a recipe-backed plot root.
  $: recipe = (rootPlot ? $plotRecipes[rootPlot.assetId] : undefined) as
    | { params?: Record<string, unknown>; lastRun?: string }
    | undefined;
  $: recipePath = rootPlot?.source?.recipePath;
  let regenBusy = false;
  let regenMsg = "";
  async function regenerate() {
    const fb = fileBridge();
    if (!rootPlot || !recipePath || !fb?.runRecipe) {
      regenMsg = "no recipe";
      return;
    }
    regenBusy = true;
    regenMsg = "";
    try {
      const res = await fb.runRecipe(recipePath, (recipe?.params ?? {}) as Record<string, unknown>);
      // FIG-14: surface the REAL failure instead of a bare "error" — the recipe's stderr on a
      // non-zero exit, and the actual exception message if the output JSON won't parse.
      if (res.code !== 0) {
        const why = String(res.stderr ?? "").trim();
        regenMsg = "recipe failed" + (why ? `: ${why.slice(-200)}` : ` (exit ${res.code})`);
      } else if (res.svgText && res.manifestText) {
        reimportPlot(
          rootPlot.assetId,
          res.svgText,
          JSON.parse(res.manifestText) as FluxPlotManifest,
          res.recipeText ? JSON.parse(res.recipeText) : undefined,
        );
        regenMsg = "regenerated ✓";
      } else regenMsg = "no output";
    } catch (e) {
      regenMsg = "error: " + String((e as Error)?.message ?? e);
    }
    regenBusy = false;
  }

  let expanded = new Set<string>();
  let selectedId: string | null = null;
  let search = "";
  let mode: "tree" | "search" = "tree";
  let panelEl: HTMLDivElement;
  let searchEl: HTMLInputElement;
  let frameW = 0;
  let frameH = 0;

  let prevOpen = false;
  $: {
    if ($xrayOpen && !prevOpen) reset();
    prevOpen = $xrayOpen;
  }
  // Focus returns to the panel when the FluxFig Menu (opened ON TOP by Show
  // Properties) closes — the keyboard picks up exactly where it left off.
  let prevMenu = false;
  $: {
    if ($xrayOpen && prevMenu && !$fluxFigMenuOpen) requestAnimationFrame(() => panelEl?.focus());
    prevMenu = $fluxFigMenuOpen;
  }
  function seedExpanded(t: XRow | null) {
    const exp = new Set<string>();
    if (t) {
      const seed = (n: XRow, d: number) => {
        if (d < 2 && n.children.length) exp.add(n.id);
        n.children.forEach((c) => seed(c, d + 1));
      };
      seed(t, 0);
    }
    expanded = exp; // single assignment → tracked dependency fires once, fully seeded
  }
  function reset() {
    search = "";
    mode = "tree";
    rootStack = [];
    seedExpanded(tree);
    // A drilled part carries into the opened tree pre-selected + revealed.
    const ps = get(partSelection);
    selectedId = null;
    if (ps && root?.kind === "element" && root.elementId === ps.elementId)
      revealRow(`part:${ps.elementId}__${ps.partId}`);
    requestAnimationFrame(() => panelEl?.focus());
  }

  interface Row {
    node: XRow;
    depth: number;
  }
  function flatten(n: XRow, depth: number, out: Row[], exp: Set<string>) {
    out.push({ node: n, depth });
    if (n.children.length && exp.has(n.id)) for (const c of n.children) flatten(c, depth + 1, out, exp);
  }
  function searchRows(n: XRow, out: Row[], query: string) {
    if (n.label.toLowerCase().includes(query)) out.push({ node: n, depth: 0 });
    for (const c of n.children) searchRows(c, out, query);
  }
  $: q = search.trim().toLowerCase();
  // NOTE: `tree`, `q`, and `expanded` are passed as ARGUMENTS (not read inside the
  // helpers) so Svelte's `$:` dependency analysis tracks them — otherwise reads
  // hidden inside flatten() aren't seen and expand/collapse never re-renders.
  $: rows = buildRows(tree, q, expanded);
  function buildRows(t: XRow | null, query: string, exp: Set<string>): Row[] {
    if (!t) return [];
    const out: Row[] = [];
    if (query) searchRows(t, out, query);
    else flatten(t, 0, out, exp);
    return out;
  }

  function findRow(n: XRow | null, id: string | null): XRow | null {
    if (!n || !id) return null;
    if (n.id === id) return n;
    for (const c of n.children) {
      const r = findRow(c, id);
      if (r) return r;
    }
    return null;
  }
  $: selRow = findRow(tree, selectedId);

  /** Expand every ancestor of a row id and select it (re-root landing / open
   *  with a drilled part). Row ids are stable across re-roots, so the path is
   *  recomputed against the CURRENT tree. */
  function revealRow(rowId: string) {
    const path: string[] = [];
    const dfs = (n: XRow | null): boolean => {
      if (!n) return false;
      if (n.id === rowId) return true;
      for (const c of n.children) {
        if (dfs(c)) {
          path.push(n.id);
          return true;
        }
      }
      return false;
    };
    if (!dfs(tree)) return;
    for (const id of path) expanded.add(id);
    expanded = expanded;
    selectedId = rowId;
  }

  // --- row → canvas selection ----------------------------------------------
  function applySelection(n: XRow) {
    if (n.kind === "part" && n.elementId && n.partId) {
      selectOnly(n.elementId);
      partSelection.set({ elementId: n.elementId, partId: n.partId });
    } else if (n.kind === "element" && n.elementId) {
      selectOnly(n.elementId);
    } else if (n.kind === "group" && n.groupId && root) {
      const fig = get(project).figures.find((f) => f.id === root.figId);
      if (!fig) return;
      const members = membersDeep(fig, n.groupId).map((e) => e.id);
      if (!members.length) return;
      selectOnly(members[0]); // clears part/frame selection
      selection.set(new Set(members));
    }
  }
  function select(n: XRow) {
    selectedId = n.id;
    mode = "tree";
    applySelection(n);
  }

  // --- Show Properties: selection per row kind → FluxFig Menu ON TOP --------
  function showProperties(n: XRow | null) {
    if (!n) return;
    selectedId = n.id;
    applySelection(n);
    if (n.kind === "group" && get(selection).size === 0) return; // empty group: nothing to edit
    fluxFigMenuOpen.set(true);
  }

  // --- ctrl-click / Ctrl+Enter re-root ("as if x-rayed alone") --------------
  function reRoot(n: XRow | null) {
    if (!n || !root) return;
    const figId = root.figId;
    let target: XrayTarget | null = null;
    if (n.kind === "group" && n.groupId) target = { kind: "group", figId, groupId: n.groupId };
    else if (n.elementId) target = { kind: "element", figId, elementId: n.elementId };
    if (!target) return;
    if (
      (root.kind === "element" && target.kind === "element" && root.elementId === target.elementId) ||
      (root.kind === "group" && target.kind === "group" && root.groupId === target.groupId)
    ) {
      if (n.kind === "part") revealRow(n.id); // already rooted here — just land on the part
      return;
    }
    rootStack = [...rootStack, root];
    xrayRoot.set(target);
    // After the tree re-derives: land on the part (pre-expanded/selected), or
    // seed the fresh root's default expansion.
    requestAnimationFrame(() => {
      seedExpanded(tree);
      if (n.kind === "part") revealRow(n.id);
      else selectedId = tree?.id ?? null;
    });
  }
  function popRoot() {
    if (!rootStack.length) return;
    const t = rootStack[rootStack.length - 1];
    rootStack = rootStack.slice(0, -1);
    xrayRoot.set(t);
    requestAnimationFrame(() => seedExpanded(tree));
  }
  function popTo(i: number) {
    // crumbs[i] clicked: i === rootStack.length is the current root (no-op).
    if (i >= rootStack.length) return;
    const t = rootStack[i];
    rootStack = rootStack.slice(0, i);
    xrayRoot.set(t);
    requestAnimationFrame(() => seedExpanded(tree));
  }

  function toggleExpand(n: XRow) {
    if (!n.children.length) return;
    if (expanded.has(n.id)) expanded.delete(n.id);
    else expanded.add(n.id);
    expanded = expanded;
  }

  // --- eye / 'x': per-row-kind hide dispatch ---------------------------------
  function toggleHidden(n: XRow) {
    if (n.kind === "part" && n.elementId && n.partId) {
      applyPartStyleTo(n.elementId, n.partId, { hidden: !n.hidden });
    } else if (n.kind === "element" && n.elementId) {
      const id = n.elementId;
      const hide = !n.hidden;
      commit((p) => ops.setElementStyle(p, [id], { hidden: hide }));
    } else if (n.kind === "group" && n.groupId) {
      const gid = n.groupId;
      const hide = !n.hidden;
      commit((p) => ops.setGroupState(p, gid, { hidden: hide }));
    }
  }

  function enterSearch() {
    mode = "search";
    requestAnimationFrame(() => searchEl?.focus());
  }
  function backToTree() {
    mode = "tree";
    requestAnimationFrame(() => panelEl?.focus());
  }
  function close() {
    xrayOpen.set(false);
  }

  function onRowClick(e: MouseEvent, n: XRow) {
    if (e.ctrlKey || e.metaKey) reRoot(n);
    else select(n);
  }

  function onWin(e: KeyboardEvent) {
    // The FluxFig Menu (opened ON TOP by Show Properties) owns the keyboard
    // while it is up — everything here yields until it closes.
    if (!$xrayOpen || $fluxFigMenuOpen || mode !== "tree") return;
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
    if (k === "Enter") {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) reRoot(selRow);
      else showProperties(selRow);
      return;
    }
    if (k === "Backspace") {
      e.preventDefault();
      if (search) search = "";
      else popRoot();
      return;
    }
    if (k === "ArrowDown" || k === "ArrowUp") {
      e.preventDefault();
      const i = rows.findIndex((r) => r.node.id === selectedId);
      const ni = k === "ArrowDown" ? Math.min(rows.length - 1, i + 1) : Math.max(0, i - 1);
      if (rows[ni]) select(rows[ni].node);
    } else if (k === "ArrowRight" && selRow) {
      expanded.add(selRow.id);
      expanded = expanded;
    } else if (k === "ArrowLeft" && selRow) {
      expanded.delete(selRow.id);
      expanded = expanded;
    } else if (k.toLowerCase() === "x" && selRow) {
      e.preventDefault();
      toggleHidden(selRow);
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
      backToTree();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const i = rows.findIndex((r) => r.node.id === selectedId);
      const ni = e.key === "ArrowDown" ? Math.min(rows.length - 1, i + 1) : Math.max(0, i - 1);
      if (rows[ni]) selectedId = rows[ni].node.id;
    }
  }

  // --- the self-drawing accent frame (shared with FluxFig Menu; see selfDraw.ts) ---
  $: pathR = halfFrame(frameW, frameH, true);
  $: pathL = halfFrame(frameW, frameH, false);

  // Panel position: docked above/below the FluxFig menu's configured spot
  // (popupLayout — one helper keeps the pair in lockstep). Lives on the
  // wrapper (like FluxFigMenu) so it never fights the panel's transition.
  $: layout = popupLayout($settings);
</script>

<svelte:window on:keydown={onWin} />

{#if $xrayOpen}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="xbackdrop" transition:fade={{ duration: 110 }} on:pointerdown={close}></div>
  <div class="xwrap" style={layout.xrayWrap}>
    <!-- svelte-ignore a11y_no_noninteractive_tabindex a11y_no_static_element_interactions -->
    <div
      class="xray"
      bind:this={panelEl}
      bind:clientWidth={frameW}
      bind:clientHeight={frameH}
      tabindex="-1"
      style={`width:${layout.width}px; max-height:${layout.xrayMax};`}
      transition:forge
      on:pointerdown|stopPropagation
    >
      <svg class="frame" viewBox={`0 0 ${frameW || 1} ${frameH || 1}`} preserveAspectRatio="none" aria-hidden="true">
        <path class="fline" d={pathL} pathLength="100" />
        <path class="fline" d={pathR} pathLength="100" />
      </svg>
      <div class="xcontent">
        <div class="xhead">
          <span class="ttl">X-Ray</span>
          <span class="crumbs">
            {#each crumbs as c, i}
              {#if i > 0}<span class="csep">›</span>{/if}
              <button class="crumb" class:cur={i === crumbs.length - 1} on:click={() => popTo(i)}>{c}</button>
            {/each}
            {#if !crumbs.length}<span class="csub">no target</span>{/if}
          </span>
          {#if rootPlot && recipePath}
            <button class="regen" on:click={regenerate} disabled={regenBusy} title={recipePath}>
              {regenBusy ? "Regenerating…" : regenMsg || "Regenerate"}
            </button>
          {/if}
        </div>
        {#if rootPlot?.source?.svgPath}
          <div class="srcline">{rootPlot.source.svgPath}</div>
        {/if}

        {#if !tree}
          <div class="empty big">Select a plot or a group, then press <b class="hk">alt+P</b>.</div>
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

          <div class="tree">
            {#each rows as r (r.node.id)}
              <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
              <div
                class="row"
                class:sel={selectedId === r.node.id}
                data-kind={r.node.kind}
                data-rid={r.node.id}
                style={`padding-left:${6 + r.depth * 14}px`}
                on:click={(e) => onRowClick(e, r.node)}
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
                  class:off={r.node.hidden}
                  title="Show / hide (x)"
                  on:click|stopPropagation={() => toggleHidden(r.node)}>{r.node.hidden ? "○" : "◉"}</button
                >
                <span class="rlabel" class:dim={r.node.hidden}>{r.node.label}</span>
                {#if r.node.kind === "group"}<span class="tag">grp</span>{/if}
                {#if r.node.count}<span class="count">{r.node.count}</span>{/if}
              </div>
            {/each}
          </div>

          <div class="actions">
            <button class="showprops" disabled={!selRow} on:click={() => showProperties(selRow)}>
              Show Properties <span class="hk">↵</span>
            </button>
          </div>
        {/if}

        <div class="foot">
          <span><b class="hk">↑↓</b> navigate</span>
          <span><b class="hk">x</b> hide</span>
          <span><b class="hk">ctrl+click</b> re-root</span>
          <span><b class="hk">⌫</b> back</span>
          <span><b class="hk">s</b> search</span>
          <span><b class="hk">p</b>/esc close</span>
        </div>
      </div>
    </div>
  </div>
{/if}

<style>
  /* ==========================================================================
     Radiograph theme — an actual x-ray screen: near-black blue field, phosphor
     glow, static scanlines + vignette, mono type. Always dark by nature (uses
     the --xr-* tokens directly, never the theme-scoped --c-* ramp). CSS-only;
     the selfDraw motion machinery is untouched. backdrop-filter deliberately
     DELETED (perf: no live blur layer behind the panel).
     ========================================================================== */
  .xbackdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.3);
    z-index: 290;
  }
  .xwrap {
    /* Sits UNDER the FluxFig Menu (300/301): Show Properties opens it on top.
       Alignment + nudge come from Settings via the inline style. */
    position: fixed;
    inset: 0;
    z-index: 291;
    display: flex;
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
    color: var(--xr-tx);
    font-family: var(--font-mono);
    outline: none;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    max-height: 82vh;
    will-change: transform, opacity;
    /* phosphor wash pooling at the top of a near-black tube */
    background:
      radial-gradient(120% 90% at 50% 0%, color-mix(in oklab, var(--xr-phos) 11%, transparent), transparent 55%),
      linear-gradient(180deg, var(--xr-bg-2), var(--xr-bg) 62%);
    border: 1px solid var(--xr-line);
    box-shadow:
      var(--elev-3),
      0 0 34px -6px var(--xr-glow),
      inset 0 0 70px -34px var(--xr-glow);
  }
  /* Static scanlines + vignette: one pseudo-layer OVER the content (CRT glass),
     UNDER the selfDraw frame (z 3). Static gradients only — zero animation cost
     at rest; the one-shot boot flicker below ends and leaves getAnimations(). */
  .xray::after {
    content: "";
    position: absolute;
    inset: 0;
    z-index: 2;
    pointer-events: none;
    border-radius: inherit;
    background:
      repeating-linear-gradient(
        0deg,
        rgba(207, 233, 227, 0.03) 0px,
        rgba(207, 233, 227, 0.03) 1px,
        transparent 1px,
        transparent 3px
      ),
      radial-gradient(130% 115% at 50% 42%, transparent 58%, rgba(0, 5, 8, 0.42) 100%);
    animation: xr-boot 340ms linear 1;
  }
  /* One-shot CRT boot: the tube sputters alive, ~340ms, then rests forever
     (default fill-mode none ⇒ the finished animation leaves getAnimations()). */
  @keyframes xr-boot {
    0% {
      opacity: 0;
    }
    9% {
      opacity: 1;
    }
    16% {
      opacity: 0.25;
    }
    28% {
      opacity: 0.95;
    }
    41% {
      opacity: 0.45;
    }
    58% {
      opacity: 1;
    }
    72% {
      opacity: 0.78;
    }
    100% {
      opacity: 1;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .xray::after {
      animation: none;
    }
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
    stroke: var(--xr-phos-hi);
    stroke-width: 2;
    stroke-linecap: round;
    vector-effect: non-scaling-stroke;
    stroke-dasharray: 100;
    stroke-dashoffset: calc((1 - var(--draw, 1)) * 100);
    filter: drop-shadow(0 0 3px var(--xr-glow));
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
    color: var(--xr-phos-hi);
    font-weight: 700;
  }
  .xhead {
    display: flex;
    align-items: baseline;
    gap: 10px;
    padding: 14px 16px 2px;
    min-width: 0;
  }
  .ttl {
    font-size: 13px;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--xr-tx);
    text-shadow: 0 0 9px var(--xr-glow);
    flex: 0 0 auto;
  }
  .crumbs {
    display: flex;
    align-items: baseline;
    gap: 4px;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    font-size: 11.5px;
  }
  .crumb {
    background: none;
    border: none;
    padding: 0;
    font: inherit;
    color: var(--xr-tx-dim);
    cursor: pointer;
    max-width: 160px;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .crumb:hover {
    color: var(--xr-phos-hi);
    text-shadow: 0 0 6px var(--xr-glow);
  }
  .crumb.cur {
    color: var(--xr-tx);
    cursor: default;
    text-shadow: 0 0 6px var(--xr-glow);
  }
  .csep {
    color: var(--xr-tx-dim);
    flex: 0 0 auto;
  }
  .csub {
    color: var(--xr-tx-dim);
    font-style: italic;
  }
  .srcline {
    padding: 0 16px 2px;
    font-size: 10.5px;
    color: var(--xr-tx-dim);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .regen {
    margin-left: auto;
    flex: 0 0 auto;
    align-self: center;
    background: transparent;
    color: var(--xr-phos-hi);
    border: 1px solid var(--xr-line);
    border-radius: 6px;
    padding: 4px 10px;
    font: inherit;
    font-size: 11px;
    letter-spacing: 0.06em;
    cursor: pointer;
  }
  .regen:hover:not(:disabled) {
    border-color: var(--xr-phos);
    background: var(--xr-tint-2);
    box-shadow: 0 0 10px -2px var(--xr-glow);
  }
  .regen:disabled {
    opacity: 0.6;
    cursor: default;
  }
  .search-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 8px 12px;
    padding: 6px 12px;
    background: color-mix(in oklab, var(--xr-phos) 5%, transparent);
    border: 1px solid var(--xr-line);
    border-radius: 8px;
  }
  .search-row.active {
    border-color: var(--xr-phos);
    box-shadow:
      0 0 0 2px var(--xr-tint),
      0 0 12px -3px var(--xr-glow);
  }
  .search-in {
    flex: 1;
    background: none;
    border: none;
    outline: none;
    color: var(--xr-tx);
    font-size: 13px;
    font-family: inherit;
  }
  .search-in::placeholder {
    color: var(--xr-tx-dim);
  }
  .tree {
    overflow-y: auto;
    padding: 4px 8px 8px;
    min-height: 0;
    flex: 1 1 auto;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 3px 6px;
    border-radius: 4px;
    cursor: pointer;
    font-size: 12.5px;
  }
  .row:hover {
    background: var(--xr-tint-2);
  }
  /* Selection = phosphor tint + inset rail + text glow — NOT a solid fill. */
  .row.sel {
    background: var(--xr-tint);
    box-shadow: inset 2px 0 0 var(--xr-phos);
    color: var(--xr-tx);
    text-shadow: 0 0 7px var(--xr-glow);
  }
  .tw {
    width: 14px;
    flex: 0 0 14px;
    background: none;
    border: none;
    color: var(--xr-tx-dim);
    cursor: pointer;
    font-size: 9px;
    padding: 0;
  }
  .row.sel .tw {
    color: var(--xr-phos-hi);
  }
  .eye {
    width: 16px;
    flex: 0 0 16px;
    background: none;
    border: none;
    color: var(--xr-phos-hi);
    cursor: pointer;
    padding: 0;
    font-size: 12px;
    text-shadow: 0 0 6px var(--xr-glow);
  }
  .eye.off {
    color: var(--xr-tx-dim);
    text-shadow: none;
  }
  .rlabel {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .rlabel.dim {
    opacity: 0.4;
    text-decoration: line-through;
  }
  .tag {
    font-size: 9px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--xr-phos);
    border: 1px solid var(--xr-line);
    border-radius: 3px;
    padding: 0 4px;
  }
  .count {
    font-size: 10.5px;
    color: var(--xr-tx-dim);
    font-variant-numeric: tabular-nums;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    padding: 6px 12px;
    border-top: 1px solid var(--xr-line);
  }
  .showprops {
    background: transparent;
    color: var(--xr-phos-hi);
    border: 1px solid var(--xr-line);
    border-radius: 6px;
    padding: 5px 12px;
    font: inherit;
    font-size: 11.5px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    cursor: pointer;
  }
  .showprops:hover:not(:disabled) {
    border-color: var(--xr-phos);
    background: var(--xr-tint-2);
    box-shadow: 0 0 12px -3px var(--xr-glow);
    text-shadow: 0 0 6px var(--xr-glow);
  }
  .showprops:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .empty {
    color: var(--xr-tx-dim);
    padding: 12px 4px;
    font-style: italic;
  }
  .empty.big {
    padding: 30px 16px;
    text-align: center;
  }
  .foot {
    display: flex;
    gap: 12px;
    flex-wrap: wrap;
    padding: 8px 16px;
    border-top: 1px solid var(--xr-line);
    font-size: 10.5px;
    color: var(--xr-tx-dim);
  }
</style>
