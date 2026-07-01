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
      `PDFs: ${s.got} fetched, ${s.have} already had, ${s.noOa} no open-access copy, ${s.noId} no DOI/PMCID (of ${s.total}).` +
        (got.length ? "\n" + got.join("\n") : ""),
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
      "List the highlights/notes a human has made on a paper (items/<citekey>/annotations.json) — each with its anchored quote, page, color, and note. `key` is the citekey.",
    inputSchema: { key: z.string() },
  },
  async ({ key }) => {
    const anns = await core.listAnnotations(key);
    if (!anns.length) return ok(`No annotations on ${key}.`);
    return ok(anns.map((a) => `p${a.page} [${a.color}] "${a.anchor.quote}"${a.note ? ` — ${a.note}` : ""}`).join("\n"));
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
