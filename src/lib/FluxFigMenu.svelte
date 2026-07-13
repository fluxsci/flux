<script lang="ts">
  import { fade } from "svelte/transition";
  import { get } from "svelte/store";
  import {
    project,
    selection,
    partSelection,
    beginGesture,
    commit,
    mutate,
    drawStyle,
    type PartSelection,
  } from "./store";
  import type { Element, PartOverride, Project, SemanticPlotElement, TextStyle } from "./types";
  import type { FluxPlotManifest } from "./plot/types";
  import { plotManifests } from "./plot/store";
  import { partKind, partNode, readPartStyle } from "./plot/partStyle";
  import * as ops from "./ops";
  import { applyTextLayout, reflowTexts } from "./text";
  import { globalTextStyles, loadGlobalTextStyles, applyTextStyleToPart, libraryOnly } from "./textStyles";
  import { evalExpr } from "./num";
  import { scrub } from "./scrub";
  import { nameForHex } from "./colors";
  import { presetPicker, presetable } from "./presets";
  import { fluxFigMenuOpen, settings, popupLayout } from "./settings";
  import { halfFrame, drawForge } from "./motion/selfDraw";
  import { prefersReducedMotion } from "./motion/motion";
  import ColorSearch from "./ColorSearch.svelte";

  type Kind = "number" | "text" | "select" | "toggle" | "color";
  interface Field {
    key: string;
    label: string;
    group: string;
    kind: Kind;
    get: () => string | number | boolean;
    apply: (v: string | number | boolean) => void;
    options?: { value: string; label: string }[];
    target?: "fill" | "stroke";
    step?: number;
  }

  let mode: "hotkey" | "field" | "color" | "search" = "hotkey";
  let activeKey: string | null = null;
  let colorField: Field | null = null;
  let search = "";
  let sIndex = 0;
  let panelEl: HTMLDivElement;
  let inputs: Record<string, any> = {};
  let searchEl: HTMLInputElement;
  let frameW = 0; // measured panel box, for the self-drawing outline
  let frameH = 0;

  // (Re)build the field list whenever the selection / part selection or its
  // data changes (the global style library too — it feeds the 'y' field).
  $: fields = $fluxFigMenuOpen ? buildFields($project, $selection, $partSelection, $plotManifests, $globalTextStyles) : [];
  $: groups = groupFields(fields);
  $: sQ = search.trim().toLowerCase();
  $: sResults = sQ
    ? fields.filter((f) => `${f.label} ${f.group} ${f.key}`.toLowerCase().includes(sQ))
    : fields;
  $: if (sIndex >= sResults.length) sIndex = Math.max(0, sResults.length - 1);

  // Reset state each time the FluxFig Menu opens (+ refresh the global style
  // library so the 'y' style field lists current definitions).
  let prevOpen = false;
  $: {
    if ($fluxFigMenuOpen && !prevOpen) {
      reset();
      loadGlobalTextStyles();
    }
    prevOpen = $fluxFigMenuOpen;
  }
  function reset() {
    mode = "hotkey";
    activeKey = null;
    colorField = null;
    search = "";
    sIndex = 0;
    requestAnimationFrame(() => panelEl?.focus());
  }

  function groupFields(fs: Field[]) {
    const out: { name: string; fields: Field[] }[] = [];
    for (const f of fs) {
      let g = out.find((o) => o.name === f.group);
      if (!g) {
        g = { name: f.group, fields: [] };
        out.push(g);
      }
      g.fields.push(f);
    }
    return out;
  }

  // --- Plot-part fields -------------------------------------------------
  // When a part is drilled (partSelection), the menu edits THAT part like the
  // equivalent native object: a tick label gets the text fields, a gridline
  // the stroke fields. Reads = effective values (override → live DOM →
  // pristine cache); writes = id-keyed overrides (survive regeneration).
  // Number/text/select fields ride activate()'s beginGesture → apply via
  // mutate (one undo per field activation); the visible toggle commits itself
  // (activate() short-circuits toggles without opening a gesture).
  const PART_FONTS = ["Lato", "Latin Modern Roman", "Arial", "Helvetica", "Georgia", "Times New Roman", "DejaVu Sans"];

  // Options for a named-style select: — None — + Project styles + the global
  // Library (minus definitions the project already carries — project wins).
  function styleOptions(p: Project, lib: TextStyle[]): { value: string; label: string }[] {
    const out: { value: string; label: string }[] = [{ value: "", label: "— None —" }];
    for (const st of p.textStyles ?? []) out.push({ value: st.id, label: st.name });
    for (const st of libraryOnly(p.textStyles, lib)) out.push({ value: "lib:" + st.id, label: `${st.name} (library)` });
    return out;
  }
  function resolveStyle(p: Project, lib: TextStyle[], v: string): { st: TextStyle; fromLibrary: boolean } | null {
    if (v.startsWith("lib:")) {
      const st = lib.find((s) => s.id === v.slice(4));
      return st ? { st, fromLibrary: true } : null;
    }
    const st = p.textStyles?.find((s) => s.id === v);
    return st ? { st, fromLibrary: false } : null;
  }

  function buildPartFields(
    el: SemanticPlotElement,
    partId: string,
    manifest: FluxPlotManifest | undefined,
    lib: TextStyle[],
  ): Field[] {
    const kind = partKind(manifest, partId, partNode(el, partId));
    const read = () => readPartStyle(el, partId, manifest);
    const patch = (q: PartOverride) => mutate((proj) => ops.setPartOverride(proj, el.id, partId, q));
    const F: Field[] = [];
    const G = "Plot part";
    const pnum = (key: string, label: string, prop: string, step = 1, clamp?: (n: number) => number) =>
      F.push({
        key,
        label,
        group: G,
        kind: "number",
        step,
        get: () => {
          const v = read()[prop];
          return typeof v === "number" ? Math.round(v * 100) / 100 : 0;
        },
        apply: (v) => {
          let n = Number(v);
          if (!Number.isFinite(n)) return;
          if (clamp) n = clamp(n);
          patch({ [prop]: n });
        },
      });
    const color = (key: string, label: string, target: "fill" | "stroke") =>
      // ColorSearch retargets to the part itself (colors.ts applyColor routes
      // through applyPartStyle while partSelection is set) — apply is a no-op.
      F.push({ key, label, group: G, kind: "color", target, get: () => String(read()[target] ?? "#000000"), apply: () => {} });
    const visible = () =>
      F.push({
        key: "v",
        label: "visible",
        group: G,
        kind: "toggle",
        get: () => !read().hidden,
        apply: () =>
          commit((proj) =>
            ops.setPartOverride(proj, el.id, partId, { hidden: !Boolean(el.overrides?.[partId]?.hidden) }),
          ),
      });

    if (kind === "container") visible();
    if (kind === "text") {
      // Part font size is in PLOT UNITS (the SVG's own user units), not pt.
      pnum("e", "size", "fontSize", 0.5, (n) => Math.max(0.5, n));
      F.push({
        key: "b",
        label: "weight",
        group: G,
        kind: "select",
        options: [{ value: "400", label: "Regular" }, { value: "700", label: "Bold" }],
        get: () => String(read().fontWeight ?? 400),
        apply: (v) => patch({ fontWeight: Number(v) }),
      });
      F.push({
        key: "i",
        label: "italic",
        group: G,
        kind: "toggle",
        get: () => read().fontStyle === "italic",
        apply: () =>
          commit((proj) =>
            ops.setPartOverride(proj, el.id, partId, {
              fontStyle: read().fontStyle === "italic" ? "normal" : "italic",
            }),
          ),
      });
      F.push({
        key: "u",
        label: "underline",
        group: G,
        kind: "toggle",
        get: () => read().textDecoration === "underline",
        apply: () =>
          commit((proj) =>
            ops.setPartOverride(proj, el.id, partId, {
              textDecoration: read().textDecoration === "underline" ? "none" : "underline",
            }),
          ),
      });
      F.push({
        key: "m",
        label: "font",
        group: G,
        kind: "select",
        options: (() => {
          const cur = String(read().fontFamily ?? "");
          const list = cur && !PART_FONTS.includes(cur) ? [cur, ...PART_FONTS] : PART_FONTS;
          return list.map((x) => ({ value: x, label: x }));
        })(),
        get: () => String(read().fontFamily ?? ""),
        apply: (v) => patch({ fontFamily: String(v) }),
      });
      color("c", "text colour", "fill");
      // Named text style → part override (fontSize converted canvas px → plot
      // units in applyTextStyleToPart; no styleId persisted on parts). Key 't':
      // 'y' is this branch's dy nudge (plan's 'y' collides — see notes).
      F.push({
        key: "t",
        label: "text style",
        group: G,
        kind: "select",
        options: styleOptions(get(project), lib).filter((o) => o.value !== ""),
        get: () => "",
        apply: (v) => {
          const r = resolveStyle(get(project), lib, String(v));
          if (r) applyTextStyleToPart(el.id, partId, r.st);
        },
      });
    } else if (kind === "line") {
      color("k", "stroke colour", "stroke");
      pnum("d", "stroke width", "strokeWidth", 0.25, (n) => Math.max(0, n));
    } else if (kind === "shape") {
      color("c", "fill colour", "fill");
      color("k", "stroke colour", "stroke");
      pnum("d", "stroke width", "strokeWidth", 0.25, (n) => Math.max(0, n));
    }
    pnum("o", "opacity", "opacity", 0.05, (n) => Math.min(1, Math.max(0, n)));
    pnum("x", "dx (plot units)", "dx", 1);
    pnum("y", "dy (plot units)", "dy", 1);
    if (kind !== "container") visible();
    return F;
  }

  function buildFields(
    p: Project,
    sel: Set<string>,
    ps: PartSelection | null,
    manifests: Record<string, FluxPlotManifest>,
    lib: TextStyle[],
  ): Field[] {
    if (ps) {
      for (const f of p.figures)
        for (const e of f.elements)
          if (e.id === ps.elementId && e.type === "plot")
            return buildPartFields(e, ps.partId, manifests[e.assetId], lib);
    }
    const els: Element[] = [];
    for (const f of p.figures)
      for (const e of f.elements) if (sel.has(e.id)) els.push(e);
    const primary = els[0];
    if (!primary) return [];

    const upd = (fn: (e: Element, proj: Project) => void) =>
      mutate((proj) => {
        for (const f of proj.figures)
          for (const e of f.elements)
            if (sel.has(e.id)) {
              fn(e, proj);
              applyTextLayout(e);
            }
      });

    const F: Field[] = [];
    const num = (
      key: string,
      label: string,
      group: string,
      g: () => number,
      a: (e: Element, v: number, proj: Project) => void,
      step = 1,
    ) =>
      F.push({
        key,
        label,
        group,
        kind: "number",
        step,
        get: g,
        apply: (v) => upd((e, proj) => a(e, Number(v), proj)),
      });

    // Union-by-presence (multi-type selections): a section renders when ANY
    // selected element is of that family. `get` reads from the FIRST matching
    // element; every applier stays type-guarded per element (mirrors
    // ops.setElementStyle), so a mixed apply only touches valid targets.
    const textEl = els.find((e) => e.type === "text");
    const shapeEl = els.find((e) => e.type === "rect" || e.type === "ellipse" || e.type === "path");
    const strokeEl = els.find(
      (e) => e.type === "rect" || e.type === "ellipse" || e.type === "path" || e.type === "line",
    );
    const rectEl = els.find((e) => e.type === "rect");
    const lineEl = els.find((e) => e.type === "line");
    const boxEl = els.find((e) => "width" in e && e.type !== "line");

    // Geometry (all element types; position reads the primary)
    num("x", "x position", "Geometry", () => Math.round(primary.x), (e, v) => (e.x = v));
    num("y", "y position", "Geometry", () => Math.round(primary.y), (e, v) => (e.y = v));
    if (boxEl) {
      num("w", "width", "Geometry", () => Math.round((boxEl as any).width), (e, v) => { if ("width" in e) e.width = Math.max(1, v); });
      num("h", "height", "Geometry", () => Math.round((boxEl as any).height), (e, v) => { if ("height" in e) e.height = Math.max(1, v); });
    }
    num("r", "rotation", "Geometry", () => Math.round(primary.rotation), (e, v) => (e.rotation = v));
    num("o", "opacity", "Geometry", () => primary.opacity ?? 1, (e, v) => (e.opacity = Math.min(1, Math.max(0, v))), 0.05);

    // Reset crop (P5): an action for cropped image/plot elements — one commit
    // through ops.setCrop(null): the box returns to the full content at its
    // current scale (content pinned), and this field disappears with the crop.
    const croppedEl = els.find((e) => (e.type === "image" || e.type === "plot") && e.crop);
    if (croppedEl) {
      const cid = croppedEl.id;
      F.push({
        key: "v",
        label: "reset crop (show full content)",
        group: "Geometry",
        kind: "toggle",
        get: () => true,
        apply: () => commit((proj) => ops.setCrop(proj, cid, null)),
      });
    }

    // Fill
    if (shapeEl) {
      F.push({ key: "c", label: "fill color", group: "Fill", kind: "color", target: "fill", get: () => (shapeEl as any).fill, apply: () => {} });
      // "none" as a first-class state: toggling back restores the draw-style fill.
      F.push({ key: "0", label: "no fill (outline only)", group: "Fill", kind: "toggle", get: () => (shapeEl as any).fill === "none", apply: () => { const to = (shapeEl as any).fill === "none" ? get(drawStyle).fill : "none"; upd((e) => { if (e.type === "rect" || e.type === "ellipse" || e.type === "path") e.fill = to; }); } });
    }
    if (rectEl) {
      num("u", "corner radius", "Fill", () => (rectEl as any).cornerRadius, (e, v) => { if (e.type === "rect") e.cornerRadius = Math.max(0, v); });
    }

    // Stroke
    if (strokeEl) {
      const se = strokeEl as Element & { dash?: number[] };
      F.push({ key: "k", label: "stroke color", group: "Stroke", kind: "color", target: "stroke", get: () => (strokeEl as any).stroke, apply: () => {} });
      num("d", "stroke width", "Stroke", () => (strokeEl as any).strokeWidth, (e, v) => { if ("strokeWidth" in e) e.strokeWidth = Math.max(0, v); });
      F.push({ key: "9", label: "no stroke", group: "Stroke", kind: "toggle", get: () => (strokeEl as any).stroke === "none", apply: () => { const to = (strokeEl as any).stroke === "none" ? get(drawStyle).stroke : "none"; upd((e) => { if (e.type === "rect" || e.type === "ellipse" || e.type === "path" || e.type === "line") e.stroke = to; }); } });
      // Dash pattern ([len, gap] canvas px) — the toggle swaps solid↔[6,4];
      // the two numbers appear while dashed (fields rebuild reactively). All
      // writes go through ops.setElementStyle so sanitizing lives in ONE place.
      F.push({ key: "-", label: "dashed stroke", group: "Stroke", kind: "toggle", get: () => !!se.dash?.length, apply: () => { const ids = [...sel]; const on = !!se.dash?.length; commit((proj) => ops.setElementStyle(proj, ids, { dash: on ? [] : [6, 4] })); } });
      if (se.dash?.length) {
        F.push({ key: "[", label: "dash length", group: "Stroke", kind: "number", step: 0.5, get: () => se.dash?.[0] ?? 6, apply: (v) => { const ids = [...sel]; const gap = se.dash?.[1] ?? 4; mutate((proj) => ops.setElementStyle(proj, ids, { dash: [Math.max(0.5, Number(v)), gap] })); } });
        F.push({ key: "]", label: "dash gap", group: "Stroke", kind: "number", step: 0.5, get: () => se.dash?.[1] ?? 4, apply: (v) => { const ids = [...sel]; const len = se.dash?.[0] ?? 6; mutate((proj) => ops.setElementStyle(proj, ids, { dash: [len, Math.max(0.5, Number(v))] })); } });
      }
    }
    // Arrowheads — lines AND open paths share the flags (ops.setElementStyle
    // applies them per-type).
    const arrowEl = els.find((e) => e.type === "line" || (e.type === "path" && !e.closed)) as
      | (Element & { arrowStart?: boolean; arrowEnd?: boolean; arrowStyle?: string; arrowSize?: number })
      | undefined;
    if (arrowEl) {
      const applyArrow = (patch: Partial<{ arrowStart: boolean; arrowEnd: boolean; arrowStyle: "filled" | "vee"; arrowSize: number }>) => {
        const ids = [...sel];
        commit((proj) => ops.setElementStyle(proj, ids, patch));
      };
      F.push({ key: "q", label: "arrow start", group: "Stroke", kind: "toggle", get: () => !!arrowEl.arrowStart, apply: () => applyArrow({ arrowStart: !arrowEl.arrowStart }) });
      F.push({ key: "g", label: "arrow end", group: "Stroke", kind: "toggle", get: () => !!arrowEl.arrowEnd, apply: () => applyArrow({ arrowEnd: !arrowEl.arrowEnd }) });
      if (arrowEl.arrowStart || arrowEl.arrowEnd) {
        F.push({ key: "z", label: "arrowhead", group: "Stroke", kind: "select", options: [{ value: "filled", label: "Filled" }, { value: "vee", label: "V-line" }], get: () => arrowEl.arrowStyle ?? "filled", apply: (v) => applyArrow({ arrowStyle: v as "filled" | "vee" }) });
        num("e", "arrowhead size (× width)", "Stroke", () => arrowEl.arrowSize ?? 4, (e, v) => { if (e.type === "line" || e.type === "path") (e as any).arrowSize = Math.max(1, v); }, 0.5);
      }
    }
    if (lineEl) {
      const ln = lineEl as Element & { type: "line" };
      F.push({ key: "l", label: "cap style", group: "Stroke", kind: "select", options: [{ value: "round", label: "Round" }, { value: "butt", label: "Flat" }, { value: "square", label: "Square" }], get: () => ln.cap ?? "round", apply: (v) => upd((e) => { if (e.type === "line") e.cap = v as "butt" | "round" | "square"; }) });
    }

    // Presets — save a SINGLE primitive to the machine-global design library
    // (<FluxConfig>/presets/designs). Insert side lives on Ctrl+P.
    if (els.length === 1 && presetable(els[0])) {
      const pid = els[0].id;
      F.push({
        key: "p",
        label: "save as preset…",
        group: "Presets",
        kind: "toggle",
        get: () => false,
        apply: () => {
          fluxFigMenuOpen.set(false);
          presetPicker.set({ mode: "save", elementId: pid });
        },
      });
    }

    // Text
    if (textEl) {
      // 'c' stays text colour for text-only selections (muscle memory); it
      // yields to the Fill section's fill colour in mixed selections.
      const tcKey = shapeEl ? "n" : "c";
      const tEl = textEl as Element & { type: "text" };
      F.push({ key: "t", label: "text", group: "Text", kind: "text", get: () => tEl.text, apply: (v) => upd((e) => { if (e.type === "text") { e.text = String(v); } }) });
      // Font size in POINTS (stored px × 0.75; see Inspector) — same unit as journal specs.
      num("e", "font size (pt)", "Text", () => Math.round(tEl.fontSize * 0.75 * 10) / 10, (e, v, proj) => { if (e.type === "text") { e.fontSize = Math.max(1, v) * (4 / 3); ops.detachOnManualEdit(proj, e, ["fontSize"]); } }, 0.5);
      F.push({ key: "b", label: "weight", group: "Text", kind: "select", options: [{ value: "400", label: "Regular" }, { value: "700", label: "Bold" }], get: () => String(tEl.fontWeight), apply: (v) => upd((e, proj) => { if (e.type === "text") { e.fontWeight = Number(v); ops.detachOnManualEdit(proj, e, ["fontWeight"]); } }) });
      F.push({ key: "i", label: "italic", group: "Text", kind: "toggle", get: () => tEl.fontStyle === "italic", apply: () => { const list = [...sel]; mutate((proj) => { ops.toggleTextStyle(proj, list, "italic"); reflowTexts(proj, list); }); } });
      F.push({ key: "j", label: "underline", group: "Text", kind: "toggle", get: () => !!tEl.underline, apply: () => { const list = [...sel]; mutate((proj) => { ops.toggleTextStyle(proj, list, "underline"); reflowTexts(proj, list); }); } });
      F.push({ key: "m", label: "font", group: "Text", kind: "select", options: ["Georgia", "Arial", "Helvetica", "Times New Roman", "Courier New", "Verdana"].map((x) => ({ value: x, label: x })), get: () => tEl.fontFamily, apply: (v) => upd((e, proj) => { if (e.type === "text") { e.fontFamily = String(v); ops.detachOnManualEdit(proj, e, ["fontFamily"]); } }) });
      F.push({ key: "a", label: "align", group: "Text", kind: "select", options: [{ value: "left", label: "Left" }, { value: "center", label: "Center" }, { value: "right", label: "Right" }], get: () => tEl.align, apply: (v) => upd((e, proj) => { if (e.type === "text") { e.align = v as "left" | "center" | "right"; ops.detachOnManualEdit(proj, e, ["align"]); } }) });
      num("l", "line height", "Text", () => tEl.lineHeight ?? 1.2, (e, v, proj) => { if (e.type === "text") { e.lineHeight = Math.max(0.5, v); ops.detachOnManualEdit(proj, e, ["lineHeight"]); } }, 0.05);
      F.push({
        key: "z",
        label: "sizing",
        group: "Text",
        kind: "select",
        options: [{ value: "auto", label: "Auto (hug)" }, { value: "auto-h", label: "Auto H (wrap)" }, { value: "fixed", label: "Fixed" }],
        get: () => tEl.sizing ?? "auto",
        apply: (v) => upd((e) => { if (e.type === "text") e.sizing = v as "auto" | "auto-h" | "fixed"; }),
      });
      // Named text style ('p' — the plan's 'y' collides with the ever-present
      // geometry "y position" field; see IMPLEMENTATION_NOTES).
      F.push({
        key: "p",
        label: "text style",
        group: "Text",
        kind: "select",
        options: styleOptions(p, lib),
        get: () => tEl.styleId ?? "",
        apply: (v) => {
          const val = String(v);
          const list = [...sel];
          if (val === "") {
            upd((e) => { if (e.type === "text") delete e.styleId; });
            return;
          }
          const r = resolveStyle(get(project), lib, val);
          if (!r) return;
          mutate((proj) => {
            if (r.fromLibrary && !proj.textStyles?.some((s) => s.id === r.st.id)) {
              ops.createTextStyle(proj, structuredClone(r.st)); // copy-on-apply
            }
            ops.applyTextStyle(proj, list, r.st.id);
            reflowTexts(proj, list);
          });
        },
      });
      F.push({ key: tcKey, label: "text color", group: "Text", kind: "color", target: "fill", get: () => tEl.color, apply: () => {} });
    }

    return F;
  }

  // The signature entrance: the panel's accent frame DRAWS ITSELF — two luminous
  // lines start at the top-centre, race down both sides and seal at the bottom
  // (manim's rate_func=smooth IS the 5th-order smoothstep), a glowing pen-tip
  // leading each one; then the content materialises. One bidirectional
  // transition so pressing `f` mid-draw catches the state and reverses (P4);
  // only opacity/scale + cheap registered custom props animate (P5); collapses
  // to instant under reduced motion (P6).
  // The frame geometry + the signature "draw" open are shared with the Plot
  // X-Ray (see selfDraw.ts), so they never drift. Only the menu-only "quick-fade"
  // alternative lives here.
  $: pathR = halfFrame(frameW, frameH, true);
  $: pathL = halfFrame(frameW, frameH, false);

  function forge(node: HTMLElement) {
    if (prefersReducedMotion()) return { duration: 0 };
    if (get(settings).fluxFigMenuAnim === "fade") {
      // the whole panel (frame already drawn at rest) fades in/out, very fast.
      return {
        duration: 105,
        css: (t: number) => `opacity:${t}; transform: scale(${0.985 + 0.015 * t});`,
      };
    }
    return drawForge(node);
  }

  // --- interaction ---
  function close() {
    fluxFigMenuOpen.set(false);
  }
  function focusPanel() {
    requestAnimationFrame(() => panelEl?.focus());
  }

  function activate(f: Field) {
    if (f.kind === "color") {
      colorField = f;
      mode = "color";
      return;
    }
    if (f.kind === "toggle") {
      f.apply(true);
      return; // stays in hotkey mode
    }
    beginGesture();
    activeKey = f.key;
    mode = "field";
    requestAnimationFrame(() => {
      const el = inputs[f.key];
      el?.focus();
      if (el instanceof HTMLInputElement) el.select();
    });
  }

  function enterSearch() {
    mode = "search";
    requestAnimationFrame(() => searchEl?.focus());
  }

  function backToHotkey() {
    mode = "hotkey";
    activeKey = null;
    colorField = null;
    focusPanel();
  }

  function onWin(e: KeyboardEvent) {
    if (!$fluxFigMenuOpen || mode !== "hotkey") return;
    const k = e.key;
    // stopImmediatePropagation prevents the global shortcut handler from
    // re-processing the same key (e.g. re-opening on the closing "f").
    if (k === "Escape" || k.toLowerCase() === "f") {
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
    const f = fields.find((fl) => fl.key === k.toLowerCase());
    if (f) {
      e.preventDefault();
      e.stopImmediatePropagation();
      activate(f);
    }
  }

  function onFieldKey(e: KeyboardEvent) {
    if (e.key === "Enter" || e.key === "Escape") {
      e.preventDefault();
      backToHotkey();
    }
  }

  function onSearchKey(e: KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      sIndex = Math.min(sResults.length - 1, sIndex + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      sIndex = Math.max(0, sIndex - 1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const f = sResults[sIndex];
      if (f) {
        mode = "hotkey";
        activate(f);
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      backToHotkey();
    }
  }

  // panel geometry from settings (shared with the X-ray — popupLayout keeps
  // the pair docked). Placement lives on the wrapper (NOT a transform on the
  // panel) so it can never fight the scale transition.
  $: layout = popupLayout($settings);
  $: width = layout.width;
  $: wrapStyle = layout.menuWrap;
  $: bgAlpha = $settings.fluxFigMenuOpacity;

  function colorDisplay(f: Field): { hex: string; name: string } {
    const hex = String(f.get());
    return { hex, name: nameForHex(hex) ?? hex };
  }
</script>

<svelte:window on:keydown={onWin} />

{#if $fluxFigMenuOpen}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="fbackdrop" transition:fade={{ duration: 110 }} on:pointerdown={close}></div>
  <div class="fwrap" style={wrapStyle}>
    <!-- svelte-ignore a11y_no_noninteractive_tabindex a11y_no_static_element_interactions -->
    <div
      class="fluxFigMenu"
      bind:this={panelEl}
      bind:clientWidth={frameW}
      bind:clientHeight={frameH}
      tabindex="-1"
      style={`width:${width}px; --fa:${bgAlpha}; max-height:${layout.menuMax};`}
      transition:forge
      on:pointerdown|stopPropagation
    >
    <!-- the accent frame that draws itself in: two luminous strokes descend from
         the top-centre and seal at the bottom (manim's Create), then content rises. -->
    <svg class="frame" viewBox={`0 0 ${frameW || 1} ${frameH || 1}`} preserveAspectRatio="none" aria-hidden="true">
      <path class="fline" d={pathL} pathLength="100" />
      <path class="fline" d={pathR} pathLength="100" />
    </svg>
    <div class="fcontent">
    <!-- search bar -->
    <div class="search-row" class:active={mode === "search"}>
      <span class="hk">s</span>
      {#if mode === "search"}
        <input
          bind:this={searchEl}
          bind:value={search}
          class="search-in"
          placeholder="Search properties & actions…"
          spellcheck="false"
          on:keydown={onSearchKey}
        />
      {:else}
        <button class="search-fake" on:click={enterSearch}>Search bar…</button>
      {/if}
    </div>

    <div class="body">
      {#if mode === "color" && colorField}
        <div class="color-mode">
          <div class="cm-head"><span class="hk">{colorField.key}</span> {colorField.label}</div>
          <ColorSearch target={colorField.target ?? "fill"} onDone={backToHotkey} onCancel={backToHotkey} />
        </div>
      {:else if mode === "search"}
        <div class="results">
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
        {#each groups as grp}
          <div class="group">
            <div class="gtitle">{grp.name}</div>
            {#each grp.fields as f (f.key)}
              <div class="field" class:editing={activeKey === f.key}>
                <span class="hk">{f.key}</span>
                {#if f.kind === "number"}
                  <span class="label scrubbable" use:scrub={{ get: () => Number(f.get()), step: f.step ?? 1, onStep: (v) => f.apply(v) }}>{f.label}</span>
                {:else}
                  <span class="label">{f.label}</span>
                {/if}
                <span class="control">
                  {#if f.kind === "color"}
                    {@const cd = colorDisplay(f)}
                    <button class="colorbtn" on:click={() => activate(f)}>
                      <span class="dot" style={`background:${cd.hex}`}></span>
                      <span class="cname">{cd.name}</span>
                    </button>
                  {:else if f.kind === "toggle"}
                    <button class="toggle" class:on={Boolean(f.get())} on:click={() => f.apply(true)}>
                      {f.get() ? "on" : "off"}
                    </button>
                  {:else if f.kind === "select"}
                    <select
                      bind:this={inputs[f.key]}
                      value={String(f.get())}
                      on:change={(e) => { f.apply(e.currentTarget.value); backToHotkey(); }}
                      on:keydown={(e) => onFieldKey(e)}
                    >
                      {#each f.options ?? [] as o}<option value={o.value}>{o.label}</option>{/each}
                    </select>
                  {:else if f.kind === "text"}
                    <input
                      bind:this={inputs[f.key]}
                      class="tin"
                      value={String(f.get())}
                      spellcheck="false"
                      on:input={(e) => f.apply(e.currentTarget.value)}
                      on:keydown={(e) => onFieldKey(e)}
                    />
                  {:else}
                    <input
                      bind:this={inputs[f.key]}
                      class="nin"
                      type="text"
                      inputmode="decimal"
                      spellcheck="false"
                      value={f.get()}
                      on:input={(e) => { const v = evalExpr(e.currentTarget.value); if (v != null) f.apply(v); }}
                      on:keydown={(e) => onFieldKey(e)}
                    />
                  {/if}
                </span>
              </div>
            {/each}
          </div>
        {/each}
      {/if}
    </div>

    <div class="foot">
      <span><b class="hk">s</b> search</span>
      <span><b class="hk">f</b>/esc close</span>
      <span>hotkeys jump to a property</span>
    </div>
    </div>
    </div>
  </div>
{/if}

<style>
  .fbackdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.28);
    z-index: 300;
  }
  .fwrap {
    position: fixed;
    inset: 0;
    z-index: 301;
    display: flex;
    pointer-events: none;
  }
  /* Animatable custom properties (Chromium @property = smooth interpolation).
     Inherited so the panel's entrance transition can drive the frame + content
     children. Both rest at 1 (fully drawn / fully shown). */
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

  .fluxFigMenu {
    pointer-events: auto;
    position: relative;
    border-radius: var(--r-3);
    color: var(--c-tx);
    font-family: var(--font-serif);
    outline: none;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    max-height: 78vh;
    will-change: transform, opacity;
    /* Quiet glass: surface tint (opacity from settings) + a faint top sheen. */
    background:
      linear-gradient(
        180deg,
        color-mix(in oklab, var(--c-tx-hi) 6%, transparent),
        transparent 42%
      ),
      color-mix(in oklab, var(--c-surface) calc(var(--fa, 0.94) * 100%), transparent);
    backdrop-filter: blur(16px) saturate(120%);
    -webkit-backdrop-filter: blur(16px) saturate(120%);
    /* depth + a soft blue glow halo so the accent outline reads as distinct */
    box-shadow:
      var(--elev-3),
      0 0 26px -6px var(--c-accent-glow);
  }

  /* The drawn accent frame: a real SVG stroke that draws the rounded rectangle
     (two mirrored half-paths sealing at the bottom), driven by --draw (0..1) via
     stroke-dashoffset. At rest --draw = 1 → fully drawn (it IS the border). */
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
    /* the line glows as it draws — the inner halo reads as luminous ink */
    filter: drop-shadow(0 0 2.5px var(--c-accent-glow));
  }

  /* Content rises in once the frame is set (--content 0..1; rest = 1). */
  .fcontent {
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
    font-family: var(--font-serif);
  }
  .search-row {
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 12px;
    padding: 10px 14px;
    background: color-mix(in oklab, var(--c-tx-hi) 4%, transparent);
    border: 1px solid var(--c-line);
    border-radius: 9px;
  }
  .search-row.active {
    border-color: var(--c-accent);
    box-shadow: 0 0 0 2px var(--c-accent-tint);
  }
  .search-fake {
    flex: 1;
    text-align: left;
    background: none;
    border: none;
    color: var(--c-tx-muted);
    font-size: 19px;
    font-family: inherit;
    cursor: text;
  }
  .search-in {
    flex: 1;
    background: none;
    border: none;
    outline: none;
    color: var(--c-tx);
    font-size: 19px;
    font-family: inherit;
  }
  .body {
    overflow-y: auto;
    padding: 0 12px;
  }
  .group {
    margin-bottom: 14px;
  }
  .gtitle {
    font-size: 12px;
    letter-spacing: 0.4px;
    opacity: 0.5;
    margin: 6px 2px 6px;
    text-transform: capitalize;
  }
  .field {
    display: grid;
    grid-template-columns: 16px 1fr 130px;
    align-items: center;
    gap: 10px;
    padding: 5px 8px;
    border-radius: 7px;
  }
  .field.editing {
    background: var(--c-accent-tint);
    box-shadow: inset 0 0 0 1px var(--c-accent);
  }
  .label {
    font-style: italic;
    font-size: 15px;
  }
  .control {
    display: flex;
    justify-content: flex-end;
  }
  .nin,
  .tin,
  select {
    width: 100%;
    background: var(--c-bg-raised);
    border: 1px solid var(--c-line-strong);
    border-radius: 6px;
    color: var(--c-tx);
    padding: 5px 8px;
    font-size: 14px;
    font-family: inherit;
    outline: none;
  }
  .nin:focus,
  .tin:focus,
  select:focus {
    border-color: var(--c-accent);
  }
  .colorbtn {
    display: flex;
    align-items: center;
    gap: 8px;
    justify-content: flex-end;
    width: 100%;
    background: none;
    border: none;
    color: var(--c-tx);
    cursor: pointer;
    font-family: inherit;
  }
  .dot {
    width: 16px;
    height: 16px;
    border-radius: 50%;
    border: 1px solid var(--c-line-strong);
  }
  .cname {
    font-style: italic;
    font-size: 14px;
    color: var(--c-accent-bright);
  }
  .toggle {
    background: var(--c-bg-raised);
    border: 1px solid var(--c-line-strong);
    border-radius: 6px;
    color: var(--c-tx);
    padding: 4px 12px;
    cursor: pointer;
    font-family: inherit;
    font-style: italic;
  }
  .toggle.on {
    background: var(--c-accent);
    border-color: var(--c-accent);
    color: var(--c-on-accent);
  }
  .color-mode {
    padding: 6px 2px 14px;
  }
  .cm-head {
    font-style: italic;
    font-size: 15px;
    margin-bottom: 10px;
  }
  .results {
    padding: 4px 0 10px;
  }
  .res {
    display: grid;
    grid-template-columns: 16px 1fr auto;
    gap: 10px;
    align-items: center;
    padding: 7px 8px;
    border-radius: 7px;
    cursor: pointer;
  }
  .res.active {
    background: var(--c-accent);
    color: var(--c-on-accent);
  }
  .res.active .hk {
    color: var(--c-on-accent);
  }
  .rlabel {
    font-style: italic;
    font-size: 15px;
  }
  .rgrp {
    font-size: 12px;
    opacity: 0.55;
    text-transform: capitalize;
  }
  .empty {
    opacity: 0.45;
    padding: 14px;
    text-align: center;
  }
  .foot {
    display: flex;
    gap: 16px;
    padding: 9px 16px;
    border-top: 1px solid var(--c-line);
    font-size: 12px;
    color: var(--c-tx-muted);
  }
</style>
