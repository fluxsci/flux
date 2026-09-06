**Flux Figure — review and implementation plan**

Reviewed September 5, 2026, on `codex/figures-slides-overhaul`, application baseline
`35c5bbe`. This is a review and plan; no application fixes have been applied by this review.

The recommendation is a focused pass over correctness, direct manipulation, shared editing
controls, and interface organization. The current architecture is worth retaining. The audit
found concrete defects that should be corrected before a larger visual redesign, including
two persistence hazards that matter to existing projects.

**Scope and method**

Read the engineering guide and Figure user guide; inspected the shared Canvas, Inspector,
Sidebar, Toolbar, F menu, numeric controls, keyboard dispatch, geometry operations, history,
import/export, asset residency, captions, references, source synchronization, and Figure/Slide
mode lifecycle. Exercised these through the dev server on port 1420 using isolated demo
fixtures and the repository's Puppeteer driver. Additional probes used real pointer/keyboard
events after seeding small, deterministic models; persistence faults used the in-memory bridge.

The browser was Brave's Chromium executable because this machine has no Google Chrome at the
driver's default path. Performance figures below are measurements of the dev build, not a
claim about packaged Electron performance. No current user project was opened or modified by
the probes. The real FluxLib bibliography's SHA-256 remained unchanged.

**Confirmed findings, in implementation priority order**

| ID | Priority | Finding and evidence | Proposed correction |
| --- | --- | --- | --- |
| F01 | P1 — preservation | A failed Figure save followed by switching to Slides discards unsaved edits. A marker was present and dirty after an injected write failure; the switch evicted Figure and reset history; returning to Figure lost the marker. Both mode mounts contain the same flush-then-evict pattern. | Make shared-store handoff conditional on confirmed durable save success. Preserve the current tenant, model, selection and history on failure, with retry/conflict recovery. Test both directions and rapid switches. |
| F02 | P1 — compatibility | Legacy index labels are copied verbatim into `referenceKey`, but the canvas schema requires `^fig-.+`. In the existing lazy-save fixture, labels `lazy-1` through `lazy-6` load, save, then cause all six figures to be rejected on reload. Asset files still pass their byte-preservation checks. The original canvas is quarantined, but the editor opens empty. | Reconcile migration and validation without silently changing existing references. Preserve legacy identities or provide an explicit, reference-preserving migration; validate the final migrated save model. Prevent rejected compositions from being replaced by a later empty save. |
| F03 | P1 — direct manipulation | The reported stale selection rectangle is reproduced. Selecting B in Layers updates selection and Inspector while the rectangle remains around A. Escape clears the selected IDs but leaves A's box visible. The `overlayBox` reactive expression calls `selectedEls(fig)`, hiding its `$selection` dependency from Svelte's static analysis. The change originated in `4fd87a3f`. | Make selected elements and their dependencies explicit. Derive overlay, handles, hit targets and Inspector state consistently. Preserve Slides' unborn-element/ghost rules. Test selection-only changes without a compensating model mutation. |
| F04 | P1 — undo | Alt-pointer-down on an object, then Escape before any drag, removes the previous completed edit. The probe reverted x=70 to x=40 and left neither undo nor redo. `cancelGesture()` rolls back whenever Alt duplication was requested, even if duplication never opened a history entry. | Roll back only the transaction owned by the active gesture. Use an explicit gesture checkpoint/ownership contract; preserve prior undo and redo when a gesture never changes the model. |
| F05 | P1 — property editing | F-menu edits depend on how a field was entered. Clicking “no fill” or typing x=175 into a clicked field creates no undo entry. Typing `240` into a mouse-focused width field produced width 24 and toggled no-fill: the final `0` was intercepted as a menu hotkey. | Give mouse, Tab, hotkey and search activation the same field lifecycle. Suppress command shortcuts during text entry. One committed edit equals one undo step; Escape restores the edit's baseline. |
| F06 | P1 — saving existing content | Removing panel-label elements from the unchanged demo figure makes saving report a caption conflict although the Markdown sidecar was never edited. The accepted base uses bold panel markers; the old sidecar uses `(a)` markers. Reinterpreting both through the *new* panel topology makes equivalent old captions look different. | Compare accepted caption snapshots independently of current label topology. Preserve stable label IDs and recoverable caption text; distinguish a real concurrent edit from a formatting/topology change. Share the correction with GUI, Paper readers and headless save. |
| F07 | P2 — cancellation | The Canvas binds `pointercancel` to the commit handler. Cancelling a drag in the probe committed x/y movement. Escape during an Inspector numeric scrub also kept the value and cleared selection. Guides, node/bend drags, rails and reorder controls have separate cleanup paths. | Define finish/cancel behavior once and adapt each gesture. Cover Escape, pointer cancellation, lost capture, window blur, tool/mode changes and unmount. Preserve selection on the first Escape that cancels a gesture. |
| F08 | P2 — locking | Moving the free object in a mixed locked/free selection moved both objects. Canvas only disables handles when *all* selected elements are locked; move snapshots include the whole selection. Keyboard and Inspector mutation routes also need a consistent effective-lock policy. | Resolve eligible targets using ancestor-group state and operation capability. Keep locked content inspectable while preventing incidental transform/deletion through mixed selections. Explicit unlock remains available. |
| F09 | P2 — resize precision | An aspect-locked east handle dragged inward by 40 px did not shrink a 120×100 rectangle. The shared resize math compares the changed ratio with an unchanged ratio of 1. Minimum-size crossing also moves the supposedly fixed opposite edge. Separately, repeated width updates from 120 to 200 yielded 200×180 under aspect lock, rather than retaining the original 1.2 ratio. | Derive aspect-preserving resizing from the active axes and the gesture's original geometry. Clamp at the fixed anchor. Keep fractional precision through scrubs and apply explicit pixel snapping only where requested. |
| F10 | P2 — mixed selections | F-menu width/height controls are shown when a box-capable object exists, but the applier tests only for a width/height property. In the rect+path probe, the path's stored width changed while its path data did not. Mixed text/shape selections also expose duplicate shortcut keys in the field definitions. | Centralize property applicability and shortcut allocation. Unsupported elements stay unchanged; mixed values and the number of affected objects are explicit. Use the same operations from Inspector and F menu. |
| F11 | P2 — layout/hit testing | The catalog's rename → save → Used in browser flow closes the catalog and stays in Figure. Event instrumentation shows the click landing on the backdrop, not the usage button. Basic navigation succeeds in a larger fixture. At the native 940 px minimum width, the toolbar's final button extends to x≈951. | Fix catalog scroll containment/target stability and test actual hit targets at supported sizes. Preserve preview dimensions while refreshing. Make the toolbar fit at the native minimum without losing access to controls. The precise catalog layout cause still needs tracing. |
| F12 | P2 — responsiveness | At 1,600 elements, nudge-to-paint p95 was 116.8 ms; drag-to-paint was 93.4 ms and failed the existing 22× ratio budget at 23.4×. A 5,000-element edit measured 128.6 ms. Normal/dense Slides playback measured 17.2/17.4 ms p95 against a 17 ms gate. | Profile invalidation/render work and reproduce in an isolated packaged build. Reduce work on unrelated elements and keep transform previews transient. Retain the existing gates and record absolute latency as well as ratios. |
| F13 | P2/P3 — export responsiveness | TIFF encoding and pixel readback run synchronously in the UI path. A simple 190 mm, 600 dpi export produced an 81 ms long task; 300 dpi produced none. Larger figures and 1200 dpi were not stress-tested. | Capture an immutable export job; move costly encoding off the UI thread where measurements justify it. Expose meaningful working/error state and guard impossible allocations without reducing requested output fidelity. |

