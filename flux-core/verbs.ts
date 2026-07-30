// WS-6.3 — the verb table (see registry.ts for the machinery). Migration is
// batched: registered verbs route through the registry on BOTH surfaces; verbs
// not yet here fall through to flux-cli's legacy switch / flux-mcp's manual
// registerTool blocks. Every entry must keep the EXACT observable behavior of
// the wrapper it replaces (verify-registry-parity.ts pins representative
// strings; verify-f1-mcp/w11-verbs/release-check stay green).

import { z } from "zod";
import type { VerbDef, CliArgSpec } from "./registry";
import { text } from "./registry";
import * as core from "./index";
import * as model from "./model";
import * as references from "./references";
import { ELEMENT_CASCADE_PROPS, TRACK_CASCADE_PROPS, type CascadeSpec, type TrackCascadeSpec } from "../src/lib/cascade";

// --- shared bits -------------------------------------------------------------

/** Copy the defined keys of `a` listed in `keys` into a fresh patch object —
 *  the "only the fields you pass change" contract every patch verb keeps. */
const pick = (a: Record<string, unknown>, keys: string[]): Record<string, never> => {
  const p: Record<string, unknown> = {};
  for (const k of keys) if (a[k] !== undefined) p[k] = a[k];
  return p as Record<string, never>;
};

const s = (v: unknown): string => v as string;
const sArr = (v: unknown): string[] => v as string[];
const n = (v: unknown): number => v as number;

/** pivotX/pivotY → the {x,y} pivot core takes (both or nothing). */
const pivotOf = (a: Record<string, unknown>): { x: number; y: number } | undefined =>
  a.pivotX != null && a.pivotY != null ? { x: n(a.pivotX), y: n(a.pivotY) } : undefined;

/** cascade args → the pure CascadeSpec: --factor selects ×-mode (value ·
 *  factor^step), else +delta; --dl/--dc/--dh form the per-step OKLCh shift
 *  for the color properties. */
const cascadeSpecOf = (a: Record<string, unknown>): CascadeSpec => ({
  property: a.property as CascadeSpec["property"],
  ...(a.factor != null ? { mode: "mul" as const, factor: n(a.factor) } : { delta: n(a.delta ?? 0) }),
  ...(a.dl != null || a.dc != null || a.dh != null
    ? { color: { dL: n(a.dl ?? 0), dC: n(a.dc ?? 0), dH: n(a.dh ?? 0) } }
    : {}),
  ...(a.order != null ? { order: a.order as CascadeSpec["order"] } : {}),
  ...(a.reverse ? { reverse: true } : {}),
  ...(a.firstFixed ? { firstFixed: true } : {}),
});
const trackCascadeSpecOf = (a: Record<string, unknown>): TrackCascadeSpec => ({
  property: a.property as TrackCascadeSpec["property"],
  ...(a.factor != null ? { mode: "mul" as const, factor: n(a.factor) } : { delta: n(a.delta ?? 0) }),
  ...(a.order != null ? { order: a.order as TrackCascadeSpec["order"] } : {}),
  ...(a.reverse ? { reverse: true } : {}),
  ...(a.firstFixed ? { firstFixed: true } : {}),
});

// The element-style surface set_style accepts (schema AND patch keys).
const STYLE_KEYS = [
  "fill",
  "stroke",
  "strokeWidth",
  "opacity",
  "color",
  "fontSize",
  "fontFamily",
  "fontWeight",
  "fontStyle",
  "underline",
  "lineHeight",
  "sizing",
  "align",
  "hidden",
  "locked",
  "name",
  "dash",
  "arrowStart",
  "arrowEnd",
  "arrowStyle",
  "arrowSize",
] as const;

// The full PartOverride surface restyle_part accepts (WS-6.1 closed the
// 5-vs-16 drift; the registry keeps it closed by construction).
const PART_KEYS = [
  "stroke",
  "fill",
  "color",
  "strokeWidth",
  "opacity",
  "fontSize",
  "fontFamily",
  "fontWeight",
  "fontStyle",
  "textDecoration",
  "dx",
  "dy",
  "hidden",
] as const;

// Named-text-style props (create/update share them; sizes in canvas px).
const TEXT_STYLE_PROPS = {
  fontFamily: z.string().optional(),
  fontSize: z.number().optional(),
  fontWeight: z.number().optional(),
  fontStyle: z.enum(["normal", "italic"]).optional(),
  underline: z.boolean().optional(),
  lineHeight: z.number().optional(),
  color: z.string().optional(),
  align: z.enum(["left", "center", "right"]).optional(),
};
const TEXT_STYLE_KEYS = ["fontFamily", "fontSize", "fontWeight", "fontStyle", "underline", "lineHeight", "color", "align"];
// The CLI flag spellings for those props (points → px on the CLI).
const textStyleFlags: CliArgSpec[] = [
  { kind: "flag", at: "font", into: "fontFamily" },
  { kind: "flag", at: "size-pt", into: "fontSize", as: "ptToPx" },
  { kind: "flag", at: "weight", into: "fontWeight", as: "number" },
  { kind: "flag", at: "italic", into: "fontStyle", const: "italic" },
  { kind: "flag", at: "no-italic", into: "fontStyle", const: "normal" },
  { kind: "flag", at: "underline", into: "underline", const: true },
  { kind: "flag", at: "no-underline", into: "underline", const: false },
  { kind: "flag", at: "line-height", into: "lineHeight", as: "number" },
  { kind: "flag", at: "color", into: "color" },
  { kind: "flag", at: "align", into: "align" },
];

// Bezier node schema (add_path / edit_path).
const handleZ = z.object({ dx: z.number(), dy: z.number() });
const nodeZ = z.object({
  x: z.number(),
  y: z.number(),
  type: z.enum(["corner", "smooth"]),
  hIn: handleZ.optional(),
  hOut: handleZ.optional(),
});

// Flux Slide vocabularies (shared with flux-mcp's remaining manual blocks:
// set_slide uses SLIDE_LAYOUTS, set_animation uses SLIDE_PRESETS).
export const SLIDE_PRESETS = [
  "fade", "fadeRise", "popIn", "drawOn", "growBaseline", "stagger", "writeOn",
  "fadeOut", "popOut", "drawOff", "wipeOut",
  "highlight", "dim", "move", "scale", "rotate", "camera", "countUp", "morph",
  "transform",
] as const;
export const SLIDE_LAYOUTS = ["title", "section", "content-figure", "two-column", "full-bleed", "blank"] as const;
export const SLIDE_THEMES = ["flux-dark", "flux-light", "flux-paper", "flux-midnight", "flux-slate", "flux-sepia", "flux-contrast"] as const;

