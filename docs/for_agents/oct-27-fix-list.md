# October 27 Flux fixes — implementation and verification record

This record is for agents maintaining the changes requested in `Oct_27_flux_issue_list.md`.
The user-facing behavior is documented in the Figure, Paper, Slide, Dissections and shortcut
guides. Work began on 2026-10-28 in the isolated `OCT-27-FIX-LIST` worktree and branch, based
on `6ad8289b`. The original issue document and its images are read-only inputs.

**Acceptance status: integration in progress.** Items 01–21 are implemented with focused
acceptance coverage. The final real-project zoom/pan investigation (22), production/native
qualification and final frozen regression results will be recorded below before completion.
No application installation, main-branch integration or remote publication is part of this work.

## Request-by-request implementation

| ID | Request and resulting behavior | Maintenance and acceptance pointers |
|---|---|---|
| 01 | Confidence bands follow resized axes instead of being translated as fixed-size marker symbols. Source SVGs do not need regeneration. | `plot/derive.ts` consults captured frame/role semantics when normalizing defs-backed uses; `relayout/apply.ts` composes the original placement affine into data geometry. The supplied transition plot's 112 band vertices were independently checked at four width ratios: baseline errors up to 163.32 pt, fixed errors below 0.0000007 pt. `verify-plot-resize-fixes.ts` pins coordinates, marker identity and exact native restoration. |
| 02 | Legends fit narrower plots by reducing columns first. A single column shrinks uniformly only when needed; fitting legends retain their native typography. Framed backgrounds follow wrapped entries, and titled legends retain their composition through uniform fitting. Wrapped figure legends keep their space above/beside axes. | `relayout/legend.ts` supplies one metric-only plan to solver and SVG writer; `constrained.ts` reserves outside-figure legend margins without feeding a beside-axes legend's width back into its own available width. The 93-case resize gate includes framed/titled geometry and exact native restoration. Real supplied density and transition SVGs were inspected at 0.45/0.65/1/1.5 native widths. Extreme axis-label crowding remains reported rather than silently shrinking independent axis typography. |
| 03 | Hiding plot parts tightens selection/hover/hit/marquee geometry. The outline remains tight during dragging/resizing, rotation and flips; showing content restores it. Saved placement dimensions stay authoritative. | `plot/visibleBounds.ts` caches post-mount drawable bounds. Relative screen matrices cancel nested SVG/viewport transforms; crop grabs retain the original placement frame. Hidden-pane measurement resumes only when shown. `verify-plot-visible-bounds.mjs` drives actual resize/crop/Undo, hidden-only clicks/marquees, rotation/flip and zero viewport-triggered DOM measurements. |
| 04 | Alt+F offers both inline Figure insertion and semantic Reference insertion, including panel references. Reference insertion replaces the selected prose and restores editor focus; inline figures retain their block insertion behavior. Unchanged preview bindings retain their subscriptions. | `paper/margin/views/FigureView.svelte`, margin types, `PaperMode.svelte`, `scholar/figures.ts`; `verify-figpicker.mjs` covers Whole figure/panel b, selection replacement, focus, existing embed insertion and 100 unchanged preview updates with zero reset mutations. |
| 05 | Figure thumbnail rendering shares concurrent requests by figure/revision, stays lazy and cached, and yields behind pending input. | `paper/scholar/figures.ts`; `scripts/perf/paper-figure-picker.mjs`. On 40 figures × 1,800 paths, cold @@ shell/first preview were 18/139 ms; warm were 0/0 ms at browser precision. Open-margin typing p95 was 1.5 ms synchronous / 36.2 ms for two animation frames. The fixture did not reproduce the owner's pronounced lag, so these measurements establish current responsiveness without claiming a large reproduced speedup. |
| 06 | Adding a dictionary word immediately clears its existing Flux diagnostics across active Paper editors in the same window. Native Chromium spellcheck is disabled across the editor, eliminating competing squiggles. | Language revision handling in `localCorrections.ts`, `markdown-setup.ts`; real + action and multiple occurrences in `verify-paper-spelling-choice.mjs`. Vocabulary reaches both worker lanes. |
| 07 | The sentence inference feature is removed from the active application: renderer service/controller/core, providers, managed runtime, downloads/model controls, secrets/lifecycle IPC, packaging/CI fetches, evaluation code/corpora/artifacts and active manual. | Only profileGet/profileSet remain in `electron/ipc/languageProfiles.cjs`. Harper mechanical checks, workers, dictionaries, aliases, dialect, guarded Undo/vetoes and reset remain. Regression checks assert retired settings/APIs are absent. Historical session records remain history; they are not runtime instructions. |
| 08 | The Personal dictionary receives a versioned set of 980 neuroscience/biology terms, including every word called out by the supplied spelling screenshot. User additions/case and explicit removals survive reopening. | `scientificVocabulary.ts`, `localCorrectionProfile.ts`, profile IPC tests. Seed recognition must not turn hundreds of related sensor names into new automatic correction neighbors; retain the distinction between seeded recognition and authored canonical corrections. |
| 09 | A spelling underline offers a vertical ranked list (up to five available suggestions), a custom word field and + Personal dictionary. A chosen/custom correction learns a durable mapping for future delimiter-triggered typing, with exact Undo. | `localSpelling.ts`, `localCorrections.ts`, profile and CSS. Only Spelling/Typo diagnostics enter this learned menu: contextual article/capitalization/grammar choices must never become unconditional aliases. Tests include actual Harper hover/selection/custom Enter, title case, reload persistence, dictionary clearing and a→an/the→The/then→than counterexamples. |
| 10 | Chase is the sole Paper caret behavior; Smooth settings, preference schema/default, subscription and implementation are removed. | `caretFeel.ts`, settings and editor setup; `verify-caret-feel.ts` preserves finite animation, IME teleport, multiple cursor/Vim behavior and geometry checks under the explicit new contract. |
| 11 | Figure sidebar width changes no longer invalidate CSS throughout the canvas. | Width props place `--sb-w`/`--insp-w` on the consuming rail roots instead of their shared body. In a 1,600-object dev fixture, 36 drag moves reduced left/right style work from 431/392 ms to 70/19 ms (about 84%/95%). These are headless dev measurements; see the final native evidence for its separate scope. |
| 12 | Alt+G toggles an expanded Plots view back to Layers (Slides in Slide mode), then returns to Plots/search. A hidden rail always opens to Plots. Editable fields outside the rail retain their keys. | `keyboard.ts`, rail host registry. Existing rail suites now assert the requested toggle instead of the superseded focus-only behavior, including collapsed gallery and cross-mode cases. |
| 13 | Alt+Shift+C and Ctrl+K → Copy selected plot path copy a selected plot's full path. Linked source paths use shared relocation rules; unlinked accepted SVGs resolve in their actual owning asset directory. | `figure/commands.ts`, `plot/source.ts`. Figure accepted assets are under project `fig/`; standalone and deck-owned/external Slide assets use their own bases. Async resolution refuses a stale project/deck snapshot. `verify-oct27-figure-gui.mjs` writes/reads the real isolated browser clipboard and checks linked/unlinked Figure paths, owning/external Slide paths and a deterministic deck switch during lookup. |
| 14 | The native tooltip that obscured rich Peek is removed. Peek retains metadata and gains concise interaction hints. | Tile descriptions use aria-labels; explicit action chips retain useful tooltips. `verify-gallery-notes-gui.mjs`, existing P3 Peek tests. |
| 15 | Multiple ordinary .txt plot notes can be created/edited in the sidebar and full Dissect viewer. Notes content search spans the project, including literal tags such as #TODO, and opens the matching note. | `dissect/notes.ts`, note draft core/registry and note components; `dissect:saveNote` performs sender/project checks, portable name/size/symlink confinement, baseline comparison, same-file serialization and durable atomic writes. A shared writer drains newer text during an in-flight save; shell owners retain dirty/conflicting drafts after the UI closes. Pure/GUI tests cover immediate switches/close, held IO, exact bytes, concurrent edits, external conflict and draft recovery. Native acceptance includes docked/pinned typing and close. |
| 16 | Alt+/ or Folders switches the lower rail pane to a searchable full plot directory tree; choosing a folder scopes the gallery. Reserved companion directories are pruned. | `DirectoryPane.svelte`, `PlotsRail`, `GalleryPane`. The tree includes empty folders, windows its rows and supports arrows/Home/End/Enter/Escape. IO/indexing are independent of query keystrokes. |
| 17 | Fullscreen gallery/dissection surfaces follow sidebar conventions: actual page aspect ratios, restrained borders, compact technical captions, square pages, flat tabs, selection accents and consistent typography. | Gallery preview and Dissect components. Existing windowing, preview/zoom, insertion, pin/dock ownership and keyboard flows remain; rendered browser screenshots are inspected separately from native utility-window acceptance. |
| 18 | Sidebar, Space preview, fullscreen gallery, dissection tiles and image details share the same readable background law. Transparent dark ink gets paper; light ink gets dark; declared backgrounds and explicit preferences are honored. | `plot/previewBackdrop.ts` uses shared thumbnail ink analysis, stamp/revision invalidation and stale callback cancellation. Detailed previews keep their full-resolution source bytes. Automatic mode does not subscribe to every active-project edit. |
| 19 | R opens X-ray; Alt+R selects Rectangle. Shift+Alt+R still opens a drilled part's family, and Shift+R keeps rulers. Figure/Slide and the Become picker use the same intended routing. | Keyboard, tool labels, Become UI, Help, user manuals and stock context updated together. Reader/Paper Alt+R keeps its unrelated reference-search behavior. Existing X-ray/Slide UI fixtures exercise real keys under the new contract. |
| 20 | Ctrl+K → New figure arms point placement at the requested upper-left, or the mathematically closest free frame position with a 24px gap. Alt-dragging a frame title duplicates its complete figure in the same family with the next number and a fresh reference. | Shared `figureLifecycle.nearestFigurePosition` uses forbidden position intervals, preserving fractional/negative coordinates. Project/canvas/tool changes and Escape cancel placement. Duplication starts only past slop and uses the shared identity/group/caption/attachment core and one checkpoint. Shift locks its dominant axis. Pure independent exhaustive oracle and actual GUI placement/cancel/duplicate/Undo/Redo tests guard this. |
| 21 | Selection edge/corner handles remain reachable beyond a figure frame; a marquee can start in outside canvas space and select active-figure elements. | `interact/handles.excludeZones` reserves title bars by subtraction instead of clipping all zones to the frame. Slide retains its stage policy. Existing interaction/selection/crop/frame gates plus actual outside-handle/marquee gestures validate hit priority and history. |
| 22 | Final rapid zoom/pan investigation — pending the non-performance acceptance cohort. | Use the October 1 overview for existing proxy/culling/compositor context. Do not implement its structural roadmap or mutate the real Synaptic Sleep project. Record the actual regression, bounded repair, before/after numbers and settle/input/export checks here. |

