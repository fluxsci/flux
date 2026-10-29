# October 27 issue list — maintenance record

For an agent changing any of the behaviour below. It maps each request in the owner's
October 27 issue list to where it lives, the gates that hold it, and the traps that cost time.
The user-facing description is in `docs/modes/{figure,paper,slide}.qmd`,
`docs/concepts/dissections.qmd` and `docs/reference/shortcuts.qmd`; the durable engineering
rules are in the guide body (search it for the file names below).

## History

Codex implemented all 22 requests on branch `OCT-27-FIX-LIST` (tip `cb368bdb`). A Claude review
(2026-10-28/29) verified every item and found several claims wrong; the fixes landed on the same
branch before it merged to `main`:

- **01** the band fix stretched untagged line markers into ellipses (marker vs data was decided
  by part roles); now decided by geometry.
- **04** the Alt+F lag was "not reproduced"; it was real (231–305 ms key-to-paint p95 with the
  pane open) and came from vector thumbnails re-rastered every frame.
- **08** 68 of the 980 seed words were hyphenated phrases Harper can never match.
- **09** a hover-opened spelling menu never closed; choosing a suggestion polluted the dictionary.
- **11** moving the rail width variables barely helped (1,436 → 1,320 ms per drag); the real
  cost was a per-move re-feed of every mounted element.
- **17** the fullscreen gallery and Dissect viewer were barely restyled.
- **22** the dense zoom path only worked after resting at fit zoom; in the owner's real flow
  (zoomed in → edit → zoom out) it proxied 3 of 36 ticks, and its retained mounts made editing
  2–4× slower.

The review also fixed two things outside the list: a later language-profile save from another
window silently dropped dictionary words (now every window re-reads on `correction:profileChanged`),
and Plot Change views left reference lines (axhline/axvline/identity) at their original pixel
(`projectDom.bind()` now projects them along their data axis; `verify-plot-view.ts`).

## Item map

