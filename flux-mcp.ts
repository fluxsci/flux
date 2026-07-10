#!/usr/bin/env -S npx tsx
// flux MCP server — exposes the Flux project verbs to an MCP client (Claude
// Desktop/Code) over stdio. Thin wrappers over flux-core (same logic as the CLI
// and the GUI). Configure a client with:
//   { "command": "npx", "args": ["tsx", "flux-mcp.ts", "/path/to/project"] }

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as path from "node:path";
import * as core from "./flux-core/index";
import * as live from "./flux-core/liveClient";

const ROOT = path.resolve(process.argv[2] ?? process.env.FLUX_PROJECT ?? ".");
core.setClient(process.env.FLUX_CLIENT || "mcp"); // WS6: journal/lock identity
const server = new McpServer({ name: "flux", version: "0.1.0" });

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });

// OpenAlex sort presets for the whole-world tools (undefined = relevance).
const SORT: Record<string, string | undefined> = {
  relevance: undefined,
  citations: "cited_by_count:desc",
  date: "publication_date:desc",
};

server.registerTool(
  "list_project",
  { description: "List the project's documents, figures (with panel letters), and references.", inputSchema: {} },
  async () => ok(JSON.stringify(await core.listProject(ROOT), null, 2)),
);

server.registerTool(
  "reindex",
  { description: "Rebuild project.json.figures[] from fig/index.json.", inputSchema: {} },
  async () => {
    const r = await core.reindex(ROOT);
    return ok(`reindexed ${r.figures} figure(s)`);
  },
);

server.registerTool(
  "get_figure_image",
  {
    description:
      "Render a figure to a PNG so a vision agent can SEE its current state (per-part plot overrides baked in). Use after compose_figure/restyle_part to check your work.",
    inputSchema: { id: z.string(), scale: z.number().optional() },
  },
  async ({ id, scale }) => {
    const png = await core.renderFigurePng(ROOT, id, scale ?? 2);
    return {
      content: [
        { type: "image" as const, data: png.toString("base64"), mimeType: "image/png" },
        { type: "text" as const, text: `Rendered figure "${id}" (PNG, ${png.length} bytes, scale ${scale ?? 2}).` },
      ],
    };
  },
);

server.registerTool(
  "sync_figure",
  {
    description:
      "Refresh a figure's (or all figures') fig/assets plot copies from their regenerated plots/ sources IN PLACE — the regenerate loop without delete+recompose; captions, positions and per-part restyles survive.",
    inputSchema: { figureId: z.string().optional() },
  },
  async ({ figureId }) => {
    const r = await core.syncFigureAssets(ROOT, figureId);
    const head = r.refreshed.length
      ? `refreshed ${r.refreshed.length}/${r.checked} panel asset(s): ${r.refreshed.map((x) => x.from).join(", ")}`
      : `all ${r.checked} panel asset(s) already match plots/ (no change)`;
    return ok(head + (r.missing.length ? ` — missing source plot(s): ${r.missing.join(", ")}` : ""));
  },
);

server.registerTool(
  "get_canvas_image",
  {
    description:
      "Render a WHOLE canvas to a PNG — every figure at its real canvas x/y with a name·id label. Use to check canvas-level layout (overlaps, stray empty frames) that per-figure renders can't show.",
    inputSchema: { canvasId: z.string().optional(), scale: z.number().optional() },
  },
  async ({ canvasId, scale }) => {
    const { png, canvasId: cid } = await core.renderCanvasPng(ROOT, canvasId, scale ?? 1);
    return {
      content: [
        { type: "image" as const, data: png.toString("base64"), mimeType: "image/png" },
        { type: "text" as const, text: `Rendered canvas "${cid}" (PNG, ${png.length} bytes, scale ${scale ?? 1}).` },
      ],
    };
  },
);

server.registerTool(
  "set_caption",
  { description: "Write a figure's caption to fig/captions/<id>.md (the single caption source).", inputSchema: { id: z.string(), markdown: z.string() } },
  async ({ id, markdown }) => {
    await core.setCaption(ROOT, id, markdown);
    return ok(`caption set for ${id}`);
  },
);

server.registerTool(
  "add_reference",
  {
    description:
      "Add a BibTeX entry to the machine-global FluxLib (deduped by DOI) AND cite it in this project (materialized into references/library.bib).",
    inputSchema: { bibtex: z.string() },
  },
  async ({ bibtex }) => {
    await core.addReference(ROOT, bibtex);
    return ok("reference added (FluxLib + project)");
  },
);

server.registerTool(
  "search_references",
  {
    description:
      "Search the machine-global FluxLib reference library with a structured query, e.g. 'author:smith year:2020 journal:nature' (fields: author, year, journal, title, doi; bare words match any). Returns matching entries — cite one via its `key` as @key. Each hit also carries `enrich` (abstract, topics, keywords, citedByCount, openalexId) when the entry has been hydrated (see hydrate_library).",
    inputSchema: { query: z.string() },
  },
  async ({ query }) => ok(JSON.stringify(await core.searchReferencesEnriched(query), null, 2)),
);

server.registerTool(
  "add_to_library",
  {
    description:
      "Add a reference to FluxLib WITHOUT citing it in the current project — by DOI (fetched via content negotiation) or raw BibTeX. Use add_reference / cite_doi to also cite it here.",
    inputSchema: { doi: z.string().optional(), bibtex: z.string().optional() },
  },
  async ({ doi, bibtex }) => {
    if (doi) {
      const r = await core.addDoiToLibrary(doi);
      return ok(`added to FluxLib: @${r.result.keys.join("; @")}`);
    }
    if (bibtex) {
      const r = await core.addToLibrary(bibtex);
      return ok(`FluxLib: +${r.added.length} added, ${r.deduped.length} already present`);
    }
    return ok("add_to_library: provide `doi` or `bibtex`");
  },
);

// --- Reference hydration + whole-world lookups (OpenAlex; no API key needed) ---

server.registerTool(
  "hydrate_library",
  {
    description:
      "Enrich the machine-global FluxLib from OpenAlex — abstracts, topics/keywords, citation counts, referenced/related works, open-access, author + external IDs — into a derived sidecar (the canonical .bib is untouched). Incremental by default (skips already-hydrated entries); refresh re-fetches all; key limits to one citekey. Powers richer search_references + the world lookups. No API key needed.",
    inputSchema: { refresh: z.boolean().optional(), key: z.string().optional() },
  },
  async ({ refresh, key }) => {
    const r = await core.hydrateLibrary({ refresh, key });
    return ok(
      `hydrated ${r.fetched} (+${r.crossrefBackfill} CrossRef abstracts); ${r.hydrated}/${r.total} entries enriched, ${r.withAbstract} with abstracts` +
        (r.missing.length ? `; no OpenAlex match for: ${r.missing.join(", ")}` : ""),
    );
  },
);

server.registerTool(
  "search_world",
  {
    description:
      "Search ALL of OpenAlex (~250M works) by free text — discovery BEYOND your library. sort: 'relevance' (default), 'citations', or 'date'. Returns brief records (openalexId, doi, title, authors, year, container, citedByCount, abstract). Add one to FluxLib with add_to_library {doi}.",
    inputSchema: {
      query: z.string(),
      sort: z.enum(["relevance", "citations", "date"]).optional(),
      perPage: z.number().optional(),
    },
  },
  async ({ query, sort, perPage }) =>
    ok(JSON.stringify(await core.searchWorld(query, { sort: SORT[sort ?? "relevance"], perPage }), null, 2)),
);

server.registerTool(
  "semantic_search",
  {
    description:
      "SEMANTIC (meaning-based) search across ALL of OpenAlex via search.semantic — finds conceptually related work even when the wording differs. Returns up to 50 brief records ranked by similarity (relevanceScore). sort: 'relevance' (default) or 'citations' (re-ranks the 50 by citation count). Add a hit with add_to_library {doi}.",
    inputSchema: { query: z.string(), sort: z.enum(["relevance", "citations"]).optional() },
  },
  async ({ query, sort }) =>
    ok(JSON.stringify(await core.searchWorldSemantic(query, { sort: sort ?? "relevance" }), null, 2)),
);

server.registerTool(
  "similar_papers",
  {
    description:
      "Papers similar to a FluxLib entry. source 'openalex' (default) = OpenAlex semantic 'more like this' (seeded from title+abstract; hydrate first); 'semanticscholar' = SPECTER2 recommendations; 'both' = run each and return { openalex, semanticscholar } for comparison. `ref` = a citekey (or DOI for S2). sort 'relevance' (default) or 'citations' (OpenAlex only).",
    inputSchema: {
      ref: z.string(),
      source: z.enum(["openalex", "semanticscholar", "both"]).optional(),
      sort: z.enum(["relevance", "citations"]).optional(),
    },
  },
  async ({ ref, source, sort }) => {
    const src = source ?? "openalex";
    if (src === "openalex")
      return ok(JSON.stringify(await core.similarByKey(ref, { sort: sort ?? "relevance" }), null, 2));
    if (src === "semanticscholar") return ok(JSON.stringify(await core.s2Similar(ref), null, 2));
    const [openalex, semanticscholar] = await Promise.all([
      core.similarByKey(ref, { sort: sort ?? "relevance" }).catch((e) => ({ error: String(e?.message || e) })),
      core.s2Similar(ref).catch((e) => ({ error: String(e?.message || e) })),
    ]);
    return ok(JSON.stringify({ openalex, semanticscholar }, null, 2));
  },
);

