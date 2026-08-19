# Flux — Agent Engineering Guide (RUNNING)

This is the **living engineering guide for AI agents working on Flux**. It is the accumulated,
distilled knowledge of every agent session that came before yours. Read it in full before doing
substantive work. It exists so the human directing you never has to re-explain the codebase, the
conventions, or the traps.

---

## How to use and maintain this document (read this first)

This document has two parts: the **body** (sections 1–10, the authoritative distilled knowledge)
and the **session log** (section 11, an append-only history). The rules:

1. **Before working:** read the body. Skim the last few session-log entries for anything fresher
   than the body.
2. **While working:** if you discover anything that makes something in this document **false,
   incomplete, or improvable** — by removal, addition, or modification — **edit the body in the
   same session**, and mention the correction in your session-log entry. The body must never
   knowingly lag reality. Prefer editing an existing sentence over appending a caveat.
3. **After any major session of work:** append a datetime-stamped entry to the **end** of the
   session log (chronological order, newest last) in this exact shape:

   ```markdown
   ### YYYY-MM-DD — <short title> (<model/agent>, <branch>)
   **Work:** 1–3 sentences on what was done and how it went.
   **Learnings:** bullet list of ONLY the genuinely reusable lessons — principles, rules,
   traps, corrections to this guide. Omit the section entirely if there are none.
   ```

   Entries must be **concise**. They are not work summaries — commit messages and plan ledgers
   hold the detail. An entry earns length only when the context is critical for future agents.
4. **Promote, don't accumulate:** a durable lesson belongs in the **body**, placed in the right
   section; the log entry just notes that you promoted it. The log is history; the body is truth.
   Never let the log become the only place a rule lives.
5. Commit guide updates with the work they came from (explicit paths — see §5).

---

## 1. What Flux is, technically

Flux is a desktop **scientific writing studio**: manuscript editor (Paper), figure editor
(Figure), slide deck builder (Slide), PDF reader/annotator (Reader), and reference library
(Library) over one project format. Stack: **Svelte 5 + Vite + Electron** (Tauri remnants are
vestigial). It is deliberately **agent-native**: an AI agent is a first-class user with the same
capabilities as the GUI, through three surfaces:

- **`flux` CLI** (`flux-cli.ts`) and **MCP server** (`flux-mcp.ts`) — both generated from **one
  verb registry** (`flux-core/registry.ts` + `flux-core/verbs.ts`, ~99 verbs). They operate on
  project files directly through `flux-core/*` (Node).
- **Live bridge** (`electron/bridgeServer.cjs` + `src/lib/project/liveClient` path) — a loopback
  control server per open project that dispatches ~38 verbs against the **live GUI store**. Its
  switch IS its allow-list; it is deliberately NOT part of the registry.
- **The Context layer + principal runtime** (principal-agent scheme, 2026-07-19): all agent
  memory/context lives in two folders — `<FluxConfig>/Context/{UserContext,FluxContext}`
  (machine: user identity/rules + stock docs synced from `resources/flux-context/` via
  generated `electron/fluxContextDocs.gen.cjs`) and `<project>/Context/` (MISSION/NOTEBOOK/
  RULES as first-class paper docs + Transcripts/Dispatches archives). `<FluxConfig>/agents.json`
  (shared core `electron/agentsConfig.cjs`) names the user's principal/worker CLIs; the in-app
  Agent drawer (Ctrl+Shift+J, `src/shell/agent/`), `flux agent`, `flux dispatch`, and
  `flux attend` launch them. The feedback ledger (`.meta/feedback.ndjson`, event-sourced
  append-only, shared core `src/lib/project/feedback.ts`) carries context-stamped review notes
  (Ctrl+Shift+M capture). Gates: verify-context-scheme / -feedback / -dispatch (pure),
  verify-context-gui (ui), verify-principal-electron (electron).

The defining architectural fact is the **dual engine**: every mutation of project data can happen
through the **GUI renderer** (Svelte stores → bridges → Electron fs IPC) *or* through
**flux-core** (plain Node fs). Historically these drifted; most of the hardening work exists to
make drift structurally impossible. Which leads to:

## 2. The Twin-Engine Rule (the single most important convention)

**Any logic that both engines need must live in exactly one shared pure module, and a parity gate
must pin that both engines produce identical results.** Never re-implement, "mirror", or copy
logic between `src/lib/**` and `flux-core/**`. The dependency direction is always
`flux-core → src/lib` (never the reverse), and shared modules must be pure (no Svelte, no DOM, no
Node-only APIs) so they load in both worlds.

The established shared cores — extend these, don't duplicate them:

