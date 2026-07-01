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
  caption [root] <id>                  print a figure's composed caption
  set-caption [root] <id> <md…|--file f>   write fig/captions/<id>.md
  add-reference [root] <bibtex…|--file f>   append a BibTeX entry to library.bib
  add-panel [root] <id> <svg> [--x --y --width --height]   import an SVG panel
  create-figure [--root R] [--id slug] [--name N] [--canvas C] [--width --height]
                                       add a blank figure
  compose-figure <plot.svg…> [--root R] [--id slug] [--name N] [--rows N]
                 [--cols N] [--gap N] [--no-label] [--no-caption]
                                       assemble N plots into a labeled figure
  arrange <figId> [--root R] [--rows N | --cols N] [--gap N]   grid-arrange panels
  auto-label <figId> [--root R]        auto-letter panel labels (a, b, c…)
  restyle <figId> <partId> [--root R] [--element E] [--stroke c] [--fill c]
          [--stroke-width n] [--opacity n] [--hidden]   restyle a plot part
  set-style <id…> [--root R] [--fill c] [--stroke c] [--stroke-width n]
            [--opacity n] [--color c] [--font-size n]   set element style
  manuscript [--root R] [--doc rel]    print a manuscript document (.qmd)
  set-manuscript [--root R] [--doc rel] <text…|--file f>   overwrite a document
  docs [--root R]                      list the project's documents
  new-doc <name…> [--root R]           create a new document
  ref <figId> [--root R] [--doc rel]   append a @fig cross-reference
  cite-doi <doi> [--root R]            fetch a DOI → FluxLib + cite in this project
  search <query…>                      search FluxLib (e.g. author:smith year:2020)
  lib                                  show the FluxLib path + entry count
  lib-add <doi|bibtex…|--file f>       add to FluxLib only (no project cite)
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
  annotations [search <q>] [--key K]   list/search FluxReader highlights & notes
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
    if (flags.hidden) s.hidden = true;
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
        const r = await core.addToLibrary(await fs.readFile(String(flags.file), "utf8"));
        console.error(`✓ FluxLib: +${r.added.length} added, ${r.deduped.length} already present`);
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
        `✓ PDFs: ${r.got} fetched, ${r.have} already present, ${r.noOa} no-OA, ${r.noId} no-id (of ${r.total})`,
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
    case "annotations": {
      if (_[0] === "search") {
        const q = _.slice(1).join(" ");
        const hits = await core.searchAnnotations(q, {
          key: typeof flags.key === "string" ? flags.key : undefined,
        });
        console.log(JSON.stringify(hits, null, 2));
        console.error(`✓ ${hits.length} match(es)`);
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
