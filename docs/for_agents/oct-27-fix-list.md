# October 27 Flux fixes — implementation and verification record

This is the self-contained maintenance record for every request in
`Oct_27_flux_issue_list.md`. Work began 2026-10-28 in isolated worktree/branch
`OCT-27-FIX-LIST`, based on `6ad8289b`. The original issue document and screenshots
are untouched read-only inputs. User behavior is documented in the Figure,
Paper, Slide, Dissections and shortcut guides.

**Completed:** all 22 requests are implemented and the verification targets below
pass. Application runtime is committed at `5b6fc5a8`; subsequent commit
`e0a53fbb` corrects verification fixtures for the requested contracts without
changing application code. The final documentation commit records this handoff.
All work stays in `OCT-27-FIX-LIST`. The measured software-display limitations are
reported explicitly; no universal physical-GPU timing guarantee is claimed.

## Request-by-request implementation

| ID | Request and resulting behavior | Maintenance and acceptance pointers |
|---|---|--- |
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
| 20 | Ctrl+K → New figure arms point placement at the requested upper-left, or the mathematically closest free frame position with a 24 px gap. Alt-dragging a frame title duplicates its complete figure in the same family with the next number and a fresh reference. | Shared `figureLifecycle.nearestFigurePosition` uses forbidden position intervals, preserving fractional/negative coordinates. Project/canvas/tool changes and Escape cancel placement. Duplication starts only past slop and uses the shared identity/group/caption/attachment core and one checkpoint. Shift locks its dominant axis. Pure independent exhaustive oracle and actual GUI placement/cancel/duplicate/Undo/Redo tests guard this. |
| 21 | Selection edge/corner handles remain reachable beyond a figure frame; a marquee can start in outside canvas space and select active-figure elements. | `interact/handles.excludeZones` reserves title bars by subtraction instead of clipping all zones to the frame. Slide retains its stage policy. Existing interaction/selection/crop/frame gates plus actual outside-handle/marquee gestures validate hit priority and history. |
| 22 | Dense native zoom uses cooperative preparation, a bounded child rasterizer, complete capture ownership, retained coarse pixels and captured-DOM retention through settle folds. Opaque mattes preserve transparent artwork without changing frozen-SVG opacity. Inert singleton semantic clips are safely consolidated and restored before edits/effects. | `zoomProxy.ts`, `sceneCaptureSupplement.ts`, shared Canvas, `electron/sceneRaster*`, clip normalization/restoration and registered `scene-raster` / `dense-zoom-native` gates. Portable native acceptance:193/193 proxy events, zero remounts,30 checks passed under the unchanged 100 ms budgets. Actual-project p95 frame/entry 16.8/19.5 ms; retain its software-rendered maximum 117.8 ms and 103 ms long task. Full mechanisms, measurements, reproducible checks and qualification limits follow below. |

## Review findings and implementation safeguards

Independent reviews resolved stale point placement after tool/project changes,
accepted-asset clipboard bases and asynchronous deck ownership, hidden-only plot
hits/marquees, tight bounds reverting during resize, wrapped legend frames,
contextual grammar becoming unconditional spelling aliases, seed provenance,
corrupt-profile preservation, note input arriving during an in-flight save, and
note restoration losing newer input. Their gates exercise the triggering action
and failure state, not just the final stored model.

Scientific vocabulary provenance records only words actually inserted by the
seeder. Preexisting authored Personal canonical words still participate in
technical near-match correction; a deliberate re-addition promotes a seeded word
to an authored target. Versioned removals stay removed. Invalid/unreadable native
profiles fail visibly and cannot be replaced by seed hydration or later writes;
in-memory user edits survive a failed save.

Shared note writers retain ownership after UI close, serialize per-file IO,
check expected bytes, drain newer text and refuse a conflicting/external
replacement. Deleted dirty notes remain explicit recoverable drafts. Search
crosses project plot owners independently of folder scope, while query typing
does not rescan disk. Fullscreen/pinned controls use native event listeners and
correct textarea Tab traversal; detailed previews keep full source bytes.

The final read-only review at `5b6fc5a8` found no new concrete defect in note
ownership/search, preview invalidation, dense capture ownership, pointer camera
handoff or clip restoration. That review is separate from the final execution
receipts are reconciled below.

## Final responsiveness investigation (item 22)

The non-performance core was implemented and qualified before this final
investigation. The October 1 overview was read in full for context; its manifest
split/per-figure-raster structural roadmap was not implemented. All actual-project
native runs use complete disposable copies and isolated HOME/XDG/project locks.

