// WS-6.3 — the verb table (see registry.ts for the machinery). Migration is
// batched: registered verbs route through the registry on BOTH surfaces; verbs
// not yet here fall through to flux-cli's legacy switch / flux-mcp's manual
// registerTool blocks. Every entry must keep the EXACT observable behavior of
// the wrapper it replaces (verify-registry-parity.ts pins representative
// strings; verify-f1-mcp/w11-verbs/release-check stay green).

import { z } from "zod";
import { PRESET_CATALOG, EDITABLE_PRESETS } from "../src/lib/slide/presetCatalog";
import type { PlotViewFields } from "../src/lib/plot/viewControls";
import type { ColorScaleVerbFields } from "./slides";
import { EASING_TOKENS, CURVE_CATALOG, parseCurve } from "../src/lib/slide/curves";
import type { EasingToken, PairPolicy, TransformMethod, Track, PresetName, TargetRef } from "../src/lib/slide/types";
import { PAIR_POLICY_IDS, TRANSFORM_METHOD_IDS } from "../src/lib/slide/targets";
import type { VerbDef, CliArgSpec } from "./registry";
import { INBOX_VERBS } from "./inboxVerbs";
import { MODEL3D_VERBS } from './model3dVerbs';
import { inboxSession, inboxAuthor, resolveItem } from "./annotations";import { ValidationError } from "./errors";
import { text } from "./registry";
import { renderLogEntries } from "../src/lib/project/contextTemplates";
import * as core from "./index";
import * as model from "./model";
import * as references from "./references";
import { ELEMENT_CASCADE_PROPS, TRACK_CASCADE_PROPS, type CascadeSpec, type TrackCascadeSpec } from "../src/lib/cascade";

// --- shared bits -------------------------------------------------------------

const staggerSchema = z.object({
  perMs: z.number().nonnegative().optional(), totalMs: z.number().nonnegative().optional(),
  by: z.union([z.enum(["index", "x", "y", "data"]), z.object({ key: z.enum(["value", "count", "index"]) }).strict()]).optional(),
  from: z.enum(["start", "end", "center", "edges", "random"]).optional(),
  seed: z.number().int().min(0).max(0xffffffff).optional(),
  curve: z.union([
    z.enum(EASING_TOKENS),
    z.object({ kind: z.literal("bezier"), p: z.tuple([z.number().min(0).max(1), z.number().min(-1).max(2), z.number().min(0).max(1), z.number().min(-1).max(2)]) }).strict(),
    z.object({ kind: z.literal("spring"), bounce: z.number().min(-0.5).max(0.8), velocity: z.number().optional() }).strict(),
    z.object({ kind: z.literal("steps"), n: z.number().int().min(1).max(60), jump: z.enum(["start", "end"]).optional() }).strict(),
  ]).optional(),
}).refine(s => s.perMs !== undefined || s.totalMs !== undefined, "Stagger needs perMs or totalMs");

/** Copy the defined keys of `a` listed in `keys` into a fresh patch object —
 *  the "only the fields you pass change" contract every patch verb keeps. */
const pick = (a: Record<string, unknown>, keys: string[]): Record<string, never> => {
  const p: Record<string, unknown> = {};
  for (const k of keys) if (a[k] !== undefined) p[k] = a[k];
  return p as Record<string, never>;
};

const CURVE_GRAMMAR = `Curve: spring(0.35), spring(0.35, v=2), spring(k=170, c=26, m=1), bezier(x1,y1,x2,y2) or cubic-bezier(x1,y1,x2,y2), steps(n[,start|end]); catalog names: ${CURVE_CATALOG.map(c => c.id).join(", ")}`;
/** Parse before any IO. A curve argument takes precedence over legacy fields. */
function timingCurveArgs(a: Record<string, unknown>): Pick<Track, "curve" | "influence" | "easing"> {
  if (a.curve !== undefined) {
    const curve = parseCurve(a.curve as string);
    if (curve === null) throw new ValidationError(`Invalid curve ${JSON.stringify(a.curve)}. ${CURVE_GRAMMAR}`);
    return typeof curve === "string" ? { easing: curve } : { curve };
  }
  if (a.influence !== undefined) return { influence: a.influence as Track["influence"] };
  return a.easing !== undefined ? { easing: a.easing as EasingToken } : {};
}

const s = (v: unknown): string => v as string;
const modelMorphSummary = (value: unknown): string => {
  const result = value as { morph?: boolean; reason?: string };
  return typeof result.morph === 'boolean' ? `; morph:${result.morph}${result.reason ? ` (${result.reason})` : ''}` : '';
};
/** "becomes ‹target›", or for a set result "hands off to 3 ellipses". */
const becomeDestination = (value: unknown, a: Record<string, unknown>): string => {
  const set = (value as { destination?: string }).destination;
  return set ? `hands off to ${set}` : `becomes ${a.target ?? a.asset}`;
};
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
  "valign",
  "letterSpacing",
  "paragraphSpacing",
  "hidden",
  "locked",
  "name",
  "dash",
  "fillOpacity",
  "strokeOpacity",
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
  align: z.enum(["left", "center", "right", "justify"]).optional(),
  valign: z.enum(["top", "middle", "bottom"]).optional(),
  letterSpacing: z.number().optional(),
  paragraphSpacing: z.number().optional(),
};
const TEXT_STYLE_KEYS = ["fontFamily", "fontSize", "fontWeight", "fontStyle", "underline", "lineHeight", "color", "align", "valign", "letterSpacing", "paragraphSpacing"];
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
  { kind: "flag", at: "valign", into: "valign" },
  { kind: "flag", at: "letter-spacing", into: "letterSpacing", as: "number" },
  { kind: "flag", at: "paragraph-spacing", into: "paragraphSpacing", as: "number" },
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
export const SLIDE_PRESETS = [...EDITABLE_PRESETS, ...Object.values(PRESET_CATALOG).filter(def => !def.editable && def.family !== "media").map(def => def.name)] as [PresetName, ...PresetName[]];
export const SLIDE_LAYOUTS = ["title", "section", "content-figure", "two-column", "full-bleed", "blank"] as const;
export const SLIDE_THEMES = ["flux-dark", "flux-light", "flux-paper", "flux-midnight", "flux-slate", "flux-sepia", "flux-contrast"] as const;

const ageOfSince = (since: string) => {
  const min = Math.max(0, Math.round((Date.now() - Date.parse(since)) / 60000));
  return min < 90 ? `${min} min ago` : min < 2880 ? `${Math.round(min / 60)} h ago` : `${Math.round(min / 1440)} d ago`;
};

/** `flux connect --refresh`: the delta since the session last looked, then where the full new pack is. */
function connectRefreshBrief(c: import("./connect/index").ConnectResult): string {
  const f = c.refresh!;
  return [
    `# FLUX-CONNECT REFRESH BRIEF · project "${c.title}" · pack ${c.packId} · since pack ${f.fromPack} (${ageOfSince(f.since)})`,
    "",
    f.details,
    "",
    `The full, current pack: \`${c.briefPath ?? "(not written)"}\` and \`${c.bundlePath ?? "(not written)"}\` (MCP \`read_pack {packId:"${c.packId}"}\`). Re-read only what changed.`,
    "",
    "Reply with:",
    "```",
    `↻ refreshed · ${c.title} · since ${f.fromPack} (${ageOfSince(f.since)}) · ${f.changes} change${f.changes === 1 ? "" : "s"}`,
    "```",
    "",
    `END OF FLUX-CONNECT REFRESH BRIEF ${c.packId}`,
    "",
  ].join("\n");
}

