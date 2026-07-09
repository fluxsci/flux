#!/usr/bin/env -S npx tsx
// flux — headless CLI for a Flux project. Same verbs the MCP server exposes; both
// are thin wrappers over flux-core. Run via `npm run flux -- <verb> …` or, after a
// global link, `flux <verb> …`. "The file is the API."

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as core from "./flux-core/index";

const HELP = `flux — drive a Flux project from the terminal

usage: flux <verb> [root] [args] [--flags]
       (root defaults to the current directory)

  new <dir> [--title T] [--author A]   scaffold a new project
  reindex [root]                       rebuild project.json.figures[] from fig/
  list [root]                          print project overview (JSON)
  render-figure [root] <id> [--out f]  render a figure to SVG (stdout or --out)
  render-figures [root] [--doc p.qmd]  write fig/renders/<id>.svg for embedded figures (bare-quarto prep)
  caption [root] <id>                  print a figure's composed caption
  set-caption [root] <id> <md…|--file f>   write fig/captions/<id>.md
  add-reference [root] <bibtex…|--file f>   append a BibTeX entry to library.bib
  add-panel [root] <id> <svg> [--x --y --width --height]   import an SVG panel
  import-plots <figId> <plot.svg…> [--root R]   batch-import plots onto an EXISTING
                                       figure (GUI Alt+I multi-insert parity: true
                                       physical size, grid-packed; one plot centers)
  create-figure [--root R] [--id slug] [--name N] [--canvas C] [--width --height]
                                       add a blank figure
  compose-figure <plot.svg…> [--root R] [--id slug] [--name N] [--rows N]
                 [--cols N] [--gap N] [--no-label] [--no-caption]
                                       assemble N plots into a labeled figure
  arrange <figId> [--root R] [--rows N | --cols N] [--gap N]   grid-arrange panels
  auto-label <figId> [--root R]        auto-letter panel labels (a, b, c…)
  distribute <figId> [--axis h|v] [--gap n] [--ids a,b,c] [--root R]   distribute panels (exact gap when --gap)
  set-guides <figId> [--x a,b,c] [--y a,b,c] [--root R]   set ruler guides (column/baseline grid)
  duplicate <figId> <id…> [--dx n] [--dy n] [--count n] [--root R]   duplicate elements at an offset
  scale <id…> --factor n [--px X --py Y] [--root R]   proportionally scale (geometry + stroke/font)
  reorder <figId> <id> <index> [--root R]   move an element to a z-index (0=bottom)
  rotate <id…> --deg N [--px X --py Y] [--root R]   rotate elements about a pivot
  add-path <figId> --nodes '<json>' [--closed] [--fill c] [--stroke c]
           [--stroke-width n] [--root R]   add a vector path from a node list
  edit-path <id> [--nodes '<json>'] [--closed|--open] [--root R]   replace a path's nodes
  restyle <figId> <partId> [--root R] [--element E] [--stroke c] [--fill c]
          [--stroke-width n] [--opacity n] [--hidden]   restyle a plot part
  set-style <id…> [--root R] [--fill c] [--stroke c] [--stroke-width n]
            [--opacity n] [--color c] [--font-size n] [--font F] [--weight n]
            [--italic|--no-italic] [--underline|--no-underline]
            [--line-height n] [--sizing auto|auto-h|fixed] [--align a]
            [--hidden|--show] [--locked|--unlock] [--name N]   set element style
  set-crop <id> --x n --y n --width n --height n [--root R]   crop an image/plot to a
            window (intrinsic content px; content stays pinned — the box follows)
  reset-crop <id> [--root R]           remove a crop (full content at current scale)
  toggle-text-style <bold|italic|underline> <id…> [--root R]   B/I/U toggle on texts
  add-fig-text <figId> "text…" [--x --y --width --height --size-pt n --weight n
            --font F --color c --align a --sizing m] [--root R]   add a figure text
  text-styles [--root R] [--global]    list named text styles (project | machine library)
  create-text-style --name N [--from elId | --font F --size-pt n --weight n
            --italic --underline --line-height n --color c --align a] [--root R]
  update-text-style <styleId> [--name N --font F --size-pt n --weight n
            --italic|--no-italic --underline|--no-underline --line-height n
            --color c --align a] [--root R]   patch (re-applies to linked texts)
  delete-text-style <styleId> [--root R]   delete (linked texts keep their look)
  apply-text-style <styleId> <id…> [--root R]   apply a named style to texts
  save-global-text-style <styleId> [--root R]   copy a project style → machine library
  delete-element <id…> [--root R]      delete elements by id
  delete-figure <figId> [--root R]     delete a whole figure
  duplicate-figure <figId> [--root R]  duplicate a whole figure (fresh ids)
  align <figId> <left|right|top|bottom|centerH|centerV> [--ids a,b,c] [--root R]   align elements
  group <id…> [--root R]               group ≥2 elements → one unit
  ungroup <id…> [--root R]             dissolve group membership
  set-figure-layout <figId> [--x n --y n --width n --height n --background c --name N] [--root R]   set a figure's frame
  set-z <figId> <front|back|forward|backward> --ids a,b,c [--root R]   change stacking order
  manuscript [--root R] [--doc rel]    print a manuscript document (.qmd)
  set-manuscript [--root R] [--doc rel] <text…|--file f>   overwrite a document
  docs [--root R]                      list the project's documents
  new-doc <name…> [--root R]           create a new document
  ref <figId> [--root R] [--doc rel]   append a @fig cross-reference
  cite-doi <doi> [--root R]            fetch a DOI → FluxLib + cite in this project
  search <query…>                      search FluxLib (e.g. author:smith year:2020)
  lib                                  show the FluxLib path + entry count
  lib-add <doi|bibtex…|--file f>       add to FluxLib only (no project cite)
                                       --file f: bulk-import a .bib/.ris file
                                       --attach-files [--zotero-dir d]: pull its PDFs
  reconcile [--root R]                 sync this project's library.bib with FluxLib
  hydrate [--refresh] [--key K]        enrich FluxLib with OpenAlex (abstracts, topics, citations)
  discover <query…> [--semantic] [--sort cites|date]   search ALL of OpenAlex (--semantic = by meaning)
  similar <key> [--s2] [--sort cites]  "more like this" (OpenAlex semantic; --s2 = Semantic Scholar recs)
  citing <key|doi|Wid> [--s2] [--sort date]   works citing this (--s2 = Semantic Scholar + contexts)
  by-author <key|Aid>                  other works by this entry's first author
  related <key|Wid>                    related papers (OpenAlex similarity)
  keys [--openalex K] [--s2 K] [--mailto M]   show/set API keys (~/FluxLib/keys.json)
  fetch-pdfs [--refresh] [--key K]     download OA PDFs into ~/FluxLib/items/<citekey>/
  ingest-pdf <file> --key K            file a hand-downloaded PDF into items/<citekey>/
  assign-pdfs [--dry-run] [--dir D]    identify + file every PDF in ~/FluxLib/pdfs_to_assign/
  search-text <query…> [--limit N] [--json]   full-text search across every stored PDF's text
  annotations [search <q>] [--key K]   list/search FluxReader highlights & notes
                                       --key K --md: export the paper's notes as Markdown
  tag <citekey> <tag…> [--remove]      add/remove an organization tag on a paper
  set-status <citekey> <status>        set reading status (unread|reading|read)
  collection <citekey> <name…> [--remove]  add/remove a paper from a collection
  add-annotation --key K --quote "…" [--page n] [--prefix …] [--suffix …] [--color c] [--note …]   add a highlight/note
  compile [--root R] [--to pdf|html|docx]   render the manuscript via Quarto
  comments [--root R] [--doc rel] [--all]   list review comments (open by default)
  resolve-comment <id|quote> [--root R] [--doc rel] [--note "…"]   mark a comment resolved
  validate [file] [--root R]           validate writes against .meta/schema/
  validate-plot <plot.svg>             validate a FluxPlot (manifest + addressable ids)
  rerun-plot <recipe.json> [--param v…]   re-run a plot's recipe (regenerate)

 Slides (Flux Slide — figure-first animated talks):
  decks [--root R]                     list the project's slide decks (JSON)
  new-deck [--title T] [--theme T] [--root R]   create a new slide deck
  add-slide <deckId> [--name N] [--layout L] [--root R]   append a slide to a deck
  delete-slide <deckId> <slideId>      delete a slide
  duplicate-slide <deckId> <slideId>   deep-copy a slide (fresh ids)
  reorder-slides <deckId> --order a,b,c   set the slide order (exact permutation)
  set-slide <deckId> <slideId> [--name|--layout|--background|--transition|--notes|--notes-file|--camera-x/-y/-zoom]   patch a slide
  set-theme <deckId> <theme>           flux-dark|light|midnight|slate|sepia|contrast
  add-text <deckId> <slideId> "text…" [--x --y --width --height --align --color --font-size]   add a text box
  add-math <deckId> <slideId> "\\tex…" [--display] [--x …]   add a KaTeX element
  add-embed-figure <deckId> <slideId> <figureId> [--fit contain|cover|fill] [--x …]   embed a project figure
  add-beat <deckId> <slideId> [--label L]   append a build/advance step
  set-animation <deckId> <slideId> <beatId> --target <elId|@camera> [--preset P --part id --start ms --duration ms --easing e --to-asset id --to-x/-y/-zoom] [--track '<json>']   animate
  set-beat <deckId> <slideId> <beatId> [--label L --advance click|with-prev|auto --auto-delay ms]   patch a beat
  reorder-beats <deckId> <slideId> --order b2,b1   set beat order (beat 0 pinned)
  move-track <deckId> <slideId> <trackId> <toBeatId> [--at n]   move a track to another beat
  duplicate-track <deckId> <slideId> <trackId>   deep-copy a track (prints the new id)
  reorder-tracks <deckId> <slideId> <beatId> --order t2,t1   set a beat's lane order
  set-track-enabled <deckId> <slideId> <trackId> true|false   disable = kept but not played
  set-part-visibility <deckId> <elementId> <part> show|animate|mask   plot part tri-state (non-destructive)
  set-part-style <deckId> <elementId> <part> --patch '<json>'   per-part style override (stroke/fill/…)
  animate-part <deckId> <slideId> <elementId> <part> [--beat-index n]   default reveal for a plot part
  animate-element <deckId> <slideId> <elementId> [--exit --preset P --beat-index n --whole-box]   enter/exit for text/shape/media
  set-morph <deckId> <slideId> <beatId> <elementId> <toAssetId> [--duration ms --force]   data-space morph to any project plot
  validate-deck [deckId] [--root R]    validate a deck (or all decks)
  export-deck <deckId> [--out F] [--root R]   export a self-contained offline .html (default exports/<deckId>.html)
  help                                 this message
`;