### Diagnosis and bounded repair

The supplied project mounted roughly 73k–75k SVG elements. The preexisting browser
snapshot path declines above 20,000, so it had no proxy even after resting.
Read-only history found that cap and the quiet/culling rules already existed in
September; no particular recent source commit was proved responsible for the
reported regression. Retained baseline `/tmp/oct27-zoom-baseline-rest/` sent 24
reverse-zoom events but observed 13, no proxy ticks and p95 frame gaps 150 ms.
The native wheel timestamp-to-paint p95 was 818.7 ms. A direct preparation probe
cost 200.3 ms:74.7 ms clone,13.1 ms component styles and 112.5 ms serialization on
34.8 million SVG characters. Raising the synchronous cap would move that work
into input handling.

The final implementation preserves the existing live SVG/editor and transient
viewport-proxy architecture:

- Small scenes retain the≤20k browser serializer/decoder. Dense Electron captures
  use a cancellable cooperative XML walk, then a dedicated supervised child via
  `scene:rasterize`. Admission remains≤150k elements/64 MiB UTF-8; output is two
  bounded planes,4096 px sides,3 MP sharp plus 1 MP coarse including device scale.
  Each worker input has that region's bounded dimensions: no huge whole-scene
  image is allocated at the sharp zoom. Resource/font/vector-effect safety,
  binary transport, latest-only queuing, cancellation, project/sender identity,
  timeout/crash handling and packaged imports have registered pure/native gates.
- Content identity includes revisions of all figures on the canvas. Mounted-set
  membership is separate: a captured subset may be reused, but uncaptured art
  and offscreen edits retire it. A bounded detached supplement uses the shared
  export/render helpers only inside already-present frames (32 placements,
  2 MiB source/model/manifest,10k extra nodes,150k total). It records only
  successfully captured IDs and never mounts a frame or changes source data.
- Whole-scene coarse pixels survive a sharper subset through explicit canvas
  ownership transfer; retired/newly declined canvases are released. A new opaque
  sharp patch is refused if it would hide inherited captured art missing from
  that patch. Complete, current, covering snapshots protect the first camera tick
  before reactive proxy activation and retain already-mounted captured dense DOM
  through settle folds. Ordinary resting culling still admits newly visible art.
  Content/membership/coverage/context/matte failure restores normal discovery;
  this is bounded captured residency, not an unconditional project-wide freeze.
- Traces identified 84–95 ms handoff repaint/layerization tasks from changing the
  frozen SVG's opacity. The live scene now keeps its display/opacity unchanged
  behind an opaque host matte. Both raster planes have the same unfiltered matte,
  so sharp-over-coarse composition neither doubles translucent artwork nor needs
  an antialiased clip hole. View-as filters apply only to the hosted canvases.
  Known solid ancestor colors resolve an RGBA host; unsupported gradients or
  compositing use the live scene. Whole-viewport PNG references strip the
  implementation mattes and use the real host/ancestor background independently:
  opaque, RGBA and colored-host grayscale cases all have zero differing pixels.
  Unsupported-gradient live rendering also preserves exact composed pixels.
- Pointer entry folds/flushes the true camera before resolving the hit. The frozen
  SVG is not the current camera during a proxy burst. Trusted click/drag checks
  cover current geometry and previously unmounted destinations.

### Singleton semantic clips and restoration

Remaining settle cost was browser layout/PrePaint/Paint/layerization rather than
contemporaneous capture/JavaScript/GC. The source contained 22,239 clipped geometry
leaves individually wrapped in static semantic groups. `hoistPlotClips` now groups
adjacent static leaves and inert singleton semantic wrappers sharing one user-space
clip while retaining all original nodes, IDs, order and metadata. Pristine source
and exported bytes are unchanged. Structural/conditional CSS, transforms including
CSS individual transforms, opacity, filters/masks, animations, glyphs, nongeometry
and objectBoundingBox clips opt out. Only the existing atomic universal cap/join
stylesheet subset may be baked.

