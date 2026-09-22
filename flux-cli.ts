#!/usr/bin/env -S npx tsx
// flux — headless CLI for a Flux project. Same verbs the MCP server exposes; both
// are thin wrappers over flux-core. Run via `npm run flux -- <verb> …` or, after a
// global link, `flux <verb> …`. "The file is the API."

import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";
import * as path from "node:path";
import * as core from "./flux-core/index";
import { runCliVerb, parseCliFlags, registryHelp, registeredCliVerbs, errorToCli } from "./flux-core/registry";

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
                                       figure (GUI Alt+G multi-insert parity: true
                                       physical size, grid-packed; one plot centers)
  create-figure [--root R] [--id slug] [--name N] [--canvas C] [--width --height]
                [--family f --number n --nickname N]   add a blank figure
  set-figure-family <figId> [--family figure|supplementary|extended-data|<custom>]
                [--number n] [--nickname N | --clear-nickname] [--root R]
                                       assign structured identity (insert-and-shift;
                                       the display name derives from family + number)
  define-figure-family --id slug --display-name N [--ref-template "Mov. {num}{panel}"]
                [--caption-template "Movie {num} | "] [--root R]   define/update a custom family
  remove-figure-family <id> [--root R]  drop a custom family (members → figure family)
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
            [--line-height n] [--sizing auto|auto-h|fixed]
            [--align left|center|right|justify] [--valign top|middle|bottom]
            [--letter-spacing n] [--paragraph-spacing n]
            [--hidden|--show] [--locked|--unlock] [--name N]   set element style
  set-crop <id> --x n --y n --width n --height n [--root R]   crop an image/plot to a
            window (intrinsic content px; content stays pinned — the box follows)
  reset-crop <id> [--root R]           remove a crop (full content at current scale)
  toggle-text-style <bold|italic|underline> <id…> [--root R]   B/I/U toggle on texts
  add-fig-text <figId> "text…" [--x --y --width --height --size-pt n --weight n
            --font F --color c --align a --valign v --letter-spacing n
            --paragraph-spacing n --sizing m] [--panel-label] [--root R]
                                       add a figure text (--panel-label = a
                                       semantic panel label auto-label letters)
  text-styles [--root R] [--global]    list named text styles (project | machine library)
  create-text-style --name N [--from elId | --font F --size-pt n --weight n
            --italic --underline --line-height n --color c --align a
            --valign v --letter-spacing n --paragraph-spacing n] [--root R]
  update-text-style <styleId> [--name N --font F --size-pt n --weight n
            --italic|--no-italic --underline|--no-underline --line-height n
            --color c --align a --valign v --letter-spacing n
            --paragraph-spacing n] [--root R]   patch (re-applies to linked texts)
  delete-text-style <styleId> [--root R]   delete (linked texts keep their look)
  apply-text-style <styleId> <id…> [--root R]   apply a named style to texts
  save-global-text-style <styleId> [--root R]   copy a project style → machine library
  delete-element <id…> [--root R]      delete elements by id
  delete-figure <figId> [--root R]     delete a whole figure
  duplicate-figure <figId> [--root R]  duplicate a whole figure (fresh ids)
  align <figId> <left|right|top|bottom|centerH|centerV> [--ids a,b,c] [--root R]   align elements
  bring-inside <figId> [--ids a,b,c] [--root R]   translate elements inside the
            frame (minimal move, never resized; oversized ones cover the frame)
  cascade <figId> <property> <id…> [--delta n | --factor n] [--dl n --dc n --dh n]
            [--order selection|layer|x|y] [--reverse] [--first-fixed] [--root R]
            stepped delta across elements: rank k gets value+delta·step (step =
            k with --first-fixed, else k+1); groups are ONE rigid rank; colors
            shift per step in OKLCh (--dl/--dc/--dh)
  group <id…> [--name N] [--parent G] [--root R]   group ≥2 units → one NAMED
            nestable group (whole top groups nest instead of dissolving)
  ungroup <id…> [--root R]             dissolve each id's top-level group
                                       (a group id dissolves exactly that group)
  rename-group <groupId> <name…> [--root R]   rename a group
  set-group-state <groupId> [--hide|--show] [--lock|--unlock] [--root R]
                                       group eye/padlock (exports honor it)
  list-groups [--figure F] [--root R]  list groups (name/nesting/state/members)
  set-figure-layout <figId> [--x n --y n --width n --height n --background c --name N] [--root R]   set a figure's frame
  resize-figure-frame <figId> --x n --y n --width n --height n [--root R]   resize boundary with artwork pinned
  set-z <figId> <front|back|forward|backward> --ids a,b,c [--root R]   change stacking order
  manuscript [--root R] [--doc rel]    print a manuscript document (.qmd)
  set-manuscript [--root R] [--doc rel] <text…|--file f>   overwrite a document
  docs [--root R]                      list the project's documents
  new-doc <name…> [--folder DIR] [--root R]  create a new document
  new-doc-folder <parent> <name…> [--root R]  create a document folder
  move-doc <path> <folder> [--root R]   move a document and its comments
  delete-doc <path> [--root R]         delete a document (legacy main + standard Context docs protected)
  insert-slide-embed <deck> <slide> [--doc rel] [--width W] [--caption text] [--anchor text]   insert an inline slide
  ref <figId> [--root R] [--doc rel]   append a @fig cross-reference
  cite-doi <doi> [--root R]            fetch a DOI → FluxLib + cite in this project
  search <query…>                      search FluxLib (e.g. author:smith year:2020)
  lib                                  show the FluxLib path + entry count
  config                               machine paths (FluxConfig, FluxLib, Context, agents.json) + build info as JSON;
                                       first run initializes ~/FluxConfig (and migrates old layouts)
  version                              this build's version/commit/entry (bundle vs source) as JSON
  lib-add <doi|bibtex…|--file f>       add to FluxLib only (no project cite)
                                       --file f: bulk-import a .bib/.ris file
                                       --attach-files [--zotero-dir d]: pull its PDFs
  reconcile [--root R]                 sync this project's library.bib with FluxLib
  hydrate [--refresh] [--key K]        enrich FluxLib with OpenAlex (abstracts, topics, citations)
  zotero-sync [--bib f] [--data-dir d] [--attach copy|link] [--defer-fulltext] [--force] [--save]   pull new
                                       references + PDFs from the connected Zotero Better-BibTeX auto-export
                                       (one-way, idempotent; an unchanged export is skipped from a stat alone —
                                       --force re-scans; --defer-fulltext = link without reading the PDFs now)
  grobid [--run] [--reproject] [--url U] [--force] [--limit N] [--keys a,b]   OPTIONAL: structured
                                       enrichment via a local GROBID service — parsed references, in-text
                                       citation links, sections. Flux needs none of it; without a service
                                       nothing changes. No flags = coverage report. Setup: docs/integrations/grobid.qmd
  discover <query…> [--semantic] [--sort cites|date]   search ALL of OpenAlex (--semantic = by meaning)
  similar <key> [--s2] [--sort cites]  "more like this" (OpenAlex semantic; --s2 = Semantic Scholar recs)
  citing <key|doi|Wid> [--s2] [--sort date]   works citing this (--s2 = Semantic Scholar + contexts)
  by-author <key|Aid>                  other works by this entry's first author
  related <key|Wid>                    related papers (OpenAlex similarity)
  keys [--openalex K] [--s2 K] [--mailto M]   show/set API keys (<FluxLib>/keys.json)
  fetch-pdfs [--refresh] [--key K]     download OA PDFs into <FluxLib>/items/<citekey>/
  fetch-supplements [--key K]          download supplementary files (Europe PMC OA subset)
  missing-pdfs [--out F] [--json]      CSV of references with no main text + why (stdout)
  ingest-pdf <file> --key K            file a hand-downloaded PDF into items/<citekey>/
  assign-pdfs [--dry-run] [--dir D]    identify + file every PDF in <FluxLib>/pdfs_to_assign/
  search-text <query…> [--limit N] [--json]   full-text search across every stored PDF's text
  annotations [search <q>] [--key K]   list/search FluxReader highlights & notes
                                       --key K --md: export the paper's notes as Markdown
  snip-paper <key> --page N [--rect x1,y1,x2,y2]   capture a PDF page region as a PNG snip into
                                       plots/paper_snips/ (rect = PDF points, y-up; omit = whole
                                       page) with citekey provenance; [--name N] [--scale S]
                                       [--supplement F]. Returns the path + citation.
  cite <key>                           minimal text citation ("Driessen et al., 2026, Nat. Neurosci.")
  tag <citekey> <tag…> [--remove]      add/remove an organization tag on a paper
  set-status <citekey> <status>        set reading status (unread|reading|read)
  collection <citekey> <name…> [--remove]  add/remove a paper from a collection
  add-annotation --key K --quote "…" [--page n] [--prefix …] [--suffix …] [--color c] [--note …]   add a highlight/note
  compile [--root R] [--doc rel] [--to pdf|html|docx] [--style nature]   render the manuscript via Quarto
            [--zotero-fields] [--zotero-library a.docx,b.docx]   docx: citations as live Zotero fields
  comments [--root R] [--doc rel] [--all]   list project-wide review comments (open by default; --doc targets one)
  resolve-comment <id|quote> [--root R] [--doc rel] [--note "…"]   resolve a project-wide unique match (--doc targets one)
  add-comment --quote "…" --body "…" [--root R] [--doc rel] [--at n]   open a NEW thread (ask the human in the margin)
  feedback [--root R] [--all]          list the user's context-stamped feedback notes
  resolve-feedback <id|text> [--root R] [--note "…"]   mark a feedback note resolved
  send [--root R] [--note "…"]         mark a review-pass boundary in the feedback ledger
  context-init [--root R]              ensure the project's Context/ layer (heal old projects)
  note <text…> [--title "…"] [--file f] [--author a] [--root R]   append a stamped entry to the notebook's
                                       Session log under the manuscript lock (concurrent-writer safe)
  agents                               show the machine's agent roster (agents.json)
  principal [root] [--print] [--no-picker] [--no-transcript]   the launch picker + YOUR principal,
                                       in THIS terminal, with transcript capture (alias: agent);
                                       [--model m] [--effort e] [--family f] [--worker-model m] [--worker-effort e] skip the picker
  dispatch <name> --brief-file f [--model m] [--effort e] [--family fam] [--root R]   run a worker with a brief,
                                       recorded in Context/Dispatches/ (model/effort default to the session's worker policy)
  attend [root] [--interval ms] [--echo]   watch the feedback ledger; Send wakes a principal review pass
  validate [file] [--root R]           validate writes against .meta/schema/
  validate-plot <plot.svg>             validate a FluxPlot (manifest + addressable ids)
  rerun-plot <recipe.json> [--param v…] [--only [name]]   re-run a plot's recipe
                                       (--only: figure-level scripts rerun ONE
                                       plot — bare --only = this recipe's plot;
                                       siblings stay untouched on disk)
  list-dissections [plot]              a plot's companion material in plots/_dissections/<plot>/
                                       (subfolders = named groups; no arg = every
                                       plot that has a dissection folder)

 Slides (Flux Slide — figure-first animated talks):
  decks [--root R]                     list the project's slide decks (JSON)
  new-deck [--title T] [--theme T] [--root R]   create a new slide deck
  add-slide <deckId> [--name N] [--layout L] [--root R]   append a slide to a deck
  delete-slide <deckId> <slideId> [--force]   delete an unreferenced slide (force overrides)
  duplicate-slide <deckId> <slideId>   deep-copy a slide (fresh ids)
  reorder-slides <deckId> --order a,b,c   set the slide order (exact permutation)
  set-slide <deckId> <slideId> [--name|--layout|--background|--transition|--notes|--notes-file|--camera-x/-y/-zoom]   patch a slide
  set-theme <deckId> <theme>           flux-dark|light|paper|midnight|slate|sepia|contrast
  add-text <deckId> <slideId> "text…" [--x --y --width --height --align --valign --color --size-pt|--font-size --weight --sizing]   add a figure text element
  add-figure <deckId> <slideId> <figureId> [--x --y]   COPY a project figure's content onto a slide (fresh ids, native size)
  add-beat <deckId> <slideId> [--label L]   append a build/advance step
  add-video <deckId> <slideId> <plots/_videos/clip.mp4|.mov> [--x N --y N --width N --height N --muted --loop] [--root R]   import a video clip
  set-video-track <deckId> <slideId> <beatId> <target> <start|pause|stop> [--start ms] [--root R]   control clip playback
  set-video-settings <deckId> <slideId> <target> [--muted true|false --loop true|false] [--root R]   clip options
  set-animation <deckId> <slideId> <beatId> --target <elId|@camera> [--preset P --part id --start ms --duration ms --easing e --to-asset id --to-x/-y/-zoom] [--track '<json>' --append]   animate (append preserves existing effects)
  set-transform <deckId> <slideId> <beatId> <elementId> [--state '<json patch>' --replace-state --start ms --duration ms --easing e --to-asset id]   the t1→t2 state tween (one per element per beat)
  ghost-transform <deckId> <slideId> <beatId> <sourceId> [--count 3 --original stay|disappear|transform --states '<json array>' --original-state '<json patch>' --duration ms --start ms --easing e]   spawn independent copies from the source's current state
  become <deckId> <slideId> <beatId> <sourceId> (--target <elementId> | --asset <assetId>) [--start ms --duration ms --easing e --force]   the source turns into another object (consumed) or, for a plot, another project plot's data
  group-tracks <deckId> <slideId> <beatId> t1,t2… [--label L]   bundle lanes under a collapsible TrackGroup
  ungroup-tracks <deckId> <slideId> <beatId> t1,t2…   dissolve the lanes' groups
  cascade-tracks <deckId> <slideId> <start|duration|influence.in|influence.out|stagger.perMs> t1,t2… [--delta n | --factor n] [--order timeline|list] [--reverse] [--first-fixed]   stepped timing delta across tracks (rank k gets value+delta·step)
  apply-anim-template <deckId> <slideId> <name|path.json> [--element id [--part axis.y] | --elements a,b,c] [--beat id]   bind a saved preset bundle by role/type
  set-beat <deckId> <slideId> <beatId> [--label L --advance click|with-prev|auto --auto-delay ms]   patch a beat
  reorder-beats <deckId> <slideId> --order b2,b1   set beat order (beat 0 pinned)
  move-track <deckId> <slideId> <trackId> <toBeatId> [--at n]   move a track to another beat
  duplicate-track <deckId> <slideId> <trackId>   deep-copy a track (prints the new id)
  reorder-tracks <deckId> <slideId> <beatId> --order t2,t1   set a beat's lane order
  set-track-enabled <deckId> <slideId> <trackId> true|false   disable = kept but not played
  set-part-visibility <deckId> <elementId> <part> show|animate|mask   plot part tri-state (non-destructive)
  set-part-style <deckId> <elementId> <part> --patch '<json>'   per-part style override (stroke/fill/…)
  animate-part <deckId> <slideId> <elementId> <part> [--beat-index n]   default reveal for a plot part
  animate-element <deckId> <slideId> <elementId> [--exit --preset P --beat-index n --part <plotPartId>]   enter/exit for text/shape/image/plot
  validate-deck [deckId] [--root R]    validate a deck (or all decks)
  export-deck <deckId> [--out F] [--root R]   export a self-contained offline .html (default exports/<deckId>.html)
  export-slide-video <deckId> <slideId> [--out F] [--root R]   export one slide as MP4; --step-delay/--start-hold/--end-hold in ms, --height 720|1080|2160, --fps 30|60
  help                                 this message
`;

function help(verb?: string): string {
  if (verb && registeredCliVerbs().includes(verb)) return registryHelp(verb);
  const registered = new Set(registeredCliVerbs());
  let keep = true;
  const legacy = HELP.split('\n').filter(line => {
    const match = /^  ([a-z][a-z-]*) /.exec(line);
    if (match) keep = !registered.has(match[1]);
    return keep;
  }).join('\n');
  return `${legacy}\nRegistry commands (flags from the shared CLI/MCP contract):\n${registryHelp()}`;
}

const num = (v: unknown): number | undefined =>
  v == null || v === true ? undefined : Number(v);

async function main() {
  core.setClient(process.env.FLUX_CLIENT || "cli"); // WS6: journal/lock identity
  const [verb, ...rest] = process.argv.slice(2);
  const { _, flags } = parseCliFlags(verb, rest);
  if (flags.help) { console.log(help(verb)); return; }
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
      {
        log: console.log,
        err: console.error,
        raw: (t) => process.stdout.write(t),
        setExit: (c) => (process.exitCode = c),
      },
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
    // Principal-agent scheme: interactive launch + the attend daemon are
    // deliberately CLI-only legacy verbs (they own the terminal / never return —
    // inexpressible as registry/MCP tools, like `new`).
    case "principal":
    case "agent": {
      if (flags.print) {
        console.log(JSON.stringify(core.principalSpec(root()), null, 2));
        break;
      }
      process.exitCode = await core.runPrincipal(root(), {
        family: flags.family as string | undefined,
        model: flags.model as string | undefined,
        effort: flags.effort as string | undefined,
        workerFamily: flags["worker-family"] as string | undefined,
        workerModel: flags["worker-model"] as string | undefined,
        workerEffort: flags["worker-effort"] as string | undefined,
        noPicker: !!flags["no-picker"],
        noTranscript: !!flags["no-transcript"],
      });
      // This verb owns the terminal and has nothing left to flush, so it exits
      // rather than waiting for the loop to drain: on Windows node-pty leaves a
      // MessagePort and a Socket open after the child exits, and `flux principal`
      // with a transcript never returned to the shell (measured: still alive
      // indefinitely, the gate's 60s exit wait timed out). stdout here is a
      // terminal, where Windows writes are synchronous.
      process.exit(process.exitCode);
    }
    case "attend": {
      await core.attend(root(), {
        intervalMs: num(flags.interval),
        echo: !!flags.echo,
        onEvent: (m) => console.error(`[attend] ${m}`),
      });
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
    case "discover": {
      const semantic = flags.semantic !== undefined;
      // The declared boolean never consumes the following query words.
      const q = _.join(" ");
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
        console.error(`✓ keys saved to ${path.join(await core.resolveFluxLibPath(), "keys.json")}`);
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
    case "fetch-supplements": {
      const r = await core.fetchSupplements({
        keys: typeof flags.key === "string" ? [flags.key] : undefined,
        onProgress: (d, t) => process.stderr.write(`\r  ${d}/${t}`),
      });
      process.stderr.write("\n");
      console.error(`✓ Supplements: ${r.files} file(s) for ${r.papers} paper(s), of ${r.total} checked`);
      for (const g of r.results.filter((x) => x.added > 0).slice(0, 25)) console.error(`  + ${g.key}  ${(g.names ?? []).join(", ")}`);
      if (!r.files) console.error("  (Europe PMC serves supplements for its OPEN-ACCESS subset only — subscription papers need the GUI's “Get via library ⚿”.)");
      break;
    }
    case "missing-pdfs": {
      const rows = await core.missingPdfs();
      // CSV on STDOUT so `flux missing-pdfs > missing.csv` (or a pipe into anything) just
      // works; the human summary goes to stderr, same split as every other verb here.
      const out = flags.json ? JSON.stringify(rows, null, 2) + "\n" : core.toCsv(rows);
      if (typeof flags.out === "string") {
        await (await import("node:fs/promises")).writeFile(flags.out, out);
        console.error(`✓ ${rows.length} reference(s) with no main text → ${flags.out}`);
      } else {
        process.stdout.write(out);
        console.error(`✓ ${rows.length} reference(s) with no main text`);
      }
      const by = (st: string) => rows.filter((r) => r.status === st).length;
      console.error(`  never-tried ${by("never-tried")} · no-oa ${by("no-oa")} · failed ${by("failed")}`);
      const noDoi = rows.filter((r) => !r.doi).length;
      if (noDoi) console.error(`  ${noDoi} have no DOI at all — nothing to resolve until they're enriched`);
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
    case "help":
    case "--help":
    case "-h":
    case undefined:
      console.log(help(_[0]));
      break;
    default:
      console.error(`flux: unknown verb "${verb}"\n`);
      console.log(help(_[0]));
      process.exit(1);
  }
}

main().catch((e) => {
  const result = errorToCli(e);
  console.error("flux: " + result.err);
  process.exitCode = result.exit ?? 1;
});