function parseFlags(args: string[]): { _: string[]; flags: Record<string, string | boolean> } {
  const _: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next === undefined || next.startsWith("--")) flags[key] = true;
      else {
        flags[key] = next;
        i++;
      }
    } else _.push(a);
  }
  return { _, flags };
}

const num = (v: unknown): number | undefined =>
  v == null || v === true ? undefined : Number(v);

async function main() {
  core.setClient(process.env.FLUX_CLIENT || "cli"); // WS6: journal/lock identity
  const [verb, ...rest] = process.argv.slice(2);
  const { _, flags } = parseFlags(rest);
  const root = (i = 0) => path.resolve(_[i] ?? ".");
  // New verbs take the project root from --root (or $FLUX_PROJECT / cwd) so all
  // positionals are the verb's own args (e.g. variadic plot paths).
  const R = () => path.resolve((flags.root as string) ?? process.env.FLUX_PROJECT ?? ".");
  const styleFromFlags = (): Record<string, string | number | boolean> => {
    const s: Record<string, string | number | boolean> = {};
    if (typeof flags.stroke === "string") s.stroke = flags.stroke;
    if (typeof flags.fill === "string") s.fill = flags.fill;
    if (typeof flags.color === "string") s.color = flags.color;
    const sw = num(flags["stroke-width"]);
    if (sw != null) s.strokeWidth = sw;
    const op = num(flags.opacity);
    if (op != null) s.opacity = op;
    const fs2 = num(flags["font-size"]);
    if (fs2 != null) s.fontSize = fs2;
    // text props (figure-v1 P3)
    if (typeof flags.font === "string") s.fontFamily = flags.font;
    const fw = num(flags.weight);
    if (fw != null) s.fontWeight = fw;
    if (flags.italic) s.fontStyle = "italic";
    if (flags["no-italic"]) s.fontStyle = "normal";
    if (flags.underline) s.underline = true;
    if (flags["no-underline"]) s.underline = false;
    const lh = num(flags["line-height"]);
    if (lh != null) s.lineHeight = lh;
    if (flags.sizing === "auto" || flags.sizing === "auto-h" || flags.sizing === "fixed") s.sizing = flags.sizing;
    if (flags.align === "left" || flags.align === "center" || flags.align === "right") s.align = flags.align;
    if (flags.hidden) s.hidden = true;
    if (flags.show) s.hidden = false;
    if (flags.locked) s.locked = true;
    if (flags.unlock) s.locked = false;
    if (typeof flags.name === "string") s.name = flags.name;
    return s;
  };
  // Named-text-style props from flags (sizes edited in POINTS: px = pt × 4/3).
  const textStyleFromFlags = (): Record<string, string | number | boolean> => {
    const s: Record<string, string | number | boolean> = {};
    if (typeof flags.font === "string") s.fontFamily = flags.font;
    const pt = num(flags["size-pt"]);
    if (pt != null) s.fontSize = pt * (4 / 3);
    const fw = num(flags.weight);
    if (fw != null) s.fontWeight = fw;
    if (flags.italic) s.fontStyle = "italic";
    if (flags["no-italic"]) s.fontStyle = "normal";
    if (flags.underline) s.underline = true;
    if (flags["no-underline"]) s.underline = false;
    const lh = num(flags["line-height"]);
    if (lh != null) s.lineHeight = lh;
    if (typeof flags.color === "string") s.color = flags.color;
    if (flags.align === "left" || flags.align === "center" || flags.align === "right") s.align = String(flags.align);
    return s;
  };

  switch (verb) {
    case "new": {
      const dir = path.resolve(_[0] ?? ".");
      await core.scaffold(dir, { title: flags.title as string, author: flags.author as string });
      console.error(`✓ scaffolded Flux project at ${dir}`);
      break;
    }
    case "reindex": {
      const r = await core.reindex(root());
      console.error(`✓ reindexed ${r.figures} figure(s)`);
      break;
    }
    case "list": {
      console.log(JSON.stringify(await core.listProject(root()), null, 2));
      break;
    }
    case "render-figure": {
      if (flags.png) {
        const png = await core.renderFigurePng(root(), _[1], num(flags.scale) ?? 2);
        const out = String(flags.out ?? `${_[1]}.png`);
        await fs.writeFile(out, png);
        console.error(`✓ wrote ${out} (${png.length} bytes)`);
      } else {
        const svg = await core.renderFigureSvg(root(), _[1]);
        if (flags.out) {
          await fs.writeFile(String(flags.out), svg);
          console.error(`✓ wrote ${flags.out}`);
        } else process.stdout.write(svg);
      }
      break;
    }
    case "render-figures": {
      // Materialize fig/renders/<id>.svg for the figures the manuscript embeds (or all,
      // without a readable doc) — what `quarto render` needs on disk. compile() does this
      // automatically; this verb serves "I'll run quarto myself".
      const r = await core.materializeRenders(root(), typeof flags.doc === "string" ? flags.doc : undefined);
      console.error(`✓ wrote ${r.wrote} render(s) to fig/renders/` + (r.failed.length ? ` — failed: ${r.failed.join(", ")}` : ""));
      if (r.failed.length) process.exitCode = 1;
      break;
    }
    case "caption": {
      console.log(await core.captionFor(root(), _[1]));
      break;
    }
    case "set-caption": {
      const md = flags.file ? await fs.readFile(String(flags.file), "utf8") : _.slice(2).join(" ");
      await core.setCaption(root(), _[1], md);
      console.error(`✓ caption written for ${_[1]}`);
      break;
    }
    case "add-reference":
    case "cite": {
      const bib = flags.file ? await fs.readFile(String(flags.file), "utf8") : _.slice(1).join(" ");
      await core.addReference(root(), bib);
      console.error("✓ reference added");
      break;
    }
    case "add-panel": {
      const res = await core.addPanel(root(), _[1], _[2], {
        x: num(flags.x),
        y: num(flags.y),
        width: num(flags.width),
        height: num(flags.height),
      });
      console.error(`✓ added panel ${res.elementId} (asset ${res.assetId})`);
      break;
    }
    case "import-plots": {
      if (_.length < 2) throw new Error("import-plots needs a figure id and at least one plot path");
      const r = await core.importPlots(R(), _[0], _.slice(1).map((p) => path.resolve(p)));
      console.error(`✓ imported ${r.panels.length} plot(s) onto ${_[0]}`);
      console.log(JSON.stringify(r.panels, null, 2));
      break;
    }
    case "create-figure": {
      const r = await core.createFigure(R(), {
        id: flags.id as string,
        name: flags.name as string,
        canvasId: flags.canvas as string,
        width: num(flags.width),
        height: num(flags.height),
      });
      console.error(`✓ created figure ${r.figureId}`);
      break;
    }
    case "compose-figure": {
      if (!_.length) throw new Error("compose-figure needs at least one plot path");
      const r = await core.composeFigure(R(), _, {
        id: flags.id as string,
        name: flags.name as string,
        canvasId: flags.canvas as string,
        rows: num(flags.rows),
        cols: num(flags.cols),
        gap: num(flags.gap),
        label: !flags["no-label"],
        captionStub: !flags["no-caption"],
      });
      console.error(
        `✓ composed figure ${r.figureId} — ${r.panels.length} panel(s) [${r.panels.join("")}] ${r.width}×${r.height}`,
      );
      break;
    }
    case "arrange": {
      await core.arrangeFigure(R(), _[0], { rows: num(flags.rows), cols: num(flags.cols), gap: num(flags.gap) });
      console.error(`✓ arranged ${_[0]}`);
      break;
    }
    case "auto-label": {
      const r = await core.autoLabel(R(), _[0]);
      console.error(`✓ labeled ${_[0]}: ${r.panels.join("")}`);
      break;
    }
    case "distribute": {
      const axis = flags.axis === "v" || flags.v ? "v" : "h";
      const gap = num(flags.gap);
      const ids = typeof flags.ids === "string" ? flags.ids.split(",") : undefined;
      await core.distributeFigure(R(), _[0], axis, gap, ids);
      console.error(`✓ distributed ${_[0]} (${axis}${gap != null ? `, gap ${gap}` : ""})`);
      break;
    }
    case "set-guides": {
      const nums = (s: unknown) => (typeof s === "string" ? s.split(",").map(Number).filter((n) => !Number.isNaN(n)) : undefined);
      await core.setGuides(R(), _[0], { x: nums(flags.x), y: nums(flags.y) });
      console.error(`✓ set guides on ${_[0]} (x:[${flags.x ?? ""}] y:[${flags.y ?? ""}])`);
      break;
    }
    case "duplicate": {
      const r = await core.duplicateElements(R(), _[0], _.slice(1), { dx: num(flags.dx) ?? 16, dy: num(flags.dy) ?? 16, count: num(flags.count) });
      console.error(`✓ duplicated ${_.slice(1).length} element(s) → ${r.ids.length} new`);
      break;
    }
    case "scale": {
      const factor = num(flags.factor) ?? num(flags.f) ?? 1;
      const px = num(flags.px);
      const py = num(flags.py);
      const pivot = px != null && py != null ? { x: px, y: py } : undefined;
      await core.scaleElements(R(), _, factor, pivot);
      console.error(`✓ scaled ${_.length} element(s) by ${factor}×`);
      break;
    }
    case "reorder": {
      await core.reorderElement(R(), _[0], _[1], Number(_[2]));
      console.error(`✓ reordered ${_[1]} → z-index ${_[2]} in ${_[0]}`);
      break;
    }
    case "rotate": {
      const deg = num(flags.deg) ?? num(flags.degrees) ?? 0;
      const px = num(flags.px);
      const py = num(flags.py);
      const pivot = px != null && py != null ? { x: px, y: py } : undefined;
      await core.rotateElements(R(), _, deg, pivot);
      console.error(`✓ rotated ${_.length} element(s) by ${deg}°`);
      break;
    }
    case "add-path": {
      const nodes = JSON.parse(String(flags.nodes ?? "[]"));
      const r = await core.addPath(R(), _[0], {
        nodes,
        closed: !!flags.closed,
        fill: typeof flags.fill === "string" ? flags.fill : undefined,
        stroke: typeof flags.stroke === "string" ? flags.stroke : undefined,
        strokeWidth: num(flags["stroke-width"]),
      });
      console.error(`✓ added path ${r.id} (${nodes.length} nodes) to ${_[0]}`);
      break;
    }
    case "edit-path": {
      const patch: { nodes?: unknown; closed?: boolean } = {};
      if (typeof flags.nodes === "string") patch.nodes = JSON.parse(flags.nodes);
      if (flags.closed) patch.closed = true;
      if (flags.open) patch.closed = false;
      const r = await core.editPath(R(), _[0], patch as Parameters<typeof core.editPath>[2]);
      console.error(`✓ edited path ${r.id}`);
      break;
    }
    case "restyle": {
      const r = await core.setPartOverride(R(), _[0], _[1], styleFromFlags(), flags.element as string | undefined);
      console.error(`✓ restyled ${_[1]} on ${r.elementId}`);
      break;
    }
    case "set-style": {
      await core.setElementStyle(R(), _, styleFromFlags());
      console.error(`✓ styled ${_.length} element(s)`);
      break;
    }
    case "set-crop": {
      const x = num(flags.x);
      const y = num(flags.y);
      const w = num(flags.width);
      const h = num(flags.height);
      if ([x, y, w, h].some((v) => v == null || Number.isNaN(v)))
        throw new Error("set-crop: need numeric --x --y --width --height (intrinsic content px)");
      await core.setCrop(R(), _[0], { x: x!, y: y!, width: w!, height: h! });
      console.error(`✓ cropped ${_[0]} to ${w}×${h} @ ${x},${y}`);
      break;
    }
    case "reset-crop": {
      await core.setCrop(R(), _[0], null);
      console.error(`✓ reset crop on ${_[0]}`);
      break;
    }
    case "toggle-text-style": {
      const which = _[0];
      if (which !== "bold" && which !== "italic" && which !== "underline")
        throw new Error("toggle-text-style: first arg must be bold|italic|underline");
      await core.toggleTextStyle(R(), _.slice(1), which);
      console.error(`✓ toggled ${which} on ${_.length - 1} element(s)`);
      break;
    }
    case "add-fig-text": {
      const pt = num(flags["size-pt"]);
      const r = await core.addFigText(R(), _[0], {
        text: _.slice(1).join(" ") || "Text",
        x: num(flags.x),
        y: num(flags.y),
        width: num(flags.width),
        height: num(flags.height),
        ...(pt != null ? { fontSize: pt * (4 / 3) } : {}),
        ...(num(flags.weight) != null ? { fontWeight: num(flags.weight) } : {}),
        ...(typeof flags.font === "string" ? { fontFamily: flags.font } : {}),
        ...(typeof flags.color === "string" ? { color: flags.color } : {}),
        ...(flags.align === "left" || flags.align === "center" || flags.align === "right"
          ? { align: flags.align }
          : {}),
        ...(flags.sizing === "auto" || flags.sizing === "auto-h" || flags.sizing === "fixed"
          ? { sizing: flags.sizing }
          : {}),
      });
      console.log(r.id);
      break;
    }
    case "text-styles": {
      const styles = flags.global ? await core.listGlobalTextStyles() : await core.listTextStyles(R());
      console.log(JSON.stringify(styles, null, 2));
      break;
    }
    case "create-text-style": {
      if (typeof flags.name !== "string" || !flags.name.trim()) throw new Error("create-text-style: --name required");
      const r = await core.createTextStyle(R(), {
        name: flags.name.trim(),
        ...(typeof flags.from === "string" ? { fromElementId: flags.from } : {}),
        ...(textStyleFromFlags() as object),
      });
      console.log(JSON.stringify(r.style, null, 2));
      break;
    }
    case "update-text-style": {
      const patch = textStyleFromFlags();
      if (typeof flags.name === "string" && flags.name.trim()) patch.name = flags.name.trim();
      await core.updateTextStyle(R(), _[0], patch);
      console.error(`✓ updated text style ${_[0]} (re-applied to linked texts)`);
      break;
    }
    case "delete-text-style": {
      await core.deleteTextStyle(R(), _[0]);
      console.error(`✓ deleted text style ${_[0]}`);
      break;
    }
    case "apply-text-style": {
      const r = await core.applyTextStyle(R(), _.slice(1), _[0]);
      console.error(`✓ applied ${_[0]} to ${r.applied} text element(s)`);
      break;
    }
    case "save-global-text-style": {
      const styles = await core.listTextStyles(R());
      const st = styles.find((s) => s.id === _[0]);
      if (!st) throw new Error(`text style not found in project: ${_[0]}`);
      await core.saveGlobalTextStyle(st);
      console.error(`✓ saved "${st.name}" to the machine-global library`);
      break;
    }
    case "delete-element":
    case "delete-elements": {
      await core.deleteElements(R(), _);
      console.error(`✓ deleted ${_.length} element(s)`);
      break;
    }
    case "delete-figure": {
      const r = await core.deleteFigure(R(), _[0]);
      console.error(`✓ deleted figure ${_[0]}${r.nextActiveId ? ` (next: ${r.nextActiveId})` : ""}`);
      break;
    }
    case "duplicate-figure": {
      const r = await core.duplicateFigure(R(), _[0]);
      console.error(`✓ duplicated ${_[0]} → ${r.figureId}`);
      console.log(r.figureId);
      break;
    }
    case "align": {
      const kind = (flags.kind as string) ?? _[1];
      const ids = typeof flags.ids === "string" ? flags.ids.split(",") : undefined;
      await core.alignFigure(R(), _[0], kind as Parameters<typeof core.alignFigure>[2], ids);
      console.error(`✓ aligned ${_[0]} (${kind})`);
      break;
    }
    case "group": {
      const r = await core.groupElements(R(), _);
      console.error(`✓ grouped ${_.length} element(s) → ${r.groupId}`);
      console.log(r.groupId);
      break;
    }
    case "ungroup": {
      await core.ungroupElements(R(), _);
      console.error(`✓ ungrouped ${_.length} element(s)`);
      break;
    }
    case "set-figure-layout": {
      const patch: Parameters<typeof core.setFigureLayout>[2] = {};
      if (num(flags.x) != null) patch.x = num(flags.x);
      if (num(flags.y) != null) patch.y = num(flags.y);
      if (num(flags.width) != null) patch.width = num(flags.width);
      if (num(flags.height) != null) patch.height = num(flags.height);
      if (typeof flags.background === "string") patch.background = flags.background;
      if (typeof flags.name === "string") patch.name = flags.name;
      await core.setFigureLayout(R(), _[0], patch);
      console.error(`✓ set layout on ${_[0]}`);
      break;
    }
    case "set-z":
    case "z-order": {
      const where = ((flags.where as string) ?? _[1]) as Parameters<typeof core.setZOrder>[3];
      const ids = typeof flags.ids === "string" ? flags.ids.split(",") : _.slice(2);
      await core.setZOrder(R(), _[0], ids, where);
      console.error(`✓ z-order ${where} for ${ids.length} element(s) in ${_[0]}`);
      break;
    }
    case "manuscript": {
      process.stdout.write(await core.getManuscript(R(), flags.doc as string | undefined));
      break;
    }
    case "set-manuscript": {
      const text = flags.file ? await fs.readFile(String(flags.file), "utf8") : _.join(" ");
      await core.setManuscript(R(), text, flags.doc as string | undefined);
      console.error("✓ manuscript written");
      break;
    }
    case "docs": {
      console.log(JSON.stringify(await core.listDocuments(R()), null, 2));
      break;
    }
    case "new-doc": {
      const r = await core.createDocument(R(), _.join(" ") || "Untitled");
      console.error(`✓ created ${r.path}`);
      break;
    }
    case "ref": {
      const r = await core.insertFigureRef(R(), _[0], flags.doc as string | undefined);
      console.error(`✓ inserted ${r.ref}`);
      break;
    }
    case "cite-doi": {
      const r = await core.citeDoi(R(), _[0]);
      console.error(`✓ cited [@${r.keys.join("; @")}]: ${r.bibtex.slice(0, 60).replace(/\s+/g, " ")}…`);
      break;
    }
    case "search": {
      const hits = await core.searchReferences(_.join(" "));
      console.log(JSON.stringify(hits, null, 2));
      console.error(`✓ ${hits.length} match(es) in FluxLib`);
      break;
    }
    case "lib": {
      console.log(JSON.stringify(await core.libraryInfo(), null, 2));
      break;
    }
    case "reconcile": {
      const r = await core.reconcile(R());
      console.error(
        `✓ reconcile: materialized ${r.materialized.length}, promoted ${r.promoted.length}, orphans ${r.orphans.length}`,
      );
      if (r.orphans.length) console.error("  orphans (cited, not in FluxLib): " + r.orphans.join(", "));
      break;
    }
    case "lib-add": {
      const arg = _.join(" ").trim();
      const isDoi = /^(https?:\/\/(dx\.)?doi\.org\/)?10\.\d{4,9}\//i.test(arg);
      if (flags.file) {
        // 2.4 bulk import: sniff .bib vs .ris (RIS is normalized to BibTeX), and with
        // --attach-files pull the PDFs named in each entry's Better-BibTeX `file` field.
        const fp = String(flags.file);
        const text = await fs.readFile(fp, "utf8");
        const r = await core.importReferences(text, {
          attachFiles: !!flags["attach-files"],
          baseDir: path.dirname(path.resolve(fp)),
          zoteroDir: typeof flags["zotero-dir"] === "string" ? flags["zotero-dir"] : undefined,
        });
        console.error(
          `✓ FluxLib (${r.format}): +${r.added.length} added, ${r.deduped.length} already present` +
            (flags["attach-files"] ? ` · ${r.attached.length} PDF(s) attached${r.attachFailed.length ? `, ${r.attachFailed.length} not found` : ""}` : ""),
        );
      } else if (isDoi && !flags.bibtex) {
        const r = await core.addDoiToLibrary(arg);
        console.error(`✓ FluxLib += [@${r.result.keys.join("; @")}]`);
      } else {
        const r = await core.addToLibrary(arg);
        console.error(`✓ FluxLib: +${r.added.length} added, ${r.deduped.length} already present`);
      }
      break;
    }
    case "hydrate": {
      const r = await core.hydrateLibrary({
        refresh: !!flags.refresh,
        key: typeof flags.key === "string" ? flags.key : undefined,
      });
      console.error(
        `✓ hydrated ${r.fetched} (+${r.crossrefBackfill} CrossRef abstracts); ${r.hydrated}/${r.total} entries enriched, ${r.withAbstract} with abstracts`,
      );
      if (r.missing.length) console.error(`  no OpenAlex match: ${r.missing.join(", ")}`);
      break;
    }
    case "discover": {
      const semantic = flags.semantic !== undefined;
      // `--semantic` is a boolean, but the arg parser swallows the next token as its
      // value (`discover --semantic "q"`); recover the query from there when needed.
      const q = _.join(" ") || (typeof flags.semantic === "string" ? flags.semantic : "");
      const hits = semantic
        ? await core.searchWorldSemantic(q, { sort: flags.sort === "cites" ? "citations" : "relevance" })
        : await core.searchWorld(q, {
            sort:
              flags.sort === "cites"
                ? "cited_by_count:desc"
                : flags.sort === "date"
                  ? "publication_date:desc"
                  : undefined,
          });
      console.log(JSON.stringify(hits, null, 2));
      console.error(`✓ ${hits.length} ${flags.semantic ? "semantic " : ""}OpenAlex hit(s)`);
      break;
    }
    case "citing": {
      const hits = flags.s2
        ? await core.s2Citing(_[0])
        : await core.citingWorks(_[0], { sort: flags.sort === "date" ? "publication_date:desc" : undefined });
      console.log(JSON.stringify(hits, null, 2));
      console.error(`✓ ${hits.length} citing (${flags.s2 ? "Semantic Scholar + contexts" : "OpenAlex"})`);
      break;
    }
    case "by-author": {
      const hits = await core.authorWorks(_[0]);
      console.log(JSON.stringify(hits, null, 2));
      console.error(`✓ ${hits.length} work(s) by author`);
      break;
    }
    case "related": {
      const hits = await core.relatedWorks(_[0]);
      console.log(JSON.stringify(hits, null, 2));
      console.error(`✓ ${hits.length} related work(s)`);
      break;
    }
    case "similar": {
      const hits = flags.s2
        ? await core.s2Similar(_[0])
        : await core.similarByKey(_[0], { sort: flags.sort === "cites" ? "citations" : "relevance" });
      console.log(JSON.stringify(hits, null, 2));
      console.error(`✓ ${hits.length} similar (${flags.s2 ? "Semantic Scholar" : "OpenAlex semantic"})`);
      break;
    }
    case "keys": {
      const patch: Record<string, string> = {};
      if (typeof flags.openalex === "string") patch.openAlexKey = flags.openalex;
      if (typeof flags.s2 === "string") patch.s2Key = flags.s2;
      if (typeof flags.mailto === "string") patch.mailto = flags.mailto;
      if (Object.keys(patch).length) {
        await core.saveKeys(patch);
        console.error("✓ keys saved to ~/FluxLib/keys.json");
      }
      const k = await core.loadKeys();
      const mask = (v?: unknown) =>
        typeof v === "string" && v ? v.slice(0, 4) + "…" + v.slice(-3) : "(unset)";
      console.log(
        JSON.stringify(
          { mailto: (k.mailto as string) || "(unset)", openAlexKey: mask(k.openAlexKey), s2Key: mask(k.s2Key) },
          null,
          2,
        ),
      );
      break;
    }
    case "fetch-pdfs": {
      const r = await core.fetchPdfs({
        refresh: !!flags.refresh,
        keys: typeof flags.key === "string" ? [flags.key] : undefined,
        onProgress: (d, t) => process.stderr.write(`\r  ${d}/${t}`),
      });
      process.stderr.write("\n");
      console.error(
        `✓ PDFs: ${r.got} fetched, ${r.have} already present, ${r.noOa} no-OA, ${r.noId} no-id` +
          (r.skipped ? `, ${r.skipped} skipped (known no-OA — use --refresh to re-check)` : "") +
          ` (of ${r.total})`,
      );
      for (const g of r.results.filter((x) => x.status === "got").slice(0, 25))
        console.error(`  + ${g.key}  (${g.source})`);
      break;
    }
    case "ingest-pdf": {
      const file = _[0];
      const key = typeof flags.key === "string" ? flags.key : undefined;
      if (!file || !key) {
        console.error("usage: flux ingest-pdf <file.pdf> --key <citekey>");
        process.exitCode = 1;
        break;
      }
      const r = await core.ingestPdf(file, { key });
      console.error(`✓ ingested ${file} → items/${r.key}/paper.pdf`);
      break;
    }
    case "assign-pdfs": {
      const dryRun = !!flags["dry-run"];
      const r = await core.assignPdfs({
        dryRun,
        dir: typeof flags.dir === "string" ? flags.dir : undefined,
        onProgress: (d, t, f) => process.stderr.write(`\r  ${d}/${t}  ${f.slice(0, 48)}`),
      });
      process.stderr.write("\n");
      const verb = dryRun ? "would " : "";
      for (const it of r.results) {
        if (it.action === "unresolved") console.error(`  ? ${it.file}  UNRESOLVED — ${it.reason}`);
        else if (it.action === "deferred") console.error(`  ~ ${it.file}  deferred (left in inbox) — ${it.reason}`);
        else if (it.action === "discarded")
          console.error(`  = ${it.file}  ${verb}duplicate of ${it.key}${it.keptAs ? ` — kept as supplements/${it.keptAs}` : " (byte-identical, dropped)"}  ${it.doi}`);
        else if (it.action === "attached") console.error(`  + ${it.file}  ${verb}attach → ${it.key}  [${it.method}] ${it.doi}`);
        else console.error(`  ★ ${it.file}  ${verb}add+attach${it.key ? ` → ${it.key}` : ""}  [${it.method}] ${it.doi}`);
      }
      console.error(
        `\n${dryRun ? "DRY RUN — " : "✓ "}${r.total} PDF(s) in ${r.dir}: ` +
          `${r.attached} attach, ${r.addedAttached} add+attach, ${r.discarded} duplicate, ${r.unresolved} unresolved` +
          (r.deferred ? `, ${r.deferred} deferred (network — left in inbox)` : "") +
          (r.abortedOffline ? " — ABORTED: network unavailable" : "") +
          (dryRun ? " (nothing changed)" : ""),
      );
      break;
    }
    case "search-text": {
      // 2.3: full-text search over items/*/fulltext.txt. --json for machine use
      // (the GUI's fulltext: filter spawns this bundle); human output = snippets.
      const q = _.join(" ");
      if (!q.trim()) throw new Error("search-text needs a query");
      const r = await core.searchFulltext(q, {
        limit: num(flags.limit) ?? 50,
        keys: typeof flags.keys === "string" ? String(flags.keys).split(",").filter(Boolean) : undefined,
      });
      if (flags.json) {
        console.log(JSON.stringify(r));
      } else {
        for (const h of r.hits) {
          console.log(`@${h.key}  (${h.count} hit${h.count === 1 ? "" : "s"})`);
          for (const s of h.snippets) console.log(`   p${s.page}: ${s.text}`);
        }
        console.error(
          `✓ ${r.hits.length} paper(s) matched · scanned ${r.scanned} texts in ${r.elapsedMs}ms` +
            (r.truncated ? " (hit limit — refine the query)" : "") +
            (r.missingText.length ? ` · ${r.missingText.length} PDF(s) have no extracted text yet` : ""),
        );
      }
      break;
    }
    case "annotations": {
      if (_[0] === "search") {
        const q = _.slice(1).join(" ");
        const hits = await core.searchAnnotations(q, {
          key: typeof flags.key === "string" ? flags.key : undefined,
        });
        console.log(JSON.stringify(hits, null, 2));
        console.error(`✓ ${hits.length} match(es)`);
      } else if (typeof flags.key === "string" && flags.md) {
        // 3.2: a Markdown digest of this paper's highlights/notes (for a notebook/manuscript).
        process.stdout.write(await core.annotationsMarkdown(flags.key));
      } else if (typeof flags.key === "string") {
        const list = await core.listAnnotations(flags.key);
        console.log(JSON.stringify(list, null, 2));
        console.error(`✓ ${list.length} annotation(s) in ${flags.key}`);
      } else {
        const hits = await core.searchAnnotations("");
        console.log(JSON.stringify(hits, null, 2));
        console.error(`✓ ${hits.length} annotation(s) library-wide`);
      }
      break;
    }
    // 3.3 library organization
    case "tag": {
      const key = String(_[0] ?? "");
      const tag = _.slice(1).join(" ").trim();
      if (!key || !tag) throw new Error("tag needs <citekey> <tag…>  (--remove to drop it)");
      const org = await core.loadOrganize();
      const cur = org.items[key]?.tags ?? [];
      const next = flags.remove ? cur.filter((t) => t.toLowerCase() !== tag.toLowerCase()) : [...cur, tag];
      const d = await core.organizeSetTags(key, next);
      console.error(`✓ ${key} tags: ${(d.items[key]?.tags ?? []).join(", ") || "(none)"}`);
      break;
    }
    case "set-status": {
      const key = String(_[0] ?? "");
      const status = String(_[1] ?? "");
      if (!key || !["unread", "reading", "read"].includes(status)) throw new Error("set-status needs <citekey> <unread|reading|read>");
      await core.organizeSetStatus(key, status as "unread" | "reading" | "read");
      console.error(`✓ ${key} status: ${status}`);
      break;
    }
    case "collection": {
      const key = String(_[0] ?? "");
      const name = _.slice(1).join(" ").trim();
      if (!key || !name) throw new Error("collection needs <citekey> <name…>  (--remove to drop it)");
      const org = await core.loadOrganize();
      const cur = org.items[key]?.collections ?? [];
      const next = flags.remove ? cur.filter((c) => c.toLowerCase() !== name.toLowerCase()) : [...cur, name];
      const d = await core.organizeSetCollections(key, next);
      console.error(`✓ ${key} collections: ${(d.items[key]?.collections ?? []).join(", ") || "(none)"}`);
      break;
    }
    case "add-annotation": {
      const key = String(flags.key ?? _[0]);
      const quote = String(flags.quote ?? "");
      if (!key || !quote) throw new Error("add-annotation needs --key and --quote");
      const a = await core.addAnnotation(key, {
        page: num(flags.page) ?? 1,
        anchor: { quote, prefix: String(flags.prefix ?? ""), suffix: String(flags.suffix ?? "") },
        color: typeof flags.color === "string" ? flags.color : "yellow",
        note: typeof flags.note === "string" ? flags.note : undefined,
      });
      console.error(`✓ annotated @${key} p${a.page} [${a.color}] (${a.id})`);
      break;
    }
    case "compile": {
      const r = await core.compile(R(), (flags.to as string) ?? "pdf");
      console.error(`✓ quarto exited ${r.code}`);
      if (r.code !== 0) {
        console.error(r.log);
        process.exit(r.code);
      }
      break;
    }
    case "comments": {
      const threads = await core.listComments(R(), flags.doc as string | undefined);
      const shown = flags.all ? threads : threads.filter((t) => !t.resolved);
      console.log(
        JSON.stringify(
          shown.map((t) => ({ id: t.id, resolved: t.resolved, quote: t.anchor?.quote ?? "", messages: t.messages })),
          null,
          2,
        ),
      );
      break;
    }
    case "resolve-comment": {
      const r = await core.resolveComment(R(), _[0], {
        docRel: flags.doc as string | undefined,
        note: typeof flags.note === "string" ? flags.note : undefined,
      });
      console.error(`✓ resolved ${r.id} (${r.resolved}/${r.total} resolved)`);
      break;
    }
    case "decks": {
      console.log(JSON.stringify(await core.listDecks(R()), null, 2));
      break;
    }
    case "new-deck": {
      const r = await core.createDeck(R(), {
        id: flags.id as string,
        title: flags.title as string,
        theme: flags.theme as string,
      });
      console.error(`✓ created deck ${r.deckId} (${r.path})`);
      break;
    }
    case "add-slide": {
      if (!_[0]) throw new Error("add-slide needs a deck id");
      const r = await core.addSlide(R(), _[0], {
        name: flags.name as string,
        layout: flags.layout as import("./src/lib/slide/types").LayoutId,
      });
      console.error(`✓ added slide ${r.slideId} to ${_[0]}`);
      break;
    }
    case "validate-deck": {
      const r = await core.validateDeck(R(), _[0]);
      if (r.ok) console.error(`✓ valid deck(s) (${r.checked} checked)`);
      else {
        console.error(`✗ ${r.errors.length} problem(s):`);
        for (const e of r.errors) console.error("  " + e);
        process.exit(1);
      }
      break;
    }
    case "export-deck": {
      if (!_[0]) throw new Error("export-deck needs a deck id");
      const r = await core.exportDeck(R(), _[0], { out: flags.out as string });
      console.error(`✓ exported ${_[0]} → ${r.path} (${(r.bytes / 1024).toFixed(0)} KB, self-contained)`);
      for (const w of r.warnings) console.error("  ⚠ " + w);
      break;
    }
    case "delete-slide": {
      const r = await core.deleteSlide(R(), _[0], _[1]);
      console.error(`✓ deleted slide ${_[1]}${r.nextActiveId ? ` (next: ${r.nextActiveId})` : ""}`);
      break;
    }
    case "duplicate-slide": {
      const r = await core.duplicateSlide(R(), _[0], _[1]);
      console.error(`✓ duplicated slide ${_[1]} → ${r.slideId}`);
      console.log(r.slideId);
      break;
    }
    case "reorder-slides": {
      const order = typeof flags.order === "string" ? flags.order.split(",") : _.slice(1);
      await core.reorderSlides(R(), _[0], order);
      console.error(`✓ reordered ${_[0]} (${order.length} slides)`);
      break;
    }
    case "set-slide": {
      const patch: Parameters<typeof core.setSlide>[3] = {};
      if (typeof flags.name === "string") patch.name = flags.name;
      if (typeof flags.layout === "string") patch.layout = flags.layout as typeof patch.layout;
      if (typeof flags.background === "string") patch.background = flags.background;
      if (typeof flags.transition === "string") patch.transition = flags.transition as typeof patch.transition;
      if (flags.notes != null || flags["notes-file"]) {
        patch.notes = flags["notes-file"] ? await fs.readFile(String(flags["notes-file"]), "utf8") : String(flags.notes);
      }
      const cx = num(flags["camera-x"]);
      const cy = num(flags["camera-y"]);
      const cz = num(flags["camera-zoom"]);
      if (cx != null || cy != null || cz != null) patch.camera = { x: cx ?? 0, y: cy ?? 0, zoom: cz ?? 1 };
      await core.setSlide(R(), _[0], _[1], patch);
      console.error(`✓ set slide ${_[1]}`);
      break;
    }
    case "set-theme": {
      const theme = (flags.theme as string) ?? _[1];
      await core.setDeckTheme(R(), _[0], theme);
      console.error(`✓ set theme ${theme} on ${_[0]}`);
      break;
    }
    case "add-text": {
      const text = flags.file ? await fs.readFile(String(flags.file), "utf8") : _.slice(2).join(" ");
      const r = await core.addTextToSlide(R(), _[0], _[1], {
        text,
        x: num(flags.x), y: num(flags.y), width: num(flags.width), height: num(flags.height),
        align: flags.align as import("./src/lib/slide/ops").TextBoxOpts["align"],
        color: typeof flags.color === "string" ? flags.color : undefined,
        fontSize: num(flags["font-size"]),
      });
      console.error(`✓ added text ${r.elementId} to ${_[1]}`);
      console.log(r.elementId);
      break;
    }
    case "add-math": {
      const tex = flags.tex ? String(flags.tex) : _.slice(2).join(" ");
      const r = await core.addMathToSlide(R(), _[0], _[1], {
        tex,
        display: !!flags.display,
        x: num(flags.x), y: num(flags.y), width: num(flags.width), height: num(flags.height),
        color: typeof flags.color === "string" ? flags.color : undefined,
        fontSize: num(flags["font-size"]),
      });
      console.error(`✓ added math ${r.elementId} to ${_[1]}`);
      console.log(r.elementId);
      break;
    }
    case "add-embed-figure": {
      const r = await core.addEmbedFigureToSlide(R(), _[0], _[1], {
        figureId: _[2],
        fit: flags.fit as import("./src/lib/slide/ops").EmbedFigureOpts["fit"],
        x: num(flags.x), y: num(flags.y), width: num(flags.width), height: num(flags.height),
      });
      console.error(`✓ embedded figure ${_[2]} → ${r.elementId} on ${_[1]}`);
      console.log(r.elementId);
      break;
    }
    case "add-beat": {
      const r = await core.addBeat(R(), _[0], _[1], { label: typeof flags.label === "string" ? flags.label : undefined });
      console.error(`✓ added beat ${r.beatId} to ${_[1]}`);
      console.log(r.beatId);
      break;
    }
    case "set-animation": {
      // Full-fidelity via --track '<json>'; else build a Track from flags.
      let track: import("./src/lib/slide/types").Track;
      if (typeof flags.track === "string") {
        track = JSON.parse(flags.track);
      } else {
        track = { target: String(flags.target ?? _[3] ?? "") };
        if (typeof flags.preset === "string") track.preset = flags.preset as import("./src/lib/slide/types").PresetName;
        if (typeof flags.part === "string") track.part = flags.part;
        if (num(flags.start) != null) track.start = num(flags.start);
        if (num(flags.duration) != null) track.duration = num(flags.duration);
        if (typeof flags.easing === "string") track.easing = flags.easing as import("./src/lib/slide/types").EasingToken;
        if (typeof flags.params === "string") track.params = JSON.parse(flags.params);
        // morph/camera/move destination → `to` (assetId for morph; x/y/zoom for camera).
        const to: import("./src/lib/slide/types").TrackTarget = {};
        if (typeof flags["to-asset"] === "string") to.assetId = flags["to-asset"];
        if (num(flags["to-x"]) != null) to.x = num(flags["to-x"]);
        if (num(flags["to-y"]) != null) to.y = num(flags["to-y"]);
        if (num(flags["to-zoom"]) != null) to.zoom = num(flags["to-zoom"]);
        if (Object.keys(to).length) track.to = to;
      }
      if (!track.target) throw new Error("set-animation needs --target (an element id, or @camera/@stage)");
      await core.setAnimation(R(), _[0], _[1], _[2], track);
      console.error(`✓ set animation on beat ${_[2]} (${track.preset ?? "keyframes"} → ${track.target})`);
      break;
    }
    case "set-beat": {
      // flux set-beat <deck> <slide> <beat> [--label L] [--advance click|with-prev|auto] [--auto-delay ms]
      const patch: Parameters<typeof core.setBeat>[4] = {};
      if (typeof flags.label === "string") patch.label = flags.label;
      if (typeof flags.advance === "string") patch.advance = flags.advance as "click" | "with-prev" | "auto";
      if (num(flags["auto-delay"]) != null) patch.autoDelayMs = num(flags["auto-delay"]);
      await core.setBeat(R(), _[0], _[1], _[2], patch);
      console.error(`✓ set beat ${_[2]}`);
      break;
    }
    case "reorder-beats": {
      // flux reorder-beats <deck> <slide> --order b2,b1 (beat 0 is pinned)
      const order = typeof flags.order === "string" ? flags.order.split(",") : _.slice(2);
      await core.reorderBeats(R(), _[0], _[1], order);
      console.error(`✓ reordered beats on ${_[1]}`);
      break;
    }
    case "move-track": {
      // flux move-track <deck> <slide> <track> <toBeat> [--at n]
      await core.moveTrack(R(), _[0], _[1], _[2], _[3], num(flags.at));
      console.error(`✓ moved track ${_[2]} → beat ${_[3]}`);
      break;
    }
    case "duplicate-track": {
      const r = await core.duplicateTrack(R(), _[0], _[1], _[2]);
      console.error(`✓ duplicated track ${_[2]} → ${r.trackId}`);
      console.log(r.trackId);
      break;
    }
    case "reorder-tracks": {
      // flux reorder-tracks <deck> <slide> <beat> --order t2,t1
      const order = typeof flags.order === "string" ? flags.order.split(",") : _.slice(3);
      await core.reorderTracks(R(), _[0], _[1], _[2], order);
      console.error(`✓ reordered tracks on beat ${_[2]}`);
      break;
    }
    case "set-track-enabled": {
      // flux set-track-enabled <deck> <slide> <track> true|false
      const enabled = String(flags.enabled ?? _[3]) !== "false";
      await core.setTrackEnabled(R(), _[0], _[1], _[2], enabled);
      console.error(`✓ track ${_[2]} ${enabled ? "enabled" : "disabled"}`);
      break;
    }
    case "set-part-visibility": {
      // flux set-part-visibility <deck> <element> <part> show|animate|mask
      const mode = String(flags.mode ?? _[3]) as "show" | "animate" | "mask";
      await core.setPartVisibility(R(), _[0], _[1], _[2], mode);
      console.error(`✓ ${_[2]} → ${mode}`);
      break;
    }
    case "set-part-style": {
      // flux set-part-style <deck> <element> <part> --patch '{"stroke":"#bc5215","strokeWidth":2}'
      if (typeof flags.patch !== "string") throw new Error("set-part-style needs --patch '<json>'");
      await core.setPartStyle(R(), _[0], _[1], _[2], JSON.parse(flags.patch));
      console.error(`✓ styled ${_[2]}`);
      break;
    }
    case "animate-part": {
      // flux animate-part <deck> <slide> <element> <part> [--beat-index n]
      const r = await core.animatePartVerb(R(), _[0], _[1], _[2], _[3], num(flags["beat-index"]));
      console.error(`✓ ${_[3]} animates on beat ${r.beatIndex}`);
      break;
    }
    case "animate-element": {
      // flux animate-element <deck> <slide> <element> [--exit] [--preset p] [--beat-index n] [--whole-box]
      const r = await core.animateElementVerb(R(), _[0], _[1], _[2], {
        beatIndex: num(flags["beat-index"]),
        exit: !!flags.exit,
        preset: typeof flags.preset === "string" ? (flags.preset as import("./src/lib/slide/types").PresetName) : undefined,
        wholeBox: !!flags["whole-box"],
      });
      console.error(`✓ element ${_[2]} ${flags.exit ? "animates out" : "animates in"} on beat ${r.beatIndex}`);
      console.log(r.trackId);
      break;
    }
    case "set-morph": {
      // flux set-morph <deck> <slide> <beat> <element> <toAssetId> [--duration ms] [--force]
      await core.setMorph(R(), _[0], _[1], _[2], _[3], _[4], { duration: num(flags.duration), force: !!flags.force });
      console.error(`✓ morph ${_[3]} → ${_[4]} on beat ${_[2]}`);
      break;
    }
    case "validate": {
      const res = await core.validate(R(), _[0]);
      if (res.ok) console.error(`✓ valid (${res.checked} file(s) checked)`);
      else {
        console.error(`✗ ${res.errors.length} schema problem(s):`);
        for (const e of res.errors) console.error("  " + e);
        process.exit(1);
      }
      break;
    }
    case "validate-plot": {
      const r = await core.validatePlot(path.resolve(_[0]));
      if (r.ok) console.error(`✓ valid FluxPlot (${r.matched}/${r.references} ids matched)`);
      else {
        console.error(`✗ ${r.errors.length} problem(s):`);
        for (const e of r.errors) console.error("  " + e);
        process.exit(1);
      }
      break;
    }
    case "rerun-plot": {
      const recipePath = path.resolve(_[0] ?? "");
      const res = await core.runRecipe(recipePath, flags as Record<string, string | boolean>);
      console.error(`✓ recipe exited ${res.code}; wrote ${res.svgPath}`);
      if (res.stderr.trim()) console.error(res.stderr.trim());
      if (res.code !== 0) process.exit(res.code);
      break;
    }
    case "help":
    case "--help":
    case "-h":
    case undefined:
      console.log(HELP);
      break;
    default:
      console.error(`flux: unknown verb "${verb}"\n`);
      console.log(HELP);
      process.exit(1);
  }
}

main().catch((e) => {
  console.error("flux: " + (e?.message ?? e));
  process.exit(1);
});