`data-flux-clip-leaf` preserves original ownership through cloning/prefixing.
`restorePlotClip` restores each original leaf clip before semantic translation or
opacity, editor presentation/ghosting, marker projection, relayout transform,
player effects/content morphs and semantic-part extraction. Identity wrappers
remain valid for held gesture references. Exact zero-pixel regressions cover
curved clips, visibility/opacity, transforms, player endpoint/mid/reseek, ghosting,
edge fades, marker and annotation-arrow movement. Real trusted Ctrl-drag commits
one 24/13 displacement, and Undo restores/remounts the optimized untouched source.
The retained 2,551/2,844-pixel failures drove these repairs; tolerances were not
increased. Focused evidence: style-bake 126/126 (`13-10-17-307Z-2`), landmarks 73/73
(`13-04-15-958Z-2`), render optimizations 49/49 (`13-12-24-811Z-2`) and part-move 67
checks (`13-05-36-590Z-2`). Final integrated coverage remains listed below.

### Measurements and qualification limits

These are different input/runtime scenarios. Preserve their separate scope;
handler-entry timing is not end-to-end hardware latency.

| Scenario | Preserved result |
|---|--- |
| Supplied-project reverse zoom baseline |p95 frame 150 ms; native timestamp-to-paint 818.7 ms;13 observed events from 24 sends; no proxy |
| Three repaired reverse runs |p95 frame 16.8 ms; wheel timestamp-to-paint 36.3–59.1 ms; all 24 zoom ticks proxied in each run |
| Corrected wide-out→Shift-pan→rezoom navigation |48 actual delivered wheel events;36/36 zoom events proxied; entry-to-paint p95≈19 ms; frame p95≈16.7 ms; native injection queue p95≈146 ms; timestamp-to-paint≈163 ms in the same run |
| Same navigation, precise-wheel flag | No material queue improvement; retained negative experiment, not a product speedup |
| Three-cycle 16× deep stress before captured-DOM retention | ≈13 s phase; p95 frame≈116 ms; large mount tasks up to 1031 ms |
| Retained deep stress | ≈6.6 s phase; p95 frame 16.8 ms; entry-to-paint≈22 ms;193/193 proxy observations, avoiding repeated dense unmount/remount |
| Latest supplied-project clip-clean diagnostic |193/193 proxied; p95 frame 16.8 ms and entry 19.5 ms; retained maximum entry 117.8 ms and one 103 ms long task |

The larger real-project result is software-rendered diagnostic evidence. Its
maximum 117.8 ms entry/103 ms task is explicitly retained; it must not be described
as a universal≤100 ms guarantee or physical-GPU presentation qualification.
Unphased 8 ms native notch injection can also build a transport queue independently
of the≈20 ms renderer-entry response; the exact queue metric must not be silently
subtracted or replaced by an entry percentile. Native/screencast/trace runs keep
their own overhead and cannot be interchanged with clean timing results.

### Portable native acceptance fixture

`verify-dense-zoom-electron.cjs` saves a self-contained two-frame project with 18
reused SVG panels,72k live nodes and 18k clipped singleton wrappers before
normalization. Two small initially culled plots in an already-mounted frame are
captured by the bounded supplement. It uses production code/preload and actual
native input/pixels, not development viewport/model handles or `/data` fixtures.
The declared qualified cadence is 16 ms per native notch with product background
throttling preserved and focus verified; the ordinary diagnostic 8 ms cadence is
unchanged and pure policy tests reject implicitly changing it. All three cycles,
all 36 outward notches per cycle, all delivered events and existing 100 ms budgets
remain enforced.

Source-stable focused receipt
`test-results/runs/2026-10-28T13-24-16-524Z-2/`: **30 native checks passed**.

| Native observation | Result |
|---|--- |
| Initial→wide-fold live SVG nodes |72,256→72,320 |
| Initial→final live models |19→21; both supplements appear at first wide fold |
| Delivered/proxy zoom events |193/193 |
| Disconnected/changed initial wrappers at all six folds |0/0 |
| Proxy residency | Two canvases;1,849,128 initial physical pixels;≤4 MP/4096 px bounds |
| Frame p95 / maximum |16.8 /33.3 ms |
| Handler-entry-to-paint p95 / maximum |19.5 /21.6 ms |
| Native timestamp-to-paint p95 / queue p95 |47.3 /29.5 ms |
| Navigation long tasks |None |
| Trusted Delete→fresh white native pixels |66.6 ms |
| Trusted Undo→restored magenta native pixels |33.6 ms |