| ID | Behaviour | Code | Gates |
|---|---|---|---|
| 01 | Shaded bands (fill_between, hexbin) follow resized axes; markers, ticks and caps keep their point size | `plot/derive.ts` `displaySpacePath` (origin-centred def = marker; otherwise the use offset is baked into the path) | `verify-plot-resize-fixes.ts`, `group:relayout` |
| 02 | Narrow legends drop columns first (wrapping left to right, fewest rows), shrink uniformly only as a last resort; frames keep their corners; widening restores exactly | `plot/relayout/legend.ts` (`legendGeometry`, shared by solver and writer), `relayout/apply.ts`, figure-legend margins in `constrained.ts` | `verify-plot-resize-fixes.ts`, `group:relayout` |
| 03 | Hiding plot parts tightens outline, hover, hit, marquee, snapping, spacing guides, caliper and Align & Arrange (spine alignment stays data-defined); placement geometry unchanged | `plot/visibleBounds.ts` (cached per source DOM + mount signature; retired on web-font load; `visibleElementBox` is the O(1) provider Align & Arrange inject), Canvas consumers | `verify-plot-visible-bounds.mjs` |
| 04 | Alt+F typing stays instant; margin offers **Insert figure** and **Insert Fig. 1b** side by side with panel chips | `paper/scholar/figures.ts` (`figureThumb`: per-revision PNG at the box size for strip and picker grids), `margin/views/FigureView.svelte` | `verify-figpicker.mjs` |
| 05 | @@ thumbnails share one render per figure revision and stay cached; cold first open is real work (~3.7 s on the owner project), the second ~13 ms | `paper/scholar/figures.ts` | `scripts/perf/paper-figure-picker.mjs` |
| 06 | Adding a dictionary word clears its underlines at once in every editor and window; Chromium spellcheck is off in the editor | `localCorrections.ts`, `markdown-setup.ts`; cross-window push `correction:profileChanged` in `electron/ipc/languageProfiles.cjs` | `verify-paper-spelling-choice.mjs`, `verify-language-profiles.ts`, `verify-p5-paper.mjs` |
| 07 | The sentence-judgement model is gone: no provider, runtime, downloads, settings, IPC, packaging or docs; old preferences are dropped on load (`RETIRED_KEYS`) | — | `verify-local-corrections.ts`, `verify-paper-local-corrections.mjs` |
| 08 | Neuroscience/biology vocabulary seeded into the Personal dictionary in versioned blocks; user removals survive upgrades | `editing/scientificVocabulary.ts`, `localCorrectionProfile.ts` | `verify-language-profiles.ts`, `verify-local-corrections.ts` |
| 09 | Spelling menu: ranked suggestions, a type-the-word field, **+** for the dictionary; hover shows it, a click gives it the keyboard; every correction (menu, typed, or a hand retype to a suggestion) becomes a learned alias | `editing/localSpelling.ts`, `localCorrections.ts`, `app.css` | `verify-paper-spelling-choice.mjs` |
| 10 | Chase is the only caret | `editing/caretFeel.ts`, `settings.ts` | `verify-caret-feel.ts` |
| 11 | Sidebar/inspector/filmstrip drags never re-render the scene | `Canvas.svelte` (`visibleFigures` keeps its array while membership is unchanged; `.scene-svg` is window-sized), width props on `LeftRail`/Inspector | `verify-scale-figure.mjs` (zero `perf.slotChecks` per drag), `verify-colorpicker-narrow.mjs` |
| 12 | Alt+G toggles Plots ↔ Layers (Slides in Slide); hidden rail opens to Plots | `keyboard.ts`, `plotsRail/railState.ts` | `verify-plots-rail*.mjs` |
| 13 | Alt+Shift+C / Ctrl+K copies every selected plot's path, one per line | `figure/commands.ts`, `plot/source.ts` | `verify-oct27-figure-gui.mjs` |
| 14 | No native tooltip over the plot Peek | `plotsRail/Tile.svelte`, Peek | `verify-gallery-notes-gui.mjs` |
| 15 | Several plain `.txt` notes per plot in the rail and Dissect; project-wide notes search; hits open in the rail | `dissect/notes.ts`, `noteDraftCore.ts`, `noteDrafts.ts`, `electron/ipc/dissectNotes.cjs` | `verify-plot-notes.ts`, `verify-gallery-notes-gui.mjs` |
| 16 | Alt+/ (anywhere in Figure/Slide) swaps the lower pane for a searchable folder tree with counts; scope survives Alt+G | `plotsRail/DirectoryPane.svelte`, `GalleryPane.svelte` | `verify-gallery-notes-gui.mjs` |
| 17 | Fullscreen gallery and Dissect viewers are built from the rail's sections, justified rows, tiles, mini-tables and file rows | `PlotImporter.svelte`, `dissect/DissectSections.svelte`, `plotsRail/JustifiedGrid.svelte`, `justify.ts` (`blockGap`) | `group:plots-rail`, `group:plot-gallery`, `verify-dissect-gui.mjs` |
| 18 | Every plot preview sits on a readable page (dark ink → paper) | `plot/previewBackdrop.ts` | `verify-gallery-preview-electron.cjs`, `group:plot-gallery` |
| 19 | R opens X-ray (repeats ignored), Alt+R draws a rectangle | `keyboard.ts`, `Xray.svelte`, Become pick | `verify-xray-*`, `verify-slide-become-gui.mjs` |
| 20 | Ctrl+K → New figure shows a placement ghost at the nearest free spot (24 px beside, 80 px above/below); Alt-drag a title duplicates the figure | `figureLifecycle.nearestFigurePosition`, `figure/commands.ts`, Canvas | `verify-figure-placement.ts`, `verify-oct27-figure-gui.mjs` |
| 21 | Handles work beyond the frame; an outside marquee selects in the frame it overlaps most | `interact/handles.ts` (`excludeZones`), Canvas | `verify-selection-zones-gui.mjs`, `verify-oct27-figure-gui.mjs` |
| 22 | Dense-scene zoom/pan is raster-carried, including right after edits | see below | `group:scene-raster`, `group:dense-zoom-native`, `verify-zoom-proxy.mjs`, `verify-canvas-coverage.mjs` |

