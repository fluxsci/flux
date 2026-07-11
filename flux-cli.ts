#!/usr/bin/env -S npx tsx
// flux — headless CLI for a Flux project. Same verbs the MCP server exposes; both
// are thin wrappers over flux-core. Run via `npm run flux -- <verb> …` or, after a
// global link, `flux <verb> …`. "The file is the API."

import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";
import * as path from "node:path";
import * as core from "./flux-core/index";
import { runCliVerb } from "./flux-core/registry";

const HELP = `flux — drive a Flux project from the terminal

usage: flux <verb> [root] [args] [--flags]
       Every verb resolves the project root as --root → $FLUX_PROJECT → cwd.
       Verbs marked [root] ALSO accept a leading positional root (".", a path,
       or a dir holding project.json) for back-compat — when the first
       positional isn't plainly a root, it's treated as the verb's argument.

  new <dir> [--title T] [--author A]   scaffold a new project
  reindex [root]                       rebuild project.json.figures[] from fig/
  list [root]                          print project overview (JSON)
  render-figure [root] <id> [--out f]  render a figure to SVG (stdout or --out)
  render-canvas [canvasId] [--root R] [--png] [--scale n] [--out f]
                                       render a WHOLE canvas (all figures at their x/y)
  render-figures [root] [--doc p.qmd]  write fig/renders/<id>.svg for embedded figures (bare-quarto prep)
  sync-figure [figId] [--root R]       refresh fig/assets copies from regenerated plots/
                                       sources IN PLACE (captions/restyles survive)
  normalize-embeds [--root R]          clear legacy alt-text captions from embed lines
                                       (canonical embeds are ![](…){#fig-id} — the model
                                       owns captions)
  caption [root] <id>                  print a figure's composed caption
  set-caption [root] <id> <md…|--file f> [--panel a]   write the caption; the
                                       "Lead. **a**, … **b**, …" convention is
                                       distributed into per-panel blocks
                                       (--panel writes ONE panel's text)
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
  auto-label <figId> [--root R]        auto-letter panel labels (a, b, c…) by
                                       reading order; panels missing a label
                                       get one first
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
            --font F --color c --align a --sizing m] [--panel-label] [--root R]
                                       add a figure text (--panel-label = a
                                       semantic panel label auto-label letters)
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
  group <id…> [--name N] [--parent G] [--root R]   group ≥2 units → one NAMED
            nestable group (whole top groups nest instead of dissolving)
  ungroup <id…> [--root R]             dissolve each id's top-level group
                                       (a group id dissolves exactly that group)
  rename-group <groupId> <name…> [--root R]   rename a group
  set-group-state <groupId> [--hide|--show] [--lock|--unlock] [--root R]
                                       group eye/padlock (exports honor it)
  list-groups [--figure F] [--root R]  list groups (name/nesting/state/members)
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
  config                               machine paths (FluxConfig, FluxLib, Guidelines) + build info as JSON;
                                       first run initializes ~/FluxConfig (and migrates old layouts)
  version                              this build's version/commit/entry (bundle vs source) as JSON
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
  rerun-plot <recipe.json> [--param v…] [--only [name]]   re-run a plot's recipe
                                       (--only: figure-level scripts rerun ONE
                                       plot — bare --only = this recipe's plot;
                                       siblings stay untouched on disk)

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
  animate-element <deckId> <slideId> <elementId> [--exit --preset P --beat-index n --whole-box --part group:<gid>]   enter/exit for text/shape/media (+ figure groups inside an embedFigure)
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
  // One-time machine init/migration (FluxConfig, lowercase config dir, FluxLib
  // move, Guidelines seed) — idempotent, statSync-fast after the first run. A
  // failure must never block a verb: the path resolvers keep legacy fallbacks.
  if (verb && verb !== "help") {
    await core.ensureFluxConfig().catch((e) => console.error(`flux config init: ${(e as Error)?.message ?? e}`));
  }
  // New verbs take the project root from --root (or $FLUX_PROJECT / cwd) so all
  // positionals are the verb's own args (e.g. variadic plot paths).
  const R = () => path.resolve((flags.root as string) ?? process.env.FLUX_PROJECT ?? ".");
  // Old-style verbs took the root as their FIRST POSITIONAL and ignored
  // --root/$FLUX_PROJECT — the classic wrong-root trap (`caption fig1` resolved
  // ./fig1 as the project). Unified: the positional still wins when it plainly
  // IS a root ("."/".."/a path/a dir holding project.json); otherwise the
  // new-style resolution applies and every positional is a verb argument.
  const posIsRoot =
    _[0] !== undefined &&
    (_[0] === "." ||
      _[0] === ".." ||
      /[\\/]/.test(_[0]) ||
      existsSync(path.join(path.resolve(_[0]), "project.json")));
  const root = () => (posIsRoot ? path.resolve(_[0]) : R());
  const A = posIsRoot ? _.slice(1) : _; // old-style verbs' own (root-stripped) args

  // WS-6.3: registered verbs route through the ONE registry (same schema +
  // handler + render as the MCP surface); everything else falls through to the
  // legacy switch until its batch migrates. The invocation carries BOTH root
  // contracts — each VerbDef picks its own (cliRoot).
  if (
    await runCliVerb(
      verb,
      { pos: _, posRooted: A, flags, rootPositional: root(), rootFlags: R() },
      { log: console.log, err: console.error, setExit: (c) => (process.exitCode = c) },
    )
  ) {
    return;
  }

  switch (verb) {
    case "new": {
      const dir = path.resolve(_[0] ?? ".");
      await core.scaffold(dir, { title: flags.title as string, author: flags.author as string });
      console.error(`✓ scaffolded Flux project at ${dir}`);
      break;
    }
    case "render-figure": {
      const figId = A[0];
      // Staleness probe: a plots/ source newer than its fig/assets copy means
      // this render shows OLD panels — say so (fix with `flux sync-figure`).
      const stale = await core.syncFigureAssets(root(), figId, { dryRun: true }).catch(() => null);
      if (stale?.refreshed.length)
        console.error(
          `⚠ ${figId}: ${stale.refreshed.length} panel(s) stale vs plots/ (${stale.refreshed.map((r) => r.from).join(", ")}) — run \`flux sync-figure ${figId}\` to refresh`,
        );
      // WS-12: headless-edited text renders unwrapped — warn loudly, render anyway.
      for (const w of await core.textLayoutProbe(root(), { figureId: figId })) console.error(`⚠ ${w}`);
      if (flags.png) {
        const png = await core.renderFigurePng(root(), figId, num(flags.scale) ?? 2);
        const out = String(flags.out ?? `${figId}.png`);
        await fs.writeFile(out, png);
        console.error(`✓ wrote ${out} (${png.length} bytes)`);
      } else {
        const svg = await core.renderFigureSvg(root(), figId);
        if (flags.out) {
          await fs.writeFile(String(flags.out), svg);
          console.error(`✓ wrote ${flags.out}`);
        } else process.stdout.write(svg);
      }
      break;
    }
    case "sync-figure": {
      // Close the regenerate loop headlessly: refresh fig/assets copies from
      // their plots/ sources in place (captions/restyles/positions survive).
      // Changed intrinsic sizes resize their elements (physical-size-true) and
      // grow the figure frame when content would no longer fit.
      const r = await core.syncFigureAssets(R(), _[0] || undefined);
      if (r.refreshed.length)
        console.error(`✓ refreshed ${r.refreshed.length}/${r.checked} panel asset(s): ${r.refreshed.map((x) => x.from).join(", ")}`);
      else console.error(`✓ all ${r.checked} panel asset(s) already match plots/ (no change)`);
      for (const rs of r.resized)
        console.error(
          `  ↔ ${rs.elementIds.join(", ")}: intrinsic size ${Math.round(rs.from.w)}×${Math.round(rs.from.h)} → ${Math.round(rs.to.w)}×${Math.round(rs.to.h)} (element resized to match)`,
        );
      for (const fr of r.framed)
        console.error(`  ⤢ ${fr.figId}: frame ${fr.from.width}×${fr.from.height} → ${fr.to.width}×${fr.to.height} (grown to fit resized panels)`);
      if (r.resized.length) console.error(`  (layout may need a re-pack: flux arrange <figId> --cols N)`);
      if (r.missing.length) console.error(`⚠ missing source plot(s): ${r.missing.join(", ")}`);
      for (const w of r.warnings) console.error(`⚠ ${w}`);
      break;
    }
    case "render-canvas": {
      // The whole canvas in one image — every figure at its real x/y, so an
      // agent's look-step catches layout problems (overlap, stray placeholder
      // frames) that per-figure renders can never show.
      const cid = _[0] || undefined;
      for (const w of await core.textLayoutProbe(R(), { canvasId: cid })) console.error(`⚠ ${w}`); // WS-12
      if (flags.png) {
        const { png, canvasId } = await core.renderCanvasPng(R(), cid, num(flags.scale) ?? 1);
        const out = String(flags.out ?? `${canvasId}.png`);
        await fs.writeFile(out, png);
        console.error(`✓ wrote ${out} (${png.length} bytes)`);
      } else {
        const { svg, canvasId } = await core.renderCanvasSvg(R(), cid);
        if (flags.out) {
          await fs.writeFile(String(flags.out), svg);
          console.error(`✓ wrote ${flags.out}`);
        } else {
          process.stdout.write(svg);
          console.error(`✓ rendered canvas ${canvasId}`);
        }
      }
      break;
    }
    case "render-figures": {
      // Materialize fig/renders/<id>.svg for the figures the manuscript embeds (or all,
      // without a readable doc) — what `quarto render` needs on disk. compile() does this
      // automatically; this verb serves "I'll run quarto myself".
      const r = await core.materializeRenders(root(), typeof flags.doc === "string" ? flags.doc : undefined);
      for (const w of r.warnings) console.error(`⚠ ${w}`); // WS-12
      console.error(`✓ wrote ${r.wrote} render(s) to fig/renders/` + (r.failed.length ? ` — failed: ${r.failed.join(", ")}` : ""));
      if (r.failed.length) process.exitCode = 1;
      break;
    }
    case "add-reference":
    case "cite": {
      const bib = flags.file ? await fs.readFile(String(flags.file), "utf8") : A.join(" ");
      await core.addReference(root(), bib);
      console.error("✓ reference added");
      break;
    }
    case "add-panel": {
      const res = await core.addPanel(root(), A[0], A[1], {
        x: num(flags.x),
        y: num(flags.y),
        width: num(flags.width),
        height: num(flags.height),
      });
      console.error(`✓ added panel ${res.elementId} (asset ${res.assetId})`);
      if (res.warning) console.error(`⚠ ${res.warning}`);
      break;
    }
    case "import-plots": {
      if (_.length < 2) throw new Error("import-plots needs a figure id and at least one plot path");
      const r = await core.importPlots(R(), _[0], _.slice(1).map((p) => path.resolve(p)));
      console.error(`✓ imported ${r.panels.length} plot(s) onto ${_[0]}`);
      for (const w of r.warnings) console.error(`⚠ ${w}`);
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
      for (const w of r.warnings) console.error(`⚠ ${w}`);
      break;
    }
    case "reset-crop": {
      await core.setCrop(R(), _[0], null);
      console.error(`✓ reset crop on ${_[0]}`);
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
    case "normalize-embeds": {
      const r = await core.normalizeEmbeds(R());
      if (!r.files.length) console.error("✓ all embed lines already canonical (empty alts)");
      else for (const f of r.files) console.error(`✓ ${f.path}: cleared ${f.cleared} embed alt(s)`);
      break;
    }
    case "cite-doi": {
      const r = await core.citeDoi(R(), _[0]);
      // The fetched author/title/year print IN FULL: registries serve junk
      // metadata on automated deposits ("Robot, Open Data" etc.) and a 60-char
      // bibtex slice hid it — the manuscript then cites garbage verbatim.
      console.error(`✓ cited [@${r.keys.join("; @")}]`);
      console.error(`  ${r.summary}\n  (registry metadata — if it looks wrong, fix references/library.bib and keep the citekey)`);
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
    case "version":
    case "--version":
    case "-v": {
      // Which build is answering — the moma run couldn't tell that the
      // installed bundle had drifted behind the source CLI (missing verbs).
      console.log(JSON.stringify({ ...core.buildInfo(), node: process.version }, null, 2));
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
      if (r.code !== 0) {
        console.error(`✗ quarto exited ${r.code}`);
        console.error(r.log);
        process.exit(r.code);
      }
      console.error(`✓ compiled${r.output ? ` → ${r.output}` : ` (quarto exited 0)`}`);
      if (r.figures)
        console.error(
          `  figures: ${r.figures.resolved}/${r.figures.embedded} embedded figure(s) resolved` +
            (r.figures.missing.length ? ` — no project figure for: ${r.figures.missing.join(", ")}` : ""),
        );
      if (r.citations)
        console.error(
          `  citations: ${r.citations.resolved}/${r.citations.keys} key(s) resolved in the project library` +
            (r.citations.missing.length ? ` — unresolved: @${r.citations.missing.join(", @")}` : ""),
        );
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
      // flux animate-element <deck> <slide> <element> [--exit] [--preset p] [--beat-index n] [--whole-box] [--part group:<gid>]
      const r = await core.animateElementVerb(R(), _[0], _[1], _[2], {
        beatIndex: num(flags["beat-index"]),
        exit: !!flags.exit,
        preset: typeof flags.preset === "string" ? (flags.preset as import("./src/lib/slide/types").PresetName) : undefined,
        wholeBox: !!flags["whole-box"],
        part: typeof flags.part === "string" ? flags.part : undefined,
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
      for (const w of res.warnings ?? []) console.error(`⚠ ${w}`);
      if (res.ok) console.error(`✓ valid (${res.checked} file(s) checked${res.warnings?.length ? `, ${res.warnings.length} warning(s)` : ""})`);
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
      // `--only [name]` targets one plot of a figure-level script (bare --only
      // = this recipe's own plot); `root`/`only` are runner flags, not recipe
      // params — everything else persists into the recipe as a param override.
      const { only, root: _r, ...params } = flags;
      const res = await core.runRecipe(recipePath, params as Record<string, string | boolean>, {
        only: only === true ? true : typeof only === "string" ? only : undefined,
      });
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
