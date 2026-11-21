<script lang="ts">
  import { partContext } from "./xray/rowContext";
  import type { FluxPlotManifest } from "./plot/types";
  import { numericStep, numericFraction } from "./interact/numericStep";
  import { yieldsToShellModal, isAnnotateChord } from "../shell/agent/annotationVisibility";

  // The property menu — `f` (2026-09-15 surface redesign). The main way
  // of editing object properties without the right rail: left hand on the
  // keyboard, right hand on the mouse, and neither ever has to leave.
  //
  //   · It opens INSTANTLY beside the selection (ui/anchor.ts — right of the
  //     selection box, else left/below/above, never covering it), aligned to
  //     the pointer, and lays its groups out in COLUMNS so it never scrolls.
  //   · Every property has a left-hand hotkey (the letter on its row). Pressing
  //     it ARMS the row: a number then follows the mouse WHEEL (speed-scaled:
  //     a flick moves fast, a slow roll moves one step; Shift ×10, Alt ×0.1)
  //     or the arrow keys, typed digits replace it, and Space / Enter confirm;
  //     a choice expands its options inline (wheel / w·a·s·d / 1–9 / click);
  //     a colour opens the palette picker (hover previews, click commits);
  //     a toggle flips at once. Escape reverts the armed edit, Escape again
  //     (or f) closes. Hovering any numeric row and rolling the wheel edits it
  //     directly — the whole menu is usable with the mouse alone as well.
  //   · Every armed edit is ONE undo entry (editSession), previewed live.
  //
  // The field model (labels, hotkeys, readers, live appliers, ranges) lives in
  // interact/propertyMenu.ts, shared with the Inspector's part section.
  //
  // THE LOOK (2026-11-20, owner's pick from a click-to-try viewer: "B Compact"): the menu is an
  // instrument, like the image live view's board. One plate, a card per group, one LINE per
  // property and no boxes at rest: a number gets its well under the pointer or in hand. Position
  // and size pair up (x | width, y | height); on/off properties are small paper keys on their
  // group's head, lit when on; a number that has a natural picture is drawn by it (opacity: a
  // fader over the object's own colour; rotation: a dial; corner radius: a corner; stroke width:
  // a sample of the line), and faders, tracks and the dial can be dragged. One hint line at the
  // foot says what the hand can do with what is under it. A geometric row in hand is measured on
  // the object itself (interact/measure.ts). interact/menuLook.ts holds the layout and the marks.
  // Every hook the gates and the keyboard rely on is unchanged: `.field[data-key]`, `.label` with
  // the field's full label, `.hk`, `.nin` / `.tin`, `.toggle`, `.colorbtn`, `.selbtn`, `.opts .opt`.
  import { onDestroy, tick } from "svelte";
  import { get } from "svelte/store";
  import { editSession } from "./interact/editSession";
  import { selectionTargets } from "./interact/selectionTargets";
  import { buildMenuFields, groupFields, fieldRange, setDimensionBase, type Field } from "./interact/propertyMenu";
  import { anchorPanel, reanchorPanel, unionRects, type Rect, type Point } from "./ui/anchor";
  import { WheelStepper, wheelDelta, wheelMultiplier } from "./interact/wheelLaw";
  import { project, selection, partSelection, partSelections } from "./store";
  import { plotManifests } from "./plot/store";
  import { globalTextStyles, loadGlobalTextStyles } from "./textStyles";
  import { evalExpr, fmtNum } from "./num";
  import { scrub } from "./scrub";
  import { nameForHex, currentGradient } from "./colors";
  import { gradientCss, gradientLabel } from "./color/gradient";
  import { fluxFigMenuOpen } from "./settings";
  import ColorPicker from "./ColorPicker.svelte";
  import { logoImageUrl } from "../shell/logoImage";
  import { fluxAiMarkElement } from "../shell/agent/fluxAiMark";
  import { looksOf, menuLines, menuColumns, menuWidth, instrumentOf, measureOf, shortNum, valueAtFraction, toggleGlyph, toggleWord, actionGlyph, MENU_GLYPHS, type Instrument } from "./interact/menuLook";
  import { fluxFigMeasure } from "./interact/measure";
  import { elementLabel } from "./xray/buildXrayTree";
  import { semanticPartIndex } from "./plot/partStyle";
  import { scene3dManifests } from "./model3d/store";
  import type { Element as FluxElement, Figure } from "./types";

  // "wide": a field that needs room (the colour scale) owns the whole body,
  // the way "color" gives it to the colour picker.
  type Mode = "hotkey" | "field" | "option" | "color" | "search" | "wide";

  // The Flux mark, as one image (decoded when this module loads, long before the first f).
  const MARK = logoImageUrl();
  // The Flux AI mark on the Ask key, still: built once by the mark's own builder and cloned in at each open
  // (a mounted component per open would be effects and style bindings for a mark that never moves here).
  let aiMarkStill: HTMLElement | null = null;
  function aiMark(node: HTMLElement) {
    aiMarkStill ??= fluxAiMarkElement(document, 14, "ready", true);
    node.prepend(aiMarkStill.cloneNode(true));
  }
  /** A row's standing classes, by its place: a full row, the left cell of a pair, the right cell. */
  const ROW_CLASS = ["field", "field half", "field half right"] as const;
  const session = editSession();
  onDestroy(() => session.finish());

  let mode: Mode = "hotkey";
  let activeKey: string | null = null;
  let colorField: Field | null = null;
  let wideField: Field | null = null;
  let vw = typeof window === "undefined" ? 1600 : window.innerWidth;
  let vh = typeof window === "undefined" ? 1000 : window.innerHeight;
  let draft = "";
  let optIndex = 0;
  let search = "";
  let sIndex = 0;
  let panelEl: HTMLDivElement;
  let searchEl: HTMLInputElement;
  let inputs: Record<string, HTMLInputElement | undefined> = {};

  // (Re)build the field list whenever the selection / part selection or its
  // data changes (the global style library too — it feeds the style fields).
  $: fields = $fluxFigMenuOpen ? buildMenuFields($project, $selection, $partSelections, $plotManifests, $globalTextStyles, $scene3dManifests) : [];
  $: groups = groupFields(fields);
  // Columns by the lines the layout takes, plus one more whenever they would not
  // fit the window's height — as far as the window's width allows (menuLook.menuColumns).
  $: looks = looksOf(groups);
  $: cols = menuColumns(menuLines(looks), looks.length, vw, vh);
  // The panel sizes to what it shows — its columns, the colour picker's
  // 648, the colour-scale view's 808 (controls beside an always-open palette
  // list) — and never past the window (owner inbox 2026-09-30).
  $: width = Math.max(240, Math.min(mode === "color" ? 648 : mode === "wide" ? 808 : menuWidth(cols), vw - 16));
  $: sQ = search.trim().toLowerCase();
  $: sResults = sQ ? fields.filter((f) => `${f.label} ${f.group} ${f.key}`.toLowerCase().includes(sQ)) : fields;
  $: if (sIndex >= sResults.length) sIndex = Math.max(0, sResults.length - 1);
  $: active = activeKey ? (fields.find((f) => f.key === activeKey) ?? null) : null;
  // The header names the THING (owner request 2026-09-15): the Flux mark, a
  // hairline, then the same name the Layers rail shows — "rect 1", a plot's
  // file name, a custom name — and for a part the plot › part; `.ctx` carries
  // the kind or the plural count so the plural pick still reads "2 plot parts".
  $: head = describeHead($selection, $partSelections, $project, $plotManifests, $scene3dManifests);
  // "plot › X axis › Tick labels": the place (which gives way first in a narrow head) and the name.
  $: nameCut = head.name.lastIndexOf(" › ");
  $: namePath = nameCut >= 0 ? head.name.slice(0, nameCut + 3) : "";
  $: nameLast = nameCut >= 0 ? head.name.slice(nameCut + 3) : head.name;
  function describeHead(
    sel: Set<string>,
    parts: { elementId: string; partId: string }[],
    p: typeof $project,
    manifests: typeof $plotManifests,
    models: typeof $scene3dManifests,
  ): { name: string; ctx: string } {
    const find = (id: string): { f: Figure; e: FluxElement } | null => {
      for (const f of p.figures) {
        const e = f.elements.find((x) => x.id === id);
        if (e) return { f, e };
      }
      return null;
    };
    if (parts.length) {
      const first = find(parts[0].elementId);
      const plotName = first ? elementLabel(first.f, first.e, manifests) : "plot";
      const plots = new Set(parts.map((pt) => pt.elementId)).size;
      if (parts.length === 1) {
        const m = first?.e.type === "model3d" ? models[first.e.assetId] : first?.e.type === "plot" ? manifests[first.e.assetId] : undefined;
        const info = m ? semanticPartIndex(m)[parts[0].partId] : undefined;
        const label =
          info?.label ??
          ([info?.role, info?.series, info && "index" in info && info.index !== undefined ? `#${info.index}` : null].filter(Boolean).join(" · ") || parts[0].partId);
        // Where it sits ("X axis › Tick labels"): a bare "Tick labels" never says which axis.
        const path = first?.e.type === "plot" && m ? partContext(m as FluxPlotManifest, parts[0].partId).path : [];
        return { name: [plotName, ...path, label].join(" › "), ctx: first?.e.type === "model3d" ? "3D part" : "plot part" };
      }
      // The SAME part on several plots (a common X-ray row, ⇧A): name the part, count the plots.
      const one = parts.every((pt) => pt.partId === parts[0].partId);
      const m0 = first?.e.type === "plot" ? manifests[first.e.assetId] : undefined;
      if (one && plots > 1 && m0) {
        const label = semanticPartIndex(m0)[parts[0].partId]?.label ?? parts[0].partId;
        return { name: [...partContext(m0, parts[0].partId).path, label].join(" › "), ctx: `${parts.length} plot parts · ${plots} plots` };
      }
      return { name: plots > 1 ? `${plots} plots` : plotName, ctx: `${parts.length} plot parts` };
    }
    if (!sel.size) return { name: "Drawing defaults", ctx: "" };
    const kinds = new Map<string, number>();
    let single: { f: Figure; e: FluxElement } | null = null;
    for (const f of p.figures)
      for (const e of f.elements)
        if (sel.has(e.id)) {
          kinds.set(e.type, (kinds.get(e.type) ?? 0) + 1);
          single ??= { f, e };
        }
    const list = [...kinds].map(([k, n]) => (n > 1 ? `${n} ${k}s` : k)).join(", ");
    if (sel.size === 1 && single) {
      const name = elementLabel(single.f, single.e, manifests);
      return { name, ctx: name.startsWith(single.e.type) ? "" : single.e.type };
    }
    return { name: `${sel.size} selected`, ctx: list };
  }

  // --- pointer + placement -----------------------------------------------------
  // The last pointer position is the anchor's second input; tracking it costs
  // one assignment per move (no reactivity).
  const pointer = { x: -1, y: -1 };
  function onPointerMove(e: PointerEvent) {
    pointer.x = e.clientX;
    pointer.y = e.clientY;
  }
  let pos = { x: 0, y: 0 };
  let placed = false;
  let sizeObs: ResizeObserver | null = null;
  let openedAvoid: Rect | null = null;
  let openedPoint: Point | null = null;

  /** The screen box the panel must not cover: the canvas's selection box(es),
   *  else the selected elements' own DOM boxes. */
  function avoidRect(): Rect | null {
    const rects: Rect[] = [];
    for (const n of document.querySelectorAll<Element>(".canvas-host .sel-box")) {
      const r = n.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) rects.push({ x: r.left, y: r.top, w: r.width, h: r.height });
    }
    if (!rects.length) {
      for (const id of get(selection)) {
        const n = document.querySelector<Element>(`.canvas-host [data-editor-element-id="${CSS.escape(id)}"]`);
        const r = n?.getBoundingClientRect();
        if (r && r.width > 0) rects.push({ x: r.left, y: r.top, w: r.width, h: r.height });
      }
    }
    // Opened from the X-ray (Show Properties): land beside the X-ray too, so
    // the tree stays readable while its rows are being edited.
    const xr = document.querySelector<Element>(".xray")?.getBoundingClientRect();
    if (xr && xr.width > 0) rects.push({ x: xr.left, y: xr.top, w: xr.width, h: xr.height });
    return unionRects(rects);
  }
  async function place() {
    placed = false;
    await tick();
    const el = panelEl;
    if (!$fluxFigMenuOpen || !el) return;
    const size = { w: el.offsetWidth, h: el.offsetHeight };
    const vp = { w: window.innerWidth, h: window.innerHeight };
    openedAvoid = avoidRect();
    openedPoint = pointer.x >= 0 ? { x: pointer.x, y: pointer.y } : null;
    const r = anchorPanel({ avoid: openedAvoid, point: openedPoint, size, viewport: vp });
    pos = { x: r.x, y: r.y };
    placed = true;
    sizeObs?.disconnect();
    sizeObs = new ResizeObserver(resizePlacement);
    sizeObs.observe(el);
    focusPanel(); // The placed class must be flushed before this panel can take focus.
  }
  function resizePlacement() {
    if (!$fluxFigMenuOpen || !placed || !panelEl) return;
    const p = reanchorPanel(pos, {
      avoid: openedAvoid, point: openedPoint,
      size: { w: panelEl.offsetWidth, h: panelEl.offsetHeight },
      viewport: { w: window.innerWidth, h: window.innerHeight },
    });
    if (p.x !== pos.x || p.y !== pos.y) pos = p;
  }

  // Reset state each time the menu opens (+ refresh the global style library
  // so the style fields list current definitions).
  let prevOpen = false;
  $: {
    if ($fluxFigMenuOpen && !prevOpen) {
      reset();
      loadGlobalTextStyles();
      void place();
    }
    if (!$fluxFigMenuOpen && prevOpen) {
      session.finish();
      sizeObs?.disconnect();
      sizeObs = null;
    }
    prevOpen = $fluxFigMenuOpen;
  }
  onDestroy(() => sizeObs?.disconnect());
  function reset() {
    session.finish();
    setDimensionBase(null);
    mode = "hotkey";
    activeKey = null;
    colorField = null;
    wideField = null;
    search = "";
    sIndex = 0;
    wheel.reset();
  }

  // --- interaction ---------------------------------------------------------------
  function close() {
    session.finish();
    fluxFigMenuOpen.set(false);
  }
  function focusPanel() {
    void tick().then(() => {
      if ($fluxFigMenuOpen && mode === "hotkey") panelEl?.focus({ preventScroll: true });
    });
  }
  function captureDimBase() {
    const base = new Map<string, { w: number; h: number }>();
    for (const fig of get(project).figures)
      for (const e of selectionTargets(fig, get(selection), { editable: true }))
        if ("width" in e && "height" in e) base.set(e.id, { w: e.width, h: e.height });
    setDimensionBase(base);
  }
  function enterField(f: Field) {
    if ((mode === "field" || mode === "option") && activeKey === f.key) return;
    session.finish();
    captureDimBase();
    activeKey = f.key;
    draft = f.mixed ? "" : String(f.get());
    mode = f.kind === "select" ? "option" : "field";
    if (f.kind === "select") optIndex = Math.max(0, (f.options ?? []).findIndex((o) => o.value === String(f.get())));
    wheel.reset();
  }
  function applyField(f: Field, value: string | number | boolean) {
    if (f.kind !== "toggle" && f.kind !== "action" && !f.mixed && String(value) === String(f.get())) return;
    session.run(() => f.apply(value));
  }
  function activate(f: Field) {
    session.finish();
    if (f.kind === "color") {
      colorField = f;
      activeKey = f.key;
      mode = "color";
      return;
    }
    if (f.kind === "colorScale") {
      wideField = f;
      activeKey = f.key;
      mode = "wide";
      // The palette list takes the keyboard: ↑↓ walk, Enter applies, Esc goes back.
      void tick().then(() => {
        if (mode !== "wide") return;
        (panelEl?.querySelector<HTMLElement>(".palette-pane .cmp") ?? panelEl)?.focus({ preventScroll: true });
      });
      return;
    }
    if (f.kind === "toggle" || f.kind === "action") {
      strike(f.key);
      applyField(f, true);
      session.finish();
      return;
    }
    enterField(f);
    // Focus after the DOM flush, before the next input event. Waiting for a
    // paint frame can lose the first digits of a fast hotkey → value sequence.
    void tick().then(() => {
      if (!$fluxFigMenuOpen || activeKey !== f.key || (mode !== "field" && mode !== "option")) return;
      const el = inputs[f.key];
      if (f.kind === "select" || f.kind === "axisView") {
        panelEl?.focus({ preventScroll: true });
        return;
      }
      el?.focus();
      if (el instanceof HTMLInputElement) el.select();
    });
  }
  /** Confirm the armed field and return to hotkey mode. */
  function confirmField() {
    session.finish();
    activeKey = null;
    mode = "hotkey";
    setDimensionBase(null);
    focusPanel();
  }
  /** Revert the armed field and return to hotkey mode. */
  function cancelField() {
    session.cancel();
    activeKey = null;
    mode = "hotkey";
    setDimensionBase(null);
    focusPanel();
  }
  function blurField(f: Field) {
    if (activeKey !== f.key || mode !== "field") return;
    session.finish();
    activeKey = null;
    mode = "hotkey";
    setDimensionBase(null);
  }
  function enterSearch() {
    mode = "search";
    void tick().then(() => {
      if ($fluxFigMenuOpen && mode === "search") searchEl?.focus();
    });
  }
  function backToHotkey() {
    session.finish();
    mode = "hotkey";
    activeKey = null;
    colorField = null;
    wideField = null;
    setDimensionBase(null);
    focusPanel();
  }

  // --- numeric stepping: keys + wheel ------------------------------------------------
  function stepValue(f: Field, steps: number, mult = 1) {
    const cur = f.mixed && draft === "" ? Number(f.get()) : (evalExpr(draft) ?? Number(f.get()));
    let v = numericStep(Number.isFinite(cur) ? cur : 0, steps * mult, f.step ?? 1, f.factor);
    if (f.min != null) v = Math.max(f.min, v);
    if (f.max != null) v = Math.min(f.max, v);
    v = +v.toFixed(6);
    draft = fmtNum(v);
    applyField(f, v);
  }
  // The wheel follows the ONE law in interact/wheelLaw.ts: a notch is a step
  // in every dialect (Windows 100px, a slow macOS mouse's 4px, a trackpad's
  // stream), a spin moves further, a flick doubles, Shift ×10, Alt ×0.1.
  const wheel = new WheelStepper();
  /** Window-level, capture phase: once a row is armed (f, then its letter) the
   *  wheel adjusts it wherever the mouse is — the canvas must not zoom. */
  function onWinWheel(e: WheelEvent) {
    if (yieldsToShellModal(e)) return;
    if (!$fluxFigMenuOpen || !(mode === "field" || mode === "option") || !active || active.kind === "axisView") return;
    if (panelEl?.contains(e.target as Node)) return; // the panel's own handler (hover-arming) takes it
    e.preventDefault();
    e.stopPropagation();
    wheelField(e, active);
  }
  function onWheel(e: WheelEvent) {
    if (mode === "color" || mode === "search" || mode === "wide") return;
    let f: Field | null = null;
    if ((mode === "field" || mode === "option") && active) f = active;
    else {
      const row = (e.target as HTMLElement | null)?.closest<HTMLElement>(".field[data-key]");
      const key = row?.dataset.key;
      const hover = key ? (fields.find((x) => x.key === key) ?? null) : null;
      if (hover && (hover.kind === "number" || hover.kind === "select")) {
        f = hover;
        enterField(hover); // arms it — the whole menu is mouse-only editable
        if (hover.kind === "number") void tick().then(() => {
          if (!$fluxFigMenuOpen || mode !== "field" || activeKey !== hover.key) return;
          const el = inputs[hover.key]; el?.focus({ preventScroll: true }); el?.select();
        });
      }
    }
    if (!f || f.kind === "axisView") return; // nothing armed under the pointer: let the body scroll
    e.preventDefault();
    e.stopPropagation();
    wheelField(e, f);
  }
  function wheelField(e: WheelEvent, f: Field) {
    const steps = wheel.steps({ deltaY: wheelDelta(e), deltaMode: e.deltaMode, time: performance.now() });
    if (!steps) return;
    if (f.kind === "number") stepValue(f, steps, wheelMultiplier(e)); // wheel up = increase
    else if (f.kind === "select") moveOption(f, steps > 0 ? -1 : 1);
  }

  // --- option strips ------------------------------------------------------------------
  function moveOption(f: Field, d: number) {
    const opts = f.options ?? [];
    if (!opts.length) return;
    optIndex = Math.max(0, Math.min(opts.length - 1, optIndex + d));
    applyField(f, opts[optIndex].value);
  }
  function previewOption(f: Field, i: number) {
    optIndex = i;
    applyField(f, (f.options ?? [])[i]?.value ?? "");
  }
  function pickOption(f: Field, i: number) {
    previewOption(f, i);
    confirmField();
  }

  // --- keyboard ---------------------------------------------------------------------------
  function onWin(e: KeyboardEvent) {
    if (e.target instanceof HTMLElement && e.target.closest('[data-command-scope="model3d-orbit"]')) return;
    if (yieldsToShellModal(e) || isAnnotateChord(e)) return;
    if (e.defaultPrevented || !$fluxFigMenuOpen) return;
    const t = e.target as HTMLElement | null;
    const typing = !!t && (t.matches("input, textarea, select") || t.isContentEditable);
    const k = e.key;
    const lk = k.toLowerCase();
    if (mode === "hotkey") {
      if (typing) return;
      if (k === "Escape" || lk === "f") {
        // stopImmediatePropagation prevents the global shortcut handler from
        // re-processing the same key (e.g. re-opening on the closing "f").
        e.preventDefault();
        e.stopImmediatePropagation();
        close();
        return;
      }
      if (lk === "s") {
        e.preventDefault();
        e.stopImmediatePropagation();
        enterSearch();
        return;
      }
      const f = fields.find((fl) => fl.key === lk);
      if (f) {
        e.preventDefault();
        e.stopImmediatePropagation();
        activate(f);
      }
      return;
    }
    if (mode === "option" && active) {
      const f = active;
      e.stopImmediatePropagation();
      if (k === "Escape") { e.preventDefault(); cancelField(); return; }
      if (k === "Enter" || k === " ") { e.preventDefault(); confirmField(); return; }
      if (k === "ArrowDown" || k === "ArrowRight" || lk === "s" || lk === "d") { e.preventDefault(); moveOption(f, 1); return; }
      if (k === "ArrowUp" || k === "ArrowLeft" || lk === "w" || lk === "a") { e.preventDefault(); moveOption(f, -1); return; }
      if (/^[1-9]$/.test(k)) {
        const i = Number(k) - 1;
        if (i < (f.options ?? []).length) { e.preventDefault(); pickOption(f, i); }
        return;
      }
      if (lk === "f") { e.preventDefault(); confirmField(); close(); }
      return;
    }
    if (mode === "wide") {
      // Controls inside own their keys (a limit's Escape reverts it; the palette
      // list's Escape comes back through onClose); from anywhere else Escape
      // returns to the menu and f closes it.
      if (typing) return;
      if (k === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); backToHotkey(); return; }
      if (lk === "f") { e.preventDefault(); e.stopImmediatePropagation(); close(); return; }
      return;
    }
    if (active?.kind === "axisView" && !typing && (k === "Escape" || lk === "f")) {
      e.preventDefault(); e.stopImmediatePropagation(); confirmField(); return;
    }
    // field / color / search modes: the focused control owns the keys.
  }
  function onFieldKey(e: KeyboardEvent, f: Field) {
    e.stopPropagation();
    if (e.key === "Escape") { e.preventDefault(); cancelField(); return; }
    if (e.key === "Enter" || (e.key === " " && f.kind === "number")) { e.preventDefault(); confirmField(); return; }
    if (f.kind === "number" && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      stepValue(f, e.key === "ArrowUp" ? 1 : -1, e.shiftKey ? 10 : e.altKey ? 0.1 : 1);
    }
  }
  /** Keep the result the keyboard is on in view (a long list on a short window). */
  function showResult() {
    void tick().then(() => panelEl?.querySelector(".res.active")?.scrollIntoView({ block: "nearest" }));
  }
  function onSearchKey(e: KeyboardEvent) {
    e.stopPropagation();
    if (e.key === "ArrowDown") { e.preventDefault(); sIndex = Math.min(sResults.length - 1, sIndex + 1); showResult(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); sIndex = Math.max(0, sIndex - 1); showResult(); }
    else if (e.key === "Enter") {
      e.preventDefault();
      const f = sResults[sIndex];
      if (f) { mode = "hotkey"; activate(f); }
    } else if (e.key === "Escape") { e.preventDefault(); backToHotkey(); }
  }

  function colorDisplay(f: Field): { hex: string; name: string } {
    // a colormap gradient on the element: the chip shows the map, named with its axis
    const g = f.target ? currentGradient(f.target) : null;
    const css = g ? gradientCss(g) : null;
    if (g && css) return { hex: css, name: gradientLabel(g) };
    const hex = String(f.get());
    return { hex, name: hex === "none" ? "none" : (nameForHex(hex) ?? hex) };
  }
  const pct = (f: Field): number => {
    const r = fieldRange(f);
    if (!r) return 0;
    const v = Number(f.get());
    return numericFraction(v, r.min, r.max, f.factor) * 100;
  };

  // --- the look: what is under the pointer, the instruments, the measure ------------------------
  // The paints the instruments are drawn in: an opacity fades the object's own colour, a stroke
  // width is a sample of the object's own line.
  $: fillField = fields.find((f) => f.kind === "color" && f.target === "fill") ?? null;
  $: strokeField = fields.find((f) => f.kind === "color" && f.target === "stroke") ?? null;
  $: dashedField = fields.find((f) => f.kind === "toggle" && f.label === "dashed stroke") ?? null;
  /** A colour field's paint as CSS (a gradient for a colormap), or null for none. No name lookup: this is read on every render. */
  const paintOf = (f: Field | null): string | null => {
    if (!f) return null;
    const g = f.target ? currentGradient(f.target) : null;
    const css = g ? gradientCss(g) : null;
    if (css) return css;
    const hex = String(f.get());
    return hex === "none" ? null : hex;
  };
  $: fillInk = paintOf(fillField);
  $: strokeInk = paintOf(strokeField);
  const faderPaint = (f: Field, fill: string | null, stroke: string | null): string => {
    const ink = f.prop === "strokeOpacity" ? stroke : f.prop === "fillOpacity" ? fill : (fill ?? stroke);
    // The fader fades ONE colour in; a colormap paint (a gradient) is not one, and the menu's own ink stands in.
    return ink && !ink.includes("gradient") ? ink : "var(--fm-tx)";
  };
  /** A corner as round as the value says (it stops growing where a picture this small stops telling). */
  const cornerPath = (v: number): string => {
    const r = +(Math.max(0, Math.min(1, v / 40)) * 11).toFixed(2);
    return `M3.5 16V${3.5 + r}a${r} ${r} 0 0 1 ${r} ${-r}H16`;
  };
  /** A fader, a track or the dial under the hand: the value follows the pointer, as one undo
   *  entry, and nothing stays in hand afterwards (the same contract as dragging a name). */
  function instrument(node: Element, params: { f: Field; kind: Instrument }) {
    let p = params, pointer: number | null = null;
    const valueAt = (e: PointerEvent): number | null => {
      const r = node.getBoundingClientRect();
      if (p.kind === "dial") {
        const a = Math.round((Math.atan2(e.clientX - (r.left + r.width / 2), -(e.clientY - (r.top + r.height / 2))) * 180) / Math.PI);
        return e.shiftKey ? Math.round(a / 15) * 15 : a;
      }
      const range = fieldRange(p.f);
      return range && r.width > 0 ? valueAtFraction((e.clientX - r.left) / r.width, range.min, range.max, p.f.step ?? 1, p.f.factor) : null;
    };
    const follow = (e: PointerEvent) => {
      let v = valueAt(e);
      if (v == null) return;
      if (p.f.min != null) v = Math.max(p.f.min, v);
      if (p.f.max != null) v = Math.min(p.f.max, v);
      draft = fmtNum(v);
      applyField(p.f, v);
    };
    // Ending a drag, by release or by backing out. Like dragging a name (scrub.ts): Escape, a lost capture, the
    // window losing focus, or the row going away mid-drag all REVERT the edit and return the menu to its keys.
    const finish = (cancel: boolean) => {
      if (pointer === null) return;
      const id = pointer;
      pointer = null;
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", onBlur);
      if (cancel) session.cancel();
      blurField(p.f);
      try { node.releasePointerCapture(id); } catch { /* capture already lost */ }
    };
    const onKey = (e: KeyboardEvent) => {
      if (yieldsToShellModal(e) || isAnnotateChord(e)) return;
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      finish(true);
    };
    const onBlur = () => finish(true);
    const down = (ev: Event) => {
      const e = ev as PointerEvent;
      if (e.button !== 0 || pointer !== null || (p.kind !== "dial" && !fieldRange(p.f))) return;
      e.preventDefault();
      e.stopPropagation();
      pointer = e.pointerId;
      try { node.setPointerCapture(e.pointerId); } catch { /* a synthetic pointer */ }
      enterField(p.f);
      // No input keeps the keyboard during the drag: one left focused would step ITS field from this one's draft.
      panelEl?.focus({ preventScroll: true });
      window.addEventListener("keydown", onKey, true);
      window.addEventListener("blur", onBlur);
      follow(e);
    };
    const move = (ev: Event) => { const e = ev as PointerEvent; if (e.pointerId === pointer) follow(e); };
    const up = (ev: Event) => { if ((ev as PointerEvent).pointerId === pointer) finish(false); };
    const cancel = (ev: Event) => { if ((ev as PointerEvent).pointerId === pointer) finish(true); };
    const lost = () => finish(true); // after a release this is a no-op: the pointer is already let go
    node.addEventListener("pointerdown", down);
    node.addEventListener("pointermove", move);
    node.addEventListener("pointerup", up);
    node.addEventListener("pointercancel", cancel);
    node.addEventListener("lostpointercapture", lost);
    return {
      update(next: { f: Field; kind: Instrument }) { p = next; },
      destroy() {
        finish(true);
        node.removeEventListener("pointerdown", down);
        node.removeEventListener("pointermove", move);
        node.removeEventListener("pointerup", up);
        node.removeEventListener("pointercancel", cancel);
        node.removeEventListener("lostpointercapture", lost);
      },
    };
  }
  // The row under the pointer, for the hint line and the measure; and the paper label of a key
  // that is only a mark. One delegated listener: nothing here runs unless the pointer moves onto
  // a different row.
  let hoverKey: string | null = null;
  let tip: { text: string; key: string; x: number; y: number; below: boolean } | null = null;
  $: hoverField = hoverKey ? (fields.find((f) => f.key === hoverKey) ?? null) : null;
  function onPanelOver(e: PointerEvent) {
    const t = e.target as HTMLElement | null;
    const key = t?.closest<HTMLElement>(".field[data-key]")?.dataset.key ?? null;
    if (key !== hoverKey) hoverKey = key;
    const named = t?.closest<HTMLElement>("[data-tip]") ?? null;
    // A name says itself; its label is only for when it does not fit.
    const cut = named && named.dataset.tipCut !== undefined ? [...named.children].some((c) => c.scrollWidth > c.clientWidth + 1) : true;
    if (!named || !panelEl || !cut) { if (tip) tip = null; return; }
    const a = named.getBoundingClientRect(), b = panelEl.getBoundingClientRect();
    const text = named.dataset.tip ?? "", hk = named.dataset.hk ?? "";
    if (tip && tip.text === text && tip.key === hk) return;
    const half = (text.length * 6.4 + (hk ? 34 : 18)) / 2;
    // Over a key near the menu's top the label stands under it: the menu clips what leaves it.
    const below = a.top - b.top < 30;
    tip = { text, key: hk, x: Math.max(half + 2, Math.min(b.width - half - 2, a.left - b.left + a.width / 2)), y: below ? a.bottom - b.top + 6 : a.top - b.top - 6, below };
  }
  function onPanelLeave() {
    hoverKey = null;
    tip = null;
  }
  $: if (!$fluxFigMenuOpen) { hoverKey = null; tip = null; }
  // A key pressed from the keyboard goes down like one pressed by the hand.
  // (Set on the key's own element: a binding on every row for a 130 ms flourish would be paid at every open.)
  let struckTimer: ReturnType<typeof setTimeout> | undefined;
  function strike(key: string) {
    const el = panelEl?.querySelector<HTMLElement>(`.field[data-key="${CSS.escape(key)}"]`);
    if (!el) return;
    el.classList.add("struck");
    clearTimeout(struckTimer);
    struckTimer = setTimeout(() => el.classList.remove("struck"), 130);
  }
  onDestroy(() => clearTimeout(struckTimer));
  // The measure on the object: the geometric row in hand, else the one under the pointer.
  $: measured = $fluxFigMenuOpen && (mode === "hotkey" || mode === "field") ? measureOf(mode === "field" ? active : hoverField) : null;
  $: fluxFigMeasure.set(measured);
  onDestroy(() => fluxFigMeasure.set(null));