export const VERBS: VerbDef[] = [
  // --- batch 0: trivial project verbs ------------------------------------------
  {
    name: "list_project",
    cli: "list",
    summary: "List the project's documents, figures (with panel letters), and references.",
    params: {},
    cliArgs: [],
    handler: (ctx) => model.listProject(ctx.root),
    render: {
      // Both surfaces have always printed the JSON payload.
      human: (r) => ({ out: JSON.stringify(r, null, 2) }),
    },
  },
  {
    name: "reindex",
    cli: "reindex",
    summary: "Rebuild project.json.figures[] from fig/index.json.",
    params: {},
    cliArgs: [],
    handler: (ctx) => model.reindex(ctx.root),
    render: {
      human: (r) => ({ err: `✓ reindexed ${(r as { figures: number }).figures} figure(s)` }),
      mcp: (r) => text(`reindexed ${(r as { figures: number }).figures} figure(s)`),
    },
  },
  {
    name: "config_paths",
    cli: "config",
    aliases: ["config-paths"],
    summary:
      "Resolve Flux's machine-level paths as JSON: fluxConfigPath (the user's FluxConfig folder), fluxLibPath (the reference library, always <FluxConfig>/FluxLib), contextPath/userContextPath/fluxContextPath (the machine Context layer), agentsConfigPath (the agent roster), and userDataDir — plus `build` (version/commit/entry) identifying which Flux build is answering. Before working, read every file in userContextPath (who the user is + their standing rules) and orient via fluxContextPath/README.md.",
    params: {},
    cliArgs: [],
    handler: () => references.configInfo(),
    render: {
      human: (r) => ({ out: JSON.stringify(r, null, 2) }),
    },
  },

  // --- batch A: the one-line figure/style/text verbs ---------------------------
  {
    name: "set_caption",
    cli: "set-caption",
    summary:
      "Write a figure's caption. Whole-string form distributes the 'Lead. **a**, … **b**, …' convention into the per-panel caption blocks (the app's Caption Editor structure); pass panel:'a' to write ONE panel's text.",
    params: { id: z.string(), markdown: z.string(), panel: z.string().optional() },
    cliArgs: [
      { kind: "pos", at: 0, into: "id", required: true },
      { kind: "rest", at: 1, into: "markdown", as: "joined", default: "" },
      { kind: "flag", at: "file", into: "markdown", as: "fileText" },
      { kind: "flag", at: "panel", into: "panel" },
    ],
    handler: (ctx, a) => core.setCaption(ctx.root, s(a.id), s(a.markdown), { panel: a.panel as string | undefined }),
    render: {
      human: (r, a) => {
        const panels = (r as { panels: string[] }).panels;
        if (a.panel) return { err: `✓ caption written for ${a.id} panel ${a.panel}` };
        if (panels.length)
          return {
            err: `✓ caption written for ${a.id} — distributed across lead + panels [${panels.join("")}] (use --panel <letter> for one panel)`,
          };
        return { err: `✓ caption written for ${a.id}` };
      },
      mcp: (r, a) => {
        const panels = (r as { panels: string[] }).panels;
        if (a.panel) return text(`caption set for ${a.id} panel ${a.panel}`);
        return text(`caption set for ${a.id}` + (panels.length ? ` — distributed across lead + panels [${panels.join("")}]` : ""));
      },
    },
  },
  {
    name: "get_caption",
    cli: "caption",
    summary:
      "Read a figure's composed caption (fig/captions/<id>.md — figure caption + per-panel captions). Use before set_caption to see the current text.",
    params: { figureId: z.string() },
    cliArgs: [{ kind: "pos", at: 0, into: "figureId", required: true }],
    handler: (ctx, a) => core.captionFor(ctx.root, s(a.figureId)),
    render: {
      human: (r) => ({ out: r as string }),
      mcp: (r, a) => text((r as string) || `(no caption for ${a.figureId})`),
    },
  },
  {
    name: "set_style",
    cli: "set-style",
    cliRoot: "flags",
    summary:
      "Set element-level style on element ids: fill/stroke/strokeWidth/opacity/color/fontSize (canvas px = pt × 4/3), text props (fontFamily/fontWeight/fontStyle/underline/lineHeight/sizing/align), stroke dash (--dash 6,4 in canvas px; --solid clears), arrowheads for lines AND open paths (--arrow-start/--arrow-end/--no-arrow-*, --arrow-style filled|vee, --arrow-size ×width), plus hidden (omit from canvas + export), locked (not editable on canvas), and name (Layers label).",
    params: {
      ids: z.array(z.string()),
      fill: z.string().optional(),
      stroke: z.string().optional(),
      strokeWidth: z.number().optional(),
      opacity: z.number().optional(),
      color: z.string().optional(),
      fontSize: z.number().optional(),
      fontFamily: z.string().optional(),
      fontWeight: z.number().optional(),
      fontStyle: z.enum(["normal", "italic"]).optional(),
      underline: z.boolean().optional(),
      lineHeight: z.number().optional(),
      sizing: z.enum(["auto", "auto-h", "fixed"]).optional(),
      align: z.enum(["left", "center", "right"]).optional(),
      hidden: z.boolean().optional(),
      locked: z.boolean().optional(),
      name: z.string().optional(),
      dash: z.array(z.number()).optional(),
      arrowStart: z.boolean().optional(),
      arrowEnd: z.boolean().optional(),
      arrowStyle: z.enum(["filled", "vee"]).optional(),
      arrowSize: z.number().optional(),
    },
    cliArgs: [
      { kind: "rest", at: 0, into: "ids", required: true },
      { kind: "flag", at: "stroke", into: "stroke" },
      { kind: "flag", at: "fill", into: "fill" },
      { kind: "flag", at: "color", into: "color" },
      { kind: "flag", at: "stroke-width", into: "strokeWidth", as: "number" },
      { kind: "flag", at: "opacity", into: "opacity", as: "number" },
      { kind: "flag", at: "dash", into: "dash", as: "csvNum" },
      { kind: "flag", at: "solid", into: "dash", const: [] },
      { kind: "flag", at: "arrow-start", into: "arrowStart", const: true },
      { kind: "flag", at: "no-arrow-start", into: "arrowStart", const: false },
      { kind: "flag", at: "arrow-end", into: "arrowEnd", const: true },
      { kind: "flag", at: "no-arrow-end", into: "arrowEnd", const: false },
      { kind: "flag", at: "arrow-style", into: "arrowStyle" },
      { kind: "flag", at: "arrow-size", into: "arrowSize", as: "number" },
      { kind: "flag", at: "font-size", into: "fontSize", as: "number" },
      { kind: "flag", at: "font", into: "fontFamily" },
      { kind: "flag", at: "weight", into: "fontWeight", as: "number" },
      { kind: "flag", at: "italic", into: "fontStyle", const: "italic" },
      { kind: "flag", at: "no-italic", into: "fontStyle", const: "normal" },
      { kind: "flag", at: "underline", into: "underline", const: true },
      { kind: "flag", at: "no-underline", into: "underline", const: false },
      { kind: "flag", at: "line-height", into: "lineHeight", as: "number" },
      { kind: "flag", at: "sizing", into: "sizing" },
      { kind: "flag", at: "align", into: "align" },
      { kind: "flag", at: "hidden", into: "hidden", const: true },
      { kind: "flag", at: "show", into: "hidden", const: false },
      { kind: "flag", at: "locked", into: "locked", const: true },
      { kind: "flag", at: "unlock", into: "locked", const: false },
      { kind: "flag", at: "name", into: "name" },
    ],
    handler: (ctx, a) => core.setElementStyle(ctx.root, sArr(a.ids), pick(a, [...STYLE_KEYS])),
    render: {
      human: (_r, a) => ({ err: `✓ styled ${sArr(a.ids).length} element(s)` }),
      mcp: (_r, a) => text(`styled ${sArr(a.ids).length} element(s)`),
    },
  },
  {
    name: "restyle_part",
    cli: "restyle",
    cliRoot: "flags",
    summary:
      "Restyle a semantic-plot part or series by its stable id (e.g. 'control.line' or the group 'control'). Writes an override that survives regeneration. Omit elementId if the figure has a single plot panel.",
    // WS-6.1: the FULL PartOverride surface (the CLI exposed these all along —
    // same core.setPartOverride underneath; the 5-prop schema was drift).
    params: {
      figureId: z.string(),
      partId: z.string(),
      elementId: z.string().optional(),
      stroke: z.string().optional(),
      fill: z.string().optional(),
      color: z.string().optional(),
      strokeWidth: z.number().optional(),
      opacity: z.number().optional(),
      fontSize: z.number().optional(),
      fontFamily: z.string().optional(),
      fontWeight: z.number().optional(),
      fontStyle: z.enum(["normal", "italic"]).optional(),
      textDecoration: z.string().optional(),
      dx: z.number().optional(),
      dy: z.number().optional(),
      hidden: z.boolean().optional(),
    },
    cliArgs: [
      { kind: "pos", at: 0, into: "figureId", required: true },
      { kind: "pos", at: 1, into: "partId", required: true },
      { kind: "flag", at: "element", into: "elementId" },
      { kind: "flag", at: "stroke", into: "stroke" },
      { kind: "flag", at: "fill", into: "fill" },
      { kind: "flag", at: "color", into: "color" },
      { kind: "flag", at: "stroke-width", into: "strokeWidth", as: "number" },
      { kind: "flag", at: "opacity", into: "opacity", as: "number" },
      { kind: "flag", at: "font-size", into: "fontSize", as: "number" },
      { kind: "flag", at: "font", into: "fontFamily" },
      { kind: "flag", at: "weight", into: "fontWeight", as: "number" },
      { kind: "flag", at: "italic", into: "fontStyle", const: "italic" },
      { kind: "flag", at: "no-italic", into: "fontStyle", const: "normal" },
      { kind: "flag", at: "hidden", into: "hidden", const: true },
    ],
    handler: (ctx, a) =>
      core.setPartOverride(ctx.root, s(a.figureId), s(a.partId), pick(a, [...PART_KEYS]), a.elementId as string | undefined),
    render: {
      human: (r, a) => ({ err: `✓ restyled ${a.partId} on ${(r as { elementId: string }).elementId}` }),
      mcp: (r, a) => text(`restyled ${a.partId} on ${(r as { elementId: string }).elementId}`),
    },
  },
  {
    name: "set_crop",
    cli: "set-crop",
    cliRoot: "flags",
    summary:
      "Crop an image/plot element to a window, or reset it. `crop` is {x,y,width,height} in INTRINSIC content px (the asset's display size: SVG CSS px, PNG px × 96/dpi); omit it (or pass null) to remove the crop. Figma semantics: the content stays pinned on the canvas — the element box moves/resizes to frame exactly the window; reset returns the box to the full content at its current scale.",
    params: {
      id: z.string(),
      crop: z
        .object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })
        .nullable()
        .optional(),
    },
    cliArgs: [
      { kind: "pos", at: 0, into: "id", required: true },
      { kind: "flag", at: "x", into: "crop.x", as: "number", required: true },
      { kind: "flag", at: "y", into: "crop.y", as: "number", required: true },
      { kind: "flag", at: "width", into: "crop.width", as: "number", required: true },
      { kind: "flag", at: "height", into: "crop.height", as: "number", required: true },
    ],
    handler: (ctx, a) => core.setCrop(ctx.root, s(a.id), (a.crop as Parameters<typeof core.setCrop>[2]) ?? null),
    render: {
      human: (_r, a) => {
        const c = a.crop as { x: number; y: number; width: number; height: number } | null | undefined;
        return { err: c ? `✓ cropped ${a.id} to ${c.width}×${c.height} @ ${c.x},${c.y}` : `✓ reset crop on ${a.id}` };
      },
      mcp: (_r, a) => {
        const c = a.crop as { x: number; y: number; width: number; height: number } | null | undefined;
        return text(c ? `cropped ${a.id} to ${c.width}×${c.height} @ ${c.x},${c.y}` : `reset crop on ${a.id}`);
      },
    },
  },
  {
    name: "rotate_elements",
    cli: "rotate",
    cliRoot: "flags",
    summary:
      "Rotate elements by `deg` degrees about a pivot (default = the selection's bbox centre). A single element rotates about its own centre; a group orbits the shared pivot rigidly.",
    params: { ids: z.array(z.string()), deg: z.number(), pivotX: z.number().optional(), pivotY: z.number().optional() },
    cliArgs: [
      { kind: "rest", at: 0, into: "ids", required: true },
      { kind: "flag", at: "degrees", into: "deg", as: "number", default: 0 },
      { kind: "flag", at: "deg", into: "deg", as: "number" },
      { kind: "flag", at: "px", into: "pivotX", as: "number" },
      { kind: "flag", at: "py", into: "pivotY", as: "number" },
    ],
    handler: (ctx, a) => core.rotateElements(ctx.root, sArr(a.ids), n(a.deg), pivotOf(a)),
    render: {
      human: (_r, a) => ({ err: `✓ rotated ${sArr(a.ids).length} element(s) by ${a.deg}°` }),
      mcp: (_r, a) => text(`rotated ${sArr(a.ids).length} element(s) by ${a.deg}°`),
    },
  },
  {
    name: "align_figure",
    cli: "align",
    cliRoot: "flags",
    summary:
      "Align a figure's elements to a common edge/axis: left, right, top, bottom, centerH (share a vertical center line), centerV (share a horizontal center line). Omit `ids` to align all of the figure's elements.",
    params: {
      figureId: z.string(),
      kind: z.enum(["left", "right", "top", "bottom", "centerH", "centerV"]),
      ids: z.array(z.string()).optional(),
    },
    cliArgs: [
      { kind: "pos", at: 0, into: "figureId", required: true },
      { kind: "pos", at: 1, into: "kind" },
      { kind: "flag", at: "kind", into: "kind" },
      { kind: "flag", at: "ids", into: "ids", as: "csv" },
    ],
    handler: (ctx, a) =>
      core.alignFigure(ctx.root, s(a.figureId), a.kind as Parameters<typeof core.alignFigure>[2], a.ids as string[] | undefined),
    render: {
      human: (_r, a) => ({ err: `✓ aligned ${a.figureId} (${a.kind})` }),
      mcp: (_r, a) => text(`aligned ${a.figureId} (${a.kind})`),
    },
  },
  {
    name: "bring_inside",
    cli: "bring-inside",
    cliRoot: "flags",
    summary:
      "Bring elements inside the figure frame: translate each unit (whole groups move rigidly) the minimal distance so it lies inside the frame — nothing is resized, units may overlap; an element larger than the frame is positioned to fully cover it. The rescue for imports placed at true physical size outside the frame (GUI: Ctrl+Shift+I). `ids` restricts the set (default = all elements).",
    params: { figureId: z.string(), ids: z.array(z.string()).optional() },
    cliArgs: [
      { kind: "pos", at: 0, into: "figureId", required: true },
      { kind: "flag", at: "ids", into: "ids", as: "csv" },
    ],
    handler: (ctx, a) => core.bringInside(ctx.root, s(a.figureId), a.ids as string[] | undefined),
    render: {
      human: (_r, a) => ({ err: `✓ brought ${a.ids ? sArr(a.ids).length + " element(s)" : "all elements"} inside ${a.figureId}` }),
      mcp: (_r, a) => text(`brought ${a.ids ? sArr(a.ids).length + " element(s)" : "all elements"} inside ${a.figureId}`),
    },
  },
  {
    name: "cascade",
    cli: "cascade",
    cliRoot: "flags",
    summary:
      "Cascade one property across elements: the unit at rank k (0-indexed, ordered by --order over the given ids; default = the ids order) gets value + delta·step, where step = k with --first-fixed, else k+1. --factor switches to multiplicative (value · factor^step). property ∈ x|y|rotation|width|height|opacity|strokeWidth|cornerRadius|fontSize|fill|stroke|color; the color properties shift per step in OKLCh via --dl/--dc/--dh ('none'/unparseable values keep their rank, unchanged). A whole group is ONE rank (x/y translate and rotation turns it rigidly); elements the property doesn't apply to are excluded and consume no rank; fontSize deltas are in pt; width/height need single (non-path, non-line) elements. GUI: Ctrl+Shift+C.",
    params: {
      figureId: z.string(),
      property: z.enum(ELEMENT_CASCADE_PROPS),
      ids: z.array(z.string()),
      delta: z.number().optional(),
      factor: z.number().positive().optional(),
      dl: z.number().optional(),
      dc: z.number().optional(),
      dh: z.number().optional(),
      order: z.enum(["selection", "layer", "x", "y"]).optional(),
      reverse: z.boolean().optional(),
      firstFixed: z.boolean().optional(),
    },
    cliArgs: [
      { kind: "pos", at: 0, into: "figureId", required: true },
      { kind: "pos", at: 1, into: "property", required: true },
      { kind: "rest", at: 2, into: "ids", required: true },
      { kind: "flag", at: "delta", into: "delta", as: "number" },
      { kind: "flag", at: "factor", into: "factor", as: "number" },
      { kind: "flag", at: "dl", into: "dl", as: "number" },
      { kind: "flag", at: "dc", into: "dc", as: "number" },
      { kind: "flag", at: "dh", into: "dh", as: "number" },
      { kind: "flag", at: "order", into: "order" },
      { kind: "flag", at: "reverse", into: "reverse", as: "boolean" },
      { kind: "flag", at: "first-fixed", into: "firstFixed", as: "boolean" },
    ],
    handler: (ctx, a) => core.cascadeElements(ctx.root, s(a.figureId), sArr(a.ids), cascadeSpecOf(a)),
    render: {
      human: (_r, a) => ({ err: `✓ cascaded ${a.property} across ${sArr(a.ids).length} element(s)` }),
      mcp: (_r, a) => text(`cascaded ${a.property} across ${sArr(a.ids).length} element(s)`),
    },
  },
  {
    name: "distribute",
    cli: "distribute",
    cliRoot: "flags",
    summary:
      "Distribute a figure's panels along an axis. With `gap`, place them at an EXACT edge-to-edge gap (equal gutters, anchored on the first item); without `gap`, equalize the spacing between the outermost items (needs ≥3). `ids` restricts the set (default = all elements).",
    params: { figureId: z.string(), axis: z.enum(["h", "v"]).optional(), gap: z.number().optional(), ids: z.array(z.string()).optional() },
    cliArgs: [
      { kind: "pos", at: 0, into: "figureId", required: true },
      { kind: "flag", at: "axis", into: "axis" },
      { kind: "flag", at: "v", into: "axis", const: "v" },
      { kind: "flag", at: "gap", into: "gap", as: "number" },
      { kind: "flag", at: "ids", into: "ids", as: "csv" },
    ],
    handler: (ctx, a) =>
      core.distributeFigure(ctx.root, s(a.figureId), (a.axis as "h" | "v") ?? "h", a.gap as number | undefined, a.ids as string[] | undefined),
    render: {
      human: (_r, a) => ({ err: `✓ distributed ${a.figureId} (${(a.axis as string) ?? "h"}${a.gap != null ? `, gap ${a.gap}` : ""})` }),
      mcp: (_r, a) => text(`distributed ${a.figureId} (${(a.axis as string) ?? "h"}${a.gap != null ? `, gap ${a.gap}` : ""})`),
    },
  },
  {
    name: "arrange_figure",
    cli: "arrange",
    cliRoot: "flags",
    summary: "Grid-arrange a figure's existing panels (give rows OR cols; gap optional).",
    params: {
      figureId: z.string(),
      rows: z.number().optional(),
      cols: z.number().optional(),
      gap: z.number().optional(),
    },
    cliArgs: [
      { kind: "pos", at: 0, into: "figureId", required: true },
      { kind: "flag", at: "rows", into: "rows", as: "number" },
      { kind: "flag", at: "cols", into: "cols", as: "number" },
      { kind: "flag", at: "gap", into: "gap", as: "number" },
    ],
    handler: (ctx, a) =>
      core.arrangeFigure(ctx.root, s(a.figureId), {
        rows: a.rows as number | undefined,
        cols: a.cols as number | undefined,
        gap: a.gap as number | undefined,
      }),
    render: {
      human: (_r, a) => ({ err: `✓ arranged ${a.figureId}` }),
      mcp: (_r, a) => text(`arranged ${a.figureId}`),
    },
  },
  {
    name: "scale_elements",
    cli: "scale",
    cliRoot: "flags",
    summary:
      "Proportionally scale elements about a pivot (default = their bbox centre) by `factor` — scales geometry AND stroke widths, corner radii, and font sizes together (unlike a plain resize, which leaves weights fixed). 0.5 halves everything.",
    params: { ids: z.array(z.string()), factor: z.number(), pivotX: z.number().optional(), pivotY: z.number().optional() },
    cliArgs: [
      { kind: "rest", at: 0, into: "ids", required: true },
      { kind: "flag", at: "f", into: "factor", as: "number", default: 1 },
      { kind: "flag", at: "factor", into: "factor", as: "number" },
      { kind: "flag", at: "px", into: "pivotX", as: "number" },
      { kind: "flag", at: "py", into: "pivotY", as: "number" },
    ],
    handler: (ctx, a) => core.scaleElements(ctx.root, sArr(a.ids), n(a.factor), pivotOf(a)),
    render: {
      human: (_r, a) => ({ err: `✓ scaled ${sArr(a.ids).length} element(s) by ${a.factor}×` }),
      mcp: (_r, a) => text(`scaled ${sArr(a.ids).length} element(s) by ${a.factor}×`),
    },
  },
  {
    name: "reorder_element",
    cli: "reorder",
    cliRoot: "flags",
    summary: "Move an element to an absolute z-index within its figure (0 = bottom, higher = closer to front).",
    params: { figureId: z.string(), id: z.string(), index: z.number() },
    cliArgs: [
      { kind: "pos", at: 0, into: "figureId", required: true },
      { kind: "pos", at: 1, into: "id", required: true },
      { kind: "pos", at: 2, into: "index", as: "number", required: true },
    ],
    handler: (ctx, a) => core.reorderElement(ctx.root, s(a.figureId), s(a.id), n(a.index)),
    render: {
      human: (_r, a) => ({ err: `✓ reordered ${a.id} → z-index ${a.index} in ${a.figureId}` }),
      mcp: (_r, a) => text(`reordered ${a.id} → z-index ${a.index}`),
    },
  },
  {
    name: "set_z",
    cli: "set-z",
    aliases: ["z-order"],
    cliRoot: "flags",
    summary:
      "Change elements' stacking order within their figure: front, back, forward (one step up), or backward (one step down). For an absolute index use reorder_element.",
    params: { figureId: z.string(), ids: z.array(z.string()), where: z.enum(["front", "back", "forward", "backward"]) },
    cliArgs: [
      { kind: "pos", at: 0, into: "figureId", required: true },
      { kind: "pos", at: 1, into: "where" },
      { kind: "flag", at: "where", into: "where" },
      { kind: "rest", at: 2, into: "ids" },
      { kind: "flag", at: "ids", into: "ids", as: "csv" },
    ],
    handler: (ctx, a) => core.setZOrder(ctx.root, s(a.figureId), sArr(a.ids), a.where as Parameters<typeof core.setZOrder>[3]),
    render: {
      human: (_r, a) => ({ err: `✓ z-order ${a.where} for ${sArr(a.ids).length} element(s) in ${a.figureId}` }),
      mcp: (_r, a) => text(`z-order ${a.where} for ${sArr(a.ids).length} element(s) in ${a.figureId}`),
    },
  },
  {
    name: "group_elements",
    cli: "group",
    cliRoot: "flags",
    summary:
      "Group ≥2 units (elements and/or whole existing groups, same figure) into one NAMED movable/selectable group (default name 'Group N'). Existing top-level groups NEST inside the new one (Figma ⌘G); members are made z-contiguous. Optional parentId nests the new group under an existing group. Returns the new group id.",
    params: { ids: z.array(z.string()), name: z.string().optional(), parentId: z.string().optional() },
    cliArgs: [
      { kind: "rest", at: 0, into: "ids", required: true },
      { kind: "flag", at: "name", into: "name" },
      { kind: "flag", at: "parent", into: "parentId" },
    ],
    handler: (ctx, a) =>
      core.groupElements(ctx.root, sArr(a.ids), { name: a.name as string | undefined, parentId: a.parentId as string | undefined }),
    render: {
      human: (r, a) => ({
        out: (r as { groupId: string }).groupId,
        err: `✓ grouped ${sArr(a.ids).length} element(s) → ${(r as { groupId: string }).groupId}`,
      }),
      mcp: (r, a) => text(`grouped ${sArr(a.ids).length} element(s) → ${(r as { groupId: string }).groupId}`),
    },
  },
  {
    name: "ungroup_elements",
    cli: "ungroup",
    cliRoot: "flags",
    summary:
      "Ungroup — dissolve each element id's TOP-level group (or pass a group id to dissolve exactly that group). Members drop to the parent group or go loose; nested child groups survive one level up.",
    params: { ids: z.array(z.string()) },
    cliArgs: [{ kind: "rest", at: 0, into: "ids", required: true }],
    handler: (ctx, a) => core.ungroupElements(ctx.root, sArr(a.ids)),
    render: {
      human: (_r, a) => ({ err: `✓ ungrouped ${sArr(a.ids).length} element(s)` }),
      mcp: (_r, a) => text(`ungrouped ${sArr(a.ids).length} id(s)`),
    },
  },
  {
    name: "rename_group",
    cli: "rename-group",
    cliRoot: "flags",
    summary: "Rename a figure group (the Layers panel name).",
    params: { groupId: z.string(), name: z.string() },
    cliArgs: [
      { kind: "pos", at: 0, into: "groupId", required: true },
      { kind: "rest", at: 1, into: "name", as: "joined", required: true },
    ],
    handler: (ctx, a) => core.renameGroup(ctx.root, s(a.groupId), s(a.name)),
    render: {
      human: (_r, a) => ({ err: `✓ renamed ${a.groupId} → "${a.name}"` }),
      mcp: (_r, a) => text(`renamed ${a.groupId} → "${a.name}"`),
    },
  },
  {
    name: "set_group_state",
    cli: "set-group-state",
    cliRoot: "flags",
    summary:
      "Set a group's hidden/locked flags (the Layers panel group eye/padlock). Hidden groups drop out of rendered/exported figures (members inherit via effectiveHidden); members keep their own flags.",
    params: { groupId: z.string(), hidden: z.boolean().optional(), locked: z.boolean().optional() },
    cliArgs: [
      { kind: "pos", at: 0, into: "groupId", required: true },
      { kind: "flag", at: "hide", into: "hidden", const: true },
      { kind: "flag", at: "show", into: "hidden", const: false },
      { kind: "flag", at: "lock", into: "locked", const: true },
      { kind: "flag", at: "unlock", into: "locked", const: false },
    ],
    handler: (ctx, a) =>
      core.setGroupState(ctx.root, s(a.groupId), pick(a, ["hidden", "locked"]) as { hidden?: boolean; locked?: boolean }),
    render: {
      human: (_r, a) => ({ err: `✓ group ${a.groupId} state ${JSON.stringify(pick(a, ["hidden", "locked"]))}` }),
      mcp: (_r, a) => text(`group ${a.groupId} state ${JSON.stringify(pick(a, ["hidden", "locked"]))}`),
    },
  },
  {
    name: "list_groups",
    cli: "list-groups",
    cliRoot: "flags",
    summary:
      "List the figure groups (id, name, parentId nesting, hidden/locked state, member element ids — deep), across the project or one figure.",
    params: { figureId: z.string().optional() },
    cliArgs: [{ kind: "flag", at: "figure", into: "figureId" }],
    handler: async (ctx, a) => (await core.listGroups(ctx.root, a.figureId as string | undefined)).groups,
    render: {
      human: (r) => ({ out: JSON.stringify(r, null, 2) }),
    },
  },
  {
    name: "delete_elements",
    cli: "delete-element",
    aliases: ["delete-elements"],
    cliRoot: "flags",
    summary: "Delete elements by id (removes them from whatever figure they're in). Use to remove a wrong panel/label/shape.",
    params: { ids: z.array(z.string()) },
    cliArgs: [{ kind: "rest", at: 0, into: "ids", required: true }],
    handler: (ctx, a) => core.deleteElements(ctx.root, sArr(a.ids)),
    render: {
      human: (_r, a) => ({ err: `✓ deleted ${sArr(a.ids).length} element(s)` }),
      mcp: (_r, a) => text(`deleted ${sArr(a.ids).length} element(s)`),
    },
  },
  {
    name: "delete_figure",
    cli: "delete-figure",
    cliRoot: "flags",
    summary: "Delete a whole figure (keeps at least one figure in the project). Returns the id the GUI would select next.",
    params: { figureId: z.string() },
    cliArgs: [{ kind: "pos", at: 0, into: "figureId", required: true }],
    handler: (ctx, a) => core.deleteFigure(ctx.root, s(a.figureId)),
    render: {
      human: (r, a) => {
        const next = (r as { nextActiveId?: string }).nextActiveId;
        return { err: `✓ deleted figure ${a.figureId}${next ? ` (next: ${next})` : ""}` };
      },
      mcp: (r, a) => {
        const next = (r as { nextActiveId?: string }).nextActiveId;
        return text(`deleted figure ${a.figureId}${next ? ` (next: ${next})` : ""}`);
      },
    },
  },
  {
    name: "duplicate_figure",
    cli: "duplicate-figure",
    cliRoot: "flags",
    summary: "Duplicate a whole figure (fresh element/group ids). Returns the new figure id.",
    params: { figureId: z.string() },
    cliArgs: [{ kind: "pos", at: 0, into: "figureId", required: true }],
    handler: (ctx, a) => core.duplicateFigure(ctx.root, s(a.figureId)),
    render: {
      human: (r, a) => ({
        out: (r as { figureId: string }).figureId,
        err: `✓ duplicated ${a.figureId} → ${(r as { figureId: string }).figureId}`,
      }),
      mcp: (r, a) => text(`duplicated ${a.figureId} → ${(r as { figureId: string }).figureId}`),
    },
  },
  {
    name: "duplicate_elements",
    cli: "duplicate",
    cliRoot: "flags",
    summary:
      "Duplicate elements within their figure `count` times, each stamp offset by k·(dx,dy), with fresh element + group ids (each stamp independent). Use to build even arrays — tick rows, marker series, panel scaffolds. Returns the last stamp's ids.",
    params: { figureId: z.string(), ids: z.array(z.string()), dx: z.number().optional(), dy: z.number().optional(), count: z.number().optional() },
    cliArgs: [
      { kind: "pos", at: 0, into: "figureId", required: true },
      { kind: "rest", at: 1, into: "ids", required: true },
      { kind: "flag", at: "dx", into: "dx", as: "number" },
      { kind: "flag", at: "dy", into: "dy", as: "number" },
      { kind: "flag", at: "count", into: "count", as: "number" },
    ],
    handler: (ctx, a) =>
      core.duplicateElements(ctx.root, s(a.figureId), sArr(a.ids), {
        dx: (a.dx as number | undefined) ?? 16,
        dy: (a.dy as number | undefined) ?? 16,
        count: a.count as number | undefined,
      }),
    render: {
      human: (r, a) => ({ err: `✓ duplicated ${sArr(a.ids).length} element(s) → ${(r as { ids: string[] }).ids.length} new` }),
      mcp: (r, a) => text(`duplicated ${sArr(a.ids).length} → ${(r as { ids: string[] }).ids.length} new`),
    },
  },
  {
    name: "add_fig_text",
    cli: "add-fig-text",
    cliRoot: "flags",
    summary:
      "Add a text element to a FIGURE (fontSize in canvas px = pt × 4/3; sizing auto = box hugs text, auto-h = wrap at width, fixed = pinned box). panelLabel: true creates a semantic panel label (bold 8 pt, letterable by auto_label).",
    params: {
      figureId: z.string(),
      text: z.string(),
      panelLabel: z.boolean().optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      width: z.number().optional(),
      height: z.number().optional(),
      fontSize: z.number().optional(),
      fontWeight: z.number().optional(),
      fontFamily: z.string().optional(),
      color: z.string().optional(),
      align: z.enum(["left", "center", "right"]).optional(),
      sizing: z.enum(["auto", "auto-h", "fixed"]).optional(),
    },
    cliArgs: [
      { kind: "pos", at: 0, into: "figureId", required: true },
      { kind: "rest", at: 1, into: "text", as: "joined", default: "Text" },
      { kind: "flag", at: "panel-label", into: "panelLabel", as: "boolean" },
      { kind: "flag", at: "x", into: "x", as: "number" },
      { kind: "flag", at: "y", into: "y", as: "number" },
      { kind: "flag", at: "width", into: "width", as: "number" },
      { kind: "flag", at: "height", into: "height", as: "number" },
      { kind: "flag", at: "size-pt", into: "fontSize", as: "ptToPx" },
      { kind: "flag", at: "weight", into: "fontWeight", as: "number" },
      { kind: "flag", at: "font", into: "fontFamily" },
      { kind: "flag", at: "color", into: "color" },
      { kind: "flag", at: "align", into: "align" },
      { kind: "flag", at: "sizing", into: "sizing" },
    ],
    handler: (ctx, a) =>
      core.addFigText(
        ctx.root,
        s(a.figureId),
        pick(a, ["text", "panelLabel", "x", "y", "width", "height", "fontSize", "fontWeight", "fontFamily", "color", "align", "sizing"]) as unknown as Parameters<typeof core.addFigText>[2],
      ),
    render: {
      human: (r) => ({ out: (r as { id: string }).id }),
      mcp: (r, a) => text(`added text ${(r as { id: string }).id} to ${a.figureId}`),
    },
  },
  {
    name: "list_text_styles",
    cli: "text-styles",
    cliRoot: "flags",
    summary:
      "List named text styles: the project's (default) or the machine-global library (global: true). Library styles are reusable definitions — applying one copies it into the project.",
    params: { global: z.boolean().optional() },
    cliArgs: [{ kind: "flag", at: "global", into: "global", as: "boolean" }],
    handler: (ctx, a) => (a.global ? core.listGlobalTextStyles() : core.listTextStyles(ctx.root)),
    render: {
      human: (r) => ({ out: JSON.stringify(r, null, 2) }),
    },
  },
  {
    name: "create_text_style",
    cli: "create-text-style",
    cliRoot: "flags",
    summary:
      "Create a named text style — from an element's current look (fromElementId, which also links that element) or from explicit props. fontSize in canvas px (pt × 4/3).",
    params: {
      name: z.string(),
      fromElementId: z.string().optional(),
      ...TEXT_STYLE_PROPS,
    },
    cliArgs: [
      { kind: "flag", at: "name", into: "name", as: "trim", required: true },
      { kind: "flag", at: "from", into: "fromElementId" },
      ...textStyleFlags,
    ],
    handler: (ctx, a) =>
      core.createTextStyle(ctx.root, pick(a, ["name", "fromElementId", ...TEXT_STYLE_KEYS]) as unknown as Parameters<typeof core.createTextStyle>[1]),
    render: {
      human: (r) => ({ out: JSON.stringify((r as { style: unknown }).style, null, 2) }),
      mcp: (r) => {
        const st = (r as { style: { id: string; name: string } }).style;
        return text(`created text style ${st.id} ("${st.name}")`);
      },
    },
  },
  {
    name: "update_text_style",
    cli: "update-text-style",
    cliRoot: "flags",
    summary: "Patch a named text style (name renames) — LIVE: re-applies to every linked text element.",
    params: {
      styleId: z.string(),
      name: z.string().optional(),
      ...TEXT_STYLE_PROPS,
    },
    cliArgs: [
      { kind: "pos", at: 0, into: "styleId", required: true },
      { kind: "flag", at: "name", into: "name", as: "trim" },
      ...textStyleFlags,
    ],
    handler: (ctx, a) => core.updateTextStyle(ctx.root, s(a.styleId), pick(a, ["name", ...TEXT_STYLE_KEYS])),
    render: {
      human: (_r, a) => ({ err: `✓ updated text style ${a.styleId} (re-applied to linked texts)` }),
      mcp: (_r, a) => text(`updated text style ${a.styleId}`),
    },
  },
  {
    name: "delete_text_style",
    cli: "delete-text-style",
    cliRoot: "flags",
    summary: "Delete a named text style. Linked text elements keep their current look and drop the link.",
    params: { styleId: z.string() },
    cliArgs: [{ kind: "pos", at: 0, into: "styleId", required: true }],
    handler: (ctx, a) => core.deleteTextStyle(ctx.root, s(a.styleId)),
    render: {
      human: (_r, a) => ({ err: `✓ deleted text style ${a.styleId}` }),
      mcp: (_r, a) => text(`deleted text style ${a.styleId}`),
    },
  },
  {
    name: "apply_text_style",
    cli: "apply-text-style",
    cliRoot: "flags",
    summary: "Apply a named text style to text elements (sets the style's defined props + links styleId).",
    params: { styleId: z.string(), ids: z.array(z.string()) },
    cliArgs: [
      { kind: "pos", at: 0, into: "styleId", required: true },
      { kind: "rest", at: 1, into: "ids", required: true },
    ],
    handler: (ctx, a) => core.applyTextStyle(ctx.root, sArr(a.ids), s(a.styleId)),
    render: {
      human: (r, a) => ({ err: `✓ applied ${a.styleId} to ${(r as { applied: number }).applied} text element(s)` }),
      mcp: (r, a) => text(`applied ${a.styleId} to ${(r as { applied: number }).applied} text element(s)`),
    },
  },
  {
    name: "toggle_text_style",
    cli: "toggle-text-style",
    cliRoot: "flags",
    summary:
      "Toggle bold/italic/underline across TEXT elements (Figma semantics: if every text already has it, turn it off everywhere; else on everywhere).",
    params: { ids: z.array(z.string()), which: z.enum(["bold", "italic", "underline"]) },
    cliArgs: [
      { kind: "pos", at: 0, into: "which", required: true },
      { kind: "rest", at: 1, into: "ids", required: true },
    ],
    handler: (ctx, a) => core.toggleTextStyle(ctx.root, sArr(a.ids), a.which as "bold" | "italic" | "underline"),
    render: {
      human: (_r, a) => ({ err: `✓ toggled ${a.which} on ${sArr(a.ids).length} element(s)` }),
      mcp: (_r, a) => text(`toggled ${a.which} on ${sArr(a.ids).length} element(s)`),
    },
  },
  {
    name: "set_guides",
    cli: "set-guides",
    cliRoot: "flags",
    summary:
      "Set a figure's ruler guides (figure-local guide lines that elements snap to). `x` = vertical guides at those x positions, `y` = horizontal guides. Either axis omitted clears it. Use to lay down a column grid / baseline set programmatically.",
    params: { figureId: z.string(), x: z.array(z.number()).optional(), y: z.array(z.number()).optional() },
    cliArgs: [
      { kind: "pos", at: 0, into: "figureId", required: true },
      { kind: "flag", at: "x", into: "x", as: "csvNum" },
      { kind: "flag", at: "y", into: "y", as: "csvNum" },
    ],
    handler: (ctx, a) => core.setGuides(ctx.root, s(a.figureId), { x: a.x as number[] | undefined, y: a.y as number[] | undefined }),
    render: {
      human: (_r, a) => ({
        err: `✓ set guides on ${a.figureId} (x:[${(a.x as number[] | undefined)?.join(",") ?? ""}] y:[${(a.y as number[] | undefined)?.join(",") ?? ""}])`,
      }),
      mcp: (_r, a) =>
        text(`set guides on ${a.figureId} (x:${(a.x as number[] | undefined)?.length ?? 0}, y:${(a.y as number[] | undefined)?.length ?? 0})`),
    },
  },
  {
    name: "set_figure_layout",
    cli: "set-figure-layout",
    cliRoot: "flags",
    summary: "Set a figure's frame: position (x,y), size (width,height), background color, and/or name. Only the fields you pass change.",
    params: {
      figureId: z.string(),
      x: z.number().optional(),
      y: z.number().optional(),
      width: z.number().optional(),
      height: z.number().optional(),
      background: z.string().optional(),
      name: z.string().optional(),
    },
    cliArgs: [
      { kind: "pos", at: 0, into: "figureId", required: true },
      { kind: "flag", at: "x", into: "x", as: "number" },
      { kind: "flag", at: "y", into: "y", as: "number" },
      { kind: "flag", at: "width", into: "width", as: "number" },
      { kind: "flag", at: "height", into: "height", as: "number" },
      { kind: "flag", at: "background", into: "background" },
      { kind: "flag", at: "name", into: "name" },
    ],
    handler: (ctx, a) =>
      core.setFigureLayout(ctx.root, s(a.figureId), pick(a, ["x", "y", "width", "height", "background", "name"]) as Parameters<typeof core.setFigureLayout>[2]),
    render: {
      human: (_r, a) => ({ err: `✓ set layout on ${a.figureId}` }),
      mcp: (_r, a) => text(`set layout on ${a.figureId}`),
    },
  },
  {
    name: "auto_label",
    cli: "auto-label",
    cliRoot: "flags",
    summary:
      "Auto-letter a figure's panel labels (a, b, c…) by reading order. Plot/image panels that have no label yet get one created first, so this works on any multi-panel figure (composed or imported+arranged).",
    params: { figureId: z.string() },
    cliArgs: [{ kind: "pos", at: 0, into: "figureId", required: true }],
    handler: (ctx, a) => core.autoLabel(ctx.root, s(a.figureId)),
    render: {
      human: (r, a) => {
        const { panels, changed, created } = r as { panels: string[]; changed: boolean; created?: number };
        const made = created ? ` (created ${created} missing label(s))` : "";
        if (!panels.length)
          return { err: `⚠ ${a.figureId} has no letterable panels (needs ≥2 plot/image panels, or add labels via add-fig-text --panel-label)` };
        if (!changed) return { err: `✓ ${a.figureId} already labeled: ${panels.join("")} (no change)` };
        return { err: `✓ labeled ${a.figureId}: ${panels.join("")}${made}` };
      },
      mcp: (r, a) => {
        const { panels, changed, created } = r as { panels: string[]; changed: boolean; created?: number };
        if (!panels.length) return text(`${a.figureId} has no letterable panels (needs ≥2 plot/image panels)`);
        const made = created ? ` (created ${created} missing label(s))` : "";
        return text(changed ? `labeled ${a.figureId}: ${panels.join("")}${made}` : `${a.figureId} already labeled: ${panels.join("")} (no change)`);
      },
    },
  },
  {
    name: "add_path",
    cli: "add-path",
    cliRoot: "flags",
    summary:
      "Add a vector path (bezier) to a figure from an editable node list — the same core the pen tool uses. Each node has element-local x/y and optional hIn/hOut handle offsets (present → cubic segment; absent → straight). `closed` joins the last node to the first. The node list is normalized and the bbox fitted automatically.",
    params: {
      figureId: z.string(),
      nodes: z.array(nodeZ),
      closed: z.boolean().optional(),
      fill: z.string().optional(),
      stroke: z.string().optional(),
      strokeWidth: z.number().optional(),
    },
    cliArgs: [
      { kind: "pos", at: 0, into: "figureId", required: true },
      { kind: "flag", at: "nodes", into: "nodes", as: "json", default: [] },
      { kind: "flag", at: "closed", into: "closed", as: "boolean" },
      { kind: "flag", at: "fill", into: "fill" },
      { kind: "flag", at: "stroke", into: "stroke" },
      { kind: "flag", at: "stroke-width", into: "strokeWidth", as: "number" },
    ],
    handler: (ctx, a) =>
      core.addPath(ctx.root, s(a.figureId), {
        nodes: a.nodes as Parameters<typeof core.addPath>[2]["nodes"],
        closed: a.closed as boolean | undefined,
        fill: a.fill as string | undefined,
        stroke: a.stroke as string | undefined,
        strokeWidth: a.strokeWidth as number | undefined,
      }),
    render: {
      human: (r, a) => ({ err: `✓ added path ${(r as { id: string }).id} (${(a.nodes as unknown[]).length} nodes) to ${a.figureId}` }),
      mcp: (r, a) => text(`added path ${(r as { id: string }).id} (${(a.nodes as unknown[]).length} nodes)`),
    },
  },
  {
    name: "edit_path",
    cli: "edit-path",
    cliRoot: "flags",
    summary:
      "Replace a path's nodes and/or closed flag (node editing). Adopts a legacy d-only path into nodes first, so any path stays editable. Regenerates the rendered `d` and bbox.",
    params: { id: z.string(), nodes: z.array(nodeZ).optional(), closed: z.boolean().optional() },
    cliArgs: [
      { kind: "pos", at: 0, into: "id", required: true },
      { kind: "flag", at: "nodes", into: "nodes", as: "json" },
      { kind: "flag", at: "closed", into: "closed", const: true },
      { kind: "flag", at: "open", into: "closed", const: false },
    ],
    handler: (ctx, a) =>
      core.editPath(ctx.root, s(a.id), {
        nodes: a.nodes as Parameters<typeof core.editPath>[2]["nodes"],
        closed: a.closed as boolean | undefined,
      }),
    render: {
      human: (r) => ({ err: `✓ edited path ${(r as { id: string }).id}` }),
      mcp: (_r, a) => text(`edited path ${a.id}`),
    },
  },

  // --- batch B: figure composition / import / sync ------------------------------
  {
    name: "compose_figure",
    cli: "compose-figure",
    cliRoot: "flags",
    summary:
      "Assemble multiple plots into ONE labeled multi-panel figure: imports each plot (semantic FluxPlot if a .fluxplot.json sidecar is present), grid-arranges them, auto-letters the panels (a, b, c…), and writes a caption stub. The flagship figure-building verb — e.g. turn 10 analysis plots into Figure 6.",
    params: {
      plotPaths: z.array(z.string()),
      id: z.string().optional(),
      name: z.string().optional(),
      // CLI superset: --canvas always reached core.composeFigure; the manual
      // MCP schema simply never exposed it (capability drift, WS-6.1 kind).
      canvasId: z.string().optional(),
      rows: z.number().optional(),
      cols: z.number().optional(),
      gap: z.number().optional(),
      label: z.boolean().optional(),
      captionStub: z.boolean().optional(),
    },
    cliArgs: [
      { kind: "rest", at: 0, into: "plotPaths", required: true },
      { kind: "flag", at: "id", into: "id" },
      { kind: "flag", at: "name", into: "name" },
      { kind: "flag", at: "canvas", into: "canvasId" },
      { kind: "flag", at: "rows", into: "rows", as: "number" },
      { kind: "flag", at: "cols", into: "cols", as: "number" },
      { kind: "flag", at: "gap", into: "gap", as: "number" },
      { kind: "flag", at: "no-label", into: "label", const: false },
      { kind: "flag", at: "no-caption", into: "captionStub", const: false },
    ],
    handler: (ctx, a) =>
      core.composeFigure(ctx.root, sArr(a.plotPaths), {
        id: a.id as string | undefined,
        name: a.name as string | undefined,
        canvasId: a.canvasId as string | undefined,
        rows: a.rows as number | undefined,
        cols: a.cols as number | undefined,
        gap: a.gap as number | undefined,
        label: a.label as boolean | undefined,
        captionStub: a.captionStub as boolean | undefined,
      }),
    render: {
      human: (r) => {
        const c = r as { figureId: string; panels: string[]; width: number; height: number; warnings: string[] };
        return {
          err:
            `✓ composed figure ${c.figureId} — ${c.panels.length} panel(s) [${c.panels.join("")}] ${c.width}×${c.height}` +
            c.warnings.map((w) => `\n⚠ ${w}`).join(""),
        };
      },
      mcp: (r) => {
        const c = r as { figureId: string; panels: string[]; width: number; height: number; warnings: string[] };
        return text(
          `composed figure ${c.figureId} — panels [${c.panels.join("")}] ${c.width}×${c.height}` +
            (c.warnings.length ? `\n⚠ ${c.warnings.join("\n⚠ ")}` : ""),
        );
      },
    },
  },
  {
    name: "create_figure",
    cli: "create-figure",
    cliRoot: "flags",
    summary: "Create a blank figure (optionally a clean slug id → @fig-<id>, name, canvas, size).",
    params: {
      id: z.string().optional(),
      name: z.string().optional(),
      canvasId: z.string().optional(),
      width: z.number().optional(),
      height: z.number().optional(),
    },
    cliArgs: [
      { kind: "flag", at: "id", into: "id" },
      { kind: "flag", at: "name", into: "name" },
      { kind: "flag", at: "canvas", into: "canvasId" },
      { kind: "flag", at: "width", into: "width", as: "number" },
      { kind: "flag", at: "height", into: "height", as: "number" },
    ],
    handler: (ctx, a) => core.createFigure(ctx.root, a as Parameters<typeof core.createFigure>[1]),
    render: {
      human: (r) => ({ err: `✓ created figure ${(r as { figureId: string }).figureId}` }),
      mcp: (r) => text(`created figure ${(r as { figureId: string }).figureId}`),
    },
  },
  {
    name: "import_plots",
    cli: "import-plots",
    cliRoot: "flags",
    summary:
      "Batch-import multiple SVG plots onto an EXISTING figure (the headless mirror of the GUI's Alt+I multi-insert): each plot resolves its FluxPlot sidecars (semantic when a .fluxplot.json sits next to it), lands at TRUE physical size, and the batch grid-packs into the figure's largest empty region (a single plot centers). Use compose_figure to build a NEW figure instead.",
    params: {
      id: z.string(),
      plotPaths: z.array(z.string()),
    },
    cliArgs: [
      { kind: "pos", at: 0, into: "id", required: true },
      // The legacy switch resolved each path against the shell cwd.
      { kind: "rest", at: 1, into: "plotPaths", as: "path", required: true },
    ],
    handler: (ctx, a) => core.importPlots(ctx.root, s(a.id), sArr(a.plotPaths)),
    render: {
      human: (r, a) => {
        const c = r as { panels: { elementId: string; assetId: string }[]; warnings: string[] };
        return {
          err: `✓ imported ${c.panels.length} plot(s) onto ${a.id}` + c.warnings.map((w) => `\n⚠ ${w}`).join(""),
          out: JSON.stringify(c.panels, null, 2),
        };
      },
      mcp: (r, a) => {
        const c = r as { panels: { elementId: string; assetId: string }[]; warnings: string[] };
        return text(
          `imported ${c.panels.length} plot(s) onto ${a.id}: ` +
            c.panels.map((p) => `${p.elementId} (asset ${p.assetId})`).join(", ") +
            (c.warnings.length ? `\n⚠ ${c.warnings.join("\n⚠ ")}` : ""),
        );
      },
    },
  },
  {
    name: "add_panel",
    cli: "add-panel",
    summary: "Import an SVG file as an image panel on a figure.",
    params: {
      id: z.string(),
      svgPath: z.string(),
      x: z.number().optional(),
      y: z.number().optional(),
      width: z.number().optional(),
      height: z.number().optional(),
    },
    cliArgs: [
      { kind: "pos", at: 0, into: "id", required: true },
      { kind: "pos", at: 1, into: "svgPath", required: true },
      { kind: "flag", at: "x", into: "x", as: "number" },
      { kind: "flag", at: "y", into: "y", as: "number" },
      { kind: "flag", at: "width", into: "width", as: "number" },
      { kind: "flag", at: "height", into: "height", as: "number" },
    ],
    handler: (ctx, a) =>
      core.addPanel(ctx.root, s(a.id), s(a.svgPath), {
        x: a.x as number | undefined,
        y: a.y as number | undefined,
        width: a.width as number | undefined,
        height: a.height as number | undefined,
      }),
    render: {
      human: (r) => {
        const c = r as { elementId: string; assetId: string; warning?: string };
        return { err: `✓ added panel ${c.elementId} (asset ${c.assetId})` + (c.warning ? `\n⚠ ${c.warning}` : "") };
      },
      mcp: (r) => {
        const c = r as { elementId: string; assetId: string; warning?: string };
        return text(`added panel ${c.elementId} (asset ${c.assetId})` + (c.warning ? `\n⚠ ${c.warning}` : ""));
      },
    },
  },
  {
    name: "sync_figure",
    cli: "sync-figure",
    cliRoot: "flags",
    summary:
      "Refresh a figure's (or all figures') fig/assets plot copies from their regenerated plots/ sources IN PLACE — the regenerate loop without delete+recompose; captions, positions and per-part restyles survive. A changed intrinsic plot size resizes its element (physical-size-true) and grows the figure frame when needed (re-pack with arrange if the grid should reflow).",
    params: { figureId: z.string().optional() },
    cliArgs: [{ kind: "pos", at: 0, into: "figureId" }],
    handler: (ctx, a) => core.syncFigureAssets(ctx.root, a.figureId as string | undefined),
    render: {
      human: (r) => {
        const c = r as Awaited<ReturnType<typeof core.syncFigureAssets>>;
        const lines: string[] = [];
        if (c.refreshed.length)
          lines.push(`✓ refreshed ${c.refreshed.length}/${c.checked} panel asset(s): ${c.refreshed.map((x) => x.from).join(", ")}`);
        else lines.push(`✓ all ${c.checked} panel asset(s) already match plots/ (no change)`);
        for (const rs of c.resized)
          lines.push(
            `  ↔ ${rs.elementIds.join(", ")}: intrinsic size ${Math.round(rs.from.w)}×${Math.round(rs.from.h)} → ${Math.round(rs.to.w)}×${Math.round(rs.to.h)} (element resized to match)`,
          );
        for (const fr of c.framed)
          lines.push(`  ⤢ ${fr.figId}: frame ${fr.from.width}×${fr.from.height} → ${fr.to.width}×${fr.to.height} (grown to fit resized panels)`);
        if (c.resized.length) lines.push(`  (layout may need a re-pack: flux arrange <figId> --cols N)`);
        if (c.missing.length) lines.push(`⚠ missing source plot(s): ${c.missing.join(", ")}`);
        for (const w of c.warnings) lines.push(`⚠ ${w}`);
        return { err: lines.join("\n") };
      },
      mcp: (r) => {
        const c = r as Awaited<ReturnType<typeof core.syncFigureAssets>>;
        const head = c.refreshed.length
          ? `refreshed ${c.refreshed.length}/${c.checked} panel asset(s): ${c.refreshed.map((x) => x.from).join(", ")}`
          : `all ${c.checked} panel asset(s) already match plots/ (no change)`;
        const parts = [head];
        for (const rs of c.resized)
          parts.push(
            `${rs.elementIds.join(", ")}: intrinsic ${Math.round(rs.from.w)}×${Math.round(rs.from.h)} → ${Math.round(rs.to.w)}×${Math.round(rs.to.h)} (element resized; re-pack with arrange if needed)`,
          );
        for (const fr of c.framed) parts.push(`${fr.figId}: frame grown ${fr.from.width}×${fr.from.height} → ${fr.to.width}×${fr.to.height}`);
        if (c.missing.length) parts.push(`missing source plot(s): ${c.missing.join(", ")}`);
        parts.push(...c.warnings);
        return text(parts.join(" — "));
      },
    },
  },

  // --- batch C: manuscript / library / comments / references --------------------
  {
    name: "get_manuscript",
    cli: "manuscript",
    cliRoot: "flags",
    summary: "Read a manuscript document's text (.qmd). Omit doc for the main manuscript.",
    params: { doc: z.string().optional() },
    cliArgs: [{ kind: "flag", at: "doc", into: "doc" }],
    handler: (ctx, a) => core.getManuscript(ctx.root, a.doc as string | undefined),
    render: {
      // Byte-exact stdout (the legacy case used process.stdout.write).
      human: (r) => ({ outRaw: r as string }),
      mcp: (r) => text(r as string),
    },
  },
  {
    name: "set_manuscript",
    cli: "set-manuscript",
    cliRoot: "flags",
    summary: "Overwrite a manuscript document's full text (.qmd). Omit doc for the main manuscript.",
    params: { text: z.string(), doc: z.string().optional() },
    cliArgs: [
      { kind: "rest", at: 0, into: "text", as: "joined", default: "" },
      { kind: "flag", at: "file", into: "text", as: "fileText" },
      { kind: "flag", at: "doc", into: "doc" },
    ],
    handler: (ctx, a) => core.setManuscript(ctx.root, s(a.text), a.doc as string | undefined),
    render: {
      human: () => ({ err: "✓ manuscript written" }),
      mcp: () => text("manuscript written"),
    },
  },
  {
    name: "list_documents",
    cli: "docs",
    cliRoot: "flags",
    summary: "List the project's documents (main + supplementary + scanned manuscript/**.qmd).",
    params: {},
    cliArgs: [],
    handler: (ctx) => core.listDocuments(ctx.root),
    render: {
      human: (r) => ({ out: JSON.stringify(r, null, 2) }),
    },
  },
  {
    name: "create_document",
    cli: "new-doc",
    cliRoot: "flags",
    summary: "Create a new blank document (registered in the manifest).",
    params: { name: z.string() },
    cliArgs: [{ kind: "rest", at: 0, into: "name", as: "joined", default: "Untitled" }],
    handler: (ctx, a) => core.createDocument(ctx.root, s(a.name)),
    render: {
      human: (r) => ({ err: `✓ created ${(r as { path: string }).path}` }),
      mcp: (r) => text(`created ${(r as { path: string }).path}`),
    },
  },
  {
    name: "insert_figure_ref",
    cli: "ref",
    cliRoot: "flags",
    summary: "Append a figure cross-reference (@fig-<label>) to a document.",
    params: { figureId: z.string(), doc: z.string().optional() },
    cliArgs: [
      { kind: "pos", at: 0, into: "figureId", required: true },
      { kind: "flag", at: "doc", into: "doc" },
    ],
    handler: (ctx, a) => core.insertFigureRef(ctx.root, s(a.figureId), a.doc as string | undefined),
    render: {
      human: (r) => ({ err: `✓ inserted ${(r as { ref: string }).ref}` }),
      mcp: (r) => text(`inserted ${(r as { ref: string }).ref}`),
    },
  },
  {
    name: "cite_doi",
    cli: "cite-doi",
    cliRoot: "flags",
    summary:
      "Fetch a DOI's BibTeX (content negotiation), add it to FluxLib (deterministic citekey, deduped by DOI), and cite it in this project (materialized into references/library.bib). Returns the citekey(s) to use as @key.",
    params: { doi: z.string() },
    cliArgs: [{ kind: "pos", at: 0, into: "doi", required: true }],
    handler: (ctx, a) => core.citeDoi(ctx.root, s(a.doi)),
    render: {
      // The fetched author/title/year print IN FULL: registries serve junk
      // metadata on automated deposits ("Robot, Open Data" etc.) and a 60-char
      // bibtex slice hid it — the manuscript then cites garbage verbatim.
      human: (r) => {
        const c = r as { keys: string[]; summary: string };
        return {
          err: `✓ cited [@${c.keys.join("; @")}]\n  ${c.summary}\n  (registry metadata — if it looks wrong, fix references/library.bib and keep the citekey)`,
        };
      },
      mcp: (r) => {
        const c = r as { keys: string[]; summary: string };
        return text(`cited @${c.keys.join("; @")} — ${c.summary} (registry metadata; if wrong, fix references/library.bib, keep the citekey)`);
      },
    },
  },
  {
    name: "add_reference",
    cli: "add-reference",
    aliases: ["cite"],
    summary:
      "Add a BibTeX entry to the machine-global FluxLib (deduped by DOI) AND cite it in this project (materialized into references/library.bib).",
    params: { bibtex: z.string() },
    cliArgs: [
      { kind: "rest", at: 0, into: "bibtex", as: "joined", default: "" },
      { kind: "flag", at: "file", into: "bibtex", as: "fileText" },
    ],
    handler: (ctx, a) => core.addReference(ctx.root, s(a.bibtex)),
    render: {
      human: () => ({ err: "✓ reference added" }),
      mcp: () => text("reference added (FluxLib + project)"),
    },
  },
  {
    name: "search_references",
    cli: "search",
    cliRoot: "flags",
    summary:
      "Search the machine-global FluxLib reference library with a structured query, e.g. 'author:smith year:2020 journal:nature' (fields: author, year, journal, title, doi; bare words match any). Returns matching entries — cite one via its `key` as @key. Each hit also carries `enrich` (abstract, topics, keywords, citedByCount, openalexId) when the entry has been hydrated (see hydrate_library).",
    params: { query: z.string() },
    cliArgs: [{ kind: "rest", at: 0, into: "query", as: "joined", default: "" }],
    // ONE core call now (the enriched search) — the CLI previously printed the
    // un-enriched entries; hits gain the `enrich` sidecar both surfaces showed
    // in the MCP path (capability drift closed toward the superset).
    handler: (_ctx, a) => core.searchReferencesEnriched(s(a.query)),
    render: {
      human: (r) => ({
        out: JSON.stringify(r, null, 2),
        err: `✓ ${(r as unknown[]).length} match(es) in FluxLib`,
      }),
      mcp: (r) => text(JSON.stringify(r, null, 2)),
    },
  },
  {
    name: "reconcile",
    cli: "reconcile",
    cliRoot: "flags",
    summary:
      "Reconcile the project's cited references against the machine-global FluxLib: re-materialize references/library.bib from cited keys, promote any project-only entries into FluxLib, and report orphaned citekeys (cited but not found). Run after editing citations by hand.",
    params: {},
    cliArgs: [],
    handler: (ctx) => core.reconcile(ctx.root),
    render: {
      human: (r) => {
        const c = r as { materialized: unknown[]; promoted: unknown[]; orphans: string[] };
        return {
          err:
            `✓ reconcile: materialized ${c.materialized.length}, promoted ${c.promoted.length}, orphans ${c.orphans.length}` +
            (c.orphans.length ? `\n  orphans (cited, not in FluxLib): ${c.orphans.join(", ")}` : ""),
        };
      },
      mcp: (r) => {
        const c = r as { materialized: unknown[]; promoted: unknown[]; orphans: string[] };
        return text(
          `reconciled: ${c.materialized.length} materialized, ${c.promoted.length} promoted to FluxLib` +
            (c.orphans.length ? `, ${c.orphans.length} orphan(s): ${c.orphans.join(", ")}` : ""),
        );
      },
    },
  },
  {
    name: "normalize_embeds",
    cli: "normalize-embeds",
    cliRoot: "flags",
    summary:
      "Clear legacy alt-text captions from manuscript embed lines (canonical embeds are ![](…){#fig-id} — the figure model owns captions; Quarto exports get them injected at render time).",
    params: {},
    cliArgs: [],
    handler: (ctx) => core.normalizeEmbeds(ctx.root),
    render: {
      human: (r) => {
        const files = (r as { files: { path: string; cleared: number }[] }).files;
        if (!files.length) return { err: "✓ all embed lines already canonical (empty alts)" };
        return { err: files.map((f) => `✓ ${f.path}: cleared ${f.cleared} embed alt(s)`).join("\n") };
      },
      mcp: (r) => {
        const files = (r as { files: { path: string; cleared: number }[] }).files;
        if (!files.length) return text("all embed lines already canonical (empty alts)");
        return text(files.map((f) => `${f.path}: cleared ${f.cleared} embed alt(s)`).join("\n"));
      },
    },
  },
  {
    name: "hydrate_library",
    cli: "hydrate",
    cliRoot: "flags",
    summary:
      "Enrich the machine-global FluxLib from OpenAlex — abstracts, topics/keywords, citation counts, referenced/related works, open-access, author + external IDs — into a derived sidecar (the canonical .bib is untouched). Incremental by default (skips already-hydrated entries); refresh re-fetches all; key limits to one citekey. Powers richer search_references + the world lookups. No API key needed.",
    params: { refresh: z.boolean().optional(), key: z.string().optional() },
    cliArgs: [
      { kind: "flag", at: "refresh", into: "refresh", as: "boolean" },
      { kind: "flag", at: "key", into: "key" },
    ],
    handler: (_ctx, a) => core.hydrateLibrary({ refresh: a.refresh as boolean | undefined, key: a.key as string | undefined }),
    render: {
      human: (r) => {
        const c = r as Awaited<ReturnType<typeof core.hydrateLibrary>>;
        return {
          err:
            `✓ hydrated ${c.fetched} (+${c.crossrefBackfill} CrossRef abstracts); ${c.hydrated}/${c.total} entries enriched, ${c.withAbstract} with abstracts` +
            (c.missing.length ? `\n  no OpenAlex match: ${c.missing.join(", ")}` : ""),
        };
      },
      mcp: (r) => {
        const c = r as Awaited<ReturnType<typeof core.hydrateLibrary>>;
        return text(
          `hydrated ${c.fetched} (+${c.crossrefBackfill} CrossRef abstracts); ${c.hydrated}/${c.total} entries enriched, ${c.withAbstract} with abstracts` +
            (c.missing.length ? `; no OpenAlex match for: ${c.missing.join(", ")}` : ""),
        );
      },
    },
  },
  {
    name: "zotero_sync",
    cli: "zotero-sync",
    cliRoot: "flags",
    summary:
      "Pull new references (and their PDFs) from the connected Zotero Better-BibTeX 'Keep updated' auto-export into the machine-global FluxLib. Idempotent + additive: known entries dedupe by DOI/title-signature, PDFs attach for new entries and backfill PDF-less known ones; nothing is written back to Zotero. Uses the machine `zotero` settings (connect in the app: Library → Zotero) unless overridden with bib/dataDir/attach; `save` persists the overrides as the machine settings.",
    params: {
      bib: z.string().optional(),
      dataDir: z.string().optional(),
      attach: z.enum(["copy", "link"]).optional(),
      deferFulltext: z.boolean().optional(),
      save: z.boolean().optional(),
    },
    cliArgs: [
      { kind: "flag", at: "bib", into: "bib" },
      { kind: "flag", at: "data-dir", into: "dataDir" },
      { kind: "flag", at: "attach", into: "attach" },
      { kind: "flag", at: "defer-fulltext", into: "deferFulltext", as: "boolean" },
      { kind: "flag", at: "save", into: "save", as: "boolean" },
    ],
    handler: (_ctx, a) =>
      core.zoteroSync({
        bib: a.bib as string | undefined,
        dataDir: a.dataDir as string | undefined,
        attach: a.attach as "copy" | "link" | undefined,
        deferFulltext: a.deferFulltext as boolean | undefined,
        save: a.save as boolean | undefined,
      }),
    render: {
      human: (r) => {
        const c = r as Awaited<ReturnType<typeof core.zoteroSync>>;
        return {
          err:
            `✓ Zotero sync — ${c.line}\n  ${c.settings.bibPath}` +
            (c.report.attachFailed.length
              ? `\n  not found: ${c.report.attachFailed.map((f) => `${f.key} (${f.path})`).join(", ")}`
              : ""),
        };
      },
      mcp: (r) => {
        const c = r as Awaited<ReturnType<typeof core.zoteroSync>>;
        return text(
          `Zotero sync: ${c.line} (bib: ${c.settings.bibPath})` +
            (c.report.added.length ? `; added: ${c.report.added.join(", ")}` : "") +
            (c.report.attachFailed.length ? `; PDFs not found for: ${c.report.attachFailed.map((f) => f.key).join(", ")}` : ""),
        );
      },
    },
  },
  {
    name: "author_works",
    cli: "by-author",
    cliRoot: "flags",
    summary:
      "Other works by an author (OpenAlex), sorted by citation count. `ref` = a FluxLib citekey (uses its first author; must be hydrated) or an OpenAlex author id (A…). Returns brief records.",
    params: { ref: z.string(), perPage: z.number().optional() },
    cliArgs: [{ kind: "pos", at: 0, into: "ref", required: true }],
    handler: (_ctx, a) => core.authorWorks(s(a.ref), { perPage: a.perPage as number | undefined }),
    render: {
      human: (r) => ({ out: JSON.stringify(r, null, 2), err: `✓ ${(r as unknown[]).length} work(s) by author` }),
      mcp: (r) => text(JSON.stringify(r, null, 2)),
    },
  },
  {
    name: "related_works",
    cli: "related",
    cliRoot: "flags",
    summary:
      "Related papers via OpenAlex's precomputed similarity (the closest 'papers like this' without local embeddings). `ref` = a FluxLib citekey (must be hydrated) or an OpenAlex work id (W…).",
    params: { ref: z.string() },
    cliArgs: [{ kind: "pos", at: 0, into: "ref", required: true }],
    handler: (_ctx, a) => core.relatedWorks(s(a.ref)),
    render: {
      human: (r) => ({ out: JSON.stringify(r, null, 2), err: `✓ ${(r as unknown[]).length} related work(s)` }),
      mcp: (r) => text(JSON.stringify(r, null, 2)),
    },
  },
  {
    name: "list_comments",
    cli: "comments",
    cliRoot: "flags",
    summary:
      "List review comments (the human's margin comments) across every project document by default; pass doc to target one document. Open threads by default. Every thread includes its document path, and anchor.quote is the EXACT targeted text — address it, then call resolve_comment.",
    params: { doc: z.string().optional(), includeResolved: z.boolean().optional() },
    cliArgs: [
      { kind: "flag", at: "doc", into: "doc" },
      { kind: "flag", at: "all", into: "includeResolved", as: "boolean" },
    ],
    handler: async (ctx, a) => {
      const threads = await core.listProjectComments(ctx.root, a.doc as string | undefined);
      return a.includeResolved ? threads : threads.filter((t) => !t.resolved);
    },
    render: {
      // The CLI has always printed a REDUCED shape (id/resolved/quote/messages);
      // MCP returns the full threads.
      human: (r) => ({
        out: JSON.stringify(
          (r as { id: string; doc: string; resolved?: boolean; anchor?: { quote?: string }; messages: unknown }[]).map((t) => ({
            id: t.id,
            doc: t.doc,
            resolved: t.resolved,
            quote: t.anchor?.quote ?? "",
            messages: t.messages,
          })),
          null,
          2,
        ),
      }),
      mcp: (r) => text(JSON.stringify(r, null, 2)),
    },
  },
  {
    name: "resolve_comment",
    cli: "resolve-comment",
    cliRoot: "flags",
    summary:
      "Mark a review comment resolved — by thread id, or a substring of its quoted text. Searches every project document by default and requires a unique open match; pass doc to target one document. Optionally appends a reply note. Call this AFTER addressing the comment.",
    params: { id: z.string(), doc: z.string().optional(), note: z.string().optional() },
    cliArgs: [
      { kind: "pos", at: 0, into: "id", required: true },
      { kind: "flag", at: "doc", into: "doc" },
      { kind: "flag", at: "note", into: "note" },
    ],
    handler: (ctx, a) =>
      core.resolveProjectComment(ctx.root, s(a.id), {
        docRel: a.doc as string | undefined,
        note: a.note as string | undefined,
      }),
    render: {
      human: (r) => {
        const c = r as { id: string; resolved: number; total: number };
        return { err: `✓ resolved ${c.id} (${c.resolved}/${c.total} resolved)` };
      },
      mcp: (r) => {
        const c = r as { id: string; resolved: number; total: number };
        return text(`resolved ${c.id} (${c.resolved}/${c.total} resolved)`);
      },
    },
  },
  {
    name: "add_comment",
    cli: "add-comment",
    cliRoot: "flags",
    summary:
      "Open a NEW review-comment thread anchored to exact document text — your channel for asking the human a question in the margin (they see it live in the open app). quote must occur in the document; if it occurs more than once pass at (1-based occurrence). Omit doc for the main manuscript. Holds the manuscript lock + journals.",
    params: {
      quote: z.string(),
      body: z.string(),
      doc: z.string().optional(),
      at: z.number().optional(),
    },
    cliArgs: [
      { kind: "flag", at: "quote", into: "quote", required: true },
      { kind: "flag", at: "body", into: "body", required: true },
      { kind: "flag", at: "doc", into: "doc" },
      { kind: "flag", at: "at", into: "at", as: "number" },
    ],
    handler: (ctx, a) =>
      core.addComment(ctx.root, {
        quote: s(a.quote),
        body: s(a.body),
        docRel: a.doc as string | undefined,
        at: a.at as number | undefined,
      }),
    render: {
      human: (r) => {
        const c = r as { id: string; doc: string; total: number };
        return { err: `✓ comment ${c.id} added on ${c.doc} (${c.total} threads)` };
      },
      mcp: (r) => {
        const c = r as { id: string; doc: string; total: number };
        return text(`added comment ${c.id} on ${c.doc} (${c.total} threads)`);
      },
    },
  },
  {
    name: "list_feedback",
    cli: "feedback",
    cliRoot: "flags",
    summary:
      "List the user's feedback notes from the app (.meta/feedback.ndjson). Each note carries a context STAMP of what the user had selected when writing it (figure/element/plot part, document + quoted text, slide + beat) — 'make this bigger' arrives with 'this' resolved. Open notes by default (--all includes resolved); also reports the last send (review-pass request). Address each note, then resolve_feedback.",
    params: { all: z.boolean().optional() },
    cliArgs: [{ kind: "flag", at: "all", into: "all", as: "boolean" }],
    handler: (ctx, a) => core.listFeedback(ctx.root, { all: a.all as boolean | undefined }),
    render: {
      human: (r) => ({ out: JSON.stringify(r, null, 2) }),
      mcp: (r) => text(JSON.stringify(r, null, 2)),
    },
  },
  {
    name: "resolve_feedback",
    cli: "resolve-feedback",
    cliRoot: "flags",
    summary:
      "Mark a feedback note resolved — by id, or a unique substring of its text — with a note on what you did (the user sees it in the app). Call AFTER actually addressing the item. Appends to the ledger (never rewrites) + journals.",
    params: { id: z.string(), note: z.string().optional() },
    cliArgs: [
      { kind: "pos", at: 0, into: "id", required: true },
      { kind: "flag", at: "note", into: "note" },
    ],
    handler: (ctx, a) => core.resolveFeedback(ctx.root, s(a.id), { note: a.note as string | undefined }),
    render: {
      human: (r) => {
        const c = r as { id: string; open: number };
        return { err: `✓ resolved ${c.id} (${c.open} still open)` };
      },
      mcp: (r) => {
        const c = r as { id: string; open: number };
        return text(`resolved ${c.id} (${c.open} still open)`);
      },
    },
  },
  {
    name: "send_feedback",
    cli: "send",
    cliRoot: "flags",
    summary:
      "Mark a review-pass boundary in the feedback ledger: everything open is now a work order (the attend watcher wakes the principal on this). Humans trigger this from the app; agents rarely need it.",
    params: { note: z.string().optional() },
    cliArgs: [{ kind: "flag", at: "note", into: "note" }],
    handler: (ctx, a) => core.sendFeedback(ctx.root, { note: a.note as string | undefined }),
    render: {
      human: (r) => {
        const c = r as { open: number };
        return { err: `✓ sent — ${c.open} open note(s) now a work order` };
      },
      mcp: (r) => {
        const c = r as { open: number };
        return text(`sent (${c.open} open notes)`);
      },
    },
  },
  {
    name: "list_agents",
    cli: "agents",
    summary:
      "Show the machine's agent roster (<FluxConfig>/agents.json): the FAMILIES (per-vendor command templates with their model/effort menus) and the standing defaults for principal/worker/pass — worker values of 'principal-decides' mean dispatch requires --model/--effort. Edit that file to change agents — see FluxContext/AGENTS-CONFIG.md.",
    params: {},
    cliArgs: [],
    handler: () => core.readRoster(),
    render: {
      human: (r) => ({ out: JSON.stringify(r, null, 2) }),
      mcp: (r) => text(JSON.stringify(r, null, 2)),
    },
  },
  {
    name: "dispatch",
    cli: "dispatch",
    cliRoot: "flags",
    summary:
      "Dispatch a WORKER agent with a brief, and wait for it. <name> labels the dispatch; the worker's model/effort resolve from --family/--model/--effort → the session's worker policy (FLUX_WORKER_POLICY, set at principal launch) → the roster defaults — a standing 'principal-decides' policy means YOU pass --model/--effort per task (match effort to difficulty). The brief is the worker's whole contract — write it complete (goal + why, exact paths, environment, conventions, what done looks like, what to report). Recorded under Context/Dispatches/<stamp>-<name>/ (brief.md, log.txt, result.md + the agent used); returns the report tail. Prefer --brief-file (briefs are reviewable craft).",
    params: {
      role: z.string(),
      brief: z.string().optional(),
      briefFile: z.string().optional(),
      name: z.string().optional(),
      family: z.string().optional(),
      model: z.string().optional(),
      effort: z.string().optional(),
    },
    cliArgs: [
      { kind: "pos", at: 0, into: "role", required: true },
      { kind: "flag", at: "brief", into: "brief" },
      { kind: "flag", at: "brief-file", into: "briefFile" },
      { kind: "flag", at: "name", into: "name" },
      { kind: "flag", at: "family", into: "family" },
      { kind: "flag", at: "model", into: "model" },
      { kind: "flag", at: "effort", into: "effort" },
    ],
    handler: (ctx, a) =>
      core.dispatch(ctx.root, {
        role: s(a.role),
        brief: a.brief as string | undefined,
        briefFile: a.briefFile as string | undefined,
        name: a.name as string | undefined,
        family: a.family as string | undefined,
        model: a.model as string | undefined,
        effort: a.effort as string | undefined,
      }),
    render: {
      human: (r) => {
        const d = r as { dir: string; exitCode: number; ms: number; report: string; agent: string };
        return {
          out: JSON.stringify({ dir: d.dir, agent: d.agent, exitCode: d.exitCode, seconds: +(d.ms / 1000).toFixed(1), report: d.report }, null, 2),
          exit: d.exitCode === 0 ? 0 : 1,
        };
      },
      mcp: (r) => {
        const d = r as { dir: string; exitCode: number; report: string; agent: string };
        return text(`dispatch (${d.agent}) ${d.exitCode === 0 ? "succeeded" : `FAILED (exit ${d.exitCode})`} — record: ${d.dir}\n\n${d.report}`);
      },
    },
  },
  {
    name: "ensure_context",
    cli: "context-init",
    summary:
      "Ensure this project has its Context/ layer (Project/MISSION.qmd, NOTEBOOK.md, RULES.md, Transcripts/, Dispatches/) — heals projects created before the principal-agent scheme. Additive and existence-guarded; safe to run any time.",
    params: {},
    cliArgs: [],
    handler: (ctx) => core.ensureProjectContext(ctx.root),
    render: {
      human: (r) => {
        const c = r as { created: string[] };
        return { err: c.created.length ? `✓ created: ${c.created.join(", ")}` : "✓ Context layer already complete" };
      },
      mcp: (r) => {
        const c = r as { created: string[] };
        return text(c.created.length ? `created: ${c.created.join(", ")}` : "Context layer already complete");
      },
    },
  },
  {
    name: "add_annotation",
    cli: "add-annotation",
    cliRoot: "flags",
    summary:
      "Add a highlight/note to a FluxLib paper (items/<citekey>/annotations.json) — the same annotations FluxReader shows the human. `quote` is the exact text to highlight; `prefix`/`suffix` are the surrounding text that disambiguates it on the page (find them in get_paper_text). `page` is 1-based.",
    params: {
      key: z.string(),
      page: z.number(),
      quote: z.string(),
      prefix: z.string().optional(),
      suffix: z.string().optional(),
      color: z.enum(["yellow", "green", "blue", "pink", "orange"]).optional(),
      note: z.string().optional(),
      tags: z.array(z.string()).optional(),
    },
    cliArgs: [
      { kind: "pos", at: 0, into: "key" },
      { kind: "flag", at: "key", into: "key" },
      { kind: "flag", at: "page", into: "page", as: "number", default: 1 },
      { kind: "flag", at: "quote", into: "quote", as: "string", required: true },
      { kind: "flag", at: "prefix", into: "prefix", as: "string" },
      { kind: "flag", at: "suffix", into: "suffix", as: "string" },
      { kind: "flag", at: "color", into: "color" },
      { kind: "flag", at: "note", into: "note" },
    ],
    handler: (_ctx, a) =>
      core.addAnnotation(s(a.key), {
        page: n(a.page),
        anchor: { quote: s(a.quote), prefix: (a.prefix as string | undefined) ?? "", suffix: (a.suffix as string | undefined) ?? "" },
        color: ((a.color as string | undefined) ?? "yellow") as Parameters<typeof core.addAnnotation>[1]["color"],
        note: a.note as string | undefined,
        tags: a.tags as string[] | undefined,
      }),
    render: {
      human: (r, a) => {
        const c = r as { id: string; page: number; color: string };
        return { err: `✓ annotated @${a.key} p${c.page} [${c.color}] (${c.id})` };
      },
      mcp: (r, a) => {
        const c = r as { id: string; color: string };
        return text(`added annotation ${c.id} on @${a.key} p${a.page} [${c.color}]`);
      },
    },
  },
  {
    name: "ingest_pdf",
    cli: "ingest-pdf",
    cliRoot: "flags",
    summary:
      "Store a PDF you already have on disk into FluxLib for a citekey (items/<citekey>/paper.pdf) and extract its fulltext — the manual fallback when fetch_pdfs can't find an open-access copy (paywalled/proxy-only papers). `key` is the citekey; `filePath` is an absolute path to the .pdf.",
    params: { key: z.string(), filePath: z.string() },
    cliArgs: [
      { kind: "pos", at: 0, into: "filePath", required: true },
      { kind: "flag", at: "key", into: "key", required: true },
    ],
    handler: (_ctx, a) => core.ingestPdf(s(a.filePath), { key: s(a.key) }),
    render: {
      human: (r, a) => ({ err: `✓ ingested ${a.filePath} → items/${(r as { key: string }).key}/paper.pdf` }),
      mcp: (r, a) => text(`ingested ${a.filePath} → @${a.key} (${(r as { status: string }).status})`),
    },
  },

  // --- batch D: the irregular exit-code verbs -----------------------------------
  // A failed external tool must be UNMISSABLE on both surfaces (WS-6.1): the CLI
  // exits with the tool's own exit code, MCP returns isError. The handlers do NOT
  // throw — each surface's exact strings differ (the CLI prints the FULL log,
  // MCP tails 2000 chars), so the renders own the mapping.
  {
    name: "compile",
    cli: "compile",
    cliRoot: "flags",
    summary:
      "Compile the manuscript via Quarto (pdf|html|docx). Requires quarto on PATH. Reports the output path and a figures/citations resolution summary.",
    params: { to: z.string().optional() },
    cliArgs: [{ kind: "flag", at: "to", into: "to" }],
    handler: (ctx, a) => core.compile(ctx.root, (a.to as string | undefined) ?? "pdf"),
    render: {
      human: (r) => {
        const c = r as Awaited<ReturnType<typeof core.compile>>;
        if (c.code !== 0) return { err: `✗ quarto exited ${c.code}\n${c.log}`, exit: c.code };
        const lines = [`✓ compiled${c.output ? ` → ${c.output}` : ` (quarto exited 0)`}`];
        if (c.figures)
          lines.push(
            `  figures: ${c.figures.resolved}/${c.figures.embedded} embedded figure(s) resolved` +
              (c.figures.missing.length ? ` — no project figure for: ${c.figures.missing.join(", ")}` : ""),
          );
        if (c.citations)
          lines.push(
            `  citations: ${c.citations.resolved}/${c.citations.keys} key(s) resolved in the project library` +
              (c.citations.missing.length ? ` — unresolved: @${c.citations.missing.join(", @")}` : ""),
          );
        return { err: lines.join("\n") };
      },
      mcp: (r) => {
        const c = r as Awaited<ReturnType<typeof core.compile>>;
        if (c.code !== 0)
          return { isError: true, content: [{ type: "text", text: `quarto exited ${c.code}\n${c.log.slice(-2000)}` }] };
        const parts = [`compiled${c.output ? ` → ${c.output}` : " (quarto exited 0)"}`];
        if (c.figures)
          parts.push(
            `figures: ${c.figures.resolved}/${c.figures.embedded} resolved` +
              (c.figures.missing.length ? ` (no project figure for: ${c.figures.missing.join(", ")})` : ""),
          );
        if (c.citations)
          parts.push(
            `citations: ${c.citations.resolved}/${c.citations.keys} resolved` +
              (c.citations.missing.length ? ` (unresolved: @${c.citations.missing.join(", @")})` : ""),
          );
        return text(parts.join(" — "));
      },
    },
  },
  {
    name: "validate_project",
    cli: "validate",
    cliRoot: "flags",
    summary:
      "Validate the project (or one file) against the bundled JSON Schemas (.meta/schema/), plus project lint: EMPTY figures (they shift figure numbers), figures embedded in no document, and overlapping canvas frames. Use after editing files directly to confirm your writes are well-formed.",
    params: { file: z.string().optional() },
    cliArgs: [{ kind: "pos", at: 0, into: "file" }],
    handler: (ctx, a) => core.validate(ctx.root, a.file as string | undefined),
    render: {
      human: (r) => {
        const c = r as { ok: boolean; checked: number; errors: string[]; warnings?: string[] };
        const lines = (c.warnings ?? []).map((w) => `⚠ ${w}`);
        if (c.ok) {
          lines.push(`✓ valid (${c.checked} file(s) checked${c.warnings?.length ? `, ${c.warnings.length} warning(s)` : ""})`);
          return { err: lines.join("\n") };
        }
        lines.push(`✗ ${c.errors.length} schema problem(s):`, ...c.errors.map((e) => "  " + e));
        return { err: lines.join("\n"), exit: 1 };
      },
      mcp: (r) => {
        const c = r as { ok: boolean; checked: number; errors: string[]; warnings?: string[] };
        const warn = c.warnings?.length ? `\nwarnings:\n` + c.warnings.map((w) => `  ${w}`).join("\n") : "";
        return text(c.ok ? `valid (${c.checked} file(s) checked)${warn}` : `INVALID (${c.errors.length}):\n` + c.errors.join("\n") + warn);
      },
    },
  },
  {
    name: "validate_plot",
    cli: "validate-plot",
    cliRoot: "flags",
    summary:
      "Validate a FluxPlot output: the .fluxplot.json manifest is schema-valid AND every id it references exists in the .svg (so the plot is genuinely part-addressable/restylable).",
    params: { svgPath: z.string() },
    cliArgs: [{ kind: "pos", at: 0, into: "svgPath", as: "path", required: true }],
    handler: (_ctx, a) => core.validatePlot(s(a.svgPath)),
    render: {
      human: (r) => {
        const c = r as { ok: boolean; matched: number; references: number; errors: string[] };
        if (c.ok) return { err: `✓ valid FluxPlot (${c.matched}/${c.references} ids matched)` };
        return { err: `✗ ${c.errors.length} problem(s):\n` + c.errors.map((e) => "  " + e).join("\n"), exit: 1 };
      },
      mcp: (r) => {
        const c = r as { ok: boolean; matched: number; references: number; errors: string[] };
        return text(c.ok ? `valid FluxPlot (${c.matched}/${c.references} ids matched)` : `INVALID (${c.errors.length}):\n` + c.errors.join("\n"));
      },
    },
  },
  {
    name: "rerun_plot",
    cli: "rerun-plot",
    cliRoot: "flags",
    summary:
      "Re-run a plot's recipe (regenerate the figure from its source script + params). Params may be strings, numbers, or booleans. only: true reruns just THIS recipe's plot even when the script saves several (figure-level scripts) — sibling plots stay untouched on disk; a string targets specific plot name(s)/patterns.",
    params: {
      recipePath: z.string(),
      params: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
      only: z.union([z.boolean(), z.string()]).optional(),
    },
    cliArgs: [
      { kind: "pos", at: 0, into: "recipePath", as: "path", required: true },
      { kind: "flag", at: "only", into: "only" },
      // `root`/`only` are runner flags, not recipe params — every OTHER flag
      // persists into the recipe as a param override (the open-ended surface
      // kind:"flagRest" exists for).
      { kind: "flagRest", into: "params" },
    ],
    handler: (_ctx, a) =>
      core.runRecipe(s(a.recipePath), (a.params ?? {}) as Record<string, string | boolean>, {
        only: a.only === true ? true : typeof a.only === "string" ? a.only : undefined,
      }),
    render: {
      human: (r) => {
        const c = r as { code: number; svgPath: string; stderr: string };
        return {
          err: `✓ recipe exited ${c.code}; wrote ${c.svgPath}` + (c.stderr.trim() ? `\n${c.stderr.trim()}` : ""),
          exit: c.code !== 0 ? c.code : undefined,
        };
      },
      mcp: (r) => {
        const c = r as { code: number; svgPath: string; stderr: string };
        // WS-6.1: nonzero exit = the plot did NOT regenerate — report it as an
        // error (the old success-shaped "recipe exited 1" was invisible to agents).
        if (c.code !== 0)
          return { isError: true, content: [{ type: "text", text: `recipe exited ${c.code}\n${String(c.stderr ?? "").slice(-2000)}` }] };
        return text(`recipe exited ${c.code}; wrote ${c.svgPath}`);
      },
    },
  },

  // --- batch E: Flux Slide (deck authoring/animation) ---------------------------
  {
    name: "list_decks",
    cli: "decks",
    cliRoot: "flags",
    summary: "List the project's slide decks (id, title, slide count) from project.json.",
    params: {},
    cliArgs: [],
    handler: (ctx) => core.listDecks(ctx.root),
    render: {
      human: (r) => ({ out: JSON.stringify(r, null, 2) }),
    },
  },
  {
    name: "create_deck",
    cli: "new-deck",
    cliRoot: "flags",
    summary: "Create a new slide deck (slides/<id>/deck.json, registered in the manifest). Returns the deck id.",
    params: { id: z.string().optional(), title: z.string().optional(), theme: z.enum(SLIDE_THEMES).optional() },
    cliArgs: [
      { kind: "flag", at: "id", into: "id" },
      { kind: "flag", at: "title", into: "title" },
      { kind: "flag", at: "theme", into: "theme" },
    ],
    handler: (ctx, a) =>
      core.createDeck(ctx.root, { id: a.id as string | undefined, title: a.title as string | undefined, theme: a.theme as string | undefined }),
    render: {
      human: (r) => {
        const c = r as { deckId: string; path: string };
        return { err: `✓ created deck ${c.deckId} (${c.path})` };
      },
      mcp: (r) => {
        const c = r as { deckId: string; path: string };
        return text(`created deck ${c.deckId} (${c.path})`);
      },
    },
  },
  {
    name: "add_slide",
    cli: "add-slide",
    cliRoot: "flags",
    summary:
      "Append a slide to a deck. `layout` seeds the slide's role (title/section/content-figure/two-column/full-bleed/blank). Returns the new slide id.",
    params: { deckId: z.string(), name: z.string().optional(), layout: z.enum(SLIDE_LAYOUTS).optional() },
    cliArgs: [
      { kind: "pos", at: 0, into: "deckId", required: true },
      { kind: "flag", at: "name", into: "name" },
      { kind: "flag", at: "layout", into: "layout" },
    ],
    handler: (ctx, a) =>
      core.addSlide(ctx.root, s(a.deckId), {
        name: a.name as string | undefined,
        layout: a.layout as Parameters<typeof core.addSlide>[2]["layout"],
      }),
    render: {
      human: (r, a) => ({ err: `✓ added slide ${(r as { slideId: string }).slideId} to ${a.deckId}` }),
      mcp: (r, a) => text(`added slide ${(r as { slideId: string }).slideId} to ${a.deckId}`),
    },
  },
  {
    name: "delete_slide",
    cli: "delete-slide",
    cliRoot: "flags",
    summary: "Delete a slide from a deck. Returns the id the GUI would select next.",
    params: { deckId: z.string(), slideId: z.string() },
    cliArgs: [
      { kind: "pos", at: 0, into: "deckId", required: true },
      { kind: "pos", at: 1, into: "slideId", required: true },
    ],
    handler: (ctx, a) => core.deleteSlide(ctx.root, s(a.deckId), s(a.slideId)),
    render: {
      human: (r, a) => {
        const next = (r as { nextActiveId?: string }).nextActiveId;
        return { err: `✓ deleted slide ${a.slideId}${next ? ` (next: ${next})` : ""}` };
      },
      mcp: (r, a) => {
        const next = (r as { nextActiveId?: string }).nextActiveId;
        return text(`deleted slide ${a.slideId}${next ? ` (next: ${next})` : ""}`);
      },
    },
  },
  {
    name: "duplicate_slide",
    cli: "duplicate-slide",
    cliRoot: "flags",
    summary: "Deep-copy a slide (fresh element/beat/track ids). Returns the new slide id.",
    params: { deckId: z.string(), slideId: z.string() },
    cliArgs: [
      { kind: "pos", at: 0, into: "deckId", required: true },
      { kind: "pos", at: 1, into: "slideId", required: true },
    ],
    handler: (ctx, a) => core.duplicateSlide(ctx.root, s(a.deckId), s(a.slideId)),
    render: {
      human: (r, a) => ({
        out: (r as { slideId: string }).slideId,
        err: `✓ duplicated slide ${a.slideId} → ${(r as { slideId: string }).slideId}`,
      }),
      mcp: (r, a) => text(`duplicated slide ${a.slideId} → ${(r as { slideId: string }).slideId}`),
    },
  },
  {
    name: "reorder_slides",
    cli: "reorder-slides",
    cliRoot: "flags",
    summary: "Set the deck's slide order to exactly `order` (a permutation of the current slide ids).",
    params: { deckId: z.string(), order: z.array(z.string()) },
    cliArgs: [
      { kind: "pos", at: 0, into: "deckId", required: true },
      { kind: "rest", at: 1, into: "order" },
      { kind: "flag", at: "order", into: "order", as: "csv" },
    ],
    handler: (ctx, a) => core.reorderSlides(ctx.root, s(a.deckId), sArr(a.order)),
    render: {
      human: (_r, a) => ({ err: `✓ reordered ${a.deckId} (${sArr(a.order).length} slides)` }),
      mcp: (_r, a) => text(`reordered ${a.deckId} (${sArr(a.order).length} slides)`),
    },
  },
  {
    name: "set_deck_theme",
    cli: "set-theme",
    cliRoot: "flags",
    summary: "Switch a deck's theme (flux-dark | flux-light | flux-paper | flux-midnight | flux-slate | flux-sepia | flux-contrast).",
    params: { deckId: z.string(), theme: z.enum(SLIDE_THEMES) },
    cliArgs: [
      { kind: "pos", at: 0, into: "deckId", required: true },
      { kind: "pos", at: 1, into: "theme" },
      { kind: "flag", at: "theme", into: "theme" },
    ],
    handler: (ctx, a) => core.setDeckTheme(ctx.root, s(a.deckId), s(a.theme)),
    render: {
      human: (_r, a) => ({ err: `✓ set theme ${a.theme} on ${a.deckId}` }),
      mcp: (_r, a) => text(`set theme ${a.theme} on ${a.deckId}`),
    },
  },
  {
    name: "add_slide_text",
    cli: "add-text",
    cliRoot: "flags",
    summary:
      "Add a text element to a slide — the FIGURE text model on the shared 96 px/inch ruler (fontSize in canvas px = pt × 4/3, like add_fig_text; the default 640×360 stage is a ~6.7-inch frame). Returns the new element id (use it as an animation target).",
    params: {
      deckId: z.string(),
      slideId: z.string(),
      text: z.string(),
      x: z.number().optional(),
      y: z.number().optional(),
      width: z.number().optional(),
      height: z.number().optional(),
      align: z.enum(["left", "center", "right"]).optional(),
      color: z.string().optional(),
      fontSize: z.number().optional(),
      fontWeight: z.number().optional(),
      sizing: z.enum(["auto", "auto-h", "fixed"]).optional(),
    },
    cliArgs: [
      { kind: "pos", at: 0, into: "deckId", required: true },
      { kind: "pos", at: 1, into: "slideId", required: true },
      { kind: "rest", at: 2, into: "text", as: "joined", default: "" },
      { kind: "flag", at: "file", into: "text", as: "fileText" },
      { kind: "flag", at: "x", into: "x", as: "number" },
      { kind: "flag", at: "y", into: "y", as: "number" },
      { kind: "flag", at: "width", into: "width", as: "number" },
      { kind: "flag", at: "height", into: "height", as: "number" },
      { kind: "flag", at: "align", into: "align" },
      { kind: "flag", at: "color", into: "color" },
      { kind: "flag", at: "font-size", into: "fontSize", as: "number" },
      { kind: "flag", at: "size-pt", into: "fontSize", as: "ptToPx" },
      { kind: "flag", at: "weight", into: "fontWeight", as: "number" },
      { kind: "flag", at: "sizing", into: "sizing" },
    ],
    handler: (ctx, a) =>
      core.addTextToSlide(ctx.root, s(a.deckId), s(a.slideId), {
        text: s(a.text),
        x: a.x as number | undefined,
        y: a.y as number | undefined,
        width: a.width as number | undefined,
        height: a.height as number | undefined,
        align: a.align as "left" | "center" | "right" | undefined,
        color: a.color as string | undefined,
        fontSize: a.fontSize as number | undefined,
        fontWeight: a.fontWeight as number | undefined,
        sizing: a.sizing as "auto" | "auto-h" | "fixed" | undefined,
      }),
    render: {
      human: (r, a) => ({
        out: (r as { elementId: string }).elementId,
        err: `✓ added text ${(r as { elementId: string }).elementId} to ${a.slideId}`,
      }),
      mcp: (r, a) => text(`added text ${(r as { elementId: string }).elementId} to ${a.slideId}`),
    },
  },
  {
    name: "add_slide_figure",
    cli: "add-figure",
    cliRoot: "flags",
    summary:
      "COPY a project figure's elements + groups (by its figure id, from fig/index.json) onto a slide with fresh ids, at native size (slides share the figure 96 px/inch ruler — 1:1, fit-to-frame only if the figure exceeds the stage; pass x/y to place the content's top-left instead of centering). Plot panels stay individually addressable — animate their parts with animate_part / set_animation. The headless twin of the GUI's Send-to-deck. Returns the new element ids.",
    params: {
      deckId: z.string(),
      slideId: z.string(),
      figureId: z.string(),
      x: z.number().optional(),
      y: z.number().optional(),
    },
    cliArgs: [
      { kind: "pos", at: 0, into: "deckId", required: true },
      { kind: "pos", at: 1, into: "slideId", required: true },
      { kind: "pos", at: 2, into: "figureId", required: true },
      { kind: "flag", at: "x", into: "x", as: "number" },
      { kind: "flag", at: "y", into: "y", as: "number" },
    ],
    handler: (ctx, a) =>
      core.addFigureToSlide(ctx.root, s(a.deckId), s(a.slideId), s(a.figureId), {
        x: a.x as number | undefined,
        y: a.y as number | undefined,
      }),
    render: {
      human: (r, a) => {
        const ids = (r as { elementIds: string[] }).elementIds;
        return {
          out: ids.join("\n"),
          err: `✓ copied figure ${a.figureId} → ${ids.length} element(s) on ${a.slideId}`,
        };
      },
      mcp: (r, a) => {
        const ids = (r as { elementIds: string[] }).elementIds;
        return text(`copied figure ${a.figureId} → ${ids.length} element(s) on ${a.slideId}: ${ids.join(", ")}`);
      },
    },
  },
  {
    name: "add_beat",
    cli: "add-beat",
    cliRoot: "flags",
    summary:
      "Append a build beat to a slide — one 'advance' (click) step of its timeline. Beat 0 is the resting state; add beats, then set_animation on them. Returns the new beat id.",
    params: { deckId: z.string(), slideId: z.string(), label: z.string().optional() },
    cliArgs: [
      { kind: "pos", at: 0, into: "deckId", required: true },
      { kind: "pos", at: 1, into: "slideId", required: true },
      { kind: "flag", at: "label", into: "label" },
    ],
    handler: (ctx, a) => core.addBeat(ctx.root, s(a.deckId), s(a.slideId), { label: a.label as string | undefined }),
    render: {
      human: (r, a) => ({
        out: (r as { beatId: string }).beatId,
        err: `✓ added beat ${(r as { beatId: string }).beatId} to ${a.slideId}`,
      }),
      mcp: (r, a) => text(`added beat ${(r as { beatId: string }).beatId} to ${a.slideId}`),
    },
  },
  {
    name: "set_beat",
    cli: "set-beat",
    cliRoot: "flags",
    summary:
      "Patch a beat: label, advance mode ('click' = manual step, 'with-prev' = chains onto the previous press, 'auto' = plays autoDelayMs after the previous beat finishes), autoDelayMs.",
    params: {
      deckId: z.string(),
      slideId: z.string(),
      beatId: z.string(),
      label: z.string().optional(),
      advance: z.enum(["click", "with-prev", "auto"]).optional(),
      autoDelayMs: z.number().optional(),
    },
    cliArgs: [
      { kind: "pos", at: 0, into: "deckId", required: true },
      { kind: "pos", at: 1, into: "slideId", required: true },
      { kind: "pos", at: 2, into: "beatId", required: true },
      { kind: "flag", at: "label", into: "label" },
      { kind: "flag", at: "advance", into: "advance" },
      { kind: "flag", at: "auto-delay", into: "autoDelayMs", as: "number" },
    ],
    handler: (ctx, a) =>
      core.setBeat(ctx.root, s(a.deckId), s(a.slideId), s(a.beatId), pick(a, ["label", "advance", "autoDelayMs"]) as Parameters<typeof core.setBeat>[4]),
    render: {
      human: (_r, a) => ({ err: `✓ set beat ${a.beatId}` }),
      mcp: (_r, a) => text(`set beat ${a.beatId}`),
    },
  },
  {
    name: "reorder_beats",
    cli: "reorder-beats",
    cliRoot: "flags",
    summary: "Set a slide's beat order to `order` (beat ids). Beat 0 — the resting state — is pinned and never moves.",
    params: { deckId: z.string(), slideId: z.string(), order: z.array(z.string()) },
    cliArgs: [
      { kind: "pos", at: 0, into: "deckId", required: true },
      { kind: "pos", at: 1, into: "slideId", required: true },
      { kind: "rest", at: 2, into: "order" },
      { kind: "flag", at: "order", into: "order", as: "csv" },
    ],
    handler: (ctx, a) => core.reorderBeats(ctx.root, s(a.deckId), s(a.slideId), sArr(a.order)),
    render: {
      human: (_r, a) => ({ err: `✓ reordered beats on ${a.slideId}` }),
      mcp: (_r, a) => text(`reordered beats on ${a.slideId}`),
    },
  },
  {
    name: "move_track",
    cli: "move-track",
    cliRoot: "flags",
    summary: "Move an animation track (by id) into another beat on the same slide; timing travels untouched. `at` picks the lane index.",
    params: { deckId: z.string(), slideId: z.string(), trackId: z.string(), toBeatId: z.string(), at: z.number().optional() },
    cliArgs: [
      { kind: "pos", at: 0, into: "deckId", required: true },
      { kind: "pos", at: 1, into: "slideId", required: true },
      { kind: "pos", at: 2, into: "trackId", required: true },
      { kind: "pos", at: 3, into: "toBeatId", required: true },
      { kind: "flag", at: "at", into: "at", as: "number" },
    ],
    handler: (ctx, a) =>
      core.moveTrack(ctx.root, s(a.deckId), s(a.slideId), s(a.trackId), s(a.toBeatId), a.at as number | undefined),
    render: {
      human: (_r, a) => ({ err: `✓ moved track ${a.trackId} → beat ${a.toBeatId}` }),
      mcp: (_r, a) => text(`moved track ${a.trackId} → beat ${a.toBeatId}`),
    },
  },
  {
    name: "duplicate_track",
    cli: "duplicate-track",
    cliRoot: "flags",
    summary: "Deep-copy a track in place (fresh id, inserted after the original). Returns the new track id.",
    params: { deckId: z.string(), slideId: z.string(), trackId: z.string() },
    cliArgs: [
      { kind: "pos", at: 0, into: "deckId", required: true },
      { kind: "pos", at: 1, into: "slideId", required: true },
      { kind: "pos", at: 2, into: "trackId", required: true },
    ],
    handler: (ctx, a) => core.duplicateTrack(ctx.root, s(a.deckId), s(a.slideId), s(a.trackId)),
    render: {
      human: (r, a) => ({
        out: (r as { trackId: string }).trackId,
        err: `✓ duplicated track ${a.trackId} → ${(r as { trackId: string }).trackId}`,
      }),
      mcp: (r, a) => text(`duplicated track ${a.trackId} → ${(r as { trackId: string }).trackId}`),
    },
  },
  {
    name: "reorder_tracks",
    cli: "reorder-tracks",
    cliRoot: "flags",
    summary: "Set one beat's track (lane) order to `order` (track ids). Order is presentational — tracks in a beat play concurrently.",
    params: { deckId: z.string(), slideId: z.string(), beatId: z.string(), order: z.array(z.string()) },
    cliArgs: [
      { kind: "pos", at: 0, into: "deckId", required: true },
      { kind: "pos", at: 1, into: "slideId", required: true },
      { kind: "pos", at: 2, into: "beatId", required: true },
      { kind: "rest", at: 3, into: "order" },
      { kind: "flag", at: "order", into: "order", as: "csv" },
    ],
    handler: (ctx, a) => core.reorderTracks(ctx.root, s(a.deckId), s(a.slideId), s(a.beatId), sArr(a.order)),
    render: {
      human: (_r, a) => ({ err: `✓ reordered tracks on beat ${a.beatId}` }),
      mcp: (_r, a) => text(`reordered tracks on beat ${a.beatId}`),
    },
  },
  {
    name: "set_track_enabled",
    cli: "set-track-enabled",
    cliRoot: "flags",
    summary:
      "Disable/enable a track. Disabled tracks keep their authored timing but are invisible to play/preview/export (the non-destructive Mask substrate).",
    params: { deckId: z.string(), slideId: z.string(), trackId: z.string(), enabled: z.boolean() },
    cliArgs: [
      { kind: "pos", at: 0, into: "deckId", required: true },
      { kind: "pos", at: 1, into: "slideId", required: true },
      { kind: "pos", at: 2, into: "trackId", required: true },
      { kind: "pos", at: 3, into: "enabled", as: "boolean", default: true },
      { kind: "flag", at: "enabled", into: "enabled", as: "boolean" },
    ],
    handler: (ctx, a) => core.setTrackEnabled(ctx.root, s(a.deckId), s(a.slideId), s(a.trackId), a.enabled as boolean),
    render: {
      human: (_r, a) => ({ err: `✓ track ${a.trackId} ${a.enabled ? "enabled" : "disabled"}` }),
      mcp: (_r, a) => text(`track ${a.trackId} ${a.enabled ? "enabled" : "disabled"}`),
    },
  },
  {
    name: "set_transform",
    cli: "set-transform",
    cliRoot: "flags",
    summary:
      "Add or update THE transform track for an element on a beat (max one per element per beat — chain across beats). `state` is a sparse element-property patch vs the track's pre-state (t1 = document state ⊕ earlier transforms): {x, y, width, height, rotation, opacity, fill, stroke, text, …}; null deletes a prop at t2; merged over the existing patch unless `replaceState`. For plots, `toAssetId` adds the data-morph half (same-structure plot; explicit source paths are persisted automatically). Playback tweens t1→t2 with OKLab colors, arc-length path resampling, and digit-tweened numeric text.",
    params: {
      deckId: z.string(),
      slideId: z.string(),
      beatId: z.string(),
      target: z.string(),
      state: z.record(z.any()).optional(),
      replaceState: z.boolean().optional(),
      start: z.number().optional(),
      duration: z.number().optional(),
      easing: z.enum(["smooth", "standard", "enter", "exit", "linear"]).optional(),
      toAssetId: z.string().optional(),
    },
    cliArgs: [
      { kind: "pos", at: 0, into: "deckId", required: true },
      { kind: "pos", at: 1, into: "slideId", required: true },
      { kind: "pos", at: 2, into: "beatId", required: true },
      { kind: "pos", at: 3, into: "target", required: true },
      { kind: "flag", at: "state", into: "state", as: "json" },
      { kind: "flag", at: "replace-state", into: "replaceState", as: "boolean" },
      { kind: "flag", at: "start", into: "start", as: "number" },
      { kind: "flag", at: "duration", into: "duration", as: "number" },
      { kind: "flag", at: "easing", into: "easing" },
      { kind: "flag", at: "to-asset", into: "toAssetId" },
    ],
    handler: (ctx, a) =>
      core.setTransformTrack(ctx.root, s(a.deckId), s(a.slideId), s(a.beatId), s(a.target), {
        ...(a.state != null ? { state: a.state as Record<string, unknown> } : {}),
        ...(a.replaceState ? { replaceState: true } : {}),
        ...(a.start != null ? { start: a.start as number } : {}),
        ...(a.duration != null ? { duration: a.duration as number } : {}),
        ...(a.easing != null ? { easing: a.easing as "smooth" } : {}),
        ...(a.toAssetId != null ? { toAssetId: s(a.toAssetId) } : {}),
      }),
    render: {
      human: (r, a) => ({
        out: (r as { trackId: string }).trackId,
        err: `✓ transform on ${a.target} (beat ${a.beatId})`,
      }),
      mcp: (r, a) => text(`transform track ${(r as { trackId: string }).trackId} on ${a.target} (beat ${a.beatId})`),
    },
  },
  {
    name: "group_tracks",
    cli: "group-tracks",
    cliRoot: "flags",
    summary:
      "Bundle tracks on one beat under a labeled, collapsible TrackGroup (a presentational animator lane group — grouping never changes playback). Returns the group id.",
    params: { deckId: z.string(), slideId: z.string(), beatId: z.string(), trackIds: z.array(z.string()), label: z.string().optional() },
    cliArgs: [
      { kind: "pos", at: 0, into: "deckId", required: true },
      { kind: "pos", at: 1, into: "slideId", required: true },
      { kind: "pos", at: 2, into: "beatId", required: true },
      { kind: "rest", at: 3, into: "trackIds" },
      { kind: "flag", at: "tracks", into: "trackIds", as: "csv" },
      { kind: "flag", at: "label", into: "label" },
    ],
    handler: (ctx, a) => core.groupTracksVerb(ctx.root, s(a.deckId), s(a.slideId), s(a.beatId), sArr(a.trackIds), a.label as string | undefined),
    render: {
      human: (r, a) => ({
        out: (r as { groupId: string }).groupId,
        err: `✓ grouped ${sArr(a.trackIds).length} tracks on beat ${a.beatId}`,
      }),
      mcp: (r, a) => text(`grouped ${sArr(a.trackIds).length} tracks → ${(r as { groupId: string }).groupId}`),
    },
  },
  {
    name: "ungroup_tracks",
    cli: "ungroup-tracks",
    cliRoot: "flags",
    summary: "Dissolve the TrackGroups the given tracks belong to (members become loose lanes).",
    params: { deckId: z.string(), slideId: z.string(), beatId: z.string(), trackIds: z.array(z.string()) },
    cliArgs: [
      { kind: "pos", at: 0, into: "deckId", required: true },
      { kind: "pos", at: 1, into: "slideId", required: true },
      { kind: "pos", at: 2, into: "beatId", required: true },
      { kind: "rest", at: 3, into: "trackIds" },
      { kind: "flag", at: "tracks", into: "trackIds", as: "csv" },
    ],
    handler: (ctx, a) => core.ungroupTracksVerb(ctx.root, s(a.deckId), s(a.slideId), s(a.beatId), sArr(a.trackIds)),
    render: {
      human: (_r, a) => ({ err: `✓ ungrouped on beat ${a.beatId}` }),
      mcp: (_r, a) => text(`ungrouped tracks on beat ${a.beatId}`),
    },
  },
  {
    name: "cascade_tracks",
    cli: "cascade-tracks",
    cliRoot: "flags",
    summary:
      "Cascade one timing property across animation tracks: the track at rank k (0-indexed) gets value + delta·step, where step = k with --first-fixed, else k+1; --factor switches to multiplicative (value · factor^step). property ∈ start|duration|influence.in|influence.out|stagger.perMs. --order timeline (beat index, then lane — the default) or list (the given track order). Clamps: start ≥ 0 ms, duration ≥ 50 ms, influence 0–100 (both-zero deletes the velocity profile), perMs ≥ 0 (only stagger-bearing tracks rank). GUI: ⌃⇧C in the animator with ≥2 tracks selected.",
    params: {
      deckId: z.string(),
      slideId: z.string(),
      property: z.enum(TRACK_CASCADE_PROPS),
      trackIds: z.array(z.string()),
      delta: z.number().optional(),
      factor: z.number().positive().optional(),
      order: z.enum(["timeline", "list"]).optional(),
      reverse: z.boolean().optional(),
      firstFixed: z.boolean().optional(),
    },
    cliArgs: [
      { kind: "pos", at: 0, into: "deckId", required: true },
      { kind: "pos", at: 1, into: "slideId", required: true },
      { kind: "pos", at: 2, into: "property", required: true },
      { kind: "rest", at: 3, into: "trackIds" },
      { kind: "flag", at: "tracks", into: "trackIds", as: "csv" },
      { kind: "flag", at: "delta", into: "delta", as: "number" },
      { kind: "flag", at: "factor", into: "factor", as: "number" },
      { kind: "flag", at: "order", into: "order" },
      { kind: "flag", at: "reverse", into: "reverse", as: "boolean" },
      { kind: "flag", at: "first-fixed", into: "firstFixed", as: "boolean" },
    ],
    handler: (ctx, a) => core.cascadeTracksVerb(ctx.root, s(a.deckId), s(a.slideId), sArr(a.trackIds), trackCascadeSpecOf(a)),
    render: {
      human: (r, a) => ({ err: `✓ cascaded ${a.property} across ${(r as { changed: number }).changed} track(s)` }),
      mcp: (r, a) => text(`cascaded ${a.property} across ${(r as { changed: number }).changed} track(s)`),
    },
  },
  {
    name: "apply_anim_template",
    cli: "apply-anim-template",
    cliRoot: "flags",
    summary:
      "Apply a saved animation TEMPLATE (a bundle of preset slots with role/type matchers, from <FluxConfig>/presets/anim-templates/ by name, or an explicit .json path) onto a scope: `elementId` [+ `part`] binds part slots within that plot('s container subtree) by ROLE (an x-axis template lands on a y-axis); `elementIds` binds element slots by type + document order. Bound tracks land on `beatId` (default: the last build beat) as one labeled TrackGroup. Partial matches are reported, never invented.",
    params: {
      deckId: z.string(),
      slideId: z.string(),
      template: z.string(),
      beatId: z.string().optional(),
      elementIds: z.array(z.string()).optional(),
      elementId: z.string().optional(),
      part: z.string().optional(),
    },
    cliArgs: [
      { kind: "pos", at: 0, into: "deckId", required: true },
      { kind: "pos", at: 1, into: "slideId", required: true },
      { kind: "pos", at: 2, into: "template", required: true },
      { kind: "flag", at: "beat", into: "beatId" },
      { kind: "flag", at: "elements", into: "elementIds", as: "csv" },
      { kind: "flag", at: "element", into: "elementId" },
      { kind: "flag", at: "part", into: "part" },
    ],
    handler: (ctx, a) =>
      core.applyAnimTemplateVerb(ctx.root, s(a.deckId), s(a.slideId), {
        template: s(a.template),
        ...(a.beatId != null ? { beatId: s(a.beatId) } : {}),
        ...(a.elementIds != null ? { elementIds: sArr(a.elementIds) } : {}),
        ...(a.elementId != null ? { elementId: s(a.elementId) } : {}),
        ...(a.part != null ? { part: s(a.part) } : {}),
      }),
    render: {
      human: (r) => {
        const x = r as { matched: number; total: number; trackIds: string[]; unmatched: string[] };
        return {
          out: x.trackIds.join("\n"),
          err: `✓ applied ${x.matched}/${x.total}${x.unmatched.length ? ` — unmatched: ${x.unmatched.join("; ")}` : ""}`,
        };
      },
      mcp: (r) => {
        const x = r as { matched: number; total: number; trackIds: string[]; unmatched: string[] };
        return text(`applied ${x.matched}/${x.total} slots (${x.trackIds.length} tracks)${x.unmatched.length ? `; unmatched: ${x.unmatched.join("; ")}` : ""}`);
      },
    },
  },
  {
    name: "set_part_visibility",
    cli: "set-part-visibility",
    cliRoot: "flags",
    summary:
      "A plot part's resting tri-state on a slide: 'show' (visible from beat 0), 'animate' (revealed by its track), 'mask' (always hidden). Mask/show DISABLE the part's tracks rather than deleting them.",
    params: { deckId: z.string(), elementId: z.string(), part: z.string(), mode: z.enum(["show", "animate", "mask"]) },
    cliArgs: [
      { kind: "pos", at: 0, into: "deckId", required: true },
      { kind: "pos", at: 1, into: "elementId", required: true },
      { kind: "pos", at: 2, into: "part", required: true },
      { kind: "pos", at: 3, into: "mode" },
      { kind: "flag", at: "mode", into: "mode" },
    ],
    handler: (ctx, a) =>
      core.setPartVisibility(ctx.root, s(a.deckId), s(a.elementId), s(a.part), a.mode as "show" | "animate" | "mask"),
    render: {
      human: (_r, a) => ({ err: `✓ ${a.part} → ${a.mode}` }),
      mcp: (_r, a) => text(`${a.part} → ${a.mode}`),
    },
  },
  {
    name: "set_part_style",
    cli: "set-part-style",
    cliRoot: "flags",
    summary:
      "Merge a style patch into one plot part's override on a slide element — stroke, fill, strokeWidth, opacity, fontSize, fontFamily, fontWeight, hidden. The SAME id-keyed override core the figure editor writes (survives regeneration). Null deletes a key. Part may be a leaf ('fit.line') or group ('axis.x.ticks') id.",
    params: {
      deckId: z.string(),
      elementId: z.string(),
      part: z.string(),
      patch: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])),
    },
    cliArgs: [
      { kind: "pos", at: 0, into: "deckId", required: true },
      { kind: "pos", at: 1, into: "elementId", required: true },
      { kind: "pos", at: 2, into: "part", required: true },
      { kind: "flag", at: "patch", into: "patch", as: "json", required: true },
    ],
    handler: (ctx, a) =>
      core.setPartStyle(ctx.root, s(a.deckId), s(a.elementId), s(a.part), a.patch as Parameters<typeof core.setPartStyle>[4]),
    render: {
      human: (_r, a) => ({ err: `✓ styled ${a.part}` }),
      mcp: (_r, a) => text(`styled ${a.part}`),
    },
  },
  {
    name: "animate_part",
    cli: "animate-part",
    cliRoot: "flags",
    summary:
      "Make ONE plot part animate in: re-enables its existing tracks (authored timing preserved) or adds the plot's suggested default reveal on a build beat. Returns the beat index used.",
    params: { deckId: z.string(), slideId: z.string(), elementId: z.string(), part: z.string(), beatIndex: z.number().optional() },
    cliArgs: [
      { kind: "pos", at: 0, into: "deckId", required: true },
      { kind: "pos", at: 1, into: "slideId", required: true },
      { kind: "pos", at: 2, into: "elementId", required: true },
      { kind: "pos", at: 3, into: "part", required: true },
      { kind: "flag", at: "beat-index", into: "beatIndex", as: "number" },
    ],
    handler: (ctx, a) =>
      core.animatePartVerb(ctx.root, s(a.deckId), s(a.slideId), s(a.elementId), s(a.part), a.beatIndex as number | undefined),
    render: {
      human: (r, a) => ({ err: `✓ ${a.part} animates on beat ${(r as { beatIndex: number }).beatIndex}` }),
      mcp: (r, a) => text(`${a.part} animates on beat ${(r as { beatIndex: number }).beatIndex}`),
    },
  },
  {
    name: "animate_element",
    cli: "animate-element",
    cliRoot: "flags",
    summary:
      "Give a whole element (text / shape / line / image / plot) an enter or exit animation with sensible per-kind defaults (text→fadeRise, line/path→drawOn, rect/ellipse→popIn; exits: fadeOut/popOut/drawOff). The non-plot analog of animate_part. `part` narrows to a named plot part instead.",
    params: {
      deckId: z.string(),
      slideId: z.string(),
      elementId: z.string(),
      exit: z.boolean().optional(),
      preset: z.enum(SLIDE_PRESETS).optional(),
      beatIndex: z.number().optional(),
      part: z.string().optional(),
    },
    cliArgs: [
      { kind: "pos", at: 0, into: "deckId", required: true },
      { kind: "pos", at: 1, into: "slideId", required: true },
      { kind: "pos", at: 2, into: "elementId", required: true },
      { kind: "flag", at: "exit", into: "exit", as: "boolean" },
      { kind: "flag", at: "preset", into: "preset" },
      { kind: "flag", at: "beat-index", into: "beatIndex", as: "number" },
      { kind: "flag", at: "part", into: "part" },
    ],
    handler: (ctx, a) =>
      core.animateElementVerb(
        ctx.root,
        s(a.deckId),
        s(a.slideId),
        s(a.elementId),
        pick(a, ["beatIndex", "exit", "preset", "part"]) as Parameters<typeof core.animateElementVerb>[4],
      ),
    render: {
      human: (r, a) => ({
        out: (r as { trackId: string }).trackId,
        err: `✓ element ${a.elementId} ${a.exit ? "animates out" : "animates in"} on beat ${(r as { beatIndex: number }).beatIndex}`,
      }),
      mcp: (r, a) => {
        const c = r as { beatIndex: number; trackId: string };
        return text(`element ${a.elementId} ${a.exit ? "animates out" : "animates in"} on beat ${c.beatIndex} (track ${c.trackId})`);
      },
    },
  },
  {
    name: "set_morph",
    cli: "set-morph",
    cliRoot: "flags",
    summary:
      "Author the data-space morph: a plot element tweens into ANY project plot (by asset id) on a beat. Refuses structurally-incompatible pairs (no shared tweenable series) unless force.",
    params: {
      deckId: z.string(),
      slideId: z.string(),
      beatId: z.string(),
      elementId: z.string(),
      toAssetId: z.string(),
      duration: z.number().optional(),
      force: z.boolean().optional(),
    },
    cliArgs: [
      { kind: "pos", at: 0, into: "deckId", required: true },
      { kind: "pos", at: 1, into: "slideId", required: true },
      { kind: "pos", at: 2, into: "beatId", required: true },
      { kind: "pos", at: 3, into: "elementId", required: true },
      { kind: "pos", at: 4, into: "toAssetId", required: true },
      { kind: "flag", at: "duration", into: "duration", as: "number" },
      { kind: "flag", at: "force", into: "force", as: "boolean" },
    ],
    handler: (ctx, a) =>
      core.setMorph(ctx.root, s(a.deckId), s(a.slideId), s(a.beatId), s(a.elementId), s(a.toAssetId), {
        duration: a.duration as number | undefined,
        force: a.force as boolean | undefined,
      }),
    render: {
      human: (_r, a) => ({ err: `✓ morph ${a.elementId} → ${a.toAssetId} on beat ${a.beatId}` }),
      mcp: (_r, a) => text(`morph ${a.elementId} → ${a.toAssetId} on beat ${a.beatId}`),
    },
  },
  {
    name: "validate_deck",
    cli: "validate-deck",
    cliRoot: "flags",
    summary: "Validate a deck (or all decks) against the bundled deck JSON Schema. Run after editing deck.json by hand.",
    params: { deckId: z.string().optional() },
    cliArgs: [{ kind: "pos", at: 0, into: "deckId" }],
    handler: (ctx, a) => core.validateDeck(ctx.root, a.deckId as string | undefined),
    render: {
      human: (r) => {
        const c = r as { ok: boolean; checked: number; errors: string[]; warnings: string[] };
        const warn = c.warnings.length ? "\n" + c.warnings.map((w) => `  ⚠ ${w}`).join("\n") : "";
        if (c.ok) return { err: `✓ valid deck(s) (${c.checked} checked)` + warn };
        return { err: `✗ ${c.errors.length} problem(s):\n` + c.errors.map((e) => "  " + e).join("\n") + warn, exit: 1 };
      },
      mcp: (r) => {
        const c = r as { ok: boolean; checked: number; errors: string[]; warnings: string[] };
        const warn = c.warnings.length ? "\n" + c.warnings.map((w) => `⚠ ${w}`).join("\n") : "";
        return text((c.ok ? `valid deck(s) (${c.checked} checked)` : `INVALID (${c.errors.length}):\n` + c.errors.join("\n")) + warn);
      },
    },
  },
  {
    name: "export_deck",
    cli: "export-deck",
    cliRoot: "flags",
    summary: "Export a deck to a single self-contained offline .html (animations + media inlined). Writes to exports/ by default.",
    params: { deckId: z.string(), out: z.string().optional() },
    cliArgs: [
      { kind: "pos", at: 0, into: "deckId", required: true },
      { kind: "flag", at: "out", into: "out" },
    ],
    handler: (ctx, a) => core.exportDeck(ctx.root, s(a.deckId), { out: a.out as string | undefined }),
    render: {
      human: (r, a) => {
        const c = r as { path: string; bytes: number; warnings: string[] };
        return {
          err:
            `✓ exported ${a.deckId} → ${c.path} (${(c.bytes / 1024).toFixed(0)} KB, self-contained)` +
            c.warnings.map((w) => `\n  ⚠ ${w}`).join(""),
        };
      },
      mcp: (r, a) => {
        const c = r as { path: string; bytes: number; warnings: string[] };
        return text(
          `exported ${a.deckId} → ${c.path} (${(c.bytes / 1024).toFixed(0)} KB)` +
            (c.warnings.length ? `\n  ⚠ ${c.warnings.join("\n  ⚠ ")}` : ""),
        );
      },
    },
  },

  // --- paper snips (reader-parity capture + citations) ------------------------------
  {
    name: "snip_paper",
    cli: "snip-paper",
    cliRoot: "flags",
    summary:
      "Capture a region of a FluxLib paper's PDF page as a PNG snip into plots/paper_snips/ — true-size pHYs dpi (72×scale), embedded flux-snip tEXt provenance, and a .snip.json sidecar, exactly like the reader's ctrl+alt+drag. rect is PDF points, y-up, [x1,y1,x2,y2] (a human-captured snip's sidecar rect round-trips); omit it to snip the whole page. Returns the file path and the formatted citation — cite it to substantiate claims about the paper's figures.",
    params: {
      key: z.string(),
      page: z.number().int().min(1),
      rect: z.array(z.number()).length(4).optional(),
      name: z.string().optional(),
      scale: z.number().positive().max(8).optional(),
      supplement: z.string().optional(),
    },
    cliArgs: [
      { kind: "pos", at: 0, into: "key", required: true },
      { kind: "flag", at: "page", into: "page", as: "number", required: true },
      { kind: "flag", at: "rect", into: "rect", as: "csvNum" },
      { kind: "flag", at: "name", into: "name" },
      { kind: "flag", at: "scale", into: "scale", as: "number" },
      { kind: "flag", at: "supplement", into: "supplement" },
    ],
    handler: (ctx, a) =>
      core.snipPaper(ctx.root, {
        key: s(a.key),
        page: a.page as number,
        rect: a.rect as [number, number, number, number] | undefined,
        name: a.name as string | undefined,
        scale: a.scale as number | undefined,
        supplement: a.supplement as string | undefined,
      }),
    render: {
      human: (r, a) => {
        const c = r as { path: string; citation: string; dpi: number; bibEntry: boolean };
        return {
          err:
            `✓ snipped @${a.key} p${a.page} → ${c.path} (${c.dpi}dpi)\n  ${c.citation}` +
            (c.bibEntry ? "" : "\n  ⚠ no bib entry for this key — citation is the bare citekey"),
        };
      },
      mcp: (r, a) => {
        const c = r as { path: string; citation: string; rect: number[]; bibEntry: boolean };
        return text(
          `snipped @${a.key} → ${c.path}\nrect: [${c.rect.map((n) => n.toFixed(1)).join(", ")}]\ncitation: ${c.citation}` +
            (c.bibEntry ? "" : "\n⚠ no bib entry for this key — citation is the bare citekey"),
        );
      },
    },
  },
  {
    name: "get_citation",
    cli: "cite",
    cliRoot: "flags",
    summary:
      'The minimal text citation for a FluxLib key ("Smith et al., 2026, Nat. Neurosci." — in-text author-year + ISO-4-abbreviated journal), for figure captions and slides.',
    params: { key: z.string() },
    cliArgs: [{ kind: "pos", at: 0, into: "key", required: true }],
    handler: (_ctx, a) => core.getCitation(s(a.key)),
    render: {
      human: (r) => {
        const c = r as { citation: string; bibEntry: boolean };
        return { err: c.bibEntry ? `✓ ${c.citation}` : `✓ ${c.citation}\n  ⚠ no bib entry for this key` };
      },
      mcp: (r) => {
        const c = r as { citation: string; bibEntry: boolean };
        return text(c.citation + (c.bibEntry ? "" : "\n⚠ no bib entry for this key"));
      },
    },
  },
];