| Domain | Shared core | Parity/behavior gate |
| --- | --- | --- |
| fig/ persistence (shapes, labels, writer plan, save ordering) | `src/lib/project/figfiles.ts` | `verify-figfiles-parity.ts` (byte-identical trees) |
| Model mutations (all figure edits) | `src/lib/ops.ts` (+ `editing.ts`, `geometry.ts`) | `verify-ops.ts`, figenh parity suite |
| Pointer-gesture math (resize/snap/handles) | `src/lib/interact/` | `verify-interact-core.ts` |
| Load-gate validation (parse → migrate → validate) | `src/lib/project/validate.ts` (+ generated `validators.gen.js`) | `verify-loadgate.ts` |
| Reference query grammar | `src/lib/references/query.ts` | `verify-organize.ts` |
| Enrichment shapes/projection | `src/lib/references/enrich.ts` | `verify-enrich-grid.ts` |
| PDF identification + the `_unresolved/` sidecar | `src/lib/references/pdfIdentify.ts` | `verify-pdfidentify.ts` |
| Text folding / fulltext terms | `src/lib/references/textFold.ts` | `verify-fulltext-search.ts`, `verify-scale-fulltext.mjs` |
| Front-matter parsing (13 former hand-rolled sites) | `src/shell/modes/paper/frontmatter.ts` | `verify-frontmatter.ts` |
| Captions/panels | `src/lib/captions.ts` | `verify-w9-roundtrip.ts` |
| Deck ⇄ figure-Project projection (slides-are-figures) | `src/lib/slide/deckProject.ts` | `verify-deckproject-roundtrip.ts` (identity) |
| Deck/beat/track mutations | `src/lib/slide/ops.ts` (static editing = figure `ops.ts`) | `verify-slide-track-ops.ts`, `verify-slide-headless-e2e.ts` |
| Transform tween (state ⊕/diff/lerp, pre-state folding) | `src/lib/slide/tween.ts` (+ `color/interp.ts`, `path.resampleNodes`) | `verify-slide-tween.ts`, `verify-color-interp.ts` |
| Trim-path dash math (drawOn/drawOff windows) | `src/lib/slide/player/trim.ts` | `verify-trim.ts` |
| Animation preset/template matching | `src/lib/slide/animTemplates.ts` | `verify-anim-presets.ts` |
| Slide static rendering | `export.ts elementToSvg` → `slide/player/render.ts` | `verify-slide-export-parity.ts` (GUI vs headless export) |
| Plot part overrides (figure + slide) | `ops.mergePartOverride` | `verify-slide-track-ops.ts`, figenh part suites |
| Placed-plot inline markup from svg text (overrides/crop/pt-true baked) | `src/lib/plot/inlineMarkup.ts` (flux-core render + paper `scholar/figures.ts`) | `verify-paper-render-overrides.ts` (byte parity, both engines) |
| Present-mode input/HUD | `src/lib/slide/present/core.ts` | `verify-present-core.ts` |
| Paper snips (naming, citation, sidecar/tEXt meta, raster plan) | `src/lib/references/snips.ts` (+ `journalAbbrev.ts`) | `verify-snips.ts`, `verify-snip-headless.ts` |
| CLI/MCP verb surface | `flux-core/registry.ts` + `verbs.ts` | `verify-registry-parity.ts` (goldens) |
| Zotero sync (settings shape, summary line, attach/backfill planning, attachment path candidates) | `src/lib/references/zoteroSettings.ts` + `zoteroFiles.ts` | `verify-zotero-sync.ts` (hermetic; also EXECUTES the CLI verb) |
| Live Zotero fields in Word exports (citation marking, docx field injection, library harvest) | `src/lib/references/zoteroFields.ts` (flux-core `compile` + PaperMode's export do only IO) | `verify-zotero-fields.ts` |
| External-command launch (quarto, recipes, agent roster) | `electron/execResolve.cjs` (identity off win32; PATH×PATHEXT + ComSpec wrap on win32) | `verify-win-spawn.ts` |

## 3. Data model and persistence invariants

A project is a folder: `project.json` (manifest), `manuscript/**.qmd` (text is truth),
`Context/` (the agent layer: `Project/MISSION.qmd` + `NOTEBOOK.md` + `RULES.md` are
first-class paper documents — discovered by the Context scan in both listDocuments
twins, comments sidecars derive beside them, watcher subsystem "context" rides the
manuscript reload chain; `Transcripts/`+`Dispatches/` are archives, not documents;
pre-Context projects heal on open via contextHeal.ts / `flux context-init`),
`fig/index.json` + `fig/canvases/<id>.json` + `fig/captions/<id>.md` + `fig/assets/`,
`slides/<deckId>/deck.json` (0.3.0, **slides-are-figures** + the animation
rework: a slide's `elements` is the figure `Element` union verbatim + a
presentation overlay of beats/transition/notes/camera; tracks animate in two
FAMILIES — appearances and transforms (`to.state` = a sparse t2 patch folded
left-to-right across beats; `Beat.groups` = collapsible animator lanes);
deck-local media under `slides/<id>/assets/`, figure `Asset` shape; project
plots/fig media resolved BY ID, never copied in; `0.2.0` decks migrate via a
pure stamp at the normalizeDeck chokepoint; `0.1.x` decks remain a sanctioned
clean break — they fail validation and quarantine, no migration),
`references/library.bib` (the project's *cited subset*),
`.meta/` (locks, journal, live bridge). Machine-global state lives in `~/FluxConfig`
(pointer pref `fluxConfigPath`); the reference library is **always derived** as
`<FluxConfig>/FluxLib` — never persist or read a separate `fluxLibPath`
(`verify-fluxconfig.ts` gates this). Machine config dir is lowercase `~/.config/flux` only.

Persistence invariants (all machine-checked — do not weaken):

- **Review discovery is project-wide by default**: headless `comments` / `list_comments`
  scans every canonical document (including Context documents) and attaches the owning
  document path; `resolve-comment` without `--doc` resolves only a unique open match across
  the project. `--doc` is an explicit single-document narrowing, never a boot requirement.

- **Document-role changes preserve review discovery**: the current main document reads both
  `comments.json` and its document-named `<base>.comments.json` sidecar, deduplicated by thread
  id. Promoting a secondary manuscript to main must never make its existing comments vanish.

- **Every canonical write is atomic** (`tmp + fsync + rename`; `flux-core/fsx.ts`,
  `atomicWriteMain` in `electron/ipc/files.cjs`). Directory entries are fsynced after rename
  batches (`fsyncDir`).
- **fig/ saves have a commit point**: canvas files first → dir fsync → captions →
  `index.json` **last** (+ one-generation `index.json.bak`). The index never references a canvas
  file that doesn't exist, even across SIGKILL (`verify-figsave-txn.ts`). The ordering lives once,
  in `executeFigSave` (figfiles.ts) — never reorder it.
- **Plot source paths are PROJECT-RELATIVE** — `SemanticPlotElement.source.svgPath` /
  `manifestPath` / `recipePath`. This is a *silent* invariant: the SVG bytes live in
  `fig/assets/`, so a wrong source path renders and exports fine and only stops the things
  that relink to the origin — `plots/` hot-swap, the slide bridge, Regenerate, the X-ray
  source line — the moment the project root changes (synced to a second machine, folder
  renamed, restored elsewhere). Three import routes historically wrote three shapes
  (absolute picker path from the GUI, relative from headless, bare filename from drag-drop),
  so **one module owns all of them**: `src/lib/plot/source.ts` —
  `toProjectRelativeSource` on write, `healPlotSources` on load (pure, idempotent,
  string-only, runs in both loaders), `plotSourceCandidates` at every read (probe in order,
  first that exists wins). Never join a stored source path straight onto the root, and never
  assume it is absolute: `runRecipe` needs a real absolute path and resolves the recipe's
  `cwd` from its dirname, so X-ray resolves before invoking it. A genuinely *external* plot
  keeps its absolute path — the one case the relativizer must not touch. Callers that also
  hold a security boundary (`flux-core/render.ts`, where a canvas file is untrusted input)
  filter candidates through `isUnderRoot` rather than dropping `safeJoin`'s guarantee.
  Gated by `verify-plot-source.ts`.
- **A sync tool's leftovers are never ordinary files.** `electron/conflictRules.js` is the ONE
  definition (typed wrapper `src/lib/project/conflictRules.ts`), loaded by the watcher, the
  scan, the resolver and `listDocuments` alike. Two shapes, opposite treatment: an in-flight
  `.syncthing.*.tmp` transfer is **silent** (it is noise, not an event), while a
  `<base>.sync-conflict-<date>-<time>-<device7>` copy raises the dedicated `"conflict"`
  subsystem — checked FIRST in `subsystemFor`, before any path prefix, because a conflict copy
  of `main.qmd` is not a manuscript edit. Two rules follow and are gated by
  `verify-sync-conflicts.ts`: **a conflict copy must never appear as a document** (listDocuments
  scans directories, so it used to offer one as an editable twin), and **an unresolved conflict
  must never be silently ignored or silently deleted** — the banner is non-dismissable and every
  resolution ends with the copy gone. Only append-only `.ndjson` ledgers get an automatic answer
  (union the lines); everything else is the user's call. The scan runs on project open, not just
  from watcher events: conflicts arrive while Flux is CLOSED, which is exactly when the other
  machine was in use.
- **Byte-identical rewrites are skipped** everywhere (watcher churn, disk wear, mtime stability).
- **Divergence detection**: the GUI keeps per-file baselines (index, every canvas, decks); an
  external edit raises `ConflictError` → the reload/overwrite banner. Force-overwrite re-baselines
  from disk. Never silently clobber (`verify-canvas-divergence.ts`).
- **Forward-version guards**: files stamped with a newer breaking format (0.x → **minor** is the
  breaking slot) refuse to load and are never rewritten (`verify-fwdguard.ts`).
- **Load gate**: parse → `migrateProject` → validate ("legacy-lenient, post-migration-strict");
  invalid derived files are quarantined as `.corrupt-<ts>` copies, never half-loaded.
- **Locks**: mutating headless verbs run `mutateFigModel` (load→mutate→save inside the `project`
  lock) and journal afterwards. A held human lock defers agents with the standard
  "deferred … is locked" message (CLI exit 75 via the error taxonomy). Lock claims and
  restamps are **content-atomic** (tmp + hard-link / rename — `flux-core/locks.ts`, mirrored
  by the GUI's `writeLockFile`): the old open("wx")-then-write claim let a contender read the
  just-created file EMPTY, judge it corrupt, delete the holder's live lock, and walk into the
  critical section beside it (a real lost update, found 2026-08-13 by verify-note's contention
  gate; pinned in verify-w3-locks §6). Corollaries: never clear a lock you couldn't READ as
  stale (a vanished file just retries; corrupt content clears only past the TTL by mtime), and
  clear a stale lock by RENAME-to-trash so two contenders can't double-clear each other's
  fresh claim. Notebook session-log entries have a dedicated locked appender: `flux note`
  (`addNote`, manuscript lock — safe with N concurrent principals; verify-note).
- **Text is truth**: derived caches (`.fluxlib/*.json` indexes, `fulltext-index.json`,
  `enrich-grid.json`, `fig/renders/`, `validators.gen.js`) are rebuildable and must self-heal via
  mtime/staleness rules, never become load-bearing.

## 4. Renderer architecture notes

- **Svelte 5, but much of `src/lib` is legacy-syntax** (`$:` + stores) while newer shell/mode code
  uses runes. Both are fine; know the traps in §9.
- **Scoped invalidation**: figure commits bump `figureRev[figId]`; any non-scoped store notify
  bumps `globalRev` (under-invalidation impossible by construction). Expensive derived work keys
  on `${figureRev[id]}|${globalRev}|…` and memoizes in **non-reactive `const` boxes**.
- Mutations go through `commit`/`mutate`/`mutateFigure` in `src/lib/store.ts`; gestures are
  `beginGesture` → transient preview → one commit on release. Undo history is byte-budgeted
  (64MB / 200 entries).
- **External-reload contract (2026-08-14):** an agent/CLI edit to `fig/` that live-reloads a
  clean editor (W10) — or the banner's "Reload theirs" — must land IN PLACE: the user's active
  canvas/figure/selection are preserved wherever their ids survive (first-canvas fallback only
  when they don't), and the swap is pushed as ONE undo entry so Ctrl+Z restores the exact
  pre-agent state with the user's own history intact beneath it. The mechanism is
  `store.loadProject(p, dir, { reload: true })` (threaded from `loadFigInto` →
  `FigureMode.reloadFigures`); initial loads must NOT pass `reload` (their pre-state is a
  blank/foreign project — history still resets). Slide mode mirrors the view half:
  external-change reloads go through `openDeck(id, { preserveView: true })`, which restores the
  current slide + beat via `selectSlide` instead of landing on slide 1 + re-fitting (slide
  history still resets on reload — the overlay companion's checkout/display maps make a
  pre-reload snapshot unsafe to restore; deliberate). Gates: `verify-fig-reload-preserve.ts`
  (pure) + `verify-w10-matrix.mjs` (renderer wiring). Undoing a reload dirties the editor, so
  the revert autosaves back over the external version — that IS the intended "reject the
  agent's change" path. Asset BYTES stay outside undo everywhere (reimportPlot hot-swaps are
  not undoable), unchanged.
- Big collections use windowing (`VirtualFixedList.svelte` for the sidebar; hand-rolled row window
  in `LibraryMode`) — all N rows in the DOM is never acceptable at 5k scale.
- **Plot DOM residency is LAZY** (2026-07-21, plan: `notes/lazy_figure_asset_loading_plan.md`).
  Project open loads asset BYTES (`assetData`), sidecar manifests/recipes, and `model.assets`
  metadata eagerly — all cheap — but the parsed pristine SVG DOM (`plot/store.ts plotDom`, the
  dominant memory cost at ~180k renderer nodes per dense figure) is populated ON DEMAND: a
  mounted `PlotElement` with no cached DOM renders the full-fidelity `<image>` fallback and
  calls `requestPlotDom` (a self-terminating, ~6ms-sliced macrotask parse queue), and
  `cachePlot`'s `plotGen[id]` bump is what flips it inline. Viewport culling is therefore the
  residency policy; an LRU under `plotResidency.nodeCap` (150k element nodes, SOFT — mounted
  plots are never evicted; refcounts via `retainPlot`/`releasePlot`; runtime cap changes go
  through `applyPlotNodeCap`) keeps resident cost O(working set) instead of O(project).
  Hard invariants: (1) `model.assets` stays 100% resident — the fig/ index is regenerated from
  it on save, so pruning it would orphan asset bytes (verify-lazy-save-safety); (2) every GUI
  figure export funnels through `io.ts buildFigureSvg` → `ensureFigurePlots` (synchronous
  parse) so per-part overrides always bake instead of falling to the raster
  (verify-lazy-export-overrides) — and the PAPER module's disk-backed renders (embeds, hover
  cards, pickers, in-app preview/PDF, app-side materializeRenders: `scholar/figures.ts
  renderFigureSvg` over `readFigSource`) bake the same overrides through the shared
  `plot/inlineMarkup.ts` and degrade a failing figure to "no preview" instead of throwing —
  a single throwing figure once killed the whole FigurePicker silently
  (verify-paper-render-overrides, byte-parity with flux-core); (3) anything reading `hasPlotDom`/`plotDom` reactively must
  depend on `$plotGen[id]` or it will never see the lazy upgrade (verify-lazy-load-gui);
  (4) slide mode stays EAGER (`resolveDeckAssets`) and eviction is tenancy-gated to figure
  mode — deck morph targets and filmstrip thumbnails have no mount-driven reload path.
  Import/hot-swap/preset-insert still cache eagerly (a new plot is about to be visible).
  Vanilla svgs derive their manifest at first parse, so the X-ray is empty for them until
  first view (accepted). Measured @12 dense figures (real rasterized-FluxProjection density):
  open 2.55s → 0.88s, renderer nodes 2.25M → ~307k FLAT in figure count, parsed docs 168 → 14;
  cold figure-focus ~330–500ms (raster paints immediately, upgrades under the 1s navigation
  budget), warm re-focus ~20ms and re-parses nothing. Gate: `verify-scale-lazy-assets.mjs`.
- The **paper editor** (CodeMirror 6) is the most latency-sensitive surface in the app. The
  mechanisms that keep it instantaneous (§6) and glitch-free — engineering constraints, not
  aesthetics; understand them before changing them: BLOCK WIDGETS are a pure function of the
  DOCUMENT, never the selection (a selection-driven rebuild once swapped a ~500px widget in the
  caret's own transaction — the "arrow up jumps multiple lines" bug); no block-level
  `atomicRanges` — embeds/tables/math render as a styled source line plus a block widget AFTER it,
  so every doc line costs exactly one vertical keypress (the ONE deliberate exception is a
  table's collapsed source, below — it hides whole lines, and pays for that with its own
  navigation/height gates); source-line metrics are identical active
  vs. inactive (goal-column navigation survives caret entry); block widgets carry accurate
  `estimatedHeight`s (scroll stability); vim loads FIRST in the extension tree (it claims keys at
  the DOM level); citation ordinals publish synchronously before the chip plugin; external reloads
  dispatch a minimal single-span diff, never a whole-doc replace. Per-editor state rides facets
  (no module singletons); block StateFields are change-gated by `science/changeGate.ts` so prose
  keystrokes pay zero construct cost. Focus returns to the editor after every transient UI.
  Regression suite: `group:paper-gate`.
  **Local corrections** (2026-08-04, contextual lane 2026-08-05) live in
  `editing/localCorrections.ts`: an abbreviation-aware shared segmenter schedules a
  completed-word lane and a separate completed-sentence lane. Both lint through the dedicated
  module worker (`localCorrection.worker.ts`, Harper slim WASM), then revalidate exact source
  against the current document before applying each accepted batch in isolated history.
  **THE WINDOW RULE (2026-08-09):** every window is a SLICE, but the linter reads each one as a
  whole document, so a window must carry enough language to be read correctly and must declare
  what it may change. The word lane submits the SENTENCE SO FAR with a `focus` — the final two
  completed tokens — and only the focus is correctable (`scopeWindowLints` + `withinFocus` in the
  pure core bound the lints AND every span the planners synthesize from the window text; the
  protected-range veto and the worker's per-word mechanical rescue search are focus-scoped too).
  A window that does not begin a real sentence (`windowStartsSentence`) additionally drops
  sentence-OPENING verdicts about its first sentence — that is the residual guard for the
  sentence lane's 760-char clamp and the backlog scan's whitespace fallback cut. Never shrink a
  window to "just the interesting tokens": a bare two-token slice made Harper report the tail of
  one sentence as the lowercase head of another, a mid-sentence adverb as a discourse marker owed
  a comma, and both halves of "et al." as unknown words.
  The synchronous keystroke path never calls the linter. `localCorrectionCore.ts` is deliberately
  conservative: mechanical edits only; arbitrary one-letter substitutions, scientific compound
  styling, phrase/style lints, technical tokens, and protected Markdown never auto-apply. Visual
  marks are zero-layout; immediate native Undo restores the batch and persists per-project vetoes.
  Explicit language data is a separate v2 profile (`localCorrectionProfile.ts`, lossless v1
  migration): project + device-wide Personal dictionaries and aliases, with project aliases
  taking precedence. `localWordTools.ts` owns the selection toolbar/popover and Vim-proof
  `Prec.highest` chords. Alias expansion is synchronous but tiny: a transaction filter appends
  the replacement to the delimiter's SAME transaction (one exact Undo), while the worker remains
  entirely off the keystroke path. Explicit mixed-case terms feed a conservative mechanical
  matcher in the pure core; arbitrary substitutions and version-like identifiers stay protected.
  Reset learning clears automatic vetoes but preserves explicit words/aliases. The worker and
  WASM stay lazy outside the startup graph. A deferred span receives a Flux-owned red underline;
  sentence judgment changes it to a transient blue correction line or a persistent, clickable
  orange abstention with structured (non-chain-of-thought) diagnostics. Native Chromium spelling
  decoration is suppressed only inside those owned spans so it cannot conflict with the state.
  A programmatically loaded document (open/switch/external reload — any docChanged with no
  userEvent) additionally gets a BACKLOG SCAN (2026-08-06): idle-paced chunks
  (`backlogScanWindows`, paragraph blocks cut at sentence boundaries) lint through the same
  worker and mark Harper-flagged spans with status `flagged` (red, persistent, capped at 300)
  — candidates come from `harperLintsOnly` normalization (no confusion-table/vocab synthesis,
  which would mark every "there"), the scan never edits, never calls the judgment model, skips
  the caret's own chunk (live lanes own it — this also keeps typed-fixture gates deterministic),
  and never downgrades an existing issue's status. Editing a flagged sentence hands it to the
  normal lanes.
  Unresolved sentence candidates may cross the bounded main-process seam in
  `electron/ipc/corrections.cjs`. The model first adjudicates supplied options; for a plain
  unresolved spelling token it may enter a bounded rescue protocol that proposes one
  case-preserving word. The persisted `standard` mode permits one edit for short tokens and two
  otherwise; `aggressive` permits three for 9+ letters; opt-in `really-aggressive` permits three
  for 7+ and four for 10+ letters and examines every bounded candidate.
  Recognizable scientific morphology gets a separate preservation veto, every proposal needs a
  fresh contextual approval, and the renderer independently requires Harper lexicon proof.
  `contextualCorrectionCore.ts` retains mutation authority, stale-source validation, policy gates,
  exact-span/edit-distance enforcement, and protected-range checks. The default managed provider lives in
  `electron/ipc/correctionRuntime.cjs`: a checksummed, main-owned `llama-server` helper on random
  authenticated loopback, with an explicit resumable Qwen model under
  `<FluxConfig>/Models/corrections/`. Ollama is an advanced local provider; OpenAI is explicit,
  `safeStorage`-keyed, `store:false`, and never a fallback. Personal language state is durable in
  `<FluxConfig>/Language/corrections.json`; project state is `.flux/corrections.json`.
  **Tables are a full editing surface** (2026-08-04): ONE escape-aware grammar/serializer in
  `science/tableModel.ts`, markdown-it-faithful because the export feeds the same text to
  markdown-it — escaped `\|` (escapedSplit port), header/delimiter column-count equality,
  terminator-based body absorption (pipe-less prose under a table IS a row), fence/display-math
  suspension in byte-parity with `refNumbers.ts`. Editing ops + Tab/Enter cell navigation live
  in `editing/tableOps.ts`; auto-reflow is a `transactionFilter` that appends the pipe re-padding
  to the SAME transaction (one undo unit, caret re-derived by cell+offset) and fires ONLY on
  user input/delete events — undo, IME composition, and external/agent reloads never reformat
  (text is truth). Widget cells render inline md/math/refs via `mdInline` resolver hooks
  (signature-diffed in updateDOM); a cell click routes the caret to its source cell through the
  `tableHandlers` seam; the wrap is `width:0; min-width:100%` so a wide table scrolls inside
  `.flux-tablescroll` instead of pushing cm-content past the pane (the editor's line-wrapping
  `overflow-wrap` is reset on the wrap — inherited, it mid-word-breaks cell numbers). The
  renderer binds table+caption into one `.tblblock` (paginator unit; over-wide tables zoom-fit,
  floor 0.55) — its inline scripts are CSP-hashed (PAGINATOR/LIVE_SCROLL/TBLFIT, w12 gate).
  **The pipe source COLLAPSES to one "Table N" pill off-caret** (2026-08-10, owner: a long
  table's markdown drowned the prose you were reading) — `science/tableFold.ts`, the embed-chip
  rule generalized to a multi-line construct. CodeMirror only accepts a line-break-spanning
  replace from a StateField, so this is the one paper field whose decorations depend on the
  SELECTION as well as the document; the rules that make that safe are: the rendered block
  widget below is a SEPARATE, doc-pure field (never rebuilt, never swapped — what burned the
  old reveal-on-cursor embed); the reveal predicate is "a selection range touches the block",
  boundaries included, so the caret can never land inside hidden text; no `atomicRanges`, so
  arrowing in still works; the value object is returned UNCHANGED when nothing opened or
  closed (CodeMirror then finds every chunk shared and does no height work); and the
  doc-side rebuild rides the same `changeGate` — with a `spans` set covering every table,
  since a revealed one contributes no decoration and a caption keystroke carries no trigger
  token. The scan is memoized per doc (`tableModel.scanTablesCached`) and the Quarto numbering
  is one shared `numberTables`. `paperPerf.tableFold` counts full re-derives; caret motion must
  cost zero (verify-table-fold §C + scale-paper's structural budget). Height DOES move when a
  block opens — CodeMirror's own scroll anchoring absorbs it (measured: 0px caret drift
  arrowing out of a 30-row table, ~59px when clicking prose below one), so do not add scroll
  compensation without re-measuring first. Gates: `verify-table-fold.ts` (pure, hermetic —
  the whole contract is StateField logic), `verify-paper-tables.mjs` §F (pill DOM + click
  routes), `verify-paper-nav.mjs` (one keypress per line still holds THROUGH a table; height
  constant outside the block, constant inside it, and back to exactly the collapsed value).
- **Slide mode edits through the figure store** (slide-migration, 2026-07): a
  deck loads as projected figures on the synthetic `"deck"` canvas
  (`deckProject.ts`), the shared Canvas (`frame` prop) / Inspector
  (`flux-editor-mode` context) / X-ray / presets / keyboard operate on them,
  and the presentation overlay lives in `slide/store.ts` (`deckOverlay`,
  composed back on save by `projectIntoDeck`). Deck-level structural ops go
  through `commitDeckLive` (compose → ONE pure `slideOps` fn — the same fn
  flux-core runs — → decompose). Overlay edits ride the figure history via
  `store.registerHistoryCompanion` → ONE unified Cmd+Z. THE TENANCY RULE:
  figure and slide mode share that app-global store, so they are mutually
  exclusive residents — `paneStore` denies side-by-side panes, mode mounts
  flush+evict the other (`evictMode`), and the bridges hard-assert the tenant
  (`src/lib/tenancy.ts`) so a wrong-folder autosave is structurally impossible.
  BEAT-FAITHFUL DISPLAY (2026-07-18): the canvas always shows the slide AS
  IT EXISTS AT THE ACTIVE BEAT — elements with transforms in beats ≤
  activeBeat hold their COMPOSED state in the figure store (base elements
  captured in `displayBaselines`; every fold substitutes them back so
  deck.json never stores a composed state), and a plain edit routes into the
  GOVERNING transform's `to.state` ("you edit what you see"; beat 0 edits
  the base). `refreshBeatDisplay()` in slide/store.ts is the one reconciler
  (beat/slide changes, every deck op, undo/redo); it skips no-op writes so
  coalesced commit runs keep their editGen continuity, and it writes through
  `store.mutateDisplay` (bumps editGen for coalescing but NEVER sets `dirty`) —
  recomposing what a beat SHOWS is not a user edit, so plain beat navigation
  must not dirty the deck or trigger an autosave (V0.1 A2: it used to, which
  rewrote deck.json per nav and raised a spurious external-change banner that
  biased toward a data-losing Overwrite). `clearBeatDisplay` (slide-switch base
  restore) uses `mutateDisplay` for the same reason. Deck saves also skip a
  content-identical rewrite (`sameDeckContent` ignores the always-changing
  `modified` stamp) — the §3 byte-identical invariant, extended to decks. Gate:
  `verify-beat-display-gui.mjs` (scrubbing every beat leaves the deck clean +
  deck.json byte-identical; a real edit still dirties + rewrites).
  When touching stores/keep-alive, run `verify-slide-tenancy-gui.mjs`.
  Svelte 5 trap discovered here: `store.set(sameObjectRef)` does NOT re-render
  `$store` consumers in runes components (referential dedup) — publish a fresh
  identity (`store.set({ ...o })`) when mutating in place.
- **The reader is multi-document** (reader-tabs, 2026-08-04): `readerStore.readerTabs`
  ({tabs, active}, persisted to localStorage `flux-reader-tabs`) is the open-paper strip;
  `readerKey` is a READ-ONLY derived view meaning "the focused pane's paper" (the
  `__fluxReaderKey`/`get_reading_context` contract). Everything scoped to one paper lives in
  `ReaderDoc.svelte` (`citekey` immutable per instance — a switch mounts a fresh one);
  `ReaderMode` is the shell: tab strip, keep-alive (`MAX_LIVE_DOCS = 3`, MRU,
  ModeContent-style visibility flip — warm tab switch is instantaneous; cold tabs restore
  page/zoom from `flux-reader-view:<key>`, flushed on destroy), and the ONE shared-terminal
  mount (`agentPane` snippet rendered by the active doc only; across panes the host is claimed
  via `readerTerminalPane`). Split panes: `paneId` threads Pane → ModeContent → mode;
  a reader pane shows `paneActiveTab[paneId] ?? readerTabs.active`, with every reader pane
  PINNED to its current paper before any re-target (one pane's change never retargets the
  other). reader-context.json has a single writer (module-level owner token; only the
  focused doc publishes, only the last writer clears). Same-paper-in-two-panes annotation
  sync rides `annotationsBridge.annotationsRev` (one bump per in-app write; writers
  skip their own by count — the fs watcher suppresses self-write echoes, so
  fluxLibRevision never covered in-renderer cross-view sync). Gates: `group:reader-gate`
  (15 scripts) + the `src/shell/modes/reader/**` pathMap entry; tab semantics pinned in
  `verify-r7-tabs.mjs`. Gate-selector rule: probes must scope to
  `[data-doc-active="true"]` (hidden kept-alive docs are in the DOM) and to panes BY INDEX
  (every `.pane` sits alone in a `.slot` wrapper, so `:first/last-child` match both).
- Electron: `main.cjs` is a **composition root**; handler families live in
  `electron/ipc/{contract,files,terminal,network,agent}.cjs`. Every IPC channel is declared in
  `contract.cjs` (`verify-ipc-contract.ts` — no orphans in either direction). The renderer runs
  under a **CSP with no `unsafe-eval`** — see §5.
- **Multi-window (2026-08-11): one process, N windows, one project per window.** All
  per-window lifecycle state lives in main's `sessions` registry (webContents id → {win, root,
  watcher}); handlers resolve the sender's root via `rootFor(e)` — never a global. The watcher
  is split: ONE process-wide machine-global watcher (FluxLib/zotero/capture, fans out to all
  windows) + a small per-window project watcher. Agent bridges are keyed by root and pinned to
  their window (`ipc/agent.cjs`); GUI locks key `senderId:scope:name`; dialog APPROVALS are
  per-window while the fsGuard roots() union stays global (roots are project roots, approvals
  are transient dialog grants). The same project never opens in two windows —
  `win:projectOpenElsewhere` focuses the existing one (two autosavers on one manuscript can
  lose writing). Reader sessions persist per project root (`flux-reader-tabs:<root>`). QUIT is
  decided by `appLifecycle.createAppWindowPolicy`: app windows register, hidden utility windows
  (proxy-capture, print) never do, and the last app window's close quits on non-mac — *a
  window the user cannot see must never keep the app alive* (the quit-wedge fix). Gates:
  `verify-quit-policy.ts` (pure), `verify-multiwindow.cjs` (electron).
- **Dual paper panes (2026-08-11): Paper left `SINGLETON_MODES`.** Every per-editor singleton
  is a per-instance factory now (selection bubble, cursor tracker, active-citation tracker,
  refReveal, margin pane stack) threaded via the MarginHost like WS-4.2 numbering; the
  chip/slash/table/embed handlers are a per-editor registry keyed by `view.dom`
  (`chipContext.registerPaperHandlers`, lookup by `el.closest(".cm-editor")`); flushable ids
  carry the pane id (`paper-<paneId>` — prefix matching in lifecycle.ts keeps every caller
  working); the feedback stamp publishes from the FOCUSED pane only; shell-routed
  palette/open-doc requests are focused-gated. Two panes on the SAME document are refused
  (`paperDocRegistry` — the request focuses the claiming pane; a shared-EditorState split view
  is a different feature, deliberately out). Figure/slide stay gated (app-global store, F5.3).
  Gate: `verify-paper-split.mjs` (paper-gate).

## 5. Hard rules — do not do these

1. **Never regress out of the instantaneous class (§6).** Responsiveness outranks every other
   user-facing quality. The paper editor is the most sensitive surface — §4 lists the mechanisms
   that keep it fast; understand them before touching `src/shell/modes/paper/**`, and run the full
   paper gate after ANY change there. There is no "locked feel" (a July-2026 lock was rescinded
   2026-07-12): editing behavior may change when there's a reason, with the affected gates updated
   alongside per rule 3.
2. **Never `git add -A` / `git commit -a`.** Stage explicit paths only — parallel agent sessions
   may have unrelated work in flight in this tree.
3. **Never loosen a failing gate to make it pass.** The gates encode contracts; a failure means
   fix the regression (or, if the gate encodes a *superseded* contract, prove that from git
   history and update the gate with the evidence in the commit message).
4. **No native Node dependencies** (`npmRebuild: false`; prebuilt-only posture). No SQLite/FTS5 —
   the pure-JS fulltext index exists precisely because of this.
5. **CSP:** never add `script-src 'unsafe-inline'` or `'unsafe-eval'`. Runtime `new Function` is
   banned in the renderer — Ajv validators are **pre-generated**
   (`node --import tsx scripts/gen-validators.mjs`, drift-gated in `verify-loadgate.ts`). A new
   inline script in the manuscript preview needs its sha256 hash added in `index.html` AND
   `electron/main.cjs` (`verify-w12-security.ts` recomputes them from source).
6. **Never hand-edit generated/golden files**: `validators.gen.js`,
   `scripts/fixtures/{mcp-tools.golden.json,cli-help.golden.txt}`. Goldens change only via
   `REGEN_GOLDEN=1 npx tsx scripts/verify-registry-parity.ts`, deliberately, with the diff
   explained in the commit.
7. **Don't bypass the mutation cores.** GUI model edits go through `ops.ts` + store commits;
   headless edits go through `mutateFigModel`/registry verbs. Hand-rolled JSON surgery on
   `fig/*.json` in app code is a bug.
8. **Don't persist derived paths or state**: no `fluxLibPath`, no wrap caches as truth
   (`TextElement.lines` is derived; headless edits set `needsLayout` instead — see
   `verify-text-parity.ts`).
9. **Capital-F "Flux" never appears in a filesystem path** except the legacy migration source
   (display strings carry `// flux-cap-ok`).
10. **Check :1420 before spawning a dev server**; if you spawn one for verification, kill it when
    done. The user often runs their own.
11. **Perf work is measure-first.** No optimization lands without a before/after number from the
    scale gates or a purpose-built probe, and budgets are structural (counts, windows) wherever
    possible — see §9 for measurement traps. Interactive latency targets follow the Nielsen
    classes — §6.

## 6. Responsiveness budgets — the Nielsen limits (product policy)

Flux targets the Miller (1968) / Nielsen (1993) response-time limits as **standing product
policy** (owner decision, 2026-07-12) — the same framework Obsidian builds against:

- **≤ 0.1s — feels instantaneous.** Required for everything in the *direct-manipulation* class:
  typing, cursor movement, drag/pan/zoom/nudge, selection, scrolling, hover feedback,
  search-as-you-type. The user must never perceive the tool between intent and result.
- **≤ 1s — flow of thought stays intact.** The budget for *navigations*: opening a
  project/document/mode, jumping to a search result, one-shot commands. Nielsen is explicit that
  the 0.1–1s band needs **no** feedback — don't add spinners here.
- **≤ 10s — attention limit.** Beyond ~1s show progress; beyond ~10s show percent-done and make
  it interruptible (bulk PDF fetches, enrich sweeps, exports).

Rules of practice:

1. **Classify every new interaction into a band at design time**, and give direct-manipulation
   interactions a scale-gate budget (§8) at fixture scale. An unclassified interaction is an
   unbudgeted one.
2. **Never mask slowness with artificial latency.** A debounce/throttle wider than the operation
   it hides is a bug: make the operation fast, then shrink or delete the delay. (Case in point:
   the library search debounce sat at 150ms while the scan it was protecting cost ~25ms.)
3. **Dev-mode numbers are the worst case** (§9, measurement traps): production strips Svelte dev
   tracing. Until a production perf harness exists (`window.__flux` is dev-only — building a
   packaged-build equivalent is a wanted item), scale gates budget ratios and structure; treat a
   dev-mode reading over 100ms as a flag to investigate, not automatically a failure.

Standing status (dev-mode, scale fixtures, as of 2026-07-13) — instantaneous class is green:
paper keystroke @20k lines 5ms sync / 34ms paint p95, undo ~1ms, figure pan 16–47ms, library
scroll 17ms p95 @5k refs, reader page-jump ≤56ms, warm fulltext 73ms @5k PDFs, slide-switch
33ms p95 + slide static-edit 34ms p95 @31 plot-bearing slides with 0 rAF at rest and
1-thumbnail invalidation per edit (`verify-scale-slide.mjs`, test-results/scale-slide.json). Known items above
100ms, tracked, descending priority: GUI `ft:` query (spawns a CLI subprocess per query — wants a
resident mtime-invalidated index in the main process), library first-keystroke 177ms (the 150ms
debounce above), sidebar edit @5k elements 156ms (un-memoized derived recompute), figure commit
@1600 elements 111ms p95 (≈2 frames of it is dev tracing; likely compliant in production —
unprovable until the prod harness exists). Reader open / project open / whole-doc find are
1s-class navigations and within budget. If you fix one of these, update this list.

## 7. The verification system (how you prove your work)

The manifest (`scripts/verify-manifest.json`) is the registry of all gates. **A new verify script
that isn't in the manifest doesn't exist.** Tiers:

- **pure** — hermetic Node/tsx, the `npm test` gate. Run: `node scripts/run-verifies.mjs --tier
  pure --jobs 4` (~21s parallel, currently 175 scripts, must stay green at all times).
  **Hermetic includes the user's machine state**, not just network and dev server: a pure script
  that can reach FluxLib redirects `HOME` + `XDG_CONFIG_HOME` into a scratch dir *before*
  flux-core loads (dynamic `import()` after the assignment — see `verify-zotero-sync.ts`,
  `verify-f1-core.ts`) **and** passes an explicit `libPath`. `verify-hermetic-fluxlib.ts` pins
  the libPath half; see the §9 trap for why both are needed.
- **ui / ui-extra** — puppeteer against the dev server on :1420 (`scripts/lib/driver.mjs`;
  fixtures via `?fixture=demo`, dev handles `window.__flux`, `__fluxView`, `__fluxSeed*`). ui is
  the curated stable suite (59), ui-extra the full sweep (60). Consoles must be **clean** —
  there is no tolerated-404 filter anymore.
- **scale** — the perf budgets (figure/paper/library/reader/fulltext). These are the standing
  60fps/scale contracts from the polish mandate.
- **presence** — the seven source-shape/static scripts (main-process/build config that headless
  drivers can't exercise; incl. `verify-electron-no-undef.ts`, the TS-checker undefined-identifier
  gate over `electron/**/*.cjs`). They also live in pure; the tier exists for `--changed` mapping.
- **bundle / startup / electron** — need `npm run build` / a real Electron run. Electron harnesses
  on this box need `--ozone-platform=x11` (§9).
- `--changed` maps `git diff` paths through the manifest's `pathMap`;
  `group:paper-gate` is the paper editor's regression suite (28 scripts). For parallel
  worktrees, set `FLUX_URL`; `driver.mjs` remaps legacy `gotoApp(...:1420...)` calls to that
  configured origin, but new gates should still use `APP_URL` and direct `page.goto` calls must
  never hardcode the default port.

Conventions: scripts print a `##VERIFY##` JSON sentinel (`scripts/lib/harness.mjs`); waits are
condition-based (`scripts/lib/wait.mjs`), never bare sleeps (kept sleeps must be annotated with
why); child processes are owned by `TestProcessScope` (`scripts/lib/testProcess.mjs`). Node 22 is
required — every shell needs `export PATH="$HOME/.local/node22/bin:$PATH"` on this machine.
`npm run check` (svelte-check) must stay at 0 errors/0 warnings.

## 8. Recipes for common work

**Before starting any feature:** (a) decide which engine(s) it touches — if both, the logic goes
in a shared core (§2); (b) find the gates that cover the area (grep the manifest + this guide's
table) and run them for a green baseline; (c) plan the NEW gate — features without verification
don't land; (d) classify the feature's interactions into Nielsen bands (§6); (e) check §10 that
you're not rebuilding something deliberately deferred or rejected; (f) if it changes
user-visible behavior, update the affected `docs/` user-docs page in the same session
(see the user-docs recipe below).

**Add a CLI/MCP verb:** one `VerbDef` in `flux-core/verbs.ts` (name, cli, one summary, one zod
shape, `cliArgs` mapping, handler calling `flux-core/*`, per-surface renders). Both surfaces are
generated. Then `REGEN_GOLDEN=1` the parity gate (tools/help goldens change — quote the diff),
and run `verify-registry-parity` + `verify-f1-mcp` + `verify-w11-verbs`. Errors: throw the typed
taxonomy (`flux-core/errors.ts`) — Locked→CLI exit 75, ExternalToolError carries exitCode+log,
everything is `isError` on MCP. A handful of verbs are deliberately legacy (inexpressible
CLI/MCP asymmetries — listed in the batch D/E commit bodies); don't force them into the table.

**Add an IPC channel:** declare it in `electron/ipc/contract.cjs` (kind: invoke/send/push +
scope), register through the wrapped `ipcMain` in the right family module, expose in
`preload.cjs`, add the FileBridge type in `src/lib/project/types.ts`. `verify-ipc-contract.ts`
fails on any orphan. Note: handler registration happens at require-time but Electron's
`session`/`app.getPath` are unusable before app-ready — lazy-init anything session-backed.

**Change the fig/ file format:** schema in `src/lib/project/schemas.ts` → regenerate validators →
migration in `src/lib/migrate.ts` (legacy-lenient) → shapes/plan in `figfiles.ts` → bump the
schema version ONLY for breaking changes (minor slot) → extend `verify-loadgate` /
`verify-figfiles-parity` / `verify-fwdguard`.

**Perf investigation:** reproduce via a scale gate or a throwaway probe against the dev server;
read §9's measurement traps first; prefer structural fixes (window, gate, scope, cache-by-rev)
and structural budgets; record before/after in the commit.

**Update the user docs** (`docs/` is a Quarto website — the V0.1 user documentation, distinct
from this guide): pages are `.qmd`, enumerated by `docs/_quarto.yml`'s sidebar; preview with
`quarto preview docs`. Conventions (gated by `verify-docs.ts`, pure tier): user-facing register
(the index.qmd voice — plain language, UI things called by their UI names, no internal jargon);
per-page frontmatter is `title` + `subtitle` ONLY (toc/numbering/theme are centralized in
`_quarto.yml`); real relative links between pages; shortcuts **bold**, written Ctrl-style with
the one macOS ⌘ note in index.qmd; per-page Troubleshooting sections; and **never restate
gated reference content** — the CLI verb tables live in `resources/flux-context/CLI-REFERENCE.md`
(registry-parity-gated), so user docs link there instead of copying. A new page = the file +
a sidebar entry in `_quarto.yml` (the gate fails on orphans, broken links, frontmatter drift,
or a render glob that could pull this guide into the site). **A user-visible behavior change
updates the affected docs page in the same session** — the same discipline as gates.

**Write a runbook for an agent, not a page** (`docs/for_agents/`, `.md` only, never rendered):
procedures addressed to an agent acting on a user's behalf — machine setup, sudo prompts,
failure forensics — belong there, not in the site. Two independent guards, both gated: the
render globs are `.qmd`-only, and `_quarto.yml` names `!for_agents/**` outright. Register it in
`docs/for_agents/README.md` (the gate requires that index and checks its links resolve). The
register is different from the user docs on purpose — exhaustive, verify-after-every-step, and
free to name the failure modes plainly. Facts in
the mode guides were swept from source (chords from `keyboard.ts`/`commands.ts` etc.); when a
chord or label changes, grep `docs/` for the old one.

## 9. Known traps (each of these cost real time)

**Svelte 5 legacy syntax:**

- A `$:` block that reads **and** reassigns the same `let` is self-dependent — it re-runs until
  the loop guard. Memoize in a **non-reactive `const` box** (`const memo = {v: null}`) instead.
- `$: name = …` silently **assigns to an existing `let name`** in scope — it does not create a new
  binding. (This collided with a pan-quantizer variable and cost a 4× regression.)
- Key memos on object **identity** (e.g. a rect object), not its fields — field-keying re-runs
  per frame under pan.

**Derived model fields (figure families):** since 2026-08-04 a figure's `name` is DERIVED from
family identity — every load runs `applyFamilyNumbers`, which rewrites `name` from
`{family, number}` (an unparseable external rename survives only as the `nickname`). Two
corollaries: an agent renaming a figure must set family/number/nickname, not `name`; and a
gate must never probe "did the external edit land?" through `name` — the name-based probe in
verify-w10-matrix silently broke the day families shipped and sat red in ui-extra for ten
days (probe geometry like `width` instead).

**Measurement:**

- Dev-mode Svelte tracing (`get_stack`) costs ~2 frames/commit at 1600 elements and is **absent in
  production**. Never chase dev-only overhead; the gates use ratio-to-control + structural budgets
  for exactly this reason. `window.__flux` is DEV-only, so headless gates can only drive dev
  builds — production numbers need a different harness (nobody has built one yet).
- **Load contention fakes regressions.** A scale gate read 4.49× under load-57 (parallel agents)
  and 3.32× quiet. Check `uptime` before believing a perf failure; kill orphaned tsx children
  (delegated agents leak them: `pgrep -f "tsx/dist/preflight"`).
- This desktop's real Chrome/Electron reports `prefers-reduced-motion: reduce` (GTK-derived);
  headless Chrome doesn't. Never gate ambient/feature motion on that query.

**Environment:**

- The dev machine is the owner's Linux desktop with monitors and an active Wayland session —
  do NOT assume it is headless (an earlier "no monitor" note here was wrong; corrected
  2026-07-12). Agent shells, however, often run detached (ssh/tmux), and the Wayland compositor
  has died mid-session at least once, leaving Electron **hung before executing any JS** — silence
  looks like success. Automated Electron harnesses therefore pass `--ozone-platform=x11` **as a
  real command-line argument** — from a detached shell native Wayland can also hang Electron
  *after* JS starts but before `app.whenReady` ever resolves, and an `appendSwitch` inside the
  script is parsed too late to save it (2026-08-11) — and demand **positive** boot evidence
  (e.g. a probe printing `windows=1 title=Flux`), never absence-of-errors.
- **On Wayland a client cannot set its own window icon** — no protocol exists for it, so
  `BrowserWindow.icon` is silently ignored (on X11 the same option works, via `_NET_WM_ICON`).
  The compositor instead matches the surface's `app_id` to an installed `.desktop` file and takes
  the icon from there, so an unpackaged `electron .` matches nothing and GNOME draws its generic
  `application-x-executable` cog. Packaged builds ship an entry (electron-builder, `linux.icon`);
  dev runs need `npm run install:desktop-entry`. macOS ignores `BrowserWindow.icon` on any
  backend — the Dock takes `app.dock.setIcon()` or the bundle's `.icns`.
- Delegated worktree agents fork from the **default branch**, not your branch. Give them an
  explicit `git reset --hard <sha>` as step one, and expect to reconcile your in-flight deltas
  when merging their result.
- pdf.js text layers hide during CSS-zoom (span boxes collapse to 0,0 *stably*) — waits need a
  nonzero two-poll-stable box, not a single poll. `TextQuoteSelector`'s field is `quote`, not
  `exact` — a wrong anchor field silently orphans annotations.

**A temp project root does NOT sandbox a FluxLib write** (found 2026-08-10, cost: 13 junk entries
in the owner's real 1669-entry library):

- Reference verbs write to **two** places — the project's cited subset *and* the machine-global
  FluxLib. Scaffolding a throwaway project sandboxes only the first, so
  `addReference(TMP, bibtex)` looked hermetic while filing its fixture into
  `~/FluxConfig/FluxLib/library.bib` on every run. It sat in the `pure` tier for months; the
  fixture was DOI-less, so dedupe could never collapse the copies and each run minted a fresh
  re-keyed entry (`smith2020`, `anonStudy2020`, `anonStudy2020a…k`).
- **A `libPath` option on the outer function is not proof it reaches the inner write.**
  `importReferences` threaded `libPath` to its PDF/fulltext writes and dropped it on the bib
  write — a sandboxed import that split across two libraries. When adding a `libPath` seam,
  grep every `addToFluxLib`/`materializeIntoProject` call in the function body.
- The tell is cheap and worth running after touching any reference code:
  `md5sum ~/FluxConfig/FluxLib/library.bib` before and after the pure tier — it must not change.
  Note the assertion has to be "no ENTRY landed in the global library", not "no `FluxConfig`
  folder appeared": `scaffold` legitimately machine-inits an empty skeleton via `ensureFluxConfig`.
- A gate that only *prints* a boolean has no teeth. `verify-f1-core.ts` reports by exit code, so
  the containment check must `throw`. Prove any new gate fails by reverting the fix under it.

**Identifying a PDF from its own bytes** (`pdfIdentify.ts`; the 2026-08-06 inbox backlog):

- **A PDF's `/Title` is production junk more often than it is a title.** Real values seen in one
  22-file batch: `PII: 0013-4694(81)90225-X` (11×), `SLEEP.30.12.1631.indd`, `NSS_A_330939
  217..230`, `ns030000899p`, `CRMETH101179_mmc2 1..1`. Never treat that slot as authoritative
  prose. `looksLikeTitle` screens it and the font-size `titleGuess` behind it is usually correct
  — so any "pick the first non-empty title field" rule is a bug waiting to happen; fall through.
- **An Elsevier PII *is* the DOI**: `10.1016/` + the PII verbatim, both eras
  (`0013-4694(81)90225-X`, `S0166-2236(98)01349-6`). Taken from the metadata slot only — a PII in
  page text could be a reference (the masthead lesson) — it is publisher-set and therefore
  authoritative, which matters because such scans often start mid-way through the previous
  article, leaving no page-1 title to cross-check against.
- **A paper ABOUT a work scores 1.00 against that work.** A 24-page 1861 *review of* Virchow's
  *Cellular Pathology* quotes the book's title verbatim in its header and names its author on
  page 1; every title metric maxes out. The ONLY thing separating "is this work" from "is about
  this work" is the year/author corroboration — which is why Tier 2 judges the **first usable
  (DOI-bearing) hit and stops**. Skipping past DOI-*less* records is fine (registries return the
  same paper twice, DOI on the second copy); continuing past a hit that FAILED corroboration is
  not — that is shopping the ranked list for one that agrees, and it files a review as the book.
- Search-index reach, not the gate, is now the binding constraint on the rest: a scrambled
  two-column OCR title guess and a paper OpenAlex ranks poorly for its own exact title both stay
  unresolved, correctly.
- `quarto install tinytex` installs to `~/Library/TinyTeX` (macOS) / `~/.TinyTeX` (Linux) and
  **never touches PATH**, so `tlmgr` and `kpsewhich` are command-not-found on a perfectly good
  install. Flux and Quarto are unaffected — they resolve TinyTeX internally — which is exactly
  what makes it confusing: PDF export works while the docs' own verification commands fail.
  Any installer must call `tlmgr` by absolute path (`~/Library/TinyTeX/bin/universal-darwin/`),
  because a fresh machine has no shell config to inherit from yet.

**World-space DOM (anything mounted inside the canvas):**

- Overlays like the caption editor ride `transform: scale($viewport.zoom)`. **Never measure them
  with `getBoundingClientRect`** — it is transform-scaled, so any value you write back is wrong
  at zoom ≠ 1. `scrollHeight`/`clientHeight`/`offsetTop`/`offsetHeight` are pre-transform layout
  px: measure and write in those and the result is zoom-invariant for free.
- `Canvas.svelte onWheel` calls `preventDefault()` unconditionally, so **no scroll container
  mounted inside the canvas can scroll natively.** A scrollable overlay needs an explicit branch
  there: divide `deltaY` by `viewport.zoom` (the container is inside the scale transform) and
  fall through to the canvas pan once the container hits either end, so chaining reads as one
  gesture. The same applies to hit-testing — `pointer-events` is off on overlay layers by
  default, and a wheel/click target has to opt back in.
- An element that auto-sizes to its content must take **font size as an explicit input**. A
  font-size change resizes no box, so neither an `input` event nor a `ResizeObserver` fires and
  the content silently overflows a frozen height. (Reusable action: `src/lib/ui/autogrow.ts`.)

**Bundle/startup:** a static import from any eager shell module (`Shell.svelte`, stores,
`src/lib/references/*` used by Shell) into `src/shell/modes/**` drags an entire mode chunk into
Home. Dynamic-import at the call site; `verify-startup.mjs` (800KB eager budget, no mode chunks
at Home) is the gate. Mode warms belong in `requestIdleCallback`. Also: `npm run check` covers
`src/**` ONLY — `flux-core/**` and `scripts/**` are outside the type-checker, so a name missing
from `flux-core/index.ts`'s explicit re-export lists is silently `undefined` at runtime with no
static signal except esbuild's `import-is-undefined` warning during `npm run build`. Treat that
warning as an error (it shipped a dead `cascade-tracks` verb); registry-parity §(e) now pins
every `core.<name>` reference in verbs.ts against the real index surface.

**SVG rendering & the slide player (the anim_test lessons, 2026-07-18):**

- An inline-level `<svg>` sits on the host line box's **text baseline** — small-height svgs get
  pushed down by a host-font-dependent ~12px, so content drifts inside its wrapper and clips
  against `clip-path`. Content svgs must be `display:block` (fillStatic/fillPlot do this), and
  wipe clips grow non-animating edges (`inset(-20% …)`) because clip-path clips border-box
  overflow (descenders, stroke halves, antialiasing).
- Chromium's `getTotalLength()` **undershoots the painted perimeter** on `<ellipse>` (~0.6%) —
  a dash window sized exactly to it leaves a visible sliver in drawOn's "hidden" state. Always
  overshoot: `drawGap(len) = len + max(4, len·5%)` (presets.ts). linkedom has no
  `getTotalLength` at all (lengths fall back to 1) — pure-tier gates can only check the
  formula; the real overshoot is pinned browser-side (verify-slide-export-transform).
- A **zero-length dash still paints its linecaps** — `stroke-dasharray: 0 G` with round/square
  caps renders a DOT at the path start. Hide strokes with the offset form
  (`dasharray: G; dashoffset: G`), which never paints caps; the trim engine instead forces
  `stroke-linecap: butt` in its keyframes when the geometry declares a cap. Filled shapes
  (arrowhead polygons) can't be dash-hidden at all — hide them with opacity, end-timed.
- `compensatePtTrue` and `applyOverrides`' dx/dy are **one-shot writes** (prepend transforms,
  multiply stroke styles) — any code path that re-runs them per frame COMPOUNDS (glyphs shrink
  a notch per beat nav, explode to a gray wall during playback). The contract: capture pristine
  per-field records first (WeakMap in compensate.ts), and every seek runs
  `restorePtTrue → viewBox/crop → applyOverrides → compensatePtTrue` — exactly a fresh mount,
  idempotent at any t (transform.ts).
- **Never animate the wrapper's layout box** (left/top/width/height): the svg child's painted
  origin pixel-snaps to whole STAGE px — sub-pixel writes paint nothing, then jump a full px at
  the 0.5 crossing (ladder-measured: `0 0 0 0 3 0…` device px at fit-scale 3). Present + export
  scale the stage with a CSS fit transform, so every snap is a multi-device-pixel jump — the
  "jitter" at slow ease tails. Frame timing can be perfect (zero drops) and it still stutters:
  it's paint quantization, not jank. Mid-flight morph frames therefore FREEZE layout at the t1
  box and ride a compositor transform (translate+scale, rotation/flips conjugated about the
  current centre, origin 0 0 — `applyWrapperBoxComposite`); endpoints restore classic layout.
  Equivalence holds because content svgs are `100%`+`preserveAspectRatio:none`: stretching the
  frozen box by (w/w0, h/h0) IS the viewBox→box mapping. Gates read effective x = frozen left
  - translate-x.
- **Inline SVG copies + `url(#id)` are document-global.** Chromium resolves `url(#clipPath-id)`
  to the FIRST matching id anywhere in the document, and composes clip geometry from RENDERED
  children only — a duplicate-id copy inside a `visibility:hidden` subtree (ModeContent
  keep-alive) makes the winning clipPath EMPTY, so the VISIBLE copy's clipped data marks paint
  nothing while its unclipped axes/text survive (the 2026-08-13 blank-plots regression: paper's
  new inline embeds shared the figure editor's element-id prefix). Any DOM-mounted plot render
  must namespace its ids away from the editor's element prefixes (`PAPER_SVG_NS`,
  scholar/figures.ts — the DISK render for fig/renders stays un-namespaced for flux-core byte
  parity), and ModeContent carries a hidden-clipPath guard rule as the second layer. Gate:
  `verify-clip-collision.mjs` (also pins the raw Chromium behavior so a future fix is visible).

## 10. Current state & deliberate deferrals (don't "fix" these)

- **WS-11 plot render-detail budget** and the **figure spatial index**: evaluated against
  measurements and NOT built (triggers recorded 2026-07-11; blueprints live in
  `notes/flux_fortify_plan_claude.md`). Revisit only if their trigger conditions fire.
- **Deterministic cross-engine text layout engine**: deferred, owner sign-off required.
  `needsLayout` is the shipped interim.
- **CI ui-gate flip**: `.github/workflows/ci.yml` has one marked `continue-on-error` line to
  delete after 5 consecutive green main runs. Do not flip early.
- **Electron `project` IPC family** (watch/locks/prefs/config) is the one family still in
  `main.cjs` — mechanical follow-up, pattern established.
- **Presence→behavioral test conversions** for `verify-p4-*`/`verify-p5-library`: convert as
  those areas are touched (policy, not backlog).
- Known un-gated perf cliffs (acceptable today): giant single-paragraph docs (~180ms/keystroke —
  lezer re-parses the paragraph), dense-canvas *initial* mount (160 plots → one ~90ms task).
- The proxy-capture engine is owner-tuned and out of scope for refactors; its behavior contract is
  `verify-proxy-capture.cjs` + `verify-netget.cjs`.
- **Slide deferrals (slide-migration, owner-scoped §8):** rich text boxes /
  bullets and math are OUT — slide text is the figure `text` element; KaTeX
  left the deck export bundle entirely. **Video** returns later as a
  purpose-built slide-only element (commented seams in `slide/types.ts` +
  `player/render.ts`; the player's media plumbing was kept). Live-linked
  embedded figures (the old `embedFigure`) were removed — design fresh if
  wanted. Theme fonts bind at layout-starter creation (no live restyle). A
  fluxplot "presentation" render style (bigger labels for projection) is a
  fluxplot-side follow-up. Do not rebuild any of these casually.
- **Animation-rework deferrals (2026-07-17):** the S/A/M tri-state TREE is
  GONE from the GUI (everything is visible by default; the X-ray's `x` hide
  is the one static-hiding mechanism) — `setPartVisibility` remains as the
  headless/back-compat op + verb only; don't resurrect a GUI tri-state.
  Cross-type transforms (rect→text) and per-part transform tracks are
  deliberately out of v1 (part styling changes ride the plot transform's
  `overrides` diff). Character-level text morph is the flagged Phase-8
  enhancement, not merge-blocking; text rewrites crossfade (numeric diffs
  digit-tween).
- **Lazy-residency deferrals (2026-07-21):** slide-mode lazy asset loading (plan Phase 2 —
  `resolveDeckAssets` stays eager; the player/morph/thumbnail consumers have no mount-driven
  reload path, and scale-slide is green at 31 plot slides) and lazy `assetData` bytes (Phase 4
  stretch — the remaining ~89 MB linear byte cost @12 dense figures, incl. paper-mode
  `readFigSource`'s analogous all-assets base64) are deliberately NOT built. Revisit when a
  real deck or the paper side actually hits the ceiling; the design lives in
  `notes/lazy_figure_asset_loading_plan.md` §5.7. The per-plot complexity budget + warning
  (single pathological plot, node-explosion memory) also remains open — `plotResidency` is an
  AGGREGATE budget, not a per-plot guard.
- `notes/` is **gitignored** (owner's working notes + plan ledgers live there, on-disk only).
  Committed docs belong in `docs/`.

## 11. Session log (append-only; newest last — see maintenance rules at top)

### 2026-07-10/11 — Fortify hardening engagement (Claude Fable 5, `fortify` → merged to `main`)

**Work:** Executed the full 12-workstream fortify plan (~53 commits): perf (figure/paper/library/
reader/fulltext/startup), data integrity (load gates, version guards, crash-safe fig saves,
divergence detection, undo byte-budget), consolidation (one fig-persistence core, flux-core
decomposed to 10 modules, one verb registry for CLI+MCP, one interaction/frontmatter/present
core), platform (CSP, SSRF hop validation, fsGuard deny-by-default, IPC contract + family split),
and the verification system itself (tiers, scale gates, sleep→condition conversion, clean-console
contract). All gates green; ledger in `notes/flux_fortify_plan_claude.md` §12.
**Learnings:** promoted into the body of this guide (§2 twin-engine table, §5 hard rules, §9
traps, §10 deferrals) — notably: the Svelte `$:` self-dependence/shadowing traps, dev-tracing and
load-contention measurement traps, the compositor/`--ozone-platform=x11` gotcha, positive-evidence
boot checks, worktree agents forking from the default branch, and "the scan's tie order is
nondeterministic — canonicalize before oracle-comparing".

### 2026-07-12 — Nielsen responsiveness budgets adopted as policy (Claude Fable 5, `main`)

**Work:** Deep-dived Obsidian's performance architecture (metadata cache in IndexedDB, deferred
views, CM6 viewport rendering, no-framework UI, absolute-ms culture) and mapped Flux's scale-gate
numbers onto the Nielsen 0.1s/1s/10s framework. Owner adopted the framework as standing policy —
promoted into the body as new §6 (sections renumbered; old §6–10 are now §7–11).
**Learnings:**

- Obsidian on Electron is the existence proof that our stack can hit sub-100ms everywhere at
  20k-file scale; the techniques are ones Flux mostly already uses (derived mtime-keyed caches,
  windowing, viewport rendering, deferral).
- Don't hide slow operations behind debounces — measure the operation; if it's fast, the delay
  itself is the latency bug (library search: 150ms debounce over a ~25ms scan).

### 2026-07-12 — Editing-feel lock rescinded (Claude Fable 5, `main`)

**Work:** The owner rescinded the July-2026 "editing feel is LOCKED" policy: EDITING-FEEL.md
deleted, lock language removed from CLAUDE.md / AGENTS.md / this guide / source and script
comments. The Nielsen budgets (§6) are the standing policy in its place; the `paper-gate` scripts
remain as ordinary regression gates.
**Learnings:**

- Any "LOCKED editing feel" reference in old commits, branches, or agent memories is obsolete —
  responsiveness (§6) is the contract, and paper-editor behavior is changeable like any other
  gated area (intentional changes update the gates with evidence, per hard rule 3).
- The technical invariants behind the old lock were kept (as §4 architecture notes) because they
  are load-bearing for instantaneous editing — they were never aesthetic preferences.
- Corrected a false environment claim in §9: the dev machine is NOT headless (owner's desktop,
  monitors attached, active Wayland seat). Verify environment claims against `loginctl`/`who`
  before repeating them — an agent shell without a display is not evidence the machine lacks one.

### 2026-07-12 — Shape completeness: None swatch + Closed-path toggle (Claude Fable 5, `main`)

**Work:** Added the Colors panel "None" swatch (fill/stroke → literal `"none"`, with foot-gun
guards: text colour never blanked, lines skip fill-target none, drawStyle.textColor never
poisoned) and an Inspector "Closed path" checkbox (via `ops.updatePath` — adopts legacy d-only
paths, regenerates `d`, refits bbox). New ui gate `verify-shape-nofill.mjs`; extended
`figenh-01-path.ts`.
**Learnings:**

- `window.__flux` dev handle: svelte's `get` lives at the ROOT (`__flux.get`), store modules
  (`__flux.fig`) expose only their own exports.
- The element renderer already draws open paths with `fill="none"` regardless of the model fill
  (chord-fill masquerade guard) — model fill survives a close→reopen round trip by design.

### 2026-07-12 — Pen placement assist (Claude Fable 5, `main`)

**Work:** Pen tool gained a placement-assist core (`src/lib/interact/penSnap.ts`, pure): widened
zoom-corrected close radius (8→14 screen px) with a ring + hot-anchor indicator, Shift 0/45/90°
constraint (line-tool parity), h/v alignment snapping to draft nodes AND edge midpoints, and
equal-edge-length snapping (free / axis-pinned / along-ray) with geometry-notation tick marks —
perfect squares and 45-45-90 triangles from sloppy clicks. Gates: `verify-pen-snap.ts` (pure),
`figenh-01-pen.ts` extended with an end-to-end shift-square.
**Learnings:**

- Overlay-svg chrome must be `pointer-events: none` unless it has its OWN handler: figure-level
  interactions (pen placement/close) run in the SCENE svg's handlers, and overlay elements that
  capture the pointer silently swallow clicks. The pen's close-click was finicky for exactly this
  reason — the first anchor's `pointer-events: all` ate direct hits, leaving only a 3px annulus.
- One snap function must feed BOTH pointermove (preview) and pointerdown (placement) — computing
  assists in only one path makes the click land somewhere the preview never showed.

### 2026-07-12 — Primitive completeness (dash, path arrows, bend, presets) (Claude Fable 5, `main`)

**Work:** Owner-mandated completeness pass on the four primitives: `dash` on all four (model →
schema → both renderers → set_style `--dash`), arrowheads on open paths (pure `pathRender`:
tangent heads from the shared arrowTri/arrowVee + arc-length body trim), TRUE-curve path bboxes
(cubic extrema, not control hull), Figma hover (paths/lines trace their geometry; wide invisible
hit strokes), ctrl+drag segment BEND in node-edit (pure `bendSegment`, weight-distributed handle
deltas), FluxFig-menu none/dash fields, and the machine-global design-preset library
(`<FluxConfig>/presets/designs/**.json`, presets:* IPC, memBridge localStorage fallback, Ctrl+P
grid picker with elementToSvg thumbnails). Presets extended to GROUPS of primitives + text:
elements stored verbatim with their group-def subtree (clipboard-copy semantics), inserted via
cloneGroupsFor with fresh ids, loose sets wrapped by ops.group so a multi-element preset always
lands as one ungroupable unit. Gates: verify-primitives.ts (pure), verify-primitives-gui.mjs
(ui), figenh/parity/canary suites green.
**Learnings:**

- A degenerate cubic with controls AT the endpoints is NOT linear in t (parameterization bunches)
  — straight segments must special-case point/tangent evaluation. The pure gate caught this.
- Machine-global user libraries have an established 4-layer pattern to copy (textstyles →
  presets): contract channels + dumb main-process file store, preload pair, FileBridge optional
  methods, memBridge localStorage fallback (headless gates), devHandle exposure.
- Export parity check pays off: line elements were silently dropping `opacity` in export while
  the canvas honored it — found by reading both renderers side by side, not by a report.

### 2026-07-13 — Slide migration: slides are figures (Claude Fable 5, `slide_migration`)

**Work:** Executed notes/slide_migration_plan.md end-to-end: a slide IS a figure
(deck 0.2.0; `SlideElement`/textBox/math/video/embedFigure/DeckAsset deleted, clean
break, no migration), the Slide module now mounts the figure editor verbatim
(Canvas `frame` prop, Inspector/Toolbar `flux-editor-mode` context) over a pure
deck⇄Project projection (`deckProject.ts`, identity round-trip gated), with a thin
presentation layer (filmstrip w/ figureRev-keyed thumbnails, on-demand animator
dock, present, offline export), ONE unified undo via the store's new history
companion, store tenancy + mutual mode eviction (the #1 risk — gated end to end),
the slide asset sink (`slides/<id>/assets/`), Send-to-deck/Send-to-canvas over one
clone core, and the full batch-E headless disposition (add_slide_figure = copy
semantics; add_slide_math deleted; goldens regenerated deliberately). Old slide
gate suite dispositioned per plan §7.0 (rewritten/deleted-with-re-homing, table in
the disposition commit); new gates: roundtrip, deck-schema, figure-separation,
headless-e2e, 6 GUI gates, scale-slide. Net −2.3k lines.
**Learnings:**

- Svelte 5 runes dedupe store values by reference: `store.set(sameObj)` after an
  in-place mutation silently skips `$store` consumers in runes components —
  always publish a fresh identity. (Legacy `$:` components were immune;
  the filmstrip went stale for exactly this reason.)
- The compose→pure-op→decompose pattern (`commitDeckLive`) is a cheap way to give
  a GUI real twin-engine parity: the GUI literally executes the flux-core
  mutation function per structural edit, so drift is impossible by construction.
- `elementToSvg` (the figure export serializer) doubling as the slide
  present/export renderer bought dash/arrowhead/wrap/crop parity for free —
  reuse the serializer, never re-approximate rendering.
- A history "companion" (opaque capture/restore snapshot riding each history
  entry) unifies two stores under one undo stack with ~30 lines and zero cost
  when unregistered — beats focus-routed twin stacks.

### 2026-07-13/14 — Slide showcase deck + two morph/export bug fixes (Claude Fable 5, `main` working tree)

**Work:** Built an end-to-end demo of the slide pillar — a 10-slide flux-midnight
talk ("The Edge of Chaos", ~/edge-of-chaos) driven entirely through the headless
verb layer from fluxplot-generated semantic plots (Fourier synthesis, Moore's
law, logistic bifurcation, Monte-Carlo π, iris allometry, pendulum phase
portrait, Lorenz attractor). Exercised every animation family (drawOn, stagger
by-x, growBaseline, countUp, camera zoom, highlight/dim, part-style, S/A/M
part-visibility, all four exits, writeOn, with-prev/auto beats) and verified each
slide/beat by booting the exported HTML headless and screenshotting. Two genuine
shipped bugs surfaced and fixed (regression-gated in `verify-slide-morph`):

- **Morph line froze at state A.** fluxplot emits a series line as
  `<g id="…series.line"><path/></g>` (a group, esp. with markers); `createMorph`
  set `d` on the `<g>` — a silent no-op. Fix: descend to the child `<path>` when
  the matched node isn't itself a path (`src/lib/slide/player/morph.ts`).
- **Export dropped part animations for externally-imported plots.** A plot
  imported from a dir OUTSIDE the project stores `source.manifestPath` as a
  root-escaping `../…` relative path; `gatherDeckPayload.collectPlot` committed to
  that single path, failed `safeJoin`, and DERIVED an empty-series manifest →
  `morphCompatible` false and every part id unresolvable, so drawOn/stagger/morph
  silently no-op'd offline. Fix: try `[manifestPath, entry.manifestPath,
  sibling-of-resolved-svg]` in order and take the first that READS — the
  `fig/assets/<id>.fluxplot.json` byte copy is the real manifest
  (`flux-core/slides.ts`).
**Learnings:**
- The data-space `morph` preset is fragile for real matplotlib output beyond a
  same-range point/line tween: the linear↔log axis-fit blend goes numerically
  unstable for large data ranges (Moore's 2.3k→4e10 projected to ~−1e6 px,
  off-canvas), and scatter `PathCollection` markers don't respond to the
  transform-based point move. Prefer a two-plot crossfade (fadeOut + fade/drawOn)
  for a linear→log reveal — correct axes on both sides, and it can't mis-tween.
  A morph is only reliable between structurally-identical, same-scale plots.
- Verifying slide animations headless needs `page.emulateMediaFeatures([{name:
  "prefers-reduced-motion", value:"no-preference"}])` — headless Chrome defaults
  to `reduce`, which snaps every WAAPI/rAF anim (and morph/countUp seek) straight
  to its end state, so partials look "instantly complete". `fluxDeck.goTo` is
  anim-off by design; drive real playback with a keypress to see motion.
- Camera targets are stage-space; compute a data feature's stage pixel from the
  manifest `axes[0].{x,y}.anchors` (data→svg-pt) × the pt→px factor (4/3) + the
  element origin — guessing lands on the plot's empty margins. Keep the focus in
  bounds for the zoom (`cx ∈ [W/2Z, W−W/2Z]`) or the frame shows past-edge void.
  Sparse plots (a square wave is mostly flat band + thin jumps) resist meaningful
  zoom; showcase camera on dense plots (bifurcation cloud, Lorenz) instead.
- `core.addSlide` hard-codes `starters:true`, so every non-`blank`/`full-bleed`
  layout seeds placeholder "Title/Subtitle" figure-text under your content — use
  `blank` when authoring every element yourself. `add_slide_text` has no
  fontFamily knob; set `el.fontFamily` on the deck.json text elements directly to
  match a serif plot set.

### 2026-07-14 — Two more morph fixes: markerless lines + drawOn dash residue (Claude Fable 5, `main` working tree)

Extended the Edge-of-Chaos showcase with two morph-flagship slides (pitchfork
potential x²/2 → x⁴/2 − x²; Van der Pol limit cycle μ=0.15 → μ=3, one period
from the same Poincaré section, arc-length-resampled to 401 index-matched
vertices) and found + fixed two more shipped bugs in the process — both in the
same-axis, same-structure regime the morph is *supposed* to own:

- **Markerless line series silently didn't morph.** A plain `fp.line` (no
  markers) emits every vertex under `series.data.{x,y}` but no `points[]`;
  `morphCompatible` counted `svg.line` as tweenable, yet `morphSeriesPixels`
  consumed only `points` — so the pair passed the gate and the line froze at A
  (`px.length` 0 skipped the `d` rewrite). Only marker-carrying lines (Moore)
  ever morphed. Fix: `tweenVertices()` in `player/morph.ts` — explicit `points`
  when present, else vertices synthesized from `series.data`. Positional
  behavior for marker series is byte-identical (points take precedence).
- **A prior drawOn truncated the tail of a longer morphed path.** drawOn preps
  `stroke-dasharray = len(original path)`; `applyStatic` runs `prep()` before
  morph seeks, and live playback leaves the dash inline after the enter beat.
  When the morph rewrites `d` into a LONGER path, everything past the old
  window is invisible (the VdP relaxation loop wouldn't close; the double well
  lost its right arm). Fix: `seek(t>0)` clears `stroke-dasharray/-offset` on
  the line it rewrites — the morph owns the geometry from there. `seek(0)`
  leaves the dash intact: drawOn's pre-beat hidden state (`dashoffset=len`)
  needs it, and at t=0 the rebuild matches A's length anyway.

Both regression-gated in `scripts/verify-slide-morph.ts` (data-only-series
morph; dash cleared at t>0, preserved at t=0 — linkedom note: a removed style
property reads back `undefined`, not the browser's `""`). All 22 pure slide
gates PASS; svelte-check 0/0; `gen-export-assets` re-run (morph.ts is baked
into the export runtime — REMEMBER this after any player edit). Full-deck
sweep: 12 slides / 38 beat states, 0 page errors.

**Learning:** the morph's reliable home turf is *exactly* the case the earlier
fragility note pushed toward — same axes, shared series id, index-matched
vertex counts — and that regime is now genuinely solid for smooth curves (the
natural morph content), not just marker plots. Authoring recipe for a clean
closed-curve morph: start both cycles at the same Poincaré section, keep the
same orientation, and resample both by arc length to the same vertex count.

### 2026-07-14 (later) — "no morph in the app": GUI morph-target resolution + the stray scaffold deck (Claude Fable 5, `main` working tree)

Owner reported the new morph slides showed no morph. The exported talk.html was
verified fine (keypress AND mouse-click advance, both reduced-motion settings)
— the failure was the APP path, and it was two independent problems stacked:

- **The app opened a stray deck.** `scaffold()` seeds a default deck; the
  showcase build authored everything into deck `talk` and deleted `talk`'s
  stock *slides* but left the scaffold-seeded *deck* registered first in
  project.json — and the app opens the first registered deck. The owner was
  presenting a one-slide "Title/Subtitle" placeholder, not the talk at all.
  There is no core deleteDeck verb yet; the build script now prunes non-talk
  decks from `project.json` + `slides/` directly.
- **GUI morph-target resolution missed figure-derived plots.** A morph target
  lives only in the track's `to` (never as an element). flux-core `setMorph`
  persisted `svgPath`/`manifestPath` only from the project manifest's plots
  index (absent in this project) → bare `{assetId}`; `slideBridge.loadDeckAssets`'
  2b loop then guessed only `plots/<id>.svg` — but figure-imported plots live
  at `fig/assets/<id>.svg` → manifest never cached → `computeSlideAnims`
  requires `A && B && morphCompatible` → the morph SILENTLY held at A in
  preview/present while the export (whose collectPlot has the full candidate
  chain) worked. Fixed on both sides: `setMorph` now probes
  `plots/<id>.svg` → `fig/assets/<id>.svg` and persists what exists (gated in
  verify-slide-headless-e2e: authored deck.json must carry the fig-derived
  paths); the bridge 2b loop mirrors collectPlot's candidate order (authored
  path → plots/ → fig/assets/) so even bare-assetId decks resolve.

Verified in the REAL app (electron + CDP over the dev server, present mode,
keypress-driven): both showcase morphs play live, mid-flight ≠ endpoints; the
export re-verified after rebuild. Testing traps worth remembering:

- **Scope present-mode DOM probes to `.present .mount`** — the editor's
  filmstrip renders EVERY slide as a thumbnail beneath the overlay, so a
  global `[id$="__part"]` query matches a static thumbnail and reads as
  "frozen animation" (and as "slide reached" when you never left slide 1).
- An in-app anomaly is not necessarily the player: check WHICH deck loaded
  (`__flux.get(__flux.slide.deckOverlay)`) before debugging animation code.
- `plotManifests` can be inspected live via
  `window.__flux.get((await import("/src/lib/plot/store.ts")).plotManifests)`.

### 2026-07-15 — Paper snips: reader capture + citation linkage (Claude Fable 5, `paper-snips`)

**Work:** New feature end-to-end on a branch. Ctrl+Alt+drag in the reader captures a
PDF page region as a PNG "snip" into `<project>/plots/paper_snips/` (parallel to the
existing Alt+drag figure pop-out); a naming popover confirms/renames (Enter keeps).
Provenance (citekey/page/rect/citation) travels **inside the PNG bytes** as a
`flux-snip` tEXt chunk plus a `.snip.json` sidecar, decoded into a runtime `snipMeta`
map at every asset-decode seam, so the FluxFig menu's new "copy citation" action works
on any imported snip in figure AND slide mode. A headless `snip_paper` verb (+ `cite`)
gives agents the same capture (pdf.js legacy + `@napi-rs/canvas`). One shared pure core
`src/lib/references/snips.ts` (+ `journalAbbrev.ts`) owns naming/citation/meta/raster
math for both engines. Gates: `verify-snips` (pure), `verify-snip-headless` (pure),
`verify-snip-gui` (ui), `verify-snip-cite-gui` (ui-extra); pure 129/129, check 0/0,
live CLI exercised against a real FluxLib paper.
**Learnings:**

- **Snip physical-size math:** pdf.js renders at scale *s* → pixels = PDF-points·s;
  physical size = points/72 in ⇒ stamp dpi = 72·s. Snips render at s=4 (288dpi) and the
  existing physical-size-true import (`io.ts buildIncoming` × `readPngDpi`) then places
  them 1:1 with the printed page for free.
- **Provenance in bytes, not the model:** carrying metadata in a PNG tEXt chunk (pure
  byte surgery beside the pHYs helpers in `figure/pngDpi.ts`) + a sidecar, resolved into
  a runtime map, avoided the entire "change the fig/ file format" recipe (figfiles
  whitelists, both schemas, validators regen, parity goldens) — fig/deck saves write
  asset bytes verbatim, so the linkage survives every round-trip structurally, and the
  slide-paste path (no sidecar possible) still works because the bytes self-describe.
- **The reader's project root is `shellStore.currentProject.path`, NOT
  `embeddedProjectRoot`** — the latter is figure-mode-scoped (set/cleared on FigureMode
  mounts, `store.ts:233`), so it's null while you're in the reader.
- tEXt is Latin-1: ASCII-escape (`\uXXXX`) the JSON payload so diacritic author names
  survive the byte round-trip (`JSON.parse` decodes the escapes natively).
- **ESM cycle:** import `VERBS` from `flux-core/registry`, never `./verbs` directly —
  registry's module body iterates `VERBS`, so entering `verbs.ts` first throws
  "Cannot access 'VERBS' before initialization".
- **ui-gate seam:** a snip save must go through `fileBridge()` (not `window.fig`
  directly) so the memBridge demo fixture observes the writes; and an in-page
  `await import()` of a store module can yield a *different* instance than the app's
  after vite HMR — gates hardcode the fixture ROOT (`/demo/myc-growth-paper`) rather
  than subscribing to a re-imported store.

### 2026-07-15 — Figma deep-select for plot parts + Ctrl+Shift+I bring-inside (Claude Fable 5, `main`)

**Work:** Two owner-requested figure-editor changes. (1) Plot part selection is
now Figma deep-select: a PLAIN click/drag anywhere on a plot always selects/
moves the WHOLE plot (killing the accidental grab of a bar/tick while dragging
a selected plot); ctrl/meta-click pierces to the part under the cursor even on
an unselected plot (and to the element itself inside a group); double-click
descends into the part; the already-drilled part stays plain-draggable
(Figma's drag-selected-child); ctrl-hover previews the deep target
(`.part-hover`). (2) Ctrl+Shift+I "bring inside": `ops.bringInside` translates
each selection unit (groups rigid, rotation-aware bboxes, lines by endpoints)
minimally into the figure frame — never resizing; oversized units are placed
to fully cover the frame — with a `bring_inside` CLI/MCP verb, the
import-overflow toast now pointing at the chord, and the DEV Electron menu's
toggleDevTools moved to F12 on Linux/Windows so the app owns ⌃⇧I everywhere
(prod Linux/Windows has no menu). Gates: `verify-bring-inside.ts` (pure),
`verify-bring-inside-gui.mjs` (ui), `figenh-15-partmove.mjs` rewritten for the
new interaction matrix, `verify-vanilla-inline.mjs` click-through updated to
ctrl-click; registry goldens regenerated (86 verbs). Pure 127/127, ui 48/48,
figenh sweep 16/16, scale-figure, W6 electron menu gate all green.
**Learnings:**

- `page.mouse.click(x, y, {clickCount: 2})` never fires dblclick in Chrome —
  a REAL double-click needs two down/up pairs with the second at clickCount 2
  (the citegroup recipe; figenh-15 §9 uses it on the canvas now).
- Pointer capture retargets compatibility dblclicks to the HOST, so any
  dblclick-time hit resolution needs a `document.elementFromPoint(clientX,
  clientY)` fallback — `e.target` is the host, not the scene node
  (`partAtPoint` in Canvas.svelte).

### 2026-07-15 — Lighttable sidecar created (image-set EDA viewer) (Claude Fable 5, `lighttable`)

**Work:** Added `lighttable/`, a standalone Svelte 5 + Vite + Electron app for fast grid viewing
of image sets (contact-sheet EDA: aligned flip-book across variant folders, virtualized grid,
fullscreen compare, webp thumb cache behind a path-validated `ltfile://` protocol). It is a
sidecar, NOT part of Flux: own package.json/deps/build/tests/dev-port(:1440)/docs, zero code
dependency either way, Flexoki tokens copied not imported. Gates live inside the sidecar
(`cd lighttable && npm test` = check + pure + node-integration + ui on :1440; opt-in
`test:electron` real-app smoke with positive boot evidence). Boundary recorded in CLAUDE.md
(new "Sidecars" section), AGENTS.md, root .gitignore, and lighttable/README.md.
**Learnings:**

- The guide and Flux's gates govern Flux only; Lighttable is out of scope for both — edit its
  own README, never fold it into paper-gate/pure/ui or verify-manifest.json.
- Electron ≥ 32 removed `File.path`: any drag-a-folder-to-open flow needs
  `webUtils.getPathForFile` exposed through the preload (applies to Flux too if it ever
  accepts dropped folders).
- `net.fetch(pathToFileURL(...))` in a `protocol.handle` does not reliably set image MIME
  types — SVG in an `<img>` silently renders nothing until the handler wraps the response
  with an explicit `Content-Type`.
- **`@napi-rs/canvas` SEGFAULTS the Electron main process under burst load** (reproduced:
  a fling queuing ~1500 thumbnail generations killed the app; same storm serving originals
  survived — so it's the canvas work, not the protocol). Flux's posture of keeping native
  raster work OUT of main (child-process resvg, CLI-only snips raster) is load-bearing, not
  style. Lighttable's fix: an Electron `utilityProcess` worker (crash-isolated, bounded
  respawn, jobs fall back to serving originals) — the same pattern to reach for if Flux ever
  needs canvas/resvg in the app process. Regression-gated in its `test:electron` burst phase.

### 2026-07-15 (later) — Lighttable owner iteration: aspect-fit grid, sister folders, Compare view (Claude Fable 5, `lighttable`)

**Work:** Three owner-requested changes to the sidecar, all gated in its own suite (ui 63,
node 37, electron 19, pure 32, check 0/0): grid cells now adopt the images' MEASURED aspect
ratio (median of decoded sizes, dampened, collection-global so the flip-book keeps row
heights) with user-adjustable H/V gaps in the ⋯ menu — wide plots no longer waste vertical
space; the collection name is a sister-folder switcher (plain click lists sibling dirs,
Ctrl+click opens the picker); and Ctrl+click / Ctrl+Enter opens a Compare view — one item
across ALL sets at once, tiles packed optimally for the known aspect, set-name captions,
click-through to Detail with Esc stepping back. Sidecar-only work; no Flux files touched.

### 2026-07-17 — Animation rework: transforms + trim + the Animator (Claude Fable 5, `animation_overhaul`)

**Work:** Executed notes/flux_animation_rework/PLAN.md phases 0–7 end to end. Deck 0.3.0
(first minor bump WITH a migration — a pure stamp at normalizeDeck; 0.1.x stays the clean
break). Two animation families: appearances (enriched — full Trim Paths on drawOn/drawOff
with anchor/direction/mode/partial windows; writeOn direction) and TRANSFORMS (an element
tweens into a different version of itself: sparse `to.state` diffs folded across beats,
OKLab colors, arc-length path resampling, digit-tweened numeric text, crossfade fallback
that still moves, plot frame + data-morph in one track). Endpoint checkout: t1/t2 edit with
the WHOLE editor via a model swap, overlay-only diff sync riding the canvas commit's undo
entry, and a fold guard so deck.json can never contain a composed state (gated:
autosave-mid-checkout is byte-clean). New Animator pane (beat chips + one expanded beat +
collapsible track groups + t₁—t₂ transform lanes + properties mini-pane), ⌃⇧A/⌃⇧D/⌃⇧T
chords, S/A/M tree deleted. Machine-global presets + role/type-matched templates (animlib
IPC; axis-swap apply). Headless: set_transform / group_tracks / ungroup_tracks /
apply_anim_template verbs (92 total, goldens regenerated), slides.md rewritten. Acceptance:
pure 134/134, ui 50/50, scale-slide extended (animator edit p95 16.8ms, playback p95
16.7ms = vsync, 0 ambient rAF), Edge-of-Chaos verified in the export (44 states, 0 errors,
both morphs 75+ mid-flight frames) AND the real Electron app (x11 + CDP, positive boot
evidence, deck migrated in memory, morph live in present, owner files byte-untouched).
**Learnings:**

- Svelte 5 `$state` deep-proxies anything assigned into it, and `structuredClone(proxy)`
  throws DataCloneError — `$state.snapshot()` at the boundary before cloning/persisting, and
  `$state.raw` for model objects a component merely HOLDS and hands onward (the Present
  button froze on any transform deck because `presentDeck = $state(...)` proxied the deck
  into `createPlayer`, whose pre-state fold structuredClones elements; the constructor died
  and every key/click hit `if (!player) return`). Reassignment-reactive is usually all a
  handed-off object needs. Regression-locked: verify-transform-gui now PRESENTS a transform
  deck for real (keyboard + click advance, mid-flight frames, chain compose, Esc).
- A `$effect` that syncs store A → store B while also READING B re-fires on B's change and
  clobbers explicit B-writes — guard with a last-synced key and `untrack()` the B read.
- Under a long-lived vite dev server, an in-page dynamic `import("/src/…")` can return a
  DIFFERENT module instance than the app's HMR-timestamped graph (the snips lesson, now
  bitten twice) — drive the app through `window.__flux.*` handles, never re-imports.
- For chained per-node controllers (morph/transform), applyStatic must seek only the LAST
  controller ≤ the current beat (futures never seek): a later transform's t=0 already
  contains the earlier ends and leaks them into beats before they play.
- WAAPI interpolates stroke-dasharray lists numerically only when every keyframe keeps the
  SAME entry count — piecewise-linear dash windows with an exact mid-keyframe at the
  clamp knee stay exact under any easing (offsets live in eased-progress space).
- dash windows hide STROKES only: a filled shape must not "draw on" (its fill would flash
  before the beat) — stroke-rendered shapes trim; filled ones keep the fade fallback.
- `page.evaluate` of a tsx-transpiled closure can reference esbuild's `__name` helper that
  doesn't exist in the page — pass collector snippets as STRINGS.
- linkedom defines `document` but can't measure text: headless guards must probe for a real
  2d canvas (`canMeasureText()`), caching only the positive answer (harnesses inject DOMs
  mid-process).

### 2026-07-18 — Beat-faithful canvas + Present fix follow-ups (Claude Fable 5, `animation_overhaul`)

**Work:** Owner iteration on the animation rework. (1) The canvas is now BEAT-FAITHFUL:
scrubbing beats shows the slide as it exists at that point (transforms ≤ activeBeat compose
into the store display; beat 0 = base), and plain edits route into the governing transform's
t2 — the endpoint checkout generalized into an ambient display reconciler
(`refreshBeatDisplay`), with t₁/t₂ handles as per-element overrides (t₁-on-base = a lit
base-editing override, no longer an exit; Esc keeps the beat view). Gated end to end by the
new `verify-beat-display-gui.mjs` (scrub matrix, routing, fold guard under autosave, live
revert on disable/delete, undo, slide-switch restore, coalescing continuity, thumbnails).
(2) Filmstrip thumbnails painted hardcoded `#000` behind the debounced render/letterbox —
now the slide's own resting background.
**Learnings:**

- Display-swap systems must record their coalescing generation AFTER any reconciler mutate
  (commitDeckLive: refresh BEFORE `coalesceState.gen = editGen.n`), and the reconciler must
  skip no-op writes — otherwise unrelated coalesced typing runs fracture into N undo entries.
- When a store swap makes elements scope-local (per slide/beat), every SCOPE EXIT needs an
  explicit restore under the OLD scope id (selectSlide restores the outgoing slide's bases
  BEFORE switching activeFigureId — a subscription on the new scope can't reach them).
- Part-override edits (X-ray hide etc.) on a displayed plot route into the transform's t2
  like any other edit — static masking of a PART is a beat-0 action; element-level `hidden`
  stays base-only by the NEVER_CAPTURED law.

### 2026-07-18 — Watcher dialog storm: WS-9.4b orphaned identifiers + no-undef gate (Claude Fable 5, `animation_overhaul`)

**Work:** Owner report: adding plots to `plots/` while a project is open popped an endless
"Uncaught Exception: subsystemFor is not defined" dialog per fs event. Root cause: the WS-9.4b
FILES extraction (30492ce) deleted `subsystemFor`/`fluxLibSubsystemFor` from `main.cjs` and made
`underDir` a `createFileCore` closure-local, but left three call sites behind (the project
watcher and quarto:render containment). Restored the two watcher helpers verbatim from git
history, exported `underDir` from fileCore, and added `verify-electron-no-undef.ts`
(pure+presence): the TS checker over `electron/**/*.cjs` failing on TS2304/2552 — the static
signature of a runtime ReferenceError. Verified live: real-Electron probe (boots actual
main.cjs, watchRoot on a throwaway project, 6 SVGs dropped externally) → 0 uncaught, debounced
`fs:changed {subsystem:"plots"}` delivered.
**Learnings:**

- Main-process code has NO execution gate — verify-w10-matrix drives only the renderer half of
  the watch matrix ("verified by inspection" is a trap). Any refactor that moves/deletes a
  main.cjs helper can strand call sites that only explode at runtime, as a per-event modal
  storm. The no-undef gate now catches the whole class; it found a second latent orphan
  (`underDir` in quarto:render — Render-PDF would have crashed main) on its first run.
- Cheap real-main-process probe recipe: an Electron entry script that `require()`s the real
  `electron/main.cjs`, installs a `process.on("uncaughtException")` counter (suppresses the
  dialog), grabs the app window via `BrowserWindow.getAllWindows()`, and drives the real
  preload bridge (`window.fig.beginOpen/watchRoot/onFsChanged`) via `executeJavaScript` —
  needs :1420 + `--ozone-platform=x11 --no-sandbox`, prints positive boot evidence (§9).

### 2026-07-18 (later) — Slide QOL batch: themes, slide presets, layout chords (Claude Fable 5, `animation_overhaul`)

**Work:** Owner's five slide-mode requests. (1) `flux-light` is now PURE WHITE (#ffffff, neutral
surface); the old cream look moved to a new `flux-paper` theme (BUILTIN_THEMES + SLIDE_THEMES +
CLI help literal in `flux-cli.ts` — goldens regenerated). (2) The Slide-panel Background swatch
shows the EFFECTIVE color (override → deck → theme via `slideDefaultBackground`), not a
hardcoded dark. (3) Machine-global slide presets: `<FluxConfig>/presets/slides/**.json` via the
`slidelib:*` IPC trio (contract-declared, memBridge localStorage twin), snapshot = whole slide +
beats + embedded asset bytes/manifests; pure op `slideOps.insertSlideSnapshot` (duplicateSlide's
remap discipline + asset id reuse-or-remap); GUI = `presetLib.ts` + `SlidePresetMenu.svelte`
("+ Preset" in the filmstrip, "Save as preset…" in the Slide panel). Gate:
`verify-slide-presets.ts` (pure, also pins the theme contract + SLIDE_THEMES↔BUILTIN_THEMES
lockstep). (4) Filmstrip width is drag-resizable (gutter OUTSIDE the scrolling aside;
dblclick resets; persists via slideLayout). (5) Ctrl+Shift+B toggles the right rail
(`inspectorHidden` in settings.ts, chord in the shared keyboard.ts) — figure Inspector and the
whole slide rail. Verified: 136 pure, 6/6 slide GUI gates, beat-display, w10, scale-slide, and
a headless five-feature probe with screenshots.
**Learnings:**

- `e.preventDefault()` on `pointerdown` suppresses the browser's DERIVED dblclick — it silently
  killed the dock gutter's double-click-reset (AnimatePanel had shipped that way). Block drag
  text-selection with `document.body.style.userSelect = "none"` for the drag instead.
- The $state-proxy/structuredClone trap again (f59ae44's lesson, new site): `$state<T[]>`
  entries fed into `structuredClone` throw DataCloneError — use `$state.raw` for lists that are
  only ever reassigned.
- `verify-w10-matrix`'s slide leg had been dead since the slide migration: it read the retired
  `slide.deck` store handle (renamed `deckOverlay`), and `F.get(undefined)` made the leg fail
  quietly. When a store is renamed, grep scripts/ for the old handle path.
- Puppeteer: `mouse.click`'s double-click option is `count: 2` — `clickCount` is silently
  ignored there (it belongs to `page.click`), and the "dblclick doesn't work" it fakes is
  indistinguishable from a real app bug until you isolate with a synthetic dispatch.

### 2026-07-18 (evening) — anim_test root causes: baseline, perimeter, caps, idempotency (Claude Fable 5, `animation_overhaul`)

**Work:** Owner filed three animation edge cases as a self-describing deck (`~/anim_test`,
deck_mrpjnqrkw7xh_3) and asked for underlying root causes, not symptom patches. All three
traced to four defects (d034767): (1) writeOn text clipped at the bottom (present-mode) +
arrowheads landing ~12px low = inline-level `<svg>` sitting on the host text baseline →
`display:block` in fillStatic/fillPlot, plus `inset(-20%)` margins on non-animating wipe-clip
edges (clip-path clips border-box overflow). (2) drawOn ellipse showing a sliver/notch while
"hidden" = Chromium `getTotalLength()` undershooting the painted perimeter ~0.6% → `drawGap()`
dash-window overshoot (len + max(4, 5%)). Arrow visible pre-beat = filled polygon head being
dash-hidden (no-op on fills) → stroke/fill split, opacity-hidden end-timed head; a first-cut
`0 G` dasharray fix painted a linecap DOT → reverted to offset-form hiding, trim engine forces
butt caps. (3) pt-true plot thinning per beat nav and exploding to gray during transform
playback = `compensatePtTrue`/`applyOverrides` dx/dy being one-shot but re-run per seek →
pristine WeakMap records + `restorePtTrue()`, and transform seeks now run
restore→viewBox→overrides→compensate (idempotent at any t). Gates: 8-assertion "anim_test
regression pins" section in verify-slide-export-transform (browser-side); player/exits
fixtures made paint-faithful (`stroke`/`fill` attrs — bare paths default to black FILL and
route to the wrong branch). Verified: pure 136/136, 6 slide ui gates, re-exported owner deck
probes (head lands at model position exactly; compensation signature byte-stable over 6 navs
- 4 scrubs), and a real-Electron present-mode acceptance on `~/anim_test` (x11, positive boot
evidence, probes scoped to `.present .mount`, owner deck.json byte-untouched).
**Learnings:** promoted to §9 "SVG rendering & the slide player" — inline-svg baseline,
getTotalLength undershoot → overshoot doctrine, zero-length-dash cap dots, one-shot
compensation → restore-cycle contract. Meta-lesson: gate fixtures must be PAINT-faithful
(explicit stroke/fill), or the gate exercises a different code path than the app.

### 2026-07-18 (night) — Transform glide: composite mid-flight frames (Claude Fable 5, `animation_overhaul`)

**Work:** Owner follow-up: move/resize transforms carried a subtle jitter — "the object should
perfectly glide." Diagnosis was measurement-first: an rAF sampler on the exported anim_test
deck showed PERFECT frame pacing (83 consecutive 16.7ms frames, seek cost p95 0.2ms, zero
drops) — not jank. A painted-edge ladder (0.1-stage-px style.left steps, screenshot each,
sub-pixel edge centroid via in-page canvas decode) revealed the real mechanism: the painted
svg origin quantizes to whole stage px (`0 0 0 0 3 0 0 0 0 0` device px at fit 3× — nothing,
nothing, a 3-device-px JUMP at the rounding boundary). The transform driver animated the
wrapper's LAYOUT box per frame; under the present/export fit-scale every snap amplifies into
a multi-device-pixel stagger, worst at slow ease tails. Fix (`ae64525`): mid-flight frames
(0<t<1) freeze the layout box at t1 and ride a compositor transform — translate + scale with
rotation/flips conjugated about the current box centre, origin 0 0
(`applyWrapperBoxComposite`); endpoints keep classic layout writes (applyWrapperBox restores
the center origin), and skipTransform conflicts fall back to the classic path. Equivalence is
exact because content svgs are 100%+preserveAspectRatio:none. After: ladder reads
0.296–0.303 device px per step (ideal 0.30) — continuous sub-pixel glide; 12 simultaneous
path morphs p95 0.2ms/frame; plot morphs (full restore→overrides→compensate per frame) p95
1.3ms; endpoints byte-identical; real-Electron present acceptance on ~/anim_test green.
Gates updated deliberately (mid-flight readers now compute effective x = frozen left +
translate-x) and extended to PIN the mechanism (frozen layout mid-flight, no composite
residue at rest) in verify-slide-export-transform, verify-slide-tween, verify-transform-gui.
**Learnings:** promoted to §9 — never animate the wrapper layout box; measure paint, not just
timing (a zero-drop animation can still stutter — quantization and pacing are independent
failure axes). The ladder technique (fractional style writes + screenshot + sub-pixel edge
centroid computed in-page via canvas) is the cheap way to see what the compositor actually
paints.

### 2026-07-19 — Principal-agent workflow (Claude Fable 5, `principal-agent`)

**Work:** Implemented the owner's two-folder Context scheme + principal-agent runtime end to
end (notes/agent_scheme/, 5 commits): machine Context layer (UserContext w/ Guidelines
migration; stock FluxContext generated from resources/flux-context/ — the validators.gen
discipline; agents.json roster via shared electron/agentsConfig.cjs), project Context/
(scaffold + open-time heal; MISSION/NOTEBOOK/RULES as first-class commentable paper docs),
shell-owned Ctrl+K palette (moved to src/shell/command/; paper routes via commandBus),
context-stamped feedback ledger (.meta/feedback.ndjson, event-sourced; Ctrl+Shift+M capture;
send = review-pass boundary by ledger ORDER), agent question-threads (add_comment), the
project-wide Agent drawer (Ctrl+Shift+J; PTY of the configured principal; Flux-side
transcript capture from the xterm buffer), and flux agent/agents/dispatch/attend. New gates:
verify-context-scheme/-feedback/-dispatch (pure), verify-context-gui (ui),
verify-principal-electron (electron, real-app chain). Retired contracts updated WITH
evidence: scaffold AGENTS.md → stub (guide content now FluxContext/PROJECT-GUIDE.md),
verify-an-manuscript doc counts, verify-paper-commands Mod+K ownership.
**Learnings:**

- The startup gate has teeth: importing principalSession (xterm) statically from Workspace
  put the eager shell 105KB over budget — xterm lives in mode/drawer chunks only; the drawer
  is `{#await import(...)}`-mounted and prefills ride a queue in commandBus until the module
  loads.
- Event-sourced ledgers must fold by ledger ORDER, not timestamp — same-millisecond ties
  otherwise pull post-send notes into the send boundary (caught by verify-feedback).
- cjs-module-lexer can fail to surface named exports for generated CJS with very long string
  literals — `await import()` consumers need the `.default` interop guard (bitten twice:
  fluxContextDocs.gen.cjs, agentsConfig.cjs).
- The real-Electron probe recipe (§9) generalizes cleanly: drive the PRELOAD bridge
  (`window.fig.*`) via executeJavaScript instead of app UI — verify-principal-electron gets
  roster→spec→PTY→data coverage with zero Svelte coupling.

### 2026-07-19 (later) — Skill content migrated into FluxContext; vendor skills are stubs (Claude Fable 5, `principal-agent`)

**Work:** Owner decision: launched agents (principal/workers) get instructions
deterministically, so vendor skill dirs add nothing for them — the six `skills/flux/`
references (workflow/cli/plots/figures/manuscript/slides) moved into
`resources/flux-context/` as stock docs (13 total; content read-through: retired slide verbs
fixed in the cheat-sheet, machine paths → `{{FLUX_CLI}}`/`{{FLUX_MCP}}`/`{{FLUX_MCP_PATH}}`
placeholders, per-machine facts moved to the owner's UserContext RULES); templates folded
into `TEMPLATES.md`; `skills/flux/` is now a pointer STUB (kept for `/flux` + bare-session
discovery, synced once to `~/.claude` + `~/.agents`; no runtime auto-sync into vendor dirs).
verify-registry-parity repointed to `resources/flux-context/CLI-REFERENCE.md` AND now scans
the cheat-sheet TABLES (1 → 57 verbs checked — the table blindspot had let deleted
`add-math`/`add-embed-figure` linger); verify-context-scheme pins the 13-doc set + a
no-machine-paths sweep; verify-fluxconfig checks placeholder substitution across ALL synced
docs.
**Learnings:**

- The stock-docs bundle rides the CLI BUNDLES: after editing `resources/flux-context/` +
  regen, `npm run build:cli` must run before the packaged CLI can sync the new content (the
  stamp correctly no-ops on the stale bundle's own hash — drift-safe, but easy to mistake
  for a failed sync).
- A doc gate that only greps prose patterns misses tables — scan the structured columns too;
  going from 1 to 57 checked verbs found nothing new only because the content had JUST been
  hand-audited.

### 2026-07-20 — Launch picker, family-template roster, PTY transcripts (Claude Fable 5, `main`)

**Work:** Owner's model-routing rework. agents.json is now a MATRIX (families = per-vendor
interactive/exec templates with {model}/{effort} substring placeholders + picker menus;
defaults for principal/worker/pass; worker values may be "principal-decides"; legacy
fixed-command rosters still resolve). `flux principal` (alias agent) = terminal picker
(readline, Enter-through on last-used, p/w customize, q quits) + the session runs inside a
node-pty interposer feeding @xterm/headless — transcripts land in Context/Transcripts from
ANY terminal stack, identical to the drawer's (shared serializer
src/lib/terminal/bufferText.ts). Worker policy rides FLUX_WORKER_POLICY env → `dispatch`
gained --family/--model/--effort (decide-policy errors with the menu; agent used recorded in
result.md + journal). Drawer gained the same pre-launch picker (agent:principalSpec
{probe}/{selection} modes, last-used persisted in <FluxConfig>/.agents-last.json). Deps:
@xterm/headless (pure JS; CLI-external + asarUnpacked). Gates: verify-principal-pty (17 —
drives the REAL picker through an outer pty), dispatch 23, context-scheme 47, fluxconfig,
parity (goldens regen); pure 141/141; context-gui 17/17. Owner's live roster migrated
(backup: agents.json.bak-legacy).
**Learnings:**

- node-pty does NOT replay exit events — attach onExit before any interaction, or an
  early-exiting child (picker `q`) resolves as a timeout.
- The desktop seat can become unreachable overnight (gdm greeter active → X sockets refuse,
  Wayland socket refuses): verify-principal-electron is environment-blocked in that state
  (now prints an explicit ENVIRONMENT diagnosis). Re-run from an unlocked seat; the pure
  pty gate covers the resolver/launch logic in the meantime.
- Family templates substitute {model}/{effort} as SUBSTRINGS with the drop-arg+flag rule for
  "default"/"principal-decides" — one mechanism serves codex's composite `-c k={effort}`
  args and claude's flagless effort story.

### 2026-07-20 (later) — Agent drawers retired; terminal-first canonical (Claude Fable 5, `main`)

**Work:** Owner decision: principal sessions live in the user's own terminals (`flux
principal`); the app is an independent review surface. Deleted PrincipalDrawer/
principalSession (+ Ctrl+Shift+J, picker panel, gutter) AND the reader's AgentDrawer;
reader ✦ Ask-AI now opens the SHARED terminal (terminalSession.ts moved to
src/shell/terminal/, one session for Paper margin + reader via TerminalPane.svelte) and
PREFILLS the question via the new prefill() export. agent:mcpSpec channel removed
(mcpSpecFor stays internal, feeding {mcpJson}). ensureFluxConfig now installs a managed
~/.local/bin/flux shim (marker policy; never clobbers a user file). context-gui asserts
NO drawer; verify-r3-agent rewritten; p4-paper repointed; fluxconfig gains shim asserts.
Full acceptance green incl. verify-principal-electron 15/15 once the seat unlocked.
**Learnings:**

- One persistent in-app terminal serving multiple mounts (margin + reader) beats bespoke
  per-surface agent terminals: attach/detach of a module-scoped session generalizes for
  free, and prefill-never-submit is the right in-app↔session interface.
- run-verifies.mjs must be launched from the repo root — from another cwd it dies before
  printing a usable error (looked like a bare "Node.js v22.17.0" line).

### 2026-07-18 (late) — Human↔agent feedback-loop design brainstorm (Claude Fable 5, `main`, no code)

**Work:** Owner asked for better human↔agent iteration on Flux projects (no app restarts,
agent-agnostic, no context re-explaining). Surveyed the existing surfaces and wrote the design
brainstorm to `notes/Flux_Human_Agent_Loop.md`: a context-stamped feedback ledger
(`.meta/feedback.ndjson` + AppContext stamp), an agent-agnostic `flux attend` dispatcher over
non-interactive passes, a per-project RUNNING lab notebook (this guide's pattern applied to
science projects), and generalizing the reader's AgentDrawer project-wide. Proposal only —
nothing built.
**Learnings:** for any future work on this loop, the shipped precedents to build on are:
`manuscript/comments.json` + `resolve-comment` (the review loop), `reader-context.json` +
`get_reading_context` (context-stamping to a file), the `pdfs_to_assign` watcher engine (file
queue driving work), and `AgentDrawer.svelte` + `agent:mcpSpec` + the `pty:*` bridge (in-app
agent terminal). There is currently NO task/inbox structure in the project schema, and no
CLI/MCP verb to *create* a comment thread (only list/resolve).

### 2026-07-18 (night) — Figure batch: paste, aspect-lock fix, path sub-modes, corner radius, grid (Claude Fable 5, `main`)

**Work:** Owner's five-item figure batch (notes/new_flux_fig_updates_jul18). (1) OS-clipboard
image paste, Figma-style: pasting rides the native "paste" event exclusively now — the keydown
Ctrl+V branch is GONE (it raced the paste event → double-paste); `copySelected` stamps the OS
clipboard with a marker text and the pure `decidePaste` table (src/lib/clipboardPaste.ts)
arbitrates elements/image/fallback for FigureMode + SlideMode via one `handleEditorPaste`.
(2) FluxFig-menu W/H now honor `lockAspect` via the shared `ops.setBoxDim` (moved from
Inspector.setDim) — with a `dimBase` snapshot captured at field activation, because the menu
applies LIVE per keystroke and re-deriving the ratio from a half-typed value ("1","14","140")
collapses it to 1:1. (3) Path-edit sub-modes: v edit / p pen / d delete inside node-edit
(keyboard.ts yields, so the letters are free), endpoint-only pen merge (pure
`mergeNodeChains`/`reverseNodes`; mid-node connects stay coincident separate elements — the
single-chain model can't branch, owner-approved), shift-drag node constraint to H/V/flanking
tangents (pure `interact/nodeAxis.ts`; shift-click's toggle deferred to up-without-drag).
(4) `PathElement.cap` + `cornerRadius` (geometric Figma fillets): ONE d-generation wrapper
`pathD()` now feeds refitPath/pathRender/resizeRemap/scaleRemap/tween/Canvas previews —
nodes stay the sharp skeleton; radius 0 is byte-identical to before. (5) Shift+G grid toggle
(Ctrl+Shift+G is ungroup) + pen placement hard-snaps to grid vertices while the grid is
visible (`penSnap` grid/anchors/noClose opts; one `penOpts()` for all four call sites).
Gates: verify-paste-decide (new pure), verify-paste-image + figenh-18-pathmodes (new
ui-extra), extended figenh-01-path/-06, verify-pen-snap, verify-interact-core,
verify-slide-tween; pure 137/137, ui sweep green, export assets regenerated.
**Learnings:**

- A control that applies LIVE per keystroke (FluxFigMenu number fields) must never derive
  invariants (like an aspect ratio) from the mid-edit model — snapshot the base at field
  activation. The Inspector never hit this because it applies on commit.
- The keydown handler and the native paste event BOTH firing for one Ctrl+V is a standing
  double-dispatch trap: route side-effects through exactly one of them. The paste event is
  the right one — it alone carries the OS clipboard synchronously.
- verify-tokens.mjs guards CSS custom properties: invent no `--c-*` names; read
  src/styles/tokens.css first (`--c-surface`/`--c-line-strong`/`--c-tx-2`, not
  panel/border/fg-dim).
- New optional element fields need NO figfiles/writer changes (elements serialize verbatim)
  — only types + schemas (+ regen validators) + both renderers + `ElementStylePatch`.
- verify-p4-figure pins FIG-contract text by grepping SOURCE files — moving a function to
  another module (Inspector.setDim → ops.setBoxDim) fails the gate until its `read()` list
  follows; update it in the same change.

### 2026-07-20 — Project-wide comment discovery default (Codex GPT-5.6 Sol, main)

**Work:** Changed the headless comments review loop so bare list/resolve operations cover every
canonical project document and report the owning path; retained `--doc` as an explicit targeted
mode, updated stock Context guidance, and added a multi-document regression fixture.
**Learnings:**

- Agent boot safety belongs in the product default, not only in prompt discipline: when review
  state is stored per document, the zero-argument discovery command must aggregate all documents.

### 2026-07-20 — Caret-feel lab: typing-feel experiments (Claude Fable 5, `caret-feel`)

**Work:** Deep-dived monkeytype's typing feel (90–150ms near-linear `inOut(1.25)` retargeting
tween on one overlay div; soft triangle blink at idle only; 125ms line-scroll-then-rebase) and
the wider landscape (Neovide springs/smear, kitty's snap-caret-plus-trail, JetBrains "Snappy",
VS Code's fixed-tween complaints), then built four caret modes behind Settings › Paper › "Caret
feel" (EXPERIMENTAL): classic (shipped CSS glide, default), monkeytype, chase (exponential
pursuit, τ 22/40ms typing/nav), chase-trail (leading/trailing edges at τ 14/48ms → smear), plus
independent soft-blink and smooth-line-scroll toggles. One ViewPlugin
(`editing/caretFeel.ts`) owns an overlay caret + transient self-terminating rAF ticker.
Verified: pure 142/142 (new `verify-caret-feel.ts`), paper-gate 15/15, live behavioral probe
(all modes animate/settle/teleport-gate; console clean), and a real-Electron per-mode INP probe
(`scripts/perf/caret-feel-inp.mjs`): overlay modes p95 32ms vs classic 48ms — the transient
ticker does NOT tax INP (the E43 concern), it beats the classic left/top CSS transition.
**Learnings:**

- CM manages `view.dom`'s class attribute (`updateAttrs` rewrites it every update) — a plugin's
  state classes must live on `scrollDOM` (vim's `cm-vimMode` precedent), or they silently vanish.
- In CM's measure cycle ALL reads run before ALL writes, and `scrollTarget` is applied after
  both (still pre-paint, same task): mirror another layer's inline styles from your WRITE phase
  (style-attr access forces no layout), and observe post-scroll state via `queueMicrotask` from
  the measure — a scroll-event listener is one frame too late (paints the jump first).
- In vim mode the whole cursor layer is swapped (`.cm-vimCursorLayer`; fat pieces carry NO
  `.cm-cursor` class and hold the glyph as text) — caret work must scope to
  `.cm-cursorLayer:not(.cm-vimCursorLayer)` and bail under `.cm-vimMode`.
- The §9 HMR-instance trap generalizes to Electron probes: driving `openProjectAt` via in-page
  `import()` against a long-lived dev server mutates the WRONG store instance ("no Paper
  button"). Perf probes that import app modules need a freshly-spawned dev server (the probe
  header documents the recipe).
- Event-Timing keydown durations quantize to 8ms buckets — compare INP across conditions in the
  same run, not against absolute budgets.

### 2026-07-21 — Caret-feel lab shipped: chase default, smooth option (Claude Fable 5, `caret-feel` → merged to `main`)

**Work:** Owner A/B verdict on the lab: chase is the DEFAULT paper caret, monkeytype mode kept
as "smooth", classic CSS glide + chase-trail + smooth-line-scroll CUT, soft blink BUILT-IN (no
setting). The only caret setting is now Settings › Paper › "Caret motion" (chase | smooth).
Retired `paperCaretMs`/`--flux-caret-ms` (flux-theme transition rule deleted, PaperMode var
binding removed) with persisted-settings migration (monkeytype→smooth, retired keys deleted).
verify-writer-latency.ts §2's classic-glide pins were superseded WITH evidence (INP measured
16ms better; the caret contract gate is verify-caret-feel.ts, which now also pins that the old
CSS glide stays gone). Verified: pure 142/142, paper-gate 15/15, check 0/0, live final-contract
probe (defaults, both modes animate+settle, built-in blink, migration, clean console).
**Learnings:**

- A negative source pin ("X stays retired") and a comment that NAMES X literally cannot coexist
  in the same file — the gate greps its own documentation. Reword the comment; keep the pin
  strict (second occurrence of this trap; it is the norm for retirement pins, not an accident).

### 2026-07-21 — Cascade: stepped deltas across a multi-selection (Claude Fable 5, `cascade`)

**Work:** Shipped the v0.1-final cascade feature end to end: pure core (`src/lib/cascade.ts` —
the step law `value ⊕ delta·step_k`, selection-unit ranking via `unitKeyOf` (a top-level group
is ONE rigid rank), ordering resolvers selection/layer/x/y + reverse, per-property
applicability + clamps; `ops.cascadeElements` + `slideOps.cascadeTracks` apply
ABSOLUTE-FROM-BASELINE restore-then-apply so live previews are idempotent and a mid-session
property switch reverts cleanly), OKLCh color ramps (`interp.shiftOklch`, one k-scaled
conversion), the ⌃⇧C `CascadePopover` (ONE component; the track flavor is injected as an
adapter from `animator/cascadeTracks.ts`; Arrange-mode gesture lifecycle + the nudgeSession
editGen guard; Esc rolls back, Enter/outside-click apply), animator entries (PropertiesPane
button, BeatRail context menu, SlideMode chord routing tracks-vs-elements), and the headless
surface (`cascade` / `cascade-tracks` registry verbs, 99→101, + live-bridge `"cascade"`).
Gates: `verify-cascade.ts` (pure), `verify-cascade-gui.mjs` (ui), `verify-cascade-tracks-gui.mjs`
(ui-extra — incl. the beat-faithful pin: a governed element's cascade routes into its
transform's t2 while its base stays put), `shiftOklch` pins in verify-color-interp.
**Learnings:**

- keyboard.ts's `k === "c"` copy branch had no `!e.shiftKey` guard — Ctrl+Shift+C silently
  aliased copy until now (third chord-hygiene find after ⌃⇧A/⌃⇧D: assume unshifted
  mod-branches leak their shifted forms until guarded).
- `ops.setBoxDim` writes the BOX only — nothing remaps a path's `d` after a W/H write, yet
  the Inspector and f-menu offer W/H fields on paths. Pre-existing desync (follow-up
  candidate); cascade excludes paths from width/height for exactly this reason.
- The slide display-sync (`armDisplaySync`) is a plain `project.subscribe`: ANY mutate on a
  routed element mirrors into the governing transform's t2, so bare `beginGesture()`+`mutate()`
  preview loops (Arrange, cascade) need zero extra wiring in slide mode, and
  `rollbackGesture()` restores project + overlay exactly through the history companion.
- The CLI HELP in `flux-cli.ts` is a hand-written literal and parity-gated: a new registry
  verb FAILS verify-registry-parity until its HELP line is added — help is not generated.
- **Owner-found player bug (pre-existing, fixed same day):** the rAF morph driver
  (`player.ts runMorph` — the WHOLE transform/morph/countUp family) dropped `track.start`;
  only the WAAPI keyframe path passed it as `delay`, so appearances staggered but transforms
  all fired at t=0. A start cascade over transforms made the loss obvious. Fix: runMorph
  takes `delay` and HOLDS WITHOUT SEEKING until it elapses (a seek(0) during the wait would
  clear drawOn dash state — the morph.ts t=0/t>0 dash contract). Player edits ride into the
  export runtime — re-run `npx tsx scripts/gen-export-assets.ts` after ANY player change
  (this session's second reminder). Playback pin: verify-cascade-tracks-gui §5 (rAF-sampled
  move-start times, 700ms authored gaps measured at 700ms).

### 2026-07-21 — Lazy figure-asset loading shipped (Claude Fable 5, `main`)

**Work:** Assessed + executed `notes/lazy_figure_asset_loading_plan.md` (recommended cut:
Phases 0–1, 3). Project open no longer parses any plot DOM — bytes/manifests/metadata stay
eager, `plotDom` fills on demand from `PlotElement` mounts via a time-sliced parse queue,
LRU-evicted under a 150k-element soft cap (mounted plots pinned; tenancy-gated to figure
mode). Export gate (`buildFigureSvg` → `ensureFigurePlots`), `$plotGen` reactivity fix, and
the save-safety invariant (`model.assets` 100% resident) hold; details promoted to §4.
Measured @12 dense figures: open 2.55s → 0.88s, renderer nodes 2.25M → 307k flat.
New gates: `verify-scale-lazy-assets` (scale) + `verify-lazy-{save-safety,load-gui,
export-overrides}` (ui); `verify-vanilla-inline`'s load-time-eager asserts superseded with
evidence. Phase 2 (slide) + Phase 4 (lazy bytes) deliberately deferred (§10). Also fixed a
pre-existing runner bug: `.mjs` verify children now get the tsx loader (`verify-scale-fulltext`
imports flux-core `.ts` and could never pass under the runner).
**Learnings:**

- The plan's simulation UNDERSTATED reality: real `loadFigInto` open cost is ~204ms/figure
  (base64 + validation on top of the parse), and renderer node accounting runs ~6× element
  count for attribute-heavy SVG — measure in the real app before sizing a fix.
- The ACTIVE figure always renders, but its ELEMENTS are still viewport-culled — "switch to a
  figure" in probes/gates must pan the viewport (focusFigure math), or nothing mounts and
  mount-driven machinery silently never runs.
- A `<image href="data:image/svg…">` fallback leaves Chrome SVG-image-cache documents behind
  (~one figure's worth, flat) after the inline upgrade — bounded, but visible in
  Documents/Nodes metrics; don't mistake it for a leak.
- Caches with an eviction policy need an explicit "apply the policy now" seam
  (`applyPlotNodeCap`) — eviction that only runs on growth is untestable and unusable for
  runtime cap changes.

### 2026-07-22 — `flux principal` → Claude launched blank; codex MCP diagnosis (Claude Opus 4.8, `main` working tree)

**Work:** `flux principal` with a **claude** principal opened a blank Claude Code session (no
boot prompt); codex worked. Root cause: the `claude` **interactive** template ended
`… --allowedTools mcp__flux {prompt}`, but Claude Code's `--allowedTools <tools…>` is a
**variadic** option (its parser greedily eats every following arg until the next flag), so it
swallowed the boot prompt as a tool value and Claude launched with no prompt. Fix: lead the
template with `{prompt}` (right after `claude`), mirroring the already-safe `exec` template.
Applied to `electron/agentsConfig.cjs` DEFAULT_AGENTS, `resources/flux-context/AGENTS-CONFIG.md`
(+ regen `fluxContextDocs.gen.cjs`), and the live `~/FluxConfig/agents.json`. New regression
assertions in `verify-context-scheme.ts` (prompt never adjacent-after a variadic flag, both
templates). `npm run check` 0/0; gate green (51 checks). The in-app drawer resolves the same
template, so it was covered by one fix. Codex MCP warnings in the screenshot are a **separate**
pre-existing issue: `~/.codex/config.toml` points `[mcp_servers.flux]` at `dist/flux-mcp.mjs`,
which this live-source checkout never builds (`npm run build:cli` emits it) → server dies on
launch → "connection closed: initialize response". Also found a real repo bug: the stock doc's
codex config (`command="node"`, `args=["{{FLUX_MCP_PATH}}"]`) is broken for **source** installs
because `resolveOwnCliCommandsSync` fills `mcpPath` with a bare `flux-mcp.ts` and `node` can't
run `.ts` (only the dist/`.mjs` branch works with plain `node`).
**Learnings:**

- **CLI arg templates must respect variadic options.** Any `<x...>`-style option (commander/
  yargs) consumes forward until the next flag — never place a positional (`{prompt}`) directly
  after one. Put positionals first, or keep them ahead of the variadic flag. Prove arg binding
  cheaply with the real binary in `-p`/print mode (stdin closed so it can't hang), not by
  reasoning about the parser.
- The flux launcher's own MCP wiring falls back tsx-source → works; **codex's global
  `~/.codex/config.toml` is independent** and hardcodes a path — a live-source box needs it
  pointed at a tsx invocation (`node22 node_modules/tsx/dist/cli.mjs flux-mcp.ts`, proven under
  `env -i`), not the unbuilt dist bundle. The box's default `node` is v20; pin node22.

### 2026-07-23 — V0.1 user documentation corpus (Claude Fable 5, `main`)

**Work:** Built the user docs as a Quarto website project in `docs/` (15 `.qmd` pages:
index/installation/getting-started, the five mode guides, agents/collaboration, three
concepts pages, three reference pages incl. full per-mode shortcut tables), with every
UI label and chord swept from source by Explore agents (file:line-verified). `INTRO.md` →
`index.qmd`; `agent_context_and_collaboration_system.qmd` → `agents/collaboration.qmd`.
New pure gate `verify-docs.ts` (+ manifest entry + `docs/**` pathMap): sidebar completeness,
relative-link integrity, title+subtitle-only frontmatter, `.qmd`-only render globs (this
guide stays out of the site), machine-path hygiene. `quarto render docs` clean; README got a
Documentation section. Authoring conventions + the docs-ride-the-commit rule promoted into §8.
**Learnings:**

- The docs sweep surfaced real app inconsistencies (report, don't paper over in docs):
  Library tooltips still say `~/FluxLib/…` (real default `~/FluxConfig/FluxLib/…`); the
  single-row Get-PDF miss toast claims "library proxy support is coming" though proxy routes
  exist elsewhere; `Help.svelte` lists Slide-stage `+/−/0` zoom keys with no handler; Help/
  shell chords don't work on Home (Workspace-mounted); Library's `Mod+K` (focus add box)
  overlaps the shell palette binding — both window listeners fire; a stale `Ctrl+Shift+J`
  drawer comment survives in `Workspace.svelte`; `src/shell/modes/slide/README.md` still
  describes the retired S/A/M animator.
- js-yaml in this tree exposes no ESM default export — `import * as yaml from "js-yaml"`.

### 2026-07-23 (later) — Docs-sweep cleanup batch + Lighttable page (Claude Fable 5, `main`)

**Work:** Fixed the app inconsistencies the docs sweeps surfaced: Library `Mod+K` now
single-fires (the Workspace router stands down when Library is focused — the add box owns
the chord, per Help); `Help` moved from Workspace to Shell so `?` works on Home; Help's
phantom Slide `+/−/0` zoom rows removed (F5/⇧F5 documented instead); the single-row
Get-PDF miss toast is proxy-aware (no more "support is coming"); every stale
`~/FluxLib/...` path in tooltips/CLI help/code comments now reads `<FluxLib>/...`
(the `keys` verb prints the RESOLVED path via newly-exported `core.resolveFluxLibPath`;
cli-help golden regenerated — exactly the 3 path lines); the stale Ctrl+Shift+J comment
is gone; `src/shell/modes/slide/README.md` rewritten to the post-rework Animator (no
parts tree / S|A|M; BeatRail + PropertiesPane + chords; current gate names). Docs: new
"Companions" sidebar section + `lighttable.qmd`; shortcuts.qmd notes the Mod+K routing.
Verified: check 0/0, pure 145/145, ui gates context-gui/shell-complete/p5-shell/
lib-actions/lib-organize green, plus a live :1420 probe pinning the three behavior
changes (library single-fire, palette in Figure, `?` on Home) with a clean console.
**Learnings:**

- The Workspace `Mod+K` router is now the precedent for mode-claimed shell chords: the
  claiming mode keeps its own focused-scoped listener, and the shell router gets an
  explicit stand-down branch — never two competing window listeners on one chord.

### 2026-07-23 — V0.1 final hardening sweep (Claude Fable 5, `v0.1-hardening`)

**Work:** Owner's final pre-V0.1 fortification pass — three read-only audit agents (security ·
data-integrity · complexity/release) over everything that landed after the 2026-07-11 fortify
engagement, every significant finding re-verified at file:line, then a bounded fix set. **No
ship-blockers found** (fortify guards intact on new code, twin-engine clean, no secrets, no
RCE-without-user-action). Landed: **A1** made the pure tier hermetic — `verify-slide-export-parity`
read a `dist/` build artifact, so `npm test` failed on a clean checkout AND in CI (pure runs
BEFORE build, ci.yml:35 vs :43); fixed with a `FLUX_EXPORT_SIDECAR` test seam. **A2** (highest-value)
stopped beat navigation from dirtying the deck — `refreshBeatDisplay`/`clearBeatDisplay` now write
via new `store.mutateDisplay` (editGen bump, no `dirty`) and deck save skips content-identical
rewrites; this closed a real data-loss path (nav → autosave → spurious "changed on disk" → Overwrite
drops an agent's edit). **A3** excluded path/line from the W/H fields (Inspector + FluxFigMenu now
gate on `cascade.supportsBoxDim`, re-exported from ops) — `setBoxDim` never remapped a path's `d`.
**A4** made machine-global prefs/textstyles writes atomic (`atomicWriteSync` tmp+fsync+rename) +
a corrupt-prefs backup guard — a truncated `preferences.json` had silently re-resolved FluxConfig/
FluxLib to the fallback. **B1/B2/B3** electron security: recipe:run workspace-trust prompt (owner
chose "trust prompt on first run"), proxy-capture window `setWindowOpenHandler` deny + scheme-limited
nav, print window `javascript:false` + CSP. **C** release hygiene (unused `dompurify` dropped, two
`notes/` docs untracked, personal path out of `verify-figname`, dead `build-showcase-deck.ts`
deleted, Tauri gitignore lines, resvg comment). Deferred by owner: per-plot complexity budget.
New gates: `verify-prefs-atomic`, `verify-electron-hardening` (both pure+presence), plus the
`verify-beat-display-gui` nav-no-dirty extension. Pure tier **146/146 green with `dist/` absent**
(hermetic proof); check 0/0; slide-tenancy + menu + beat-display ui gates green.
**Learnings:**

- A "hermetic" pure gate that reads a `dist/` build artifact isn't hermetic — it fails on a fresh
  clone and (since CI runs `--tier pure` before `npm run build`) in CI too. Gates must generate
  what they need in-process or move to the bundle tier. Prove it by running with `dist/` moved away.
- Separating "display write" from "user edit" is the clean fix for any reconciler that mirrors
  derived state into a store: bump editGen (keep coalescing/undo byte-identical) but never set
  `dirty`. Recomputing what is SHOWN must be invisible to autosave/divergence.
- The retirement-pin trap bites again (3rd time in this guide): a negative source pin
  (`verify-slide-figure-separation` greps slideBridge for `executeFigSave`) and a *comment* naming
  that token can't coexist — an A2 comment mentioning `executeFigSave` failed the gate. Reword.
- This tree had a concurrent agent session with unrelated work in flight (references/enrich/
  library/reader) the whole time — the explicit-paths-only rule is not optional; every commit here
  staged named paths and was diffed to confirm zero foreign content. `README.md` was fixed by that
  other session (my edit lost a "modified since read" race), so C3 needed no action.

### 2026-07-24 — Lighttable launcher button in the rail (Claude Fable 5, `main`)

**Work:** Owner request: a convenience button near the Settings gear that launches the
Lighttable sidecar. Added `lighttable:launch` (invoke/spawn) — main resolves the sidecar's own
electron binary via `lighttable/node_modules/electron/path.txt` and spawns it detached (no code
crosses the sidecar boundary; second presses hit Lighttable's single-instance lock and focus the
existing window). Rail button in `ActivityRail.svelte` (new `lighttable` icon), optional
`FileBridge.launchLighttable`, memBridge stub, error toast on failure. Gate:
`verify-shell-complete` now pins the button and the click→toast wiring in the fixture; docs
`lighttable.qmd` updated.

### 2026-07-27 — Windows portability: the clone→build→run path (Claude Fable 5, `main`)

**Work:** Full win32 audit (no blockers found for `npm install → npm run build → npx electron .`;
all native deps ship win32 prebuilds) and the degraded-item fixes, every one gated behind
win32-only branches so POSIX behavior is byte-identical: NEW `electron/execResolve.cjs`(+`.d.cts`)
— the ONE seam for launching external commands by bare name (§2 table row), wired into quarto
(main.cjs + manuscript.ts), recipes (main.cjs + recipe.ts), and the agent roster (agents.ts
spawn+pty, terminal.cjs `pty:create`), gated by `verify-win-spawn.ts` (pure, all branches
simulated via injectable {platform, env, exists}). Also: renderer `isAbsolutePath` (types.ts →
projectWatch hot-swap) + win32-aware `basename` in io.ts; fsGuard case-fold on win32; `tsx.cmd`
MCP dev fallback; linux-gated ozone switch + win32 window icon; `flux.cmd` shim twin +
cmd-wrapped packaged CLI string in fluxPaths; `electron:dev` now tails into
`scripts/electron-dev.mjs` (cmd.exe has no inline env); `.gitattributes` `* text=auto eol=lf`
(verified no-op: the index was already 100% LF). Two source-shape probes re-anchored to the new
spellings (hardening B1 spawn probe, r3 tsx probe) — same contracts, evidence in the commits.
**Learnings:**

- Since Node's CVE-2024-27980 fix, `spawn()` throws EINVAL for `.cmd`/`.bat` without a shell —
  and npm installs CLIs (claude, codex, tsx) as exactly those shims on Windows. Any NEW spawn of
  an external command must go through `resolveSpawn`/`resolvePtySpawn` (execResolve.cjs): it
  prefers a real `.exe` anywhere on PATH (no shell at all) and otherwise wraps in
  `ComSpec /d /s /c` — child_process needs `windowsVerbatimArguments` spread from the resolver;
  node-pty instead takes the wrap as ONE command-line STRING (it re-quotes arrays).
- The fluxPaths injectable-platform pattern scales: pure gates can exercise every win32 branch
  from Linux. What still cannot be simulated is real hardware — Windows remains untested
  end-to-end; first testers should start at quarto compile, the agent drawer, and recipe re-run
  (the resolver seams).
- `env.Path ?? env.PATH` is wrong for env fallbacks — an EMPTY string must fall through too
  (use `||`). The pure gate caught this before it shipped.

### 2026-07-28 — cascade-tracks verb was dead headless: missing index.ts re-export (Claude Fable 5, `main`)

**Work:** Chased the `npm run build` warning `Import "cascadeTracksVerb" will always be
undefined` — a real bug: the 2026-07-21 cascade session exported `cascadeTracksVerb` from
`flux-core/slides.ts` but never added it to index.ts's explicit `./slides` re-export list, so
the `cascade-tracks` / `cascade_tracks` verb threw `core.cascadeTracksVerb is not a function`
on every CLI/MCP/tsx-source invocation (the GUI ⌃⇧C path was unaffected — slideBridge calls
slideOps directly). Fixed the export; two new pins: registry-parity gained §(e) — every
`core.<name>` in verbs.ts statically resolves against the imported flux-core/index namespace
(99 refs) — and verify-slide-headless-e2e now EXECUTES cascade-tracks through the real CLI
(first-fixed start cascade, asserted 0/250 on disk). check 0/0; both bundle warnings gone.
**Learnings:**

- flux-core is outside `npm run check`'s scope, so index.ts's explicit re-export lists have no
  static safety net — esbuild's `import-is-undefined` build warning is the ONLY signal and must
  be treated as an error (promoted to §9 Bundle/startup).
- Parse-level parity (goldens, tools/list) never invokes handlers: a new verb needs at least one
  gate that EXECUTES it headless, or a broken handler ships green.

### 2026-07-29 — UserContext seeds are BLANK by design (Claude Fable 5, `main`)

**Work:** Owner directive: nothing user-specific may be seeded into FluxConfig. The
fresh-machine `UserContext/RULES.md` seed (`GUIDELINES_BASE_RULES` in fluxPaths.cjs) was the
owner's actual conventions (panel labels, caption style, one-canvas-per-qmd, …) — replaced with
a blank purpose-comment template and renamed `USER_RULES_SEED` (WHO-AM-I was already blank).
verify-fluxconfig now asserts BOTH seeds are blank (no pre-filled conventions) instead of
asserting the old content. Also genericized owner strings in agent/user-facing product text:
stock FluxContext docs (`"MICrONS synapse organization" --author "K. Driessen"` →
`"Synapse organization" --author "A. Author"` in WORKFLOW.md; `/data/microns_analysis/` →
`/data/my_analysis/` in CLI-REFERENCE + MANUSCRIPT-AND-REVIEW; regenerated gen.cjs, hash
9a846d90c7af7fa3) and the `citation` verb description ("Driessen et al." → "Smith et al.").
memBridge.ts's dev-only fixture keeps the owner's name (never ships). Legacy migration
unchanged: an existing/edited RULES.md or base_rules.md is user-owned and never rewritten.
Gates: fluxconfig, context-scheme, registry-parity, check 0/0.
**Learnings:**

- Seed content policy (standing): everything under `UserContext/` is seeded as a purpose
  comment + empty body — never anyone's actual conventions. The fluxconfig gate now pins this.
- Stock FluxContext docs are product text synced to every machine — examples in them must use
  placeholder names/paths, not the owner's.

### 2026-07-29 (later) — Docs button in the rail (Claude Fable 5, `main`)

**Work:** New rail-foot button (bookText icon, between Lighttable and Settings) opens the
rendered user docs in the OS browser. Mirrors the lighttable:launch pattern end to end:
`docs:open` invoke channel (contract.cjs, scope spawn) → main handler `shell.openPath`s
`<repo>/docs/_site/index.html`, with a "run `quarto render docs` once" error toast when
_site is missing (a button press must not hide a multi-second render) → preload `openDocs` →
optional `FileBridge.openDocs` → ActivityRail button. Source-checkout only, like Lighttable.
Docs updated (index.qmd rail-foot sentence; lighttable.qmd "above the Settings gear" was now
stale). Gates: ipc-contract, docs (120), check 0/0; visual check on :1420 (button renders,
0 console errors).
**Learnings:**

- Rail-foot buttons that reach the OS all follow one shape: contract entry → main handler
  returning `{ok, error}` → preload one-liner → optional bridge method → toast on `!ok`.
  Copy lighttable:launch, don't improvise.

### 2026-07-29 — Zotero sync + BBT-style citekeys (Claude Fable 5, `zotero-sync`)

**Work:** Connected FluxLib to Zotero: a Better-BibTeX "Keep updated" auto-export is a standing
intake valve — synced on startup (Shell idle kick, dynamic import), live while the app is open
(new `zotero-bib` watch subsystem over the existing fs:changed channel; the Library re-invokes
watchRoot after connecting since watch targets resolve at setRoot time), from the Library's new
Zotero panel (connect / status / Sync now), and headlessly via the `zotero-sync` CLI/MCP verb
(102 verbs, goldens regenerated). One-way, additive, idempotent (planAdds dedupe). PDFs either
COPY into items/ (default, self-contained) or LINK — a `paper.link.json` pointer resolved ONLY
through the readPdf/hasPdf twins, degrading to "PDF missing" when the external file moves; a
merged entry that lacks a PDF gets BACKFILLED on later syncs. Settings live as `zotero` in
machine preferences.json; fsGuard roots extend to the configured dirs. Shared pure cores per §2:
`zoteroSettings.ts` + `zoteroFiles.ts` (attachCandidates / attachPathCandidates — flux-core,
the GUI sync job, and ImportDialog resolve identically). `makeCitekey` now emits Better BibTeX's
default `auth.lower + shorttitle(3,3) + year` (e.g. `mullerNeuralBasisDecision2024`) with
case-insensitive collision suffixes (citekeys name `items/<key>/` dirs, which case-fold on
macOS/Windows); existing keys are NEVER re-keyed (owner deferred the one-off rekey of this
machine's library). Gates: `verify-citekey.ts` + `verify-zotero-sync.ts` (hermetic scratch
HOME/XDG; executes the real CLI). Pure 149/149, check 0/0, lib ui gates 3/3, docs 120,
build warning-free.
**Learnings:**

- `assignJob.svelte.ts` is the canonical template for FluxLib intake engines and copied over
  cleanly: revision store bumped by a watch subsystem → debounced module-level subscribe →
  cross-engine heartbeat lock → `runSeq` effect in LibraryMode for the re-list. Reach for it
  before designing anything watcher-driven from scratch.
- Watch targets are resolved once, at `watch:setRoot` — any prefs-driven target (the Zotero
  bib) must re-invoke `watchRoot` after its setting changes, or the watcher silently lags the
  config until the next project open.

### 2026-07-29 (later) — Zotero huge-library posture: defer-fulltext + big-export suggestion (Claude Fable 5, `main`)

**Work:** Two owner-requested follow-ups. (1) `deferFulltext` (ZoteroSettings + `--defer-fulltext`)
makes link-mode attaches STAT-ONLY: the sync writes the `paper.link.json` pointer without ever
reading the linked file — at 15k PDFs on a cloud-mounted Zotero folder this is the difference
between a sub-second sync and an overnight streaming job. Text backfills lazily: flux-core
`getOrExtractFulltext` (readPdf resolves pointers) and an opportunistic fire-and-forget extract
in `readerPdfBytes` on first open. (2) The connect dialog stats the picked .bib and, over
`BIG_BIB_BYTES` (5MB), preselects link+defer with an explanatory note (`isBigBib`/
`estimateBibEntries` in zoteroSettings.ts, pure). Measured (scratch probe, load-8.5 box): a 30k-
entry / 22MB bib costs ~50ms to split, ~170ms to lightEntry, ~460ms to re-plan against a full
library — the steady-state sync cost a no-change stat short-circuit would eliminate (NOT built;
owner deferred pending the big-bib discussion). Gate: verify-zotero-sync extended (defer pass +
lazy backfill through the pointer + suggestion helpers); goldens regenerated (`--defer-fulltext`).
**Learnings:**

- ft: search does NOT auto-backfill deferred text (fulltextSearch only REPORTS missingText) —
  a deferred-link paper becomes full-text-searchable after its first reader open or a
  get_paper_text call. If bulk backfill is ever wanted, iterate getOrExtractFulltext over the
  index's backfill list; the machinery already exists.

### 2026-07-29 — Agent-facing macOS install runbook (Claude Fable 5, `main`)

**Work:** Added `docs/claude-install-flux-mac.md` — a step-by-step runbook a Claude Code
session on a fresh Mac follows to take a bare `git clone` to fully-ready (Node 22 → npm ci →
`npm run build` → FluxConfig first-run → claude-family agents.json → Quarto/TinyTeX +
`quarto render docs` → uv + `~/fluxplot` → Lighttable sidecar (its own `npm ci` +
`npm run build`, installed by default — the top-bar button needs `lighttable/dist/`) →
verification → optional double-clickable `~/Desktop/LAUNCH-FLUX.command`). Zotero is deliberately EXCLUDED (owner decision: the
install agent does nothing and asks nothing about Zotero — FluxLib starts empty, and the
connection happens later from the app's Library → Zotero panel; the runbook's final report
just points at the Zotero docs page). Deliberately a plain `.md`: the render globs are
`.qmd`-only, so it never enters the user site, and verify-docs (120 checks) stays green
with zero changes.
**Learnings:**

- The production-style source launch is `npm run build` once + `./node_modules/.bin/electron .`
  from the repo (main.cjs falls back to `dist/index.html` when `VITE_DEV_SERVER_URL` is
  unset). `npx electron <path>` from OUTSIDE the repo may fetch a fresh Electron instead of
  using the checkout's — always use the repo-local binary.
- macOS launcher facts: Finder starts `.command` files with a minimal env (no `~/.zshrc`), so
  a launcher must export a full PATH — and Flux spawns quarto/claude/recipes with the PATH it
  inherits (execResolve is identity off win32). Launch Electron detached (`nohup … & disown`)
  or closing the leftover Terminal window kills the app.
- Fresh-machine trap: `ensureFluxConfig` installs the `flux` shim only if `~/.local/bin`
  already exists — an installer must `mkdir -p ~/.local/bin` BEFORE the first CLI/app run.
- Privileged installer steps on macOS can be fully agent-driven:
  `osascript -e 'do shell script "…" with administrator privileges'` raises the native auth
  dialog (the password never transits the agent, which has no tty for plain `sudo`). The one
  exception is Homebrew's installer (refuses root, drives tty-interactive sudo) — a
  hands-off runbook treats brew as use-if-present and never installs it.
- Pure tier on macOS: `verify-fluxconfig` + `verify-zotero-sync` fail by construction
  (XDG-based prefs isolation is a no-op on darwin), and the three slide-export scripts need
  `FLUX_CHROME` pointed at Chrome's mac path — platform assumptions in the scripts, not
  regressions.

### 2026-07-29 (evening) — Zotero sync stat short-circuit (Claude Fable 5, `main`)

**Work:** Landed the no-change short-circuit the "(later)" entry had deferred: both engines
stamp the export's stat fingerprint ({bibPath, size, mtimeMs}) into
`<FluxLib>/.fluxlib/zotero-sync.json` after a successful sync, and AUTOMATIC passes (startup,
watcher, CLI without flags) skip everything when it matches — one ~0.05ms stat instead of
re-parsing a possibly-huge bib to conclude "0 added". USER-invoked passes always run fully
(panel "Sync now" and connect both force; CLI `--force`) — a forced pass also picks up attach
backfill for a PDF that appeared on disk WITHOUT a bib rewrite (the one thing the fingerprint
can't see). Stat-before-read discipline in both engines: a rewrite landing mid-sync can only
cause an extra re-run, never a missed one. State file is derived/rebuildable (lost stamp = one
extra full sync). Gate passes 2/6–8 + two CLI legs (skip render + `--force`); goldens regen'd.
**Learnings:**

- Adding a skip path changes the CONTRACT of "run it twice" gates: verify-zotero-sync's pass 2
  ("re-sync is a no-op") now asserts the SKIP, and full-parse idempotency moved behind
  `--force` + a rewrite pass. When a fast path lands, audit existing gates for assertions that
  silently exercised the slow path.

### 2026-07-29 (evening, 2) — Zotero integration user-docs page (Claude Fable 5, `main`)

**Work:** New `docs/integrations/zotero.qmd` (sidebar section "Integrations") — the full user
guide: BBT setup (Keep updated), connect flow, sync timing + the stat skip, copy-vs-link,
backfill, deferred text, very-large-library posture (collection exports; sqlite-on-cloud
warning), dedupe with an existing FluxLib, browser-connector capture, CLI pointer (links to
reference/cli.qmd — no verb-table restating), disconnect semantics, troubleshooting.
Cross-links repointed (library.qmd bullet, concepts citekey section). verify-docs 127,
`quarto render docs` clean (17 pages).

### 2026-07-29 — Top-bar rework: rail → titlebar, new icons, phyllotaxis logo (Claude Fable 5, `topbar-rework` → merged to `main`)

**Work:** Owner-directed appearance rework. (1) The left ActivityRail is GONE — the five mode
buttons (sliding-underline indicator, Alt/⌘-click-to-split preserved) and the four utility
buttons (Lighttable/Docs/Settings/Help, smaller+fainter "secondary register", now visible on
Home too) live in the TitleBar; `--rail-w` removed; single-pane workspaces also drop the 28px
pane header (the header, with its close button, renders only in splits). Ctrl+1–5 switch modes
(Workspace's existing window-keydown router). (2) New mode icons in Icon.svelte with always-on
Flexoki 400-grade accent details via new `--flx-*-400` tokens (figure = axes+scatter+fit,
library = temple, slide = stacked frames+play, reader = highlight doc, paper = serif "A"+caret,
help = circled ?). (3) New brand mark: an 88-dot phyllotaxis bloom through the full accent
wheel — Logomark.svelte (square, one-shot CSS bloom animation on Home, deliberately NOT gated
on prefers-reduced-motion per the §9 GTK trap), canonical asset `brand/flux-mark-phyllotaxis.svg`,
real SVG favicon in index.html, and ALL build/icons regenerated (ico/icns are hand-packed
PNG containers) by new `scripts/gen-app-icons.mjs`; the old twist mark is deleted.
Gates: check 0/0, pure 149/149, shell-complete (now pins the titlebar strip + no-nav.rail +
Ctrl+2/4 switching), p5-shell, paper-keyboard (selector re-anchored), paper-gate 15/15,
slide-tenancy, startup, docs 127.
**Learnings:**

- `driver.mjs clickMode()` selects `button[aria-label=…]` with no container, so relocating the
  mode buttons kept ~40 ui gates green untouched; only the two scripts that hard-coded
  `nav.rail` needed re-anchoring. Container-agnostic aria-label selectors are the cheap
  compatibility contract — prefer them in new gates.
- The "faint red speckle" in an empty References pane that looked like a watermark is the
  dynamic-margin ambient background (owner-locked feature, §DynamicBackground) — identify
  before deleting "decorations".
- Colored icon details ride `var(--flx-*-400)` inside the ICONS path markup (CSS vars resolve
  fine through `{@html}` inline SVG) while structural strokes stay `currentColor` — accents
  stay token-managed with zero component API change.

### 2026-08-03 — Caption editor: fit-to-content blocks + a scrolling page (Claude Fable 5, `caption-fit`)

**Work:** Owner-reported wasted space in the caption editor. Every block was pinned at
`min-height: 150px` with a `flex: 1` two-row textarea, so a one-liner burned the same space as
a paragraph and anything longer fell into an inner scrollbar that the canvas made unusable.
New sizing contract: a caption box NEVER scrolls (new `src/lib/ui/autogrow.ts` action), and the
page is exactly its figure's height with the block column scrolling inside it — so page and
brace always match. Also: hidden native scrollbar + parchment edge fades, grow-into-view under
the caret, gap 21→14 / page padding 34→26, and a `captionFontSize` setting (default 13, was a
hardcoded 15; the block letter derives at ×1.27). Separately, clipboard-pasted images now
archive their original to `plots/pasted/` (mirrors `plots/paper_snips/`) — a pasted image
produces an `ImageElement` with no `source`, so `fig/assets/<id>.png` was previously the only
copy of those pixels anywhere. Gates: new `verify-caption-fit.mjs` (28 checks, ui-extra),
`verify-paste-image` extended, check 0/0, pure 149/149, ui 56/56, docs 127.
**Learnings:**

- **Never `getBoundingClientRect` inside a world-space layer.** The caption page rides
  `transform: scale(zoom)`; `scrollHeight`/`clientHeight`/`offsetTop` are pre-transform layout
  px (what you must write back), while gBCR is transform-scaled and corrupts any fit at zoom ≠ 1.
  The corollary is free: a zoom change needs no re-fit at all.
- **A font-size change resizes no box**, so neither an input event nor a ResizeObserver fires —
  an autosizing element must take the font size as an explicit param or it silently overflows a
  frozen height. Same class of bug as the one-way `value=` + `mutate` round-trip, which fires a
  redundant `update()` after every keystroke unless the action dedupes on `{value, fs}`.
- `Canvas.svelte`'s `onWheel` `preventDefault()`s unconditionally, so **no scroll container
  mounted inside the canvas can scroll** without an explicit escape hatch there. Divide the
  delta by `viewport.zoom` (the container is inside the scale transform) and fall through to the
  pan at either end, so scroll-chaining still feels like one gesture.
- Guard a ResizeObserver on the dimension you actually care about: an unguarded callback refires
  on your own writes and can raise Chrome's "ResizeObserver loop completed with undelivered
  notifications", which `realErrors()` fails the gate on.
- Svelte 5 rejects unknown `on:*` events on DOM elements in svelte-check (`does not exist in
  type HTMLProps`). Pass a callback through the action's params instead of dispatching a
  CustomEvent — better typed and one less hop.
- **Found and fixed a rotted gate:** `verify-import-gui.mjs` asserted the pre-`a2aed28`
  AuthorYear citekey format. The BBT-format commit never re-ran it because the citekey `pathMap`
  entry didn't list it — added, so the next format change catches it. When you change a shared
  format, grep the gates for the old shape rather than trusting `--changed`.

### 2026-08-03 (later) — Sidebar figure click centres the view (Claude Fable 5, `caption-fit`)

**Work:** Owner request: clicking a figure name in the Figure-mode sidebar now goes to that
figure — activate plus centre at the CURRENT zoom (never reframe; the zoom is the user's
choice). New `src/lib/viewportNav.ts centerOnFigure()` solves the pan from
`screen = pan + world * zoom`; Canvas publishes its usable content box to a new
`store.ts canvasBox` so the math needs no DOM query and no Canvas export. Gate:
`verify-figure-center.mjs` (16 checks, ui-extra) — exact centring at three zooms, zoom
untouched, oversized figure centres rather than fitting, ruler inset respected, no dirty flag.
Also reviewed and tightened the caption work from earlier today (one post-fit hook instead of
two resync mechanisms — see f39ba4c).
**Learnings:**

- **Only the ACTIVE pane should publish shared viewport geometry.** `viewport` is an app-global
  singleton across split panes and across figure/slide tenancy, so an inactive pane writing its
  own size would silently retarget the other pane's navigation. Gate the publish on `paneActive`.
- Ruler strips overlay the host's top/left edges, so "centre in the canvas" is centre in the
  content box, not the host box. Publishing a BOX (x/y/w/h) instead of a size keeps that
  knowledge inside Canvas, where `RULER` already lives, instead of leaking to every caller.
- `activeFigureId` is a plain writable: a same-value `set` notifies nobody. Behaviour that must
  re-fire on re-selecting the current item (re-centre as a "put me back" gesture) has to be a
  direct call in the handler, never a store subscriber. Worth an explicit gate assertion — it is
  invisible in code review.
- `src/shell/scholar/nav.ts focusFigure()` is misnamed: it pins the figure's top-left at screen
  (140, 96) and hard-codes `zoom = 0.55`. It is the manuscript @fig-ref jump and was left alone,
  but it is NOT a centring helper — reach for `centerOnFigure` instead.

### 2026-08-04 — Figure families: structured identity + the Ctrl+R namer + rail parity (Claude Fable 5, `fig-families`)

**Work:** Owner-reported bug: figure "numbers" in the writer were regex-parsed out of the free-
text figure NAME (`designationFromName` — greedy capture, positional-ordinal fallback), so
"Sup. Figure 1" rendered as "Fig 2 Sup. Figure 1" in chips/pickers and exports numbered by a
THIRD rule (embed order). Replaced with structured identity: every figure = **family + number**
(+ optional free-text **nickname**), with per-family in-text/caption templates. New pure shared
core `src/lib/figfamily.ts` (built-ins figure / supplementary / extended-data + per-project
custom families like movie → "Mov. 3b"; `computeFamilyNumbers` heals numbers to contiguous
1..N; `assignFamilyNumber` is the ONE insert-and-shift reorder primitive). `Figure.name` is now
DERIVED (`"Supplementary Figure 4"`) for backcompat (export filenames, canvas labels, slide
folding); index `kind` derives via `kindForFamily`. Migration `migrateFigureFamilies` is
deliberately NOT in `migrateProject` (slide decks project through it — slides must never be
renamed); it runs in the fig-subsystem loaders only, seeds from index hints (agent-set kind
survives), parses legacy names, and captures unparseable names as nicknames (which also feed
first-save `deriveLabel` → `fig-growth-curves`, plus a `-2` de-dup). Paper chain: `FigureRef`
carries precomputed `display`/`captionLabel`; `resolveFigure` returns the formatted display;
every hard-coded "Fig "/"Figure N." site now renders templates. Export stops delegating figure
numbering to Quarto entirely (it can't express families): family caption leads baked into alts,
embed ids DEMOTED `{#fig-x}` → `{#x-fig-x}`, ALL refs literalized. **Deliberate trade-off:**
exported-HTML anchors change form and Quarto lists-of-figures lose entries. UI: `FigureNamer.svelte`
(Ctrl+R; number pre-selected → digits → Enter; ↑/↓ cycles family; inline "+ New family…" staged
until commit; ONE undo entry), sidebar dblclick opens it (figure rows no longer inline-rename),
family badges ("2"/"S2"/"ED3"/"M1"), Inspector identity row + nickname field. Rails: drag-resize
- hide across all modes (`figureLayoutStore`, slide right-rail gutter activating the dormant
`inspectorW`, paper `outlinerW`; shared `leftRailHidden` — context-sensitive Ctrl+B toggles it
when no text is selected, Ctrl+Shift+B keeps the right rail and now also toggles paper's margin).
Agent surface: verbs `set-figure-family` / `define-figure-family` / `remove-figure-family`,
`create-figure --family/--number/--nickname`, bridge `set_figure_family`; `set-figure-layout
--name` re-routed (designation → identity, else nickname). Electron dev menu reload moved to
Ctrl+F5 (renderer owns ⌃R — same reasoning as F12 for DevTools). Gates: new `verify-figfamily.ts`
(replaces verify-figname), `verify-fig-namer.mjs`; rewrote `verify-m11-m14.mjs` (namer era) and
the export/figref/embed-caption/f6 expectations; parity gate pins nickname-labels + heal
idempotence; registry goldens regenerated (3 new verbs). check 0/0, pure 149/149, paper-gate 15/15.
**Learnings:**

- **Family number = position can't be derived from array order**: canvas files partition
  `Project.figures` (canvas-then-file load order), so cross-canvas numbering needs an explicit
  stored `number` + a load/mutate-time normalizer (hand-edited gaps/dupes heal deterministically).
- **Keep new figure-model migrations OUT of `migrateProject`**: slide decks project through
  `normalizeProject → migrateProject` (slide/store.ts), so anything name/identity-shaped there
  would rename slides. Fig-subsystem-only migrations belong in the loaders (loadFigInto /
  loadFigModel / readFigSource / io.ts / convert.ts), each passing index hints.
- **Ops-level slide safety is structural, not situational**: `deleteFigure`/`duplicateFigure`
  only touch figures already carrying `family` — deck-projected figures never do, so a stray
  slide-mode code path through the shared ops can't stamp/rename slides.
- `flux-core/render.ts` was deliberately NOT wired into the family migration: it builds a
  single-figure pseudo-project, and healing a 1-element slice renumbers it to 1 — a wrong
  watermark. Healing is only meaningful over the full collection.
- The old `Figure ${count+1}` default (count-not-max) duplicated names after a delete; identity
  now appends via the normalizer, and `blankFigure` call sites route through `ops.createFigure`
  so a new canvas's backfill figure APPENDS instead of claiming "Figure 1".
- `EmbedWidget.eq()`/`updateDOM` compare cached display fields — a new derived field
  (`captionLabel`) MUST join those comparisons or family renumbering never repaints embeds.

### 2026-08-04 — Reader tabs + two PDFs side by side (Claude Fable 5, `reader-tabs`)

**Work:** Owner request: open several papers without re-finding them, and two PDFs at once.
Three commits: (1) behavior-preserving extraction of `ReaderDoc.svelte` (~90% of ReaderMode;
`citekey` immutable per instance kills the staleness guards; the shared terminal stays in the
shell — one mount, `agentPane` snippet rendered by the active doc; reader-context.json gains a
module-level owner token; `ReaderFind` gains a `key` so fresh mounts ignore stale find intents)
— the full existing reader suite green with only two source-shape regex retargets (r3/p4).
(2) Tabs: `readerTabs` store (persisted `flux-reader-tabs`, lazy session restore),
`readerKey` now a read-only derived view, keep-alive `MAX_LIVE_DOCS = 3` with destroy-time
view flush, tab strip (`ReaderTabs.svelte`), Ctrl+Tab/W/PageUp/Down chords, `verify-r7-tabs`
(46 checks), NEW `group:reader-gate` + the previously-MISSING `src/shell/modes/reader/**`
pathMap entry. (3) Split: `paneId` threads Pane → ModeContent → mode; `paneActiveTab`
per-pane assignments with pin-before-retarget; Alt-click a tab → `openReaderTabInSplit`;
`annotationsRev` cross-view sync; `readerTerminalPane` exclusivity. Architecture promoted to
§4. Also fixed rotted `verify-w5-lifecycle` (pre-families raw `name` write → nickname).
**Learnings:**

- pdf.js viewers survive `visibility:hidden` keep-alive fine (scroll/zoom state intact on
  reveal) — the ModeContent pattern generalizes to N documents within a mode unchanged.
- A restored-at-boot document instance mounts before dev-seed hooks can run — gates that
  reload the page must treat the boot-active tab as load-degraded and assert lazy activation
  instead (real disk reads don't have this race).
- Cross-view sync of a store that components ALSO update optimistically needs writer
  self-suppression by COUNT (one bump per bridge mutation, unconditional even on no-op
  updates) — reload-on-own-write would transiently duplicate keyed-each ids and cold the
  locate cache.
- Pane-scoped gate probes: every `.pane` is alone in its `.slot`, so `.pane:first-child` AND
  `.pane:last-child` both match — and puppeteer clicks the first. Scope by index +
  coordinate-click (real pointerdown so the pane's focus capture fires).
- A selection-anchored popover renders off-viewport when the target page is scrolled away
  (top: -1200px) and a coordinate click on it silently no-ops — navigate the page into view
  before driving selection UI.

### 2026-08-04 (later) — Reader panels: rails, Cited-by, row PDFs, Alt+R library (Claude Fable 5, `reader-tabs`)

**Work:** Owner's screenshot review of the reader. Both sidebars are now drag-resizable
(new `readerLayoutStore.ts`, key `flux.reader.layout`; the FigureMode `railDrag` factory +
CSS vars on `.rbody`, gutters as flex siblings OUTSIDE the scrolling asides, dblclick
resets) — widths are module-global while VISIBILITY stays per-paper in `flux-reader-view`.
Left rail gained a **Cited by** tab (forward citations through the already-shipped
`citingWorksByKey`; Most-cited ⇄ Newest toggle, ⟳ refresh, and a new derived cache
`<FluxLib>/.fluxlib/citers.json` — deliberately NOT in enrich.json, whose grid projection
strips exactly this kind of heavy edge field; a citer list also grows forever, so it needs
a refresh story a reference list doesn't). Reference/citer rows share ONE `briefRow`
snippet and offer **Open PDF** when the brief is in FluxLib with a PDF on disk (batched
`pdfPresence` store, hoisted `modes/paper/scholar/` → `lib/references/`; DOI now opens via
`fileBridge.openExternal`, the house call). **Alt+R** summons a library-search panel in the
right rail (new `ReaderLibraryPanel.svelte`, `query.ts`'s `createQueryRunner` +
`attachHaystacks`, no debounce — §6 flags the Library's 150ms as a bug, not a pattern); it
is a PANEL, sticky in `readerLayout.rightTab`, and Escape deliberately does not dismiss it.
Tab drag-reorder (live reorder as the pointer crosses a neighbour's midpoint; keyed each
means no document remounts). New gate `verify-r8-reader-panels.mjs` (30 checks) joins
`group:reader-gate` (16); `listPdfKeys` now counts dev-seeded items so the row affordance is
drivable headlessly. check 0/0, pure 149/149, reader-gate 16/16.
**Learnings:**

- **Reader PDF residency is ~2× per open doc, and item 1.6 of the V1 readiness review is
  CLOSED, not deferred** (review line 97; line 514 is the superseded open-items entry — an
  earlier note in this session repeated it wrongly). pdf.js passes `data.buffer` in the
  postMessage TRANSFER list (`GetDocRequest`, pdfjs-dist 6.1.200), so the bytes are detached
  into the worker rather than cloned — which is exactly why `PdfView` copies the master
  first (`buffer.slice(0)`): without the copy, the transfer would detach the doc's own
  buffer and break Switch-PDF and external-change remounts. Only the master-buffer
  re-architecture (re-read from disk instead of holding a renderer copy) is unbuilt, and it
  was judged unwarranted. Verify claims like this against `node_modules` before repeating them.
- A gate that needs a real FluxLib must boot `?fixture=demo`, not `clickNew` — `ensureFluxLib()`
  returns null without a resolvable lib, so `__fluxSeedScaleLibrary` silently seeds nothing
  (`{lib: null, entries: 0}`) and every library-dependent assertion fails for the wrong reason.
- `createQueryRunner()` returns the runner FUNCTION itself, not an object with `.run`.

### 2026-08-04 (later) — Paper tables: full editing tier + rich cells + export fit (Claude Fable 5, `reader-tabs`)

**Work:** Owner-reported table rendering/formatting issues → implemented the B3 editing tier in
full. New shared grammar `science/tableModel.ts` (markdown-it-faithful parse + canonical
serializer + TSV/CSV converters), `editing/tableOps.ts` (Tab/Shift-Tab/Enter cell nav, row/col/
align ops, same-transaction auto-reflow via transactionFilter), `science/tablePaste.ts`
(TSV→table outside, Excel-splice inside, pipe-escaping), rich widget cells (inline md + lazy
KaTeX + resolved cites/crossrefs via mdInline resolver hooks), widget cell-click→source +
hover bar (+Row/+Col/Format/Copy-as-TSV) + Alt-click header alignment, @tbl-/@eq- completion,
tbl/eq hover-card branches, jump-to-table (fixed the `revealFigure("")` no-op), labeled /table
snippet, and export: table+caption bound into one `.tblblock` with zoom-to-fit for over-wide
tables (PAGINATOR/TBLFIT CSP hashes refreshed). Gates: verify-table-model.ts,
verify-table-ops.ts (pure), verify-paper-tables.mjs (ui, 28 checks); paper-gate now 19.
check 0/0, pure 152/152, paper-gate 19/19, scale-paper 7/7. Docs: paper.qmd Tables section
(also fixed the false `@sec-` claim), shortcuts.qmd.
**Learnings:**

- **verify-scale-paper's sentinel offsets were stale**: it precomputed all three burst positions,
  then each burst's 18 inserts shifted the later sentinels — the "cell" burst actually typed at
  the table's HEADER-line start (corrupting the fixture into a header/delim column mismatch the
  markdown-it-faithful parser rightly rejects) and the "cite" burst typed OUTSIDE the group.
  Offsets are now recomputed per burst, and the cite anchor moved out of the table field's
  guardLines — co-located anchors measured table rebuilds, not cite machinery.
- `.cm-lineWrapping`'s `overflow-wrap` INHERITS into block widgets: table cells mid-word-broke
  ("1.11" → "1."/"11") until the wrap reset it. And a widget's min-content propagates through
  the scroller's flex sizing — `width:0; min-width:100%` on the widget is the canonical cut.
- Chromium cannot text-select inside a `contenteditable=false` island nested in an editable
  host — widget text selection is a dead end; cell-click-to-source + a Copy-as-TSV button are
  the better interaction anyway.
- puppeteer's `mouse.click(x, y, {clickCount: 2})` alone does NOT synthesize a `dblclick` DOM
  event here — use the figenh-16 recipe (down/up, then down/up with clickCount 2, no move
  between). CDP-level "real" dblclick testing is otherwise silently skipped.
- A transactionFilter returning `[tr, {changes, sequential: true, selection}]` merges into ONE
  transaction and one undo unit — the right shape for typing-time normalization. Gate it on
  `isUserEvent("input")||("delete")` and composition, or undo/agent edits get reformatted.

### 2026-08-04 — Outline missed headings until the next keystroke (Claude Fable 5, `reader-tabs`)

**Work:** Owner-reported: well-formed headings absent from the paper outline until you type at
(or near) their line. Root cause: `getOutline` walked the bare `syntaxTree(state)` — CodeMirror
parses lazily (init ≈ first 3k chars, edits parse only to the viewport, the background worker
commits progress via NON-doc-change transactions and stops ~100k past the viewport) — while the
outline refreshed only on `docChanged`, so headings past the parsed prefix never arrived. Fix:
`getOutline` forces a bounded whole-doc parse (`ensureSyntaxTree(state, doc.length, 50)`, the
livePreview pattern, partial-tree fallback); PaperMode gained a parse-progress listener
(`!docChanged && syntaxTree(u.state) !== syntaxTree(u.startState)` → `scheduleIdle`) and
`refreshIdleNow` self-reschedules while `!syntaxTreeAvailable` so giant docs converge. New gate
`verify-outline-refresh.mjs` (ui + paper-gate, now 16) — teeth proven: fails pre-fix on a ~950k
doc's tail heading, passes post-fix; paper-gate 16/16, check 0/0.
**Learnings:**

- **Bare `syntaxTree(state)` is a partial tree** — any whole-document consumer must
  `ensureSyntaxTree(state, state.doc.length, budget) ?? syntaxTree(state)` AND re-run when the
  parser catches up, because worker commits are `docChanged === false` transactions that
  `onChange`-driven refreshes never see. Viewport-scoped consumers (chips) are exempt.
- The background parser never parses past viewport + 100k chars on its own; a consumer that
  needs the WHOLE tree on a giant doc must keep pulling (self-rescheduling idle tick on
  `!syntaxTreeAvailable`) or the tail stays unparsed forever.

### 2026-08-04 (evening) — Reader UX cleanup: search pane, panel chords, terminal drawer (Claude Fable 5, `reader-tabs`)

**Work:** Owner's annotated-screenshot pass. (1) The inline find bar and its magnifier are
GONE: Ctrl+F now opens a **Search tab** in the left rail listing every match with context,
grouped by outline section (falling back to per-page) — new pure core
`src/lib/pdf/findMatches.ts` (`groupMatches`, gated by `verify-reader-search.ts`) plus three
PdfView exports: `collectMatches()` (read off the find controller's own `pageMatches` +
folded page text, so the list can never disagree with the painted highlights),
`goToMatch()`, and `outlineSections()` (dests resolved to page numbers via `getPageIndex`).
(2) The `☰ References (n)` and `Notes (n) ✎` text buttons became panelLeft/panelRight icons
(filled when open); Ctrl+B / Ctrl+Shift+B toggle the rails, Alt+A opens the Annotations tab,
Alt+R still the Library tab. (3) The ✦ Ask AI toolbar button is retired and Ctrl+J with it —
**Alt+T** toggles the terminal (matching Paper), the drawer resizes by dragging its top edge
(`readerLayout.terminalH`, dblclick resets), and both ✦ affordances now read "Send passage to
terminal" (the user is assumed to have an agent running there). (4) Tab drag-reorder.
Gates: r8 grew to 55 checks; r2/r7/scale-reader find legs repointed at the pane (contract
changed deliberately — the counter is now "N of M" and the pane lists every hit); r3's
popover pin follows `askClaudeAbout` → `sendHighlightToTerminal`. pure 150/150, check 0/0.
**Learnings:**

- **pdf.js's find controller re-reports its position several times per advance** (and again
  after a jump lands). Driving UI state from `updatefindmatchescount` makes the counter walk
  backwards; the fix is to let OUR match list own "which hit is current" and treat the
  controller as a paint engine. Same trap in reverse: dispatching a step per event
  double-advances and wraps — dedupe on the position you stepped from.
- **Never dispatch a `find` while the controller has a page pending extraction** — it logs
  "There can only be one pending page." and the reader gates fail on console errors. Worse,
  its own resume guard is `if (this._resumePageIdx)`, so page index 0 is falsy and a fresh
  search landing on page 1 trips the check from inside pdf.js. Jump by STEPPING an
  already-scanned query (type "again"), never by re-issuing type "" — a fresh find resets
  and re-extracts every page.
- A gate that clicks "the last result row" must select `li:last-child .hit`, not
  `.hit:last-child` — a button that is its `<li>`'s only child matches `:last-child` in
  EVERY row, and puppeteer clicks the first. This produced a convincing false failure.
- Retiring a chord means grepping the GATES too: Ctrl+J lived on in r7's split legs and the
  inline find bar in r2/r7/scale-reader. `group:reader-gate` caught all of them in one run —
  the pathMap entry added earlier that day paid for itself immediately.

### 2026-08-04 — Export system: file format × journal style, first preset Nature (Claude Fable 5, `export-styles`)

**Work:** Built the export system end to end in a worktree off `main` (6 commits): the export
dialog (format × style, output path for EVERY format, progress + cancel, Alt+E) over ONE shared
prep core (`src/lib/exportPrep.ts` — the include walker and the transform/restore dance existed
twice, in flux-core and PaperMode, with their own INCLUDE_RE); the journal-style core
(`src/lib/style/**` — sparse versioned descriptors merged over a DEFAULT that reproduces today's
export byte-for-byte); the Nature preset; journal Word + PDF via a vendored CSL, a generated Word
reference-doc and an ephemeral Quarto `--profile`; section roles + export-time ordering
(`src/lib/manuscript/sections.ts`); and Journal Check (`compliance.ts` + an Alt+J margin pane).
Nature's rules were established twice — nature.com plus an empirical count over 88 Nature-proper
PDFs in the owner's FluxLib — and the corpus corrected the docs twice over.
**Learnings:**

- **A journal style is EXPORT-ONLY; the writer never restyles** (owner decision). This does NOT
  violate the editor/export parity invariant that `references/format.ts:6-11` and
  `citeNumbering.ts:1-10` warn about: that warning is about ORDINALS AND IDENTITY diverging (the
  editor saying reference 5 while the export says 7). Presentation differing while numbering and
  `(family, number)` stay shared is a different thing entirely. `verify-writer-neutral.ts` pins it,
  including a source pin that six editor-owned modules import no style module at all.
- `exportCtxFigures` (`scholar/figures.ts`) was ALREADY the export-only projection of figure
  identity, so styling the export is a wrapper around one line there. Look for the seam that
  already exists before opening up an invariant — an earlier draft was going to relax
  `familyMap`'s rule that project data can never shadow builtin families, and did not need to.
- **Flux auto-formats what it OWNS; it advises on what the author typed.** FluxProjection contains
  "Gao Figure 2D establishes …" — another paper's figure, 3× — and the original plan would have
  rewritten it to house style, corrupting a citation. Worse, suppressing only the mention adjacent
  to the author name is not enough: authors introduce "Gao Figure 2D" once and write plain
  "Figure 2D" after, so a number seen ONCE beside an author is foreign for the whole document.
- A surname heuristic needs a not-a-surname list, or "See Fig. 2a-c" reads as an author called See
  and silences real advice. Both misses were caught by writing the firing AND silent fixture for
  every rule.
- Quarto `--profile` + `_quarto-<name>.yml` is how to style a render without ever editing the
  user's `_quarto.yml` or their front matter. Two traps: a YAML literal block's content must be
  indented DEEPER than its `text: |` key or Quarto rejects the profile, and `pdf` and `latex` are
  separate format keys — settings under `pdf:` do not reach `--to latex`.
- Word line numbering is a SECTION property (`w:lnNumType` in `sectPr`), which pandoc copies from
  `--reference-doc`. `scripts/gen-reference-docx.mjs` builds that template from pandoc's own
  default so the committed artifact is reproducible rather than hand-made.
- **lualatex, not pdflatex, for science manuscripts** — verified, not assumed: pdflatex fails
  outright on "α (U+03B1)". Journal PDF also needs `lineno`, `setspace`, luaotfload/Times fonts,
  and `rsvg-convert` for Flux's SVG figures; each failure log is unreadable, so
  `diagnoseQuartoFailure` maps them to one actionable sentence each.
- A style that `extends` another must reuse its parent's SHIPPED assets (`assetKey`, resolving own
  → parent's → own id). Keying them off the leaf id made `nature-communications` ask for files that
  never ship — found only by sweeping the full format × style matrix, not by any single export.
- Source-shape gates should assert the FIELDS a signature destructures, not the exact list: my own
  `quarto:render` pin went stale the moment I added two more fields in a later phase.
- Parallel worktrees each need their own dev-server port; `driver.mjs` already honours `FLUX_URL`,
  but gates that hardcode `:1420` do not. `verify-paper-export.mjs` now builds its URL from it.

### 2026-08-05 — Supplements: the Science-supplement regression, and capturing SI on purpose (Claude Fable 5, `main`)
**Work:** Fixed — for the second time, properly this time — the bug where fetching a *Science*
paper stored its **supplementary material** as `paper.pdf`, and turned the discarded supplement
links into a feature. New `electron/supplementRules.cjs` (+ `.d.cts`) is the single source of
truth for "article or supplement", shared by the capture engine, both write paths, the repair and
the gate. `proxyFetch.cjs` now RANKS candidates instead of consuming them in DOM order, partitions
supplements out, and — on request — captures them from the page it is already authenticated on.
`writePdfItem`/`writePdf` verify every automated acquisition before it can become `paper.pdf` and
divert a supplement to `supplements/` instead. Plus a labelled `supplements/manifest.json`, Europe
PMC's supplementary-files archive for the OA route (`supplementFinder.ts` + a dependency-free
`unzip.ts`), a `flux fetch-supplements` verb, and the 4 damaged library items repaired.
Full analysis: `notes/Flux_Supplement_Capture_Report.md`.
**Learnings:**
- **The 2026-07 fix failed because it was all input-side pattern matching.** It filtered candidate
  URLs against a regex; science.org changed its template to link `/doi/suppl/<doi>/suppl_file/…`
  (no substring "supplement", and `devivo-sm.pdf` uses a HYPHEN where the regex wanted `_sm.pdf`)
  and the guard silently stopped applying. Pattern-matching publisher HTML has no floor. The
  durable half of this fix is the check on the way OUT — at the write point, against the URL the
  bytes actually came from **and** the document's own first page.
- **A mitigation coded as "insert if absent" when it meant "put first" is a no-op exactly when it
  matters.** The AAAS guard did `if (!candidates.some(c => c.url === sci)) unshift(...)`. Every
  modern Science page already links `/doi/pdf/<doi>`, so the dedupe fired and the supplement kept
  its DOM-order lead. Ordering is now a scoring function, not a special case.
- **A gate that re-implements the logic under test proves nothing.** `verify-supplement.ts` mirrored
  the engine's candidate pipeline and asserted against the copy — and its fixture omitted
  `/doi/pdf/<doi>` from the scraped list, so the dedupe branch it needed to exercise never ran. The
  live case (`science.aap8586`) passed for an unrelated reason: that article's page exposes no
  supplement anchor at all. Both gates were green throughout. They now call shipped functions and
  use the two DOIs that actually reproduce.
- **Validate a content heuristic against the corpus that contains the thing you're about to
  break.** The content rules scored 4/4 with zero false positives over all 1,051 stored PDFs — but
  that corpus held the four SUPPLEMENTS, not the four main texts they were about to be replaced by.
  The first real re-fetch then rejected a perfectly good Takahashi 2016: Science's print layout
  carries the *previous* article's tail onto page 1, bare "SUPPLEMENTARY MATERIALS" heading and
  `suppl/DC1` URL included. The rule is now "the banner must say **for** <something that isn't
  itself>", which separates a supplement's masthead from both an article's section heading and its
  "supplementary material for this article is available at…" pointer.
- Text extraction preserving line structure is load-bearing here: `joinTextItems` emits `\n` on a
  baseline jump, so "starts a line" is a usable test and is what distinguishes a masthead from a
  mid-paragraph mention. Don't squash whitespace before asking a positional question.
- **The manifest is advisory; the disk is the truth.** Dedupe keyed only on `manifest.json`'s
  sha256 laid down `-2` copies of every supplement the repair had moved (its records predated
  hashing). Both filing paths now compare against the bytes actually on disk before suffixing.
- Europe PMC's supplementary-files endpoint is `…/rest/{PMCID}/supplementaryFiles` — **without**
  the `/PMC/` source segment every other Europe PMC endpoint takes; the documented form 404s. It
  serves the OA subset only, and it bundles the article's own figures in with the supplements. The
  filter that works is inverted: keep every non-image, keep an image only if it's named as a
  supplement. Enumerating figure-name shapes (`_f001.jpg`, `-g5.gif`, `_Fig11_ESM.jpg`,
  `_Tab1_ESM.gif`) failed on the first publisher it met.
- No new dependency was needed to read those ZIPs: `DecompressionStream("deflate-raw")` is native
  in both Node 20+ and Chromium, and STORED/DEFLATE is all these archives use.
- Supplement capture is ON for single user-initiated fetches and OFF for bulk. This library has
  been IP-blocked twice for publisher request volume; a few extra GETs per paper is fine for one
  paper and is not fine for a thousand. The repository route (`flux fetch-supplements`, EBI only)
  is the safe sweep.
- **TRAP — a source `.cjs` that the renderer imports passes `vite build` and breaks `vite dev`.**
  The shared rules started life as `electron/supplementRules.cjs`, because Electron main is
  CommonJS and `src/` is excluded from the packaged app. `npm run check` was clean and
  `vite build` succeeded (Rollup's commonjs plugin converts it), but the DEV server serves a
  source `.cjs` **verbatim** — `module.exports` never runs in a browser, so the module has no
  named exports and *every* importer dies at load with "does not provide an export named …".
  The whole app was blank in dev; every UI gate failed with an unhelpful 15s timeout. The fix is
  `electron/supplementRules.js` as plain ESM, with `proxyFetch.cjs` (CommonJS) reaching it via
  `await import()` — a module-scope promise awaited at the top of each capture, with thin
  wrappers so the synchronous CDP callback still reads correctly. `scripts/verify-proxy-capture.cjs`
  does the same. Two lessons: **a green `svelte-check` + `vite build` does not mean the app
  loads**, and when a batch of unrelated UI gates all start timing out, open the page and read
  its console before believing the gate.
- **Live gate: 10/10 required publishers pass** (APS, OUP, Wiley×2, AAAS×3 including both
  reproducing DOIs, PNAS, Cell Press, Nature) with the two known anti-bot walls unchanged, so
  candidate RANKING regressed nothing. Getting there was its own lesson: a first run sat for 37
  minutes emitting NOTHING, which read like a hang in the gate but was Electron itself wedged on
  this box — a script that does nothing but await `app.whenReady()` also hung, with or without a
  private `--user-data-dir`. **If a gate produces zero output, check that Electron can become
  ready at all before debugging the gate.** It cleared on its own later. (The run did wedge in
  `engine.dispose()` afterwards, so the leaked-window check never printed — untouched teardown
  code, worth re-confirming on a clean machine.)
### 2026-08-04 (late) — Local correction fabric (Codex, `codex-local-completion`)
**Work:** Added Paper's entirely local, worker-backed correction fabric with conservative
mechanical ranking, sentence-boundary scheduling, zero-layout pulse/fade feedback, one-step Undo,
project dictionaries/veto learning, controls, user docs, and pure/UI/bundle gates. Verified the
real browser flow, full Paper and pure suites, Electron latency, production build/package, and the
worker's `file://` initialization under Flux's sandbox and CSP.
**Learnings:**
- A dictionary candidate is not enough for silent scientific editing: arbitrary substitutions
  can turn *somata* into *sonata*, while Harper labels *timepoint* → *time point* as a typo.
  Automatic local edits must be mechanical; semantic/style ambiguity belongs to a later model tier.
- Heavy local WASM stays compatible with instantaneous typing when it is idle-warmed in a lazy
  module worker, triggered only at sentence boundaries, and its result is position-mapped plus
  exact-source-validated before one isolated-history transaction.
- Corrected the verification guide: `FLUX_URL` now remaps legacy `gotoApp` calls that hardcode
  `:1420`; direct navigations still need `APP_URL`.

### 2026-08-05 — Local dictionaries and aliases (Codex, `codex-local-completion`)
**Work:** Extended Paper's local correction fabric with migrated project/Personal dictionaries,
selection-scoped Word tools, Vim-proof toggle chords, conservative technical-term matching, and
same-transaction aliases with exact Undo/removal paths. Focused gates cover persistence, scope
precedence, the `iGluSnFR4f` near miss, protected syntax, live UI, and real Vim visual mode. Final
verification was 23/23 Paper, 160/160 pure, scale-paper, real Electron latency, production bundle,
startup, and unpacked-package green.
**Learnings:**
- Explicit language data and learned correction vetoes need separate reset semantics; clearing a
  behavioral lesson must not silently erase a scientist's chosen terms or abbreviations.
- An alias expander can stay instantaneous and preserve native Undo by appending a sequential
  replacement in the delimiter's CodeMirror transaction; no worker or timer belongs on that path.
- Corrected `verify-writer-latency-inp.mjs` to match the existing Linux harness rule and run
  alongside an open Flux instance: real probes need `--ozone-platform=x11`, and the harness must
  isolate `XDG_CONFIG_HOME` plus the FluxConfig pointer because production deliberately pins
  `userData` before taking its single-instance lock.

### 2026-08-05 (later) — Contextual correction layer and managed local model (Codex, `codex-local-completion`)
**Work:** Implemented the reviewed contextual-correction plan over the word-level Harper fabric.
Completed words now enter Harper immediately; completed scientific sentences produce bounded,
versioned candidate packets for a second judgment lane. That lane can use Flux's managed local
Qwen3 4B Instruct 2507 Q4_K_M runtime, an existing loopback Ollama model, or an explicitly configured OpenAI
key. It never asks a model to rewrite prose: the model may only keep or accept precomputed Harper
suggestions, and a renderer guard independently revalidates snapshot identity, exact source,
protected spans, dictionaries, vetoes, overlap, edit count, and mechanical rank immediately before
the edit. Added a durable Personal/project profile bridge (dialect, guidance, vetoes), cancellation,
FIFO/backpressure, deadline fail-open behavior, correction-scoped Undo, stale/touched-range
rejection, settings/model lifecycle UI, and full Paper documentation.

Flux's local manager pins the exact Ollama-published Qwen3 4B Instruct 2507 GGUF blob and SHA, llama.cpp release/commit and
per-platform archive/server SHAs; downloads are resumable, cancellable, hash-checked, atomic, and
confined to the correction-runtime data directory. The main process owns a random-loopback,
token-protected llama-server, abortable cold start, 30-minute idle unload, one crash restart, and
fail-closed restart-storm handling. Release builds stage both macOS architectures and their native
terminal dependencies. The optional cloud adapter is fixed to the Responses API with strict JSON,
`store:false`, no reasoning, encrypted key storage, payload disclosure, and no cloud fallback.

Built a deterministic 3,500-case synthetic corpus and reproducible evaluator covering clean text,
single/multi-edit sentences, ambiguity, scientific terms, protected syntax, project vocabulary,
paragraphs, and race cases. On the selected direct, non-thinking contract, the Flux-managed path
made 430/430 accepted shipped-policy edits correctly (100% observed precision; 99.11% Wilson lower
bound; 97.73% coverage; p50 71 ms, p95 88 ms), while Ollama made 420/420 correctly (99.09% Wilson
lower; 95.45% coverage; p50 181 ms, p95 259 ms) on the same GPU host and fixed 2,048-token context.
The otherwise identical batch contract covered 89.77% with weaker order stability and p50 268 ms;
thinking produced no decision improvement; paragraph packets were only 50% precise and therefore
are not shipped. The real-call audit was 8 calls / 923 words (8.67 per 1,000). Reports and corpus
hashes are committed under `artifacts/flux-correction-eval/`.

Final verification: TypeScript/Svelte check 0/0; all 163 pure gates accounted green (160 in the
restricted runner plus the three filesystem-dependent gates individually); Paper 26/26; local
correction UI 41 checks; scale-paper 7/7; margin/background green; contextual provider 23 checks;
managed runtime 40 checks; evaluator 29 checks; contextual provider 31 checks; the final real-Electron
responsiveness run measured 0 ms ambient and correction-observer INP deltas; production build,
bundle/startup 3/3, Linux unpacked package, packaged schema-inference smoke, IPC completeness, and
packaged runtime hash all green. macOS arm64/x64 helper archives and executables were downloaded and hash
verified. Native M5 thermal/memory soak and Apple signing/notarization remain hardware/identity
acceptance checks rather than checks this Linux host can perform.
**Learnings:**
- **Bounded selection beats generation for invisible writing assistance.** A tiny direct contract
  over one marked candidate was more accurate, faster, more stable under candidate shuffling, and
  cheaper than batching. Letting the model synthesize replacement text would bypass every useful
  provenance and deterministic-safety invariant.
- **Sentence context is the useful local-model frontier for this tier.** Paragraph context did not
  merely cost more; it materially reduced precision. Keep project guidance and vocabulary in a
  bounded packet, but do not defer several sentences into one decision until evidence reverses
  that result.
- **A timeout must release the editor without killing useful cold-start work.** Race the request
  deadline against a separately owned warmup, keep only three queued sentences, and let later
  sentences benefit if startup finishes. User typing and selection changes still invalidate the
  old packet before any result can land.
- **Hash verification belongs at both acquisition and execution.** An atomic downloaded manifest
  is not enough: rehash the GGUF before first launch and whenever its fingerprint changes, and
  reject equal-size tampering before spawning the server.
- A real responsiveness gate can expose an unrelated compositor cost. Paper's animated margin
  canvas needed a desynchronized opaque context and a short keydown yield; after that correction-on
  and correction-off probes were indistinguishable within the gate's noise floor while idle motion
  remained smooth.

### 2026-08-05 (final) — Local-provider readiness and GPU bakeoff (Codex, `codex-local-completion`)
**Work:** Reproduced the reported `correction:decide` timeout and hardened both local providers.
Managed llama.cpp now disables Qwen reasoning at startup and per request, reserves a full 2,048-token
context in each of two slots, requires a schema-valid prime before reporting ready, and fully offloads
the pinned helper to Metal on Apple Silicon or Vulkan on Linux. Ollama now coalesces explicit structured
warmups, holds the runner for 15 minutes, fixes `num_ctx` at 2,048 instead of the model's 262,144-token
default, and lets cold loading finish for the next sentence even when the editor has already cancelled
the current one. The main-process provider deadline is 8 seconds while the renderer's 1.5-second silent
mutation window remains authoritative.

The first managed benchmark exposed a deeper invalid comparison: it used the older hybrid Qwen3-4B
weights, not Ollama's successful Instruct-2507 artifact. Flux now pins the exact 2,497,280,480-byte
`qwen3:4b-instruct` model blob (`85e4a5b7…54b18b9`) and uses independently held-out-calibrated prompts
for llama.cpp and Ollama. On the locked 700-case held-out partition × three shuffled repeats, managed
scored 430/430 shipped edits with 97.73% coverage at 71/88 ms p50/p95; Ollama scored 420/420 with
95.45% coverage at 181/259 ms. Both had zero provider failures, zero protected changes, and 100%
decision stability. `ollama ps` confirmed 100% GPU/2,048 context; the unpacked Flux helper detected the
RTX PRO 5000 through Vulkan and completed a real packaged schema inference.

**Verification:** check 0/0; pure 163/163 accounted (160 in restricted runner plus three environment-
dependent passes outside it); Paper 26/26; scale 7/7; correction UI 41 checks; provider/runtime/eval
31/40/29; writer INP correction delta 0 ms; build, bundle/startup 3/3, Linux unpacked package, packaged
GPU detection and packaged inference green; pinned darwin-arm64 Metal and darwin-x64 CPU archives
downloaded and manifests verified.

**Learnings:**
- A listening health endpoint is not model readiness. Prime the exact structured contract before the UI
  says warm, especially for reasoning-capable models whose output budget can disappear into hidden work.
- Model labels such as “Qwen3 4B Q4_K_M” are not identity. Benchmark evidence must pin weights, template,
  context, engine, accelerator, and prompt; the older hybrid artifact was fast but failed the precision gate.
- GPU backends can cross close decision boundaries even with identical quantized weights. Small local-model
  prompts need backend-specific calibration against the same locked corpus; the renderer guard stays common.

### 2026-08-05 (late final) — Bounded spelling rescue and disjoint confirmation (Codex, `codex-local-completion`)
**Work:** Extended the sentence lane so Qwen can rescue an exact unresolved spelling span when
Harper's proposals are inadequate, without gaining sentence-rewrite authority. Added a post-freeze,
lexeme-disjoint 128-case confirmation corpus and same-case none/local/full ablation; the real selected
paths retained 100% measured precision while bounded generation raised Ollama coverage from 85.94%
to 93.75%, and Flux-managed Vulkan reached 96.88%. Final verification accounted for pure 163/163,
Paper 26/26, scale-paper 7/7, focused contracts 209 checks, live correction UI 44 checks, check 0/0,
bundle/startup 3/3, Electron INP, release packaging, runtime hashes, GPU offload, and real packaged
schema inference. Updated the authoritative correction architecture in the guide body and Paper docs.
**Learnings:**
- Benchmark a new fallback on the exact same cases as the old path. A separate rescue-only stress set
  can prove the mechanism works but cannot establish its total-coverage value.
- Model-generated spelling remains bounded enough for invisible editing only when generation,
  scientific-term preservation, fresh contextual approval, local lexicon proof, and renderer
  source/policy validation are independent gates.
- Harper can label a split into two valid words as a typo. The instant lane must verify both parts and
  defer insertion/deletion ambiguity so a bad word-level edit cannot preempt better sentence context.
- Chromium omits sub-16-ms Event Timing entries and can deliver observations after a phase reset.
  Responsiveness gates must count actual keydowns, timestamp phase membership, and treat unreported
  delivered keys as conservatively censored samples rather than missing data.

### 2026-08-05 — Visible judgment lifecycle and recall controls (Codex, `codex-local-completion`)
**Work:** Added Flux-owned red pending, blue accepted, and persistent clickable orange abstention
states for contextual spelling, plus Standard, Aggressive, and Really aggressive bounded-recall
modes. The unchanged 128-case confirmation set and a separate 24-case hard stress set show why the
wide opt-in mode matters: Ollama retained 100% measured precision and zero protected changes while
moving hard three/four-edit coverage from 0/12 (Standard) to 10/12, without rewriting authority.

**Learnings:**
- When product state owns a spelling span, suppress the browser's native marker only on that span;
  otherwise a red native squiggle can contradict Flux's orange abstention state.
- Compare policy modes on one untouched corpus, then use a separately named stress corpus to explain
  the affected failure class. Never present stress-only gains as a general-coverage improvement.
- Derive “accepted” visual state from the final editor-protected plans, not an earlier model/guard
  result, so every rejected mutation visibly settles rather than leaving a false pending state.

### 2026-08-06 — Codex correction fabric merged to main (Claude Fable 5, `codex-local-completion` → `main`)
**Work:** Reviewed Codex's full correction-fabric work (3 commits + a large uncommitted
contextual-lane/managed-runtime tree), committed the in-flight work on its branch, rebased the
branch onto main (7 supplement commits had landed since the merge base; conflicts were
append-append in this guide plus list-adds in verify-manifest/preload/types), and fast-forwarded
main. Post-merge acceptance on main: check 0/0, pure 163/163, paper-gate 26/26, scale 7/7,
build clean, bundle+startup 3/3, curated ui 59 accounted (58 in the sweep + the corrections gate
fixed and re-run 3× green — see below).
**Learnings:**
- `verify-paper-local-corrections` flaked under load at "one-step correction undo": it typed the
  whole two-typo sentence at 3ms/key and asserted the fixes landed as TWO history batches, but
  batch count during continuous fast typing is worker scheduling, not contract — under load both
  fixes coalesced into one batch and a single Undo (correctly) restored both. A gate that asserts
  history-batch scoping must construct the batches deterministically: wait for the word-lane fix
  before typing the second typo. Every assertion kept; nothing loosened.
- Rebase-then-ff keeps the linear main history through a 4-commit divergent worktree; the only
  human decision was session-log entry order (append order of landing, not strict datestamp).

### 2026-08-06 (later) — "Model installed but nothing works": the unstaged dev runtime + backlog flagging (Claude Fable 5, `main`)
**Work:** Owner report: the managed Qwen layer did nothing on main — Settings said "Install the
Flux local model" although the model card showed installed, and remove/re-download didn't help.
Root cause: the pinned llama-server lives in gitignored `build/correction-runtime/<platform-arch>/`,
which is a PACKAGING artifact — Codex had fetched it only inside the worktree, so a fresh checkout
(or this main tree) has the model under FluxConfig but no helper binary; `status().available` is
false while `installed` is true, and the message pointed at the wrong remedy. Staged the runtime
here (copy from the worktree ≡ `npm run fetch:correction-runtime`), proved the full path live
(warm+prime 2.6 s, one structured decision 94 ms on Vulkan), and gave Settings a discriminating
branch (`managed.runtime == null` → "runtime missing — run npm run fetch:correction-runtime").
Then built the owner-requested BACKLOG FLAGGING (details promoted to §4): opened/switched
documents get idle-paced Harper-only red flags, no edits, no model calls. New pure coverage
(`backlogScanWindows` + `harperLintsOnly`, verify-local-corrections 99) and a live gate section
(verify-paper-local-corrections 55); paper-gate 26/26, scale-paper 7/7, check 0/0.
**Learnings:**
- A source checkout needs `npm run fetch:correction-runtime` ONCE before the managed correction
  provider can run — `npm install`/`npm run build` do not stage it (deliberately: 32 MB pinned
  binary). Anyone cloning or working in a fresh worktree hits this; the Settings message now says
  so instead of blaming the model.
- When a feature spans a durable user asset (the model in FluxConfig) and a per-checkout build
  artifact (the runtime), every status string must distinguish which half is missing — "reinstall
  the model" was a plausible-looking dead end that cost the owner a 2.33 GB re-download.
- The backlog scan skips the caret's chunk. That isn't only politeness to the live lanes — it's
  what keeps every existing typed-fixture gate deterministic (their single-paragraph docs always
  contain the caret, so background scans can never race their assertions).

### 2026-08-05 — Install-docs harmonization + dependency audit fix (Claude Opus 5, `main`)
**Work:** Compared README / `installation.qmd` / `claude-install-flux-mac.md` against the code
and against a real fresh-Mac install, then fixed what diverged: `npm audit fix` clearing 13
advisories, `electron:build` running the full build, a documentation correction pass, honest
per-condition errors from the Lighttable launch handler, and a dependency-advisory gate
(`release-check` step 2 + a weekly `audit.yml` that opens an issue). Added `TODO.md` at the repo
root as a checkbox ledger for open work (deliberate non-goals stay in §10 here — the two must
not blur). Promoted the TinyTeX PATH trap into §9.
**Learnings:**
- **The session log is not a substitute for the user docs.** The 2026-07-29 runbook entry
  already recorded the `mkdir -p ~/.local/bin`-before-first-run trap, but `installation.qmd`
  never got it — so anyone following the human-facing install silently ended up with no `flux`
  command. Rule 4 says promote durable lessons into the body; the same applies outward to
  `docs/*.qmd` when the lesson is user-facing. Land it in the same session or it does not land.
- `main` was shipping 13 advisories (9 high) in `package-lock.json`, and nothing gates this —
  there is no CI audit step. It will recur silently until there is one.
- `~/flux` is only convention (everything resolves from `__dirname`; `resolveRepoDirSync`),
  while `~/fluxplot` is a hard requirement — hardcoded with no placeholder substitution in
  `resources/flux-context/PYTHON-CONVENTIONS.md`, so agents run `uv add --editable ~/fluxplot`
  verbatim. The docs presented the two as equally mandatory, which is backwards.
- The `bundle` tier is a **single script** — too thin to clear a dependency change touching the
  CLI/MCP surface. Use `--tier pure` for that (154/159 on macOS; the 5 failures are the
  documented platform set, not regressions).
- Node 22.20 bundles **npm 11**, so npm-11 lockfile metadata (`license` fields) is not evidence
  of an off-pin Node. Do not diagnose lockfile churn from the Node version alone.
- **A catch-all error message that names a fix is worse than a generic one.** The Lighttable
  button funnelled every failure into "isn't installed — run `npm install`"; the real condition
  was a missing Electron *binary* (its postinstall can fail on its own, leaving
  `node_modules/electron/` present but empty), so the message sent a user to re-run an install
  that had already succeeded and that npm would have treated as a no-op. Branch per condition,
  or say nothing specific.
- User-visible strings live in **code and `resources/flux-context/`**, not only `docs/*.qmd`. A
  docs-only sweep of `npm install` → `npm ci` missed `electron/main.cjs` and a *shipped* agent
  doc that propagates into every user's `~/FluxConfig`. Editing `resources/flux-context/` means
  re-running `scripts/gen-flux-context.mjs`; the new hash is what makes existing installs
  re-sync (content propagates fine — it is only the baked absolute paths that never do).

### 2026-08-05 (later) — Agent instructions consolidated into `AGENTS.md` (Claude Opus 5, `main`)
**Work:** Audited `CLAUDE.md` for vendor-specific content and found none — all six sections
(guide pointer, Nielsen budgets, verification conventions, machine config paths, repo etiquette,
sidecars) are harness-neutral project invariants. Moved them verbatim into `AGENTS.md`, reduced
`CLAUDE.md` to a five-line pointer stub, and repointed the five cross-references that cite the
invariants by section name (`electron/main.cjs` ×2, `electron/fluxPaths.cjs`,
`scripts/verify-fluxconfig.ts`, `scripts/verify-docs.ts`, `docs/claude-install-flux-mac.md`).
Session-log entries at §11 that mention `CLAUDE.md` were left alone — the log is history.
**Learnings:**
- **The invariants must live in the vendor-neutral file, not behind a pointer to a vendor-named
  one.** The old layout had `AGENTS.md` route to `CLAUDE.md` for every hard rule, so anything
  reading only `AGENTS.md` got a signpost with no rules. This repo has already been worked by
  Codex (§11, 2026-07-20); the indirection was load-bearing and one-vendor-shaped for no reason.
- The stub stays because Claude Code auto-loads `CLAUDE.md` into every session at zero cost;
  deleting it would turn the invariants into a file agents must be told to read. Keep the
  pointer, move the truth.
- The three-tier split is worth preserving deliberately: `AGENTS.md` (always loaded, short) →
  this guide (read on demand, long). Consolidation was a rename of which file holds tier two,
  not a collapse of the tiers.
- `resources/flux-context/TEMPLATES.md` legitimately tells *users* to write a `CLAUDE.md` in
  their analysis dir, and `electron/agentsConfig.cjs` detects one there. Those are product
  surface for someone else's repo — do not sweep them up in a repo-instructions refactor.

### 2026-08-06 — Web capture: the browser is the acquisition engine (Claude Fable 5, `main`)
**Work:** Replaced the `flux://add?doi=…` bookmarklet with one that **downloads the PDF from
inside the user's own logged-in browser**, and built the receiving half: main watches the
download folder for `flux-*`, moves captured PDFs into `pdfs_to_assign/` (where the existing
content-identifier matches them), and hands `.fluxcap` sidecars to the renderer to resolve by
DOI. Added the drag-to-install page (opened in the DEFAULT browser, carrying the Flux favicon
so the bookmark isn't blank), a `docs/integrations/web-capture.qmd` page, and three gates. The
whole `flux://` protocol path is gone: `fluxUrl.cjs`, the `capture:add` channel, `onCapture`,
the `protocols:` registration.
**Learnings:**
- **The transport was never the hard part — extraction was.** Every previous design shipped a
  URL for Flux to re-fetch server-side, where publishers bot-block it. The browser is already
  past the paywall, already holds the session, and is indistinguishable from a human to
  Cloudflare/PerimeterX. Shipping BYTES from there reaches papers Flux's own capture cannot:
  jneurosci.org returns `cf-mitigated: challenge` + 403 to us and renders fine for the user.
- **Chrome 142 killed the obvious design.** A loopback POST (how Zotero's connector works) now
  needs a per-site Local Network Access permission prompt for a public origin reaching
  127.0.0.1. Extensions are exempt; page scripts are not. A plain download is subject to none
  of it — no protocol handler, no CORS, no ports, and it works in every browser.
- **`$HOME` is deliberately not an fsGuard root (W12/SHL-6), so the renderer cannot touch the
  download folder.** The first cut had the intake doing its own file moves and would have been
  refused at runtime with types and gates all green. The fix is not to widen the guard — it's
  to put the file work in main, scoped to one job, and hand the renderer only what it needs.
- **Two mirror traps avoided, both instances of this morning's lesson.** `isCaptureFile` lives
  in `electron/captureRules.js` (ESM, the supplementRules pattern) so main's watcher classifier
  and the renderer's intake are literally the same function; and `captureIntake.cjs` is
  extracted from main so the live gate drives the real engine rather than a copy.
- **Gate what the feature could destroy, not just what it should do.** This moves files out of
  the user's downloads folder, so `verify-capture-e2e.cjs` plants `tax-return-2025.pdf` and
  friends beside the captures and asserts they're untouched, that traversal names are refused,
  that a same-named capture is suffixed rather than overwritten, and that a sub-1KB
  still-arriving download is left alone.
- Chrome renders a PDF in a viewer with NO html document — no metas, no `citation_pdf_url`,
  just an `<embed>`. And **science.org emits no `citation_pdf_url` at all**. Both were found by
  the owner testing real pages, not by any amount of reasoning about the DOM.
- The dragged bookmark inherits the SOURCE PAGE's favicon — that's the only way to get the Flux
  mark onto a `javascript:` bookmark, and it's why the install page is a real page (also why a
  2 KB href must be dragged, never typed).
- **Firefox is a documented partial.** It applies page CSP to bookmarklets where Chrome doesn't
  ([Mozilla 866522](https://bugzilla.mozilla.org/show_bug.cgi?id=866522), open since 2013), so
  it silently does nothing on strict-CSP publishers. Documented in the install page and the
  docs, with an explicit warning NOT to disable `security.csp.enable`. Real Firefox parity
  needs the WebExtension — that remains the destination, and it would share this payload format.

### 2026-08-06 (later) — PDF identification: PII DOIs, junk `/Title` fall-through (Claude Fable 5, `main`)
**Work:** Cleared a 22-file `pdfs_to_assign/_unresolved/` backlog by hand, then fixed the three
resolver gaps it exposed — an Elsevier PII in the metadata slot is now converted to its DOI
(`10.1016/` + PII, authoritative), a `looksLikeTitle` screen keeps production junk from consuming
Tier 2's only query so the search falls through to the font-size title guess, and Tier 2 skips
DOI-*less* search records to reach the first usable hit. Re-running the real batch: **0/22 → 17/22
identified, zero misassignments**, with the two files that SHOULD refuse still refusing. Promoted
the lessons to §9 and added `pdfIdentify.ts` to the §2 shared-core table (the `_unresolved/`
sidecar builder had drifting copies in both engines — now `unresolvedSidecar()` in the pure core).
**Learnings:**
- A PDF's `/Title` is production junk more often than it is a title — 11 of 22 held a PII, others
  held InDesign filenames and workflow ids. "First non-empty title field" is a bug pattern.
- Writing the adversarial test FIRST caught a hole in my own fix: scanning every search hit for
  one that passes would file a *review of* a work as the work (the Virchow case scores sim 1.00 on
  every metric). The safe rule is narrower than the motivating example suggested — skip unusable
  (DOI-less) records, but treat the first usable hit's verdict as final.
- Declined on purpose: deriving a DOI from the FILENAME. It would have rescued exactly one file
  and misassigned exactly one — the Virchow PDF is named for the DOI of the book it reviews.
- Two gaps left are search REACH, not gate strictness (a scrambled two-column OCR title; a paper
  OpenAlex ranks poorly for its own exact title), plus one deliberate near-miss at sim 0.89 vs
  SIM 0.90 with both year and author corroborating. Thresholds were not moved for it.
- Repo etiquette, learned the hard way: a concurrent session staged `docs/` broadly and swept my
  guide edits into its commit (9cf1707). Explicit paths protect your own commit, not the file.

### 2026-08-06 (later) — The capture extension: supplements in the same click (Claude Fable 5, `main`)
**Work:** Built `extension/` — an MV3 browser extension for Chrome AND Firefox that captures the
article **and its supplementary files** in one click, plus the receiver work to file supplements
against the right paper. `scripts/build-extension.mjs` assembles `extension/dist`;
`npm run build:extension`. Docs updated (`docs/integrations/web-capture.qmd` now leads with the
extension), and `scripts/verify-extension.ts` gates it.
**Learnings:**
- **The extension exists for one structural reason: page CSP.** A bookmarklet runs in the page,
  so the page's Content-Security-Policy governs it — which is why Firefox silently does nothing
  on strict-CSP publishers ([Mozilla 866522](https://bugzilla.mozilla.org/show_bug.cgi?id=866522),
  NEW since 2013) and why even Chrome can block the PDF fetch. A background worker fetching
  under host permissions is subject to none of it. Everything else (supplements, badges, batch)
  falls out of that same move.
- **`chrome.downloads.download({url})` beats fetching bytes yourself.** MV3 service workers have
  no `URL.createObjectURL`, so there is no way to hand the browser a blob. Downloading BY URL
  makes the browser fetch it — with cookies, no CSP — and sidesteps the whole problem. Bytes are
  only read to peek at the first chunk (`body.getReader()`, then `cancel()`) to confirm `%PDF`
  before committing, which is what keeps a paywall interstitial out of the library.
- **`readPaperPage` is injected via `executeScript({func, args})`, which SERIALIZES it — it can
  close over nothing.** The shared supplement patterns arrive as an argument (`RegExp.source`
  strings), the same trick the bookmarklet's in-page sweep uses. A gate asserts page.js imports
  nothing, because an added import would break silently at runtime.
- **A captured supplement can't be filed when it arrives** — its paper may not have a citekey
  until the assign scan identifies the article. So supplements are STAGED in
  `pdfs_to_assign/_captured_supplements/` (inside FluxLib, which the renderer can reach, unlike
  the download folder) under `flux-supp-<doiSlug>@@<name>`, and filed on a later pass. The
  trigger is a `fluxLibRevision` bump — the exact moment a waiting supplement may become
  fileable. The staging dir is excluded from the assign-inbox classifier so it can't wake a scan.
- **`@@` as the slug/filename separator is safe BY CONSTRUCTION**, not by hope: `captureSlug`
  maps everything outside `[A-Za-z0-9._-]` to `_`, so neither side can contain it and a
  first-occurrence split is exact. Picking a separator that "probably won't appear" would have
  broken on the first DOI with a double hyphen.
- **The vendored rules are COPIED by the build and gated byte-identical.** Third time today this
  pattern has earned itself; a hand-maintained second copy of the supplement patterns is
  precisely how this whole area rotted originally.
- Trap found by the gate: `new URL("", href)` resolves to THE PAGE, so an absent
  `link[type=application/pdf]` made `pdfUrl` the article page itself. Guard empty input in any
  `abs()` helper.
- **Two drop points, because the two front ends have different powers.** The extension writes
  into `<downloads>/flux/` (`chrome.downloads.download` takes a relative subfolder), so one
  click producing an article plus eight supplements doesn't scatter nine files through someone's
  downloads. The bookmarklet CANNOT do that — `<a download>` cannot name a directory, browsers
  strip path separators — so it writes to the root and Flux watches both, and nothing nested
  deeper than `flux/` is touched. Worth remembering when adding a third producer.
- Firefox permanence is still open: a temporary add-on is dropped on restart, so a permanent
  install needs an AMO-signed `.xpi` (free, unlisted, no review queue). Deferred by the owner.
- Also open, and the right long-term answer if the download folder ever grates: extensions are
  exempt from Chrome's Local Network Access rules, so a loopback POST — or native messaging,
  with Flux writing the host manifest on first run — would deliver captures with no folder at
  all. Both only work while Flux is RUNNING, so the download route stays as the offline
  fallback; they're additional machinery, not a replacement.

### 2026-08-06 19:23 — Dissect: per-plot companion material (plots/_dissections/) + viewer

Owner-requested feature, shipped whole (3 commits): any plot `plots/<rel>.<ext>` owns
`plots/_dissections/<rel-sans-ext>/` — per-subject panels, alternative analyses, `_stats/`
CSVs. Subfolders are named groups, loose files the default group, and **the folder is the
API** (writing needs no verb; analysis code just drops files). Plain **d** on a selected
plot (or drilled part — openXray's resolution ladder, extracted precedent) opens the viewer:
full-screen ⇄ floating window, windowed image grid, detail zoom/pan, CSV/TSV as sortable
tables. `list-dissections [plot]` is verb #106. Docs: `docs/concepts/dissections.qmd` +
figure/shortcuts/project-layout pages + PROJECT-AND-FIGURES/WORKFLOW/CLI-REFERENCE context
docs (regenerated). Gates: `verify-dissections.ts` (pure, 67) + `verify-dissect-gui.mjs`
(ui, 25) + a `_dissections` decoy in `verify-importer-multi.mjs`.

- **One shared ESM rules module** (`electron/dissectRules.js` + hand-written `.d.ts`, the
  captureRules pattern exactly): main-process watcher, renderer, and flux-core all load the
  SAME file; the pure gate source-shape-checks that main.cjs/PlotImporter carry no private
  copy of the folder name. Key derivation handles every `source.svgPath` shape in real
  projects — absolute (GUI import), relative (headless), bare name (drag-drop) — plus asset
  basenames for sourceless pasted/snip images.
- **The importer is the ONLY enumerator of plots/** in the product (no glob lib anywhere;
  headless verbs take explicit paths), so Alt+I exclusion is one shared-rule filter in
  `loadDir`/`scan` — nothing else lists the folder. Exports never walk `plots/` at all
  (verified path-by-path), so dissections can't leak into deliverables.
- **Watcher: a `dissections` subsystem BEFORE the plots branch** (`subsystemFor`), because
  everything under `plots/` previously fired `syncPlotsIntoFigures` — a script dropping 20
  panels would have triggered 20 full re-read sweeps. Now it bumps `dissectionsRevision`
  and an open viewer re-lists live (LRU cleared so fresh bytes actually show).
- **Lighttable patterns PORTED, never imported** (the sidecar boundary): windowed grid
  (spacer + translateY, damped median aspect, decode-before-swap), modal-fit/zoomwrap
  detail with zoom-at-cursor + Space hand tool. Identical Svelte 5 versions made this
  near-verbatim. Images ride the existing data-URL-over-IPC path with a byte-budgeted LRU —
  no custom protocol, no thumbnailer at dissection scale (tens of files); if that ever
  changes, the lighttable lesson stands: raster work NEVER in main.
- **CSV: a separate tolerant reader** (`src/lib/dissect/csv.ts`), deliberately NOT
  `tableModel.parseCsv` — that one is markdown-fidelity-pinned and strict (rejects ragged
  rows) where a viewer must show the file as it is. Windowed rows + sticky header + numeric
  right-align + stable sort.
- **Trap re-hit: the CLI root-positional heuristic eats slash-bearing positionals.**
  `list-dissections sub/charlie.svg` silently became root=./sub/charlie.svg with no plot arg
  (`/[\\/]/.test(_[0])` → posIsRoot). Any verb whose positional is a PATH-SHAPED non-root
  needs `cliRoot: "flags"` (validate-plot/rerun-plot already knew). Found by hand-smoking
  the verb, now pinned in the pure gate.
- Keyboard modality: the overlay's window keydown listener runs in the CAPTURE phase and
  stops propagation for everything except held-Space (the detail hand tool owns it) — that
  is what keeps tool keys off `Canvas.svelte`'s own window listener, which the handleKey
  guard alone does not cover.

### 2026-08-06 (later still) — Three real-page capture failures (Claude Fable 5, `main`)
**Work:** Owner testing found three failures the gates couldn't have predicted. All fixed, all
now gated in `verify-extension.ts`.
**Learnings:**
- **A hang is a bug, and every network call needs a deadline.** annualreviews.org (Cloudflare)
  accepted the connection and never answered, so `looksLikePdf` awaited its first chunk forever
  and the badge sat on "…" with no way out but reloading the extension. Every fetch is now
  `AbortSignal.timeout`-boxed and the whole run has its own deadline, so the badge ALWAYS
  resolves. Related: a validation that TIMED OUT is not a verdict — `looksLikePdf` returns
  yes/no/**unknown**, and "unknown" downloads anyway rather than letting our own flaky probe
  veto a real capture.
- **`chrome.scripting.executeScript` cannot inject into a browser's PDF viewer.** It failed with
  a red "!" on exactly the pages where capture should be easiest — the bytes are already
  fetched and on screen. We never needed the DOM there: `tab.url` IS the file. The test is on
  the URL's PATH, not the whole string, because publishers sign these links
  (`…annurev-….pdf?expires=…&checksum=…`).
- **`downloads.download()` resolves when the download is ACCEPTED, not when it lands.** A
  publisher answering 403 therefore produced a perfectly happy promise and a file that never
  appeared — the owner's "it finds the supplement but the download fails", with nothing anywhere
  to explain it. The real outcome only surfaces on `downloads.onChanged`; every capture download
  is now tracked to completion and reports the browser's own error code. **When an API's
  success signal is "accepted", it is not a success signal.**
- Dropped the HEAD preflight that guarded supplement size. Plenty of publishers reject HEAD, and
  an extra pre-request to an anti-bot-guarded endpoint is a known way to poison the very session
  the download depends on (same lesson as the proxy engine's "never phase-1 pre-fetch a nav
  candidate"). The size cap moved to `onChanged`, where it costs no extra request.
- **A watcher with `ignoreInitial` is not a receiver.** Captures made while Flux was CLOSED were
  never picked up — which is the common case, since you capture in the browser and open Flux
  later — and the watcher only ran at all when a project was open, so Home saw nothing. Now
  swept on startup and on window focus (the natural moment: capture, switch back, it's in). The
  docs had confidently claimed the old behaviour worked; they were corrected in the same change.

### 2026-08-07 — Bookmarklet retired; extension onboarding + AMO signing (Claude Fable 5, `main`)
**Work:** Deleted the bookmarklet entirely (source, gate, install page, `capture:openInstallPage`,
every doc reference) — the extension supersedes it. Replaced the Library footer with a **Web
capture** onboarding panel, added `npm run sign:extension` for Mozilla self-distribution
signing, and made electron-builder ship the extension with the app.
**Learnings:**
- **Onboarding for a browser extension fails on feedback, not instructions.** A browser will not
  let a page navigate to `chrome://extensions` or `about:addons` — deliberately — so no amount
  of UI can make installation one click on Chromium. What Flux CAN do is remove the two real
  frictions (open the folder for you; open the signed add-on for you), hand over the address to
  paste, and then **show a live status dot that flips to Connected the moment the first capture
  lands**. `captureLastAt` is persisted in localStorage, because "never set up" and "set up
  months ago" must not look identical.
- **Unlisted AMO signing is per-BUILD, not per-user.** The maintainer signs; anyone can then
  install the `.xpi` permanently in release Firefox. Free, no listing, no review queue. The
  irony worth remembering: after signing, **Firefox is the easy browser and Chrome is the hard
  one** — Chrome removed sideloading, so public distribution there means the Web Store ($5 +
  review per update). Unpacked stays developer-only.
- AMO rejects a version it has already seen, so `sign-extension.mjs` bumps the version in the
  SOURCE manifest and expects it committed: a signed artifact should be identifiable in the
  history. Credentials come from the environment (`WEB_EXT_API_KEY`/`WEB_EXT_API_SECRET`) and
  never the repo.
- **TRAP — electron-builder platform blocks REPLACE `extraResources`, they do not merge.** The
  top-level entry shipping `extension/` would have silently vanished on mac and linux, which
  both declare their own block for the correction runtime. The entries are repeated per
  platform on purpose; check this whenever adding a top-level resource.

### 2026-08-07 (later) — "Couldn't file that capture — HTTP 403" on every launch (Claude Fable 5, `main`)
**Work:** A single leftover `.fluxcap` (no DOI, a Cloudflare-walled jneurosci URL) produced an
error toast on every startup AND every window focus. Added `capture:park` and a
definitive-vs-transient retry rule.
**Learnings:**
- **"Leave it in place so the user can retry" is only right for TRANSIENT failures.** A
  definitive one — the server answered, `HTTP 403` — fails identically forever, so the
  retry-forever policy turned one unresolvable file into a recurring error toast on every
  launch and every focus. The distinction already existed in this codebase (`isTransientErr`
  in pdfFinderBridge: an `HTTP <status>` means the request completed and the answer was no);
  the capture intake now uses the same rule.
- Parked captures go to FluxLib's `pdfs_to_assign/_unresolved/` beside a `.txt` note — the same
  place and shape the assign flow uses for a PDF it refuses to guess at. **Nothing the user
  captured is ever deleted**, which is what makes "stop retrying" a safe policy rather than a
  lossy one.
- Worth noticing the shape of this bug: the feature worked, and the failure mode was purely
  *how often it complained*. Retry policy is part of the UX, not an implementation detail.

### 2026-08-07 — Library: sort by date added (Claude Fable 5, `main`)
**Work:** Every entry added to FluxLib now carries a `dateadded = {ISO}` BibTeX field,
stamped in `planAdds` (the shared chokepoint both engines' writers call — one shared
timestamp per plan, so a bulk import is one moment of arrival; merged entries keep their
stamp). `lightEntry` parses it into `RefEntry.dateAdded`, and the Library grid gained a
sortable **Added** column (library-only — the World grid keeps the base template). A one-off
backfill stamped all 1664 pre-existing entries with one timestamp (verified: same keys,
zero metadata drift).
**Learnings:**
- `library.bib` is append-only for new entries, so file order IS insertion order — unstamped
  entries sort correctly as "oldest, in arrival order" for free under a stable sort.
- `loadIndex` compared mtimes only, so a parser-shape change with an unchanged .bib would
  serve a stale index forever; it now also rebuilds on a `schemaVersion` mismatch.


### 2026-08-09 — Reserved folders under plots/: `_lighttable` joins `_dissections` (Claude Opus 5, `main`)

Owner-requested: Lighttable collections belong inside the project, at
`plots/_lighttable/<collection>/`, and a sweep of thousands of triage images must not appear
in the Plot Importer — the same containment `plots/_dissections/` already had. Generalized the
one-folder rule into a **reserved set**: `electron/plotsFolders.js` (+ hand-written `.d.ts`,
typed wrapper `src/lib/project/plotsFolders.ts`) owns the names, deriving the dissections entry
from `DISSECT_DIRNAME` so there is still exactly one definition of each. Consumers: the
importer (hides them from browse rows AND from the search cache), the watcher (lighttable paths
are pruned from the chokidar targets and classify to no subsystem), `flux-core/dissect`'s plots
walk. Gates: `verify-plots-folders.ts` (pure, 43) + `verify-importer-reserved.mjs` (ui, 21);
`verify-dissections.ts`'s importer source-shape check was updated — not loosened — because the
contract it encoded (skip via `isDissectDirName`) is superseded by the broader shared rule, and
it now additionally pins that the reserved set imports the dissections name rather than
restating it. Docs: dissections/figure/project-layout/lighttable pages + PROJECT-AND-FIGURES
and PROJECT-GUIDE context docs (regenerated).

- **Hidden had to stop meaning sealed.** The July rule made `_dissections` unreachable from
  Alt+I, which was fine while it was one folder of per-plot extras and wrong the moment the
  reserved set held material a user might legitimately want to insert. The resolution is an
  explicit gesture rather than an exception: a query starting with `_` — and nothing else —
  surfaces the reserved folders as enterable rows, and entering one **re-scopes the search
  cache to that folder**. Two states, each honest about what it can reach (the placeholder says
  `Search inside _lighttable/…`), and no query can ever span both.
- **Scope is derived from `cwd`, never from a `$:` block.** `reservedRootOf(dir)` is a plain
  function called synchronously by `loadDir`/`descend`, because a reactive statement is a flush
  behind the navigation that triggered it — the listing would have been filtered for the
  previous folder. Same family as the §9 Svelte traps: reactivity is for rendering, not for
  invariants a caller needs *now*.
- **The mid-flight scope guard is load-bearing.** `scanFor` stamps `scanScope` on entry and
  drops its result if it changed while awaiting, so entering and leaving a folder faster than a
  walk completes can't repopulate the cache with the folder you just left.
- **Watcher: prune, don't classify-and-discard.** `subsystemFor` returning `null` for lighttable
  paths is the belt; the real fix is chokidar's `ignored` predicate, so a 10k-image collection
  never costs a watch descriptor. Classifying events you intend to throw away still pays for
  every one of them.

### 2026-08-09 — "This sentence does not start with a capital letter" on a sentence that does (Claude Opus 5, `main`)
**Work:** Owner hit a red flag under `experiments` in *…in "acute neuropixel" experiments. These
are technical experiments.* Root cause: the word lane submitted its final two tokens ALONE, so
Harper read `experiments. These` as a document and correctly reported that its first sentence
opens in lowercase — of a word that ENDS a sentence in the manuscript. Rather than blacklist the
rule, audited the whole class by linting every window the lanes really produce over five
scientific paragraphs and diffing against linting the paragraph: five artifact classes, all from
that one 2-token window (capitalization, unterminated quote, `et`/`al` split out of "et al.",
discourse-marker comma). Fixed structurally — the word lane now submits the sentence so far with
a `focus`, plus the residual `windowStartsSentence` guard and per-window reconciliation of
deferred issues. Re-running the audit against the patched code leaves zero user-visible
artifacts. Gates: verify-local-corrections 99 → 117, verify-paper-local-corrections 55 → 58
(the new live section reproduces the owner's sentence verbatim and was proven to fail — exactly
`["experiments"]` — with the fix stashed); pure 169/169, paper-gate 26/26, check 0/0.
**Learnings:**
- **A linter reads every window as a whole document.** Shrinking a window to "just the tokens we
  might correct" doesn't narrow the analysis, it corrupts it — position-dependent rules fire on
  invented sentence boundaries. Windows carry context; a separate `focus` says what may change.
  Promoted as THE WINDOW RULE in §4.
- **Filtering a planner's INPUT is not filtering its output.** `planLocalCorrections` and
  `normalizeCorrectionCandidates` both synthesize spans from the window text itself (confusion
  table, explicit vocabulary), so widening the window silently widened what the word lane could
  edit until `withinFocus` bounded the results too. Caught in self-review, gated now.
- **Widening a window multiplies the worker's hidden per-word cost.** The mechanical rescue
  search lints ~50 generated variants as separate documents — measured 40–220 ms PER unknown
  word — so a sentence-wide window would have re-paid it for every scientific term in the
  sentence on every space. The worker takes the focus and skips context words.
- A permanently-`deferred` issue was possible by construction: only the sentence lane calls
  `enqueueContextual`, so any word-lane candidate the sentence lane didn't re-derive sat at
  "Waiting for sentence context…" forever. A lane that publishes a provisional mark must own
  retracting it — `publishDeferredIssues` reconciles within the range it may correct.
- Scale-paper's cite/cell ratio checks fail on this box at load-59 **with and without** the
  change (absolute p95s identical: prose 5.7/5.6 ms, cite 13.6/13.8 ms) — the §9 load-contention
  trap, re-confirmed. Baseline before believing a ratio gate.

### 2026-08-09 — Web capture: intake is user-initiated, never ambient (Claude Opus 5, `main`)

Owner's ask: Flux should pull captures out of `~/Downloads/flux` **only** at startup or on a
button press, not whenever it felt like it. It had four triggers — startup, every window
focus/`visibilitychange` (250 ms debounce), every `fluxLibRevision` bump (800 ms), and every
watcher event — so a user's download folder rearranged itself at moments they hadn't asked for
and couldn't predict. Now two: `captureIntakeOnStartup()` and the Library's **Assign PDFs**
button. The watcher event survives but was demoted from a TRIGGER to a NOTIFICATION — it
refreshes `captureWaiting`, a count, via the new read-only `capture:count` IPC
(`captureIntake.cjs#count()`, same filter and size floor as `intake()`), so the button can say
"Assign PDFs (3)" and offer the work without any of it having happened. One button now covers
both sources: it pulls the captures, then scans `pdfs_to_assign/`. The `fluxLibRevision`
subscription was NOT deleted — it now calls `sweepStagedSupplements()`, which touches only
FluxLib's own `_captured_supplements/` staging (a supplement can't be filed until the assign
scan gives its article a citekey, which lands ~a minute after the pass that pulled it in);
finishing a job the user started is not ambient access to their downloads. Scope decision by
the owner: the `pdfs_to_assign/` drop folder keeps its own auto-scan — a folder you drop files
into on purpose is a different contract from a folder the browser writes to. LibraryMode's
mount-time auto-scan therefore calls the new `scanInbox()`, not `runAssign()` — entering a mode
is not a request to empty your downloads. Gates: verify-capture-intake §5 (no focus/visibility
listener; the watcher refreshes the count and does not file; a repo-wide walk asserting the
Assign button is the ONLY caller of `runCaptureIntake` outside the module; `capture:count`
declared read-scope; `count()` free of rename/copyFile/mkdir/rm), verify-capture-e2e extended
with the count↔intake agreement. Both proven to fail before passing. check 0/0; pure 162/169
(the 7 failures are `node:module` `registerHooks`, Node 22 only — this box has Node 20).
**Learnings:**

- **A watcher event doesn't have to mean "act".** The reflex is watcher → do the thing; the
  useful split here was watcher → *know* the thing, user → do it. Kept the live button count
  with zero ambient file movement, and avoided polling the download folder on focus.
- Verified live in the real Electron app (x11 + CDP over the dev server, positive boot
  evidence): planted a capture in the owner's real `~/Downloads/flux`, fired `focus`,
  `visibilitychange` and a real watcher event, and confirmed the file **stayed put** while the
  count read 1 and `pdfs_to_assign/` was byte-unchanged; then opened Library (button read
  `Assign PDFs (1)`, capture-aware tooltip), pressed it, and the file moved. Probe file removed
  afterwards. A pure gate can prove no listener exists; only the app proves nothing else pulls.
- **Found here, fixed in the next entry:** 42 files / 0.50 GB of captured supplements stranded
  in the owner's `~/Downloads/flux` — `flux-supp-<slug>@@<name>` on disk as
  `flux-supp-<slug>_<name>`, so `isSupplementCapture()` rejected every one and intake had never
  seen a single supplement. My first read blamed the browser's download-filename sanitizer.
  **That was wrong** — it was our own code, see below.

### 2026-08-09 (later) — Web capture never filed a single supplement (Claude Opus 5, `main`)

Owner: "just fix this so it actually works." Two independent bugs, both of which made captured
supplements vanish, and neither of which any gate could see.

**1. The producer ate its own separator.** `extension/background.js` assembled
`flux-supp-<slug>@@<name>` and then passed the WHOLE string through a local `safeName()`, whose
job included replacing `@@` with `_` — correct for the publisher's half, fatal for the assembled
name. Every supplement landed as `flux-supp-<slug>_<name>`, which `isSupplementCapture()`
rejects. The download succeeded, the badge went green, and Flux never looked at the file. Fixed
by moving naming INTO the shared rules module (`articleCaptureName` / `sidecarCaptureName` /
`supplementCaptureName` + `safeCaptureFileName`), which sanitizes the untrusted half and THEN
adds structure — order is the whole fix. `download()` now also refuses any name failing
`isCaptureFile()`, so this class of bug is loud instead of silent.

**2. The receiver inverted a lossy transform.** `fileStagedSupplements` matched a staged
supplement to its paper via `doiFromSlug`, which GUESSES `captureSlug`'s inverse by treating the
first `_` after the registrant prefix as the slash. `captureSlug` collapses every run of unusual
characters to one `_`, so it has no inverse: `10.1093/jcr/ucy008` slugs to `10.1093_jcr_ucy008`
and comes back as `10.1093/jcr_ucy008`. Any DOI with a slash in its suffix could never match —
**61 of the 1627 DOIs in the owner's own library**. Fixed by matching in the LOSSY space
instead: slug both sides. Ambiguity (two DOIs slugging alike) is refused, not guessed.

Also fixed: `extension/background.js` and `electron/captureRules.js` carried **raw NUL / 0x1F
bytes** — a control-character regex written as literal bytes rather than as escape sequences.
`file(1)` called them "data" and `grep` silently matched NOTHING in either, including the greps
you would run to audit exactly the code that was broken. Rewritten as real escapes, and gated.
And `MIN_NODE` 22.12 to 22.15: `scripts/lib/cssStub.mjs` needs `node:module`'s `registerHooks`,
which 22.12–22.14 lack, so the guard admitted runtimes on which seven paper gates die at import.

Gates: verify-extension §3 rewritten to drive the PRODUCER's builders (it previously
hand-assembled the filename it expected and asserted the receiver liked it — a contract test
that never runs the producer proves nothing about the producer, which is exactly why it stayed
green throughout), §3b the worker can't reintroduce hand-assembly, §3b2 the extension actually
parses (nothing in the repo compiles it), §3c sources are searchable text; verify-capture-intake
§6 the staged-supplement-to-paper join over the DOI shapes that were broken; verify-capture-e2e
now plants producer-built names and pins the mangled shape as a non-capture. Teeth proven by
reintroducing each bug: 4 assertions fail for #1, 2 for #2. check 0/0, capture-e2e PASS, and
pure **169/169** — see the runtime note below.

**The seven "failing" paper gates were the runtime, not the code.** They all import
`scripts/lib/cssStub.mjs`, which uses `node:module`'s `registerHooks` — absent before Node
22.15 — so on this box's apt Node 20 they died at import before running an assertion, which
reads exactly like a code failure. Node 22.17 was already installed at `~/.local/node22` and
simply never linked onto PATH; symlinking `~/.local/bin/{node,npm,npx}` at it took the pure tier
from 162/169 to **169/169** with no `FLUX_ALLOW_OLD_NODE` override, and ~25% faster. Safe
without a reinstall because every native dep here is an N-API prebuild and there are no
node-gyp modules. If a gate fails on an import of a Node built-in, check `node -v` first.
**Learnings:**

- **A contract test that doesn't run the producer proves nothing about the producer.** Both the
  pure gate and the e2e gate wrote the expected filename as a literal and asserted the receiver
  accepted it. They were green for the entire life of the bug. Gates over a producer/consumer
  boundary must call the producer's real code path.
- **Sanitize the untrusted part, then build the structure — never the reverse.** A sanitizer
  that neutralizes your delimiter is correct; running it over a string that is *supposed* to
  contain the delimiter is not. The safe order is only obvious once it's a shared function.
- **Don't invert a lossy transform; compare in the lossy space.** `doiFromSlug` was honestly
  documented as "best-effort" and was used as if exact. Where both sides are available, apply
  the same lossy function to both and compare — exact, and it needs no filename change.
- **A source file that tools can't read hides its own bugs.** Raw control bytes made `grep`
  silently return nothing for `safeName`, `SUPP_SEP`, everything. I mis-read the regex from
  terminal output as a hyphen class and drew a wrong conclusion from it. `file(1)` saying "data"
  about a `.js` file is the tell.
- Verified live in the real app end-to-end against the owner's FluxLib: planted a supplement
  named by the real builder for `10.1093/jcr/ucy008` (a DOI in the broken class), and it filed
  itself into `items/zhu2018mere-7b4/supplements/`. Before the fix, the same probe reported
  "no library entry for 10.1093/jcr_ucy008 yet" — which is how this second bug was found at all.
  The item folder was restored afterwards.

### 2026-08-10 — A checkout now carries what both browsers need (Claude Opus 5, `main`)

Follow-on to the two capture entries above. The owner's framing: assume everyone else runs
`git pull && npm run build && npx electron .`. On that path **neither browser could be set up**.
`extension/dist/` is gitignored and `npm run build` never built it, so the Chromium route —
"Load unpacked", and the Library panel's own "Show me the folder" — pointed at a directory that
did not exist. `extension/signed/` was gitignored too, so there was no `.xpi` at all, and
Firefox will not permanently install an unsigned add-on; signing needs AMO credentials only the
maintainer holds, so a Firefox user on a checkout had no route whatsoever. Neither failure is
visible to the maintainer, whose working tree has both directories populated.

Now `npm run build` builds the extension, and **the signed `.xpi` is committed**. Committing a
signed binary is a deliberate trade: it is the only channel by which anyone else can obtain one,
and at ~40KB replaced rather than accumulated it is a cheap one. `sign:extension` deletes the
artifact it supersedes, so "exactly one" is upkept by the tool rather than by remembering.

That trade holds only while the committed artifact really is built from the source beside it —
a stale one means every Firefox user silently runs old code, which is exactly how capture spent
weeks filing no supplements. So `verify-extension` now OPENS the `.xpi` and byte-compares
`background.js`, `page.js` and the vendored rule modules against the build, closing
source -> dist -> `.xpi`; plus exactly one artifact, matching the source manifest version,
carrying a real Mozilla signature. Reading the archive needs no dependency and no `unzip`
(`scripts/lib/readZip.mjs`, ~50 lines, Windows-safe). Also fixed just before this: `signedXpi()`
took the first `.xpi` `readdir` returned, so with two versions present the Library offered the
OLDEST — the worst possible moment to serve stale bytes, since you press that button right after
signing a fix. It now picks the newest, and the picker lives in `captureIntake.cjs` so the gate
calls the real function. Gates: pure 170/170, check 0/0. Teeth proven by appending a line to
`background.js` without re-signing. *(Superseded below: those `dist/`-reading assertions were in
the wrong tier and turned CI red for four days — the gate is now split in two.)*
**Learnings:**

- **The maintainer's working tree is the worst place to judge whether a checkout works.** Both
  broken paths were invisible here because `dist/` and `signed/` were sitting on disk, ignored
  by git and therefore absent for everyone else. When something is gitignored, ask what a clone
  actually has — or delete it locally and run the documented flow, which is how this was
  confirmed.
- **A gitignored build output is fine; a gitignored artifact only one person can produce is a
  distribution dead end.** The asymmetry is who can regenerate it. `dist/` anyone can rebuild;
  the `.xpi` nobody but the credential holder can, so ignoring it silently excluded every
  Firefox user.
- **Check the artifact, not a description of it.** The tempting shortcut was a sidecar of hashes
  written at signing time; that is one more thing able to drift, and drift between a producer
  and its description is the exact failure this area already had twice. Opening the zip is fifty
  lines and answers the real question.
- The extension lives in the browser profile, so **no repo operation ever updates it** — every
  change is pull, build, then reload (Chromium) or reinstall over the top (Firefox upgrades in
  place; the add-on id is stable). There is no `update_url`, so Firefox never does it by itself:
  if this add-on ever goes past a handful of people, host an update manifest or list it on AMO.

## Session entry — the extension gate was in the wrong tier, and CI said so ten times

Every push to `main` since 2026-08-06 sent the owner a "Run failed" email. Ten consecutive red
runs; the last green one was `06a98c3`, and the extension work merged in at `0080ccf` took it
red. The failure was always the same job (`ci / test`), always the same step (the pure tier),
and always invisible to anyone running the suite locally.

`verify-extension.ts` shipped in the `pure` tier with seven assertions that read
`extension/dist` — a build output, gitignored, so a fresh checkout has never had it. `ci.yml`
runs `--tier pure` *before* `npm run build` (that is what "hermetic" is supposed to mean), so
the directory was not there and could not be. On the maintainer's box it passed, because a
built `dist/` was sitting on disk from the last time anyone ran `npm run build`.

The fix is a split along the line of what a checkout actually contains.
`verify-extension.ts` keeps everything provable from committed files: the page-reader fixtures,
the worker's structural guarantees, the capture-name contract, the control-byte scan, and what
the signed `.xpi` says about *itself* (exactly one, current version, real Mozilla signature,
embedded manifest agrees). The new `verify-extension-build.ts` takes everything that needs a
build — `dist/` is a faithful copy of the sources, the built manifest carries the source
version, and the byte-comparison closing source -> dist -> `.xpi` — and runs on the `bundle`
tier, which `ci.yml` already runs after `npm run build`. No assertion was dropped or weakened;
they were sorted. The `--changed` pathMap still points `extension/**` at the pure gate only, so
editing the extension never demands a build the caller did not ask for.

Verified the way CI runs it, not the way a working tree runs it: a clean worktree at `HEAD`
with no `extension/dist` gives **pure 171/171** (it was 169/170 + `FAILED verify-extension.ts`
before). The new gate keeps its teeth — run against that same dist-less tree it fails; run
after `scripts/build-extension.mjs` it is green.

**Learnings:**

- **This exact rule was already written down, and four days later it was broken anyway.** The
  V0.1-hardening entry above says it outright: *"A 'hermetic' pure gate that reads a `dist/`
  build artifact isn't hermetic — it fails on a fresh clone and (since CI runs `--tier pure`
  before `npm run build`) in CI too. Gates must generate what they need in-process or move to
  the bundle tier. Prove it by running with `dist/` moved away."* A learning that is only in
  the guide is a learning that has to be re-remembered by whoever writes the next gate. The
  durable version is mechanical — this one now is, because the pure tier is the tier that runs
  before the build, and putting a `dist/` read there fails immediately in CI.
- **The previous entry's own top learning describes the bug it shipped.** It closes with "the
  maintainer's working tree is the worst place to judge whether a checkout works" — and then
  reported "pure 170/170" from a working tree that had `dist/` in it. Reporting a tier as green
  means nothing unless you say *what state you ran it in*; "170/170" and "170/170 with `dist/`
  absent" are different claims, and only the second one was the one that mattered.
- **A red CI that stays red stops being information.** Ten failing runs in a row trains everyone
  to read "Run failed" as noise, which is exactly when a real regression walks in unnoticed —
  and `ui-gate` went green in that window without anyone being in a position to notice. Notify
  on failure only works if failure is rare; the fix for a noisy alarm is the cause, never the
  notification setting.
- Worth knowing for next time: the failing step's own logs need auth even on a public repo, but
  the run/job/annotation APIs do not. `/actions/runs?branch=main` gives the exact commit where
  green turned red, which is faster than reading any log — and reproducing it is one
  `git worktree add <that sha>` away.

### 2026-08-10 — The pure tier was writing test fixtures into the owner's real FluxLib (Claude Opus 5, `main`)
**Work:** The owner kept finding junk `A study` (2020) references in his library and asked why.
`verify-f1-core.ts` — a `pure`-tier script, so every `npm test` — called
`core.addReference(TMP, "@article{smith2020, title={A study}, year={2020}}")`; the temp project
root sandboxed the project half of that verb while its library half went to the real
`~/FluxConfig/FluxLib`. 13 entries had accumulated in a 1669-entry library (owner had been
deleting them by hand as he found them). Fixed by plumbing `libPath` through `addReference` /
`addToLibrary` / (a genuine latent bug) `importReferences`, making the gate hermetic with the
`verify-zotero-sync` HOME/XDG scratch idiom, and adding `verify-hermetic-fluxlib.ts` (pure, 9
checks) over all three writers. Pure tier 172/172, `npm run check` 0/0, and a full `npm test`
now leaves `library.bib` byte-identical (md5 before == after). Owner declined the cleanup of
existing entries — he is removing those himself.

**Learnings:**
- Promoted to §9 as a trap block, and §7's pure-tier definition now spells out that *hermetic*
  covers the user's machine state, not just network/dev-server. §7's script count was stale
  (163 → 172).
- **The manifest's tier `$doc` asserted "no real ~/FluxLib mutation" the whole time.** A written
  contract with nothing executing it is a comment. If a tier claims a property, something in the
  tier has to fail when the property breaks — that is the only difference between a contract and
  a wish.
- The bug survived because *both* engines behaved correctly: the write was the intended,
  documented behavior of `addReference` (add to FluxLib **and** cite into the project). Nothing
  was broken — the gate was simply calling a production verb with production reach. Test seams
  belong on any function that touches machine-global state, whether or not it looks dangerous.

### 2026-08-10 (later) — Dev runs showed a generic cog / the Electron atom instead of the mark (Claude Opus 5, `main`)
**Work:** The owner's Linux dock showed GNOME's `application-x-executable` cog for a running Flux,
and his Mac showed the Electron atom. The icons themselves were never the problem — `build/icons`
has carried the phyllotaxis plates since the 2026-07-29 rework and both packaged targets already
point at them (`electron-builder.yml` `mac.icon` / `linux.icon`). This was strictly the unpackaged
`electron .` path, failing for a *different reason per platform*: `createWindow` set `icon` only on
win32 (a deliberately narrow Windows-port change — "macOS/Linux keep today's exact window
options"), macOS ignores `BrowserWindow.icon` on any backend, and Linux runs native Wayland
(`ozone-platform-hint=auto`), where a client cannot set a window icon at all. Fixed with one
`appIconPath()` helper feeding both the window option (now Linux + Windows, `.png`/`.ico`) and a
`!app.isPackaged && app.dock` guarded `app.dock.setIcon()` for the mac Dock, plus new
`scripts/install-desktop-entry.mjs` (`npm run install:desktop-entry`) — the only mechanism that
works under Wayland — which writes `~/.local/share/applications/flux.desktop` with
`StartupWMClass=<app_id>` and the hicolor icons at 32/64/128/256/512. Pure tier 173/173,
`desktop-file-validate` clean, entry confirmed discoverable via Gio; owner confirmed the dock icon.

**Learnings:**
- Promoted to §9 (Environment) as a trap: the Wayland/X11/macOS split on window icons. Anyone
  "fixing" this by setting `BrowserWindow.icon` and testing on this box learns nothing — the
  option is accepted and silently dropped, which reads exactly like a wrong icon path.
- The app_id is the whole join key, and it is *observable without any tooling*: GNOME's fallback
  tooltip read lowercase `flux` while the window title is `Flux`, which is the app name
  (package.json `name`, since there's no runtime `productName`) rather than the title. That is
  what `StartupWMClass` has to equal, so the installer derives it from package.json instead of
  hardcoding it. `org.gnome.Shell.Introspect.GetWindows` is `AccessDenied` on GNOME 49 and
  `xprop`/`xdotool` aren't installed (and would be blind to a Wayland surface anyway).
- A user-level `flux.desktop` **shadows** a packaged `/usr/share/applications/flux.desktop`, so
  the installer prints the exact `rm` — a dev convenience that silently hijacks a real install
  later is a trap, not a convenience.

### 2026-08-10 (later still) — Two machines, one folder, and a place to keep runbooks (Claude Opus 5, `main`)

**Work:** Stood up continuous `~/FluxConfig` sync between the owner's two machines (Syncthing
over Tailscale; verified from the peer at 100% / 0 errors), then closed the three application
gaps that made a synced folder unsafe: absolute `source.svgPath` (`b5bc6ec`), sync-conflict and
`.syncthing.*.tmp` artifacts reaching the watcher and `listDocuments` (`0a73e03`), and the
scaffolded `.gitignore`. All three are promoted into §3. This commit adds `docs/for_agents/` —
`.md` runbooks addressed to an agent, excluded from the rendered site twice over and gated —
and moves the Mac install runbook there alongside a new, de-identified cross-machine sync
guide. `verify-docs` 148 → 156.

**Learnings:**

- **"Started" from a service manager is not evidence the service runs.** `brew services start`
  reported success while its LaunchAgent never executed — no process, no exit code, no log file
  — and the daemon was fine when launched by hand. Only a positive signal *from the thing
  itself* (an API ping, a written log) counts. Same shape as any "the command returned 0" claim.
- **When a symptom has two plausible causes, find a second signal rather than reasoning
  harder.** "API never came up" is a dead daemon *or* a probe on the wrong port; one `nc -zv`
  against the peer's sync port from the other machine settles it in a step. This is the cheaper
  half of every ambiguous-failure hour.
- **Verify distributed state from the far side.** A sync tool's local UI saying "Up to Date"
  only means the local queue is empty; the peer's completion is a different number, and it's the
  one that answers "did my work arrive". Generalizes to anything with a local view of a remote.
- **Escaped `\"` inside `$( )` inside a double-quoted string reaches the child as literal
  backslashes** — invalid JSON, HTTP 400, while a single-quoted body in the same script worked.
  Build request bodies with unquoted heredocs, and never `-o /dev/null` a request whose error
  body you might need.
- Promoted to §8: agent-facing runbooks live in `docs/for_agents/` as `.md`, indexed by its
  README, guarded by both the `.qmd`-only render globs and an explicit `!for_agents/**`.

### 2026-08-10 (later still) — A long table's markdown drowned the prose around it (Claude Opus 5, `main`)

**Work:** The owner: a table's whole pipe source is always on screen, so reading past a
30-row table means scrolling 30 lines of markdown you did not want to see. Fixed the way the
figure embed already solves it — the source block now collapses to one accent `▦ Table N`
pill unless the selection is inside it (`science/tableFold.ts`), with the rendered table
below it untouched. Clicking a rendered cell, the caption (new route — the caption line is
inside the fold, so it needed the same one-click path the cells had), or the pill itself
puts the caret in the matching source and brings it back; arrowing in works from either
side. Promoted into §4 with the full "why this is safe" list. Gates: new hermetic
`verify-table-fold.ts` (pure, 30 checks — the contract is all StateField logic, no browser
needed), `verify-paper-tables.mjs` §F for the DOM/click routes, and `verify-paper-nav.mjs`
rewritten around the superseded height contract. Pure 174/174, paper-gate 27/27, scale-paper
green (prose keystroke 2.2× < 3×, still zero block-field builds), check 0/0.

**Learnings:**

- **"Decorations are never selection-driven" was really "BLOCK WIDGETS are never
  selection-driven".** The 2026-07 bug it came from was a ~500px widget being swapped in the
  caret's own transaction; hiding source LINES on selection is a different mechanism and is
  what CodeMirror's own folding does. The distinction now lives in §4, because reading the
  old sentence literally makes this whole feature look forbidden — and the wording had
  already outlived one exception (chips.ts' inline reveal) before this one.
- **A line-break-spanning `Decoration.replace` may only come from a StateField** — a
  ViewPlugin cannot change the vertical layout. That single CodeMirror rule dictates the
  entire design: the field must be selection-aware, so everything else (identity when
  nothing opens, a `spans` set for the change gate, the memoized scan) exists to keep a
  caret move from paying for it.
- **Measure the feel before building machinery for it.** I had a caret-anchored scroll
  compensation designed and ready for the "everything jumps when the table closes" problem;
  a probe showed CodeMirror's own scroll anchor already absorbs it (0px caret drift arrowing
  out of a 30-row table, 59px clicking prose below one). The code that never shipped is the
  cheapest code there is.
- The gate battery mostly held ITSELF: of 27 paper gates, exactly one assertion failed
  (`verify-paper-nav`'s "zero layout shift"), and it failed for precisely the right reason.
  A gate that fails narrowly is telling you where the contract moved — the fix is to write
  the new contract more precisely (constant outside, constant inside, exactly restored),
  never to delete the check.
- A GUI gate that reads a DOM node the feature creates must null-guard it, or reverting the
  feature makes the gate CRASH instead of reporting — still red, but it takes the other 30
  checks' results down with it.

### 2026-08-11 — Multi-window + dual paper panes + the quit wedge (Claude Fable 5, `worktree-aug10-deferred-updates`)

**Work:** Implemented both deferred investigations from `notes/aug_10_deferred_updates/` after
re-verifying every claim against source (two corrections: the lock-map collision is an
early-return restamp that strands the second holder's heartbeat, not an interval leak; and the
dual-pane plan missed three real blockers — the module-global chip/slash/table/embed handler
registries, the ungated command-bus effects, and the margin terminal's host div). Quit-wedge
R1–R4: denied single-instance launches log; app windows register with
`appLifecycle.createAppWindowPolicy` and the last one's close quits regardless of hidden
utility windows; pure gate `verify-quit-policy.ts`; recovery row in the install docs.
Multi-window: main's per-window `sessions` registry replaces `mainWindow`/`currentRoot`/
`projectWatcher`; global/project watcher split; per-root bridges pinned to windows; per-window
locks + dialog approvals + pending roots; `--new-window` desktop action (dev entry +
electron-builder `desktopActions`) via second-instance; `win:new`/`win:initialProject`/
`win:projectOpenElsewhere`; same-project-opens focus the existing window; reader sessions
per project root. Dual paper panes: every remaining paper singleton became a per-instance
factory (threaded via MarginHost), chipContext became a per-editor registry, flushable ids
carry the pane id, the feedback stamp follows focus, same-document panes are refused
(`paperDocRegistry`), and `"paper"` left `SINGLETON_MODES`. Promoted the durable statements
into §4. Gates: pure 175/175, paper-gate 28/28 (new `verify-paper-split.mjs`), reader-gate
green (`verify-r8` updated for the scoped tabs key — deliberate contract change),
`verify-multiwindow.cjs` (electron) PASS, check 0/0.
**Learnings:**

- **`--ozone-platform=x11` must be a REAL command-line argument for electron-tier gates run
  from a detached shell.** Native Wayland hangs Electron BEFORE `app.whenReady` resolves —
  after JS starts, so "required electron OK" prints and then nothing — and an
  `app.commandLine.appendSwitch` inside the script is parsed too late to save it. A 12-line
  boot probe (print at require, print at whenReady, timeout) isolated it in one run after an
  hour of staring at hung full gates. The gate headers now say so.
- **A background `cmd | grep | tail` swallows a hung child's evidence.** The pipe buffers
  everything until exit, so a wedged gate shows zero bytes of output — indistinguishable from
  "not started". Electron-tier gates now stream each result line via `fs.writeSync(1, …)` as
  it happens; the report prints only the verdict.
- **A "registry keyed by instance" is not a singleton** — the pane-gate comment condemned
  module-scope state wholesale, but the doc-claim map and the per-editor handler registry are
  module-scope BY DESIGN (instances must see each other's claims). The test is whether an
  entry's lifetime is one instance's lifetime.
- The mode-gate comment in `paneStore.ts` was the best implementation plan in the repo: it
  named exactly the two singletons that still blocked paper. Keeping gate comments precise
  about WHY pays off a month later.
- Widget affordances gated on "is a handler registered" at `toDOM()` time can't resolve
  per-editor (the element isn't attached yet) — the render gate is "ANY pane registered"
  (`anyPaperHandlers`), and the click-time dispatch resolves by element ancestry.

### 2026-08-12 — paper renders now bake plot overrides; one bad figure can't kill a surface (Claude Fable 5, paper-figure-fidelity)
**Work:** Fixed the external double-title report: `scholar/figures.ts renderFigureSvg` called
`figureToSvg` with no `plotMarkup`/`assetSize`, so every paper surface (embeds, hover cards,
pickers, in-app preview/PDF, app-side materializeRenders) drew raw plots — part overrides and
crops silently dropped, diverging from flux-core/agent renders. Extracted flux-core's
`buildPlotMarkup` into shared `src/lib/plot/inlineMarkup.ts` (Twin-Engine row added),
`readFigSource` now returns manifest sidecars + migrated asset meta, and the paper render is
byte-identical to flux-core (`verify-paper-render-overrides.ts`, pure + paper-gate). Also
hardened the same seam: a throwing figure render caches `undefined` ("no preview") instead of
propagating — an uncaught throw in the FigurePicker mount (the ONLY surface that renders EVERY
figure) was a silently dead `/figure` AND Ctrl+K "Insert figure" with zero trace; slash applies
now resolve handlers BEFORE deleting the typed token, toast + journal (`slash_command`,
`render_error`) on failure, and `chipContext` grew a dev tripwire for dual-pane lookup misses.
**Learnings:**
- A modal that eagerly renders EVERY project item at mount is a single point of failure for the
  whole feature — one throwing item = a dead button with no error surface. Renders feeding
  always-on UI must degrade per-item, never propagate.
- The completion `apply` that deletes the typed token before resolving its handler destroys the
  user's input on any downstream miss. Resolve first, mutate after.
- When two entry paths (slash + palette) fail identically, the bug lives in their shared suffix —
  here the picker mount, not the per-path plumbing everyone suspected first.

### 2026-08-13 — figure picker scrolls at scale + canvas scope (Claude Fable 5, figpicker-scroll-canvas)
**Work:** Issue #10: with many figures both picker grids COMPRESSED every row to fit the modal
(cells clipped to ~30px slivers, names invisible, no scrollbar) — `.cell{overflow:hidden}`
zeroes each grid item's automatic minimum size, so a height-constrained grid shrinks rows
instead of overflowing. Row floor (`grid-auto-rows: max-content` + `align-content: start`) in
FigurePicker AND FigRefPicker restores full-size cells over a real scrollbar. Added the canvas
scope dropdown to FigurePicker (readFigSource → `FigSource.canvases` → `figureCanvases` store;
scope filters first, search composes within; hidden at 0–1 canvases). New ui gate
`verify-figpicker.mjs` (also in paper-gate, now 30); docs/modes/paper.qmd updated.
**Learnings:**
- A CSS grid whose items have `overflow: hidden` will silently compress rows to fit a
  constrained container — `overflow: auto` on the container never engages because nothing
  overflows. Give tracks a floor (`grid-auto-rows: max-content`) when cells clip their content.
- Keyboard-driving a CodeMirror completion in a gate: waiting for the option to be
  aria-selected is NOT enough — autocomplete's `interactionDelay` (~75ms) ignores an accept
  that lands right after a list update and the key falls through to the document. Condition
  wait + one annotated 120ms debounce is the stable recipe.

### 2026-08-13 — paper inline ids namespaced; hidden-clipPath guard; delete_figure prunes assets (Claude Fable 5, paper-inline-id-namespace)
**Work:** Fixed the blank-plots regression the paper-fidelity merge introduced: paper's inline
renders shared the figure editor's element-id prefix, and a keep-alive-hidden paper pane's copy
won the document-wide `url(#clipPath)` id race with an EMPTY clip (visibility:hidden children),
blanking every clipped data mark in the visible editor (axes survived — the exact user report;
pixel-repro'd with the real project asset). Display renders now carry `PAPER_SVG_NS` ("pap__")
on plot-internal ids; the DISK render (materializeRenders) stays un-namespaced and uncached to
keep byte parity with flux-core; ModeContent grew a hidden-clipPath guard rule as the second
layer. Separately, headless `delete_figure` now prunes index assets no remaining figure
references — four agent deletes had left 14 fig/index.json entries pointing at removed files
(ENOENT spam on every load). Gates: verify-clip-collision.mjs (mechanism + guard + live embed
paint; ui + paper-gate, now 31), verify-delete-prune.ts (pure, 177),
verify-paper-render-overrides extended (display/disk split, 16 checks). Trap promoted to §9.
**Learnings:**
- Inline SVG in a multi-surface document is a shared id namespace: any new surface that mounts
  markup previously rendered as `<image>` must namespace every referenceable id, or it changes
  OTHER surfaces' rendering through url(#) resolution — the regression was invisible in
  single-surface gates and only appeared with keep-alive + mode switching.
- When a fix has a cheap structural half (unique ids) and a cheap environmental half (the CSS
  guard), ship both: the structural half prevents the class you know, the guard covers the
  hidden-twin variants you haven't met yet, and the mechanism gate tells you if the platform
  ever changes underneath either.

### 2026-08-13 — `flux note`: locked notebook session-log appends + a real lock-layer race (Claude Fable 5, `main`)
**Work:** Closed the multi-principal notebook gap: PRINCIPAL.md's notebook law told every
principal to write `Context/NOTEBOOK.md` directly, so two principals (owner's standing
workflow — zellij panes) could clobber each other's session-log entries. New `note` verb
(CLI+MCP, `cliRoot:"flags"` — free text carries slashes) → `addNote` in flux-core/context.ts:
read→insert→write INSIDE the `manuscript` lock (the name the GUI activity lock already uses
for paper-surfaced docs, notebook included), insertion via pure
`contextTemplates.appendSessionLogEntry`. Stock docs amended (notebook law: log entries via
`flux note`, body edits surgical/never whole-file; CLI-REFERENCE row; PROJECT-GUIDE;
pass prompt names the verb), context docs regenerated, CLI dist rebuilt, goldens regenerated.
New pure gate `verify-note.ts` (23 checks incl. barrier-synchronized two-process contention).
That gate immediately caught a REAL pre-existing race in `flux-core/locks.ts` — see the §3
Locks bullet: torn open("wx")+write claims let a contender rm a live lock and enter alongside
(reproduced: 1 lost update per 300 under a hot two-process loop, 5/5 runs). Fixed with
content-atomic claims (tmp+link), atomic restamps, ENOENT-never-cleared, mtime-guarded
corrupt clears, rename-to-trash stale takeover; GUI `writeLockFile` (main.cjs) made atomic
too. Pinned in verify-w3-locks §6 (teeth proven against the pre-fix locks.ts: 239/240).
Pure 178/178, check 0/0, verify-multiwindow (real Electron, x11) PASS, docs gate 156.
**Learnings:**
- A contention gate with a START BARRIER (ready-files + go-file) turns a "rare flake" into a
  deterministic reproduction — the barrier collides both processes at claim time every run.
  Without it, verify-w3-locks §1/§2 had exercised this exact lock for a year without ever
  hitting the torn-claim window.
- An advisory-lock protocol on plain files has two structural rules: a claim must be
  content-atomic WITH its payload (create-then-write ≠ atomic), and no contender may destroy
  a lock it couldn't positively read as stale — "unreadable" means in-flight, not abandoned.
- `git checkout <file>` to undo a teeth-proof mutation also destroys uncommitted work in that
  file — restore teeth-proof edits from a copy (`cp` aside first), never from the index.

### 2026-08-14 — External-reload contract: view + undo survive agent fig/ edits (Claude Fable 5, `main`)
**Work:** A collaborator's reports (view yanked to another canvas mid-agent-edit; Ctrl+Z dead
afterwards) traced to ONE call: the W10 clean-editor reload ran `store.loadProject`, which
unconditionally snapped to `canvases[0]` AND `resetHistory()`. Added reload semantics
(`loadProject(p, dir, {reload:true})`, threaded `loadFigInto` → `reloadFigures`): active
canvas/figure/selection preserved where ids survive, pre-reload state pushed as ONE undo entry
(pre-existing history intact beneath), editor stays clean. Slide mode's mirrored reload paths
now pass `openDeck(..., {preserveView:true})` (current slide + beat restored via `selectSlide`;
no re-fit). Promoted to §4 (external-reload contract) + §9 (derived-name trap). New pure gate
`verify-fig-reload-preserve.ts` (19 checks); verify-w10-matrix strengthened (view kept, one
entry, undo/redo) after fixing its probe. check 0/0; an-bridge/undo-budget/canvas-divergence,
w7-fig, f1-watch, keepalive, all 6 slide UI gates green. The agent edit-lock proposal (block
user edits + red outline while an agent holds a figure) is deliberately NOT built — needs an
owner design call (granularity, in-flight gestures, "no locked feel" doctrine).
**Learnings:**
- verify-w10-matrix had been silently red in ui-extra since figure families (2026-08-04) made
  `name` a derived field its rename-probe could never observe again: a gate probing a reload
  must assert on a non-derived field (geometry), and a tier nobody runs is a tier that rots —
  when a body feature changes a field's ownership, grep the GATES for probes through it.
- Reload-in-place semantics come almost free once history is snapshot-based: push the
  pre-reload snapshot instead of resetting, and undo/redo across an external swap just works —
  the hard part is only deciding what must NOT ride along (dirty flag, initial loads, slide
  overlay's checkout maps).

## Session entry — 2026-08-17 — live Zotero citations in the Word export

**What landed.** The Word export can now write citations and the reference list as real
Word/Zotero fields instead of the text citeproc bakes in. `Export → Word` grows a **Live
Zotero citations** checkbox and, under it, **Link to library from…**, which takes `.docx`
files already written through Zotero and binds matching citations to that library. New
shared core `src/lib/references/zoteroFields.ts` (pure, fflate — no native deps, rule 4);
callers are `flux-core/manuscript.ts` `compile({zoteroFields, zoteroLibraryDocs})` and
`PaperMode`'s in-app export, which does its own IO through the FileBridge. Citation
marking rides the existing shared prep (`exportPrep`, `markCitations` flag), so both
engines mark identically and the sources are restored as before. Gate:
`verify-zotero-fields.ts` (pure, 40 assertions); user docs updated in `getting-started.qmd`.

**Why the module exists at all.** Pandoc resolves `[@key]` through citeproc, which formats
the citation into ordinary runs and discards the item identity; its docx *reader* likewise
drops `ADDIN` instructions, so importing a Zotero user's Word file destroys what they had.
Neither is a setting — a post-processor is the only place this can be fixed.

**Every assertion in the gate is a document Word rejected.** This was developed against a
real collaborator's Zotero, and each rule below cost a round trip to discover. None of them
was visible to structural checking: the XML was well-formed, the field triples balanced,
the payload schema matched a genuine Zotero document key for key, and the plain-text diff
against an ordinary render was empty — while Word still refused the file.

1. **`uris` is mandatory on every citation item.** An item without it is unlike anything
   Zotero writes and refresh fails immediately. Unmatched items get Zotero's local-library
   form (`users/local/<key>/items/<key>`), which cannot mis-bind because a recipient's local
   key differs. An earlier design omitted the key when no library match existed; that was
   the single most expensive mistake of the session.
2. **Double quotes stay RAW in the field instruction and the prefs blob.** `&quot;` is
   well-formed XML, but Word hands the field code back undecoded and Zotero cannot parse it.
   The prefs half fails quietly instead: the style silently reverts to Zotero's default.
3. **Pandoc's `ref-*` anchors must be removed from the bibliography field.** The field would
   otherwise enclose ~100 bookmarks, one straddling its boundary, and Zotero replaces the
   whole field content when it regenerates. Nothing points at those anchors.
4. **The prefs part is merged, never replaced** (Quarto writes `biblio-config` and others),
   and splits at 255 *unescaped* characters per `ZOTERO_PREF_n`.
5. **Records we synthesise are shaped like Zotero's** — string date-parts, no `keyword`.
6. Marking must skip Quarto crossrefs (`@fig-`, `@tbl-`), which are `Cite` elements too, and
   must restore the space citeproc deletes before a superscript citation — bracketing the
   citation breaks the adjacency that rule depends on.

Markers are printable (`⟦ZC{…}⟧`) on purpose: one that ever survives is visible in the
document rather than an invisible control character in a manuscript.

**Local gate state (macOS box).** Pure tier 173/180. The seven failures are pre-existing and
environmental, not from this work: `verify-fluxconfig` / `verify-zotero-sync` want a Linux
`~/.config` layout, the three slide gates want Chrome at `/usr/bin/google-chrome`,
`verify-paper-commands` asserts Linux chord hints, `verify-dispatch` likewise. Every gate
covering the touched surface passed (`verify-export-qmd`, `verify-export-prep`,
`verify-registry-parity`, `verify-docs`, `verify-zotero-fields`), and `npm run check` is at
0/0. **The paper UI gate (`group:paper-gate`) has NOT been run** — it needs a dev server on
:1420 and the owner had one in flight; run it before this is merged.

**The CLI carries it too** (owner asked, same session): `compile --zotero-fields
[--zotero-library a.docx,b.docx]`, `as: "csv"` for the library paths, resolved against the
project root. The `cli-help.golden.txt` diff is one added usage line; `mcp-tools.golden.json`
is a name list and did not move. Verified against a scratch project: *"zotero: 3 live
citation(s), 2 linked to a known library, 2 embedded"*. `CLI-REFERENCE.md` updated with it.
Note the help text in `flux-cli.ts` is hand-curated rather than derived from the verb, so
REGEN_GOLDEN alone will not pick up a summary change — edit the usage line as well.

**Not done, deliberately.** The GUI reads the CSL identity from the journal style's asset or
the document front matter; a project with no CSL at all declares Chicago author-date, which
is pandoc's own default.

### 2026-08-19 — Zotero-fields review + footnoted-citation fix (Claude Fable 5, `main`)

**Work:** Reviewed the four collaborator commits pushed 08-16..18 (panel sub-numbers, gate
hermeticity on win32, live Zotero fields, heartbeat-lock release race) — ran the pure tier
(180/180), the flagged-but-unrun `group:paper-gate` (31/31), and an end-to-end scratch-project
docx inspection; all sound. Fixed the one real defect found: citations in FOOTNOTES corrupted
the `--zotero-fields` Word export (an inline `^[… @key …]` was group-marked as a citation
bracket, splitting the `^[` adjacency — footnote destroyed, literal `^` in the prose; a
`[^1]:` definition's citation rendered into `word/footnotes.xml`, which the injector never
processed, shipping visible `⟦ZC…⟧` markers). `markCitations` now checks bracket CONTEXT
(footnote/link/span brackets left whole; image alts interior-marked so figure-caption
citations stay live), and the injector demotes any marker reaching footnotes/endnotes to its
displayed text (reported as `notesPlain`) with the refuse-to-write survival check extended to
those parts. Footnote citations are deliberately NOT live fields — untested against real
Word/Zotero. Gate extended (13 assertions, fails 8 ways against the unfixed core); §2 table
row added for the `zoteroFields.ts` shared core. Two review nits then closed in follow-up
commits: CSL identity resolution became ONE shared walk (`resolveCslIdentity`, IO injected —
the GUI's private copy had skipped the front-matter `csl:` candidates and probed a directory
as a file, so the app declared Chicago where the CLI declared the right style), and the
export dialog's "n of m references matched" line now actually renders (`countMatches` had
zero callers and the prop was never passed — dead since the feature landed).

**Learnings:**

- Markdown reuses `[…]` for constructs that live or die on ADJACENCY (`^[…]` footnote,
  `![…](…)` image, `[…](…)`/`[…][…]`/`[…]{…}` link/reflink/span). Any source transform that
  inserts material around a bracket must check what neighbours it — the export prep folds
  figure captions into the alt slot, so "caption cites something" walks straight into this.
- A "no marker survives" guard is only as strong as the set of parts it scans: pandoc renders
  footnotes into `word/footnotes.xml` (endnotes into `word/endnotes.xml`), so a document.xml-only
  check passes while the reader sees the garbage. Enumerate the docx parts a construct can
  render into before trusting a whole-document invariant.
- pandoc's alt-text/`descr` stringification drops RawInline, so raw-openxml sentinels inside an
  image alt do not leak into the drawing properties (verified empirically, not just from docs).
- A worktree with `node_modules` SYMLINKED from another filesystem mass-fails ui gates on the
  console-clean check only: vite's `server.fs.allow` 403s the Harper WASM
  (`PAGEERR … WebAssembly: HTTP status code is not ok`). Use a repo-local worktree with
  `cp -al` (hardlinks need the same filesystem; `/tmp` is tmpfs here).
