<script lang="ts">
  import { yieldsToShellModal, isAnnotateChord } from "../shell/agent/annotationVisibility";

  // X-Ray (Alt+R) — figure-v1 P8, rebuilt as a surface (2026-09-15). One
  // radiograph panel over ANY x-rayable target: a semantic plot (its manifest
  // part tree), SEVERAL plots at once (each under a synthetic "N plots" row,
  // plus the parts they share — hide the x-axis of four plots in one keystroke),
  // a group (nested child groups + member elements), or a single element.
  // STRUCTURE + SHOW/HIDE + SELECTION: the property editors live in the
  // property menu, which "Show Properties" (Enter) opens ON TOP for whatever
  // rows are picked. Rows MULTI-SELECT (click · Ctrl/⌘+click toggles ·
  // Shift+click ranges · Ctrl/⌘+A all), and every action — x, Enter, Animate —
  // applies to the whole pick. Double-click (or Ctrl+Enter) re-roots the panel
  // on that row's node "as if x-rayed alone" (breadcrumb + Backspace pop the
  // root stack). Eye / 'x' dispatch per row kind: part → id-keyed override,
  // element → hidden flag, group → GroupDef eye, common → every plot's override.
  // 'a' widens the pick to its siblings (counterpart parts first), Alt+A picks
  // every search result, a press-and-sweep over rows picks a range (Ctrl/⌘ at
  // the press adds to the pick), and F — like Enter — shows properties.
  // In Slide mode, 'm' animates the pick (Appear / Emphasize / Disappear /
  // Change) straight onto the timeline. Regenerate stays, gated on a
  // recipe-backed plot root. Always dark — an x-ray screen by nature — but flat:
  // no scanlines, no glow, no boot flicker; it opens beside the selection.
  import Model3dSemantics from "./model3d/Model3dSemantics.svelte";
  import type { Model3dElement } from "./model3d/types";
  import { scene3dManifests, scene3dRecipes, scene3dGeneration } from "./model3d/store";
  import { updateModelFromSource, modelSourceOwnerEpoch } from "./model3d/sourceBridge";
  import { modelSourceIdentity } from "./model3d/source";
  import { resolveScene3dPartStyle } from "./model3d/scene3d";
  import ColorScaleControls from "./plot/ColorScaleControls.svelte";
  import { validateIncomingPlot } from "./plot/contract";
  import { get } from "svelte/store";
  import { tick, onDestroy } from "svelte";
  import {
    project,
    selection,
    partSelection,
    partSelections,
    setPartSelections,
    editorSelectionExclusions,
    isEditorTargetExcluded,
    xrayOpen,
    xrayRoot,
    selectOnly,
    commit,
    undo,
    redo,
    embeddedProjectRoot,
    projectDir,
  } from "./store";
  import { plotSourceCandidates, toProjectRelativeSource } from "./plot/source";
  import type { SemanticPlotElement } from "./types";
  import { plotManifests, plotRecipes, plotDom, plotGen, requestPlotDom } from "./plot/store";
  import { partReadout, readoutText } from "./plot/readout";
  import { readPartStyle } from "./plot/partStyle";
  import { kindForRole } from "./plot/tree";
  import { buildXrayTree, partRowId, commonPartRows, nestCommonRows, targetLabel, widenToSiblings, type XRow, type XrayTarget } from "./xray/buildXrayTree";
  import { queryTokens, matchesQuery, highlightSegments, manifestIndex, rowSearchFields } from "./xray/rowContext";
  import { xrayHover } from "./xray/hoverHook";
  import { middleEllipsis, createMeasurer } from "./plotsRail/ellipsis";
  import { membersDeep } from "./groups";
  import * as ops from "./ops";
  import { reimportPlot } from "./io";
  import { fileBridge } from "./project/types";
  import { focusAxisView } from "./plot/axisViewState";
  import { fluxFigMenuOpen } from "./settings";
  import { anchorPanel, reclampPanel, unionRects, type Rect } from "./ui/anchor";
  import { xrayAnimate, xrayBecomeSource, xrayPickSink, type XrayAnimateKind, type XrayAnimateTarget } from "./xray/animateHook";
  import type { FluxPlotManifest } from "./plot/types";

  // --- the pinned root + its tree -----------------------------------------
  // The tree rebuilds only while the panel is OPEN — the {#if $xrayOpen}
  // below gates the DOM but not $: blocks, so a closed X-ray never pays a
  // rebuild on every commit.
  $: root = $xrayRoot;
  // Text previews read the plot's drawing only where the manifest has none (a
  // title); `$plotGen` bumps when a drawing (re)loads, so the rows re-read it.
  $: domOf = (void $plotGen, (assetId: string) => plotDom.get(assetId) ?? null);
  $: tree = $xrayOpen ? buildXrayTree($project, root, $plotManifests, $scene3dManifests, domOf) : null;
  // A multi-plot root's SHARED parts (one row hides a part everywhere): flat for
  // search and selection, nested as the first plot nests them for display.
  $: common = $xrayOpen && root?.kind === "elements" ? commonPartRows(rootPlots($project, root), $plotManifests, $scene3dManifests, Object.fromEntries($project.assets.filter(a => a.model).map(a => [a.id, a.model!])), domOf) : [];
  $: commonTree = nestCommonRows(common, firstPlotManifest($project, root, $plotManifests));
  // Where each plot SITS — a 16×12 locator per plot row / search header (the owner reads
  // figures by position: "the bottom-left one"). Every plot of the figure, this one filled.
  $: several = !!tree && (tree.kind === "set" || tree.kind === "group");
  $: locator = several && root ? figureLocator($project, root.figId) : null;
  function figureLocator(p: typeof $project, figId: string): { w: number; h: number; boxes: { id: string; x: number; y: number; w: number; h: number }[] } | null {
    const f = p.figures.find((ff) => ff.id === figId);
    if (!f) return null;
    const boxes = f.elements.filter((e) => e.type === "plot" || e.type === "model3d").map((e) => ({ id: e.id, x: e.x, y: e.y, w: e.width, h: e.height }));
    if (boxes.length < 2) return null;
    const x0 = Math.min(0, ...boxes.map((b) => b.x)), y0 = Math.min(0, ...boxes.map((b) => b.y));
    const x1 = Math.max(f.width, ...boxes.map((b) => b.x + b.w)), y1 = Math.max(f.height, ...boxes.map((b) => b.y + b.h));
    return { w: x1 - x0, h: y1 - y0, boxes: boxes.map((b) => ({ ...b, x: b.x - x0, y: b.y - y0 })) };
  }
  // A name too long for the breadcrumb loses its MIDDLE, not the end that tells plots apart.
  let crumbMeasure: ((s: string) => number) | null = null;
  function crumbText(label: string): string {
    if (label.length <= 22) return label;
    crumbMeasure ??= createMeasurer(`11px ${getComputedStyle(document.documentElement).getPropertyValue("--font-mono") || "monospace"}`);
    return middleEllipsis(label, 160, crumbMeasure);
  }

  // id → row + parent, once per tree (a pick never walks the tree per row). The
  // common rows' top level hangs off a synthetic root so `a` widens among them.
  $: rowIndex = indexRows(tree, commonTree);
  $: parents = new Map([...rowIndex].filter(([, v]) => v.parent).map(([k, v]) => [k, v.parent!]));
  function indexRows(t: XRow | null, c: XRow[]): Map<string, { row: XRow; parent: XRow | null }> {
    const m = new Map<string, { row: XRow; parent: XRow | null }>();
    const walk = (n: XRow, parent: XRow | null) => { m.set(n.id, { row: n, parent }); for (const ch of n.children) walk(ch, n); };
    const commonRoot: XRow = { id: "common-root", kind: "set", role: "set", label: "", isGroup: true, children: c };
    for (const r of c) walk(r, commonRoot);
    if (t) walk(t, null);
    return m;
  }
  function firstPlotManifest(p: typeof $project, r: XrayTarget | null, ms: Record<string, FluxPlotManifest>): FluxPlotManifest | undefined {
    const first = rootPlots(p, r)[0];
    return first?.type === "plot" ? ms[first.assetId] : undefined;
  }
  // The plots under the X-ray parse their drawing now (Figure mode loads it lazily):
  // the few previews read from it then hold steady while the panel is up.
  $: if ($xrayOpen && root) for (const id of rootPlotAssetIds($project, root)) requestPlotDom(id);
  function rootPlotAssetIds(p: typeof $project, r: XrayTarget): string[] {
    const f = p.figures.find((ff) => ff.id === r.figId);
    if (!f) return [];
    const ids = r.kind === "element" ? [r.elementId] : r.kind === "elements" ? r.elementIds : membersDeep(f, r.groupId).map((e) => e.id);
    return ids.map((id) => f.elements.find((e) => e.id === id)).filter((e): e is SemanticPlotElement => e?.type === "plot").map((e) => e.assetId);
  }
  function rootPlots(p: typeof $project, r: XrayTarget | null): (SemanticPlotElement | Model3dElement)[] {
    if (!r || r.kind !== "elements") return [];
    const f = p.figures.find((ff) => ff.id === r.figId);
    if (!f) return [];
    return r.elementIds
      .map((id) => f.elements.find((e) => e.id === id))
      .filter((e): e is SemanticPlotElement | Model3dElement => !!e && (e.type === "plot" || e.type === "model3d"));
  }

  // Parents of the current root (double-click re-root pushes; Backspace pops).
  let rootStack: XrayTarget[] = [];
  $: crumbs = [...rootStack, ...(root ? [root] : [])].map((t) => targetLabel($project, t, $plotManifests));

  // The root ELEMENT when rooted on a plot (drives the sub-line + Regenerate).
  $: rootPlot = (() => {
    if (!root || root.kind !== "element") return null;
    const f = $project.figures.find((ff) => ff.id === root.figId);
    const el = f?.elements.find((e) => e.id === root.elementId);
    return el && el.type === "plot" ? (el as SemanticPlotElement) : null;
  })();

  $: rootModel = root?.kind === 'element' ? $project.figures.find(f => f.id === root?.figId)?.elements.find((e): e is Model3dElement => e.id === (root?.kind === 'element' ? root.elementId : '') && e.type === 'model3d') : undefined;

  // Regenerate: re-run the plot's recipe and hot-swap the result in place,
  // preserving the id-keyed overrides. Gated behind this explicit action (never
  // auto-runs user code) AND on a recipe-backed plot root.
  $: recipe = (rootModel ? $scene3dRecipes[rootModel.assetId] : rootPlot ? $plotRecipes[rootPlot.assetId] : undefined) as
    | { params?: Record<string, unknown>; lastRun?: string }
    | undefined;
  $: recipePath = (rootModel ?? rootPlot)?.source?.recipePath;
  $: projRoot = $embeddedProjectRoot ?? $projectDir;
  $: sourcePath = rootModel?.source?.glbPath ?? rootPlot?.source?.svgPath;
  $: srcLabel = sourcePath ? toProjectRelativeSource(projRoot, sourcePath) : "";
  let regenJobId = "";
  let regenBusy = false;
  let regenMsg = "";
  async function regenerate(parameters: Record<string, unknown> = recipe?.params ?? {}) {
    const fb = fileBridge();
    if (regenBusy) return;
    const rootElement = rootModel ?? rootPlot;
    if (!rootElement || !recipePath || !fb?.runRecipe) {
      regenMsg = "no recipe";
      return;
    }
    // Re-rooting is allowed while the recipe runs. Pin its owner before any
    // await so its result can never replace the newly inspected plot.
    const target = { id: rootElement.id, assetId: rootElement.assetId, kind: rootElement.type, identity: rootElement.type === "model3d" ? modelSourceIdentity(rootElement) : null, figId: root!.figId, recipePath, projRoot };
    const owner = get(project), sourceEpoch = modelSourceOwnerEpoch(), sourceGeneration = get(scene3dGeneration);
    const ownsTarget = () => {
      if (target.kind === "model3d" && (modelSourceOwnerEpoch() !== sourceEpoch || get(scene3dGeneration) !== sourceGeneration)) return false;
      if (get(project) !== owner || (get(embeddedProjectRoot) ?? get(projectDir)) !== target.projRoot) return false;
      const el = owner.figures.find((f) => f.id === target.figId)?.elements.find((e) => e.id === target.id);
      return (el?.type === "plot" || el?.type === "model3d") && el.type === target.kind && el.assetId === target.assetId && el.source?.recipePath === target.recipePath && (el.type !== "model3d" || modelSourceIdentity(el) === target.identity);
    };
    let completed = false;
    regenBusy = true;
    regenJobId = crypto.randomUUID();
    regenMsg = "";
    try {
      // source.recipePath is stored PROJECT-RELATIVE (plot/source.ts), but
      // runRecipe reads the file and resolves the recipe's `cwd` from its
      // dirname — it needs a real absolute path.
      let recipeAbs = "";
      for (const c of plotSourceCandidates(target.projRoot, target.recipePath, rootElement.source)) {
        if (await fb.exists(c)) {
          recipeAbs = c;
          break;
        }
      }
      if (!ownsTarget()) return;
      if (!recipeAbs) {
        regenMsg = "recipe file not found";
      } else {
        const res = await fb.runRecipe(recipeAbs, parameters, {jobId: regenJobId});
        if (!ownsTarget()) return;
        // Surface the REAL failure instead of a bare "error" — the recipe's stderr on a
        // non-zero exit, and the actual exception message if the output JSON won't parse.
        if (res.code !== 0) {
          const why = String(res.stderr ?? "").trim();
          regenMsg = "recipe failed" + (why ? `: ${why.slice(-200)}` : ` (exit ${res.code})`);
        } else if (target.kind === 'model3d') {
          if (!res.glbPath) throw new Error('The recipe did not produce a GLB output');
          await updateModelFromSource(target.id, { sourcePath: res.glbPath, manifestPath: res.manifestPath ?? undefined, recipePath: recipeAbs, isCurrent: ownsTarget });
          completed = true; regenMsg = 'regenerated ✓';
        } else if (res.svgText && res.manifestText) {
          await validateIncomingPlot(res.svgText, res.manifestText);
          if (!ownsTarget()) return;
          reimportPlot(
            target.assetId,
            res.svgText,
            JSON.parse(res.manifestText) as FluxPlotManifest,
            res.recipeText ? JSON.parse(res.recipeText) : undefined,
          );
          regenMsg = "regenerated ✓";
        } else regenMsg = "no output";
      }
    } catch (e) {
      regenMsg = "error: " + String((e as Error)?.message ?? e);
    } finally {
      regenBusy = false;
      regenJobId = "";
      if ((rootModel ?? rootPlot)?.id !== target.id || (!completed && !ownsTarget())) regenMsg = "";
    }
  }

  let expanded = new Set<string>();
  let selectedId: string | null = null; // the primary (last-picked) row
  let selectedIds = new Set<string>(); // the whole pick
  let anchorId: string | null = null; // shift-range anchor
  let search = "";
  let mode: "tree" | "search" = "tree";
  let animMenu = false;
  let panelEl: HTMLDivElement;
  // The row under the pointer (the detail strip shows it, else the primary row).
  let hoverRowId: string | null = null;
  function findEl(id: string) {
    for (const f of get(project).figures) for (const e of f.elements) if (e.id === id) return e;
    return undefined;
  }
  let searchEl: HTMLInputElement;

  async function revealPrimary() {
    await tick();
    // Nearest scrolling keeps keyboard navigation and search results visible,
    // without recentering the tree or moving the canvas under the panel.
    panelEl?.querySelector<HTMLElement>(".row.primary")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  // --- placement (ui/anchor.ts — beside the selection, near the pointer) -----
  const pointer = { x: -1, y: -1 };
  function onPointerMove(e: PointerEvent) {
    pointer.x = e.clientX;
    pointer.y = e.clientY;
  }
  let pos = { x: 0, y: 0 };
  let placed = false;
  let sizeObs: ResizeObserver | null = null;
  function avoidRect(): Rect | null {
    const rects: Rect[] = [];
    for (const n of document.querySelectorAll<Element>(".canvas-host .sel-box")) {
      const r = n.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) rects.push({ x: r.left, y: r.top, w: r.width, h: r.height });
    }
    return unionRects(rects);
  }
  async function place() {
    placed = false;
    await tick();
    const el = panelEl;
    if (!el) return;
    const vp = { w: window.innerWidth, h: window.innerHeight };
    const r = anchorPanel({ avoid: avoidRect(), point: pointer.x >= 0 ? { ...pointer } : null, size: { w: el.offsetWidth, h: el.offsetHeight }, viewport: vp });
    pos = { x: r.x, y: r.y };
    placed = true;
    sizeObs?.disconnect();
    sizeObs = new ResizeObserver(() => {
      const p = reclampPanel(pos, { w: el.offsetWidth, h: el.offsetHeight }, { w: window.innerWidth, h: window.innerHeight });
      if (p.x !== pos.x || p.y !== pos.y) pos = p;
    });
    sizeObs.observe(el);
  }
  onDestroy(() => { sizeObs?.disconnect(); xrayHover.set(null); });

  let prevOpen = false;
  $: {
    if ($xrayOpen && !prevOpen) {
      reset();
      void place();
    }
    if (!$xrayOpen && prevOpen) {
      // However it closed (Esc here, the Become picker, a mode switch …): the
      // canvas outline of the hovered row goes with it, and the view is kept.
      xrayHover.set(null);
      rememberExpansion();
      sizeObs?.disconnect();
      sizeObs = null;
    }
    prevOpen = $xrayOpen;
  }
  // Focus returns to the panel when the property menu (opened ON TOP by Show
  // Properties) closes — the keyboard picks up exactly where it left off.
  let prevMenu = false;
  $: {
    if ($xrayOpen && prevMenu && !$fluxFigMenuOpen) requestAnimationFrame(() => panelEl?.focus({ preventScroll: true }));
    prevMenu = $fluxFigMenuOpen;
  }
  // Expansion is remembered per root for the session: reopening the X-ray on the
  // same plot (or set) lands where you left it.
  const expansionMemory = new Map<string, Set<string>>();
  // A set of plots is one root whatever order it was gathered in.
  const rootKey = (t: XrayTarget | null) => (t ? JSON.stringify(t.kind === "elements" ? { ...t, elementIds: [...t.elementIds].sort() } : t) : "");
  function rememberExpansion() {
    if (root) expansionMemory.set(rootKey(root), new Set(expanded));
  }
  function seedExpanded(t: XRow | null) {
    const kept = expansionMemory.get(rootKey(root));
    if (kept) { expanded = new Set(kept); return; }
    const exp = new Set<string>();
    // The shared axes open: what a multi-plot X-ray is mostly for (all y tick labels …).
    for (const c of commonTree) if (c.role === "axis") exp.add(c.id);
    if (t) {
      const seed = (n: XRow, d: number) => {
        // A group's members are many and alike: never opened unasked.
        if (d < 2 && n.children.length && !n.children[0].member) exp.add(n.id);
        n.children.forEach((c) => seed(c, d + 1));
      };
      seed(t, 0);
    }
    expanded = exp; // single assignment → tracked dependency fires once, fully seeded
  }
  function reset() {
    search = "";
    mode = "tree";
    animMenu = false;
    rootStack = [];
    showMore = new Map();
    hoverRowId = null;
    seedExpanded(tree);
    // The drilled parts carry into the opened tree pre-selected + revealed — a
    // group MEMBER (one tick label) included: members are rows of their own.
    const parts = get(partSelections);
    selectedId = null;
    selectedIds = new Set();
    anchorId = null;
    if (parts.length && root && (root.kind === "element" || root.kind === "elements")) {
      // The same part on EVERY plot of a multi-plot root lands on its common row.
      const plots = root.kind === "elements" ? root.elementIds : [];
      const on = new Map<string, Set<string>>();
      for (const ps of parts) { if (!on.has(ps.partId)) on.set(ps.partId, new Set()); on.get(ps.partId)!.add(ps.elementId); }
      const everywhere = (partId: string) => plots.length > 1 && plots.every((id) => on.get(partId)?.has(id)) && rowIndex.has("common:" + partId);
      for (const ps of parts) revealRow(everywhere(ps.partId) ? "common:" + ps.partId : partRowId(ps.elementId, ps.partId), true);
    }
    requestAnimationFrame(() => panelEl?.focus({ preventScroll: true }));
  }

  interface Row {
    node: XRow;
    depth: number;
  }
  // A group's members render capped: the first MEMBER_CAP, then a "+ N more"
  // control (not a row — never picked, ranged or navigated). Picked members
  // always render, wherever they sit.
  const MEMBER_CAP = 60, MEMBER_STEP = 200;
  let showMore = new Map<string, number>();
  interface Built {
    rows: Row[];
    /** "+ N more" controls, by the row they follow */
    more: Map<string, { groupId: string; rest: number }>;
    /** search: a plot (or Common) header, by the row it precedes */
    heads: Map<string, { label: string; prefix?: string; hint?: string; count: number; plotId?: string }>;
    /** rows from the Common section, in tree mode */
    commonShown: number;
    info: { hits: number; plots: number } | null;
  }
  function flatten(n: XRow, depth: number, b: Built, exp: Set<string>, sel: Set<string>, shown: Map<string, number>) {
    b.rows.push({ node: n, depth });
    if (!n.children.length || !exp.has(n.id)) return;
    const cap = n.children[0].member ? (shown.get(n.id) ?? MEMBER_CAP) : Infinity;
    let last: XRow | null = null, drawn = 0;
    n.children.forEach((c, i) => {
      if (i >= cap && !sel.has(c.id)) return;
      flatten(c, depth + 1, b, exp, sel, shown);
      last = c; drawn++;
    });
    if (last && drawn < n.children.length) b.more.set((last as XRow).id, { groupId: n.id, rest: n.children.length - drawn });
  }
  const fieldsOf = (n: XRow, plot: XRow | null) => rowSearchFields(n, plot && plot !== n ? plot.label : undefined);
  function buildRows(t: XRow | null, cTree: XRow[], cFlat: XRow[], tokens: string[], exp: Set<string>, sel: Set<string>, shown: Map<string, number>): Built {
    const b: Built = { rows: [], more: new Map(), heads: new Map(), commonShown: 0, info: null };
    if (!t) return b;
    if (!tokens.length) {
      for (const r of cTree) flatten(r, 0, b, exp, sel, shown);
      b.commonShown = b.rows.length;
      flatten(t, 0, b, exp, sel, shown);
      return b;
    }
    // Search: Common first, then the tree's hits — grouped under their plot when
    // several plots are listed, each hit carrying its path ("X axis ›").
    const commonHits = cFlat.filter((r) => matchesQuery(fieldsOf(r, null), tokens));
    if (commonHits.length) b.heads.set(commonHits[0].id, { label: "Common", hint: `shared by all ${commonHits[0].elementIds?.length ?? 0}`, count: commonHits.length });
    for (const r of commonHits) b.rows.push({ node: r, depth: 0 });
    const several = t.kind === "set" || t.kind === "group";
    const perPlot = new Map<string, { plot: XRow; first: string; count: number }>();
    const walk = (n: XRow, plot: XRow | null) => {
      const here = n.kind === "element" ? n : plot;
      if (n.kind !== "set" && matchesQuery(fieldsOf(n, here), tokens)) {
        b.rows.push({ node: n, depth: 0 });
        if (several && here) {
          const g = perPlot.get(here.id);
          if (g) g.count++; else perPlot.set(here.id, { plot: here, first: n.id, count: 1 });
        }
      }
      for (const c of n.children) walk(c, here);
    };
    walk(t, null);
    for (const { plot, first, count } of perPlot.values()) b.heads.set(first, { label: (plot.keyParts?.key ?? plot.label) + (plot.keyParts?.ordinal ? ` #${plot.keyParts.ordinal}` : ""), prefix: plot.keyParts?.prefix, hint: plot.preview, count, plotId: plot.elementId });
    b.info = { hits: b.rows.length, plots: perPlot.size };
    return b;
  }
  $: q = search.trim().toLowerCase();
  $: tokens = queryTokens(q);
  // NOTE: everything the build reads is passed as an ARGUMENT so Svelte's `$:`
  // dependency analysis tracks it.
  $: built = buildRows(tree, commonTree, common, tokens, expanded, selectedIds, showMore);
  $: rows = built.rows;
  $: commonCount = built.commonShown;

  $: selRow = selectedId ? rowIndex.get(selectedId)?.row ?? null : null;
  $: pickedRows = [...selectedIds].map((id) => rowIndex.get(id)?.row).filter((r): r is XRow => !!r);
  const rowsOf = (ids: Iterable<string>) => [...ids].map((id) => rowIndex.get(id)?.row).filter((r): r is XRow => !!r);

  /** Expand every ancestor of a row id and select it (re-root landing / open
   *  with drilled parts). Row ids are stable across re-roots. */
  function revealRow(rowId: string, additive = false) {
    const hit = rowIndex.get(rowId);
    if (!hit) return;
    for (let p = hit.parent; p; p = rowIndex.get(p.id)?.parent ?? null) expanded.add(p.id);
    expanded = expanded;
    selectedId = rowId;
    const next = additive ? new Set(selectedIds) : new Set<string>();
    next.add(rowId);
    selectedIds = next;
    anchorId ??= rowId;
    void revealPrimary();
  }

  // --- pick → canvas selection --------------------------------------------------------
  function rowBlocked(n: XRow, _exclusions: unknown): boolean {
    if (n.kind === "common") return (n.elementIds ?? []).every((id) => isEditorTargetExcluded(id, n.partId));
    if (n.elementId) return isEditorTargetExcluded(n.elementId, n.partId);
    if (n.groupId && root) {
      const fig = get(project).figures.find((f) => f.id === root.figId);
      const members = fig ? membersDeep(fig, n.groupId) : [];
      return members.length > 0 && members.every((e) => isEditorTargetExcluded(e.id));
    }
    return false;
  }
  function hideBlocked(n: XRow, exclusions: unknown): boolean {
    if (rowBlocked(n, exclusions)) return true;
    if (n.groupId && root) {
      const fig = get(project).figures.find((f) => f.id === root.figId);
      return !!fig && membersDeep(fig, n.groupId).some((e) => isEditorTargetExcluded(e.id));
    }
    return false;
  }
  /** A picked group ABSORBS its picked members (Tick labels + tick label 3 = Tick labels):
   *  one key edited, one track animated, never the family and each member over again. */
  function absorbMembers(picked: XRow[]): XRow[] {
    const ids = new Set(picked.map((n) => n.id));
    return picked.filter((n) => !(n.member && ids.has(rowIndex.get(n.id)?.parent?.id ?? "")));
  }
  /** Publish the pick to the editor's selection stores: parts (any row kind
   *  that names one) become the plural part selection; whole objects and
   *  group members become the element selection. */
  function applySelection(all: XRow[]) {
    const picked = absorbMembers(all);
    publishPick(picked);
    const exclusions = get(editorSelectionExclusions);
    const parts: { elementId: string; partId: string }[] = [];
    const elements = new Set<string>();
    const fig = root ? get(project).figures.find((f) => f.id === root.figId) : null;
    for (const n of picked) {
      if (rowBlocked(n, exclusions)) continue;
      if (n.kind === "part" && n.elementId && n.partId) parts.push({ elementId: n.elementId, partId: n.partId });
      else if (n.kind === "common" && n.partId) for (const id of n.elementIds ?? []) parts.push({ elementId: id, partId: n.partId });
      else if (n.kind === "element" && n.elementId) elements.add(n.elementId);
      else if (n.kind === "group" && n.groupId && fig) for (const m of membersDeep(fig, n.groupId)) elements.add(m.id);
      else if (n.kind === "set") for (const c of n.children) if (c.elementId) elements.add(c.elementId);
    }
    if (parts.length) {
      selection.set(new Set(parts.map((p) => p.elementId)));
      setPartSelections(parts);
      return;
    }
    if (elements.size) {
      selectOnly([...elements][0]); // clears part/frame selection
      selection.set(new Set(elements));
      return;
    }
    selection.set(new Set());
    partSelection.set(null);
  }
  function pick(n: XRow, e?: { shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean }) {
    mode = "tree";
    animMenu = false;
    const toggle = !!(e?.ctrlKey || e?.metaKey);
    const range = !!e?.shiftKey;
    let next: Set<string>;
    if (range && anchorId) {
      const ids = rows.map((r) => r.node.id);
      const a = ids.indexOf(anchorId);
      const b = ids.indexOf(n.id);
      if (a >= 0 && b >= 0) next = new Set(ids.slice(Math.min(a, b), Math.max(a, b) + 1));
      else next = new Set([n.id]);
    } else if (toggle) {
      next = new Set(selectedIds);
      if (next.has(n.id) && next.size > 1) next.delete(n.id);
      else next.add(n.id);
      anchorId = n.id;
    } else {
      next = new Set([n.id]);
      anchorId = n.id;
    }
    selectedIds = next;
    selectedId = n.id;
    applySelection(rowsOf(next));
  }
  function pickAll() {
    const ids = rows.map((r) => r.node.id).filter((id) => !id.startsWith("set:"));
    selectedIds = new Set(ids);
    if (!selectedId && ids.length) selectedId = ids[0];
    applySelection(rows.map((r) => r.node).filter((n) => n.kind !== "set"));
  }

  /** 'a' — widen the pick to its siblings (`xray/buildXrayTree.ts widenToSiblings`, the
   *  ONE rule the Slide Become picker shares): first the same part under each sibling
   *  of its parent, then — when that adds nothing — every row under the same parent. */
  function pickSiblings() {
    const picked = pickedRows.length ? pickedRows : selRow ? [selRow] : [];
    const next = widenToSiblings(tree, picked, parents);
    if (!next) return;
    for (const id of next) revealAncestors(id, parents);
    selectedIds = next;
    selectedId ??= picked[0].id;
    applySelection(rowsOf(next));
  }
  function revealAncestors(id: string, parent: Map<string, XRow>) {
    for (let p = parent.get(id); p; p = parent.get(p.id)) expanded.add(p.id);
    expanded = expanded;
  }

  // --- drag-select: press on a row and sweep; Ctrl/⌘ at the press adds to the pick --------
  let sweep: { startId: string; base: Set<string>; moved: boolean } | null = null;
  let sweepClickGuard = false;
  function onRowPointerDown(e: PointerEvent, n: XRow) {
    if (e.button !== 0 || e.shiftKey || (e.target as HTMLElement).closest("button")) return;
    sweep = { startId: n.id, base: e.ctrlKey || e.metaKey ? new Set(selectedIds) : new Set(), moved: false };
  }
  function onRowPointerEnter(e: PointerEvent, n: XRow) {
    if (!sweep || !(e.buttons & 1)) return;
    // Chrome delivers a boundary event late when rows re-render under a still
    // pointer (a search filter): entering the pressed row itself is not a sweep.
    if (!sweep.moved && n.id === sweep.startId) return;
    const ids = rows.map((r) => r.node.id);
    const a = ids.indexOf(sweep.startId), b = ids.indexOf(n.id);
    if (a < 0 || b < 0) return;
    sweep.moved = true;
    const next = new Set(sweep.base);
    for (const id of ids.slice(Math.min(a, b), Math.max(a, b) + 1)) if (!id.startsWith("set:")) next.add(id);
    selectedIds = next;
    selectedId = n.id;
    anchorId = sweep.startId;
    applySelection(rowsOf(next));
  }
  function onSweepEnd() {
    // The click that ends a sweep must not re-pick one row. It fires in this same
    // task only when the press and release share a row; otherwise it lands on
    // the tree, so the guard never outlives this task.
    if (sweep?.moved) { sweepClickGuard = true; setTimeout(() => (sweepClickGuard = false)); }
    sweep = null;
  }

  // --- Show Properties: the pick → property menu ON TOP --------------------------------
  function showProperties() {
    const picked = pickedRows.length ? pickedRows : selRow ? [selRow] : [];
    if (!picked.length || picked.every((n) => rowBlocked(n, get(editorSelectionExclusions)))) return;
    applySelection(picked);
    if (get(selection).size === 0) return; // empty group: nothing to edit
    fluxFigMenuOpen.set(true);
  }

  // --- re-root ("as if x-rayed alone"): double-click / Ctrl+Enter ---------------------
  function reRoot(n: XRow | null) {
    if (!n || !root) return;
    const figId = root.figId;
    let target: XrayTarget | null = null;
    if (n.kind === "group" && n.groupId) target = { kind: "group", figId, groupId: n.groupId };
    else if (n.kind === "common") return; // a shared part has no single home
    else if (n.kind === "set") return;
    else if (n.elementId) target = { kind: "element", figId, elementId: n.elementId };
    if (!target) return;
    if (
      (root.kind === "element" && target.kind === "element" && root.elementId === target.elementId) ||
      (root.kind === "group" && target.kind === "group" && root.groupId === target.groupId)
    ) {
      if (n.kind === "part") revealRow(n.id); // already rooted here — just land on the part
      return;
    }
    rememberExpansion();
    rootStack = [...rootStack, root];
    xrayRoot.set(target);
    // After the tree re-derives: land on the part (pre-expanded/selected), or
    // seed the fresh root's default expansion.
    requestAnimationFrame(() => {
      seedExpanded(tree);
      selectedIds = new Set();
      if (n.kind === "part") revealRow(n.id);
      else {
        selectedId = tree?.id ?? null;
        if (selectedId) selectedIds = new Set([selectedId]);
      }
    });
  }
  function popRoot() {
    if (!rootStack.length) return;
    const t = rootStack[rootStack.length - 1];
    rememberExpansion();
    rootStack = rootStack.slice(0, -1);
    xrayRoot.set(t);
    requestAnimationFrame(() => seedExpanded(tree));
  }
  function popTo(i: number) {
    if (i >= rootStack.length) return;
    const t = rootStack[i];
    rememberExpansion();
    rootStack = rootStack.slice(0, i);
    xrayRoot.set(t);
    requestAnimationFrame(() => seedExpanded(tree));
  }

  function toggleExpand(n: XRow) {
    if (!n.children.length) return;
    if (expanded.has(n.id)) expanded.delete(n.id);
    else { expanded.add(n.id); void revealChildren(n); }
    expanded = expanded;
  }
  /** Opening a row brings its first few children into view (nearest: no jump if visible). */
  async function revealChildren(n: XRow) {
    await tick();
    const last = n.children[Math.min(n.children.length, 3) - 1];
    panelEl?.querySelector<HTMLElement>(`.row[data-rid="${CSS.escape(last.id)}"]`)?.scrollIntoView({ block: "nearest" });
  }

  // --- eye / 'x': per-row-kind hide dispatch, over the whole pick -------------------------
  function toggleHiddenRows(list: XRow[]) {
    const exclusions = get(editorSelectionExclusions);
    const fig = root ? get(project).figures.find((f) => f.id === root.figId) : null;
    const targets = absorbMembers(list).flatMap((n) => n.kind === "set" ? n.children : [n])
      .filter((n) => !hideBlocked(n, exclusions))
      .map((n) => {
        if (n.kind !== "common") return n;
        const elementIds = (n.elementIds ?? []).filter((id) => !isEditorTargetExcluded(id, n.partId));
        // The eye's direction is decided by EDITABLE members. A disappeared
        // member (Show hidden off) must neither change nor reverse this action.
        const hidden = elementIds.every((id) => {
          const el = fig?.elements.find((e) => e.id === id);
          // as DRAWN on each plot: that plot's own row carries the rendering rule's answer
          return el?.type === "model3d" ? !!resolveScene3dPartStyle(get(scene3dManifests)[el.assetId], el.overrides, n.partId!).hidden : el?.type === "plot" && !!rowIndex.get(partRowId(id, n.partId!))?.row.hidden;
        });
        return { ...n, elementIds, hidden };
      });
    if (!targets.length) return;
    // Any shown → hide all; every one hidden → show all (the Layers rule).
    const anyShown = targets.some((n) => !n.hidden);
    const hide = anyShown;
    commit((p) => {
      for (const n of targets) {
        if (n.kind === "part" && n.elementId && n.partId) writeHidden(p, n.elementId, n.partId, hide);
        else if (n.kind === "common" && n.partId) for (const id of n.elementIds ?? []) writeHidden(p, id, n.partId, hide);
        else if (n.kind === "element" && n.elementId) ops.setElementStyle(p, [n.elementId], { hidden: hide });
        else if (n.kind === "group" && n.groupId) ops.setGroupState(p, n.groupId, { hidden: hide });
      }
    });
  }
  /** One part's eye on one plot. A plot part's toggle NORMALISES its subtree (rowContext
   *  hiddenToggleWrites): "x" on Tick labels shows or hides every tick label, and showing one
   *  tick label inside hidden tick labels draws it (the most specific flag wins). */
  function writeHidden(p: typeof $project, elementId: string, partId: string, hide: boolean) {
    ops.setPartHidden(p, elementId, partId, hide);
  }
  function toggleHidden(n: XRow) {
    // The eye acts on the pick when the row is part of it, else on the row.
    toggleHiddenRows(selectedIds.has(n.id) && pickedRows.length > 1 ? pickedRows : [n]);
  }

  function axisFor(row: XRow | null): "x" | "y" | null {
    if (row?.kind !== "part" || row.role !== "axis" || !row.elementId || rowBlocked(row, $editorSelectionExclusions)) return null;
    return /(?:^|\.)axis\.(x|y)$/.exec(row.partId ?? "")?.[1] as "x" | "y" | undefined ?? null;
  }
  function showAxisView(row: XRow | null) {
    const axis = axisFor(row);
    if (axis && row?.elementId) { focusAxisView(row.elementId, axis); close(); }
  }

  // --- Animate selected (slide mode only) ------------------------------------------------
  $: canAnimate = !!$xrayAnimate;
  type AnimateOption = { kind: XrayAnimateKind; label: string; key: string; hint: string };
  $: animOptions = [
    { kind: "appear", label: "Appear", key: "1", hint: "entrance with each kind's default" },
    { kind: "emphasize", label: "Emphasize", key: "2", hint: "pulse" },
    { kind: "disappear", label: "Disappear", key: "3", hint: "exit" },
    { kind: "change", label: "Change", key: "4", hint: "transform — edit the object after this step" },
    { kind: "appear-from", label: "Appear from…", key: "5", hint: "Pick the object these rows come from" },
    { kind: "animate-like", label: "Animate like…", key: "6", hint: "Pick another object's effect in this step" },
    ...($xrayBecomeSource ? [{kind: "become-destination", label: "Become", key: "b", hint: "The source hands off to the picked rows (Space or b)"}] : []),
  ] as AnimateOption[];
  /** A waiting Become pick follows the rows live (animateHook `xrayPickSink`). */
  function publishPick(picked: XRow[]) {
    const sink = get(xrayPickSink);
    if (!sink || !get(xrayBecomeSource) || !root) return;
    const fig = get(project).figures.find((f) => f.id === root.figId);
    const ids = root.kind === "element" ? [root.elementId] : root.kind === "elements" ? root.elementIds : fig ? membersDeep(fig, root.groupId).map((e) => e.id) : [];
    sink({ rootElementIds: ids, targets: animateTargets("become-destination", picked) });
  }
  function animateTargets(kind?: XrayAnimateKind, rows?: XRow[]): XrayAnimateTarget[] {
    const all = rows ?? (pickedRows.length ? pickedRows : selRow ? [selRow] : []);
    // A picked group covers its picked MEMBERS (one track for the family, never the glyph
    // animated twice). Containers and their children stay separate targets, as before:
    // "X axis appears, its ticks emphasize" is two tracks.
    const picked = absorbMembers(all);
    const exclusions = get(editorSelectionExclusions);
    const out: XrayAnimateTarget[] = [];
    const fig = root ? get(project).figures.find((f) => f.id === root.figId) : null;
    for (const n of picked) {
      if (rowBlocked(n, exclusions)) continue;
      if (n.kind === "part" && n.elementId && n.partId) out.push({ elementId: n.elementId, partId: n.partId });
      else if (n.kind === "common" && n.partId) for (const id of n.elementIds ?? []) out.push({ elementId: id, partId: n.partId });
      else if (n.kind === "element" && n.elementId) out.push({ elementId: n.elementId });
      else if (n.kind === "group" && n.groupId && fig) {
        const members = membersDeep(fig, n.groupId);
        if ((kind === "become-destination" || kind === "appear-from") && members.length) out.push({elementId: members[0].id, groupId: n.groupId});
        else for (const m of members) out.push({elementId: m.id});
      }
      else if (n.kind === "set") for (const c of n.children) if (c.elementId) out.push({ elementId: c.elementId });
    }
    const seen = new Set<string>();
    return out.filter((t) => {
      const key = JSON.stringify([t.elementId, t.partId ?? "", t.groupId ?? ""]);
      if (seen.has(key) || isEditorTargetExcluded(t.elementId, t.partId)) return false;
      seen.add(key);
      return true;
    });
  }
  function animate(kind: XrayAnimateKind) {
    const handler = get(xrayAnimate);
    const targets = animateTargets(kind);
    animMenu = false;
    if (!handler || !targets.length) return;
    handler({ kind, targets });
    close(); // the timeline takes over — adjust from there
  }

  // --- family: ← walks up a level, → down ------------------------------------------------
  /** ← on an open row folds it; otherwise it moves to (and picks) the row's parent —
   *  its FAMILY: one tick label → Tick labels → X axis. Shift keeps the pick and adds. */
  function toParent(additive: boolean) {
    if (!selRow) return;
    if (selRow.children.length && expanded.has(selRow.id)) { expanded.delete(selRow.id); expanded = expanded; return; }
    const up = parents.get(selRow.id);
    if (!up || !rowIndex.has(up.id)) return;
    if (additive && !selectedIds.has(up.id)) pick(up, { ctrlKey: true });
    else if (additive) { selectedId = up.id; anchorId = up.id; }
    else pick(up);
    void revealPrimary();
  }
  /** → opens a closed row; on an open one it steps to the first child. */
  function toChild() {
    if (!selRow?.children.length) return;
    if (!expanded.has(selRow.id)) { expanded.add(selRow.id); expanded = expanded; void revealChildren(selRow); return; }
    pick(selRow.children[0]);
    void revealPrimary();
  }

  // --- ⇧A: the same part in EVERY plot of the figure -----------------------------------
  /** Widen the picked parts to every plot in this figure that has them: the X-ray
   *  re-roots on those plots together (⌫ returns) with the part picked on all of them —
   *  its common row where every plot has it. "This y tick label style, everywhere." */
  function pickEverywhere() {
    if (!root) return;
    const picked = (pickedRows.length ? pickedRows : selRow ? [selRow] : []).filter((n) => (n.kind === "part" || n.kind === "common") && n.partId);
    if (!picked.length) return;
    const fig = get(project).figures.find((f) => f.id === root.figId);
    if (!fig) return;
    const ms = get(plotManifests);
    const partIds = [...new Set(picked.map((n) => n.partId!))];
    const has = (e: (typeof fig.elements)[number], id: string) => {
      if (e.type !== "plot" || isEditorTargetExcluded(e.id, id)) return false;
      const m = ms[e.assetId];
      if (!m) return false;
      const ix = manifestIndex(m);
      return ix.entries.has(id) || ix.memberOf.has(id);
    };
    // top-z first, like every listing
    const plots = [...fig.elements].reverse().filter((e) => partIds.some((id) => has(e, id)));
    const current = new Set(root.kind === "element" ? [root.elementId] : root.kind === "elements" ? root.elementIds : []);
    const parts = plots.flatMap((e) => partIds.filter((id) => has(e, id)).map((partId) => ({ elementId: e.id, partId })));
    const sameRoot = plots.length === current.size && plots.every((e) => current.has(e.id));
    if (!sameRoot) {
      if (plots.length < 2) return; // no other plot has it
      rememberExpansion();
      rootStack = [...rootStack, root];
      xrayRoot.set({ kind: "elements", figId: fig.id, elementIds: plots.map((e) => e.id) });
    }
    requestAnimationFrame(() => {
      if (!sameRoot) seedExpanded(tree);
      selectedId = null; selectedIds = new Set(); anchorId = null;
      for (const id of partIds) {
        if (rowIndex.has("common:" + id)) revealRow("common:" + id, true);
        else for (const ps of parts.filter((x) => x.partId === id)) revealRow(partRowId(ps.elementId, id), true);
      }
      applySelection(rowsOf(selectedIds)); // not pickedRows: its `$:` has not re-run yet this frame
    });
  }

  // --- the detail strip: the hovered row, else the primary row ------------------------------
  // Fixed, three lines, never a popover: the row's whole context and the facts a row has no
  // room for — values in full, data readout, state, effective style, the part id.
  interface Detail { path: string; title: string; values: string; meta: string[]; swatch?: string; id: string }
  $: detailRow = (hoverRowId ? rowIndex.get(hoverRowId)?.row : null) ?? selRow;
  $: detail = detailRow ? describeRow(detailRow, rowIndex, $project, $plotManifests) : null;
  function plotOf(n: XRow, ix: typeof rowIndex): XRow | null {
    for (let p: XRow | null = n; p; p = ix.get(p.id)?.parent ?? null) if (p.kind === "element") return p;
    return null;
  }
  const plotName = (r: XRow | null) => (r ? (r.keyParts ? r.keyParts.key + (r.keyParts.ordinal ? ` #${r.keyParts.ordinal}` : "") : r.label) : "");
  function describeRow(n: XRow, ix: typeof rowIndex, proj: typeof $project, ms: Record<string, FluxPlotManifest>): Detail {
    const plot = n.kind === "part" ? plotOf(n, ix) : null;
    const several = !!tree && (tree.kind === "set" || tree.kind === "group");
    const path = [...(n.kind === "common" ? [`every plot (${n.elementIds?.length ?? 0})`] : plot && several ? [plotName(plot)] : []), ...(n.path ?? [])].join(" › ");
    const meta: string[] = [];
    let values = n.preview ?? "", swatch = n.swatch;
    const el = n.elementId ? proj.figures.flatMap((f) => f.elements).find((e) => e.id === n.elementId) : undefined;
    // kind + size
    if (n.kind === "part" || n.kind === "common") meta.push(n.children.length && !n.children[0].member && n.kind === "part" ? "container" : kindForRole(n.role));
    if (n.kind === "part") {
      const members = n.children.length && n.children[0].member ? n.children.length : 0;
      if (members) meta.push(`${members} ${members === 1 ? "member" : "members"}`);
      else if (n.children.length) meta.push(`${n.children.length} parts`);
      else if (n.count) meta.push(`${n.count} marks`);
    } else if (n.kind === "element") meta.push(n.role === "figure" ? "plot" : n.role);
    else if (n.kind === "group") meta.push(`group · ${n.count ?? 0} objects`);
    else if (n.kind === "set") meta.push(`${n.children.length} plots`);
    // state
    if (n.kind === "common") {
      const hiddenIn = (n.elementIds ?? []).filter((id) => ix.get(partRowId(id, n.partId!))?.row.hidden);
      if (hiddenIn.length) meta.push(hiddenIn.length === (n.elementIds?.length ?? 0) ? "hidden everywhere" : `hidden in ${hiddenIn.map((id) => plotName(ix.get("el:" + id)?.row ?? null)).join(", ")}`);
      if (n.preview === "varies") {
        values = (n.elementIds ?? []).map((id) => `${plotName(ix.get("el:" + id)?.row ?? null)}: ${ix.get(partRowId(id, n.partId!))?.row.preview ?? "—"}`).join("  ·  ");
      }
    } else if (n.hidden) {
      if (n.inheritedHidden) {
        let by: XRow | null = null;
        for (let p = ix.get(n.id)?.parent ?? null; p; p = ix.get(p.id)?.parent ?? null) if (p.hidden && !p.inheritedHidden) { by = p; break; }
        meta.push(by ? `hidden by ${by.label}` : "hidden");
      } else meta.push("hidden");
    } else if (n.hiddenParts) meta.push(`${n.hiddenParts} hidden`);
    if (el && (el.type === "plot" || el.type === "model3d") && n.partId) {
      const ov = el.overrides?.[n.partId] as Record<string, unknown> | undefined;
      const keys = Object.keys(ov ?? {}).filter((k) => k !== "hidden" && ov![k] != null);
      if (keys.length) meta.push(`restyled: ${keys.join(", ")}`);
      else if (n.styledBeneath) meta.push("restyled inside");
    } else if (n.styled || n.styledBeneath) meta.push("restyled inside");
    // data readout + effective style: a part with its own drawing (a leaf or a member)
    if (n.kind === "part" && el?.type === "plot" && n.partId && !n.children.length) {
      const m = ms[el.assetId];
      const read = readoutText(partReadout(m, n.partId));
      if (read) values = values ? `${values} · ${read}` : read;
      const st = readPartStyle(el, n.partId, m);
      const paint = st.fontSize != null ? [`size ${+st.fontSize.toFixed(1)}`, st.fontFamily, st.fill] : st.strokeWidth != null && st.fill == null ? [st.stroke, `${+st.strokeWidth.toFixed(2)}px`] : [st.fill && st.fill !== "none" ? `fill ${st.fill}` : "", st.stroke && st.stroke !== "none" ? `stroke ${st.stroke}` : ""];
      const shown = paint.filter(Boolean).join(" ");
      if (shown) meta.push(shown);
      swatch ??= st.fontSize != null ? st.fill : st.stroke && st.stroke !== "none" && st.fill == null ? st.stroke : st.fill && st.fill !== "none" ? st.fill : undefined;
    } else if (n.kind === "part" && el?.type === "plot" && n.partId && (n.role === "series" || n.role === "legend-entry")) {
      const read = readoutText(partReadout(ms[el.assetId], n.partId));
      if (read && !values.includes(read)) values = values ? `${values} · ${read}` : read;
    }
    // A group with no value of its own: what its owner says (a series' points → the series).
    if (!values && n.kind === "part" && el?.type === "plot" && n.partId && n.children[0]?.member) {
      const up = ix.get(n.id)?.parent;
      const read = up?.partId ? readoutText(partReadout(ms[el.assetId], up.partId)) : "";
      if (read) values = read.replace(/\n/g, " · ");
    }
    if (n.kind === "element" && el?.type === "plot" && el.source?.svgPath) values = values ? `${values} · ${el.source.svgPath.split(/[\\/]/).pop()}` : el.source.svgPath.split(/[\\/]/).pop() ?? "";
    return { path, title: n.label, values, meta, swatch: swatch && /^#|^rgb|^hsl/i.test(swatch) ? swatch : undefined, id: n.partId ?? n.elementId ?? n.groupId ?? "" };
  }
  /** Rows under the pointer → the canvas outlines their parts (xray/hoverHook). */
  function hoverRow(n: XRow | null) {
    hoverRowId = n?.id ?? null;
    const t: { elementId: string; partId: string }[] = [];
    if (n?.kind === "part" && n.elementId && n.partId) t.push({ elementId: n.elementId, partId: n.partId });
    else if (n?.kind === "common" && n.partId) for (const id of n.elementIds ?? []) t.push({ elementId: id, partId: n.partId });
    xrayHover.set(t.length ? t.filter((x) => !isEditorTargetExcluded(x.elementId, x.partId)) : null);
  }
  function showMoreOf(groupId: string) {
    showMore.set(groupId, (showMore.get(groupId) ?? MEMBER_CAP) + MEMBER_STEP);
    showMore = showMore;
  }
  const hl = (text: string, t: string[]) => highlightSegments(text, t);

  function enterSearch() {
    mode = "search";
    requestAnimationFrame(() => searchEl?.focus());
  }
  function backToTree() {
    mode = "tree";
    requestAnimationFrame(() => panelEl?.focus({ preventScroll: true }));
  }
  function close() {
    rememberExpansion();
    xrayHover.set(null);
    xrayOpen.set(false);
  }

  function onRowClick(e: MouseEvent, n: XRow) {
    if (sweepClickGuard) { sweepClickGuard = false; return; }
    if (e.detail > 1) return; // the dblclick handler re-roots
    pick(n, e);
  }
  function onRowDblClick(n: XRow) {
    reRoot(n);
  }

  function onWin(e: KeyboardEvent) {
    if (e.defaultPrevented || yieldsToShellModal(e) || isAnnotateChord(e)) return;
    const target = e.target instanceof HTMLElement ? e.target : null;
    // Embedded field/Shape controls own typing, native slider keys and their
    // picker shortcuts. Tree Ctrl+A/Backspace must never steal numeric edits.
    if (target?.matches('input, textarea, select') || target?.isContentEditable || target?.closest('.model-controls')) return;
    // The property menu (opened ON TOP by Show Properties) owns the keyboard
    // while it is up — everything here yields until it closes.
    if (!$xrayOpen || $fluxFigMenuOpen || mode !== "tree") return;
    const k = e.key;
    const lk = k.toLowerCase();
    const mod = e.ctrlKey || e.metaKey;
    // Undo / redo stay live while the X-ray is up (the editor's keymap yields to it):
    // a mistaken x is one Ctrl+Z away, and the tree keeps its place.
    if (mod && !e.altKey && (lk === "z" || lk === "y")) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (lk === "y" || e.shiftKey) redo(); else undo();
      return;
    }
    // Space confirms the waiting pick, as in the canvas picker (b still does).
    if ((lk === "b" || e.code === "Space") && !mod && !e.altKey && !e.shiftKey && $xrayBecomeSource && canAnimate) {
      e.preventDefault(); e.stopImmediatePropagation(); animate("become-destination"); return;
    }
    if (animMenu) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (k === "Escape" || lk === "m") { animMenu = false; return; }
      const opt = animOptions.find((o) => o.key === k);
      if (opt) animate(opt.kind);
      return;
    }
    if (k === "Escape" || (lk === "r" && !mod) || (e.altKey && e.code === "KeyR")) {
      e.preventDefault();
      e.stopImmediatePropagation();
      close();
      return;
    }
    if (lk === "s" && !mod) {
      e.preventDefault();
      e.stopImmediatePropagation();
      enterSearch();
      return;
    }
    // Ctrl/⌘+A picks every row; Alt+A picks every search result (the rows
    // shown, which after a search ARE the results — same pick, search-first name).
    if ((mod && lk === "a") || (e.altKey && e.code === "KeyA")) {
      e.preventDefault();
      e.stopImmediatePropagation();
      pickAll();
      return;
    }
    if (lk === "a" && !mod && !e.altKey) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.shiftKey) pickEverywhere(); else pickSiblings();
      return;
    }
    if (lk === "m" && !mod && !e.altKey && canAnimate) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (pickedRows.length || selRow) animMenu = true;
      return;
    }
    // F opens the property menu for the pick, exactly like Enter (the F-menu's own key).
    if (lk === "f" && !mod && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      e.stopImmediatePropagation();
      showProperties();
      return;
    }
    if (lk === "v" && !mod && !e.altKey && axisFor(selRow)) { e.preventDefault(); e.stopImmediatePropagation(); showAxisView(selRow); return; }
    if (k === "Enter") {
      e.preventDefault();
      if (mod) reRoot(selRow);
      else showProperties();
      return;
    }
    if (k === "Backspace") {
      e.preventDefault();
      if (search) search = "";
      else popRoot();
      return;
    }
    if (k.startsWith("Arrow")) hoverRow(null); // the strip and canvas follow the keyboard now
    if (k === "ArrowDown" || k === "ArrowUp") {
      e.preventDefault();
      const i = rows.findIndex((r) => r.node.id === selectedId);
      const ni = k === "ArrowDown" ? Math.min(rows.length - 1, i + 1) : Math.max(0, i - 1);
      if (rows[ni]) { pick(rows[ni].node, { shiftKey: e.shiftKey }); void revealPrimary(); }
    } else if (k === "ArrowRight" && selRow && !mod) {
      e.preventDefault();
      toChild();
    } else if (k === "ArrowLeft" && selRow && !mod) {
      e.preventDefault();
      toParent(e.shiftKey);
    } else if (lk === "x" && !mod && !e.altKey && (pickedRows.length || selRow)) {
      e.preventDefault();
      toggleHiddenRows(pickedRows.length ? pickedRows : [selRow!]);
    }
  }
  function onSearchKey(e: KeyboardEvent) {
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      search = "";
      backToTree();
    } else if (e.altKey && e.code === "KeyA" && rows.length) {
      e.preventDefault();
      pickAll();
      backToTree();
    } else if (e.key === "Enter" && rows[0]) {
      e.preventDefault();
      pick(rows[selectedId ? Math.max(0, rows.findIndex((r) => r.node.id === selectedId)) : 0]?.node ?? rows[0].node);
      backToTree();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const i = rows.findIndex((r) => r.node.id === selectedId);
      const ni = e.key === "ArrowDown" ? Math.min(rows.length - 1, i + 1) : Math.max(0, i - 1);
      if (rows[ni]) { selectedId = rows[ni].node.id; void revealPrimary(); }
    }
  }
  // ◉ drawn · ○ hidden · ◐ partly hidden (some plots of a common row, some leaves of a part)
  const eyeGlyph = (n: XRow) => ((n.kind === "common" && n.hiddenCount && n.hiddenCount < (n.elementIds?.length ?? 0)) || (!n.hidden && (n.hiddenParts || (n.kind === "element" && n.hiddenBeneath))) ? "◐" : n.hidden ? "○" : "◉");