Source anchors: `src/lib/Canvas.svelte:541`, `:1501`, `:1785`, `:2325`, `:2587`, `:3178`;
`src/lib/store.ts:527`; `src/lib/FluxFigMenu.svelte:277`, `:325`, `:533`, `:702`;
`src/lib/interact/gestureMath.ts`; `src/lib/ops.ts:1279`; `src/lib/scrub.ts`;
`src/lib/project/figureIdentity.ts`; `src/lib/project/schemas.ts:130`;
`src/lib/project/captionReconcile.ts`; `src/lib/project/figbridge.ts:302`, `:377`;
`src/shell/modes/figure/FigureMode.svelte`; `src/shell/modes/slide/SlideMode.svelte:959`;
`src/lib/FigureCatalog.svelte`; `src/lib/Toolbar.svelte`; `src/lib/io.ts:760`.

The selection defect has consequences beyond appearance: the stale rectangle feeds resize
and rotation geometry. It should be fixed before tuning the look of the handles.

**Figure-frame resizing — the requested addition**

Add direct resizing of the figure boundary using the existing frame-selection state. The
affordance should appear when the frame is selected, with screen-sized edge hit areas and
corner handles that remain usable at different zoom levels. Preserve the existing ability
to move a figure from its title; prioritize object manipulation over frame edges when they
overlap, and avoid making every background click enter a special resize mode.

Proposed behavior:

- Right and bottom edges change W/H while existing artwork keeps its physical size.
- Left and top edges change the frame origin and offset its contents/guides oppositely, so
  artwork stays at the same world position while the boundary moves around it.
- Corners change both dimensions. Shift preserves the aspect ratio captured at pointer-down.
  Enforce a positive minimum without flipping the frame or moving the opposite anchor.