</script>

<svelte:window bind:innerWidth={vw} bind:innerHeight={vh} on:keydown={onWin} on:pointermove={onPointerMove} on:resize={resizePlacement} on:wheel|capture|nonpassive={onWinWheel} />

{#if $fluxFigMenuOpen}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="fbackdrop" on:pointerdown={close}></div>
  <div class="fwrap">
    <!-- svelte-ignore a11y_no_noninteractive_tabindex a11y_no_static_element_interactions -->
    <div
      class="fluxFigMenu"
      class:placed
      bind:this={panelEl}
      tabindex="-1"
      role="dialog"
      aria-label="Properties"
      style={`left:${pos.x}px; top:${pos.y}px; width:${width}px;`}
      on:pointerdown|stopPropagation
      on:wheel|nonpassive={onWheel}
      on:pointerover={onPanelOver}
      on:pointerleave={onPanelLeave}
    >
      <div class="fcontent">
        <!-- The head names the THING: the Flux mark, then the name the Layers rail shows. A part's place leads its
             name and gives way first; what kind of thing (or how many) is the line under it. -->
        <header class="menu-head card" class:two={!!head.ctx}>
          <img class="mark" src={MARK} width="14" height="14" alt="" draggable="false" />
          <span class="vsep" aria-hidden="true"></span>
          <span class="ttl" data-tip={head.name} data-tip-cut>{#if namePath}<span class="tpath">{namePath}</span>{/if}<span class="tlast">{nameLast}</span></span>
          <button class="hkey askbtn" type="button" use:aiMark data-tip="ask about this (read-only)" aria-label="Ask about this" on:click={() => { close(); void import("../shell/agent/askChord").then((m) => m.requestAsk()); }}>Ask</button>
          <button class="hkey xbtn" type="button" data-tip="close" data-hk="f" on:click={close} aria-label="Close properties">×</button>
          {#if head.ctx}<span class="ctx">{head.ctx}</span>{/if}
        </header>
        {#if mode === "search"}
          <div class="search-row active">
            <svg viewBox="0 0 16 16" aria-hidden="true">{@html MENU_GLYPHS.search}</svg>
            <input bind:this={searchEl} bind:value={search} class="search-in" placeholder="Search properties & actions…" spellcheck="false" on:keydown={onSearchKey} />
            <span class="scount">{sResults.length}</span>
          </div>
        {/if}

        {#if fields.some(f => f.hint)}<p class="part-mode-note">{fields.find(f => f.hint)?.hint}</p>{/if}
        <div class="body" class:cols2={mode !== "color" && mode !== "wide" && cols === 2} class:cols3={mode !== "color" && mode !== "wide" && cols === 3}>
          {#if mode === "wide" && wideField?.colorScale}
            <div class="color-mode wide-mode card">
              <div class="cm-head"><span class="hk lit">{wideField.key}</span> {wideField.label}<button class="back" on:click={backToHotkey} title="Back to the properties (Esc)"><svg viewBox="0 0 16 16" aria-hidden="true">{@html MENU_GLYPHS.back}</svg> back <span class="hk">esc</span></button></div>
              {#await import("./plot/ColorScaleControls.svelte") then module}
                <svelte:component this={module.default} elementId={wideField.colorScale.elementId} compact layout="wide" onClose={backToHotkey} />
              {/await}
            </div>
          {:else if mode === "color" && colorField}
            <div class="color-mode card">
              <div class="cm-head"><span class="hk lit">{colorField.key}</span> {colorField.label}<button class="back" on:click={backToHotkey} title="Back to the properties (Esc)"><svg viewBox="0 0 16 16" aria-hidden="true">{@html MENU_GLYPHS.back}</svg> back <span class="hk">esc</span></button></div>
              <ColorPicker target={colorField.target ?? "fill"} allowNone={colorField.label !== "text color" && colorField.label !== "text colour"} onDone={backToHotkey} onCancel={backToHotkey} />
            </div>
          {:else if mode === "search"}
            <div class="results card">
              {#each sResults as f, i (f.group + f.key)}
                <!-- svelte-ignore a11y_no_static_element_interactions a11y_click_events_have_key_events -->
                <div class="res" class:active={i === sIndex} on:pointerenter={() => (sIndex = i)} on:click={() => { mode = "hotkey"; activate(f); }}>
                  <span class="hk">{f.key}</span>
                  <span class="rlabel">{f.label}</span>
                  <span class="rgrp">{f.group}</span>
                </div>
              {/each}
              {#if sResults.length === 0}<div class="empty">No matching property</div>{/if}
            </div>
          {:else}
            {#each looks as grp (grp.name)}
              <div class="group card" class:bare={grp.bare}>
                {#if !grp.bare}
                  <div class="gtitle">
                    <span class="gname">{grp.name}</span>
                    {#if grp.keys.length}
                      <span class="gkeys">
                        {#each grp.keys as f (f.key)}
                          {@const on = Boolean(f.get())}
                          {@const g = toggleGlyph(f.label)}
                          <!-- An on/off property: a paper key on its group's head, lit when on. It is still a field (same key, same label). -->
                          <!-- svelte-ignore a11y_no_static_element_interactions a11y_click_events_have_key_events -->
                          <div class="field tkey" class:on data-key={f.key} data-tip={f.label} data-hk={f.key} on:click={() => activate(f)}>
                            <span class="hk">{f.key}</span>
                            <button class="toggle" class:on type="button" aria-pressed={on} aria-label={f.label}>{#if g}<svg viewBox="0 0 16 16" aria-hidden="true">{@html MENU_GLYPHS[g]}</svg>{:else}<b class="tword">{toggleWord(f.label)}</b>{/if}<i>{on ? "on" : "off"}</i></button>
                            <span class="label vh">{f.label}</span>
                          </div>
                        {/each}
                      </span>
                    {/if}
                  </div>
                {/if}
                  {#each grp.rows as r (r.f.key)}
                    {@const f = r.f}
                    {@const armed = activeKey === f.key && mode !== "hotkey"}
                    <div class={ROW_CLASS[r.half] + (f.kind === "text" ? " wide" : "")} class:editing={armed} class:opts-open={armed && (f.kind === "select" || f.kind === "axisView")} data-key={f.key}>
                      <span class="hk">{f.key}</span>
                      {#if f.kind === "number"}
                        <span class="label scrubbable" data-lead={r.lead} use:scrub={{ get: () => Number(f.get()), step: f.step ?? 1, factor: f.factor, min: f.min ?? null, max: f.max ?? null, onStart: () => enterField(f), onStep: (v) => { draft = String(v); applyField(f, v); }, onEnd: () => blurField(f), onCancel: () => { session.cancel(); blurField(f); } }}>{f.label}</span>
                      {:else}
                        <span class="label">{f.label}</span>
                      {/if}
                      <span class="control">
                        {#if f.kind === "color"}
                          {@const cd = colorDisplay(f)}
                          <button class="colorbtn" on:click={() => activate(f)} title="Palette (hover previews, click applies)">
                            <span class="dot" class:isnone={cd.hex === "none"} style={cd.hex === "none" ? "" : `background:${cd.hex}`}></span>
                            <span class="cname">{cd.name}</span>
                          </button>
                        {:else if f.kind === "axisView" && f.axisView}
                          {#if armed}
                            <span class="under">
                              {#await import("./plot/AxisView.svelte") then module}
                                <svelte:component this={module.default} {...f.axisView} autofocus armed onDone={confirmField} />
                              {/await}
                            </span>
                          {:else}<button class="actbtn pk" on:click={() => activate(f)}>Edit…</button>{/if}
                        {:else if f.kind === "colorScale" && f.colorScale}
                          <button class="actbtn pk" on:click={() => activate(f)}>Edit…</button>
                        {:else if f.kind === "action"}
                          <button class="actbtn pk" on:click={() => activate(f)} aria-label={f.label} data-tip="run" data-hk={f.key}><svg viewBox="0 0 16 16" aria-hidden="true">{@html MENU_GLYPHS[actionGlyph(f.label)]}</svg><span class="vh">run</span></button>
                        {:else if f.kind === "select"}
                          {@const opts = f.options ?? []}
                          {@const cur = String(f.get())}
                          <button class="selbtn" class:open={armed} on:click={() => (armed ? confirmField() : activate(f))} title="Choose (wheel, w·a·s·d, 1–9)">{opts.find((o) => o.value === cur)?.label ?? (cur || "—")}<span class="chev" aria-hidden="true"></span></button>
                          {#if armed}
                            <span class="opts" role="listbox" aria-label={f.label}>
                              {#each opts as o, i (o.value)}
                                <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
                                <span class="opt" class:cur={i === optIndex} role="option" tabindex="-1" aria-selected={i === optIndex}
                                  on:pointerenter={() => previewOption(f, i)} on:click={() => pickOption(f, i)}>
                                  {#if i < 9}<span class="ok hk">{i + 1}</span>{/if}{o.label}
                                </span>
                              {/each}
                            </span>
                          {/if}
                        {:else if f.kind === "text"}
                          <input
                            bind:this={inputs[f.key]}
                            class="tin"
                            value={activeKey === f.key ? draft : String(f.get())}
                            spellcheck="false"
                            on:focus={() => enterField(f)}
                            on:blur={() => blurField(f)}
                            on:input={(e) => { draft = e.currentTarget.value; applyField(f, draft); }}
                            on:keydown={(e) => onFieldKey(e, f)}
                          />
                        {:else if f.kind === "number"}
                          {@const viz = instrumentOf(f)}
                          {#if viz === "fader"}
                            <span class="fader" style={`--c:${faderPaint(f, fillInk, strokeInk)}`} use:instrument={{ f, kind: viz }}><i class="knob" style={`left:${pct(f)}%`}></i></span>
                          {:else if viz === "dial"}
                            <svg class="dial" viewBox="0 0 20 20" aria-hidden="true" use:instrument={{ f, kind: viz }}><circle class="ring" cx="10" cy="10" r="8.6" /><path class="zero" d="M10 1.4v2.2M18.6 10h-2.2M10 18.6v-2.2M1.4 10h2.2" /><path class="hand" d="M10 10V3.6" transform={`rotate(${Number(f.get()) || 0} 10 10)`} /><circle class="hub" cx="10" cy="10" r="1.5" /></svg>
                          {:else if viz === "corner"}
                            <svg class="corner" viewBox="0 0 18 18" aria-hidden="true"><path class="box" d="M3.5 16V3.5H16" /><path d={cornerPath(Number(f.get()) || 0)} /></svg>
                          {:else if viz === "weight"}
                            {@const dashed = !!dashedField && Boolean(dashedField.get())}
                            <span class="weight" class:none={strokeField != null && !strokeInk}><i style={`height:${Math.max(0.5, Math.min(10, Number(f.get()) || 0))}px;background:${dashed && strokeInk && !strokeInk.includes("gradient") ? `repeating-linear-gradient(90deg, ${strokeInk} 0 6px, transparent 6px 10px)` : (strokeInk ?? "#222222")}`}></i></span>
                          {:else if viz === "track"}
                            <span class="gtrack" use:instrument={{ f, kind: viz }}><i class="fill" style={`width:${pct(f)}%`}></i><i class="knob" style={`left:${pct(f)}%`}></i></span>
                          {/if}
                          <input
                              bind:this={inputs[f.key]}
                              class="nin"
                              type="text"
                              inputmode="decimal"
                              spellcheck="false"
                              placeholder={f.mixed ? "Mixed" : ""}
                              title={f.count && $selection.size > 1 ? `Applies to ${f.count} of ${$selection.size} selected objects` : f.label}
                              value={activeKey === f.key ? draft : f.mixed ? "" : shortNum(Number(f.get()))}
                              on:focus={() => enterField(f)}
                              on:blur={() => blurField(f)}
                              on:input={(e) => { draft = e.currentTarget.value; const v = evalExpr(draft); if (v != null) applyField(f, v); }}
                              on:keydown={(e) => onFieldKey(e, f)}
                          />{#if f.prop === "rotation" && activeKey !== f.key && !f.mixed}<span class="unit" aria-hidden="true">°</span>{/if}
                        {/if}
                      </span>
                    </div>
                  {/each}
              </div>
            {/each}
          {/if}
        </div>

        <!-- One line: what the hand can do with what is under it; and search, at its end. -->
        <div class="foot">
          <span class="hints">
          {#if mode === "wide"}
            <span><b class="hk">↑↓</b> walk palettes</span>
            <span><b class="hk">↵</b> applies</span>
            <span><b class="hk">r</b> reverse</span>
            <span><b class="hk">esc</b> back</span>
            <span><b class="hk">f</b> close</span>
          {:else if mode === "color"}
            <span><b class="hk">esc</b> back to the properties</span>
          {:else if mode === "search"}
            <span><b class="hk">↑↓</b> walk</span>
            <span><b class="hk">↵</b> go</span>
            <span><b class="hk">esc</b> back</span>
          {:else if mode === "option"}
            <span><b class="hk">1–9</b> pick</span>
            <span><b class="hk">↕</b> walk</span>
            <span><b class="hk">esc</b> revert</span>
          {:else if mode === "field" && active?.kind === "axisView"}
            <span><b class="hk">esc</b> <b class="hk">f</b> done</span>
          {:else if mode === "field"}
            <span class="what">type or roll</span>
            <span><b class="hk">␣</b> apply</span>
            <span><b class="hk">esc</b> revert</span>
          {:else if hoverField?.kind === "number"}
            <span class="what"><b class="hk">↕</b> {hoverField.factor && hoverField.factor > 1 ? `×${hoverField.factor}` : `±${hoverField.step ?? 1}`}</span>
            <span><b class="hk">⇧</b> ×10</span>
            <span><b class="hk">alt</b> ×0.1</span>
          {:else if hoverField}
            <span class="what">{hoverField.label}</span>
            <span><b class="hk">{hoverField.key}</b> or click</span>
          {:else}
            <span><b class="hk">f</b> <b class="hk">esc</b> close</span>
            <span><b class="hk">↕</b> wheel adjusts</span>
          {/if}
          </span>
          {#if mode !== "color" && mode !== "wide"}
            <button class="hkey skey" class:on={mode === "search"} type="button" data-tip="search properties & actions" data-hk="s" aria-label="Search properties and actions" on:click={() => (mode === "search" ? backToHotkey() : enterSearch())}><span class="hk">s</span><svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.2" /><path d="M10.2 10.2 13.6 13.6" /></svg></button>
          {/if}
        </div>
      </div>
      {#if tip}<div class="fm-tip" class:below={tip.below} style={`left:${tip.x}px; top:${tip.y}px;`} aria-hidden="true">{tip.text}{#if tip.key}<kbd>{tip.key}</kbd>{/if}</div>{/if}
    </div>
  </div>
{/if}

<style>
  /* Transparent catcher: a surface, not a modal — clicking elsewhere closes. */
  .fbackdrop { position: fixed; inset: 0; background: transparent; z-index: 300; }
  .fwrap { position: fixed; inset: 0; z-index: 301; pointer-events: none; }
  /* The menu is an instrument, like the image board: dark by nature in every theme, so it reads the raw ramp. One
     plate, a card per group. What the hand works is the menu's own blue; what it presses is paper. Its tokens
     (--fm-*) are on :root in tokens.css, deliberately not here: a custom property declared on the menu's own root
     is paid for by every element of the menu at every open. */
  .fluxFigMenu {
    pointer-events: auto;
    position: absolute;
    visibility: hidden;
    display: flex;
    flex-direction: column;
    box-sizing: border-box;
    max-width: calc(100vw - 16px);
    max-height: calc(100vh - 16px);
    padding: 4px;
    color: var(--fm-tx);
    font-family: var(--font-serif); /* Flux's classic face for the menu's words; values stay mono */
    font-size: 12.5px;
    background: var(--fm-plate);
    border: 1px solid var(--fm-line);
    border-radius: 12px;
    box-shadow: 0 10px 26px -10px rgba(0, 0, 0, 0.7), 0 2px 6px rgba(0, 0, 0, 0.4);
    outline: none;
    overflow: hidden;
  }
  .fluxFigMenu.placed { visibility: visible; animation: fm-in 70ms var(--ease-standard) 1; }
  @media (prefers-reduced-motion: reduce) { .fluxFigMenu.placed { animation: none; } }
  @keyframes fm-in { from { opacity: 0; } to { opacity: 1; } }
  .fcontent { display: flex; flex-direction: column; gap: 4px; flex: 1 1 auto; min-height: 0; opacity: 1; }
  .card { box-sizing: border-box; border-radius: 8px; background: var(--fm-card); border: 1px solid var(--fm-line); box-shadow: var(--fm-lift); }
  .vh { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  svg { display: block; }

  /* the head: the mark, the thing's name, three quiet keys */
  .menu-head { flex: none; display: grid; grid-template-columns: auto auto minmax(0, 1fr) auto auto; align-items: center; column-gap: 8px; grid-template-rows: 30px; padding: 0 5px 0 9px; }
  .menu-head.two { grid-template-rows: 28px 15px; padding-bottom: 4px; }
  .mark { display: block; width: 14px; height: 14px; flex-shrink: 0; }
  .vsep { width: 1px; height: 14px; background: var(--fm-line-2); flex-shrink: 0; }
  .ttl { display: flex; align-items: baseline; min-width: 0; font: 600 13.5px var(--font-serif); color: var(--fm-tx-hi); white-space: nowrap; }
  .tpath { flex: 0 1 auto; min-width: 2ch; overflow: hidden; text-overflow: ellipsis; white-space: pre; font-weight: 400; color: var(--fm-tx); }
  .tlast { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .tpath + .tlast { flex-shrink: 0.2; min-width: 6ch; }
  .xbtn { margin-left: -6px; font: 17px/1 var(--font-ui); color: var(--fm-tx); }
  .ctx { grid-row: 2; grid-column: 3 / -1; align-self: start; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fm-tx-dim); font: 10px/15px var(--font-mono); }
  .hkey { flex: none; display: inline-flex; align-items: center; justify-content: center; gap: 4px; height: 22px; min-width: 22px; padding: 0 5px; background: transparent; border: 1px solid transparent; border-radius: 5px;
    color: var(--fm-tx-dim); font: 11px var(--font-ui); cursor: var(--cursor-cross-hover); transition: background-color 80ms linear, color 80ms linear, border-color 80ms linear; }
  .hkey svg { width: 13px; height: 13px; fill: none; stroke: currentColor; stroke-width: 1.35; stroke-linecap: round; stroke-linejoin: round; }
  .hkey .hk { border: 0; min-width: 0; height: auto; padding: 0; background: none; color: var(--fm-blue-hi); font: 600 10px/1 var(--font-mono); }
  .askbtn { color: var(--fm-tx); }
  .hkey:hover { background: var(--fm-paper); border-color: color-mix(in oklab, var(--fm-blue) 45%, transparent); color: var(--fm-blue-deep); box-shadow: 0 1px 2px rgba(0, 0, 0, 0.5); }
  .hkey:hover .hk { color: var(--fm-blue-deep); }
  .hkey:active { transform: translateY(1px); box-shadow: none; }
  .hkey.on, .hkey.on:hover { background: var(--fm-blue); border-color: transparent; color: var(--fm-paper); box-shadow: none; }
  .hkey.on .hk { color: var(--fm-paper); }

  /* Hotkeys are key caps (app.css draws the box); the menu's keys keep their blue, and the key of
     the row in hand (an editing field, the active result) is lit. */
  .hk { color: var(--c-accent); min-width: 17px; height: 16px; flex: none; }
  .field.editing > .hk, .res.active .hk, .hk.lit { background: var(--fm-blue); border-color: var(--fm-blue); color: var(--fm-paper); }
  .field.struck > .hk { transform: translateY(1px); }

  /* search: a well under the head while it is in use */
  .search-row { flex: none; display: flex; align-items: center; gap: 7px; height: 28px; padding: 0 9px; border-radius: 8px; background: var(--fm-well); box-shadow: inset 0 0 0 1px var(--fm-blue); color: var(--fm-blue-hi); }
  .search-row svg { flex: none; width: 13px; height: 13px; fill: none; stroke: currentColor; stroke-width: 1.4; stroke-linecap: round; }
  .search-in { flex: 1; min-width: 0; background: none; border: none; outline: none; color: var(--fm-tx-hi); font: 12.5px var(--font-serif); padding: 0; }
  .search-in::placeholder { color: var(--fm-tx-dim); }
  .scount { font: 10px var(--font-mono); color: var(--fm-tx-dim); }
  .part-mode-note { color: var(--fm-tx-dim); font-size: 11px; margin: 2px 9px; }

  /* the body: a card per group, in as many columns as the lines need (never a scroll) */
  .body { overflow-y: auto; scrollbar-width: thin; margin-bottom: -4px; }
  .body.cols2 { columns: 2; column-gap: 4px; }
  .body.cols3 { columns: 3; column-gap: 4px; }
  .group { break-inside: avoid; margin-bottom: 4px; padding: 1px 0 4px; display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
  .group.bare { padding: 3px 0; }
  .gtitle { grid-column: 1 / -1; display: flex; align-items: center; height: 22px; padding: 0 5px 0 9px; font: 600 9.5px var(--font-mono); letter-spacing: 0.09em; text-transform: uppercase; color: var(--fm-tx-dim); }
  .gname { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .gkeys { display: inline-flex; gap: 4px; }

  /* a row: its key, its name, its instrument */
  .field { position: relative; grid-column: 1 / -1; display: grid; grid-template-columns: 17px fit-content(66%) minmax(0, 1fr); align-items: center; column-gap: 7px; min-height: 24px; padding: 0 6px 0 7px; margin: 0 2px; border-radius: 5px; }
  .field.half { grid-column: auto; margin: 0 0 0 2px; padding-right: 5px; }
  .field.half.right { margin: 0 2px 0 0; }
  .field.wide { grid-template-columns: 17px auto minmax(0, 1fr); }
  .field:hover { background: rgba(255, 252, 240, 0.04); }
  .field.editing { background: var(--fm-tint); }
  .field.editing::before { content: ""; position: absolute; left: 0; top: 4px; bottom: 4px; width: 2px; border-radius: 1px; background: var(--fm-blue); }
  .label { font-size: 12.5px; line-height: 1.3; color: var(--fm-tx); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .field:hover > .label, .field.editing > .label { color: var(--fm-tx-hi); }
  /* A paired cell shows the leading word ("x"); the whole label is still there to be read. */
  .field.half > .label[data-lead] { font-size: 0; }
  .field.half > .label[data-lead]::before { content: attr(data-lead); font-size: 12.5px; }
  .scrubbable { cursor: ew-resize; }
  .control { display: flex; align-items: center; justify-content: flex-end; gap: 7px; min-width: 0; }

  /* a number: no box until the hand is on it */
  .nin { field-sizing: content; min-width: 2ch; max-width: 11ch; height: 18px; padding: 0 4px; margin: 0; background: transparent; border: 0; border-radius: 4px; color: var(--fm-tx-hi);
    font: 12px/18px var(--font-mono); font-variant-numeric: tabular-nums; text-align: right; outline: none; box-sizing: content-box; }
  .nin::placeholder { color: var(--fm-tx-dim); font-style: italic; }
  .field:hover .nin { background: var(--fm-well); box-shadow: inset 0 0 0 1px rgba(255, 252, 240, 0.12); }
  .nin:focus, .field.editing .nin { background: var(--fm-well); box-shadow: inset 0 0 0 1px var(--fm-blue); }
  .unit { margin-left: -10px; padding-right: 3px; font: 12px/18px var(--font-mono); color: var(--fm-tx-hi); pointer-events: none; }
  .tin { width: 100%; height: 20px; padding: 0 6px; background: transparent; border: 0; border-radius: 4px; color: var(--fm-tx-hi); font: 12px var(--font-ui); outline: none; box-sizing: border-box; box-shadow: inset 0 0 0 1px var(--fm-line-2); }
  .field:hover .tin { background: var(--fm-well); }
  .tin:focus { background: var(--fm-well); box-shadow: inset 0 0 0 1px var(--fm-blue); }

  /* the instruments: each draws the property it sets */
  .fader { position: relative; flex: 0 1 72px; min-width: 36px; height: 10px; border-radius: 5px; cursor: ew-resize; touch-action: none;
    background: linear-gradient(90deg, transparent, var(--c)), repeating-conic-gradient(#fffcf0 0 25%, #cecdc3 0 50%) 0 0 / 10px 10px; box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.6), 0 0 0 2px rgba(255, 252, 240, 0.07); }
  .fader .knob, .gtrack .knob { position: absolute; top: -3px; width: 5px; height: 16px; margin-left: -2.5px; border-radius: 2.5px; background: var(--fm-paper); box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.6), 0 1px 2px rgba(0, 0, 0, 0.6); }
  .field:hover .knob, .field.editing .knob { box-shadow: 0 0 0 1.5px var(--fm-blue), 0 1px 2px rgba(0, 0, 0, 0.6); }
  .gtrack { position: relative; flex: 0 1 60px; min-width: 28px; height: 14px; cursor: ew-resize; touch-action: none; }
  .gtrack::before { content: ""; position: absolute; left: 0; right: 0; top: 6px; height: 2px; border-radius: 1px; background: rgba(255, 252, 240, 0.14); }
  .gtrack .fill { position: absolute; left: 0; top: 6px; height: 2px; border-radius: 1px; background: var(--fm-tx-dim); }
  .gtrack .knob { top: 1px; width: 4px; height: 12px; margin-left: -2px; border-radius: 2px; }
  .field:hover .gtrack .fill, .field.editing .gtrack .fill { background: var(--fm-blue); }
  .dial { flex: none; width: 22px; height: 22px; cursor: grab; color: var(--flx-base-300); touch-action: none; }
  .dial .ring { fill: var(--fm-well); stroke: rgba(255, 252, 240, 0.22); stroke-width: 1; }
  .dial .zero { fill: none; stroke: var(--flx-base-600); stroke-width: 1; }
  .dial .hand { fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; }
  .dial .hub { fill: currentColor; }
  .field:hover .dial, .field.editing .dial { color: var(--fm-blue-hi); }
  .field:hover .dial .ring, .field.editing .dial .ring { stroke: var(--fm-blue); }
  .corner { flex: none; width: 18px; height: 18px; color: var(--flx-base-300); }
  .corner path { fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; }
  .corner .box { stroke: rgba(255, 252, 240, 0.14); stroke-width: 1; stroke-dasharray: 2 2; }
  .field:hover .corner, .field.editing .corner { color: var(--fm-blue-hi); }
  .weight { flex: none; display: grid; place-items: center; width: 40px; height: 14px; border-radius: 4px; background: var(--fm-paper); box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.6), 0 0 0 2px rgba(255, 252, 240, 0.07); overflow: hidden; }
  .weight i { display: block; width: 30px; }
  .weight.none i { width: 100%; height: 100% !important; background: repeating-linear-gradient(-45deg, transparent 0 3px, var(--flx-base-300) 3px 4px) !important; }

  /* a colour: its chip and its name */
  .colorbtn { display: flex; align-items: center; justify-content: flex-end; gap: 8px; max-width: 100%; height: 20px; padding: 0 0 0 2px; background: none; border: 0; color: var(--fm-tx); cursor: var(--cursor-cross-hover); min-width: 0; }
  .dot { width: 40px; height: 14px; border-radius: 4px; flex: none; box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.6), 0 0 0 2px rgba(255, 252, 240, 0.24), inset 0 1px 0 rgba(255, 255, 255, 0.18); }
  .dot.isnone { background: var(--fm-paper) repeating-linear-gradient(-45deg, transparent 0 3px, var(--flx-base-300) 3px 4px); }
  .colorbtn:hover .dot, .field.editing .dot { box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.6), 0 0 0 2.5px var(--fm-blue), inset 0 1px 0 rgba(255, 255, 255, 0.18); }
  .cname { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; color: var(--fm-tx-dim); font: 11px var(--font-mono); }
  .field:hover .cname { color: var(--fm-tx); }

  /* A paper key: the Crystallize key in the menu's blue. It stands a little proud and goes down when pressed;
     a key that is ON is lit: the face takes the blue and the mark takes the paper. */
  .pk, .field.tkey { display: inline-flex; align-items: center; justify-content: center; gap: 4px; flex: none; box-sizing: border-box; height: 20px; min-width: 22px; padding: 0 5px; margin: 0; border-radius: 5px;
    background: var(--fm-paper); color: var(--fm-blue-deep); border: 1px solid color-mix(in oklab, var(--fm-blue) 45%, transparent); box-shadow: 0 1.5px 2.5px rgba(0, 0, 0, 0.5);
    font: 600 10.5px/1 var(--font-mono); letter-spacing: 0; text-transform: none; cursor: var(--cursor-cross-hover); transition: background-color 80ms linear, border-color 80ms linear, color 80ms linear; }
  .pk svg, .tkey svg { width: 13px; height: 13px; fill: none; stroke: currentColor; stroke-width: 1.35; stroke-linecap: round; stroke-linejoin: round; }
  .pk :global(svg .f), .tkey :global(svg .f) { fill: currentColor; stroke: none; }
  .pk:hover, .field.tkey:hover { background: color-mix(in oklab, var(--fm-blue) 16%, var(--fm-paper)); border-color: var(--fm-blue); }
  .pk:active, .field.tkey:active, .field.tkey.struck, .field.struck .pk { transform: translateY(1px); box-shadow: 0 0 1px rgba(0, 0, 0, 0.6); background: color-mix(in oklab, var(--fm-blue) 30%, var(--fm-paper)); }
  .field.tkey.on { background: var(--fm-blue); border-color: color-mix(in oklab, var(--fm-paper) 60%, var(--fm-blue)); color: var(--fm-paper); }
  .field.tkey.on:hover { background: color-mix(in oklab, var(--fm-paper) 14%, var(--fm-blue)); }
  .field.tkey { grid-column: auto; min-height: 0; }
  .field.tkey::before { content: none; }
  .field.tkey > .hk { border: 0; min-width: 0; height: auto; padding: 0 0 0 1px; background: none; color: inherit; font: 600 10px/1 var(--font-mono); transform: none; }
  /* The button says "on" / "off" to whoever reads it; the eye reads the lit key. */
  .toggle { display: inline-flex; align-items: center; min-width: 0; height: 14px; padding: 0; margin: 0; background: none; border: 0; color: inherit; cursor: inherit; font: inherit; }
  .toggle:focus-visible { outline: 1.5px solid var(--fm-blue-hi); outline-offset: 4px; border-radius: 2px; }
  .toggle > i { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
  .tword { font-weight: 600; white-space: nowrap; }

  /* a choice: its value, and its options under it while it is in hand */
  .selbtn { display: inline-flex; align-items: center; gap: 4px; max-width: 150px; height: 20px; padding: 0 3px 0 7px; background: transparent; border: 0; border-radius: 5px; color: var(--fm-tx-hi); font: 12px var(--font-serif);
    box-shadow: inset 0 0 0 1px var(--fm-line-2); cursor: var(--cursor-cross-hover); overflow: hidden; white-space: nowrap; }
  .selbtn:hover, .selbtn.open { background: var(--fm-well); box-shadow: inset 0 0 0 1px var(--fm-blue); }
  .selbtn .chev { flex: none; width: 6px; height: 6px; margin: -3px 3px 0 2px; border: solid var(--fm-tx-dim); border-width: 0 1.5px 1.5px 0; transform: rotate(45deg); }
  /* A row in hand that opens (a choice, an axis view): its control's children stand in the row's own grid, the
     value at the line's end and what opened under the line. */
  .field.opts-open > .control { display: contents; }
  .field.opts-open .selbtn { justify-self: end; }
  .opts { grid-column: 1 / -1; display: flex; flex-wrap: wrap; gap: 4px; padding: 2px 0 6px 24px; }
  .opt { display: inline-flex; align-items: center; gap: 5px; height: 20px; padding: 0 7px 0 3px; border-radius: 5px; background: var(--fm-well); box-shadow: inset 0 0 0 1px var(--fm-line-2); color: var(--fm-tx); cursor: var(--cursor-cross-hover); font-size: 12px; white-space: nowrap; }
  .opt .ok { min-width: 15px; height: 14px; padding: 0 3px; font-size: 9px; line-height: 12px; }
  .opt.cur { background: var(--fm-blue); box-shadow: none; color: var(--fm-paper); }
  .opt.cur .ok { color: var(--fm-paper); border-color: color-mix(in oklab, var(--fm-paper) 60%, transparent); }
  .under { grid-column: 1 / -1; padding: 2px 0 6px; min-width: 0; }

  /* the pickers the menu hosts */
  /* The pickers the menu hosts (colour, colour scale, axis view) read the menu's ramp through the semantic tokens,
     re-pointed on THEIR hosts only: these exist while a picker is open, never on the menu's ordinary path. */
  .color-mode, .under { --c-bg: var(--fm-well); --c-bg-raised: var(--fm-card); --c-surface: var(--fm-card); --c-surface-2: #262523; --c-line: var(--fm-line); --c-line-strong: var(--fm-line-2); }
  .color-mode { padding: 4px 8px 8px; margin-bottom: 4px; }
  .cm-head { display: flex; align-items: center; gap: 8px; height: 24px; font-size: 12.5px; color: var(--fm-tx-hi); margin-bottom: 4px; }
  .cm-head .back { margin-left: auto; display: inline-flex; align-items: center; gap: 5px; height: 20px; padding: 0 5px; background: none; border: 1px solid transparent; border-radius: 5px; color: var(--fm-tx-dim); font: 11px var(--font-ui); cursor: var(--cursor-cross-hover); }
  .cm-head .back svg { width: 12px; height: 12px; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
  .cm-head .back .hk { color: inherit; }
  .cm-head .back:hover { color: var(--fm-tx-hi); border-color: var(--fm-line-2); }
  /* In columns the one card of results is cut at each column: every piece keeps its own edges. */
  .results { padding: 3px 0 4px; margin-bottom: 4px; box-decoration-break: clone; -webkit-box-decoration-break: clone; }
  .res { break-inside: avoid; }
  .res { position: relative; display: grid; grid-template-columns: 17px 1fr auto; gap: 7px; align-items: center; height: 24px; padding: 0 8px 0 7px; margin: 0 2px; border-radius: 5px; cursor: var(--cursor-cross-hover); }
  .res.active { background: var(--fm-tint); color: var(--fm-tx-hi); }
  .res.active::before { content: ""; position: absolute; left: 0; top: 4px; bottom: 4px; width: 2px; border-radius: 1px; background: var(--fm-blue); }
  .rlabel { font: 12.5px var(--font-serif); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rgrp { font: 600 9px var(--font-mono); color: var(--flx-base-600); text-transform: uppercase; letter-spacing: 0.08em; }
  .empty { color: var(--fm-tx-dim); padding: 12px; text-align: center; }

  /* the foot: one line of what the hand can do now */
  .foot { flex: none; display: flex; align-items: center; gap: 6px; height: 22px; padding: 0 1px 0 8px; font: 10px var(--font-mono); color: var(--fm-tx-dim); white-space: nowrap; }
  .hints { flex: 1; min-width: 0; display: flex; align-items: center; gap: 10px; overflow: hidden; }
  .hints span { flex: none; display: inline-flex; align-items: center; gap: 4px; }
  .hints span.what { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .foot .skey { height: 20px; }
  .hints .hk { min-width: 14px; height: 13px; padding: 0 3px; font-size: 9px; line-height: 10px; color: var(--fm-tx-dim); margin-right: 1px; }
  .hints .what, .hints .what .hk { color: var(--fm-blue-hi); }

  /* the paper label of a key that is only a mark */
  .fm-tip { position: absolute; z-index: 5; display: inline-flex; align-items: center; gap: 7px; height: 21px; padding: 0 9px; border-radius: 11px; background: var(--fm-paper); border: 1px solid color-mix(in oklab, var(--fm-blue) 45%, transparent);
    box-shadow: 0 2px 6px rgba(0, 0, 0, 0.45); color: var(--fm-blue-deep); font: 600 10.5px var(--font-mono); white-space: nowrap; pointer-events: none; transform: translate(-50%, -100%); }
  .fm-tip.below { transform: translate(-50%, 0); }
  .fm-tip kbd { min-width: 14px; height: 14px; padding: 0 3px; border-color: color-mix(in oklab, var(--fm-blue-deep) 45%, transparent); border-radius: 3px; color: var(--fm-blue-deep); font: 600 9.5px/11px var(--font-mono); }
</style>