server.registerTool(
  "citing_works",
  {
    description:
      "Works that CITE a given paper. source 'openalex' (default) = breadth: the full paginated citer list (sort 'citations'|'date'). source 'semanticscholar' = citing papers WITH citation contexts (the sentence citing the seed), intents, and influential-citation flags — the 'how/why cited' view. `ref` = citekey (hydrated) / OpenAlex id (W…) / DOI.",
    inputSchema: {
      ref: z.string(),
      source: z.enum(["openalex", "semanticscholar"]).optional(),
      sort: z.enum(["citations", "date"]).optional(),
      perPage: z.number().optional(),
    },
  },
  async ({ ref, source, sort, perPage }) =>
    (source ?? "openalex") === "semanticscholar"
      ? ok(JSON.stringify(await core.s2Citing(ref, { limit: perPage }), null, 2))
      : ok(JSON.stringify(await core.citingWorks(ref, { sort: SORT[sort ?? "citations"], perPage }), null, 2)),
);

server.registerTool(
  "author_works",
  {
    description:
      "Other works by an author (OpenAlex), sorted by citation count. `ref` = a FluxLib citekey (uses its first author; must be hydrated) or an OpenAlex author id (A…). Returns brief records.",
    inputSchema: { ref: z.string(), perPage: z.number().optional() },
  },
  async ({ ref, perPage }) => ok(JSON.stringify(await core.authorWorks(ref, { perPage }), null, 2)),
);

server.registerTool(
  "related_works",
  {
    description:
      "Related papers via OpenAlex's precomputed similarity (the closest 'papers like this' without local embeddings). `ref` = a FluxLib citekey (must be hydrated) or an OpenAlex work id (W…).",
    inputSchema: { ref: z.string() },
  },
  async ({ ref }) => ok(JSON.stringify(await core.relatedWorks(ref), null, 2)),
);

server.registerTool(
  "add_panel",
  {
    description: "Import an SVG file as an image panel on a figure.",
    inputSchema: {
      id: z.string(),
      svgPath: z.string(),
      x: z.number().optional(),
      y: z.number().optional(),
      width: z.number().optional(),
      height: z.number().optional(),
    },
  },
  async ({ id, svgPath, x, y, width, height }) => {
    const r = await core.addPanel(ROOT, id, svgPath, { x, y, width, height });
    return ok(`added panel ${r.elementId} (asset ${r.assetId})` + (r.warning ? `\n⚠ ${r.warning}` : ""));
  },
);

server.registerTool(
  "import_plots",
  {
    description:
      "Batch-import multiple SVG plots onto an EXISTING figure (the headless mirror of the GUI's Alt+I multi-insert): each plot resolves its FluxPlot sidecars (semantic when a .fluxplot.json sits next to it), lands at TRUE physical size, and the batch grid-packs into the figure's largest empty region (a single plot centers). Use compose_figure to build a NEW figure instead.",
    inputSchema: {
      id: z.string(),
      plotPaths: z.array(z.string()),
    },
  },
  async ({ id, plotPaths }) => {
    const r = await core.importPlots(ROOT, id, plotPaths);
    return ok(
      `imported ${r.panels.length} plot(s) onto ${id}: ` +
        r.panels.map((p) => `${p.elementId} (asset ${p.assetId})`).join(", ") +
        (r.warnings.length ? `\n⚠ ${r.warnings.join("\n⚠ ")}` : ""),
    );
  },
);

server.registerTool(
  "compose_figure",
  {
    description:
      "Assemble multiple plots into ONE labeled multi-panel figure: imports each plot (semantic FluxPlot if a .fluxplot.json sidecar is present), grid-arranges them, auto-letters the panels (a, b, c…), and writes a caption stub. The flagship figure-building verb — e.g. turn 10 analysis plots into Figure 6.",
    inputSchema: {
      plotPaths: z.array(z.string()),
      id: z.string().optional(),
      name: z.string().optional(),
      rows: z.number().optional(),
      cols: z.number().optional(),
      gap: z.number().optional(),
      label: z.boolean().optional(),
      captionStub: z.boolean().optional(),
    },
  },
  async (a) => {
    const r = await core.composeFigure(ROOT, a.plotPaths, {
      id: a.id,
      name: a.name,
      rows: a.rows,
      cols: a.cols,
      gap: a.gap,
      label: a.label,
      captionStub: a.captionStub,
    });
    return ok(
      `composed figure ${r.figureId} — panels [${r.panels.join("")}] ${r.width}×${r.height}` +
        (r.warnings.length ? `\n⚠ ${r.warnings.join("\n⚠ ")}` : ""),
    );
  },
);

server.registerTool(
  "create_figure",
  {
    description: "Create a blank figure (optionally a clean slug id → @fig-<id>, name, canvas, size).",
    inputSchema: {
      id: z.string().optional(),
      name: z.string().optional(),
      canvasId: z.string().optional(),
      width: z.number().optional(),
      height: z.number().optional(),
    },
  },
  async (a) => {
    const r = await core.createFigure(ROOT, a);
    return ok(`created figure ${r.figureId}`);
  },
);

server.registerTool(
  "arrange_figure",
  {
    description: "Grid-arrange a figure's existing panels (give rows OR cols; gap optional).",
    inputSchema: {
      figureId: z.string(),
      rows: z.number().optional(),
      cols: z.number().optional(),
      gap: z.number().optional(),
    },
  },
  async ({ figureId, rows, cols, gap }) => {
    await core.arrangeFigure(ROOT, figureId, { rows, cols, gap });
    return ok(`arranged ${figureId}`);
  },
);

server.registerTool(
  "auto_label",
  {
    description: "Auto-letter a figure's panel labels (a, b, c…) by reading order.",
    inputSchema: { figureId: z.string() },
  },
  async ({ figureId }) => {
    const r = await core.autoLabel(ROOT, figureId);
    if (!r.panels.length) return ok(`${figureId} has no panel labels to letter`);
    return ok(r.changed ? `labeled ${figureId}: ${r.panels.join("")}` : `${figureId} already labeled: ${r.panels.join("")} (no change)`);
  },
);

server.registerTool(
  "restyle_part",
  {
    description:
      "Restyle a semantic-plot part or series by its stable id (e.g. 'control.line' or the group 'control'). Writes an override that survives regeneration. Omit elementId if the figure has a single plot panel.",
    inputSchema: {
      figureId: z.string(),
      partId: z.string(),
      elementId: z.string().optional(),
      stroke: z.string().optional(),
      fill: z.string().optional(),
      strokeWidth: z.number().optional(),
      opacity: z.number().optional(),
      hidden: z.boolean().optional(),
    },
  },
  async ({ figureId, partId, elementId, stroke, fill, strokeWidth, opacity, hidden }) => {
    const patch: Record<string, string | number | boolean> = {};
    if (stroke != null) patch.stroke = stroke;
    if (fill != null) patch.fill = fill;
    if (strokeWidth != null) patch.strokeWidth = strokeWidth;
    if (opacity != null) patch.opacity = opacity;
    if (hidden != null) patch.hidden = hidden;
    const r = await core.setPartOverride(ROOT, figureId, partId, patch, elementId);
    return ok(`restyled ${partId} on ${r.elementId}`);
  },
);

server.registerTool(
  "set_style",
  {
    description:
      "Set element-level style on element ids: fill/stroke/strokeWidth/opacity/color/fontSize (canvas px = pt × 4/3), text props (fontFamily/fontWeight/fontStyle/underline/lineHeight/sizing/align), plus hidden (omit from canvas + export), locked (not editable on canvas), and name (Layers label).",
    inputSchema: {
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
  },
  async ({ ids, fill, stroke, strokeWidth, opacity, color, fontSize, fontFamily, fontWeight, fontStyle, underline, lineHeight, sizing, align, hidden, locked, name }) => {
    const patch: Record<string, string | number | boolean> = {};
    if (fill != null) patch.fill = fill;
    if (stroke != null) patch.stroke = stroke;
    if (strokeWidth != null) patch.strokeWidth = strokeWidth;
    if (opacity != null) patch.opacity = opacity;
    if (color != null) patch.color = color;
    if (fontSize != null) patch.fontSize = fontSize;
    if (fontFamily != null) patch.fontFamily = fontFamily;
    if (fontWeight != null) patch.fontWeight = fontWeight;
    if (fontStyle != null) patch.fontStyle = fontStyle;
    if (underline != null) patch.underline = underline;
    if (lineHeight != null) patch.lineHeight = lineHeight;
    if (sizing != null) patch.sizing = sizing;
    if (align != null) patch.align = align;
    if (hidden != null) patch.hidden = hidden;
    if (locked != null) patch.locked = locked;
    if (name != null) patch.name = name;
    await core.setElementStyle(ROOT, ids, patch);
    return ok(`styled ${ids.length} element(s)`);
  },
);

server.registerTool(
  "set_crop",
  {
    description:
      "Crop an image/plot element to a window, or reset it. `crop` is {x,y,width,height} in INTRINSIC content px (the asset's display size: SVG CSS px, PNG px × 96/dpi); omit it (or pass null) to remove the crop. Figma semantics: the content stays pinned on the canvas — the element box moves/resizes to frame exactly the window; reset returns the box to the full content at its current scale.",
    inputSchema: {
      id: z.string(),
      crop: z
        .object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })
        .nullable()
        .optional(),
    },
  },
  async ({ id, crop }) => {
    await core.setCrop(ROOT, id, crop ?? null);
    return ok(crop ? `cropped ${id} to ${crop.width}×${crop.height} @ ${crop.x},${crop.y}` : `reset crop on ${id}`);
  },
);