- Keep all out-of-bounds elements. Resizing changes the export boundary; it must never delete
  artwork, flatten plots, scale type, rewrite asset bytes, or change reference identities.
- Update the frame and W/H display during the drag, commit once on release, restore completely
  on cancellation, and keep the viewport stable.

Implement the geometry as a pure operation, then add Canvas preview/handles and Inspector
integration. Test nonzero/negative origins, guides, rotated and cropped content, multiple
canvases, undo/redo, save/reopen, SVG/PNG/PDF boundaries and physical dimensions.

Object and property fixes apply to Slides through shared components. Figure-frame resizing
is mode-specific: a slide belongs to a deck-wide stage size. Do not accidentally introduce
independent per-slide frame sizes; any future stage-resize control must use the deck's stage
operation deliberately.

**Simplification and interface polish**

1. Establish one selection/target resolver with explicit inputs for visibility, effective
   locking, group expansion, element capabilities and Slide presentation state. Different
   commands can have different eligibility, but they should not invent it independently.
2. Establish one edit-session contract for numeric/text/property controls: preview, commit,
   cancel, snapshot ownership and no-op detection. Keep transaction ownership in the caller;
   scrubbing a local tool parameter such as Gap or Scale % should not itself dirty the project.
3. Share property descriptors, units, ranges, capability checks and operations between the
   Inspector and F menu. Keep render components and browser focus handling in the GUI; pure
   operations belong in `src/lib` and remain usable by `flux-core`.
4. Extract small, independently understandable gesture/selection/geometry modules from the
   4,000-line Canvas as these fixes land. Preserve its scene renderer and transient transform
   mechanism. A file split alone is not a reason to change behavior.
5. Put the active selection's geometry and relevant appearance controls first in the
   Inspector. With the frame selected, put figure dimensions first. Collapse advanced
   alignment, palette, source and journal-export details while preserving discoverability
   and existing keyboard workflows. Show mixed values and disabled reasons consistently.
6. Polish Layers selection, modifier behavior, focus visibility and keyboard access. Make
   selecting, scrolling to, renaming, locking, hiding and reordering an object predictable.
   Keep its existing virtualization and stable IDs.
7. Expose actual autosave state. The toolbar currently equates dirty with “saving…”, including
   failed/conflicted saves. Undo/redo buttons should reflect available history. Keep all
   essential controls reachable at the native minimum window size and with either rail hidden.
8. Stabilize catalog previews and scrolling, preserve focus on close, and verify modal focus
   containment. Align titles, family badges and reference details across sidebar/catalog/
   deletion flows using the branch's existing identity model.

No additional major feature is recommended for this pass. Frame resizing, trustworthy
selection and consistent direct editing will provide more value than expanding the tool set.

**Implementation sequence on this branch**

| Step | Deliverable | Acceptance before proceeding |
| --- | --- | --- |
| 1 | Preservation fixes: failed-save handoff, legacy identity migration/validation, caption baselines. Add focused failing regressions first. | Current and legacy fixtures retain all figures, references, assets, captions and edits through save/reopen and injected failure. Wrong-tenant writes stay impossible. |
| 2 | Selection/handle update and gesture/history correctness, including mixed locks and cancellation. | Model selection, visible overlay and Inspector agree after the same paint; no previous edit can be consumed by a cancelled/no-op gesture; shared Figure/Slide tests pass. |
| 3 | Shared property editing and resize math; repair mouse/keyboard F-menu behavior. | Equivalent pointer, typing, Tab, hotkey and scrub routes produce equivalent models and one undo step; mixed types and aspect lock remain correct. |
| 4 | Figure-frame edge/corner resizing. | Live preview meets the interaction budget; frame/content coordinate contract, cancellation, undo, persistence and exports pass; Slides retains deck-wide stage behavior. |
| 5 | Inspector/Layers/toolbar/catalog polish and measured rendering/export improvements. | Native minimum-size usability, keyboard focus and dark/light visual checks pass; profile-backed changes meet unchanged performance gates. |
| 6 | Integration and release verification; update Figure documentation and engineering guide. | Full relevant Figure/Slides gates, pure suite, typecheck, build, headless parity, source/watch and Paper integration checks pass. Review final diff for format and project compatibility. |

Use small commits with explicit paths on the current branch. Keep fixes and necessary
regressions reviewable together. Preserve accepted source revisions outside authoring history,
asset ownership across figures/decks, atomic file ordering, and the newer-schema read-only
guard. Do not introduce a bulk project rewrite or an unrequested data conversion.

**Verification baseline**

- `npm run check`: **0 errors, 0 warnings**.
- Full pure tier: **198/198 scripts passed**.
- Selected Figure/shared Slides UI and UI-extra sweep: **69/80 scripts exited successfully**.
  Some older scripts are weak presence/diagnostic checks; a successful exit is not proof that
  every editing route works. The new probes expose gaps in those checks.
