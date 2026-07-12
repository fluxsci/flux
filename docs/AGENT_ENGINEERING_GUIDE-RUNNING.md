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
  verb registry** (`flux-core/registry.ts` + `flux-core/verbs.ts`, ~86 verbs). They operate on
  project files directly through `flux-core/*` (Node).
- **Live bridge** (`electron/bridgeServer.cjs` + `src/lib/project/liveClient` path) — a loopback
  control server per open project that dispatches ~38 verbs against the **live GUI store**. Its
  switch IS its allow-list; it is deliberately NOT part of the registry.

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
| Slide deck normalization (migrate + track ids) | `normalizeDeck` in `src/lib/slide/ops.ts` | `verify-deck-migrate.ts` |
| Present-mode input/HUD | `src/lib/slide/present/core.ts` | `verify-present-core.ts` |
| CLI/MCP verb surface | `flux-core/registry.ts` + `verbs.ts` | `verify-registry-parity.ts` (goldens) |

## 3. Data model and persistence invariants

A project is a folder: `project.json` (manifest), `manuscript/**.qmd` (text is truth),
`fig/index.json` + `fig/canvases/<id>.json` + `fig/captions/<id>.md` + `fig/assets/`,
`slides/<deckId>/deck.json`, `references/library.bib` (the project's *cited subset*),
`.meta/` (locks, journal, live bridge). Machine-global state lives in `~/FluxConfig`
(pointer pref `fluxConfigPath`); the reference library is **always derived** as
`<FluxConfig>/FluxLib` — never persist or read a separate `fluxLibPath`
(`verify-fluxconfig.ts` gates this). Machine config dir is lowercase `~/.config/flux` only.

Persistence invariants (all machine-checked — do not weaken):

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
- The **paper editor's feel is LOCKED** (see §5). Its internals: CodeMirror 6, decorations as a
  pure function of the document, per-editor state via facets (no module singletons), block
  StateFields change-gated by `science/changeGate.ts` so prose keystrokes pay zero construct cost.
- Electron: `main.cjs` is a **composition root**; handler families live in
  `electron/ipc/{contract,files,terminal,network,agent}.cjs`. Every IPC channel is declared in
  `contract.cjs` (`verify-ipc-contract.ts` — no orphans in either direction). The renderer runs
  under a **CSP with no `unsafe-eval`** — see §5.

## 5. Hard rules — do not do these

1. **The Paper editor's editing feel is LOCKED** (owner sign-off). Read
   `src/shell/modes/paper/EDITING-FEEL.md` before touching `src/shell/modes/paper/**`, and run the
   full paper gate after ANY change there. Never change cursor/typing behavior unless the user
   explicitly asked for that specific change.
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

Standing status (dev-mode, scale fixtures, as of 2026-07-12) — instantaneous class is green:
paper keystroke @20k lines 5ms sync / 34ms paint p95, undo ~1ms, figure pan 16–47ms, library
scroll 17ms p95 @5k refs, reader page-jump ≤56ms, warm fulltext 73ms @5k PDFs. Known items above
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
  pure --jobs 4` (~15s, currently 124 scripts, must stay green at all times).
- **ui / ui-extra** — puppeteer against the dev server on :1420 (`scripts/lib/driver.mjs`;
  fixtures via `?fixture=demo`, dev handles `window.__flux`, `__fluxView`, `__fluxSeed*`). ui is
  the curated stable suite (41), ui-extra the full sweep (60). Consoles must be **clean** —
  there is no tolerated-404 filter anymore.
- **scale** — the perf budgets (figure/paper/library/reader/fulltext). These are the standing
  60fps/scale contracts from the polish mandate.
- **presence** — the six source-shape/regex scripts (main-process/build config that headless
  drivers can't exercise). They also live in pure; the tier exists for `--changed` mapping.
- **bundle / startup / electron** — need `npm run build` / a real Electron run. Electron harnesses
  on this box need `--ozone-platform=x11` (§9).
- `--changed` maps `git diff` paths through the manifest's `pathMap`;
  `group:paper-gate` is the editing-feel contract (15 scripts).

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
- Headless box (ssh/tmux, no monitor). The Wayland compositor can die mid-session and Electron
  then **hangs before executing any JS** — silence looks like success. Always pass
  `--ozone-platform=x11` and demand **positive** boot evidence (e.g. a probe printing
  `windows=1 title=Flux`), never absence-of-errors.
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