server.registerTool(
  "toggle_text_style",
  {
    description:
      "Toggle bold/italic/underline across TEXT elements (Figma semantics: if every text already has it, turn it off everywhere; else on everywhere).",
    inputSchema: { ids: z.array(z.string()), which: z.enum(["bold", "italic", "underline"]) },
  },
  async ({ ids, which }) => {
    await core.toggleTextStyle(ROOT, ids, which);
    return ok(`toggled ${which} on ${ids.length} element(s)`);
  },
);

server.registerTool(
  "add_fig_text",
  {
    description:
      "Add a text element to a FIGURE (fontSize in canvas px = pt × 4/3; sizing auto = box hugs text, auto-h = wrap at width, fixed = pinned box).",
    inputSchema: {
      figureId: z.string(),
      text: z.string(),
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
  },
  async ({ figureId, text, ...rest }) => {
    const r = await core.addFigText(ROOT, figureId, { text, ...rest });
    return ok(`added text ${r.id} to ${figureId}`);
  },
);

server.registerTool(
  "list_text_styles",
  {
    description:
      "List named text styles: the project's (default) or the machine-global library (global: true). Library styles are reusable definitions — applying one copies it into the project.",
    inputSchema: { global: z.boolean().optional() },
  },
  async ({ global: g }) => {
    const styles = g ? await core.listGlobalTextStyles() : await core.listTextStyles(ROOT);
    return ok(JSON.stringify(styles, null, 2));
  },
);

server.registerTool(
  "create_text_style",
  {
    description:
      "Create a named text style — from an element's current look (fromElementId, which also links that element) or from explicit props. fontSize in canvas px (pt × 4/3).",
    inputSchema: {
      name: z.string(),
      fromElementId: z.string().optional(),
      fontFamily: z.string().optional(),
      fontSize: z.number().optional(),
      fontWeight: z.number().optional(),
      fontStyle: z.enum(["normal", "italic"]).optional(),
      underline: z.boolean().optional(),
      lineHeight: z.number().optional(),
      color: z.string().optional(),
      align: z.enum(["left", "center", "right"]).optional(),
    },
  },
  async (def) => {
    const r = await core.createTextStyle(ROOT, def);
    return ok(`created text style ${r.style.id} ("${r.style.name}")`);
  },
);

server.registerTool(
  "update_text_style",
  {
    description:
      "Patch a named text style (name renames) — LIVE: re-applies to every linked text element.",
    inputSchema: {
      styleId: z.string(),
      name: z.string().optional(),
      fontFamily: z.string().optional(),
      fontSize: z.number().optional(),
      fontWeight: z.number().optional(),
      fontStyle: z.enum(["normal", "italic"]).optional(),
      underline: z.boolean().optional(),
      lineHeight: z.number().optional(),
      color: z.string().optional(),
      align: z.enum(["left", "center", "right"]).optional(),
    },
  },
  async ({ styleId, ...patch }) => {
    await core.updateTextStyle(ROOT, styleId, patch);
    return ok(`updated text style ${styleId}`);
  },
);

server.registerTool(
  "delete_text_style",
  {
    description: "Delete a named text style. Linked text elements keep their current look and drop the link.",
    inputSchema: { styleId: z.string() },
  },
  async ({ styleId }) => {
    await core.deleteTextStyle(ROOT, styleId);
    return ok(`deleted text style ${styleId}`);
  },
);

server.registerTool(
  "apply_text_style",
  {
    description: "Apply a named text style to text elements (sets the style's defined props + links styleId).",
    inputSchema: { styleId: z.string(), ids: z.array(z.string()) },
  },
  async ({ styleId, ids }) => {
    const r = await core.applyTextStyle(ROOT, ids, styleId);
    return ok(`applied ${styleId} to ${r.applied} text element(s)`);
  },
);

server.registerTool(
  "reorder_element",
  {
    description: "Move an element to an absolute z-index within its figure (0 = bottom, higher = closer to front).",
    inputSchema: { figureId: z.string(), id: z.string(), index: z.number() },
  },
  async ({ figureId, id, index }) => {
    await core.reorderElement(ROOT, figureId, id, index);
    return ok(`reordered ${id} → z-index ${index}`);
  },
);

server.registerTool(
  "rotate_elements",
  {
    description:
      "Rotate elements by `deg` degrees about a pivot (default = the selection's bbox centre). A single element rotates about its own centre; a group orbits the shared pivot rigidly.",
    inputSchema: { ids: z.array(z.string()), deg: z.number(), pivotX: z.number().optional(), pivotY: z.number().optional() },
  },
  async ({ ids, deg, pivotX, pivotY }) => {
    const pivot = pivotX != null && pivotY != null ? { x: pivotX, y: pivotY } : undefined;
    await core.rotateElements(ROOT, ids, deg, pivot);
    return ok(`rotated ${ids.length} element(s) by ${deg}°`);
  },
);

const handleZ = z.object({ dx: z.number(), dy: z.number() });
const nodeZ = z.object({
  x: z.number(),
  y: z.number(),
  type: z.enum(["corner", "smooth"]),
  hIn: handleZ.optional(),
  hOut: handleZ.optional(),
});

server.registerTool(
  "scale_elements",
  {
    description:
      "Proportionally scale elements about a pivot (default = their bbox centre) by `factor` — scales geometry AND stroke widths, corner radii, and font sizes together (unlike a plain resize, which leaves weights fixed). 0.5 halves everything.",
    inputSchema: { ids: z.array(z.string()), factor: z.number(), pivotX: z.number().optional(), pivotY: z.number().optional() },
  },
  async ({ ids, factor, pivotX, pivotY }) => {
    const pivot = pivotX != null && pivotY != null ? { x: pivotX, y: pivotY } : undefined;
    await core.scaleElements(ROOT, ids, factor, pivot);
    return ok(`scaled ${ids.length} element(s) by ${factor}×`);
  },
);

server.registerTool(
  "duplicate_elements",
  {
    description:
      "Duplicate elements within their figure `count` times, each stamp offset by k·(dx,dy), with fresh element + group ids (each stamp independent). Use to build even arrays — tick rows, marker series, panel scaffolds. Returns the last stamp's ids.",
    inputSchema: { figureId: z.string(), ids: z.array(z.string()), dx: z.number().optional(), dy: z.number().optional(), count: z.number().optional() },
  },
  async ({ figureId, ids, dx, dy, count }) => {
    const r = await core.duplicateElements(ROOT, figureId, ids, { dx: dx ?? 16, dy: dy ?? 16, count });
    return ok(`duplicated ${ids.length} → ${r.ids.length} new`);
  },
);

server.registerTool(
  "set_guides",
  {
    description:
      "Set a figure's ruler guides (figure-local guide lines that elements snap to). `x` = vertical guides at those x positions, `y` = horizontal guides. Either axis omitted clears it. Use to lay down a column grid / baseline set programmatically.",
    inputSchema: { figureId: z.string(), x: z.array(z.number()).optional(), y: z.array(z.number()).optional() },
  },
  async ({ figureId, x, y }) => {
    await core.setGuides(ROOT, figureId, { x, y });
    return ok(`set guides on ${figureId} (x:${x?.length ?? 0}, y:${y?.length ?? 0})`);
  },
);

server.registerTool(
  "distribute",
  {
    description:
      "Distribute a figure's panels along an axis. With `gap`, place them at an EXACT edge-to-edge gap (equal gutters, anchored on the first item); without `gap`, equalize the spacing between the outermost items (needs ≥3). `ids` restricts the set (default = all elements).",
    inputSchema: { figureId: z.string(), axis: z.enum(["h", "v"]).optional(), gap: z.number().optional(), ids: z.array(z.string()).optional() },
  },
  async ({ figureId, axis, gap, ids }) => {
    await core.distributeFigure(ROOT, figureId, axis ?? "h", gap, ids);
    return ok(`distributed ${figureId} (${axis ?? "h"}${gap != null ? `, gap ${gap}` : ""})`);
  },
);

server.registerTool(
  "add_path",
  {
    description:
      "Add a vector path (bezier) to a figure from an editable node list — the same core the pen tool uses. Each node has element-local x/y and optional hIn/hOut handle offsets (present → cubic segment; absent → straight). `closed` joins the last node to the first. The node list is normalized and the bbox fitted automatically.",
    inputSchema: {
      figureId: z.string(),
      nodes: z.array(nodeZ),
      closed: z.boolean().optional(),
      fill: z.string().optional(),
      stroke: z.string().optional(),
      strokeWidth: z.number().optional(),
    },
  },
  async ({ figureId, nodes, closed, fill, stroke, strokeWidth }) => {
    const r = await core.addPath(ROOT, figureId, { nodes, closed, fill, stroke, strokeWidth });
    return ok(`added path ${r.id} (${nodes.length} nodes)`);
  },
);

server.registerTool(
  "edit_path",
  {
    description:
      "Replace a path's nodes and/or closed flag (node editing). Adopts a legacy d-only path into nodes first, so any path stays editable. Regenerates the rendered `d` and bbox.",
    inputSchema: { id: z.string(), nodes: z.array(nodeZ).optional(), closed: z.boolean().optional() },
  },
  async ({ id, nodes, closed }) => {
    await core.editPath(ROOT, id, { nodes, closed });
    return ok(`edited path ${id}`);
  },
);

// --- W11 (AGT-6): figure verbs an agent can run with the app CLOSED. Previously
// these edits (delete/align/group/z-order/layout) were live-bridge-only. ---

server.registerTool(
  "delete_elements",
  {
    description: "Delete elements by id (removes them from whatever figure they're in). Use to remove a wrong panel/label/shape.",
    inputSchema: { ids: z.array(z.string()) },
  },
  async ({ ids }) => {
    await core.deleteElements(ROOT, ids);
    return ok(`deleted ${ids.length} element(s)`);
  },
);

server.registerTool(
  "delete_figure",
  {
    description: "Delete a whole figure (keeps at least one figure in the project). Returns the id the GUI would select next.",
    inputSchema: { figureId: z.string() },
  },
  async ({ figureId }) => {
    const r = await core.deleteFigure(ROOT, figureId);
    return ok(`deleted figure ${figureId}${r.nextActiveId ? ` (next: ${r.nextActiveId})` : ""}`);
  },
);

server.registerTool(
  "duplicate_figure",
  {
    description: "Duplicate a whole figure (fresh element/group ids). Returns the new figure id.",
    inputSchema: { figureId: z.string() },
  },
  async ({ figureId }) => {
    const r = await core.duplicateFigure(ROOT, figureId);
    return ok(`duplicated ${figureId} → ${r.figureId}`);
  },
);

server.registerTool(
  "align_figure",
  {
    description:
      "Align a figure's elements to a common edge/axis: left, right, top, bottom, centerH (share a vertical center line), centerV (share a horizontal center line). Omit `ids` to align all of the figure's elements.",
    inputSchema: {
      figureId: z.string(),
      kind: z.enum(["left", "right", "top", "bottom", "centerH", "centerV"]),
      ids: z.array(z.string()).optional(),
    },
  },
  async ({ figureId, kind, ids }) => {
    await core.alignFigure(ROOT, figureId, kind, ids);
    return ok(`aligned ${figureId} (${kind})`);
  },
);

server.registerTool(
  "group_elements",
  {
    description:
      "Group ≥2 units (elements and/or whole existing groups, same figure) into one NAMED movable/selectable group (default name 'Group N'). Existing top-level groups NEST inside the new one (Figma ⌘G); members are made z-contiguous. Optional parentId nests the new group under an existing group. Returns the new group id.",
    inputSchema: { ids: z.array(z.string()), name: z.string().optional(), parentId: z.string().optional() },
  },
  async ({ ids, name, parentId }) => {
    const r = await core.groupElements(ROOT, ids, { name, parentId });
    return ok(`grouped ${ids.length} element(s) → ${r.groupId}`);
  },
);

server.registerTool(
  "ungroup_elements",
  {
    description:
      "Ungroup — dissolve each element id's TOP-level group (or pass a group id to dissolve exactly that group). Members drop to the parent group or go loose; nested child groups survive one level up.",
    inputSchema: { ids: z.array(z.string()) },
  },
  async ({ ids }) => {
    await core.ungroupElements(ROOT, ids);
    return ok(`ungrouped ${ids.length} id(s)`);
  },
);

server.registerTool(
  "rename_group",
  {
    description: "Rename a figure group (the Layers panel name).",
    inputSchema: { groupId: z.string(), name: z.string() },
  },
  async ({ groupId, name }) => {
    await core.renameGroup(ROOT, groupId, name);
    return ok(`renamed ${groupId} → "${name}"`);
  },
);

server.registerTool(
  "set_group_state",
  {
    description:
      "Set a group's hidden/locked flags (the Layers panel group eye/padlock). Hidden groups drop out of rendered/exported figures (members inherit via effectiveHidden); members keep their own flags.",
    inputSchema: { groupId: z.string(), hidden: z.boolean().optional(), locked: z.boolean().optional() },
  },
  async ({ groupId, hidden, locked }) => {
    const patch: { hidden?: boolean; locked?: boolean } = {};
    if (hidden != null) patch.hidden = hidden;
    if (locked != null) patch.locked = locked;
    await core.setGroupState(ROOT, groupId, patch);
    return ok(`group ${groupId} state ${JSON.stringify(patch)}`);
  },
);

server.registerTool(
  "list_groups",
  {
    description:
      "List the figure groups (id, name, parentId nesting, hidden/locked state, member element ids — deep), across the project or one figure.",
    inputSchema: { figureId: z.string().optional() },
  },
  async ({ figureId }) => {
    const r = await core.listGroups(ROOT, figureId);
    return ok(JSON.stringify(r.groups, null, 2));
  },
);

server.registerTool(
  "set_figure_layout",
  {
    description: "Set a figure's frame: position (x,y), size (width,height), background color, and/or name. Only the fields you pass change.",
    inputSchema: {
      figureId: z.string(),
      x: z.number().optional(),
      y: z.number().optional(),
      width: z.number().optional(),
      height: z.number().optional(),
      background: z.string().optional(),
      name: z.string().optional(),
    },
  },
  async ({ figureId, x, y, width, height, background, name }) => {
    const patch: Parameters<typeof core.setFigureLayout>[2] = {};
    if (x != null) patch.x = x;
    if (y != null) patch.y = y;
    if (width != null) patch.width = width;
    if (height != null) patch.height = height;
    if (background != null) patch.background = background;
    if (name != null) patch.name = name;
    await core.setFigureLayout(ROOT, figureId, patch);
    return ok(`set layout on ${figureId}`);
  },
);

server.registerTool(
  "set_z",
  {
    description: "Change elements' stacking order within their figure: front, back, forward (one step up), or backward (one step down). For an absolute index use reorder_element.",
    inputSchema: { figureId: z.string(), ids: z.array(z.string()), where: z.enum(["front", "back", "forward", "backward"]) },
  },
  async ({ figureId, ids, where }) => {
    await core.setZOrder(ROOT, figureId, ids, where);
    return ok(`z-order ${where} for ${ids.length} element(s) in ${figureId}`);
  },
);

server.registerTool(
  "render_figure",
  {
    description:
      "Render a figure to SVG text (per-part plot overrides baked in) — the vector source. For a raster preview an agent can SEE, use get_figure_image (PNG) instead.",
    inputSchema: { id: z.string() },
  },
  async ({ id }) => ok(await core.renderFigureSvg(ROOT, id)),
);

server.registerTool(
  "get_caption",
  {
    description: "Read a figure's composed caption (fig/captions/<id>.md — figure caption + per-panel captions). Use before set_caption to see the current text.",
    inputSchema: { figureId: z.string() },
  },
  async ({ figureId }) => ok((await core.captionFor(ROOT, figureId)) || `(no caption for ${figureId})`),
);

server.registerTool(
  "reconcile",
  {
    description:
      "Reconcile the project's cited references against the machine-global FluxLib: re-materialize references/library.bib from cited keys, promote any project-only entries into FluxLib, and report orphaned citekeys (cited but not found). Run after editing citations by hand.",
    inputSchema: {},
  },
  async () => {
    const r = await core.reconcile(ROOT);
    return ok(
      `reconciled: ${r.materialized.length} materialized, ${r.promoted.length} promoted to FluxLib` +
        (r.orphans.length ? `, ${r.orphans.length} orphan(s): ${r.orphans.join(", ")}` : ""),
    );
  },
);

server.registerTool(
  "rerun_plot",
  {
    description: "Re-run a plot's recipe (regenerate the figure from its source script + params). Params may be strings, numbers, or booleans.",
    inputSchema: { recipePath: z.string(), params: z.record(z.union([z.string(), z.number(), z.boolean()])).optional() },
  },
  async ({ recipePath, params }) => {
    const r = await core.runRecipe(recipePath, params ?? {});
    return ok(`recipe exited ${r.code}; wrote ${r.svgPath}`);
  },
);

server.registerTool(
  "get_manuscript",
  { description: "Read a manuscript document's text (.qmd). Omit doc for the main manuscript.", inputSchema: { doc: z.string().optional() } },
  async ({ doc }) => ok(await core.getManuscript(ROOT, doc)),
);

server.registerTool(
  "set_manuscript",
  { description: "Overwrite a manuscript document's full text (.qmd). Omit doc for the main manuscript.", inputSchema: { text: z.string(), doc: z.string().optional() } },
  async ({ text, doc }) => {
    await core.setManuscript(ROOT, text, doc);
    return ok("manuscript written");
  },
);

server.registerTool(
  "list_documents",
  { description: "List the project's documents (main + supplementary + scanned manuscript/**.qmd).", inputSchema: {} },
  async () => ok(JSON.stringify(await core.listDocuments(ROOT), null, 2)),
);

server.registerTool(
  "create_document",
  { description: "Create a new blank document (registered in the manifest).", inputSchema: { name: z.string() } },
  async ({ name }) => {
    const r = await core.createDocument(ROOT, name);
    return ok(`created ${r.path}`);
  },
);

server.registerTool(
  "insert_figure_ref",
  { description: "Append a figure cross-reference (@fig-<label>) to a document.", inputSchema: { figureId: z.string(), doc: z.string().optional() } },
  async ({ figureId, doc }) => {
    const r = await core.insertFigureRef(ROOT, figureId, doc);
    return ok(`inserted ${r.ref}`);
  },
);

server.registerTool(
  "cite_doi",
  {
    description:
      "Fetch a DOI's BibTeX (content negotiation), add it to FluxLib (deterministic citekey, deduped by DOI), and cite it in this project (materialized into references/library.bib). Returns the citekey(s) to use as @key.",
    inputSchema: { doi: z.string() },
  },
  async ({ doi }) => {
    const r = await core.citeDoi(ROOT, doi);
    return ok(`cited @${r.keys.join("; @")} — ${r.bibtex.slice(0, 60).replace(/\s+/g, " ")}…`);
  },
);

server.registerTool(
  "compile",
  { description: "Compile the manuscript via Quarto (pdf|html|docx). Requires quarto on PATH.", inputSchema: { to: z.string().optional() } },
  async ({ to }) => {
    const r = await core.compile(ROOT, to ?? "pdf");
    return ok(`quarto exited ${r.code}`);
  },
);

server.registerTool(
  "list_comments",
  {
    description:
      "List a document's review comments (the human's margin comments). Open threads by default. Each thread's anchor.quote is the EXACT manuscript text the comment targets — find that text in the .qmd, address it, then call resolve_comment. Omit doc for the main manuscript.",
    inputSchema: { doc: z.string().optional(), includeResolved: z.boolean().optional() },
  },
  async ({ doc, includeResolved }) => {
    const threads = await core.listComments(ROOT, doc);
    const shown = includeResolved ? threads : threads.filter((t) => !t.resolved);
    return ok(JSON.stringify(shown, null, 2));
  },
);

server.registerTool(
  "resolve_comment",
  {
    description:
      "Mark a review comment resolved — by thread id, or a substring of its quoted text (must match exactly one). Optionally append a reply note. Holds the manuscript lock + journals. Call this AFTER addressing the comment in the .qmd (set_manuscript). Omit doc for the main manuscript.",
    inputSchema: { id: z.string(), doc: z.string().optional(), note: z.string().optional() },
  },
  async ({ id, doc, note }) => {
    const r = await core.resolveComment(ROOT, id, { docRel: doc, note });
    return ok(`resolved ${r.id} (${r.resolved}/${r.total} resolved)`);
  },
);

server.registerTool(
  "validate_project",
  {
    description: "Validate the project (or one file) against the bundled JSON Schemas (.meta/schema/). Use after editing files directly to confirm your writes are well-formed.",
    inputSchema: { file: z.string().optional() },
  },
  async ({ file }) => {
    const r = await core.validate(ROOT, file);
    return ok(r.ok ? `valid (${r.checked} file(s) checked)` : `INVALID (${r.errors.length}):\n` + r.errors.join("\n"));
  },
);

server.registerTool(
  "validate_plot",
  {
    description: "Validate a FluxPlot output: the .fluxplot.json manifest is schema-valid AND every id it references exists in the .svg (so the plot is genuinely part-addressable/restylable).",
    inputSchema: { svgPath: z.string() },
  },
  async ({ svgPath }) => {
    const r = await core.validatePlot(svgPath);
    return ok(r.ok ? `valid FluxPlot (${r.matched}/${r.references} ids matched)` : `INVALID (${r.errors.length}):\n` + r.errors.join("\n"));
  },
);

// --- FluxFinder (PDF acquisition) + FluxReader (full text + annotations) ------

server.registerTool(
  "fetch_pdfs",
  {
    description:
      "Find & download open-access PDFs for FluxLib entries into items/<citekey>/ (Unpaywall · Europe PMC · PMC · arXiv · bioRxiv · Crossref; first magic-byte-valid PDF wins), and extract fulltext.txt. Incremental: skips entries that already have a PDF unless refresh. `keys` limits to specific citekeys (default: the whole library). Returns a coverage summary.",
    inputSchema: { keys: z.array(z.string()).optional(), refresh: z.boolean().optional() },
  },
  async ({ keys, refresh }) => {
    const s = await core.fetchPdfs({ keys, refresh });
    const got = s.results.filter((r) => r.status === "got").map((r) => `  ✓ ${r.key} (${r.source})`);
    return ok(
      `PDFs: ${s.got} fetched, ${s.have} already had, ${s.noOa} no open-access copy, ${s.noId} no DOI/PMCID` +
        (s.skipped ? `, ${s.skipped} skipped (cached no-OA; refresh to re-check)` : "") +
        ` (of ${s.total}).` +
        (got.length ? "\n" + got.join("\n") : ""),
    );
  },
);

server.registerTool(
  "ingest_pdf",
  {
    description:
      "Store a PDF you already have on disk into FluxLib for a citekey (items/<citekey>/paper.pdf) and extract its fulltext — the manual fallback when fetch_pdfs can't find an open-access copy (paywalled/proxy-only papers). `key` is the citekey; `filePath` is an absolute path to the .pdf.",
    inputSchema: { key: z.string(), filePath: z.string() },
  },
  async ({ key, filePath }) => {
    const r = await core.ingestPdf(filePath, { key });
    return ok(`ingested ${filePath} → @${key} (${r.status})`);
  },
);

server.registerTool(
  "assign_pdfs",
  {
    description:
      "Scan the watched inbox ~/FluxLib/pdfs_to_assign/ and file each PDF by identifying it from its OWN content (DOI-first, cross-validated against the paper's title — never the filename): attach to an existing reference lacking a PDF, keep as a supplement if that reference already has a different PDF (byte-identical copies are dropped), or add the reference then attach. PDFs that can't be identified with confidence are moved to pdfs_to_assign/_unresolved/ with a note (never guessed); transient network failures leave files IN PLACE as 'deferred' to retry later. Pass dryRun:true to report the planned action per file WITHOUT changing anything — recommended first.",
    inputSchema: { dryRun: z.boolean().optional() },
  },
  async ({ dryRun }) => {
    const s = await core.assignPdfs({ dryRun });
    const verb = dryRun ? "would " : "";
    const lines = s.results.map((it) =>
      it.action === "unresolved"
        ? `  ? ${it.file} — UNRESOLVED: ${it.reason}`
        : it.action === "deferred"
          ? `  ~ ${it.file} — deferred (left in inbox): ${it.reason}`
          : it.action === "discarded"
            ? `  = ${it.file} — ${verb}duplicate of ${it.key}${it.keptAs ? `, kept as supplements/${it.keptAs}` : " (byte-identical, dropped)"} [${it.doi}]`
            : it.action === "attached"
              ? `  + ${it.file} — ${verb}attach → ${it.key} [${it.method}] ${it.doi}`
              : `  ★ ${it.file} — ${verb}add+attach${it.key ? ` → ${it.key}` : ""} [${it.method}] ${it.doi}`,
    );
    return ok(
      `${dryRun ? "DRY RUN — " : ""}${s.total} PDF(s) in ${s.dir}: ${s.attached} attach, ${s.addedAttached} add+attach, ${s.discarded} duplicate, ${s.unresolved} unresolved` +
        (s.deferred ? `, ${s.deferred} deferred (network — left in inbox)` : "") +
        (s.abortedOffline ? " — ABORTED: network unavailable" : "") +
        (dryRun ? " (nothing changed)" : "") +
        (lines.length ? "\n" + lines.join("\n") : ""),
    );
  },
);

server.registerTool(
  "get_paper_text",
  {
    description:
      "Return the extracted full text of a FluxLib paper's stored PDF (items/<citekey>/fulltext.txt; extracted on demand if absent). Use this to READ a paper you've fetched. Pages are separated by a form-feed (\\f). `key` is the citekey; `maxChars` truncates.",
    inputSchema: { key: z.string(), maxChars: z.number().optional() },
  },
  async ({ key, maxChars }) => {
    const t = await core.getOrExtractFulltext(key);
    if (!t)
      return ok(`No text for ${key} — fetch its PDF first (fetch_pdfs {keys:["${key}"]}), or it may be a scanned/image PDF.`);
    return ok(maxChars && t.length > maxChars ? t.slice(0, maxChars) + `\n…[truncated ${t.length - maxChars} chars]` : t);
  },
);

server.registerTool(
  "list_annotations",
  {
    description:
      "List the highlights/notes a human has made on a paper (items/<citekey>/annotations.json) — each with its anchored quote, page, color, and note. `key` is the citekey. Set `markdown:true` for a formatted digest (title header + page-grouped blockquotes) ready to paste into notes or a manuscript.",
    inputSchema: { key: z.string(), markdown: z.boolean().optional() },
  },
  async ({ key, markdown }) => {
    if (markdown) return ok(await core.annotationsMarkdown(key));
    const anns = await core.listAnnotations(key);
    if (!anns.length) return ok(`No annotations on ${key}.`);
    return ok(anns.map((a) => `p${a.page} [${a.color}] "${a.anchor.quote}"${a.note ? ` — ${a.note}` : ""}`).join("\n"));
  },
);

server.registerTool(
  "search_fulltext",
  {
    description:
      "Full-text search across the extracted text of EVERY stored PDF in FluxLib (items/<key>/fulltext.txt) — 'which of my papers mention optogenetic silencing?'. AND semantics over terms; quote a phrase for verbatim matching. Returns per-paper hit counts + page-numbered snippets. Contrast: search_references matches metadata/abstracts; get_paper_text reads ONE paper.",
    inputSchema: {
      query: z.string(),
      limit: z.number().optional(),
      keys: z.array(z.string()).optional(),
    },
  },
  async ({ query, limit, keys }) => {
    const r = await core.searchFulltext(query, { limit, keys });
    if (!r.hits.length) {
      return ok(
        `No stored PDF text matches "${query}" (scanned ${r.scanned}).` +
          (r.missingText.length ? ` ${r.missingText.length} PDF(s) have no extracted text yet — get_paper_text extracts on demand.` : ""),
      );
    }
    const lines = r.hits.map((h) => `@${h.key} (${h.count})\n` + h.snippets.map((s) => `  p${s.page}: ${s.text}`).join("\n"));
    return ok(
      `${r.hits.length} paper(s) match "${query}" (scanned ${r.scanned} in ${r.elapsedMs}ms${r.truncated ? "; hit limit" : ""}):\n` +
        lines.join("\n"),
    );
  },
);

server.registerTool(
  "organize_paper",
  {
    description:
      "Set library organization on a paper (keyed by citekey): add/remove tags, set reading status (unread|reading|read), and/or set its collections. Persisted to .fluxlib/organize.json and searchable via search_references with `tag:`, `status:`, `collection:`. Citekeys are immutable so this metadata never detaches.",
    inputSchema: {
      key: z.string(),
      addTags: z.array(z.string()).optional(),
      removeTags: z.array(z.string()).optional(),
      status: z.enum(["unread", "reading", "read"]).optional(),
      collections: z.array(z.string()).optional(),
    },
  },
  async ({ key, addTags, removeTags, status, collections }) => {
    const org = await core.loadOrganize();
    let tags = org.items[key]?.tags ?? [];
    if (addTags?.length) tags = [...tags, ...addTags];
    if (removeTags?.length) {
      const rm = new Set(removeTags.map((t) => t.toLowerCase()));
      tags = tags.filter((t) => !rm.has(t.toLowerCase()));
    }
    if (addTags || removeTags) await core.organizeSetTags(key, tags);
    if (status) await core.organizeSetStatus(key, status);
    if (collections) await core.organizeSetCollections(key, collections);
    const e = (await core.loadOrganize()).items[key];
    return ok(`Organized @${key} — tags: ${(e?.tags ?? []).join(", ") || "none"} · status: ${e?.status ?? "unread"} · collections: ${(e?.collections ?? []).join(", ") || "none"}`);
  },
);

server.registerTool(
  "search_annotations",
  {
    description:
      "Search a human's highlights/notes across the WHOLE FluxLib (or one paper via `key`) — matches the highlighted quote + note text. Returns each hit with its citekey, page, color, quote, and note. Use for 'what have I flagged about X?'.",
    inputSchema: { query: z.string(), key: z.string().optional() },
  },
  async ({ query, key }) => {
    const hits = await core.searchAnnotations(query, { key });
    if (!hits.length) return ok(`No annotations match "${query}".`);
    return ok(hits.map((h) => `@${h.key} p${h.page} [${h.color}] "${h.anchor.quote}"${h.note ? ` — ${h.note}` : ""}`).join("\n"));
  },
);

server.registerTool(
  "add_annotation",
  {
    description:
      "Add a highlight/note to a FluxLib paper (items/<citekey>/annotations.json) — the same annotations FluxReader shows the human. `quote` is the exact text to highlight; `prefix`/`suffix` are the surrounding text that disambiguates it on the page (find them in get_paper_text). `page` is 1-based.",
    inputSchema: {
      key: z.string(),
      page: z.number(),
      quote: z.string(),
      prefix: z.string().optional(),
      suffix: z.string().optional(),
      color: z.enum(["yellow", "green", "blue", "pink", "orange"]).optional(),
      note: z.string().optional(),
      tags: z.array(z.string()).optional(),
    },
  },
  async ({ key, page, quote, prefix, suffix, color, note, tags }) => {
    const a = await core.addAnnotation(key, {
      page,
      anchor: { quote, prefix: prefix ?? "", suffix: suffix ?? "" },
      color: color ?? "yellow",
      note,
      tags,
    });
    return ok(`added annotation ${a.id} on @${key} p${page} [${a.color}]`);
  },
);

server.registerTool(
  "get_reading_context",
  {
    description:
      "What the human is reading in FluxReader RIGHT NOW — the open paper (citekey, title, authors, DOI), current page, their current text selection (if any), and their highlights. Start here when the human opens you from the reader ('what does this mean?', 'summarize this'): the `selection` is what they're pointing at. Then use get_paper_text {key} for the full text and search_annotations for their notes.",
    inputSchema: {},
  },
  async () => {
    const c = await core.readReaderContext();
    if (!c || !c.citekey) return ok("No paper is open in FluxReader right now.");
    return ok(JSON.stringify(c, null, 2));
  },
);

// --- Flux Slide: author + animate decks headlessly (W11b / SLD-6) ------------
// The whole Slides pillar had ZERO MCP tools; agents could not build a deck.

const PRESETS = [
  "fade", "fadeRise", "popIn", "drawOn", "growBaseline", "stagger", "writeOn",
  "fadeOut", "popOut", "drawOff", "wipeOut",
  "highlight", "dim", "move", "scale", "rotate", "camera", "countUp", "morph",
] as const;
const LAYOUTS = ["title", "section", "content-figure", "two-column", "full-bleed", "blank"] as const;
const THEMES = ["flux-dark", "flux-light", "flux-midnight", "flux-slate", "flux-sepia", "flux-contrast"] as const;

server.registerTool(
  "list_decks",
  { description: "List the project's slide decks (id, title, slide count) from project.json.", inputSchema: {} },
  async () => ok(JSON.stringify(await core.listDecks(ROOT), null, 2)),
);

server.registerTool(
  "create_deck",
  {
    description: "Create a new slide deck (slides/<id>/deck.json, registered in the manifest). Returns the deck id.",
    inputSchema: { id: z.string().optional(), title: z.string().optional(), theme: z.enum(THEMES).optional() },
  },
  async ({ id, title, theme }) => {
    const r = await core.createDeck(ROOT, { id, title, theme });
    return ok(`created deck ${r.deckId} (${r.path})`);
  },
);

server.registerTool(
  "add_slide",
  {
    description: "Append a slide to a deck. `layout` seeds the slide's role (title/section/content-figure/two-column/full-bleed/blank). Returns the new slide id.",
    inputSchema: { deckId: z.string(), name: z.string().optional(), layout: z.enum(LAYOUTS).optional() },
  },
  async ({ deckId, name, layout }) => {
    const r = await core.addSlide(ROOT, deckId, { name, layout });
    return ok(`added slide ${r.slideId} to ${deckId}`);
  },
);

server.registerTool(
  "delete_slide",
  {
    description: "Delete a slide from a deck. Returns the id the GUI would select next.",
    inputSchema: { deckId: z.string(), slideId: z.string() },
  },
  async ({ deckId, slideId }) => {
    const r = await core.deleteSlide(ROOT, deckId, slideId);
    return ok(`deleted slide ${slideId}${r.nextActiveId ? ` (next: ${r.nextActiveId})` : ""}`);
  },
);

server.registerTool(
  "duplicate_slide",
  {
    description: "Deep-copy a slide (fresh element/beat/track ids). Returns the new slide id.",
    inputSchema: { deckId: z.string(), slideId: z.string() },
  },
  async ({ deckId, slideId }) => {
    const r = await core.duplicateSlide(ROOT, deckId, slideId);
    return ok(`duplicated slide ${slideId} → ${r.slideId}`);
  },
);

server.registerTool(
  "reorder_slides",
  {
    description: "Set the deck's slide order to exactly `order` (a permutation of the current slide ids).",
    inputSchema: { deckId: z.string(), order: z.array(z.string()) },
  },
  async ({ deckId, order }) => {
    await core.reorderSlides(ROOT, deckId, order);
    return ok(`reordered ${deckId} (${order.length} slides)`);
  },
);

server.registerTool(
  "set_slide",
  {
    description: "Patch a slide: name, layout, background (CSS color), transition, notes (speaker notes, markdown), and/or camera (base pose {x,y,zoom}). Only the fields you pass change.",
    inputSchema: {
      deckId: z.string(),
      slideId: z.string(),
      name: z.string().optional(),
      layout: z.enum(LAYOUTS).optional(),
      background: z.string().optional(),
      transition: z.string().optional(),
      notes: z.string().optional(),
      camera: z.object({ x: z.number(), y: z.number(), zoom: z.number() }).optional(),
    },
  },
  async ({ deckId, slideId, name, layout, background, transition, notes, camera }) => {
    const patch: Parameters<typeof core.setSlide>[3] = {};
    if (name != null) patch.name = name;
    if (layout != null) patch.layout = layout;
    if (background != null) patch.background = background;
    if (transition != null) patch.transition = transition as typeof patch.transition;
    if (notes != null) patch.notes = notes;
    if (camera != null) patch.camera = camera;
    await core.setSlide(ROOT, deckId, slideId, patch);
    return ok(`set slide ${slideId}`);
  },
);

server.registerTool(
  "set_deck_theme",
  {
    description: "Switch a deck's theme (flux-dark | flux-light | flux-midnight | flux-slate | flux-sepia | flux-contrast).",
    inputSchema: { deckId: z.string(), theme: z.enum(THEMES) },
  },
  async ({ deckId, theme }) => {
    await core.setDeckTheme(ROOT, deckId, theme);
    return ok(`set theme ${theme} on ${deckId}`);
  },
);

server.registerTool(
  "add_slide_text",
  {
    description: "Add a text box to a slide. Returns the new element id (use it as an animation target).",
    inputSchema: {
      deckId: z.string(),
      slideId: z.string(),
      text: z.string(),
      x: z.number().optional(), y: z.number().optional(), width: z.number().optional(), height: z.number().optional(),
      align: z.enum(["left", "center", "right"]).optional(),
      color: z.string().optional(),
      fontSize: z.number().optional(),
    },
  },
  async ({ deckId, slideId, text, x, y, width, height, align, color, fontSize }) => {
    const r = await core.addTextToSlide(ROOT, deckId, slideId, { text, x, y, width, height, align, color, fontSize });
    return ok(`added text ${r.elementId} to ${slideId}`);
  },
);

server.registerTool(
  "add_slide_math",
  {
    description: "Add a KaTeX math element to a slide (`tex` is a LaTeX string). Returns the new element id.",
    inputSchema: {
      deckId: z.string(),
      slideId: z.string(),
      tex: z.string(),
      display: z.boolean().optional(),
      x: z.number().optional(), y: z.number().optional(), width: z.number().optional(), height: z.number().optional(),
      color: z.string().optional(),
      fontSize: z.number().optional(),
    },
  },
  async ({ deckId, slideId, tex, display, x, y, width, height, color, fontSize }) => {
    const r = await core.addMathToSlide(ROOT, deckId, slideId, { tex, display, x, y, width, height, color, fontSize });
    return ok(`added math ${r.elementId} to ${slideId}`);
  },
);

server.registerTool(
  "add_slide_figure",
  {
    description:
      "Embed a project figure (by its figure id, from fig/index.json) onto a slide — its panels stay addressable so you can animate them (stagger a→b→c). This is the way to put your composed figures into a deck (no asset upload needed). Returns the new element id.",
    inputSchema: {
      deckId: z.string(),
      slideId: z.string(),
      figureId: z.string(),
      fit: z.enum(["contain", "cover", "fill"]).optional(),
      x: z.number().optional(), y: z.number().optional(), width: z.number().optional(), height: z.number().optional(),
    },
  },
  async ({ deckId, slideId, figureId, fit, x, y, width, height }) => {
    const r = await core.addEmbedFigureToSlide(ROOT, deckId, slideId, { figureId, fit, x, y, width, height });
    return ok(`embedded figure ${figureId} → ${r.elementId} on ${slideId}`);
  },
);

server.registerTool(
  "add_beat",
  {
    description:
      "Append a build beat to a slide — one 'advance' (click) step of its timeline. Beat 0 is the resting state; add beats, then set_animation on them. Returns the new beat id.",
    inputSchema: { deckId: z.string(), slideId: z.string(), label: z.string().optional() },
  },
  async ({ deckId, slideId, label }) => {
    const r = await core.addBeat(ROOT, deckId, slideId, { label });
    return ok(`added beat ${r.beatId} to ${slideId}`);
  },
);

server.registerTool(
  "set_animation",
  {
    description:
      "Add (or replace) an animation track on a beat — the general mechanism behind every preset. `target` is an element id, or '@camera'/'@stage'. `preset` picks the motion (fade, fadeRise, popIn, drawOn, stagger, writeOn, highlight, dim, move, scale, rotate, camera, morph, …). `part` targets one plot semantic id — or, on an embedFigure element, one of the figure's named groups as 'group:<groupId>' (group ids from the figure-side list_groups / groups digest; the group animates as one unit). `to` is the destination for morph (to.assetId = a second same-structure plot) / camera (to.{x,y,zoom}). `start`/`duration` are ms within the beat.",
    inputSchema: {
      deckId: z.string(),
      slideId: z.string(),
      beatId: z.string(),
      target: z.string(),
      preset: z.enum(PRESETS).optional(),
      part: z.string().optional(),
      start: z.number().optional(),
      duration: z.number().optional(),
      easing: z.string().optional(),
      params: z.record(z.any()).optional(),
      to: z.object({ assetId: z.string().optional(), x: z.number().optional(), y: z.number().optional(), zoom: z.number().optional() }).optional(),
    },
  },
  async ({ deckId, slideId, beatId, target, preset, part, start, duration, easing, params, to }) => {
    const track: import("./src/lib/slide/types").Track = { target };
    if (preset) track.preset = preset;
    if (part) track.part = part;
    if (start != null) track.start = start;
    if (duration != null) track.duration = duration;
    if (easing) track.easing = easing as import("./src/lib/slide/types").EasingToken;
    if (params) track.params = params;
    if (to) track.to = to;
    await core.setAnimation(ROOT, deckId, slideId, beatId, track);
    return ok(`set animation on beat ${beatId} (${preset ?? "keyframes"} → ${target})`);
  },
);

server.registerTool(
  "set_beat",
  {
    description: "Patch a beat: label, advance mode ('click' = manual step, 'with-prev' = chains onto the previous press, 'auto' = plays autoDelayMs after the previous beat finishes), autoDelayMs.",
    inputSchema: {
      deckId: z.string(), slideId: z.string(), beatId: z.string(),
      label: z.string().optional(),
      advance: z.enum(["click", "with-prev", "auto"]).optional(),
      autoDelayMs: z.number().optional(),
    },
  },
  async ({ deckId, slideId, beatId, ...patch }) => {
    await core.setBeat(ROOT, deckId, slideId, beatId, patch);
    return ok(`set beat ${beatId}`);
  },
);

server.registerTool(
  "reorder_beats",
  {
    description: "Set a slide's beat order to `order` (beat ids). Beat 0 — the resting state — is pinned and never moves.",
    inputSchema: { deckId: z.string(), slideId: z.string(), order: z.array(z.string()) },
  },
  async ({ deckId, slideId, order }) => {
    await core.reorderBeats(ROOT, deckId, slideId, order);
    return ok(`reordered beats on ${slideId}`);
  },
);

server.registerTool(
  "move_track",
  {
    description: "Move an animation track (by id) into another beat on the same slide; timing travels untouched. `at` picks the lane index.",
    inputSchema: { deckId: z.string(), slideId: z.string(), trackId: z.string(), toBeatId: z.string(), at: z.number().optional() },
  },
  async ({ deckId, slideId, trackId, toBeatId, at }) => {
    await core.moveTrack(ROOT, deckId, slideId, trackId, toBeatId, at);
    return ok(`moved track ${trackId} → beat ${toBeatId}`);
  },
);

server.registerTool(
  "duplicate_track",
  {
    description: "Deep-copy a track in place (fresh id, inserted after the original). Returns the new track id.",
    inputSchema: { deckId: z.string(), slideId: z.string(), trackId: z.string() },
  },
  async ({ deckId, slideId, trackId }) => {
    const r = await core.duplicateTrack(ROOT, deckId, slideId, trackId);
    return ok(`duplicated track ${trackId} → ${r.trackId}`);
  },
);

server.registerTool(
  "reorder_tracks",
  {
    description: "Set one beat's track (lane) order to `order` (track ids). Order is presentational — tracks in a beat play concurrently.",
    inputSchema: { deckId: z.string(), slideId: z.string(), beatId: z.string(), order: z.array(z.string()) },
  },
  async ({ deckId, slideId, beatId, order }) => {
    await core.reorderTracks(ROOT, deckId, slideId, beatId, order);
    return ok(`reordered tracks on beat ${beatId}`);
  },
);

server.registerTool(
  "set_track_enabled",
  {
    description: "Disable/enable a track. Disabled tracks keep their authored timing but are invisible to play/preview/export (the non-destructive Mask substrate).",
    inputSchema: { deckId: z.string(), slideId: z.string(), trackId: z.string(), enabled: z.boolean() },
  },
  async ({ deckId, slideId, trackId, enabled }) => {
    await core.setTrackEnabled(ROOT, deckId, slideId, trackId, enabled);
    return ok(`track ${trackId} ${enabled ? "enabled" : "disabled"}`);
  },
);

server.registerTool(
  "set_part_visibility",
  {
    description: "A plot part's resting tri-state on a slide: 'show' (visible from beat 0), 'animate' (revealed by its track), 'mask' (always hidden). Mask/show DISABLE the part's tracks rather than deleting them.",
    inputSchema: { deckId: z.string(), elementId: z.string(), part: z.string(), mode: z.enum(["show", "animate", "mask"]) },
  },
  async ({ deckId, elementId, part, mode }) => {
    await core.setPartVisibility(ROOT, deckId, elementId, part, mode);
    return ok(`${part} → ${mode}`);
  },
);

server.registerTool(
  "set_part_style",
  {
    description: "Merge a style patch into one plot part's override on a slide element — stroke, fill, strokeWidth, opacity, fontSize, fontFamily, fontWeight, hidden. Null deletes a key. Part may be a leaf ('fit.line') or group ('axis.x.ticks') id.",
    inputSchema: { deckId: z.string(), elementId: z.string(), part: z.string(), patch: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])) },
  },
  async ({ deckId, elementId, part, patch }) => {
    await core.setPartStyle(ROOT, deckId, elementId, part, patch);
    return ok(`styled ${part}`);
  },
);