- Figure scale: **9/10 checks passed**; drag ratio failed. Structural results were good:
  zero commits during move, one on release; 43 mounted Layers rows at 5,000 elements;
  zero plot-signature calls on an unrelated commit.
- Slides normal and dense scale: both failed only the playback frame threshold in these
  runs. Navigation and static editing were about 31–34 ms p95; animator edits/scrubbing about
  17 ms; no ambient animation-frame loop; one thumbnail invalidation per edit.
- Lazy-asset scale: **14/14 passed**. Cold focus was 305 ms, warm focus 21 ms; parsing was
  time-sliced and residency stayed bounded. Keep this mechanism.
- Targeted selection, undo, cancellation, locking, properties, save failure, legacy reopen,
  caption topology and bounded TIFF-export probes reproduced the findings above.

The scale runs were sequential after the functional sweep; budgets were not overridden,
loosened, or rerun until green. These results are a baseline, not release acceptance.

| Failing UI script | Assessment from the review |
| --- | --- |
| `verify-fig-esc.mjs` | Missing resize handles after a selection-only update; consistent with F03. |
| `figenh-02-rotate.ts` | Rotate handle path fails after selection; later field checks cannot proceed. Correct F03 before assessing downstream assertions. |
| `figenh-05-scale.ts` | Core scale-vs-resize assertions and Inspector scale pass; Canvas handle interactions fail, consistent with F03. |
| `verify-text-styles.mjs` | Style UI assertions pass, final save hits the independently reproduced false caption conflict, F06. |
| `verify-lazy-save-safety.mjs` | Byte-preservation assertions pass; reload rejects the canvas because of legacy reference validation, F02. |
| `verify-figure-catalog-gui.mjs` | Rename/save succeeds; the subsequent usage click hits the backdrop. Track actual visibility/hit testing, F11. |
| `verify-f1-watch.mjs` | Caption-only external edit does not replace Paper's current caption; bibliography/manuscript watch and dirty guards pass. The legacy empty index base makes caption reconciliation report conflict. Align the fixture and visible conflict policy; do not blindly overwrite canonical captions to satisfy the old test. |
| `verify-fig-order-gui.mjs` | Stale `.mini` selector clicks the new All… catalog button instead of Add figure, then dereferences a missing row. Use semantic controls and fail setup clearly. |
| `verify-figure-center.mjs` | Stale row lookup expects a display name where the new identity model presents the nickname/title. Repair the fixture/lookup, then rerun the full centering contract. |
| `verify-fig-namer.mjs` | Family/nickname editing and badge succeed; row assertion still expects the old combined “Movie 1” display. Update the assertion to the intended title/badge contract. |
| `verify-cascade-tracks-gui.mjs` | Start staggering/undo pass. Duration expectation uses 400 ms, while the current compiler default is 320 ms; observed ramp is 420/520/620. Explicitly seed timing or assert against the compiler contract, then exercise the later cancellation/playback legs. |

Passing workflow coverage includes imports and physical size, export primitives, arrows and
dash styles, pen/node modes, line pivots, text wrapping and styles, grouping/layers, alignment/
cascade, guides, modifier gestures, crop, plot dissection and overrides, X-ray, captions,
source refresh, deletion/reference integration, lazy rendering, clipboard images, Slides
editing/import/filmstrip, authored transforms/ghosts, timeline marquee and presentation.

The implementation must add behavioral tests for the missing routes, not just amend the
existing failures. In particular, tests must not hide F03 by mutating the project after
setting selection, and menu tests must type through an actual mouse-focused input.

Integration acceptance should include both editors at multiple zoom levels, multiple frames,
multiple canvases and deck edit destinations; legacy/current save-load-save golden fixtures;
no-edit save stability and one-step undo; external source/caption conflicts; failed writes
and rapid mode switches; headless model/export parity; and real Electron fixture runs for
watchers, dialogs, packaged latency and OS pointer/focus behavior. Run the Paper gate against
port 1420 after any Paper-module changes, and include it for the final caption/reference
integration acceptance. This review did not execute native PDF dialogs or a packaged build,
stress-test 1200 dpi exports, or validate arbitrary private user projects.

Local evidence is under `test-results/figure-polish-review/`: `ui-results.json`, per-script
logs, `interaction-probes.json`, `boundary-probes.json`, `property-probes.json`,
`caption-navigation-probes.json`, `lazy-save-probe.log`, `catalog-events-probe.log`, scale logs
and `export-probes.json`. `selection-mismatch.png` reproduces the reported selection problem.
Throwaway diagnostic sources are in `notes/figure-polish-review/`; both directories are
ignored by Git. This report retains the concrete reproduction outcomes independently of them.
