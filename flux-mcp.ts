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
  "set_caption",
  { description: "Write a figure's caption to fig/captions/<id>.md (the single caption source).", inputSchema: { id: z.string(), markdown: z.string() } },
  async ({ id, markdown }) => {
    await core.setCaption(ROOT, id, markdown);
    return ok(`caption set for ${id}`);
  },
);

server.registerTool(
  "add_reference",
  { description: "Append a BibTeX entry to the project's library.bib.", inputSchema: { bibtex: z.string() } },
  async ({ bibtex }) => {
    await core.addReference(ROOT, bibtex);
    return ok("reference added");
  },
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
    return ok(`added panel ${r.elementId} (asset ${r.assetId})`);
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
    return ok(`composed figure ${r.figureId} — panels [${r.panels.join("")}] ${r.width}×${r.height}`);
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
    return ok(`labeled ${figureId}: ${r.panels.join("")}`);
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
    description: "Set element-level style (fill/stroke/strokeWidth/opacity/color/fontSize) on element ids.",
    inputSchema: {
      ids: z.array(z.string()),
      fill: z.string().optional(),
      stroke: z.string().optional(),
      strokeWidth: z.number().optional(),
      opacity: z.number().optional(),
      color: z.string().optional(),
      fontSize: z.number().optional(),
    },
  },
  async ({ ids, fill, stroke, strokeWidth, opacity, color, fontSize }) => {
    const patch: Record<string, string | number> = {};
    if (fill != null) patch.fill = fill;
    if (stroke != null) patch.stroke = stroke;
    if (strokeWidth != null) patch.strokeWidth = strokeWidth;
    if (opacity != null) patch.opacity = opacity;
    if (color != null) patch.color = color;
    if (fontSize != null) patch.fontSize = fontSize;
    await core.setElementStyle(ROOT, ids, patch);
    return ok(`styled ${ids.length} element(s)`);
  },
);

server.registerTool(
  "rerun_plot",
  {
    description: "Re-run a plot's recipe (regenerate the figure from its source script + params).",
    inputSchema: { recipePath: z.string(), params: z.record(z.string()).optional() },
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
  { description: "Fetch a DOI's BibTeX (DOI content negotiation) and append it to library.bib.", inputSchema: { doi: z.string() } },
  async ({ doi }) => {
    const r = await core.citeDoi(ROOT, doi);
    return ok(`cited: ${r.bibtex.slice(0, 72).replace(/\s+/g, " ")}…`);
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
      "Apply an allow-listed command to the LIVE Flux app — the SAME undoable edit a human makes (Ctrl+Z reverts it). Defaults to the human's current selection / active figure. Examples: {type:'restyle_part',partId:'control.line',patch:{stroke:'#1b9e77'}}, {type:'arrange',rows:2}, {type:'auto_label'}, {type:'align',kind:'left'}, {type:'select',ids:['el_…']}. Types: select, clear_selection, restyle_part, set_style, arrange, align, distribute, auto_label, group, ungroup, set_z, delete, set_figure_layout, duplicate_figure, create_figure.",
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