## Item 22 — dense zoom

The owner's project mounts about 74k SVG nodes, past the 20k cap of the in-renderer snapshot,
so main never had a zoom proxy for it (project growth, not a code regression). The fix:

- **Capture.** Dense scenes (≤150k nodes) are walked cooperatively and rasterized in a dedicated
  child (`electron/sceneRaster*.mjs|cjs`, `scene:rasterize`). resvg-js 2.6.2 aborts the process
  when a clipped/masked/translucent layer lies far outside the requested region, so the child
  only renders the whole scene (the **overview**) or a sharp region already proven safe;
  otherwise Chromium renders a sharp crop.
- **Parking.** On Electron canvases with ≤1,000 elements, art past the hysteresis rect stays
  mounted as `display:none` instead of unmounting, so captures stay complete while editing
  costs what culling costs. Edits inside a fresh sharp capture are patched into the overview.
- **Clip hoist.** `hoistPlotClips` also groups inert singleton semantic wrappers, with
  `restorePlotClip` at every opacity/translation/effect seam. It looks unmeasured but is
  load-bearing: with it disabled the owner flow proxies 22/37 ticks with 13 long tasks.

Owner flow on a copy of the project (`zoomNavigate`, `PROBE_NAV_PREP=edit`, `--zoomSteps=8`):
Codex 3/36 ticks proxied, frame p95 183–200 ms, ~30 long tasks; final 36/36, 16.7–16.8 ms,
none (also with a 0.8 s rest after the edit, and with a pan). Zooming into another figure shows
the blurred overview until it settles ~0.25 s after the last notch.

Known limits: after a change that cannot be patched in (another figure, an off-screen edit)
the overview takes ~5 s to recapture and zoom runs live meanwhile; canvases above 1,000
elements do not park; about 1 run in 20 still fell back to live zoom (never wrong pixels).
In those runs a sharp capture had landed before the edit and no overview arrived afterwards
(`PROBE_NAV_WARM` shows `before: "2/no-overview"`, nothing seen); 14 targeted repeats (quiet,
synthetic full-core load, edit forced after the sharp capture) did not recur. Next step if it
does: `PROBE_SCENE_RASTER_LOG=1` on the failing run, and check whether a per-content
`overviewFailed` from a timed-out worker is what blocks the retry.

## Re-verifying

```sh
npm run check && npm run check:headless && npm run build
node scripts/run-verifies.mjs --tier pure --jobs 4
FLUX_URL=http://127.0.0.1:<port>/ node scripts/run-verifies.mjs --tier ui,ui-extra --jobs 1
FLUX_URL=http://127.0.0.1:<port>/ node scripts/run-verifies.mjs --group paper-gate --jobs 1
FLUX_XVFB=<Xvfb> node scripts/run-verifies.mjs --tier electron --jobs 1
# owner flow, fresh copy of a dense project per run:
PROBE_NAV_PREP=edit PROBE_NAV_WARM=1 node scripts/perf/input-probe.cjs <copy> \
  --surface=figure --phases=zoomNavigate --zoomSteps=8 --out=<dir>
```

## Traps

- Measure the owner's real rhythm, not a rested start: Codex's 16.8 ms numbers came from runs
  that began at fit zoom with everything mounted, a state the owner never works from.
- GPU raster has no partial raster: a vector `<img>` beside the editor replays its whole figure
  whenever its tile is invalidated, and in Electron every keystroke invalidates every scroller.
  Small previews near typing surfaces are bitmaps.
- Harper checks a hyphenated word part by part: dictionary seeds must be single words.
- A rail width written as a custom property above the scene restyles every SVG node below it.
- Native probes must not click a row the instant its pane exists; wait for layout.
