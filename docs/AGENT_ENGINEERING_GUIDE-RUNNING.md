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
|---|---|---|
| fig/ persistence (shapes, labels, writer plan, save ordering) | `src/lib/project/figfiles.ts` | `verify-figfiles-parity.ts` (byte-identical trees) |
| Model mutations (all figure edits) | `src/lib/ops.ts` (+ `editing.ts`, `geometry.ts`) | `verify-ops.ts`, figenh parity suite |
| Pointer-gesture math (resize/snap/handles) | `src/lib/interact/` | `verify-interact-core.ts` |
| Load-gate validation (parse → migrate → validate) | `src/lib/project/validate.ts` (+ generated `validators.gen.js`) | `verify-loadgate.ts` |
| Reference query grammar | `src/lib/references/query.ts` | `verify-organize.ts` |
| Enrichment shapes/projection | `src/lib/references/enrich.ts` | `verify-enrich-grid.ts` |
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
| Present-mode input/HUD | `src/lib/slide/present/core.ts` | `verify-present-core.ts` |
| Paper snips (naming, citation, sidecar/tEXt meta, raster plan) | `src/lib/references/snips.ts` (+ `journalAbbrev.ts`) | `verify-snips.ts`, `verify-snip-headless.ts` |
| CLI/MCP verb surface | `flux-core/registry.ts` + `verbs.ts` | `verify-registry-parity.ts` (goldens) |

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

- **Every canonical write is atomic** (`tmp + fsync + rename`; `flux-core/fsx.ts`,
  `atomicWriteMain` in `electron/ipc/files.cjs`). Directory entries are fsynced after rename
  batches (`fsyncDir`).
- **fig/ saves have a commit point**: canvas files first → dir fsync → captions →
  `index.json` **last** (+ one-generation `index.json.bak`). The index never references a canvas
  file that doesn't exist, even across SIGKILL (`verify-figsave-txn.ts`). The ordering lives once,
  in `executeFigSave` (figfiles.ts) — never reorder it.
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
  "deferred … is locked" message (CLI exit 75 via the error taxonomy).
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
- Big collections use windowing (`VirtualFixedList.svelte` for the sidebar; hand-rolled row window
  in `LibraryMode`) — all N rows in the DOM is never acceptable at 5k scale.
- The **paper editor** (CodeMirror 6) is the most latency-sensitive surface in the app. The
  mechanisms that keep it instantaneous (§6) and glitch-free — engineering constraints, not
  aesthetics; understand them before changing them: decorations are a pure function of the
  DOCUMENT, never the selection (selection-driven rebuilds once swapped a ~500px widget in the
  caret's own transaction — the "arrow up jumps multiple lines" bug); no block-level
  `atomicRanges` — embeds/tables/math render as a styled source line plus a block widget AFTER it,
  so every doc line costs exactly one vertical keypress; source-line metrics are identical active
  vs. inactive (goal-column navigation survives caret entry); block widgets carry accurate
  `estimatedHeight`s (scroll stability); vim loads FIRST in the extension tree (it claims keys at
  the DOM level); citation ordinals publish synchronously before the chip plugin; external reloads
  dispatch a minimal single-span diff, never a whole-doc replace. Per-editor state rides facets
  (no module singletons); block StateFields are change-gated by `science/changeGate.ts` so prose
  keystrokes pay zero construct cost. Focus returns to the editor after every transient UI.
  Regression suite: `group:paper-gate`.
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
  coalesced commit runs keep their editGen continuity. Gate:
  `verify-beat-display-gui.mjs`.
  When touching stores/keep-alive, run `verify-slide-tenancy-gui.mjs`.
  Svelte 5 trap discovered here: `store.set(sameObjectRef)` does NOT re-render
  `$store` consumers in runes components (referential dedup) — publish a fresh
  identity (`store.set({ ...o })`) when mutating in place.
- Electron: `main.cjs` is a **composition root**; handler families live in
  `electron/ipc/{contract,files,terminal,network,agent}.cjs`. Every IPC channel is declared in
  `contract.cjs` (`verify-ipc-contract.ts` — no orphans in either direction). The renderer runs
  under a **CSP with no `unsafe-eval`** — see §5.

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
  pure --jobs 4` (~15s, currently 136 scripts, must stay green at all times).
- **ui / ui-extra** — puppeteer against the dev server on :1420 (`scripts/lib/driver.mjs`;
  fixtures via `?fixture=demo`, dev handles `window.__flux`, `__fluxView`, `__fluxSeed*`). ui is
  the curated stable suite (41), ui-extra the full sweep (60). Consoles must be **clean** —
  there is no tolerated-404 filter anymore.
- **scale** — the perf budgets (figure/paper/library/reader/fulltext). These are the standing
  60fps/scale contracts from the polish mandate.
- **presence** — the seven source-shape/static scripts (main-process/build config that headless
  drivers can't exercise; incl. `verify-electron-no-undef.ts`, the TS-checker undefined-identifier
  gate over `electron/**/*.cjs`). They also live in pure; the tier exists for `--changed` mapping.
- **bundle / startup / electron** — need `npm run build` / a real Electron run. Electron harnesses
  on this box need `--ozone-platform=x11` (§9).
- `--changed` maps `git diff` paths through the manifest's `pathMap`;
  `group:paper-gate` is the paper editor's regression suite (15 scripts).

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
you're not rebuilding something deliberately deferred or rejected.

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

## 9. Known traps (each of these cost real time)

**Svelte 5 legacy syntax:**
- A `$:` block that reads **and** reassigns the same `let` is self-dependent — it re-runs until
  the loop guard. Memoize in a **non-reactive `const` box** (`const memo = {v: null}`) instead.
- `$: name = …` silently **assigns to an existing `let name`** in scope — it does not create a new
  binding. (This collided with a pan-quantizer variable and cost a 4× regression.)
- Key memos on object **identity** (e.g. a rect object), not its fields — field-keying re-runs
  per frame under pan.

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
  looks like success. Automated Electron harnesses therefore pass `--ozone-platform=x11` and
  demand **positive** boot evidence (e.g. a probe printing `windows=1 title=Flux`), never
  absence-of-errors.
- Delegated worktree agents fork from the **default branch**, not your branch. Give them an
  explicit `git reset --hard <sha>` as step one, and expect to reconcile your in-flight deltas
  when merging their result.
- pdf.js text layers hide during CSS-zoom (span boxes collapse to 0,0 *stably*) — waits need a
  nonzero two-poll-stable box, not a single poll. `TextQuoteSelector`'s field is `quote`, not
  `exact` — a wrong anchor field silently orphans annotations.

**Bundle/startup:** a static import from any eager shell module (`Shell.svelte`, stores,
`src/lib/references/*` used by Shell) into `src/shell/modes/**` drags an entire mode chunk into
Home. Dynamic-import at the call site; `verify-startup.mjs` (800KB eager budget, no mode chunks
at Home) is the gate. Mode warms belong in `requestIdleCallback`.

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
  + translate-x.

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
+ 4 scrubs), and a real-Electron present-mode acceptance on `~/anim_test` (x11, positive boot
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