## Review findings that changed the implementation

Independent reviews caught and resolved stale placement after a tool switch, incorrect accepted-asset
clipboard bases, hidden-only hit/marquee selection, resize chrome reverting to hidden width,
contextual grammar choices becoming global spelling aliases, and note text arriving during an
in-flight save being left only in memory after closing the editor. Regression tests exercise
the trigger for each finding, not only the final stored model.

Follow-up tests also cover clipped-away SVG data (Chromium156 ignores getBBox clipped:true),
transformed/nested clip chains and objectBoundingBox units, deleted-note restoration while new
text is typed, external note-list refresh, and docked/pinned textarea Tab traversal. Async save
callbacks use the pure draft state after closing, without reading destroyed UI-derived values.
Scientific seed provenance records actual insertions, preserving previously authored Personal
canonical words and allowing an explicitly re-added seed word to become an authored target.

The final core review additionally caught a wrapped legend's unchanged background frame and
clipboard resolution using the next deck's directory after an async import. Framed/titled legend
geometry and a deck switch before async continuation now have direct regression coverage.

Corrupt, unreadable, oversized or invalid language profiles must fail closed: the seed and later
actions cannot replace existing bytes after failed hydration. Keep the failure visible and preserve
the user's in-memory words on write failure. The temporary-file profile gate covers these cases.

