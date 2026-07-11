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
      "Resolve Flux's machine-level paths as JSON: fluxConfigPath (the user's FluxConfig folder), fluxLibPath (the reference library, always <FluxConfig>/FluxLib), guidelinesPath, and userDataDir — plus `build` (version/commit/entry) identifying which Flux build is answering. Read every file in guidelinesPath before working — it holds the user's standing conventions for all Flux output.",
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
      "Set element-level style on element ids: fill/stroke/strokeWidth/opacity/color/fontSize (canvas px = pt × 4/3), text props (fontFamily/fontWeight/fontStyle/underline/lineHeight/sizing/align), plus hidden (omit from canvas + export), locked (not editable on canvas), and name (Layers label).",
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
    },
    cliArgs: [
      { kind: "rest", at: 0, into: "ids", required: true },
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
];