The independent policy (`verify-dense-zoom-policy.cjs`,52 checks) plants missing
events/samples, residency/remount, stale/blank/wrong marker, late native pixels,
wrong source window/URL, focus and DOM/pixel disagreements. Delete/Undo use the
trusted key's own clock and one-DIP native capture polling within the unchanged
100 ms deadline. Earlier Delete samples at 48.2/59.7 ms still showed submitted old
magenta pixels while model/Layer/proxy state was already fresh; those negative
samples are retained. White appeared at 66.6 ms, Undo magenta at 33.6 ms. Double-rAF
alone is therefore not called native presentation. The original failed receipt
`13-16-00-571Z-2` remains available. The fixture qualifies the isolated private
software display, not the owner's physical GPU/display.

### Preview ResizeObserver ownership follow-up

The native gallery gate once failed only its clean-renderer check with
`ResizeObserver loop completed with undelivered notifications` after its note,
focus and playback checks passed. Original receipt
`2026-10-28T11-58-08-667Z-286` and a separate original log remain retained.
Instrumented original flow, repeated detail/resize and six dock/pin cycles did
not reproduce that warning; its exact cause is not claimed proved or filtered.

The traces did prove a separate lifecycle mismatch: GalleryPreview's shared
size observer stayed in the opener after its span was adopted into the utility
document. `GalleryPreview.svelte` now uses an ownerDocument ResizeObserver,
immediate sizing, adoption-event reconnection and cleanup. `PlotImporter.svelte`
dispatches the existing `flux:document-change` convention; DissectGrid/Detail
were not changed without evidence. The real native acceptance hides the opener,
resizes the utility twice, docks/resizes the opener, then repins and checks fit
against actual owner geometry. Source-stable rebuilt receipt
`2026-10-28T12-38-25-009Z-40`:24/24 checks in 3.0 s; widths 243→207→217→231→243 match
their owners. Image/video paints 27.0/36.9 ms remain under 100 ms, with no renderer
errors. The final-build native rerun also passes; its receipt is in the ledger below.

## Validation ledger

Runtime qualification used clean commit `5b6fc5a8` with source digest
`b6fa07fb7ec8caab150893eb86793be7ba683f8268aafd223a5bbe901fb92194`.
Every registered cohort below reports `sourceChanged: false`. Corrections in
`e0a53fbb` change five verification files only; they preserve the measured
application, existing timing budgets and all behavioral assertions.

| Check | Final result and evidence |
|---|---|
| Renderer / headless / production build | **PASS**; Svelte **0 errors / 0 warnings**, headless TypeScript and production build succeed. Logs: `/tmp/oct27-accept-{check,headless,build}.log`. |
| User documentation build | **PASS**, **22 pages / 46 generated files**, Quarto 1.7.32. `/tmp/oct27-accept-docs-isolated.log`; a temporary `XDG_CACHE_HOME`/`DENO_DIR` avoids the host's unwritable Quarto cache. The initial cache-permission failure is retained. |
| Pure tier | **449/449 reconciled**. Primary clean-source receipt `2026-10-28T13-28-44-235Z-27` passed 448/449. The sole failed control executed an unexpanded probe template; the corrected registered test passes all 44 assertions in `2026-10-28T14-19-38-204Z-16`. |
| Combined UI / UI-extra / Paper | **263/263 reconciled**. Primary clean-source receipt `2026-10-28T13-35-37-374Z-71836` passed 259/263; the four explicit contract/environment corrections below all pass. |
| Complete Paper group | **70/70 in the primary combined cohort**, with no correction or retry needed for this group. |
| Scale | **4/4**: Figure, Paper, lazy assets and dense Slide. Receipts `2026-10-28T14-11-48-244Z-144126`, `14-12-05-642Z-144661`, `14-12-24-805Z-145201`, `14-12-41-171Z-145747` (all dated 2026-10-28). |
| Bundle / startup | **6/6**, receipt `2026-10-28T14-13-17-291Z-146365`. |
| Native targets | **8/8 reconciled**: Figure polish, scene raster transport, portable dense zoom, relayout PNG/PDF/offline export, Plots rail, gallery notes/video/adoption, source sync and full gallery workflow. Seven primary receipts and the corrected gallery receipt are listed below. |
| Final supplied-project visual diagnostic | **PASS**, `/tmp/oct27-final-qualified-visual/flicker-verdict.json`: **191 sampled frames**, no sampled blank/flash failures and **0 tile warnings**. Sampling is not a proof of every physical presentation. |
| Preservation | Original issue SHA unchanged; all 3,732 non-session files byte-identical; only the pre-existing live-session metadata file changed. See the precise scope below. Main remains clean at `6ad8289b`. |