## Validation ledger

The implementation ledger is `notes/oct_27_fix_list/PLAN.md`; domain investigation details are
`PLOT_REPORT.md`, `PAPER_REPORT.md` and `GALLERY_REPORT.md` beside it. Notes/test outputs are
local artifacts, while this record and the engineering guide are tracked handoff documents.

Recorded integrated checks so far:

- Renderer check: **0 errors / 0 warnings**; headless TypeScript check: pass.
- Complete pure tier: **446 unique scripts passed** on the frozen core. The primary receipt
  `test-results/runs/2026-10-28T08-35-37-271Z-16/` passed 444/446; two environment prerequisites
  were then supplied without product changes. The pinned encoder check passed in
  `2026-10-28T08-44-23-565Z-16/`, and the headless 3D poster check passed in
  `2026-10-28T08-44-23-564Z-16/` using a test-only no-sandbox Electron launcher.
- Complete Paper regression group: **70/70**, source-stable receipt
  `test-results/runs/2026-10-28T08-47-30-265Z-16/`.
- Production native Paper diagnostic on a full disposable copy of the actual Synaptic Sleep
  project: 11 figures, real `ascs-abstract.qmd`, heaviest Figure 4 preview (15,115 SVG nodes).
  Across three trials per state, native key-to-two-frame p95 medians were **32.2 ms closed /
  32.4 ms Alt+F open**; all 252 keys arrived and no long tasks occurred. Cold @@ shell/first
  preview/all visible were **19 / 300 / 3,194 ms**; warm **65 / 66 / 67 ms**. The asynchronous
  preview completion time is separate from picker input latency. Artifacts/reproducer:
  `/tmp/oct27-real-paper-probe-pass2/`, `/tmp/oct27-real-paper-probe.cjs` and the Paper domain
  report. This is software/headless diagnostic native input, not physical GPU qualification.