server.registerTool(
  "animate_part",
  {
    description: "Make ONE plot part animate in: re-enables its existing tracks (authored timing preserved) or adds the plot's suggested default reveal on a build beat. Returns the beat index used.",
    inputSchema: { deckId: z.string(), slideId: z.string(), elementId: z.string(), part: z.string(), beatIndex: z.number().optional() },
  },
  async ({ deckId, slideId, elementId, part, beatIndex }) => {
    const r = await core.animatePartVerb(ROOT, deckId, slideId, elementId, part, beatIndex);
    return ok(`${part} animates on beat ${r.beatIndex}`);
  },
);

server.registerTool(
  "animate_element",
  {
    description: "Give a whole element (text box / shape / line / image / math / video) an enter or exit animation with sensible per-kind defaults (textBox→staggered bullet fadeRise, line→drawOn, math→writeOn; exits: fadeOut/popOut/drawOff/wipeOut). The non-plot analog of animate_part. `part` narrows to a named node inside the element — on an embedFigure, 'group:<groupId>' animates one of the figure's named groups (enter fade / exit fadeOut).",
    inputSchema: {
      deckId: z.string(), slideId: z.string(), elementId: z.string(),
      exit: z.boolean().optional(), preset: z.enum(PRESETS).optional(),
      beatIndex: z.number().optional(), wholeBox: z.boolean().optional(),
      part: z.string().optional(),
    },
  },
  async ({ deckId, slideId, elementId, ...opts }) => {
    const r = await core.animateElementVerb(ROOT, deckId, slideId, elementId, opts);
    return ok(`element ${elementId} ${opts.exit ? "animates out" : "animates in"} on beat ${r.beatIndex} (track ${r.trackId})`);
  },
);