</script>

<svelte:window on:keydown={onWin} on:pointermove={onPointerMove} on:pointerup={onSweepEnd} on:pointercancel={onSweepEnd} />

{#if $xrayOpen}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="xbackdrop" on:pointerdown={close}></div>
  <div class="xwrap">
    <!-- svelte-ignore a11y_no_noninteractive_tabindex a11y_no_static_element_interactions -->
    <div
      class="xray"
      class:placed
      bind:this={panelEl}
      tabindex="-1"
      role="dialog"
      aria-label="X-ray"
      style={`left:${pos.x}px; top:${pos.y}px;`}
      on:pointerdown|stopPropagation
    >
      <div class="xcontent">
        <div class="xhead">
          <span class="ttl">X-Ray</span>
          <span class="crumbs">
            {#each crumbs as c, i}
              {#if i > 0}<span class="csep">›</span>{/if}
              <button class="crumb" class:cur={i === crumbs.length - 1} title={c} on:click={() => popTo(i)}>{crumbText(c)}</button>
            {/each}
            {#if !crumbs.length}<span class="csub">no target</span>{/if}
          </span>
          {#if (rootPlot || (rootModel && !rootModel.source?.frozen)) && recipePath}
            {#if regenBusy}<button class="regen" title="Cancel the running recipe (24 hour maximum)" on:click={() => fileBridge()?.cancelRecipe?.(regenJobId)}>Cancel run</button>{/if}
            <button class="regen" on:click={() => regenerate()} disabled={regenBusy} title={recipePath}>
              {regenBusy ? "Regenerating…" : regenMsg || "Regenerate"}
            </button>
          {/if}
          <button class="xbtn" on:click={close} aria-label="Close X-ray">×</button>
        </div>
        {#if srcLabel}
          <div class="srcline" title={srcLabel}><bdi>{srcLabel}</bdi></div>
        {/if}

        {#if !tree}
          <div class="empty big">Select a plot (or several), a group or an object, then press <b class="hk">alt+R</b>.</div>
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
            {#if q && built.info}<span class="sres">{built.info.hits}{built.info.plots > 1 ? ` in ${built.info.plots} plots` : ""}</span>{/if}
          </div>

          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div class="tree" on:mouseleave={() => hoverRow(null)}>
            {#if rootPlot && recipePath}
              <ColorScaleControls elementId={rootPlot.id} />
            {/if}
            {#if rootModel}<div class="model-controls"><Model3dSemantics element={rootModel}/></div>{/if}
            {#each rows as r, ri (r.node.id)}
              {#if commonCount && !q && ri === 0}
                <div class="section">Common parts <span class="scount">shared by all {common[0]?.elementIds?.length ?? 0}</span></div>
              {:else if commonCount && !q && ri === commonCount}
                <div class="section">{rootPlots($project, root).some(e => e.type === "model3d") ? "Objects" : "Plots"}</div>
              {/if}
              {#if q && built.heads.has(r.node.id)}
                {@const h = built.heads.get(r.node.id)}
                <div class="shead">{#if locator && h?.plotId}<svg class="loc" viewBox={`0 0 ${locator.w} ${locator.h}`} aria-hidden="true">{#each locator.boxes as b (b.id)}<rect x={b.x} y={b.y} width={b.w} height={b.h} class:me={b.id === h.plotId} />{/each}</svg>{/if}<span class="hkey">{h?.label}</span>{#if h?.hint}<span class="hhint">{h.hint}</span>{/if}<span class="hcount">{h?.count}</span></div>
              {/if}
              <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
              <div
                class="row"
                class:sel={selectedIds.has(r.node.id)}
                class:primary={selectedId === r.node.id}
                class:member={r.node.member}
                data-kind={r.node.kind}
                data-rid={r.node.id}
                style={`padding-left:${6 + r.depth * 14}px`}
                on:mouseenter={() => hoverRow(r.node)}
                on:pointerdown={(e) => onRowPointerDown(e, r.node)}
                on:pointerenter={(e) => onRowPointerEnter(e, r.node)}
                on:click={(e) => onRowClick(e, r.node)}
                on:dblclick={() => onRowDblClick(r.node)}
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
                  class:part-off={(r.node.kind === "common" && !!r.node.hiddenCount && !r.node.hidden) || (!r.node.hidden && (!!r.node.hiddenParts || (r.node.kind === "element" && !!r.node.hiddenBeneath)))}
                  class:ghost={r.node.inheritedHidden}
                  disabled={hideBlocked(r.node, $editorSelectionExclusions)}
                  title={hideBlocked(r.node, $editorSelectionExclusions) ? "Enable Show hidden to edit this target" : r.node.inheritedHidden ? "Hidden with its parent — show / hide this part itself (x)" : "Show / hide (x)"}
                  on:click|stopPropagation={() => toggleHidden(r.node)}>{eyeGlyph(r.node)}</button
                >
                <span class="rmain">
                  {#if locator && r.node.kind === "element" && r.node.elementId}<svg class="loc" viewBox={`0 0 ${locator.w} ${locator.h}`} aria-hidden="true">{#each locator.boxes as b (b.id)}<rect x={b.x} y={b.y} width={b.w} height={b.h} class:me={b.id === r.node.elementId} />{/each}</svg>{/if}
                  {#if q && r.node.path?.length}<span class="rpath">{#each hl(r.node.path.join(" › "), tokens) as g}{#if g.hit}<mark>{g.text}</mark>{:else}{g.text}{/if}{/each}<span class="psep">›</span></span>{/if}
                  <span class="rlabel" class:dim={r.node.hidden}>{#if q}{#each hl(r.node.label, tokens) as g}{#if g.hit}<mark>{g.text}</mark>{:else}{g.text}{/if}{/each}{:else if r.node.keyParts?.prefix && r.node.label.startsWith(r.node.keyParts.prefix)}<span class="kpre">{r.node.keyParts.prefix}</span><span class="kkey">{r.node.label.slice(r.node.keyParts.prefix.length)}</span>{:else}{r.node.label}{/if}</span>
                  {#if r.node.keyParts?.ordinal}<span class="ord" title="The same plot placed more than once">#{r.node.keyParts.ordinal}</span>{/if}
                  {#if r.node.styled}<span class="sdot" title="Restyled"></span>{:else if r.node.styledBeneath && !(expanded.has(r.node.id) && !q)}<span class="sdot inside" title="Something inside is restyled"></span>{/if}
                </span>
                {#if r.node.preview}<span class="rprev" class:varies={r.node.preview === "varies"} title={r.node.preview === "varies" ? "Differs between the plots" : undefined}>{#if r.node.swatch}<span class="sw" style={`background:${r.node.swatch}`}></span>{/if}<span class="ptext">{#if q}{#each hl(r.node.preview, tokens) as g}{#if g.hit}<mark>{g.text}</mark>{:else}{g.text}{/if}{/each}{:else}{r.node.preview}{/if}</span></span>{:else if r.node.swatch}<span class="rprev"><span class="sw" style={`background:${r.node.swatch}`}></span></span>{/if}
                {#if r.node.kind === "group"}<span class="tag">grp</span>{/if}
                {#if r.node.kind === "common"}<span class="tag">×{r.node.elementIds?.length ?? 0}</span>{/if}
                {#if r.node.count && r.node.kind !== "common"}<span class="count">{r.node.count}</span>{/if}
              </div>
              {#if built.more.has(r.node.id)}
                {@const m = built.more.get(r.node.id)}
                <button class="xmore" style={`padding-left:${26 + r.depth * 14}px`} on:click={() => m && showMoreOf(m.groupId)}>+ {m?.rest.toLocaleString()} more <span class="xmore-hint">show {Math.min(MEMBER_STEP, m?.rest ?? 0)}</span></button>
              {/if}
            {/each}
            {#if q && !rows.length}
              <div class="empty">No parts match “{search.trim()}”{#if !/\s/.test(search.trim()) && search.trim().length > 4} — words are matched separately: try “x tick”, “y labels”, a plot name or a value{/if}.</div>
            {/if}
          </div>

          <div class="xdetail" class:none={!detail}>
            {#if detail}
              <div class="dline dpath" title={[detail.path, detail.title].filter(Boolean).join(" › ")}>{#if detail.path}<span class="dctx">{detail.path} ›</span>{/if}<b>{detail.title}</b></div>
              <div class="dline dval" class:none={!detail.values} title={detail.values || undefined}>{detail.values || "no value of its own"}</div>
              <div class="dline dmeta">{#if detail.swatch}<span class="sw" style={`background:${detail.swatch}`}></span>{/if}<span class="dfacts">{detail.meta.join(" · ")}</span><span class="did" title={detail.id}>{detail.id}</span></div>
            {:else}
              <div class="dline dhint">Hover a row for its full context.</div>
            {/if}
          </div>

          {#if animMenu}
            <div class="animmenu" role="menu" aria-label="Animate selected">
              <span class="am-ttl">{#if $xrayBecomeSource}{$xrayBecomeSource} becomes… · {/if}Animate {animateTargets().length} {animateTargets().length === 1 ? "target" : "targets"}</span>
              {#each animOptions as o (o.kind)}
                <button class="am" role="menuitem" title={o.hint} on:click={() => animate(o.kind)}><span class="hk">{o.key}</span>{o.label}</button>
              {/each}
              <button class="am ghost" on:click={() => (animMenu = false)}><span class="hk">esc</span>cancel</button>
            </div>
          {/if}
          <div class="actions">
            {#if $xrayBecomeSource && canAnimate}<button class="animbtn" disabled={!(pickedRows.length || selRow)} on:click={() => animate("become-destination")} title={`${$xrayBecomeSource} becomes the picked rows`}>Become <span class="hk">b</span></button>{/if}
            <span class="pickinfo">{selectedIds.size > 1 ? `${selectedIds.size} picked` : ""}</span>
            {#if axisFor(selRow)}<button class="showprops" on:click={() => showAxisView(selRow)}><b class="hk">v</b> Axis view…</button>{/if}
            <button class="animbtn" disabled={!canAnimate || !(pickedRows.length || selRow)} title={canAnimate ? "Add an animation for every picked row (m)" : "Animate is available in Slide mode"} on:click={() => (animMenu = !animMenu)}>
              Animate selected <span class="hk">m</span>
            </button>
            <button class="showprops" disabled={!(pickedRows.length || selRow) || (pickedRows.length ? pickedRows : selRow ? [selRow] : []).every((n) => rowBlocked(n, $editorSelectionExclusions))} on:click={showProperties}>
              Show Properties <span class="hk">↵</span><span class="hk">f</span>
            </button>
          </div>
        {/if}

        <div class="foot">
          <span><b class="hk">↑↓</b> navigate</span>
          <span><b class="hk">←</b> family</span>
          <span><b class="hk">⇧/⌃ click</b> multi</span>
          <span><b class="hk">a</b> siblings</span>
          <span><b class="hk">⇧a</b> every plot</span>
          <span><b class="hk">x</b> hide</span>
          <span><b class="hk">s</b> search</span>
          {#if q}<span><b class="hk">alt+a</b> all results</span>{:else}<span><b class="hk">drag</b> sweep</span>{/if}
          <span><b class="hk">dbl-click</b> re-root</span>
          <span><b class="hk">⌫</b> back</span>
          <span><b class="hk">⌃z</b> undo</span>
          <span><b class="hk">r</b> <b class="hk">esc</b> close</span>
        </div>
      </div>
    </div>
  </div>
{/if}

<style>
  .model-controls { padding: 0 0 8px; }
  /* A palette being chosen gets the room to show two columns of maps (owner
     inbox 2026-09-30); the ResizeObserver re-clamps the panel on screen. */
  .xray:has(:global(.cmappick)) { width: min(640px, calc(100vw - 16px)); }
  /* Radiograph, flat: a near-black tube field with phosphor accents and mono
     type — always dark by nature (the --xr-* ramp, never the theme-scoped
     --c-* ramp). No gradients, glow, scanlines or entrance theatrics: it is a
     surface that opens beside the selection. */
  .xbackdrop { position: fixed; inset: 0; background: transparent; z-index: 290; }
  /* Sits UNDER the property menu (300/301): Show Properties opens it on top. */
  .xwrap { position: fixed; inset: 0; z-index: 291; pointer-events: none; }
  .xray {
    pointer-events: auto;
    position: absolute;
    visibility: hidden;
    width: min(460px, calc(100vw - 16px));
    max-height: min(74vh, calc(100vh - 16px));
    display: flex;
    flex-direction: column;
    color: var(--xr-tx);
    font-family: var(--font-mono);
    font-size: 12px;
    background: var(--xr-bg-2);
    border: 1px solid var(--xr-line);
    border-radius: var(--r-panel);
    box-shadow: var(--elev-2);
    outline: none;
    overflow: hidden;
  }
  .xray.placed { visibility: visible; animation: xr-in 70ms var(--ease-standard) 1; }
  @media (prefers-reduced-motion: reduce) { .xray.placed { animation: none; } }
  @keyframes xr-in { from { opacity: 0; } to { opacity: 1; } }
  .xcontent { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; }
  .hk {
    display: inline-flex; align-items: center; justify-content: center;
    min-width: 16px; height: 16px; padding: 0 3px;
    font: 600 10.5px var(--font-mono); color: var(--xr-phos-hi);
    background: var(--xr-tint); border-radius: var(--r-ui);
  }
  .xhead { display: flex; align-items: center; gap: 8px; height: 30px; padding: 0 6px 0 10px; border-bottom: 1px solid var(--xr-line); background: var(--xr-bg); min-width: 0; }
  .ttl { font-size: 11px; letter-spacing: 0.18em; text-transform: uppercase; color: var(--xr-tx); flex: 0 0 auto; }
  .crumbs { display: flex; align-items: center; gap: 4px; min-width: 0; flex: 1; overflow: hidden; white-space: nowrap; font-size: 11px; }
  .crumb { background: none; border: none; padding: 0; font: inherit; color: var(--xr-tx-dim); cursor: var(--cursor-cross-hover); max-width: 160px; overflow: hidden; text-overflow: ellipsis; }
  .crumb:hover { color: var(--xr-phos-hi); }
  .crumb.cur { color: var(--xr-tx); cursor: var(--cursor-cross); }
  .csep { color: var(--xr-tx-dim); flex: 0 0 auto; }
  .csub { color: var(--xr-tx-dim); }
  .xbtn { width: 22px; height: 22px; padding: 0; background: none; border: 0; color: var(--xr-tx-dim); font-size: 16px; cursor: var(--cursor-cross-hover); border-radius: var(--r-ui); font-family: var(--font-ui); }
  .xbtn:hover { color: var(--xr-tx); background: var(--xr-tint-2); }
  /* the file path loses its START, never the file name */
  .srcline { padding: 4px 10px; font-size: 10.5px; color: var(--xr-tx-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; border-bottom: 1px solid var(--xr-line); direction: rtl; text-align: left; }
  .regen { flex: 0 0 auto; height: 22px; background: transparent; color: var(--xr-phos-hi); border: 1px solid var(--xr-line); border-radius: var(--r-ui); padding: 0 8px; font: inherit; font-size: 11px; cursor: var(--cursor-cross-hover); }
  .regen:hover:not(:disabled) { border-color: var(--xr-phos); background: var(--xr-tint-2); }
  .regen:disabled { opacity: 0.6; cursor: var(--cursor-cross); }
  .search-row { display: flex; align-items: center; gap: 8px; height: 30px; padding: 0 10px; border-bottom: 1px solid var(--xr-line); }
  .search-row.active { box-shadow: inset 0 -1px 0 var(--xr-phos); }
  .search-in { flex: 1; background: none; border: none; outline: none; color: var(--xr-tx); font: 12px var(--font-mono); padding: 0; }
  .search-in::placeholder { color: var(--xr-tx-dim); }
  .tree { overflow-y: auto; padding: 4px 6px 6px; min-height: 0; flex: 1 1 auto; }
  /* Only the tree yields height: the header, source line, search row, actions
     and footer keep theirs however tall the colour-scale block grows. */
  .xhead, .srcline, .search-row, .xdetail, .actions, .foot { flex-shrink: 0; }
  .section { display: flex; align-items: baseline; gap: 8px; padding: 8px 6px 3px; font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--xr-tx-dim); border-bottom: 1px solid var(--xr-line); margin-bottom: 2px; }
  .scount { text-transform: none; letter-spacing: 0; }
  .row { display: flex; align-items: center; gap: 6px; height: 24px; padding: 0 6px; scroll-margin-block: 4px; border-radius: var(--r-0); cursor: var(--cursor-cross-hover); font-size: 12px; user-select: none; }
  .row:hover { background: var(--xr-tint-2); }
  /* Selection = phosphor tint + inset rail — NOT a solid fill; the primary row of a multi-pick carries the rail. */
  .row.sel { background: var(--xr-tint); color: var(--xr-tx); }
  .row.sel.primary { box-shadow: inset 2px 0 0 var(--xr-phos); }
  .tw { width: 14px; flex: 0 0 14px; background: none; border: none; color: var(--xr-tx-dim); cursor: var(--cursor-cross-hover); font-size: 9px; padding: 0; font-family: inherit; }
  .row.sel .tw { color: var(--xr-phos-hi); }
  /* Shown is the norm, so it is quiet; partly hidden / hidden / the picked rows stand out. */
  .eye { width: 16px; flex: 0 0 16px; background: none; border: none; color: color-mix(in oklab, var(--xr-phos) 60%, transparent); cursor: var(--cursor-cross-hover); padding: 0; font-size: 12px; font-family: inherit; }
  .row:hover .eye, .row.sel .eye { color: var(--xr-phos-hi); }
  .eye.off { color: var(--xr-tx-dim); }
  .eye.part-off { color: var(--xr-phos); }
  .eye:disabled { opacity: 0.4; cursor: var(--cursor-cross); }
  /* Row anatomy: [path ›] LABEL [#n] · state dot · preview (right, dim) · count.
     The path shrinks first, then the preview; the label keeps its room. */
  .rmain { display: flex; align-items: baseline; gap: 5px; flex: 1 1 auto; min-width: 0; overflow: hidden; }
  .rpath { flex: 0 6 auto; min-width: 2ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--xr-tx-dim); direction: ltr; }
  .psep { padding-left: 5px; color: var(--xr-tx-dim); }
  .rlabel { flex: 0 1 auto; min-width: 6ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rlabel.dim { opacity: 0.45; text-decoration: line-through; }
  /* A plot row among plots: the shared prefix (dim) gives way first, the key never. */
  .rlabel:has(.kpre) { display: flex; min-width: 0; }
  .kpre { color: var(--xr-tx-dim); flex: 0 1 auto; min-width: 2ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .kkey { flex: 0 0 auto; }
  /* Plot rows among plots show only their key (the shared prefix is said once, on the set row). */
  .row[data-kind="element"] .kpre { display: none; }
  /* The locator: every plot of the figure, this one lit — "which plot" read spatially. */
  .loc { flex: 0 0 16px; width: 16px; height: 12px; align-self: center; overflow: visible; }
  .loc rect { fill: none; stroke: color-mix(in oklab, var(--xr-tx) 40%, transparent); stroke-width: 1; vector-effect: non-scaling-stroke; }
  .loc rect.me { fill: var(--xr-phos); stroke: var(--xr-phos-hi); }
  .ord { flex: 0 0 auto; font-size: 10.5px; color: var(--xr-phos); }
  /* restyled: a filled dot hugging the label; hollow = something inside is restyled */
  .sdot { flex: 0 0 auto; width: 5px; height: 5px; border-radius: 50%; background: var(--xr-phos-hi); align-self: center; }
  .sdot.inside { background: none; box-shadow: inset 0 0 0 1px var(--xr-phos); }
  .rprev { flex: 0 8 auto; max-width: 50%; min-width: 0; display: inline-flex; align-items: center; gap: 5px; overflow: hidden; white-space: nowrap; color: var(--xr-tx-dim); font-size: 11px; margin-left: auto; }
  .rprev :global(mark), .rpath :global(mark), .rlabel :global(mark) { background: none; color: var(--xr-phos-hi); font-weight: 600; }
  .ptext { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rprev.varies { font-style: italic; }
  .sw { flex: 0 0 auto; width: 9px; height: 9px; border-radius: 2px; box-shadow: 0 0 0 1px color-mix(in oklab, var(--xr-tx) 70%, transparent); }
  /* A member reads by its VALUE ("SWS"); its index label steps back. */
  .row.member { font-size: 11.5px; }
  .row.member .rlabel { color: var(--xr-tx-dim); }
  .row.member .rprev { color: var(--xr-tx); }
  .eye.ghost { opacity: 0.5; }
  .xmore { display: block; width: 100%; height: 22px; text-align: left; background: none; border: none; color: var(--xr-phos); font: 11px var(--font-mono); cursor: var(--cursor-cross-hover); border-radius: var(--r-0); }
  .xmore:hover { background: var(--xr-tint-2); color: var(--xr-phos-hi); }
  .xmore-hint { color: var(--xr-tx-dim); margin-left: 6px; }
  .sres { flex: 0 0 auto; font-size: 10.5px; color: var(--xr-tx-dim); font-variant-numeric: tabular-nums; }
  /* Search: a plot header over its hits (sticky while they scroll), dim shared prefix. */
  .shead { position: sticky; top: -4px; z-index: 1; display: flex; align-items: baseline; gap: 6px; padding: 7px 6px 3px; background: var(--xr-bg-2); font-size: 10.5px; color: var(--xr-tx-dim); border-bottom: 1px solid var(--xr-line); margin-bottom: 2px; white-space: nowrap; overflow: hidden; }
  .hkey { flex: 0 0 auto; color: var(--xr-tx); font-size: 11.5px; font-weight: 600; }
  .hhint { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .hcount { margin-left: auto; flex: 0 0 auto; font-variant-numeric: tabular-nums; }
  /* The detail strip: fixed height, so the panel never jumps as rows are hovered. */
  .xdetail { flex: 0 0 auto; display: flex; flex-direction: column; justify-content: center; gap: 2px; height: 58px; padding: 0 10px; border-top: 1px solid var(--xr-line); background: var(--xr-bg); font-size: 11px; }
  .dline { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
  .dpath b { color: var(--xr-tx); font-weight: 600; }
  .dctx { color: var(--xr-tx-dim); margin-right: 5px; }
  .dval { color: var(--xr-tx); }
  .dval.none { color: var(--xr-tx-dim); font-style: italic; }
  .dmeta { display: flex; align-items: center; gap: 6px; color: var(--xr-tx-dim); }
  .dfacts { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .did { flex: 0 1 auto; min-width: 0; max-width: 45%; overflow: hidden; text-overflow: ellipsis; direction: rtl; text-align: right; font-size: 10px; opacity: 0.8; }
  .dhint { color: var(--xr-tx-dim); white-space: normal; }
  .tag { font-size: 9px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--xr-phos); border: 1px solid var(--xr-line); border-radius: var(--r-ui); padding: 0 4px; }
  /* one trailing slot, so counts never read as part of a value and previews share a right edge */
  .count { flex: 0 0 auto; min-width: 3ch; margin-left: 6px; text-align: right; font-size: 10.5px; color: color-mix(in oklab, var(--xr-tx) 38%, transparent); font-variant-numeric: tabular-nums; }
  .actions { display: flex; align-items: center; gap: 6px; height: 34px; padding: 0 8px; border-top: 1px solid var(--xr-line); }
  .pickinfo { flex: 1; font-size: 10.5px; color: var(--xr-tx-dim); }
  .showprops, .animbtn { display: inline-flex; align-items: center; gap: 6px; height: 24px; background: transparent; color: var(--xr-phos-hi); border: 1px solid var(--xr-line); border-radius: var(--r-ui); padding: 0 8px; font: inherit; font-size: 11px; cursor: var(--cursor-cross-hover); }
  .showprops:hover:not(:disabled), .animbtn:hover:not(:disabled) { border-color: var(--xr-phos); background: var(--xr-tint-2); }
  .showprops:disabled, .animbtn:disabled { opacity: 0.4; cursor: var(--cursor-cross); }
  .animmenu { display: flex; align-items: center; flex-wrap: wrap; gap: 4px; padding: 6px 8px; border-top: 1px solid var(--xr-line); background: var(--xr-bg); }
  .am-ttl { flex: 0 0 100%; font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--xr-tx-dim); padding-bottom: 2px; }
  .am { display: inline-flex; align-items: center; gap: 6px; height: 24px; background: transparent; color: var(--xr-tx); border: 1px solid var(--xr-line); border-radius: var(--r-ui); padding: 0 8px 0 4px; font: inherit; font-size: 11px; cursor: var(--cursor-cross-hover); }
  .am:hover { border-color: var(--xr-phos); background: var(--xr-tint-2); }
  .am.ghost { color: var(--xr-tx-dim); }
  .empty { color: var(--xr-tx-dim); padding: 12px 4px; }
  .empty.big { padding: 30px 16px; text-align: center; }
  .foot { display: grid; grid-template-columns: repeat(4, max-content); column-gap: 14px; row-gap: 3px; align-items: center; min-height: 26px; padding: 5px 10px; border-top: 1px solid var(--xr-line); font-size: 10.5px; color: var(--xr-tx-dim); background: var(--xr-bg); }
  .foot span { white-space: nowrap; }
</style>