All receipt directories are under `test-results/runs/`. The full suite commands
were `--tier pure --jobs 4` and
`--tier ui,ui-extra --group paper-gate --jobs 1`. The latter contains the
entire required Paper group on the fresh :1420 dev server.

The failed attempts remain recorded. Their reconciliation is deliberate:

- `verify-model3d-s8-policy.cjs`: evaluate the actual Node-side `INSTR` template
  before running its renderer program. Raw-timing precision and every original
  policy assertion remain; this changes no benchmark or application behavior.
- `verify-shell-complete.mjs`: removing the sentence-model controls shortened
  Corrections. Real 1024×400 and 760×360 windows now prove actual overflow and
  exact nonzero per-tab scroll retention. Receipt `2026-10-28T14-21-10-864Z-28`.
- `verify-colorpicker-narrow.mjs`: the width variable now belongs to the
  Inspector itself. The test sets that consumer and asserts each actual width
  before checking all seven layouts. Receipt `2026-10-28T14-21-32-379Z-568`.
- `verify-p5-paper.mjs`: item 06 explicitly supersedes the old native-spelling
  expectation. It now requires `spellcheck="false"`, retaining find/replace and
  chip-hint checks. Receipt `2026-10-28T14-21-41-621Z-1119`.
- `verify-capture-e2e.cjs`: the original launch aborted on the host's unconfigured
  SUID helper before executing tests. A private Xvfb and test-only no-sandbox
  launch pass unchanged code in `2026-10-28T14-17-09-463Z-41`; no host permissions
  or real download/library state were changed.
- `plotGalleryProbeEntry.cjs`: native workflow selectors used the tooltip titles
  intentionally removed by item 14. Accessible directory labels replace them;
  all navigation, insertion, persistence and utility-window checks pass in
  `2026-10-28T14-19-51-401Z-41`.

The seven primary native passing receipts are:
`2026-10-28T14-13-34-437Z-149054` (Figure polish),
`14-13-58-250Z-150134` (scene raster),
`14-13-59-496Z-150423` (dense zoom),
`14-14-14-092Z-151493` (relayout export),
`14-14-17-407Z-151739` (Plots rail),
`14-14-25-943Z-152795` (gallery previews/notes), and
`14-14-29-936Z-153728` (source sync), all dated 2026-10-28.
Final 5,000-object Arrange direct opening is **93.9 ms**, below the unchanged
100 ms gate; the earlier 104.3 ms failure and first repaired 90.5 ms run remain
recorded rather than selecting one favorable sample.

Earlier core/interim results are historical checkpoints, not substitutes for
these final runtime results. The ignored local
`notes/oct_27_fix_list/FINAL_ACCEPTANCE.json` records the latest passing receipt,
source identity and status for every script. A fresh checkout can reproduce
coverage through the registered manifest; it does not need those local notes.

The production Paper diagnostic used the actual `ascs-abstract.qmd` and heaviest
Figure 4 preview on a disposable project copy. Native typing p95 medians were
**32.2 ms closed / 32.4 ms Alt+F open**, all 252 keys arrived and no long tasks
occurred. Cold `@@` shell/first/all previews were **19/300/3,194 ms**; warm were
**65/66/67 ms**. Asynchronous preview completion is separate from input latency.
Artifacts: `/tmp/oct27-real-paper-probe-pass2/`; reproducer:
`/tmp/oct27-real-paper-probe.cjs`.

## Reproduction and future-agent traps

Run registered checks through the verification runner. With current dependencies,
a current build and a dev server at`:1420` (check before starting another):

```sh
npm run check
npm run check:headless
npm run build
node scripts/run-verifies.mjs --tier pure --jobs 1
node scripts/run-verifies.mjs --tier ui --group paper-gate --jobs 1
node scripts/run-verifies.mjs --group scene-raster --jobs 1
node scripts/run-verifies.mjs --group scene-raster-native --jobs 1
FLUX_XVFB=/path/to/Xvfb node scripts/run-verifies.mjs --group dense-zoom-native --jobs 1
FLUX_XVFB=/path/to/Xvfb node scripts/run-verifies.mjs --tier electron --only verify-gallery-preview-electron.cjs --jobs 1
```