server.registerTool(
  "set_morph",
  {
    description: "Author the data-space morph: a plot element tweens into ANY project plot (by asset id) on a beat. Refuses structurally-incompatible pairs (no shared tweenable series) unless force.",
    inputSchema: {
      deckId: z.string(), slideId: z.string(), beatId: z.string(), elementId: z.string(), toAssetId: z.string(),
      duration: z.number().optional(), force: z.boolean().optional(),
    },
  },
  async ({ deckId, slideId, beatId, elementId, toAssetId, duration, force }) => {
    await core.setMorph(ROOT, deckId, slideId, beatId, elementId, toAssetId, { duration, force });
    return ok(`morph ${elementId} → ${toAssetId} on beat ${beatId}`);
  },
);

server.registerTool(
  "validate_deck",
  {
    description: "Validate a deck (or all decks) against the bundled deck JSON Schema. Run after editing deck.json by hand.",
    inputSchema: { deckId: z.string().optional() },
  },
  async ({ deckId }) => {
    const r = await core.validateDeck(ROOT, deckId);
    return ok(r.ok ? `valid deck(s) (${r.checked} checked)` : `INVALID (${r.errors.length}):\n` + r.errors.join("\n"));
  },
);

server.registerTool(
  "export_deck",
  {
    description: "Export a deck to a single self-contained offline .html (animations + media inlined). Writes to exports/ by default.",
    inputSchema: { deckId: z.string(), out: z.string().optional() },
  },
  async ({ deckId, out }) => {
    const r = await core.exportDeck(ROOT, deckId, { out });
    return ok(`exported ${deckId} → ${r.path} (${(r.bytes / 1024).toFixed(0)} KB)` + (r.warnings.length ? `\n  ⚠ ${r.warnings.join("\n  ⚠ ")}` : ""));
  },
);