- `group:oct27-figure`: **7/7**, source-stable receipt
  `test-results/runs/2026-10-28T08-01-07-753Z-2/`.
- `group:plots-rail`: **10/10**, source-stable receipt
  `test-results/runs/2026-10-28T08-02-07-491Z-2/`.
- Contract/manifest/path routing/docs/config/profile checks: **6/6** at the recorded interim
  checkpoint; final frozen profile checks include corruption/read/write preservation.

Full pure/Paper/affected Figure–Slide suites, production build/native acceptance, final source
identity, real-project performance results and preservation hashes remain to be filled before
this record is marked complete. No passing browser fixture is called physical GPU qualification.

## Reproduction rules

Run registered gates through `node scripts/run-verifies.mjs`; a new gate also needs its manifest
execution contract and changed-path route. Keep Paper's full `paper-gate` on :1420. Use scratch
HOME/XDG and copied projects for native checks. Do not open a windowed native gate on the owner's
desktop; existing private-Xvfb harnesses isolate their displays. Build before bundle/native tests.
Freeze source/generated-runtime changes during a cohort, and inspect its `sourceChanged` field.
When HMR gives a raw dynamic module URL a second instance, use the app's actual dev handle or
the exact loaded resource URL instead of testing an unrelated fresh store.

The original issue-list SHA-256 is
`0595cd8babc75e637839fcf3c7b5d85f4539e2af5e74fb6da585677b775aafb1`.
All real supplied plots/manifests and the owner's installed application/configuration remain outside
development mutations. Validate copies and report the exact scope of native/display evidence.
