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
import { registerMcpVerbs } from "./flux-core/registry";
import { SLIDE_PRESETS as PRESETS, SLIDE_LAYOUTS as LAYOUTS } from "./flux-core/verbs";
import * as live from "./flux-core/liveClient";

const ROOT = path.resolve(process.argv[2] ?? process.env.FLUX_PROJECT ?? ".");
core.setClient(process.env.FLUX_CLIENT || "mcp"); // WS6: journal/lock identity
// One-time machine init/migration (FluxConfig, lowercase config dir, FluxLib
// move, Guidelines seed) — idempotent + fast after first run; a failure must
// never block the server (path resolvers keep legacy fallbacks).
await core.ensureFluxConfig().catch((e) => console.error(`flux config init: ${(e as Error)?.message ?? e}`));
const server = new McpServer({ name: "flux", version: core.buildInfo().version });

// WS-6.3: registry-backed verbs (ONE schema/handler/render shared with the
// CLI). Manual registerTool blocks below shrink batch by batch.
registerMcpVerbs(server, ROOT);

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });

// OpenAlex sort presets for the whole-world tools (undefined = relevance).
const SORT: Record<string, string | undefined> = {
  relevance: undefined,
  citations: "cited_by_count:desc",
  date: "publication_date:desc",
};


server.registerTool(
  "get_figure_image",
  {
    description:
      "Render a figure to a PNG so a vision agent can SEE its current state (per-part plot overrides baked in). Use after compose_figure/restyle_part to check your work.",
    inputSchema: { id: z.string(), scale: z.number().optional() },
  },
  async ({ id, scale }) => {
    const png = await core.renderFigurePng(ROOT, id, scale ?? 2);
    const warns = await core.textLayoutProbe(ROOT, { figureId: id }); // WS-12
    return {
      content: [
        { type: "image" as const, data: png.toString("base64"), mimeType: "image/png" },
        {
          type: "text" as const,
          text:
            `Rendered figure "${id}" (PNG, ${png.length} bytes, scale ${scale ?? 2}).` +
            (warns.length ? `\n⚠ ${warns.join("\n⚠ ")}` : ""),
        },
      ],
    };
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
    const warns = await core.textLayoutProbe(ROOT, { canvasId: cid }); // WS-12
    return {
      content: [
        { type: "image" as const, data: png.toString("base64"), mimeType: "image/png" },
        {
          type: "text" as const,
          text:
            `Rendered canvas "${cid}" (PNG, ${png.length} bytes, scale ${scale ?? 1}).` +
            (warns.length ? `\n⚠ ${warns.join("\n⚠ ")}` : ""),
        },
      ],
    };
  },
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
  "render_figure",
  {
    description:
      "Render a figure to SVG text (per-part plot overrides baked in) — the vector source. For a raster preview an agent can SEE, use get_figure_image (PNG) instead.",
    inputSchema: { id: z.string() },
  },
  async ({ id }) => {
    const svg = await core.renderFigureSvg(ROOT, id);
    const warns = await core.textLayoutProbe(ROOT, { figureId: id }); // WS-12
    return {
      content: [
        { type: "text" as const, text: svg },
        ...(warns.length ? [{ type: "text" as const, text: `⚠ ${warns.join("\n⚠ ")}` }] : []),
      ],
    };
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

// --- Flux Slide: the two flag-multiplexed verbs still manual (set_slide's
// partial-camera defaults and set_animation's --track full-fidelity mode are
// the CLI behaviors a VerbDef can't express) — vocab shared with the registry.

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