// --- Live bridge: read/act on the running app (only while Flux is open) -------

server.registerTool(
  "get_app_context",
  {
    description:
      "Read the LIVE Flux app UI state — what the human currently has selected, the active figure/canvas, the drilled-in plot part, the viewport, and a digest of the active figure. Only works while the Flux app is open; otherwise read the files.",
    inputSchema: {},
  },
  async () => ok(JSON.stringify(await live.getAppContext(ROOT), null, 2)),
);

server.registerTool(
  "dispatch_command",
  {
    description:
      "Apply an allow-listed command to the LIVE Flux app — the SAME undoable edit a human makes (Ctrl+Z reverts it). Defaults to the human's current selection / active figure. Examples: {type:'restyle_part',partId:'control.line',patch:{stroke:'#1b9e77'}}, {type:'add_text',text:'n.s.',x:120,y:40}, {type:'set_style',patch:{arrowEnd:true,arrowStyle:'vee',arrowSize:5,cap:'round'}} (line/arrow: cap butt|round|square, arrowStyle filled|vee, arrowSize ×strokeWidth), {type:'toggle_text_style',which:'bold'}, {type:'apply_text_style',styleId:'ts-panel-label'}, {type:'flip',ids:['el_…'],axis:'h'}, {type:'arrange',rows:2}, {type:'auto_label'}, {type:'align',kind:'left'}. Types: select (also {groupId} — selects a group's members), clear_selection, restyle_part, set_style, rotate, arrange, align, distribute, auto_label, group {ids?, name?, parentId?} → named nestable group, ungroup, rename_group {groupId, name}, set_group_state {groupId, hidden?, locked?}, list_groups {figureId?}, set_z, add_path, edit_path, set_guides, duplicate, scale, select_matching, delete, set_figure_layout, duplicate_figure, create_figure, add_text, add_plot, add_image, flip, set_caption, import_plots (batch {type:'import_plots',paths:['/abs/plot.svg',…]} into the active figure), toggle_text_style {which:'bold'|'italic'|'underline'}, create_text_style {name, fromElementId?|style?}, update_text_style {styleId, patch}, delete_text_style {styleId}, apply_text_style {styleId, ids?}, list_text_styles {global?}, set_crop {id?, crop:{x,y,width,height}|null — intrinsic content px; content-pinned; null resets}.",
    inputSchema: { command: z.record(z.any()) },
  },
  async ({ command }) => ok("dispatched: " + JSON.stringify(await live.dispatchCommand(ROOT, command))),
);

server.registerTool(
  "act_on_selection",
  {
    description:
      "Convenience over the live bridge: restyle the plot part the human currently has drilled into. e.g. {patch:{stroke:'#e00000',strokeWidth:3}}. Requires the app open with a plot part selected.",
    inputSchema: { patch: z.record(z.any()) },
  },
  async ({ patch }) => ok("acted on selection: " + JSON.stringify(await live.dispatchCommand(ROOT, { type: "restyle_part", patch }))),
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`flux MCP server on stdio (project: ${ROOT})`);