export const VERBS: VerbDef[] = [
  {
    name: "connect", cli: "connect", cliRoot: "flags", scope: "machine", core: true, bindsRoot: true,
    summary:
      "flux-connect: load a Flux project (a path to or inside it), `global`, or the project around cwd. Returns a brief to follow (what to read and look at, then a receipt) and binds the project. Only when the user asks for flux-connect.",
    params: { target: z.string().optional(), live: z.boolean().optional(), refresh: z.boolean().optional(),
      depth: z.enum(["core", "full", "ask", "task"]).optional(), budget: z.number().int().positive().optional(),
      noRender: z.boolean().optional(), json: z.boolean().optional() },
    notAPath: { target: "a project path, `global`, or omitted; resolved by connect itself (walk-up to project.json)" },
    cliOnlyFlags: {
      part: { value: true, help: "part N of a stdout-only pack (with --pack and --sources, as the brief prints them)" },
      pack: { value: true, help: "the pack id, with --part" },
      sources: { value: true, help: "the pack's sources digest, with --part" },
      "check-receipt": { value: true, help: "<packId> \"<proof line>\": which bundle sections and images a receipt confirms" },
      "hook-delta": { value: false, help: "the Claude Code prompt hook: one line when a connected project changed" },
    },
    cliArgs: [{ kind: "pos", at: 0, into: "target" },
      { kind: "flag", at: "live", into: "live", as: "boolean" }, { kind: "flag", at: "refresh", into: "refresh", as: "boolean" },
      { kind: "flag", at: "depth", into: "depth" }, { kind: "flag", at: "budget", into: "budget", as: "number" },
      { kind: "flag", at: "no-render", into: "noRender", as: "boolean" }, { kind: "flag", at: "json", into: "json", as: "boolean" }],
    handler: async (ctx, a) => {
      const { connect } = await import("./connect/index");
      const identity = ctx.identity ?? (await import("./agentIdentity")).detectAgentIdentity(process.env);
      const r = await connect({
        target: a.target as string | undefined,
        // Over MCP a relative or omitted target resolves from the bound project (else the server's cwd, which Claude Code sets to the session's).
        cwd: ctx.mcp ? ctx.root || process.cwd() : process.cwd(),
        depth: a.depth as "core" | "full" | "ask" | "task" | undefined,
        live: a.live as boolean | undefined,
        refresh: a.refresh as boolean | undefined,
        budget: a.budget as number | undefined,
        noRender: a.noRender as boolean | undefined,
        identity,
        sessionName: ctx.mcp?.name() ?? null,
        ...(ctx.mcp?.bind ? { bindSession: async (root: string) => (await ctx.mcp!.bind!(root, !!a.live))?.name ?? null } : {}),
        sessionKey: ctx.mcp ? null : identity.sessionId,
        progress: ctx.mcp ? undefined : (line) => { if (process.stderr.isTTY) console.error(line); },
      });
      ctx.mcp?.connected({ root: r.root, title: r.title, packId: r.packId, cursor: r.cursor, live: !!a.live });
      // Global leaves an existing project binding alone (plan §8.7): no root to bind.
      return { ...r, root: r.root ?? undefined };
    },
    render: {
      human: (r, a) => {
        const c = r as import("./connect/index").ConnectResult;
        if (a.json) {
          const { cursor: _cursor, brief: _brief, firstPart: _part, ...rest } = c;
          return { out: JSON.stringify(rest, null, 2) };
        }
        const body = c.refresh ? connectRefreshBrief(c) : c.brief + (c.firstPart ? "\n" + c.firstPart : "");
        return { out: body, ...(c.problems.length ? { err: c.problems.map((p) => `connect: ${p}`).join("\n") } : {}) };
      },
      mcp: (r) => {
        const c = r as import("./connect/index").ConnectResult;
        return {
          content: [{ type: "text", text: c.refresh ? connectRefreshBrief(c) : c.brief }],
          structuredContent: { packId: c.packId, briefPath: c.briefPath, bundlePath: c.bundlePath, images: c.images, root: c.root ?? null },
        };
      },
    },
  },
  // --- batch 0: trivial project verbs ------------------------------------------
  {
    name: "list_project", readOnly: true,
    scope: "project",
    core: true,
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
    scope: "project",
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
    name: "config_paths", readOnly: true,
    scope: "machine",
    cli: "config",
    aliases: ["config-paths"],
    summary:
      "Resolve Flux's machine-level paths as JSON: fluxConfigPath (the user's FluxConfig folder), fluxLibPath (the reference library, always <FluxConfig>/FluxLib), contextPath/userContextPath/fluxContextPath (the machine Context layer), plotLibraryPath (the global plot library, <FluxConfig>/plot_library — reusable plots every project's Plot gallery can insert; any folder structure), and userDataDir — plus `build` (version/commit/entry) identifying which Flux build is answering. Before working, read every file in userContextPath (who the user is + their standing rules) and orient via fluxContextPath/README.md.",
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
    scope: "project",
    core: true,
    cli: "set-caption",
    summary:
      "Write a figure's caption. A whole string in the 'Lead. **a**, … **b**, …' convention is split into per-panel blocks; panel:'a' writes one panel, panel:'__ps__' the closing prose.",
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
    name: "get_caption", readOnly: true,
    scope: "project",
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
    scope: "project",
    cli: "set-style",
    cliRoot: "flags",
    summary:
      "Set element-level style on element ids: fill/stroke/strokeWidth/opacity/color/fontSize (canvas px = pt × 4/3), text props (fontFamily/fontWeight/fontStyle/underline/lineHeight/sizing) and the arrangement of the text inside its box (align left|center|right|justify, valign top|middle|bottom — visible while the box is taller than the text, letterSpacing and paragraphSpacing in canvas px), stroke dash (--dash 6,4 in canvas px; --solid clears), per-channel alpha (--fill-opacity / --stroke-opacity 0–1, independent of opacity, which multiplies both), arrowheads for lines AND open paths (--arrow-start/--arrow-end/--no-arrow-*, --arrow-style filled|vee, --arrow-size ×width), plus hidden (omit from canvas + export), locked (not editable on canvas), and name (Layers label).",
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
      align: z.enum(["left", "center", "right", "justify"]).optional(),
      valign: z.enum(["top", "middle", "bottom"]).optional(),
      letterSpacing: z.number().optional(),
      paragraphSpacing: z.number().optional(),
      hidden: z.boolean().optional(),
      locked: z.boolean().optional(),
      name: z.string().optional(),
      dash: z.array(z.number()).optional(),
      fillOpacity: z.number().min(0).max(1).optional(),
      strokeOpacity: z.number().min(0).max(1).optional(),
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
      { kind: "flag", at: "fill-opacity", into: "fillOpacity", as: "number" },
      { kind: "flag", at: "stroke-opacity", into: "strokeOpacity", as: "number" },
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
      { kind: "flag", at: "valign", into: "valign" },
      { kind: "flag", at: "letter-spacing", into: "letterSpacing", as: "number" },
      { kind: "flag", at: "paragraph-spacing", into: "paragraphSpacing", as: "number" },
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
    scope: "project",
    core: true,
    cli: "restyle",
    aliases: ['restyle-part'],
    cliRoot: "flags",
    summary:
      "Restyle a semantic plot or 3D part/group by its stable id. Writes an override that survives regeneration. Omit elementId if the figure has one semantic panel. A 3D mesh fill switches that model to Source colors so it shows.",
    // WS-6.1: the FULL PartOverride surface (the CLI exposed these all along —
    // same core.setPartOverride underneath; the 5-prop schema was drift).
    params: {
      figureId: z.string(),
      partId: z.string(),
      elementId: z.string().optional(),
      noPoster: z.boolean().optional(),
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
      { kind: "flag", at: "no-poster", into: "noPoster", as: "boolean" },
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
      { kind: "flag", at: "show", into: "hidden", const: false },
    ],
    handler: (ctx, a) =>
      core.setPartOverride(ctx.root, s(a.figureId), s(a.partId), pick(a, [...PART_KEYS]), a.elementId as string | undefined, { noPoster: a.noPoster as boolean | undefined }),
    render: {
      human: (r, a) => ({ err: `✓ restyled ${a.partId} on ${(r as { elementId: string }).elementId}${(r as { warnings?: string[] }).warnings?.length ? "\n" + (r as { warnings: string[] }).warnings.join("\n") : ""}` }),
      mcp: (r, a) => text(`restyled ${a.partId} on ${(r as { elementId: string }).elementId}${(r as { warnings?: string[] }).warnings?.length ? "\n" + (r as { warnings: string[] }).warnings.join("\n") : ""}`),
    },
  },
  {
    name: "set_crop",
    scope: "project",
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
    scope: "project",
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
    scope: "project",
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
    scope: "project",
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
    scope: "project",
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
    scope: "project",
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
    scope: "project",
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
    scope: "project",
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
    scope: "project",
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
    scope: "project",
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
    scope: "project",
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
    scope: "project",
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
    scope: "project",
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
    scope: "project",
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
    name: "list_groups", readOnly: true,
    scope: "project",
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
    scope: "project",
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
    scope: "project",
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
    scope: "project",
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
    scope: "project",
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
    scope: "project",
    cli: "add-fig-text",
    cliRoot: "flags",
    summary:
      "Add a text element to a FIGURE (fontSize in canvas px = pt × 4/3; sizing auto = box hugs text, auto-h = wrap at width, fixed = pinned box; align left|center|right|justify, valign top|middle|bottom, letterSpacing/paragraphSpacing in canvas px). panelLabel: true creates a semantic panel label (bold 8 pt, letterable by auto_label).",
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
      align: z.enum(["left", "center", "right", "justify"]).optional(),
      valign: z.enum(["top", "middle", "bottom"]).optional(),
      letterSpacing: z.number().optional(),
      paragraphSpacing: z.number().optional(),
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
      { kind: "flag", at: "valign", into: "valign" },
      { kind: "flag", at: "letter-spacing", into: "letterSpacing", as: "number" },
      { kind: "flag", at: "paragraph-spacing", into: "paragraphSpacing", as: "number" },
      { kind: "flag", at: "sizing", into: "sizing" },
    ],
    handler: (ctx, a) =>
      core.addFigText(
        ctx.root,
        s(a.figureId),
        pick(a, ["text", "panelLabel", "x", "y", "width", "height", "fontSize", "fontWeight", "fontFamily", "color", "align", "valign", "letterSpacing", "paragraphSpacing", "sizing"]) as unknown as Parameters<typeof core.addFigText>[2],
      ),
    render: {
      human: (r) => ({ out: (r as { id: string }).id }),
      mcp: (r, a) => text(`added text ${(r as { id: string }).id} to ${a.figureId}`),
    },
  },
  {
    name: "list_text_styles", readOnly: true,
    scope: "project",
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
    scope: "project",
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
    scope: "project",
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
    scope: "project",
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
    scope: "project",
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
    scope: "project",
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
  // Per-RANGE text formatting (2026-09-25): what the GUI does to selected
  // letters, headless. Offsets are 0-based characters into the element's
  // `text`, `to` exclusive; an out-of-range pair or a non-text id is an error.
  {
    name: "toggle_text_run_style",
    scope: "project",
    cli: "toggle-text-run-style",
    cliRoot: "flags",
    summary:
      "Toggle bold/italic/underline on ONE text element's character range [from, to) (0-based offsets into its text, `to` exclusive): a range that is entirely on turns off, anything else turns on. Runs are stored relative to the element's own look, so a range that merely restates it leaves nothing behind.",
    params: { id: z.string(), from: z.number().int().nonnegative(), to: z.number().int().positive(), which: z.enum(["bold", "italic", "underline"]) },
    cliArgs: [
      { kind: "pos", at: 0, into: "id", required: true },
      { kind: "pos", at: 1, into: "from", required: true, as: "number" },
      { kind: "pos", at: 2, into: "to", required: true, as: "number" },
      { kind: "pos", at: 3, into: "which", required: true },
    ],
    handler: (ctx, a) => core.toggleTextRunStyle(ctx.root, s(a.id), n(a.from), n(a.to), a.which as "bold" | "italic" | "underline"),
    render: {
      human: (_r, a) => ({ err: `✓ toggled ${a.which} on ${a.id}[${a.from}, ${a.to})` }),
      mcp: (_r, a) => text(`toggled ${a.which} on ${a.id}[${a.from}, ${a.to})`),
    },
  },
  {
    name: "toggle_text_run_script",
    scope: "project",
    cli: "toggle-text-run-script",
    cliRoot: "flags",
    summary:
      "Toggle superscript (`super`) or subscript (`sub`) on ONE text element's character range [from, to) (0-based offsets, `to` exclusive): pressing the script the range already has returns it to the baseline; the other script switches it. Glyphs are set at 0.62 of the font size and shifted.",
    params: { id: z.string(), from: z.number().int().nonnegative(), to: z.number().int().positive(), which: z.enum(["super", "sub"]) },
    cliArgs: [
      { kind: "pos", at: 0, into: "id", required: true },
      { kind: "pos", at: 1, into: "from", required: true, as: "number" },
      { kind: "pos", at: 2, into: "to", required: true, as: "number" },
      { kind: "pos", at: 3, into: "which", required: true },
    ],
    handler: (ctx, a) => core.toggleTextRunScript(ctx.root, s(a.id), n(a.from), n(a.to), a.which as "super" | "sub"),
    render: {
      human: (_r, a) => ({ err: `✓ toggled ${a.which}script on ${a.id}[${a.from}, ${a.to})` }),
      mcp: (_r, a) => text(`toggled ${a.which}script on ${a.id}[${a.from}, ${a.to})`),
    },
  },
  {
    name: "set_text_run_color",
    scope: "project",
    cli: "set-text-run-color",
    cliRoot: "flags",
    summary:
      "Paint ONE text element's character range [from, to) (0-based offsets, `to` exclusive) with a colour (#rrggbb), or pass `inherit` to hand the range back to the element's own colour. The rest of the text keeps its colour.",
    params: { id: z.string(), from: z.number().int().nonnegative(), to: z.number().int().positive(), color: z.string() },
    cliArgs: [
      { kind: "pos", at: 0, into: "id", required: true },
      { kind: "pos", at: 1, into: "from", required: true, as: "number" },
      { kind: "pos", at: 2, into: "to", required: true, as: "number" },
      { kind: "pos", at: 3, into: "color", required: true },
    ],
    handler: (ctx, a) => core.setTextRunColor(ctx.root, s(a.id), n(a.from), n(a.to), s(a.color) === "inherit" ? null : s(a.color)),
    render: {
      human: (_r, a) => ({ err: `✓ ${a.color === "inherit" ? "cleared the colour of" : `coloured ${a.color}`} ${a.id}[${a.from}, ${a.to})` }),
      mcp: (_r, a) => text(`${a.color === "inherit" ? "cleared the colour of" : `coloured ${a.color}`} ${a.id}[${a.from}, ${a.to})`),
    },
  },
  {
    name: "set_guides",
    scope: "project",
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
    name: "resize_figure_frame",
    scope: "project",
    cli: "resize-figure-frame",
    cliRoot: "flags",
    summary: "Resize a figure boundary while keeping artwork at its world position. Out-of-bounds content, guides, assets and references are preserved; artwork is never scaled. Coordinates and dimensions are canvas pixels.",
    params: { figureId: z.string(), x: z.number(), y: z.number(), width: z.number().min(1), height: z.number().min(1) },
    cliArgs: [
      { kind: "pos", at: 0, into: "figureId", required: true },
      { kind: "flag", at: "x", into: "x", as: "number" },
      { kind: "flag", at: "y", into: "y", as: "number" },
      { kind: "flag", at: "width", into: "width", as: "number" },
      { kind: "flag", at: "height", into: "height", as: "number" },
    ],
    handler: (ctx, a) => core.resizeFigureFrame(ctx.root, s(a.figureId), { x: Number(a.x), y: Number(a.y), w: Number(a.width), h: Number(a.height) }),
    render: { human: (_r, a) => ({ err: `✓ resized boundary on ${a.figureId}` }), mcp: (_r, a) => text(`resized boundary on ${a.figureId}`) },
  },
  {
    name: "set_figure_layout",
    scope: "project",
    cli: "set-figure-layout",
    cliRoot: "flags",
    summary:
      "Set a figure's frame: position (x,y), size (width,height), background color, and/or name. Only the fields you pass change. Note --name on a family-managed figure routes through identity: a designation (\"Figure S3\") maps to family+number, anything else becomes the nickname — prefer set-figure-family.",
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
    scope: "project",
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
    scope: "project",
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
    scope: "project",
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
    scope: "project",
    core: true,
    pathParams: {"plotPaths": "paths"},
    cli: "compose-figure",
    cliRoot: "flags",
    summary:
      "Assemble plots into ONE labeled multi-panel figure: imports each (semantic when a .fluxplot.json sidecar exists), grid-arranges them, letters the panels (a, b, c…) and writes a caption stub. E.g. 10 analysis plots → Figure 6.",
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
    scope: "project",
    cli: "create-figure",
    cliRoot: "flags",
    summary:
      "Create a blank figure (optionally a clean slug id → @fig-<id>, canvas, size, family identity). Family: figure (default) / supplementary / extended-data / a custom family; number inserts at that position (later figures shift); nickname is the free-text search aid.",
    params: {
      id: z.string().optional(),
      name: z.string().optional(),
      canvasId: z.string().optional(),
      width: z.number().optional(),
      height: z.number().optional(),
      family: z.string().optional(),
      number: z.number().int().min(1).optional(),
      nickname: z.string().optional(),
    },
    cliArgs: [
      { kind: "flag", at: "id", into: "id" },
      { kind: "flag", at: "name", into: "name" },
      { kind: "flag", at: "canvas", into: "canvasId" },
      { kind: "flag", at: "width", into: "width", as: "number" },
      { kind: "flag", at: "height", into: "height", as: "number" },
      { kind: "flag", at: "family", into: "family" },
      { kind: "flag", at: "number", into: "number", as: "number" },
      { kind: "flag", at: "nickname", into: "nickname" },
    ],
    handler: (ctx, a) => core.createFigure(ctx.root, a as Parameters<typeof core.createFigure>[1]),
    render: {
      human: (r) => {
        const c = r as { figureId: string; name: string };
        return { err: `✓ created figure ${c.figureId} (${c.name})` };
      },
      mcp: (r) => {
        const c = r as { figureId: string; name: string };
        return text(`created figure ${c.figureId} (${c.name})`);
      },
    },
  },
  {
    name: "set_figure_family",
    scope: "project",
    cli: "set-figure-family",
    cliRoot: "flags",
    summary:
      "Assign a figure's structured identity: family (figure / supplementary / extended-data / a custom family) and/or number within it (insert-and-shift — the rest of the family renumbers, refs stay valid) and/or nickname (--clear-nickname removes it). The display name derives from family + number.",
    params: {
      figureId: z.string(),
      family: z.string().optional(),
      number: z.number().int().min(1).optional(),
      nickname: z.string().nullable().optional(),
    },
    cliArgs: [
      { kind: "pos", at: 0, into: "figureId", required: true },
      { kind: "flag", at: "family", into: "family" },
      { kind: "flag", at: "number", into: "number", as: "number" },
      { kind: "flag", at: "nickname", into: "nickname" },
      { kind: "flag", at: "clear-nickname", into: "clearNickname", as: "boolean" },
    ],
    handler: (ctx, a) => {
      const nickname = a.clearNickname ? null : (a.nickname as string | undefined);
      if (a.family === undefined && a.number === undefined && nickname === undefined) {
        throw new Error("pass at least one of --family / --number / --nickname / --clear-nickname");
      }
      return core.setFigureIdentity(ctx.root, s(a.figureId), {
        family: a.family as string | undefined,
        number: a.number as number | undefined,
        ...(nickname !== undefined ? { nickname } : {}),
      });
    },
    render: {
      human: (r, a) => {
        const c = r as { name: string; renumbered: number };
        const shifted = c.renumbered ? ` (${c.renumbered} other figure(s) renumbered)` : "";
        return { err: `✓ ${a.figureId} → ${c.name}${shifted}` };
      },
      mcp: (r, a) => {
        const c = r as { name: string; renumbered: number };
        return text(`${a.figureId} → ${c.name}; ${c.renumbered} other figure(s) renumbered`);
      },
    },
  },
  {
    name: "define_figure_family",
    scope: "project",
    cli: "define-figure-family",
    cliRoot: "flags",
    summary:
      'Define (or update) a CUSTOM figure family. Templates use {num} and {panel}: e.g. --id movie --display-name Movie --ref-template "Mov. {num}{panel}" --caption-template "Movie {num} | ". Omitted templates default from the display name.',
    params: {
      id: z.string(),
      displayName: z.string(),
      refTemplate: z.string().optional(),
      captionTemplate: z.string().optional(),
    },
    cliArgs: [
      { kind: "flag", at: "id", into: "id" },
      { kind: "flag", at: "display-name", into: "displayName" },
      { kind: "flag", at: "ref-template", into: "refTemplate" },
      { kind: "flag", at: "caption-template", into: "captionTemplate" },
    ],
    handler: (ctx, a) =>
      core.defineFigureFamily(ctx.root, {
        id: s(a.id),
        displayName: s(a.displayName),
        refTemplate: a.refTemplate as string | undefined,
        captionTemplate: a.captionTemplate as string | undefined,
      }),
    render: {
      human: (r) => {
        const c = r as { id: string; refTemplate: string; captionTemplate: string };
        return { err: `✓ family "${c.id}": in-text "${c.refTemplate}", caption "${c.captionTemplate}"` };
      },
      mcp: (r) => {
        const c = r as { id: string; refTemplate: string; captionTemplate: string };
        return text(`family "${c.id}": in-text "${c.refTemplate}", caption "${c.captionTemplate}"`);
      },
    },
  },
  {
    name: "remove_figure_family",
    scope: "project",
    cli: "remove-figure-family",
    cliRoot: "flags",
    summary:
      "Remove a custom figure family; its member figures move to the main figure family (appended at the end).",
    params: { id: z.string() },
    cliArgs: [{ kind: "pos", at: 0, into: "id", required: true }],
    handler: (ctx, a) => core.removeFigureFamily(ctx.root, s(a.id)),
    render: {
      human: (r, a) => {
        const c = r as { moved: number };
        return { err: `✓ removed family "${a.id}"${c.moved ? ` (${c.moved} figure(s) moved to the figure family)` : ""}` };
      },
      mcp: (r, a) => text(`removed family "${a.id}"; ${(r as { moved: number }).moved} figure(s) moved`),
    },
  },
  {
    name: "import_plots",
    scope: "project",
    pathParams: {"plotPaths": "paths"},
    cli: "import-plots",
    cliRoot: "flags",
    summary:
      "Batch-import multiple SVG plots onto an EXISTING figure (the headless mirror of the GUI's Alt+G multi-insert): each plot resolves its FluxPlot sidecars (semantic when a .fluxplot.json sits next to it), lands at TRUE physical size, and the batch grid-packs into the figure's largest empty region (a single plot centers). Use compose_figure to build a NEW figure instead.",
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
    scope: "project",
    pathParams: {"svgPath": "path"},
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
    scope: "project",
    core: true,
    cli: "sync-figure",
    cliRoot: "flags",
    summary:
      "Refresh figures' plot copies IN PLACE from their regenerated plots/ sources (after rerun_plot): captions, positions and per-part restyles survive; a changed plot size resizes its element and grows the frame when needed.",
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
    name: "get_manuscript", readOnly: true,
    scope: "project",
    core: true,
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
    scope: "project",
    core: true,
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
    name: "list_documents", readOnly: true,
    scope: "project",
    core: true,
    cli: "docs",
    cliRoot: "flags",
    summary: "List the project's documents, including nested paper, legacy manuscript, and Context folders.",
    params: {},
    cliArgs: [],
    handler: (ctx) => core.listDocuments(ctx.root),
    render: {
      human: (r) => ({ out: JSON.stringify(r, null, 2) }),
    },
  },
  {
    name: "create_document",
    scope: "project",
    cli: "new-doc",
    cliRoot: "flags",
    summary: "Create a new blank document (registered in the manifest).",
    params: { name: z.string(), folder: z.string().optional() },
    cliArgs: [{ kind: "rest", at: 0, into: "name", as: "joined", default: "Untitled" }, { kind: "flag", at: "folder", into: "folder" }],
    handler: (ctx, a) => core.createDocument(ctx.root, s(a.name), a.folder as string | undefined),
    render: {
      human: (r) => ({ err: `✓ created ${(r as { path: string }).path}` }),
      mcp: (r) => text(`created ${(r as { path: string }).path}`),
    },
  },
  {
    name: "create_document_folder",
    scope: "project", cli: "new-doc-folder", cliRoot: "flags",
    summary: "Create a folder within Documents or Context.",
    params: { parent: z.string(), name: z.string() },
    cliArgs: [{ kind: "pos", at: 0, into: "parent", required: true }, { kind: "rest", at: 1, into: "name", as: "joined" }],
    handler: (ctx, a) => core.createFolder(ctx.root, s(a.parent), s(a.name)),
    render: { human: r => ({ out: JSON.stringify(r) }) },
  },
  {
    name: "move_document",
    scope: "project",
    notAPath: {"path": "Project document identifier; stored relative to the project", "folder": "Project folder identifier"}, cli: "move-doc", cliRoot: "flags",
    summary: "Move a document to a folder, preserving comments and updating relative document links. Existing destinations are refused.",
    params: { path: z.string(), folder: z.string() },
    cliArgs: [{ kind: "pos", at: 0, into: "path", required: true }, { kind: "pos", at: 1, into: "folder", required: true }],
    handler: (ctx, a) => core.moveDocument(ctx.root, s(a.path), s(a.folder)),
    render: { human: r => ({ out: JSON.stringify(r) }) },
  },
  {
    name: "delete_document",
    scope: "project",
    notAPath: {"path": "Project document identifier; stored relative to the project"},
    cli: "delete-doc",
    cliRoot: "flags",
    summary:
      "Delete a document from the project: its .qmd and its comments sidecar are removed and the manifest forgets it. Legacy main manuscripts and the standard Context documents are protected; new-project documents are all deletable. Figures and references are untouched.",
    params: { path: z.string() },
    cliArgs: [{ kind: "pos", at: 0, into: "path", required: true }],
    handler: (ctx, a) => core.deleteDocument(ctx.root, s(a.path)),
    render: {
      human: (r) => ({ err: `✓ deleted ${(r as { path: string }).path}` }),
      mcp: (r) => text(`deleted ${(r as { path: string }).path}`),
    },
  },
  {
    name: "insert_figure_ref",
    scope: "project",
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
    name: "insert_slide_embed",
    scope: "project", cli: "insert-slide-embed", cliRoot: "flags",
    summary: "Insert an inline slide in a document. Deck and slide IDs are stable references; playback starts at step 0. Optional anchor must occur exactly once; otherwise append. Materializes the static SVG poster.",
    params: { deckId: z.string(), slideId: z.string(), doc: z.string().optional(), width: z.string().optional(), caption: z.string().optional(), anchor: z.string().optional() },
    cliArgs: [
      { kind: "pos", at: 0, into: "deckId", required: true }, { kind: "pos", at: 1, into: "slideId", required: true },
      { kind: "flag", at: "doc", into: "doc" }, { kind: "flag", at: "width", into: "width" },
      { kind: "flag", at: "caption", into: "caption" }, { kind: "flag", at: "anchor", into: "anchor" },
    ],
    handler: (ctx, a) => core.insertSlideEmbed(ctx.root, s(a.deckId), s(a.slideId), { doc: a.doc as string | undefined, width: a.width as string | undefined, caption: a.caption as string | undefined, anchor: a.anchor as string | undefined }),
    render: {
      human: r => ({ err: `✓ inserted ${(r as { id: string }).id} in ${(r as { path: string }).path}` }),
      mcp: r => text(JSON.stringify(r, null, 2)),
    },
  },
  {
    name: "cite_doi",
    scope: "project",
    core: true,
    cli: "cite-doi",
    cliRoot: "flags",
    summary:
      "Fetch a DOI's BibTeX, add it to FluxLib (deduped by DOI) and cite it in this project (references/library.bib). Returns the citekey to use as @key.",
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
    scope: "project",
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
    name: "search_references", readOnly: true,
    scope: "machine",
    core: true,
    cli: "search",
    cliRoot: "flags",
    summary:
      "Search FluxLib, the machine-wide library, with a structured query like 'author:smith year:2020 journal:nature' (fields author, year, journal, title, doi; bare words match any). Cite a hit as @key; hydrated entries carry `enrich` (abstract, topics, citedByCount).",
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
    scope: "project",
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
    scope: "project",
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
    scope: "machine",
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
    scope: "machine",
    pathParams: {"bib": "path", "dataDir": "path"},
    cli: "zotero-sync",
    cliRoot: "flags",
    summary:
      "Pull new references (and their PDFs) from the connected Zotero Better-BibTeX 'Keep updated' auto-export into the machine-global FluxLib. Idempotent + additive: known entries dedupe by DOI/title-signature, PDFs attach for new entries and backfill PDF-less known ones; nothing is written back to Zotero. Uses the machine `zotero` settings (connect in the app: Library → Zotero) unless overridden with bib/dataDir/attach; `save` persists the overrides as the machine settings.",
    params: {
      bib: z.string().optional(),
      dataDir: z.string().optional(),
      attach: z.enum(["copy", "link"]).optional(),
      deferFulltext: z.boolean().optional(),
      force: z.boolean().optional(),
      save: z.boolean().optional(),
    },
    cliArgs: [
      { kind: "flag", at: "bib", into: "bib" },
      { kind: "flag", at: "data-dir", into: "dataDir" },
      { kind: "flag", at: "attach", into: "attach" },
      { kind: "flag", at: "defer-fulltext", into: "deferFulltext", as: "boolean" },
      { kind: "flag", at: "force", into: "force", as: "boolean" },
      { kind: "flag", at: "save", into: "save", as: "boolean" },
    ],
    handler: (_ctx, a) =>
      core.zoteroSync({
        bib: a.bib as string | undefined,
        dataDir: a.dataDir as string | undefined,
        attach: a.attach as "copy" | "link" | undefined,
        deferFulltext: a.deferFulltext as boolean | undefined,
        force: a.force as boolean | undefined,
        save: a.save as boolean | undefined,
      }),
    render: {
      human: (r) => {
        const c = r as Awaited<ReturnType<typeof core.zoteroSync>>;
        if (c.skipped) return { err: `✓ Zotero sync — ${c.line}; --force re-scans\n  ${c.settings.bibPath}` };
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
        if (c.skipped) return text(`Zotero sync: ${c.line} (bib: ${c.settings.bibPath}; pass force=true to re-scan)`);
        return text(
          `Zotero sync: ${c.line} (bib: ${c.settings.bibPath})` +
            (c.report.added.length ? `; added: ${c.report.added.join(", ")}` : "") +
            (c.report.attachFailed.length ? `; PDFs not found for: ${c.report.attachFailed.map((f) => f.key).join(", ")}` : ""),
        );
      },
    },
  },
  {
    name: "grobid",
    scope: "machine",
    cli: "grobid",
    cliRoot: "flags",
    summary:
      "OPTIONAL structured enrichment of the library's PDFs using a local GROBID service — parsed references, in-text citation links, sections, and header metadata, written alongside each paper as grobid.tei.xml + grobid.json. Nothing in Flux requires this: without it every feature behaves exactly as it does today. Runs incrementally (already-current items are skipped) and is resumable. With no flags, reports coverage and whether a service is reachable. `run` enriches; `reproject` re-derives the JSON from stored TEI without needing the service. Setup: docs/integrations/grobid.qmd.",
    params: {
      run: z.boolean().optional(),
      reproject: z.boolean().optional(),
      url: z.string().optional(),
      force: z.boolean().optional(),
      limit: z.number().optional(),
      keys: z.array(z.string()).optional(),
    },
    cliArgs: [
      { kind: "flag", at: "run", into: "run", as: "boolean" },
      { kind: "flag", at: "reproject", into: "reproject", as: "boolean" },
      { kind: "flag", at: "url", into: "url" },
      { kind: "flag", at: "force", into: "force", as: "boolean" },
      { kind: "flag", at: "limit", into: "limit", as: "number" },
      { kind: "flag", at: "keys", into: "keys", as: "csv" },
    ],
    handler: async (_ctx, a) => {
      if (!a.run && !a.reproject) return core.grobidCoverageReport({ url: a.url as string | undefined });
      return core.grobidEnrich({
        url: a.url as string | undefined,
        force: a.force as boolean | undefined,
        reproject: a.reproject as boolean | undefined,
        limit: a.limit as number | undefined,
        keys: a.keys as string[] | undefined,
      });
    },
    render: {
      human: (r) => {
        const any = r as Record<string, unknown>;
        if ("processed" in any) {
          const c = r as Awaited<ReturnType<typeof core.grobidEnrich>>;
          if (c.unavailable) {
            return {
              err:
                `✗ no GROBID service at ${c.url} — ${c.unavailable}\n` +
                `  GROBID is optional; Flux works fully without it. To set it up see docs/integrations/grobid.qmd`,
            };
          }
          // --reproject never contacts the service, so there is no version to name.
          const what = c.grobidVersion
            ? `GROBID ${c.grobidVersion} — enriched ${c.processed.length}`
            : `re-projected ${c.processed.length} from stored TEI`;
          return {
            err:
              `✓ ${what}, skipped ${c.skipped.length} already current, ` +
              `${c.failed.length} failed, of ${c.totalWithPdf} PDFs in ${(c.elapsedMs / 1000).toFixed(1)}s` +
              (c.failed.length ? `\n  failed: ${c.failed.slice(0, 5).map((f) => f.key).join(", ")}` : ""),
          };
        }
        const s = r as Awaited<ReturnType<typeof core.grobidCoverageReport>>;
        return {
          err:
            `GROBID enrichment (optional) — ${s.enriched}/${s.totalWithPdf} papers enriched` +
            (s.stale ? `, ${s.stale} stale` : "") +
            (s.never ? `, ${s.never} never run` : "") +
            (s.failed ? `, ${s.failed} failed` : "") +
            `\n  ${s.references.toLocaleString()} references, ${s.citationsLinked.toLocaleString()} citation links` +
            `\n  service at ${s.url}: ${s.reachable ? `up (${s.version ?? "?"})` : `not reachable — ${s.error ?? "?"}`}` +
            (s.reachable ? "" : `\n  Flux does not need it. Setup: docs/integrations/grobid.qmd`),
        };
      },
      mcp: (r) => text(JSON.stringify(r, null, 2)),
    },
  },
  {
    name: "author_works",
    scope: "machine",
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
    scope: "machine",
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
    name: "list_comments", readOnly: true,
    scope: "project",
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
    scope: "project",
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
      resolveItem(ctx.root, s(a.id), {
        doc: a.doc as string | undefined, note: a.note as string | undefined,
      }, ctx),
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
    scope: "project",
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
        at: a.at as number | undefined, author: inboxAuthor(ctx).name, client: inboxAuthor(ctx).client, session: inboxSession(ctx),
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
  ...INBOX_VERBS,
  {
    name: "ensure_context",
    scope: "project",
    cli: "context-init",
    summary:
      "Ensure missing Context/ documents (ProjectContext.qmd, NOTEBOOK.md, RULES.md) and agent pointers exist. Requires project.json; existing documents are preserved.",
    params: {},
    cliArgs: [],
    handler: (ctx) => core.ensureProjectContext(ctx.root),
    render: {
      human: (r) => {
        const c = r as import("./context").ContextHealResult;
        if (c.skipped) return { err: "Context initialization skipped: not a Flux project (no project.json)" };
        return { err: c.created.length ? `✓ created: ${c.created.join(", ")}` : "✓ Context layer already complete" };
      },
      mcp: (r) => {
        const c = r as import("./context").ContextHealResult;
        if (c.skipped) return text("Context initialization skipped: not a Flux project (no project.json)");
        return text(c.created.length ? `created: ${c.created.join(", ")}` : "Context layer already complete");
      },
    },
  },
  {
    name: "write_log",
    scope: "project",
    core: true,
    pathParams: {"file": "path"},
    cli: "log",    cliRoot: "flags",
    summary:
      "Append a dated entry to the project Log (Context/NOTEBOOK.md), only when the user asks. The byline (agent · surface · host) is added for you.",
    params: {
      text: z.string().optional(),
      file: z.string().optional(),
      title: z.string().optional(),
      agent: z.string().optional(),
      surface: z.string().optional(),
      checkpoint: z.boolean().optional(),
    },
    cliArgs: [
      { kind: "rest", at: 0, into: "text", as: "joined" },
      { kind: "flag", at: "text", into: "text" },
      { kind: "flag", at: "file", into: "file", as: "path" },
      { kind: "flag", at: "title", into: "title" },
      { kind: "flag", at: "agent", into: "agent" },
      { kind: "flag", at: "surface", into: "surface" },
      { kind: "flag", at: "checkpoint", into: "checkpoint", as: "boolean" },
    ],
    handler: (ctx, a) => {
      return core.writeLog(ctx.root, {
        text: a.text as string | undefined,
        file: a.file as string | undefined,
        title: a.title as string | undefined,
        agent: a.agent as string | undefined,
        surface: a.surface as string | undefined,
        checkpoint: a.checkpoint as boolean | undefined,
        identity: ctx.identity,
        cwd: ctx.cwd,
      });
    },
    render: {
      human: (r) => {
        const c = r as import("./context").LogResult;
        return { err: `✓ logged → ${c.rel} (${c.heading})${c.createdSection ? " — Log section created" : ""}` };
      },
      mcp: (r) => {
        const c = r as import("./context").LogResult;
        return text(`logged → ${c.rel} (${c.heading})`);
      },
    },
  },
  {
    name: "read_log", readOnly: true,
    scope: "project",
    core: true,
    cli: "read-log",
    cliRoot: "flags",
    summary: "Read the project Log: the latest entries, from the latest checkpoint, or titles only.",
    params: {
      tail: z.number().int().nonnegative().optional(),
      sinceCheckpoint: z.boolean().optional(),
      titles: z.boolean().optional(),
      json: z.boolean().optional(),
    },
    cliArgs: [
      { kind: "flag", at: "tail", into: "tail", as: "number" },
      { kind: "flag", at: "since-checkpoint", into: "sinceCheckpoint", as: "boolean" },
      { kind: "flag", at: "titles", into: "titles", as: "boolean" },
      { kind: "flag", at: "json", into: "json", as: "boolean" },
    ],
    handler: (ctx, a) => core.readLog(ctx.root, {
      tail: a.tail as number | undefined,
      sinceCheckpoint: a.sinceCheckpoint as boolean | undefined,
      titles: a.titles as boolean | undefined,
    }),
    render: {
      human: (r, a) => {
        const entries = r as import("./context").LogEntry[];
        if (a.json) return { out: JSON.stringify(entries, null, 2) };
        return { out: renderLogEntries(entries, !!a.titles), err: `✓ ${entries.length} Log entr${entries.length === 1 ? "y" : "ies"}` };
      },
      mcp: (r, a) => {
        const entries = r as import("./context").LogEntry[];
        return text(a.json ? JSON.stringify(entries, null, 2) : renderLogEntries(entries, !!a.titles));
      },
    },
  },
  {
    name: "add_highlight",
    scope: "machine",
    cli: "add-highlight",
    cliRoot: "flags",
    summary:
      "Add a highlight/note to a FluxLib paper (items/<citekey>/annotations.json) — the same highlights FluxReader shows the human. `quote` is the exact text to highlight; `prefix`/`suffix` are the surrounding text that disambiguates it on the page (find them in get_paper_text). `page` is 1-based.",
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
        return { err: `✓ highlighted @${a.key} p${c.page} [${c.color}] (${c.id})` };
      },
      mcp: (r, a) => {
        const c = r as { id: string; color: string };
        return text(`added highlight ${c.id} on @${a.key} p${a.page} [${c.color}]`);
      },
    },
  },
  {
    name: "ingest_pdf",
    scope: "machine",
    pathParams: {"filePath": "path"},
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
    scope: "project",
    cli: "compile",
    cliRoot: "flags",
    summary:
      "Compile the chosen document (--doc, otherwise the default) via Quarto (pdf|html|docx). Requires quarto on PATH. --style applies a journal style (e.g. nature) to the OUTPUT only. --zotero-fields writes docx citations as live Zotero fields (editable in Word); --zotero-library takes .docx files already written with Zotero, so citations to the same works arrive linked to that library. Reports the output path and a figures/citations resolution summary.",
    params: {
      to: z.string().optional(),
      doc: z.string().optional(),
      style: z.string().optional(),
      zoteroFields: z.boolean().optional(),
      zoteroLibrary: z.array(z.string()).optional(),
    },
    cliArgs: [
      { kind: "flag", at: "doc", into: "doc" },
      { kind: "flag", at: "to", into: "to" },
      { kind: "flag", at: "style", into: "style" },
      { kind: "flag", at: "zotero-fields", into: "zoteroFields", as: "boolean" },
      { kind: "flag", at: "zotero-library", into: "zoteroLibrary", as: "csv" },
    ],
    handler: (ctx, a) =>
      core.compile(ctx.root, (a.to as string | undefined) ?? "pdf", {
        doc: a.doc as string | undefined,
        style: a.style as string | undefined,
        zoteroFields: a.zoteroFields as boolean | undefined,
        zoteroLibraryDocs: a.zoteroLibrary as string[] | undefined,
      }),
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
        if (c.zotero)
          lines.push(
            `  zotero: ${c.zotero.citations} live citation(s)` +
              (c.zotero.bound ? `, ${c.zotero.bound} linked to a known library` : "") +
              (c.zotero.embedded ? `, ${c.zotero.embedded} embedded` : "") +
              (c.zotero.notesPlain ? `, ${c.zotero.notesPlain} in notes left as text` : ""),
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
        if (c.zotero)
          parts.push(
            `zotero: ${c.zotero.citations} live citation(s)` +
              (c.zotero.bound ? `, ${c.zotero.bound} linked` : "") +
              (c.zotero.embedded ? `, ${c.zotero.embedded} embedded` : "") +
              (c.zotero.notesPlain ? `, ${c.zotero.notesPlain} in notes as text` : ""),
          );
        return text(parts.join(" — "));
      },
    },
  },
  {
    name: "validate_project", readOnly: true,
    scope: "project",
    core: true,
    notAPath: {"file": "Project schema file identifier; confined and stored relative to the project"},
    cli: "validate",
    cliRoot: "flags",
    summary:
      "Validate the project (or one file) against the bundled schemas (.meta/schema/), plus lint: EMPTY figures (they shift figure numbers), figures embedded in no document, overlapping frames. Run after editing files directly.",
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
    name: "validate_plot", readOnly: true,
    scope: "file",
    pathParams: {"svgPath": "path"},
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
    name: "list_dissections", readOnly: true,
    scope: "project",
    cli: "list-dissections",
    // flags-root: the positional is a PLOT (often slash-bearing, e.g. sub/charlie.svg) and
    // must never be eaten by the old root-positional heuristic.
    cliRoot: "flags",
    summary:
      "List a plot's dissections — the companion material in plots/_dissections/<plot>/ (per-subject panels, _stats CSVs, alternative analyses; the Dissect viewer shows subfolders as named groups, loose files as the default group). Pass the plot by key or path (growth, sub/charlie.svg, plots/growth.svg); with no plot, summarize every plot that has a dissection folder. Writing needs no verb — drop files into the folder and an open viewer live-refreshes.",
    params: { plot: z.string().optional() },
    cliArgs: [{ kind: "pos", at: 0, into: "plot" }],
    handler: (ctx, a) => core.listDissections(ctx.root, a.plot === undefined ? undefined : s(a.plot)),
    render: {
      human: (r) => ({ out: JSON.stringify(r, null, 2) }),
    },
  },
  {
    name: "rerun_plot",
    scope: "file",
    core: true,
    pathParams: {"recipePath": "path"},
    cli: "rerun-plot",
    cliRoot: "flags",
    summary:
      "Re-run a plot's recipe: its source script with params (strings, numbers, booleans, or JSON objects such as the __fluxplot__ colour controls — see set_plot_color_scale --regenerate for the guided form). only:true reruns just this recipe's plot when the script saves several (siblings untouched); a string targets named plots.",
    params: {
      recipePath: z.string(),
      params: z.record(z.unknown()).optional(),
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
      core.runRecipe(s(a.recipePath), (a.params ?? {}) as Record<string, unknown>, {
        only: a.only === true ? true : typeof a.only === "string" ? a.only : undefined,
      }),
    render: {
      human: (r) => {
        const c = r as { code: number; svgPath: string; glbPath?: string; stderr: string };
        return {
          err: `✓ recipe exited ${c.code}; wrote ${c.glbPath ?? c.svgPath}` + (c.stderr.trim() ? `\n${c.stderr.trim()}` : ""),
          exit: c.code !== 0 ? c.code : undefined,
        };
      },
      mcp: (r) => {
        const c = r as { code: number; svgPath: string; glbPath?: string; stderr: string };
        // WS-6.1: nonzero exit = the plot did NOT regenerate — report it as an
        // error (the old success-shaped "recipe exited 1" was invisible to agents).
        if (c.code !== 0)
          return { isError: true, content: [{ type: "text", text: `recipe exited ${c.code}\n${String(c.stderr ?? "").slice(-2000)}` }] };
        return text(`recipe exited ${c.code}; wrote ${c.glbPath ?? c.svgPath}`);
      },
    },
  },

  // --- batch E: Flux Slide (deck authoring/animation) ---------------------------
  {
    name: "list_decks", readOnly: true,
    scope: "project",
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
    scope: "project",
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
    scope: "project",
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
        layout: a.layout as NonNullable<Parameters<typeof core.addSlide>[2]>["layout"],
      }),
    render: {
      human: (r, a) => ({ err: `✓ added slide ${(r as { slideId: string }).slideId} to ${a.deckId}` }),
      mcp: (r, a) => text(`added slide ${(r as { slideId: string }).slideId} to ${a.deckId}`),
    },
  },
  {
    name: "delete_slide",
    scope: "project",
    cli: "delete-slide",
    cliRoot: "flags",
    summary: "Delete a slide from a deck. Refuse referenced slides unless --force is given. Returns the id the GUI would select next.",
    params: { deckId: z.string(), slideId: z.string(), force: z.boolean().optional() },
    cliArgs: [
      { kind: "flag", at: "force", into: "force", as: "boolean" },
      { kind: "pos", at: 0, into: "deckId", required: true },
      { kind: "pos", at: 1, into: "slideId", required: true },
    ],
    handler: (ctx, a) => core.deleteSlide(ctx.root, s(a.deckId), s(a.slideId), { force: a.force as boolean | undefined }),
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
    scope: "project",
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
    scope: "project",
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
    scope: "project",
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
    scope: "project",
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
      align: z.enum(["left", "center", "right", "justify"]).optional(),
      valign: z.enum(["top", "middle", "bottom"]).optional(),
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
      { kind: "flag", at: "valign", into: "valign" },
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
        align: a.align as "left" | "center" | "right" | "justify" | undefined,
        valign: a.valign as "top" | "middle" | "bottom" | undefined,
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
    name: "add_slide_model", scope: "project", cli: "add-slide-model", cliRoot: "flags",
    pathParams: { sourcePath: "path" },
    summary: "Import a project-owned GLB or 3D fluxplot into a slide. Preserves the source, keeps model bytes out of deck JSON, and returns elementId, assetId and warnings. Shape states and orbit views animate through ordinary Change tracks.",
    params: { deckId:z.string(), slideId:z.string(), sourcePath:z.string(), name:z.string().optional(),
      x:z.number().optional(), y:z.number().optional(), width:z.number().positive().optional(), height:z.number().positive().optional(), noPoster:z.boolean().optional() },
    cliArgs: [{kind:"pos",at:0,into:"deckId",required:true},{kind:"pos",at:1,into:"slideId",required:true},{kind:"pos",at:2,into:"sourcePath",required:true},
      ...["x","y","width","height"].map(at=>({kind:"flag" as const,at,into:at,as:"number" as const})),
      {kind:"flag",at:"name",into:"name"},{kind:"flag",at:"no-poster",into:"noPoster",as:"boolean"}],
    handler:(ctx,a)=>core.addSlideModel(ctx.root,s(a.deckId),s(a.slideId),s(a.sourcePath),pick(a,["x","y","width","height","name","noPoster"])),
    render:{human:r=>({out:(r as {elementId:string}).elementId,err:(r as {warnings:string[]}).warnings.join("\n")}),mcp:r=>text(JSON.stringify(r))},
  },
  {
    name:"add_turntable",scope:"project",cli:"add-turntable",cliRoot:"flags",
    notAPath:{direction:"clockwise/counterclockwise orbit enum"},
    summary:"Turn a 3D model continuously on one slide step. Writes an ordinary Change with linear timing and unwrapped azimuth. Defaults: one clockwise turn over 6000 ms. Shape-state edits can share the same Change.",
    params:{deckId:z.string(),slideId:z.string(),beatId:z.string(),target:z.string(),turns:z.number().positive().optional(),direction:z.enum(["cw","ccw"]).optional(),durationMs:z.number().positive().optional(),start:z.number().nonnegative().optional()},
    cliArgs:[{kind:"pos",at:0,into:"deckId",required:true},{kind:"pos",at:1,into:"slideId",required:true},{kind:"pos",at:2,into:"beatId",required:true},{kind:"pos",at:3,into:"target",required:true},
      {kind:"flag",at:"turns",into:"turns",as:"number"},{kind:"flag",at:"direction",into:"direction"},{kind:"flag",at:"duration",into:"durationMs",as:"number"},{kind:"flag",at:"start",into:"start",as:"number"}],
    handler:(ctx,a)=>core.addSlideTurntable(ctx.root,s(a.deckId),s(a.slideId),s(a.beatId),s(a.target),pick(a,["turns","direction","durationMs","start"])),
    render:{human:r=>({out:(r as {trackId:string}).trackId}),mcp:r=>text(JSON.stringify(r))},
  },
  {
    name: "add_slide_video",
    scope: "project",
    pathParams: {"sourcePath": "path"}, cli: "add-video", cliRoot: "flags",
    summary: "Import an MP4 or MOV from plots/_videos into a slide. Preserves the source and prepares a portable MP4 plus poster. Starts paused; add a separate videoStart command to begin playback. Returns elementId and assetId.",
    params: { deckId: z.string(), slideId: z.string(), sourcePath: z.string(),
      x: z.number().optional(), y: z.number().optional(), width: z.number().positive().optional(), height: z.number().positive().optional(),
      muted: z.boolean().optional(), loop: z.boolean().optional() },
    cliArgs: [
      { kind: "pos", at: 0, into: "deckId", required: true }, { kind: "pos", at: 1, into: "slideId", required: true },
      { kind: "pos", at: 2, into: "sourcePath", required: true },
      ...["x", "y", "width", "height"].map(at => ({ kind: "flag" as const, at, into: at, as: "number" as const })),
      { kind: "flag", at: "muted", into: "muted", as: "boolean" }, { kind: "flag", at: "loop", into: "loop", as: "boolean" },
    ],
    handler: (ctx, a) => core.addVideoToSlide(ctx.root, s(a.deckId), s(a.slideId), { sourcePath: s(a.sourcePath), ...pick(a, ["x", "y", "width", "height", "muted", "loop"]) }),
    render: { human: r => ({ out: (r as { elementId: string }).elementId }), mcp: r => text(JSON.stringify(r)) },
  },
  {
    name: "set_video_track",
    scope: "project", cli: "set-video-track", cliRoot: "flags",
    summary: "Start, pause, or stop a video clip on a slide step independently of its appearance. Start restarts from the beginning; pause holds the current frame; stop resets to the poster. start is the command offset in milliseconds within the step.",
    params: { deckId: z.string(), slideId: z.string(), beatId: z.string(), target: z.string(), action: z.enum(["start", "pause", "stop"]), start: z.number().nonnegative().optional() },
    cliArgs: [
      { kind: "pos", at: 0, into: "deckId", required: true }, { kind: "pos", at: 1, into: "slideId", required: true },
      { kind: "pos", at: 2, into: "beatId", required: true }, { kind: "pos", at: 3, into: "target", required: true },
      { kind: "pos", at: 4, into: "action", required: true }, { kind: "flag", at: "start", into: "start", as: "number" },
    ],
    handler: (ctx, a) => core.setVideoTrack(ctx.root, s(a.deckId), s(a.slideId), s(a.beatId), s(a.target), a.action as "start" | "pause" | "stop", pick(a, ["start"])),
    render: { human: () => ({ err: "✓ video command saved" }), mcp: () => text("video command saved") },
  },
  {
    name: "set_video_settings",
    scope: "project", cli: "set-video-settings", cliRoot: "flags",
    summary: "Set a slide clip's muted and loop options. These are clip properties, independent of appearance and playback commands.",
    params: { deckId: z.string(), slideId: z.string(), target: z.string(), muted: z.boolean().optional(), loop: z.boolean().optional() },
    cliArgs: [
      { kind: "pos", at: 0, into: "deckId", required: true }, { kind: "pos", at: 1, into: "slideId", required: true },
      { kind: "pos", at: 2, into: "target", required: true }, { kind: "flag", at: "muted", into: "muted", as: "boolean" },
      { kind: "flag", at: "loop", into: "loop", as: "boolean" },
    ],
    handler: (ctx, a) => core.setVideoSettings(ctx.root, s(a.deckId), s(a.slideId), s(a.target), pick(a, ["muted", "loop"])),
    render: { human: () => ({ err: "✓ video settings saved" }), mcp: () => text("video settings saved") },
  },
  {
    name: "add_slide_figure",
    scope: "project",
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
    scope: "project",
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
    scope: "project",
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
    scope: "project",
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
    scope: "project",
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
    scope: "project",
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
    scope: "project",
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
    scope: "project",
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
    name: "anim_style", scope: "project", cli: "anim-style", cliRoot: "flags",
    summary: "Create, set, delete or list deck-local linked animation styles. Deleting materializes every linked track. create requires name, family and preset; set changes only supplied fields. Machine-global presets remain copies.",
    params: {
      action: z.enum(["create", "set", "delete", "list"]), deckId: z.string().min(1), id: z.string().optional(),
      name: z.string().min(1).optional(), family: z.enum(["appearance", "transform", "media"]).optional(),
      preset: z.enum(Object.keys(PRESET_CATALOG) as [PresetName, ...PresetName[]]).optional(),
      duration: z.number().nonnegative().optional(), start: z.number().nonnegative().optional(),
      easing: z.enum(EASING_TOKENS as unknown as [EasingToken, ...EasingToken[]]).optional(),
      curve: z.string().describe(CURVE_GRAMMAR).optional(),
      params: z.record(z.unknown()).optional(),
      influence: z.object({ in: z.number().min(0).max(100), out: z.number().min(0).max(100) }).optional(),
      stagger: staggerSchema.optional(),
      arc: z.number().min(-1).max(1).optional(),
    },
    cliArgs: [
      { kind: "pos", at: 0, into: "action", required: true }, { kind: "pos", at: 1, into: "deckId", required: true }, { kind: "pos", at: 2, into: "id" },
      ...["name", "family", "preset", "easing", "curve"].map(at => ({ kind: "flag" as const, at, into: at })),
      ...["duration", "start", "arc"].map(at => ({ kind: "flag" as const, at, into: at, as: "number" as const })),
      ...["params", "influence", "stagger"].map(at => ({ kind: "flag" as const, at, into: at, as: "json" as const })),
    ],
    handler: (ctx, a) => core.animStyleVerb(ctx.root, s(a.deckId), a.action as "create", {
      id: a.id as string | undefined, name: a.name as string | undefined, family: a.family as "appearance" | undefined,
      track: { ...pick(a, ["preset", "duration", "start", "params", "stagger", "arc"]), ...timingCurveArgs(a) },
    }),
    render: {
      human: (r) => ({ out: JSON.stringify(r) }),
      mcp: (r) => text(JSON.stringify(r)),
    },
  },
  {
    name: "animate_like", scope: "project", cli: "animate-like", cliRoot: "flags",
    summary: "Link target effects to the source effect's deck style, creating a Like <object label> style and linking the source when needed. An optional beatId filters source and targets to one beat; otherwise links slide-wide. Reports each incompatible family or missing target without changing it.",
    params: { deckId: z.string().min(1), slideId: z.string().min(1), from: z.string().min(1), to: z.array(z.string().min(1)).min(1), beatId: z.string().min(1).optional() },
    cliArgs: [
      { kind: "pos", at: 0, into: "deckId", required: true }, { kind: "pos", at: 1, into: "slideId", required: true },
      { kind: "flag", at: "beat", into: "beatId" },
      { kind: "flag", at: "from", into: "from", required: true }, { kind: "flag", at: "to", into: "to", as: "csv", required: true },
    ],
    handler: (ctx, a) => core.animateLikeVerb(ctx.root, s(a.deckId), s(a.slideId), s(a.from), sArr(a.to), a.beatId as string | undefined),
    render: { human: r => ({ out: JSON.stringify(r) }), mcp: r => text(JSON.stringify(r)) },
  },
  {
    name: "set_track", scope: "project", cli: "set-track", cliRoot: "flags",
    summary: "Edit a track's linked style, same-beat timing anchor, or timing overrides. anchor is trackId:start|end[:offsetMs]. noStyle materializes inherited fields; noAnchor retains the resolved start. start on an anchored track edits its offset. Stagger Each/Total are exclusive; the distribution uses the clamped curve grammar. Random order uses seed (default: stable track-id hash). staggerBy orders the ramp: index (target order), x / y (data position), data or value (each part's data-value: a hexagon's mean, a cell's value, a bar's height), count (observations per hexagon), data-index.",
    params: {
      deckId: z.string().min(1), slideId: z.string().min(1), trackId: z.string().min(1),
      staggerEach: z.number().nonnegative().optional(), staggerTotal: z.number().nonnegative().optional(),
      staggerCurve: z.string().optional(), staggerFrom: z.enum(["start", "end", "center", "edges", "random"]).optional(),
      staggerBy: z.enum(["index", "x", "y", "data", "value", "count", "data-index"]).optional(),
      seed: z.number().int().min(0).max(0xffffffff).optional(),
      styleId: z.string().optional(), noStyle: z.boolean().optional(), anchor: z.string().optional(), noAnchor: z.boolean().optional(),
      start: z.number().nonnegative().optional(), duration: z.number().nonnegative().optional(),
      easing: z.enum(EASING_TOKENS as unknown as [EasingToken, ...EasingToken[]]).optional(),
      curve: z.string().describe(CURVE_GRAMMAR).optional(),
    },
    cliArgs: [
      { kind: "flag", at: "stagger-each", into: "staggerEach", as: "number" },
      { kind: "flag", at: "stagger-total", into: "staggerTotal", as: "number" },
      { kind: "flag", at: "stagger-curve", into: "staggerCurve" },
      { kind: "flag", at: "stagger-from", into: "staggerFrom" },
      { kind: "flag", at: "stagger-by", into: "staggerBy" },
      { kind: "flag", at: "seed", into: "seed", as: "number" },
      { kind: "pos", at: 0, into: "deckId", required: true }, { kind: "pos", at: 1, into: "slideId", required: true }, { kind: "pos", at: 2, into: "trackId", required: true },
      { kind: "flag", at: "style", into: "styleId" }, { kind: "flag", at: "no-style", into: "noStyle", as: "boolean" },
      { kind: "flag", at: "anchor", into: "anchor" }, { kind: "flag", at: "no-anchor", into: "noAnchor", as: "boolean" },
      { kind: "flag", at: "start", into: "start", as: "number" }, { kind: "flag", at: "duration", into: "duration", as: "number" }, { kind: "flag", at: "easing", into: "easing" },
      { kind: "flag", at: "curve", into: "curve" },
    ],
    handler: (ctx, a) => {
      if (a.styleId !== undefined && a.noStyle || a.anchor !== undefined && a.noAnchor) throw new ValidationError("Choose a link or its detach flag, not both");
      const patch: Parameters<typeof core.setTrackVerb>[4] = { ...pick(a, ["start", "duration"]), ...timingCurveArgs(a) };
      if (["staggerEach", "staggerTotal", "staggerCurve", "staggerFrom", "staggerBy", "seed"].some(k => a[k] !== undefined)) {
        const stagger: NonNullable<typeof patch.stagger> = {};
        if (a.staggerEach !== undefined) stagger.perMs = n(a.staggerEach);
        if (a.staggerTotal !== undefined) stagger.totalMs = n(a.staggerTotal);
        if (a.staggerFrom !== undefined) stagger.from = a.staggerFrom as typeof stagger.from;
        if (a.staggerBy !== undefined) {
          // the CLI spelling: value / count / data-index name the data keys, the rest are the axes
          const by = s(a.staggerBy);
          stagger.by = by === "value" ? { key: "value" } : by === "count" ? { key: "count" } : by === "data-index" ? { key: "index" } : by as "index" | "x" | "y" | "data";
        }
        if (a.seed !== undefined) stagger.seed = n(a.seed);
        if (a.staggerCurve !== undefined) {
          const curve = parseCurve(s(a.staggerCurve));
          if (!curve) throw new ValidationError("Invalid stagger curve");
          stagger.curve = curve;
        }
        patch.stagger = stagger;
      }
      if (a.noStyle) patch.styleId = null; else if (a.styleId !== undefined) patch.styleId = s(a.styleId);
      if (a.noAnchor) patch.anchor = null;
      else if (a.anchor !== undefined) {
        const match = /^(.+):(start|end)(?::(-?(?:\d+(?:\.\d*)?|\.\d+)))?$/.exec(s(a.anchor));
        if (!match || !Number.isFinite(Number(match[3] ?? 0))) throw new ValidationError("anchor must be trackId:start|end[:offsetMs]");
        patch.anchor = { trackId: match[1], edge: match[2] as "start" | "end", ...(match[3] !== undefined ? { offsetMs: Number(match[3]) } : {}) };
      }
      return core.setTrackVerb(ctx.root, s(a.deckId), s(a.slideId), s(a.trackId), patch);
    },
    render: {
      human: r => ({ out: core.renderTrackTiming(r as Awaited<ReturnType<typeof core.setTrackVerb>>) }),
      mcp: r => text(core.renderTrackTiming(r as Awaited<ReturnType<typeof core.setTrackVerb>>)),
    },
  },
  {
    name: "align_tracks", scope: "project", cli: "align-tracks", cliRoot: "flags",
    summary: "Align tracks' resolved start or end edge (end includes the stagger tail) to a time in ms or to another track's edge (to = trackId[:start|end], default the same edge) — the Animator's Alt+A / Alt+D. Default moves each track and keeps its duration; resize keeps the opposite edge. Starts clamp at 0, durations at 1 ms; a moved start detaches a timing anchor and overrides a linked style's start. beatId is a step id or 0-based index (default: the first track's step).",
    params: {
      deckId: z.string().min(1), slideId: z.string().min(1), trackIds: z.array(z.string().min(1)).min(1),
      edge: z.enum(["start", "end"]), to: z.union([z.number().nonnegative(), z.string().min(1)]),
      beatId: z.string().min(1).optional(), resize: z.boolean().optional(),
    },
    cliArgs: [
      { kind: "pos", at: 0, into: "deckId", required: true }, { kind: "pos", at: 1, into: "slideId", required: true },
      { kind: "flag", at: "tracks", into: "trackIds", as: "csv", required: true }, { kind: "flag", at: "edge", into: "edge", required: true },
      { kind: "flag", at: "to", into: "to", required: true }, { kind: "flag", at: "beat", into: "beatId" },
      { kind: "flag", at: "resize", into: "resize", as: "boolean" },
    ],
    handler: (ctx, a) => core.alignTracksVerb(ctx.root, s(a.deckId), s(a.slideId), sArr(a.trackIds), a.edge as "start" | "end", a.to as string | number,
      { beat: a.beatId as string | undefined, resize: !!a.resize }),
    render: {
      human: r => ({ out: JSON.stringify(r) }),
      mcp: r => text(JSON.stringify(r)),
    },
  },
  {
    name: "inherit_track", scope: "project", cli: "inherit-track", cliRoot: "flags",
    summary: "Give target tracks the source track's exact animation parameters — the Animator's Ctrl+Alt-drag Inherit. A linked source links the targets to its style (plus the source's own overrides); otherwise its resolved duration, timing curve and stagger are copied, and within one family and phase also its preset, params and arc. Bindings, endpoints, anchors, groups and enabled state never travel; start is copied only with includeStart. Video commands and animations refuse each other.",
    params: {
      deckId: z.string().min(1), slideId: z.string().min(1), from: z.string().min(1), to: z.array(z.string().min(1)).min(1),
      beatId: z.string().min(1).optional(), includeStart: z.boolean().optional(),
    },
    cliArgs: [
      { kind: "pos", at: 0, into: "deckId", required: true }, { kind: "pos", at: 1, into: "slideId", required: true },
      { kind: "flag", at: "from", into: "from", required: true }, { kind: "flag", at: "to", into: "to", as: "csv", required: true },
      { kind: "flag", at: "beat", into: "beatId" }, { kind: "flag", at: "include-start", into: "includeStart", as: "boolean" },
    ],
    handler: (ctx, a) => core.inheritTrackVerb(ctx.root, s(a.deckId), s(a.slideId), s(a.from), sArr(a.to), { beat: a.beatId as string | undefined, includeStart: !!a.includeStart }),
    render: {
      human: r => ({ out: JSON.stringify(r) }),
      mcp: r => text(JSON.stringify(r)),
    },
  },
  {
    name: "set_plot_view", scope: "project", cli: "set-plot-view", cliRoot: "flags",
    notAPath: { target: "Figure id or deckId/slideId, not a filesystem path" },
    summary: "Set a plot's data view in data units. target is a figureId or deckId/slideId. A slide --beat edits that step's Change endpoint; without it edit Design. Omitted fields are preserved, --reset restores generator defaults. Lines, points, bars, cells, hexagons and existing guides re-project; ticks are regenerated for the new domain; reference lines stay put. A twin value axis (fluxplot axes[].y2 / .x2 — ax.twinx(), a secondary axis) has its own --y2-min/--y2-max/--y2-scale (--x2-…).",
    params: {
      target: z.string(), elementId: z.string(), beatId: z.string().optional(),
      xMin: z.number().finite().optional(), xMax: z.number().finite().optional(),
      yMin: z.number().finite().optional(), yMax: z.number().finite().optional(),
      xScale: z.enum(["linear", "log"]).optional(), yScale: z.enum(["linear", "log"]).optional(),
      y2Min: z.number().finite().optional(), y2Max: z.number().finite().optional(), y2Scale: z.enum(["linear", "log"]).optional(),
      x2Min: z.number().finite().optional(), x2Max: z.number().finite().optional(), x2Scale: z.enum(["linear", "log"]).optional(),
      reset: z.boolean().optional(),
    },
    cliArgs: [
      { kind: "pos", at: 0, into: "target", required: true },
      { kind: "pos", at: 1, into: "elementId", required: true },
      { kind: "flag", at: "beat", into: "beatId" },
      { kind: "flag", at: "x-min", into: "xMin", as: "number" },
      { kind: "flag", at: "x-max", into: "xMax", as: "number" },
      { kind: "flag", at: "y-min", into: "yMin", as: "number" },
      { kind: "flag", at: "y-max", into: "yMax", as: "number" },
      { kind: "flag", at: "x-scale", into: "xScale" },
      { kind: "flag", at: "y-scale", into: "yScale" },
      { kind: "flag", at: "y2-min", into: "y2Min", as: "number" },
      { kind: "flag", at: "y2-max", into: "y2Max", as: "number" },
      { kind: "flag", at: "y2-scale", into: "y2Scale" },
      { kind: "flag", at: "x2-min", into: "x2Min", as: "number" },
      { kind: "flag", at: "x2-max", into: "x2Max", as: "number" },
      { kind: "flag", at: "x2-scale", into: "x2Scale" },
      { kind: "flag", at: "reset", into: "reset", as: "boolean" },
    ],
    handler: (ctx, a) => {
      const { target, elementId, ...fields } = a;
      return core.setPlotViewVerb(ctx.root, s(target), s(elementId), fields as PlotViewFields & { beatId?: string });
    },
    render: {
      human: (r) => ({ out: JSON.stringify(r) }),
      mcp: (r) => text(JSON.stringify(r)),
    },
  },
  {
    name: "set_plot_color_scale", scope: "project", cli: "set-plot-color-scale", cliRoot: "flags",
    notAPath: { target: "Figure id or deckId/slideId, not a filesystem path" },
    summary: "Recolour a plot's colour scale LIVE, in data units, without touching the source: colormap (any map fluxplot ships, e.g. viridis, crameri.batlow, cmr.ember, or *_r), reversed, norm kind (within the scale's editable.normKinds), vmin/vmax, center (twoslope/centered), gamma (power), linthresh/linscale (symlog), extend. target is a figureId or deckId/slideId; --scale names the scale when the plot has several; a slide --beat writes that step's Change endpoint (the colours tween), without it edit Design. Omitted fields are preserved, null restores one field's generated value, --reset restores the whole scale. --regenerate (figure targets) also writes the complete v2 __fluxplot__ control into the recipe, re-runs it, refreshes the figure's copies and clears the live override. Raster scales (images, contourf) accept only --regenerate edits. get_plot_color_scales lists what a plot has.",
    params: {
      target: z.string(), elementId: z.string(), scaleId: z.string().optional(), beatId: z.string().optional(),
      cmap: z.string().nullable().optional(), reversed: z.boolean().nullable().optional(),
      norm: z.enum(["linear", "log", "symlog", "power", "twoslope", "centered"]).nullable().optional(),
      vmin: z.number().finite().nullable().optional(), vmax: z.number().finite().nullable().optional(), vcenter: z.number().finite().nullable().optional(),
      gamma: z.number().finite().nullable().optional(), linthresh: z.number().finite().nullable().optional(), linscale: z.number().finite().nullable().optional(),
      extend: z.enum(["neither", "min", "max", "both"]).nullable().optional(),
      reset: z.boolean().optional(), regenerate: z.boolean().optional(),
    },
    cliArgs: [
      { kind: "pos", at: 0, into: "target", required: true },
      { kind: "pos", at: 1, into: "elementId", required: true },
      { kind: "flag", at: "scale", into: "scaleId" },
      { kind: "flag", at: "beat", into: "beatId" },
      { kind: "flag", at: "cmap", into: "cmap" },
      { kind: "flag", at: "reversed", into: "reversed", as: "boolean" },
      { kind: "flag", at: "norm", into: "norm" },
      { kind: "flag", at: "vmin", into: "vmin", as: "number" },
      { kind: "flag", at: "vmax", into: "vmax", as: "number" },
      { kind: "flag", at: "center", into: "vcenter", as: "number" },
      { kind: "flag", at: "gamma", into: "gamma", as: "number" },
      { kind: "flag", at: "linthresh", into: "linthresh", as: "number" },
      { kind: "flag", at: "linscale", into: "linscale", as: "number" },
      { kind: "flag", at: "extend", into: "extend" },
      { kind: "flag", at: "reset", into: "reset", as: "boolean" },
      { kind: "flag", at: "regenerate", into: "regenerate", as: "boolean" },
    ],
    handler: (ctx, a) => {
      const { target, elementId, ...fields } = a;
      return core.setPlotColorScaleVerb(ctx.root, s(target), s(elementId), fields as ColorScaleVerbFields);
    },
    render: {
      human: (r) => ({ out: JSON.stringify(r) }),
      mcp: (r) => text(JSON.stringify(r)),
    },
  },
  {
    name: "get_plot_color_scales", readOnly: true, scope: "project", cli: "get-plot-color-scales", cliRoot: "flags",
    notAPath: { target: "Figure id or deckId/slideId, not a filesystem path" },
    summary: "List a plot's colour scales (fluxplot ≥ 0.3.1): id, label, recolor mode (live or raster), what is editable, the norm kinds it may switch to, the generated colormap and norm, the live view held by the target (a figure, a deck's Design, or a --beat's resolved state) and the effective norm with any issues.",
    params: { target: z.string(), elementId: z.string(), beatId: z.string().optional() },
    cliArgs: [
      { kind: "pos", at: 0, into: "target", required: true },
      { kind: "pos", at: 1, into: "elementId", required: true },
      { kind: "flag", at: "beat", into: "beatId" },
    ],
    handler: (ctx, a) => core.getPlotColorScales(ctx.root, s(a.target), s(a.elementId), a.beatId as string | undefined),
    render: {
      human: (r) => ({ out: JSON.stringify(r, null, 2) }),
      mcp: (r) => text(JSON.stringify(r)),
    },
  },
  {
    name: "get_plot_data", readOnly: true, scope: "project", cli: "get-plot-data", cliRoot: "flags",
    notAPath: { target: "Figure id or deckId/slideId, not a filesystem path" },
    summary: "Read a plot's DATA from its fluxplot manifest instead of squinting at a PNG: every series with exact nullable x/y, per-point ids and its colour; fluxplot's payloads (hexmatrix bins with count/value/x/y per hexagon, glowbar and fluxbox statistics, histogram distributions, heatmap/contour field values and levels, image channels, bands, bars); the colour scales (tables only with --fields lut); axis domains and scales; overlays (a significance bracket with the test, p and effect size behind it). --series narrows to one series; --fields to sections (series,colorScales,axes,overlays,guides,style). Arrays longer than --limit (default 1000, max 10000) are windowed from --offset and every cut is listed in `pages` with its true length: page through big data instead of pulling it whole.",
    params: { target: z.string(), elementId: z.string().optional(), seriesId: z.string().optional(), fields: z.union([z.string(), z.array(z.string())]).optional(), offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(10000).optional() },
    cliArgs: [
      { kind: "pos", at: 0, into: "target", required: true },
      { kind: "pos", at: 1, into: "elementId" },
      { kind: "flag", at: "series", into: "seriesId" },
      { kind: "flag", at: "fields", into: "fields" },
      { kind: "flag", at: "offset", into: "offset", as: "number" },
      { kind: "flag", at: "limit", into: "limit", as: "number" },
    ],
    handler: (ctx, a) => {
      const fields = typeof a.fields === "string" ? a.fields.split(",") : Array.isArray(a.fields) ? (a.fields as string[]) : undefined;
      return core.getPlotData(ctx.root, s(a.target), a.elementId as string | undefined, { seriesId: a.seriesId as string | undefined, fields, offset: a.offset as number | undefined, limit: a.limit as number | undefined });
    },
    render: {
      human: (r) => ({ out: JSON.stringify(r, null, 2) }),
      mcp: (r) => text(JSON.stringify(r)),
    },
  },
  {
    name: "set_series_color", scope: "project", cli: "set-series-color", cliRoot: "flags",
    notAPath: { target: "Figure id or deckId/slideId, not a filesystem path" },
    summary: "Give a whole plot series one colour: its line (stroke), points (face + edge), bars / band (fill), error bars, and its legend swatch — one override per part, all surviving regeneration (restyle_part colours ONE part; this colours the series and keeps the key honest). target is a figureId (elementId optional when it has one plot) or deckId/slideId (the slide's Design). color is #rrggbb; --clear (or color null) restores the generated colours. A colour-mapped series (a heatmap, hexmatrix, scatter c=) is refused: edit its colour scale with set_plot_color_scale.",
    params: { target: z.string(), elementId: z.string().optional(), seriesId: z.string(), color: z.string().nullable().optional(), clear: z.boolean().optional() },
    cliArgs: [
      { kind: "pos", at: 0, into: "target", required: true },
      { kind: "pos", at: 1, into: "seriesId", required: true },
      { kind: "pos", at: 2, into: "color" },
      { kind: "flag", at: "element", into: "elementId" },
      { kind: "flag", at: "clear", into: "clear", as: "boolean" },
    ],
    handler: (ctx, a) => {
      const colour = a.clear ? null : a.color == null ? null : s(a.color);
      if (!a.clear && a.color == null) throw new ValidationError("Pass a colour (#rrggbb) or --clear.");
      return core.setSeriesColorVerb(ctx.root, s(a.target), a.elementId as string | undefined, s(a.seriesId), colour);
    },
    render: {
      human: (r) => ({ err: `✓ ${(r as { seriesId: string }).seriesId}: ${(r as { color: string | null }).color ?? "generated colours"} on ${(r as { parts: unknown[] }).parts.length} part(s) of ${(r as { elementId: string }).elementId}` }),
      mcp: (r) => text(JSON.stringify(r)),
    },
  },
  {
    name: "set_transform",
    scope: "project",
    cli: "set-transform",
    cliRoot: "flags",
    summary:
      "Add or update THE transform track for an element on a beat (max one per complete source TargetRef per beat — chain across beats). `state` is a sparse element-property patch vs the track's pre-state (t1 = document state ⊕ earlier transforms): {x, y, width, height, rotation, opacity, fill, stroke, text, …}; null deletes a prop at t2; merged over the existing patch unless `replaceState`. For plots, `toAssetId` changes content: shared semantic parts tween and unmatched parts fade. For 3D models, compatible topology morphs and incompatible topology crossfades; known original model source receipts persist and bare targets clear old provenance. Explicit source paths persist automatically. `state.view` changes data-unit axis limits/scales; `state.colorScale` ({scaleId: {cmap, reversed, norm:{kind, vmin, vmax, …}, extend}}) recolours a plot's colour scale in data units (set_plot_color_scale --beat is the guided form). Playback tweens t1→t2 with OKLab colors, arc-length path resampling, and digit-tweened numeric text.",
    params: {
      deckId: z.string(),
      slideId: z.string(),
      beatId: z.string(),
      target: z.string(),
      state: z.record(z.any()).optional(),
      replaceState: z.boolean().optional(),
      start: z.number().optional(),
      duration: z.number().optional(),
      easing: z.enum(EASING_TOKENS as unknown as [EasingToken, ...EasingToken[]]).optional(),
      curve: z.string().describe(CURVE_GRAMMAR).optional(),
      arc: z.number().min(-1).max(1).optional(),
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
      { kind: "flag", at: "curve", into: "curve" },
      { kind: "flag", at: "arc", into: "arc", as: "number" },
      { kind: "flag", at: "to-asset", into: "toAssetId" },
    ],
    handler: (ctx, a) =>
      core.setTransformTrack(ctx.root, s(a.deckId), s(a.slideId), s(a.beatId), s(a.target), {
        ...(a.state != null ? { state: a.state as Record<string, unknown> } : {}),
        ...(a.replaceState ? { replaceState: true } : {}),
        ...(a.start != null ? { start: a.start as number } : {}),
        ...(a.duration != null ? { duration: a.duration as number } : {}),
        ...timingCurveArgs(a),
        ...(a.arc !== undefined ? { arc: n(a.arc) } : {}),
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
    name: "ghost_transform",
    scope: "project",
    cli: "ghost-transform",
    cliRoot: "flags",
    summary: "Create independent ghost copies of an object at a build step. Copies start from the source's state before that step and transform to their own sparse endpoint patches. count defaults to 3 (1–32); original is stay, disappear, or transform. states supplies one endpoint patch per copy; originalState edits the original when original=transform. Returns elementIds and trackIds for later editing; copies persist for later steps and remain absent before their birth.",
    params: {
      deckId: z.string(), slideId: z.string(), beatId: z.string(), sourceId: z.string(),
      count: z.number().int().min(1).max(32).optional(),
      original: z.enum(["stay", "disappear", "transform"]).optional(),
      states: z.array(z.record(z.any())).optional(), originalState: z.record(z.any()).optional(),
      start: z.number().min(0).optional(), duration: z.number().min(0).optional(),
      easing: z.enum(EASING_TOKENS as unknown as [EasingToken, ...EasingToken[]]).optional(),
    },
    cliArgs: [
      { kind: "pos", at: 0, into: "deckId", required: true },
      { kind: "pos", at: 1, into: "slideId", required: true },
      { kind: "pos", at: 2, into: "beatId", required: true },
      { kind: "pos", at: 3, into: "sourceId", required: true },
      { kind: "flag", at: "count", into: "count", as: "number" },
      { kind: "flag", at: "original", into: "original" },
      { kind: "flag", at: "states", into: "states", as: "json" },
      { kind: "flag", at: "original-state", into: "originalState", as: "json" },
      { kind: "flag", at: "start", into: "start", as: "number" },
      { kind: "flag", at: "duration", into: "duration", as: "number" },
      { kind: "flag", at: "easing", into: "easing" },
    ],
    handler: (ctx, a) => core.addGhostTransform(ctx.root, s(a.deckId), s(a.slideId), s(a.beatId), s(a.sourceId), {
      count: a.count as number | undefined, original: a.original as "stay" | "disappear" | "transform" | undefined,
      states: a.states as Record<string, unknown>[] | undefined, originalState: a.originalState as Record<string, unknown> | undefined,
      start: a.start as number | undefined, duration: a.duration as number | undefined,
      easing: a.easing as "smooth" | undefined,
    }),
    render: {
      human: (r) => ({ out: JSON.stringify(r), err: `✓ created ${(r as { elementIds: string[] }).elementIds.length} ghost copies` }),
      mcp: (r) => text(JSON.stringify(r)),
    },
  },
  {
    name: "group_tracks",
    scope: "project",
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
    scope: "project",
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
    scope: "project",
    cli: "cascade-tracks",
    cliRoot: "flags",
    summary:
      "Cascade one timing property across animation tracks: the track at rank k (0-indexed) gets value + delta·step, where step = k with --first-fixed, else k+1; --factor switches to multiplicative (value · factor^step). property ∈ start|duration|influence.in|influence.out|curve.bounce|stagger.perMs|stagger.totalMs|arc. --order timeline (beat index, then lane — the default) or list (the given track order). Clamps: start ≥ 0 ms, duration ≥ 50 ms, influence 0–100 (both-zero deletes the velocity profile), spring bounce −0.5…0.8 (only spring tracks rank), stagger ≥ 0 (only stagger-bearing tracks rank), arc −1…1 (only transform tracks rank). GUI: ⌃⇧C in the animator with ≥2 tracks selected.",
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
    scope: "project",
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
    scope: "project",
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
    scope: "project",
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
    scope: "project",
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
    scope: "project",
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
    name: "become",
    scope: "project",
    cli: "become",
    cliRoot: "flags",
    summary:
      "Become another object or plot parts at a build step. Loose drawn destinations default to Consume: their evaluated endpoint replaces the source and they are deleted. Plots, images, models and part sets default to hand-off: keep both objects, hide the source after the flight and reveal the live destination. Use sourcePart for a part-set source, part for destination parts, and mode to choose completion. A destination SET (several objects and/or plot parts, from any plots) is to (repeatable element ids) or members ([{element, parts?}]); a set always hands off and the source splits across its members. Pair controls correspondence; reveal chooses flip or draw. For a whole plot or model source, asset replaces content in the same frame. Plots without shared tweenable data require force. Model topology determines morph:true or a valid crossfade with morph:false and reason; shape states are simpler for one mesh with named shapes.",
    params: {
      deckId: z.string(),
      slideId: z.string(),
      beatId: z.string(),
      sourceId: z.string(),
      target: z.string().optional(),
      to: z.array(z.string().min(1)).min(1).optional(),
      members: z.array(z.object({ element: z.string().min(1), parts: z.array(z.string().min(1)).min(1).optional() }).strict()).min(1).optional(),
      asset: z.string().optional(),
      part: z.array(z.string().min(1)).min(1).optional(),
      sourcePart: z.array(z.string().min(1)).min(1).optional(),
      mode: z.enum(["consume", "handoff"]).optional(),
      pair: z.enum(PAIR_POLICY_IDS).optional(),
      reveal: z.enum(["flip", "draw"]).optional(),
      method: z.enum(TRANSFORM_METHOD_IDS).optional(),
      start: z.number().min(0).optional(),
      duration: z.number().min(0).optional(),
      easing: z.enum(EASING_TOKENS as unknown as [EasingToken, ...EasingToken[]]).optional(),
      force: z.boolean().optional(),
    },
    cliArgs: [
      { kind: "pos", at: 0, into: "deckId", required: true },
      { kind: "pos", at: 1, into: "slideId", required: true },
      { kind: "pos", at: 2, into: "beatId", required: true },
      { kind: "pos", at: 3, into: "sourceId", required: true },
      { kind: "flag", at: "target", into: "target" },
      { kind: "flag", at: "to", into: "to", repeat: true },
      { kind: "flag", at: "members", into: "members", as: "json" },
      { kind: "flag", at: "asset", into: "asset" },
      { kind: "flag", at: "part", into: "part", as: "csv" },
      { kind: "flag", at: "source-part", into: "sourcePart", as: "csv" },
      { kind: "flag", at: "mode", into: "mode" },
      { kind: "flag", at: "pair", into: "pair" },
      { kind: "flag", at: "reveal", into: "reveal" },
      { kind: "flag", at: "method", into: "method" },
      { kind: "flag", at: "start", into: "start", as: "number" },
      { kind: "flag", at: "duration", into: "duration", as: "number" },
      { kind: "flag", at: "easing", into: "easing" },
      { kind: "flag", at: "force", into: "force", as: "boolean" },
    ],
    handler: (ctx, a) =>
      core.become(ctx.root, s(a.deckId), s(a.slideId), s(a.beatId), s(a.sourceId), {
        ...(a.target != null ? { targetId: s(a.target) } : {}),
        ...(a.to != null || a.members != null ? { members: [...((a.to as string[] | undefined) ?? []).map(element => ({ element })), ...((a.members as TargetRef[] | undefined) ?? [])] } : {}),
        ...(a.asset != null ? { assetId: s(a.asset) } : {}),
        ...(a.part != null ? { parts: a.part as string[] } : {}),
        ...(a.sourcePart != null ? { sourceParts: a.sourcePart as string[] } : {}),
        ...(a.mode != null ? { mode: a.mode as "consume" | "handoff" } : {}),
        ...(a.pair != null ? { pair: a.pair as PairPolicy } : {}),
        ...(a.reveal != null ? { reveal: a.reveal as "flip" | "draw" } : {}),
        ...(a.method != null ? { method: a.method as TransformMethod } : {}),
        ...(a.start != null ? { start: a.start as number } : {}),
        ...(a.duration != null ? { duration: a.duration as number } : {}),
        ...(a.easing != null ? { easing: a.easing as "smooth" } : {}),
        ...(a.force ? { force: true } : {}),
      }),
    render: {
      human: (r, a) => ({
        out: (r as { trackId: string }).trackId,
        err: `✓ ${a.sourceId} ${becomeDestination(r, a)} (beat ${a.beatId})${modelMorphSummary(r)}`,
      }),
      mcp: (r, a) => text(`transform track ${(r as { trackId: string }).trackId}: ${a.sourceId} ${becomeDestination(r, a)} (beat ${a.beatId})${modelMorphSummary(r)}`),
    },
  },
  {
    name: "swap_become",
    scope: "project",
    cli: "swap-become",
    cliRoot: "flags",
    summary: "Swap direction of a hand-off Become. Retains both objects, authored timing, style and follower anchors; refuses group sources, ghost births, missing outlines and conflicting transforms.",
    params: { deckId: z.string(), slideId: z.string(), trackId: z.string() },
    cliArgs: [
      { kind: "pos", at: 0, into: "deckId", required: true },
      { kind: "pos", at: 1, into: "slideId", required: true },
      { kind: "pos", at: 2, into: "trackId", required: true },
    ],
    handler: (ctx, a) => core.swapBecomeVerb(ctx.root, s(a.deckId), s(a.slideId), s(a.trackId)),
    render: {
      human: r => ({ out: (r as { trackId: string }).trackId, err: "✓ swapped Become direction" }),
      mcp: r => text(`swapped Become direction (track ${(r as { trackId: string }).trackId})`),
    },
  },
  {
    name: "appear_from",
    scope: "project",
    cli: "appear-from",
    cliRoot: "flags",
    summary: "Reveal a destination object or plot parts by a hand-off from another object or part set. Writes exactly the same source-owned transform as Become with mode handoff; neither object is consumed. part names destination leaves, sourcePart names source leaves; pair chooses correspondence and reveal chooses flip or draw. members ([{element, parts?}]) instead of dest reveals a SET of objects and plot parts from the one source.",
    params: {
      deckId: z.string(),
      slideId: z.string(),
      beatId: z.string(),
      dest: z.string().optional(),
      members: z.array(z.object({ element: z.string().min(1), parts: z.array(z.string().min(1)).min(1).optional() }).strict()).min(1).optional(),
      from: z.string(),
      part: z.array(z.string().min(1)).min(1).optional(),
      sourcePart: z.array(z.string().min(1)).min(1).optional(),
      pair: z.enum(PAIR_POLICY_IDS).optional(),
      reveal: z.enum(["flip", "draw"]).optional(),
      method: z.enum(TRANSFORM_METHOD_IDS).optional(),
      start: z.number().min(0).optional(),
      duration: z.number().min(0).optional(),
      easing: z.enum(EASING_TOKENS as unknown as [EasingToken, ...EasingToken[]]).optional(),
    },
    cliArgs: [
      { kind: "pos", at: 0, into: "deckId", required: true },
      { kind: "pos", at: 1, into: "slideId", required: true },
      { kind: "pos", at: 2, into: "beatId", required: true },
      { kind: "flag", at: "dest", into: "dest" },
      { kind: "flag", at: "members", into: "members", as: "json" },
      { kind: "flag", at: "from", into: "from" },
      { kind: "flag", at: "part", into: "part", as: "csv" },
      { kind: "flag", at: "source-part", into: "sourcePart", as: "csv" },
      { kind: "flag", at: "pair", into: "pair" },
      { kind: "flag", at: "reveal", into: "reveal" },
      { kind: "flag", at: "method", into: "method" },
      { kind: "flag", at: "start", into: "start", as: "number" },
      { kind: "flag", at: "duration", into: "duration", as: "number" },
      { kind: "flag", at: "easing", into: "easing" },
    ],
    handler: (ctx, a) => core.appearFrom(ctx.root, s(a.deckId), s(a.slideId), s(a.beatId), a.dest != null ? s(a.dest) : undefined, s(a.from), {
      ...(a.members != null ? { members: a.members as TargetRef[] } : {}),
      ...(a.part != null ? { parts: a.part as string[] } : {}),
      ...(a.sourcePart != null ? { sourceParts: a.sourcePart as string[] } : {}),
      ...(a.pair != null ? { pair: a.pair as PairPolicy } : {}),
      ...(a.reveal != null ? { reveal: a.reveal as "flip" | "draw" } : {}),
      ...(a.method != null ? { method: a.method as TransformMethod } : {}),
      ...(a.start != null ? { start: a.start as number } : {}),
      ...(a.duration != null ? { duration: a.duration as number } : {}),
      ...(a.easing != null ? { easing: a.easing as "smooth" } : {}),
    }),
    render: {
      human: (r, a) => ({ out: (r as { trackId: string }).trackId, err: `✓ ${(r as { destination?: string }).destination ?? a.dest} appear${(r as { destination?: string }).destination ? "" : "s"} from ${a.from} (beat ${a.beatId})${modelMorphSummary(r)}` }),
      mcp: (r, a) => text(`transform track ${(r as { trackId: string }).trackId}: ${(r as { destination?: string }).destination ?? a.dest} appear${(r as { destination?: string }).destination ? "" : "s"} from ${a.from} (beat ${a.beatId})${modelMorphSummary(r)}`),
    },
  },
  {
    name: "validate_deck", readOnly: true,
    scope: "project",
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
    name: "export_slide_video",
    scope: "project",
    pathParams: {"out": "path"},
    cli: "export-slide-video",
    cliRoot: "flags",
    summary: "Export one slide, its animations and video clips to a smooth MP4, including unmuted clip audio. Timing values are milliseconds; simultaneous and automatic steps retain authored timing. Requires the desktop Electron runtime and bundled video encoder.",
    params: {
      deckId: z.string(), slideId: z.string(), out: z.string().optional(),
      stepDelayMs: z.number().min(0).max(60000).optional(), startHoldMs: z.number().min(0).max(60000).optional(), endHoldMs: z.number().min(0).max(60000).optional(),
      height: z.union([z.literal(720), z.literal(1080), z.literal(2160)]).optional(), fps: z.union([z.literal(30), z.literal(60)]).optional(),
    },
    cliArgs: [
      { kind: "pos", at: 0, into: "deckId", required: true }, { kind: "pos", at: 1, into: "slideId", required: true },
      { kind: "flag", at: "out", into: "out" },
      { kind: "flag", at: "step-delay", into: "stepDelayMs", as: "number" }, { kind: "flag", at: "start-hold", into: "startHoldMs", as: "number" }, { kind: "flag", at: "end-hold", into: "endHoldMs", as: "number" },
      { kind: "flag", at: "height", into: "height", as: "number" }, { kind: "flag", at: "fps", into: "fps", as: "number" },
    ],
    handler: (ctx, a) => core.exportSlideVideo(ctx.root, s(a.deckId), s(a.slideId), {
      ...pick(a, ["out", "stepDelayMs", "startHoldMs", "endHoldMs", "height", "fps"]),
      refreshSources: process.env.FLUX_VIDEO_SAVED === "1" ? false : undefined,
      onProgress: process.env.FLUX_VIDEO_PROGRESS === "1" ? value => process.stderr.write(`FLUX_VIDEO ${JSON.stringify(value)}\n`) : undefined,
    }),
    render: {
      human: r => { const c = r as { path: string; frames: number; durationMs: number; warnings: string[] }; return { out: JSON.stringify(c), err: `Exported MP4 → ${c.path} (${(c.durationMs / 1000).toFixed(2)} s, ${c.frames} frames)${c.warnings.length ? "\n" + c.warnings.join("\n") : ""}` }; },
      mcp: r => text(JSON.stringify(r)),
    },
  },
  {
    name: "export_deck",
    scope: "project",
    pathParams: {"out": "path"},
    cli: "export-deck",
    cliRoot: "flags",
    summary: "Export a deck to a single self-contained offline .html (animations + media inlined). Writes to exports/ by default.",
    params: { deckId: z.string(), out: z.string().optional(), saved: z.boolean().optional() },
    cliArgs: [
      { kind: "pos", at: 0, into: "deckId", required: true },
      { kind: "flag", at: "out", into: "out" },
      { kind: "flag", at: "saved", into: "saved", as: "boolean" },
    ],
    handler: (ctx, a) => core.exportDeck(ctx.root, s(a.deckId), { out: a.out as string | undefined, refreshSources: !a.saved }),
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
    scope: "project",
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
    name: "get_citation", readOnly: true,
    scope: "machine",
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
  {
    name: 'add_to_library',
    scope: "machine",
    pathParams: {"file": "path", "zoteroDir": "path"},
    notAPath: {"forceBibtex": "Input-format boolean", "attachFiles": "Attachment-mode boolean"}, cli: 'lib-add', cliRoot: 'flags',
    summary: 'Add a DOI or BibTeX to FluxLib without citing it. --file imports BibTeX/RIS, optionally attaching referenced files. Exactly one input is required.',
    params: { doi:z.string().optional(), bibtex:z.string().optional(), input:z.string().optional(), file:z.string().optional(), forceBibtex:z.boolean().optional(), attachFiles:z.boolean().optional(), zoteroDir:z.string().optional() },
    cliArgs: [
      {kind:'rest',at:0,into:'input',as:'joined'},
      {kind:'flag',at:'file',into:'file'},
      {kind:'flag',at:'bibtex',into:'forceBibtex',as:'boolean'},
      {kind:'flag',at:'attach-files',into:'attachFiles',as:'boolean'},
      {kind:'flag',at:'zotero-dir',into:'zoteroDir'},
    ],
    handler: async (_ctx,a) => {
      const inputs = [a.doi,a.bibtex,a.input,a.file].filter(v => typeof v === 'string' && v.trim());
      if(inputs.length !== 1) throw new ValidationError('add_to_library: provide exactly one nonempty DOI, BibTeX, or file');
      if(a.file) {
        const fs=await import('node:fs/promises'), path=await import('node:path');
        const file=path.resolve(s(a.file));
        const result=await core.importReferences(await fs.readFile(file,'utf8'), {attachFiles:!!a.attachFiles,baseDir:path.dirname(file),zoteroDir:a.zoteroDir as string|undefined});
        return {kind:'file',...result,attachFiles:!!a.attachFiles};
      }
      if(a.attachFiles || a.zoteroDir) throw new ValidationError('File attachment options require --file');
      const input=String(a.doi ?? a.bibtex ?? a.input).trim();
      const isDoi=!!a.doi || !a.bibtex && !a.forceBibtex && /^(https?:\/\/(dx\.)?doi\.org\/)?10\.\d{4,9}\//i.test(input);
      if(isDoi) return {kind:'doi', ...(await core.addDoiToLibrary(input))};
      return {kind:'bibtex',...(await core.addToLibrary(input))};
    },
    render: {
      human: r => {
        const v=r as {kind:string;result?:{keys:string[]};format?:string;added?:string[];deduped?:string[];attached?:unknown[];attachFailed?:unknown[];attachFiles?:boolean};
        if(v.kind==='doi')return {err:`✓ FluxLib += [@${v.result!.keys.join('; @')}]`};
        return {err:`✓ FluxLib${v.kind==='file' ? ` (${v.format})` : ''}: +${v.added!.length} added, ${v.deduped!.length} already present${v.attachFiles ? ` · ${v.attached!.length} PDF(s) attached${v.attachFailed!.length ? `, ${v.attachFailed!.length} not found` : ''}` : ''}`};
      },
      mcp: r => {
        const v=r as {kind:string;result?:{keys:string[]};added?:string[];deduped?:string[]};
        return text(v.kind==='doi' ? `added to FluxLib: @${v.result!.keys.join('; @')}` : `FluxLib: +${v.added!.length} added, ${v.deduped!.length} already present`);
      },
    },
  },
  {
    name: 'set_slide',
    scope: "project", cli: 'set-slide', cliRoot: 'flags',
    summary: 'Patch only supplied slide fields: name, layout, background, transition, notes, and camera.',
    params: { deckId:z.string().min(1), slideId:z.string().min(1), name:z.string().optional(), layout:z.enum(SLIDE_LAYOUTS).optional(), background:z.string().optional(), transition:z.string().optional(), notes:z.string().optional(), camera:z.object({x:z.number(),y:z.number(),zoom:z.number().positive()}).optional(), cameraX:z.number().optional(),cameraY:z.number().optional(),cameraZoom:z.number().positive().optional() },
    cliArgs: [{kind:'pos',at:0,into:'deckId',required:true},{kind:'pos',at:1,into:'slideId',required:true},
      ...['name','layout','background','transition','notes'].map(at=>({kind:'flag' as const,at,into:at})),
      {kind:'flag',at:'notes-file',into:'notes',as:'fileText'},
      {kind:'flag',at:'camera-x',into:'cameraX',as:'number'}, {kind:'flag',at:'camera-y',into:'cameraY',as:'number'}, {kind:'flag',at:'camera-zoom',into:'cameraZoom',as:'number'}],
    handler: async(ctx,a)=>{
      const patch:Parameters<typeof core.setSlide>[3]=pick(a,['name','layout','background','transition','notes']);
      if(a.camera!==undefined && [a.cameraX,a.cameraY,a.cameraZoom].some(v=>v!==undefined))throw new ValidationError('Pass camera or its individual fields, not both');
      if(a.camera!==undefined)patch.camera=a.camera as NonNullable<typeof patch.camera>;
      else if([a.cameraX,a.cameraY,a.cameraZoom].some(v=>v!==undefined))patch.camera={x:n(a.cameraX??0),y:n(a.cameraY??0),zoom:n(a.cameraZoom??1)};
      await core.setSlide(ctx.root,s(a.deckId),s(a.slideId),patch);
    },
    render:{human:(_r,a)=>({err:`✓ set slide ${a.slideId}`}),mcp:(_r,a)=>text(`set slide ${a.slideId}`)},
  },
  {
    name:'set_animation',
    scope: "project",
    pathParams: {"to.svgPath": "path", "to.manifestPath": "path"},cli:'set-animation',cliRoot:'flags',
    summary:'Add or replace an animation track on a beat. --track JSON accepts the full track; --append preserves existing effects.',
    params:{ deckId:z.string().min(1),slideId:z.string().min(1),beatId:z.string().min(1),track:z.record(z.unknown()).optional(),target:z.string().optional(),append:z.boolean().optional(),preset:z.enum(SLIDE_PRESETS).optional(),part:z.string().optional(),start:z.number().optional(),duration:z.number().optional(),easing:z.string().optional(),params:z.record(z.unknown()).optional(),influence:z.object({in:z.number(),out:z.number()}).optional(),stagger:staggerSchema.optional(),groupId:z.string().optional(),to:z.object({assetId:z.string().optional(),x:z.number().optional(),y:z.number().optional(),zoom:z.number().optional(),state:z.record(z.unknown()).optional(),svgPath:z.string().optional(),manifestPath:z.string().optional()}).optional() },
    cliArgs:[{kind:'pos',at:0,into:'deckId',required:true},{kind:'pos',at:1,into:'slideId',required:true},{kind:'pos',at:2,into:'beatId',required:true},{kind:'pos',at:3,into:'target'},
      {kind:'flag',at:'target',into:'target'}, {kind:'flag',at:'track',into:'track',as:'json'}, {kind:'flag',at:'append',into:'append',as:'boolean'},
      ...['preset','part','easing'].map(at=>({kind:'flag' as const,at,into:at})),
      ...['start','duration'].map(at=>({kind:'flag' as const,at,into:at,as:'number' as const})),
      {kind:'flag',at:'params',into:'params',as:'json'}, {kind:'flag',at:'to-asset',into:'to.assetId'},
      ...['x','y','zoom'].map(axis=>({kind:'flag' as const,at:`to-${axis}`,into:`to.${axis}`,as:'number' as const}))],
    handler:async(ctx,a)=>{
      const keys=['target','preset','part','start','duration','easing','params','influence','stagger','groupId','to'];
      if(a.track && keys.some(k=>a[k]!==undefined))throw new ValidationError('Pass --track or individual animation fields, not both');
      const track=(a.track??pick(a,keys)) as import('../src/lib/slide/types').Track;
      if(typeof track.target!=='string'||!track.target.trim())throw new ValidationError('set-animation needs --target (an element id, or @camera/@stage)');
      await core.setAnimation(ctx.root,s(a.deckId),s(a.slideId),s(a.beatId),track,{append:!!a.append});
      return track;
    },
    render:{human:(r,a)=>{const t=r as import('../src/lib/slide/types').Track;return {err:`✓ set animation on beat ${a.beatId} (${t.preset??'keyframes'} → ${t.target})`};},mcp:(r,a)=>{const t=r as import('../src/lib/slide/types').Track;return text(`set animation on beat ${a.beatId} (${t.preset??'keyframes'} → ${t.target})`);}},
  },
  {
    name:'search_fulltext', readOnly: true,
    scope: "machine",cli:'search-text',cliRoot:'flags',summary:'Search extracted library PDF text with AND terms or quoted phrases.',
    params:{query:z.string().trim().min(1),limit:z.number().int().positive().optional(),keys:z.array(z.string()).optional(),json:z.boolean().optional()},
    cliArgs:[{kind:'rest',at:0,into:'query',as:'joined',required:true},{kind:'flag',at:'limit',into:'limit',as:'number'},{kind:'flag',at:'keys',into:'keys',as:'csv'},{kind:'flag',at:'json',into:'json',as:'boolean'}],
    handler:(_ctx,a)=>core.searchFulltext(s(a.query),{limit:a.limit as number|undefined,keys:a.keys as string[]|undefined}),
    render:{
      human:(r,a)=>{const v=r as Awaited<ReturnType<typeof core.searchFulltext>>;return a.json?{out:JSON.stringify(v)}:{out:v.hits.map(h=>`@${h.key}  (${h.count} hit${h.count===1?'':'s'})\n`+h.snippets.map(s=>`   p${s.page}: ${s.text}`).join('\n')).join('\n'),err:`✓ ${v.hits.length} paper(s) matched · scanned ${v.scanned} texts in ${v.elapsedMs}ms${v.truncated?' (hit limit — refine the query)':''}${v.missingText.length?` · ${v.missingText.length} PDF(s) have no extracted text yet`:''}`};},
      mcp:(r,a)=>{const v=r as Awaited<ReturnType<typeof core.searchFulltext>>;return text(!v.hits.length?`No stored PDF text matches "${a.query}" (scanned ${v.scanned}).${v.missingText.length?` ${v.missingText.length} PDF(s) have no extracted text yet — get_paper_text extracts on demand.`:''}`:`${v.hits.length} paper(s) match "${a.query}" (scanned ${v.scanned} in ${v.elapsedMs}ms${v.truncated?'; hit limit':''}):\n`+v.hits.map(h=>`@${h.key} (${h.count})\n`+h.snippets.map(s=>`  p${s.page}: ${s.text}`).join('\n')).join('\n'));},
    },
  },

  // Figure-side 3D commands; Slides additions land after animation-v2.
  ...MODEL3D_VERBS,

];