On this machine `/tmp/flux-analysis-xvfb/root/usr/bin/Xvfb` was a temporary
environment override, not a repository dependency. Use the installed private
display/CI executable elsewhere. A separate explicit test desktop is required
before enabling non-Linux native-window tests. Run latency serially; do not
compete with builds, JSON trace analysis or another browser/native measurement.
The native helpers own scratch HOME/XDG/project paths and child-process groups.
Never point a diagnostic edit phase at the source project or live configuration.
The docs build can be reproduced with a writable temporary `XDG_CACHE_HOME` and
`npm run build:docs`; the cache permission workaround changes no product source.

For actual-project comparison, `scripts/perf/input-probe.cjs` supports
`zoomFast`, `zoomBursts`, `zoomNavigate` and `zoomDeep`; use the copied-project/
scratch launcher and saved exact runtime/arguments from the chosen retained
receipt. The archived 24-tick reverse diagnostic is a separate temporary
reproducer, not an additional `zoomReverse` phase in the shipped probe.
Do not assume `sendInputEvent` means an event was delivered. Wait for observed
event/paint barriers before querying a subsequent camera stage. While a proxy
is active, `.scene-svg > g` is deliberately frozen; use the displayed proxy's
`data-world-box`, `data-raster-size` and transform, or the actual model viewport
when available. Compute destination coordinates from that camera and the copied
committed model, and assert the destination is actually inside the final viewport.
Recheck host geometry after native window-manager/maximize changes.

Report native timestamp-to-paint, timestamp-to-handler queue, handler-entry paint
and rAF frame gaps separately. Keep clean cadence/runtime comparisons, traced
attribution and saved visual frames distinct. Screenshot/screencast samples do
not prove every physical presentation. Read `sourceChanged` before claiming an
exact-source cohort. After HMR, a raw module import can create a second store
instance: use the app's current dev handle or exact loaded resource URL.

New verification scripts require manifest execution contracts and changed-path
routes. Dedicated entry points are `scene-raster`, `scene-raster-native` and
`dense-zoom-native`; the latter includes the planted-failure policy plus the
actual production native gate. Font sources/OFL and conversion provenance are
under `resources/fonts/` with `scripts/build-scene-fonts.py`; packaging must keep
the complete worker import closure unpacked. Do not remove font/resource refusal
guards, clone-safe clip markers, leaf restoration seams, complete-membership
proofs, transient ownership/cancellation or exact pixel/100 ms assertions to make
a gate green.

## Preservation, scope and delivery

The source project audit covers **3,733 files /948,720,365 bytes**, with no added
or removed files or symlinks. **3,732 files are byte-identical**, including all
authored figures/plots/manifests/manuscripts/profile bytes. The sole changed path
is the existing 339-byte live-session metadata file
`.meta/live/sessions/f6005afd-6098-47f6-99b6-cc05361f3ee6.json`, from the pre-existing live client
`PSY-WK-1P1Q2H4`, started `2026-10-27T15:51:43.619Z` before this task.
Our copied projects exclude `.meta/live` and `.meta/locks`. Do not describe the whole tree as byte-identical while
omitting that concurrently updated session metadata. Per-file before/after records are
in `notes/oct_27_fix_list/source-project-{before,after}.json`.

The original issue document remains untouched and its SHA-256 is unchanged:
`0595cd8babc75e637839fcf3c7b5d85f4539e2af5e74fb6da585677b775aafb1`.
Its linked source screenshots and supplied source SVG/manifest inputs remain
read-only. The installed application and real user configuration were not
installed over, reloaded or edited. The science seed operates through normal
Personal-profile hydration when this implementation is used; development used
isolated profiles rather than writing the owner's real dictionary directly.

Main remains clean at `6ad8289b`; all application work is in the isolated
`OCT-27-FIX-LIST` branch/worktree, runtime commit `5b6fc5a8`. No install, main
merge or remote push was performed. Application code and verification fixtures are committed; this final tracked
handoff and the engineering guide record the completed work and its measured
qualification scope.

Local domain evidence lives in `notes/oct_27_fix_list/` (`PLOT_REPORT.md`,
`PAPER_REPORT.md`, `GALLERY_REPORT.md`, `SCENE_RASTER_REPORT.md`,
`RESIZE_OBSERVER_DIAGNOSIS.md`, `CLIP_HOIST_REPORT.md`,
`DENSE_ZOOM_REGRESSION.md`). Those ignored notes and temporary diagnostic artifacts
may not accompany a later checkout; this tracked handoff, the engineering guide,
registered gates and the final receipt references are the durable maintenance
record. Temporary `/tmp` reproducers are retained conveniences, not shipped
runtime dependencies.
