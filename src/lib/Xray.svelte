<script lang="ts">
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
  // In Slide mode, 'a' animates the pick (Appear / Emphasize / Disappear /
  // Change) straight onto the timeline. Regenerate stays, gated on a
  // recipe-backed plot root. Always dark — an x-ray screen by nature — but flat:
  // no scanlines, no glow, no boot flicker; it opens beside the selection.
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
    embeddedProjectRoot,
    projectDir,
  } from "./store";
  import { plotSourceCandidates, toProjectRelativeSource } from "./plot/source";
  import type { SemanticPlotElement } from "./types";
  import { plotManifests, plotRecipes } from "./plot/store";
  import { buildXrayTree, commonPartRows, targetLabel, type XRow, type XrayTarget } from "./xray/buildXrayTree";
  import { membersDeep } from "./groups";
  import * as ops from "./ops";
  import { reimportPlot } from "./io";
  import { fileBridge } from "./project/types";
  import { fluxFigMenuOpen } from "./settings";
  import { anchorPanel, reclampPanel, unionRects, type Rect } from "./ui/anchor";
  import { xrayAnimate, type XrayAnimateKind, type XrayAnimateTarget } from "./xray/animateHook";
  import type { FluxPlotManifest } from "./plot/types";

  // --- the pinned root + its tree -----------------------------------------
  // The tree rebuilds only while the panel is OPEN — the {#if $xrayOpen}
  // below gates the DOM but not $: blocks, so a closed X-ray never pays a
  // rebuild on every commit.
  $: root = $xrayRoot;
  $: tree = $xrayOpen ? buildXrayTree($project, root, $plotManifests) : null;
  // A multi-plot root's SHARED parts (one row hides a part everywhere).
  $: common = $xrayOpen && root?.kind === "elements" ? commonPartRows(rootPlots($project, root), $plotManifests) : [];
  function rootPlots(p: typeof $project, r: XrayTarget | null): SemanticPlotElement[] {
    if (!r || r.kind !== "elements") return [];
    const f = p.figures.find((ff) => ff.id === r.figId);
    if (!f) return [];
    return r.elementIds
      .map((id) => f.elements.find((e) => e.id === id))
      .filter((e): e is SemanticPlotElement => !!e && e.type === "plot");
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

  // Regenerate: re-run the plot's recipe and hot-swap the result in place,
  // preserving the id-keyed overrides. Gated behind this explicit action (never
  // auto-runs user code) AND on a recipe-backed plot root.
  $: recipe = (rootPlot ? $plotRecipes[rootPlot.assetId] : undefined) as
    | { params?: Record<string, unknown>; lastRun?: string }
    | undefined;
  $: recipePath = rootPlot?.source?.recipePath;
  $: projRoot = $embeddedProjectRoot ?? $projectDir;
  $: srcLabel = rootPlot?.source?.svgPath ? toProjectRelativeSource(projRoot, rootPlot.source.svgPath) : "";
  let regenBusy = false;
  let regenMsg = "";
  async function regenerate(parameters: Record<string, unknown> = recipe?.params ?? {}) {
    const fb = fileBridge();
    if (!rootPlot || !recipePath || !fb?.runRecipe) {
      regenMsg = "no recipe";
      return;
    }
    regenBusy = true;
    regenMsg = "";
    try {
      // source.recipePath is stored PROJECT-RELATIVE (plot/source.ts), but
      // runRecipe reads the file and resolves the recipe's `cwd` from its
      // dirname — it needs a real absolute path.
      let recipeAbs = "";
      for (const c of plotSourceCandidates(projRoot, recipePath)) {
        if (await fb.exists(c)) {
          recipeAbs = c;
          break;
        }
      }
      if (!recipeAbs) {
        regenMsg = "recipe file not found";
      } else {
        const res = await fb.runRecipe(recipeAbs, parameters);
        // Surface the REAL failure instead of a bare "error" — the recipe's stderr on a
        // non-zero exit, and the actual exception message if the output JSON won't parse.
        if (res.code !== 0) {
          const why = String(res.stderr ?? "").trim();
          regenMsg = "recipe failed" + (why ? `: ${why.slice(-200)}` : ` (exit ${res.code})`);
        } else if (res.svgText && res.manifestText) {
          await validateIncomingPlot(res.svgText, res.manifestText);
          reimportPlot(
            rootPlot.assetId,
            res.svgText,
            JSON.parse(res.manifestText) as FluxPlotManifest,
            res.recipeText ? JSON.parse(res.recipeText) : undefined,
          );
          regenMsg = "regenerated ✓";
        } else regenMsg = "no output";
      }
    } catch (e) {
      regenMsg = "error: " + String((e as Error)?.message ?? e);
    }
    regenBusy = false;
  }

  let expanded = new Set<string>();
  let selectedId: string | null = null; // the primary (last-picked) row
  let selectedIds = new Set<string>(); // the whole pick
  let anchorId: string | null = null; // shift-range anchor
  let search = "";
  let mode: "tree" | "search" = "tree";
  let animMenu = false;
  let panelEl: HTMLDivElement;
  let searchEl: HTMLInputElement;

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
  onDestroy(() => sizeObs?.disconnect());

  let prevOpen = false;
  $: {
    if ($xrayOpen && !prevOpen) {
      reset();
      void place();
    }
    if (!$xrayOpen && prevOpen) {
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
    animMenu = false;
    rootStack = [];
    seedExpanded(tree);
    // The drilled parts carry into the opened tree pre-selected + revealed.
    const parts = get(partSelections);
    selectedId = null;
    selectedIds = new Set();
    anchorId = null;
    if (parts.length && root && (root.kind === "element" || root.kind === "elements")) {
      for (const ps of parts) revealRow(`part:${ps.elementId}__${ps.partId}`, true);
    }
    requestAnimationFrame(() => panelEl?.focus({ preventScroll: true }));
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
  // NOTE: `tree`, `common`, `q`, and `expanded` are passed as ARGUMENTS (not
  // read inside the helpers) so Svelte's `$:` dependency analysis tracks them.
  $: rows = buildRows(tree, common, q, expanded);
  function buildRows(t: XRow | null, c: XRow[], query: string, exp: Set<string>): Row[] {
    if (!t) return [];
    const out: Row[] = [];
    if (query) {
      for (const r of c) if (r.label.toLowerCase().includes(query)) out.push({ node: r, depth: 0 });
      searchRows(t, out, query);
    } else {
      for (const r of c) out.push({ node: r, depth: 0 });
      flatten(t, 0, out, exp);
    }
    return out;
  }
  $: commonCount = common.length;

  function findRow(n: XRow | null, cs: XRow[], id: string | null): XRow | null {
    if (!id) return null;
    for (const c of cs) if (c.id === id) return c;
    const dfs = (x: XRow | null): XRow | null => {
      if (!x) return null;
      if (x.id === id) return x;
      for (const ch of x.children) {
        const r = dfs(ch);
        if (r) return r;
      }
      return null;
    };
    return dfs(n);
  }
  $: selRow = findRow(tree, common, selectedId);
  $: pickedRows = [...selectedIds].map((id) => findRow(tree, common, id)).filter((r): r is XRow => !!r);

  /** Expand every ancestor of a row id and select it (re-root landing / open
   *  with drilled parts). Row ids are stable across re-roots. */
  function revealRow(rowId: string, additive = false) {
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
    if (!dfs(tree) && !common.some((c) => c.id === rowId)) return;
    for (const id of path) expanded.add(id);
    expanded = expanded;
    selectedId = rowId;
    const next = additive ? new Set(selectedIds) : new Set<string>();
    next.add(rowId);
    selectedIds = next;
    anchorId ??= rowId;
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
  /** Publish the pick to the editor's selection stores: parts (any row kind
   *  that names one) become the plural part selection; whole objects and
   *  group members become the element selection. */
  function applySelection(picked: XRow[]) {
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
    applySelection([...next].map((id) => findRow(tree, common, id)).filter((r): r is XRow => !!r));
  }
  function pickAll() {
    const ids = rows.map((r) => r.node.id).filter((id) => !id.startsWith("set:"));
    selectedIds = new Set(ids);
    if (!selectedId && ids.length) selectedId = ids[0];
    applySelection(rows.map((r) => r.node).filter((n) => n.kind !== "set"));
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
    rootStack = rootStack.slice(0, -1);
    xrayRoot.set(t);
    requestAnimationFrame(() => seedExpanded(tree));
  }
  function popTo(i: number) {
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

  // --- eye / 'x': per-row-kind hide dispatch, over the whole pick -------------------------
  function toggleHiddenRows(list: XRow[]) {
    const exclusions = get(editorSelectionExclusions);
    const targets = list.filter((n) => !hideBlocked(n, exclusions));
    if (!targets.length) return;
    // Any shown → hide all; every one hidden → show all (the Layers rule).
    const anyShown = targets.some((n) => !n.hidden);
    const hide = anyShown;
    commit((p) => {
      for (const n of targets) {
        if (n.kind === "part" && n.elementId && n.partId) ops.setPartOverride(p, n.elementId, n.partId, { hidden: hide });
        else if (n.kind === "common" && n.partId) for (const id of n.elementIds ?? []) ops.setPartOverride(p, id, n.partId, { hidden: hide });
        else if (n.kind === "element" && n.elementId) ops.setElementStyle(p, [n.elementId], { hidden: hide });
        else if (n.kind === "group" && n.groupId) ops.setGroupState(p, n.groupId, { hidden: hide });
      }
    });
  }
  function toggleHidden(n: XRow) {
    // The eye acts on the pick when the row is part of it, else on the row.
    toggleHiddenRows(selectedIds.has(n.id) && pickedRows.length > 1 ? pickedRows : [n]);
  }

  // --- Animate selected (slide mode only) ------------------------------------------------
  $: canAnimate = !!$xrayAnimate;
  const animOptions: { kind: XrayAnimateKind; label: string; key: string; hint: string }[] = [
    { kind: "appear", label: "Appear", key: "1", hint: "entrance with each kind's default" },
    { kind: "emphasize", label: "Emphasize", key: "2", hint: "highlight" },
    { kind: "disappear", label: "Disappear", key: "3", hint: "exit" },
    { kind: "change", label: "Change", key: "4", hint: "transform — edit the object after this step" },
  ];
  function animateTargets(): XrayAnimateTarget[] {
    const picked = pickedRows.length ? pickedRows : selRow ? [selRow] : [];
    const exclusions = get(editorSelectionExclusions);
    const out: XrayAnimateTarget[] = [];
    const fig = root ? get(project).figures.find((f) => f.id === root.figId) : null;
    for (const n of picked) {
      if (rowBlocked(n, exclusions)) continue;
      if (n.kind === "part" && n.elementId && n.partId) out.push({ elementId: n.elementId, partId: n.partId });
      else if (n.kind === "common" && n.partId) for (const id of n.elementIds ?? []) out.push({ elementId: id, partId: n.partId });
      else if (n.kind === "element" && n.elementId) out.push({ elementId: n.elementId });
      else if (n.kind === "group" && n.groupId && fig) for (const m of membersDeep(fig, n.groupId)) out.push({ elementId: m.id });
      else if (n.kind === "set") for (const c of n.children) if (c.elementId) out.push({ elementId: c.elementId });
    }
    return out;
  }
  function animate(kind: XrayAnimateKind) {
    const handler = get(xrayAnimate);
    const targets = animateTargets();
    animMenu = false;
    if (!handler || !targets.length) return;
    handler({ kind, targets });
    close(); // the timeline takes over — adjust from there
  }

  function enterSearch() {
    mode = "search";
    requestAnimationFrame(() => searchEl?.focus());
  }
  function backToTree() {
    mode = "tree";
    requestAnimationFrame(() => panelEl?.focus({ preventScroll: true }));
  }
  function close() {
    xrayOpen.set(false);
  }

  function onRowClick(e: MouseEvent, n: XRow) {
    if (e.detail > 1) return; // the dblclick handler re-roots
    pick(n, e);
  }
  function onRowDblClick(n: XRow) {
    reRoot(n);
  }

  function onWin(e: KeyboardEvent) {
    // The property menu (opened ON TOP by Show Properties) owns the keyboard
    // while it is up — everything here yields until it closes.
    if (!$xrayOpen || $fluxFigMenuOpen || mode !== "tree") return;
    const k = e.key;
    const lk = k.toLowerCase();
    const mod = e.ctrlKey || e.metaKey;
    if (animMenu) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (k === "Escape" || lk === "a") { animMenu = false; return; }
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
    if (mod && lk === "a") {
      e.preventDefault();
      e.stopImmediatePropagation();
      pickAll();
      return;
    }
    if (lk === "a" && canAnimate) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (pickedRows.length || selRow) animMenu = true;
      return;
    }
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
    if (k === "ArrowDown" || k === "ArrowUp") {
      e.preventDefault();
      const i = rows.findIndex((r) => r.node.id === selectedId);
      const ni = k === "ArrowDown" ? Math.min(rows.length - 1, i + 1) : Math.max(0, i - 1);
      if (rows[ni]) pick(rows[ni].node, { shiftKey: e.shiftKey });
    } else if (k === "ArrowRight" && selRow) {
      expanded.add(selRow.id);
      expanded = expanded;
    } else if (k === "ArrowLeft" && selRow) {
      expanded.delete(selRow.id);
      expanded = expanded;
    } else if (lk === "x" && (pickedRows.length || selRow)) {
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
    } else if (e.key === "Enter" && rows[0]) {
      e.preventDefault();
      pick(rows[selectedId ? Math.max(0, rows.findIndex((r) => r.node.id === selectedId)) : 0]?.node ?? rows[0].node);
      backToTree();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const i = rows.findIndex((r) => r.node.id === selectedId);
      const ni = e.key === "ArrowDown" ? Math.min(rows.length - 1, i + 1) : Math.max(0, i - 1);
      if (rows[ni]) selectedId = rows[ni].node.id;
    }
  }
  const eyeGlyph = (n: XRow) => (n.kind === "common" && n.hiddenCount && n.hiddenCount < (n.elementIds?.length ?? 0) ? "◐" : n.hidden ? "○" : "◉");
</script>

<svelte:window on:keydown={onWin} on:pointermove={onPointerMove} />

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
              <button class="crumb" class:cur={i === crumbs.length - 1} on:click={() => popTo(i)}>{c}</button>
            {/each}
            {#if !crumbs.length}<span class="csub">no target</span>{/if}
          </span>
          {#if rootPlot && recipePath}
            <button class="regen" on:click={() => regenerate()} disabled={regenBusy} title={recipePath}>
              {regenBusy ? "Regenerating…" : regenMsg || "Regenerate"}
            </button>
          {/if}
          <button class="xbtn" on:click={close} aria-label="Close X-ray">×</button>
        </div>
        {#if srcLabel}
          <div class="srcline">{srcLabel}</div>
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
          </div>

          <div class="tree">
            {#if rootPlot && recipePath}
              <ColorScaleControls manifest={$plotManifests[rootPlot.assetId]} params={recipe?.params ?? {}} busy={regenBusy}
                on:regenerate={(event) => regenerate(event.detail)} />
            {/if}
            {#each rows as r, ri (r.node.id)}
              {#if commonCount && !q && ri === 0}
                <div class="section">Common parts <span class="scount">shared by all {common[0]?.elementIds?.length ?? 0}</span></div>
              {:else if commonCount && !q && ri === commonCount}
                <div class="section">Plots</div>
              {/if}
              <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
              <div
                class="row"
                class:sel={selectedIds.has(r.node.id)}
                class:primary={selectedId === r.node.id}
                data-kind={r.node.kind}
                data-rid={r.node.id}
                style={`padding-left:${6 + r.depth * 14}px`}
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
                  class:part-off={r.node.kind === "common" && !!r.node.hiddenCount && !r.node.hidden}
                  disabled={hideBlocked(r.node, $editorSelectionExclusions)}
                  title={hideBlocked(r.node, $editorSelectionExclusions) ? "Enable Show hidden to edit this target" : "Show / hide (x)"}
                  on:click|stopPropagation={() => toggleHidden(r.node)}>{eyeGlyph(r.node)}</button
                >
                <span class="rlabel" class:dim={r.node.hidden}>{r.node.label}</span>
                {#if r.node.kind === "group"}<span class="tag">grp</span>{/if}
                {#if r.node.kind === "common"}<span class="tag">×{r.node.elementIds?.length ?? 0}</span>{/if}
                {#if r.node.count && r.node.kind !== "common"}<span class="count">{r.node.count}</span>{/if}
              </div>
            {/each}
          </div>

          {#if animMenu}
            <div class="animmenu" role="menu" aria-label="Animate selected">
              <span class="am-ttl">Animate {animateTargets().length} {animateTargets().length === 1 ? "target" : "targets"}</span>
              {#each animOptions as o (o.kind)}
                <button class="am" role="menuitem" title={o.hint} on:click={() => animate(o.kind)}><span class="hk">{o.key}</span>{o.label}</button>
              {/each}
              <button class="am ghost" on:click={() => (animMenu = false)}><span class="hk">esc</span>cancel</button>
            </div>
          {/if}
          <div class="actions">
            <span class="pickinfo">{selectedIds.size > 1 ? `${selectedIds.size} picked` : ""}</span>
            <button class="animbtn" disabled={!canAnimate || !(pickedRows.length || selRow)} title={canAnimate ? "Add an animation for every picked row (a)" : "Animate is available in Slide mode"} on:click={() => (animMenu = !animMenu)}>
              Animate selected <span class="hk">a</span>
            </button>
            <button class="showprops" disabled={!(pickedRows.length || selRow) || (pickedRows.length ? pickedRows : selRow ? [selRow] : []).every((n) => rowBlocked(n, $editorSelectionExclusions))} on:click={showProperties}>
              Show Properties <span class="hk">↵</span>
            </button>
          </div>
        {/if}

        <div class="foot">
          <span><b class="hk">↑↓</b> navigate</span>
          <span><b class="hk">⇧/⌃ click</b> multi</span>
          <span><b class="hk">x</b> hide</span>
          <span><b class="hk">dbl-click</b> re-root</span>
          <span><b class="hk">⌫</b> back</span>
          <span><b class="hk">s</b> search</span>
          <span><b class="hk">r</b>/esc close</span>
        </div>
      </div>
    </div>
  </div>
{/if}

<style>
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
    width: 460px;
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
  .crumb { background: none; border: none; padding: 0; font: inherit; color: var(--xr-tx-dim); cursor: pointer; max-width: 160px; overflow: hidden; text-overflow: ellipsis; }
  .crumb:hover { color: var(--xr-phos-hi); }
  .crumb.cur { color: var(--xr-tx); cursor: default; }
  .csep { color: var(--xr-tx-dim); flex: 0 0 auto; }
  .csub { color: var(--xr-tx-dim); }
  .xbtn { width: 22px; height: 22px; padding: 0; background: none; border: 0; color: var(--xr-tx-dim); font-size: 16px; cursor: pointer; border-radius: var(--r-ui); font-family: var(--font-ui); }
  .xbtn:hover { color: var(--xr-tx); background: var(--xr-tint-2); }
  .srcline { padding: 4px 10px; font-size: 10.5px; color: var(--xr-tx-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; border-bottom: 1px solid var(--xr-line); }
  .regen { flex: 0 0 auto; height: 22px; background: transparent; color: var(--xr-phos-hi); border: 1px solid var(--xr-line); border-radius: var(--r-ui); padding: 0 8px; font: inherit; font-size: 11px; cursor: pointer; }
  .regen:hover:not(:disabled) { border-color: var(--xr-phos); background: var(--xr-tint-2); }
  .regen:disabled { opacity: 0.6; cursor: default; }
  .search-row { display: flex; align-items: center; gap: 8px; height: 30px; padding: 0 10px; border-bottom: 1px solid var(--xr-line); }
  .search-row.active { box-shadow: inset 0 -1px 0 var(--xr-phos); }
  .search-in { flex: 1; background: none; border: none; outline: none; color: var(--xr-tx); font: 12px var(--font-mono); padding: 0; }
  .search-in::placeholder { color: var(--xr-tx-dim); }
  .tree { overflow-y: auto; padding: 4px 6px 6px; min-height: 0; flex: 1 1 auto; }
  .section { display: flex; align-items: baseline; gap: 8px; padding: 8px 6px 3px; font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--xr-tx-dim); border-bottom: 1px solid var(--xr-line); margin-bottom: 2px; }
  .scount { text-transform: none; letter-spacing: 0; }
  .row { display: flex; align-items: center; gap: 6px; height: 24px; padding: 0 6px; border-radius: var(--r-0); cursor: pointer; font-size: 12px; user-select: none; }
  .row:hover { background: var(--xr-tint-2); }
  /* Selection = phosphor tint + inset rail — NOT a solid fill; the primary row of a multi-pick carries the rail. */
  .row.sel { background: var(--xr-tint); color: var(--xr-tx); }
  .row.sel.primary { box-shadow: inset 2px 0 0 var(--xr-phos); }
  .tw { width: 14px; flex: 0 0 14px; background: none; border: none; color: var(--xr-tx-dim); cursor: pointer; font-size: 9px; padding: 0; font-family: inherit; }
  .row.sel .tw { color: var(--xr-phos-hi); }
  .eye { width: 16px; flex: 0 0 16px; background: none; border: none; color: var(--xr-phos-hi); cursor: pointer; padding: 0; font-size: 12px; font-family: inherit; }
  .eye.off { color: var(--xr-tx-dim); }
  .eye.part-off { color: var(--xr-phos); }
  .eye:disabled { opacity: 0.4; cursor: default; }
  .rlabel { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rlabel.dim { opacity: 0.45; text-decoration: line-through; }
  .tag { font-size: 9px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--xr-phos); border: 1px solid var(--xr-line); border-radius: var(--r-ui); padding: 0 4px; }
  .count { font-size: 10.5px; color: var(--xr-tx-dim); font-variant-numeric: tabular-nums; }
  .actions { display: flex; align-items: center; gap: 6px; height: 34px; padding: 0 8px; border-top: 1px solid var(--xr-line); }
  .pickinfo { flex: 1; font-size: 10.5px; color: var(--xr-tx-dim); }
  .showprops, .animbtn { display: inline-flex; align-items: center; gap: 6px; height: 24px; background: transparent; color: var(--xr-phos-hi); border: 1px solid var(--xr-line); border-radius: var(--r-ui); padding: 0 8px; font: inherit; font-size: 11px; cursor: pointer; }
  .showprops:hover:not(:disabled), .animbtn:hover:not(:disabled) { border-color: var(--xr-phos); background: var(--xr-tint-2); }
  .showprops:disabled, .animbtn:disabled { opacity: 0.4; cursor: default; }
  .animmenu { display: flex; align-items: center; flex-wrap: wrap; gap: 4px; padding: 6px 8px; border-top: 1px solid var(--xr-line); background: var(--xr-bg); }
  .am-ttl { flex: 0 0 100%; font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--xr-tx-dim); padding-bottom: 2px; }
  .am { display: inline-flex; align-items: center; gap: 6px; height: 24px; background: transparent; color: var(--xr-tx); border: 1px solid var(--xr-line); border-radius: var(--r-ui); padding: 0 8px 0 4px; font: inherit; font-size: 11px; cursor: pointer; }
  .am:hover { border-color: var(--xr-phos); background: var(--xr-tint-2); }
  .am.ghost { color: var(--xr-tx-dim); }
  .empty { color: var(--xr-tx-dim); padding: 12px 4px; }
  .empty.big { padding: 30px 16px; text-align: center; }
  .foot { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; min-height: 26px; padding: 2px 10px; border-top: 1px solid var(--xr-line); font-size: 10.5px; color: var(--xr-tx-dim); background: var(--xr-bg); }
</style>
