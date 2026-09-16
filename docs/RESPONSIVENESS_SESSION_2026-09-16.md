> Historical session report, preserved verbatim below from `notes/Flux_Responsiveness_Session_2026-09-16.md`.
> Its implementation and conclusions were subsequently audited and corrected; see [the independent audit](RESPONSIVENESS_AUDIT_2026-09-16.md) for the final findings.

# Flux responsiveness session — 2026-09-16 (Linux workstation)

**Branch:** `perf-instant-canvas` (one commit, `8132d66`, moved off `main` at the owner's request;
`main` stays at `3444ce3`). **Machine:** Threadripper PRO 9985WX, RTX PRO 5000 (NVIDIA 595),
GNOME Wayland with fractional scaling 1.25, Electron 43. **Project used for every measurement:**
`~/fluxsci.github.io/examples/neural-populations` — 2 figures, 21 plots, ~14.8k mounted plot SVG
nodes at zoom-to-fit; a 34-line manuscript with two figure embeds.

This is the narrative the engineering guide's session log compresses: what the owner reported at
each step, what was measured, what was tried, what failed, and why the final shape is what it is.

---

## 0. How everything was measured

Rule 11 of the guide (measure first) decided the method: a **real project in a real Electron,
production bundle**, never a fixture on the dev server, because the earliest lesson of the day was
that the symptoms depended on the real content (15k plot nodes), not on anything a seeded fixture
had. The tools that came out of this, all in `scripts/perf/`:

- `input-probe.cjs` — launches `dist/` in an isolated Electron (own HOME/XDG, a COPY of the
  project), enters Figure / Paper / Slide, drives real input (pointer sweeps, hover flips, click
  bursts, drags, trackpad and notch wheel pans, ctrl-wheel zoom bursts, Paper scroll, typing) and
  reports per phase: renderer long tasks, rAF frame gaps, input→paint, delivered vs sent events,
  CDP style/layout/script/task deltas, per-process CPU, the browser-side `cursor-changed` oracle
  (which cursor image the OS was handed and when), optional Chrome trace, optional presented-frame
  screencast + renderer transform log (`--frames`), optional display sampling (`--grim`, which
  GNOME refuses). CSS "scenarios" inject `!important` overrides to bisect a mechanism without
  rebuilding — an override that leaves computed values unchanged costs nothing, which is what makes
  it a clean knob.
- `trace-summary.mjs` — self time by event name inside long tasks; the first trace of the day named
  the cause in one line.
- `layerize-lab.mjs` — a bare page with a dense SVG under a transformed wrapper, puppeteer trace:
  isolates Chromium layerization behaviour from Flux.
- `layer-swap-lab.cjs` — Electron page capturing EVERY presented frame (CDP screencast) across
  layer promotion, folds while animating, folds after demotion, live zoom.

Probe hygiene learned the hard way: a window on the owner's live desktop gets occluded mid-run (rAF
stops, input drops, `moves: 0`) — measure renderer cost on `--ozone-platform=headless`, use Wayland
runs as smoke tests; hold the Control KEY around synthetic ctrl+wheel (the modifiers field alone
lets the first ~20 events latch as a plain scroll); confirm any presented-frame anomaly against the
renderer's own transform log before chasing it.

---

## 1. "Laggy in Figure; the click ring can't keep up" (owner's first report)

**What the owner saw.** After pulling the redesign from the MacBook Air: lagginess and slowness
scrolling and selecting in Figure on the Linux box; rapid clicks left the new click-ring animation
behind. Fine on the Mac.

**What was measured.** Baseline probe: every hover boundary and every press/release ran one
110–135 ms `Document::recalcStyle` over 14,957 elements, inside the mouse-move hit test. Twelve
rapid clicks painted 2–4 s late; mouse moves were delivered once per 120 ms (23 of 180 sent).

**Bisection.** Scenario `nocursor` (`* { cursor: default !important }`) removed every long task;
scenario `noring` (click ring hidden) changed nothing. So the ring was innocent; the cursor was it.

**Cause.** `cursor` is an inherited CSS property. Commit 75213f1 bound the canvas host's cursor to
hover/press state and replaced `.el { cursor: move }` with `cursor: inherit`, so each flip
recomputed the style of every plot node. "Fine on the Mac" was less mounted content, not the
platform. Blink's independent-inheritance fast path did not help (`independentInheritedStylesPropagated: 0`)
— explicit `inherit` below disables it, and it is still O(n).

**Fix.** The firewall: `.el` carries the hover-dot variant as an explicit constant; the host flips
only for pan / tool / press. The press variant still shows over objects because element presses
capture the pointer on the host and Chromium takes the cursor from the capture target — confirmed
with the `cursor-changed` oracle (hashes: plain / hover / press). Result: 0.24 ms of recalc per
flip on a 30k-node fixture, clicks at ~30 ms paint. Gate: `verify-cursor-gui` firewall leg (fails
4/17 on the old code).

---

## 2. "Very good, but still slow scrolling in Figure and Paper; remove the ring" (second report)

**What the owner said.** Clear improvement; the ring is distracting (remove it, keep hover dot and
press contraction if free); still noticing slowness scrolling vertically/horizontally in Figure and
scrolling in Paper; the project is small so it will only get worse; drill down at every level,
large fixes allowed, no regressions.

**Paper.** Trace: each time a figure embed re-entered CodeMirror's rendered range, its 5k-node
inline SVG was re-parsed (`XMLDocumentParser`), inserted a stylesheet
(`StyleEngine::scheduleInvalidationsForRuleSets`) and restyled — 60–130 ms tasks on a 34-line
manuscript; its paint chunks also made every keystroke's layerization ~6 ms. Fix: figures in Paper
are `<img>`s over cached blob URLs (embeds, hover card, pickers, margin view). A second finding
came from the idle-after-edit phase: every figure edit → autosave → `figRevision` → the paper
re-rendered EVERY embed synchronously inside the IPC reply, 170 ms, with Paper hidden. Fix: widget
constructors compute only the model box; renders go through an idle queue (one figure per slice),
the previous picture shows until the new one lands, and figures whose `<img>` sits in a hidden pane
wait for `flux:pane-shown`. `inlineMarkup` caches prepared plot roots so a render never re-parses
the same plot.

**Figure pan, mechanism 1 — cull churn.** Trackpad pans crossed the 400 px cull step and
mounted/unmounted plots mid-gesture: 45–450 ms tasks, each plot mount inserting a `<style>` (a
document-wide rule-set invalidation) and restyling its 5k nodes. Fixes: the cull key freezes while
an interaction is live and re-culls once at cool-down; mounted content unmounts only one viewport
past the margin (hysteresis, `cullMarginOut()`); the editor's plot cache bakes `<style>` rules into
presentation attributes (`bakePlotStyles`) so a mount inserts no stylesheet. Exports serialize a
pristine parse (`pristinePlotRoot`) so GUI/flux-core byte parity holds.

**Figure pan, mechanism 2 — layerization per frame.** With churn gone, a small pan inside one
figure still spent 6.7 ms of every 16.7 ms frame in `PaintArtifactCompositor::Update`. Every
CSS-injection knob (rulers off, overlay off, clip-path off, scene svg promoted, host overflow
visible) left it unchanged, so the lab was built: a `style.transform` write per frame on a
`will-change` layer re-layerizes the page every frame, cost ∝ paint chunks (4 ms for 12.5k SVG
nodes, 0.01 ms for 12k HTML divs). A paused Web Animation whose keyframes are replaced per change,
or a native scroll offset, layerizes ONCE per gesture. Fix: `interact/compositorDrive.ts` — while
`sceneHot`, `.scene`'s transform rides a paused animation (`setKeyframes` per tick, inline style
mirrored alongside so probes and at-rest gates read the truth); `cool()` cancels it the same frame.
Result: pan 630 → ~100 ms of main thread per 1.6 s burst, 2 layerizations instead of 73.

**Figure, mechanism 3 — paint chunks.** Hover flips and clicks still paid ~10 ms of layerization
each because matplotlib stamps the same `clip-path` on 97 % of elements and every clipped element
is a paint chunk. `hoistPlotClips` wraps each run of same-clip, untransformed siblings in one
clipped `<g>` (exactly equivalent): 4.06 → 0.02 ms per layerization in the lab; hover sweep 510 →
55 ms, twelve clicks 1094 → 258 ms.

**A trap that only the realistic flow showed.** Running Paper first (typing) then Figure, every
pan tick ran `VisibleUnits::canonicalPosition → EditingUtility::nextCandidateAlgorithm`, 8 ms twice
per frame: a caret left in the hidden Paper pane is re-canonicalized through the scene after every
style update (`inert` blurs the element but keeps the range). Fix: ModeContent drops a selection
anchored in a pane it just hid; the canvas drops an out-of-canvas selection at the first tick of a
burst. Gate: `verify-figure-input-hygiene` (2.4 ms per wheel tick on 30k nodes; the old code read
56 ms).

**Things tried and dropped in this step.** Suppressing hover via the host cursor (recalc storm);
relying on Blink's inherited fast path (fragile, still O(n)); `text-rendering: geometricPrecision`
for zoom (halves layout, leaves paint, changes glyphs — not imposed without the owner's eye);
`--disable-features=Vulkan` variants (see §3). The click ring was removed as asked.

---

## 3. "Flicker of the canvas, sometimes the whole UI, on very fast zoom/pan" (third report)

**What the owner said.** Movement now fast and responsive; but going really fast, especially
zooming, shows flickering of the canvas and sometimes the whole UI; a delay in the high-res
render is acceptable (Figma does it); movement must be instantaneous and the app responsive; find
the root cause, add a test, then commit everything.

**What was tried to SEE it.**
1. Compositor frame reporter over traces: 337 frames of zoom bursts, 59 `PRESENTED_PARTIAL`, 24
   `DROPPED`, zero `checkerboarded_*` / `has_missing_content`. Partial/dropped frames are the
   main thread missing frames (the 20 ms/tick live zoom), not visual corruption.
2. `webContents.beginFrameSubscription` — too slow (full bitmaps, ~30 fps, starves itself).
3. CDP `Page.startScreencast` (small JPEGs, ~50 fps) with content fraction / bbox / centroid and a
   reversal detector, plus a renderer-side rAF log of the scene's computed transform. Every
   flagged "reversal" turned out to be the probe's own direction change (and, once, its ctrl+wheel
   arriving as a pan); one frame had impossible geometry (a broken JPEG). Never a blank frame.
4. `layer-swap-lab.cjs`: promotion + animation + first move in one frame, folds while animating,
   folds after demotion, live zoom — no blank or stale frame in any scenario, on Wayland.
5. Real display sampling: `grim` (Mutter has no wlr-screencopy), GNOME's `ScreenshotArea` D-Bus
   (access denied), portal screencast (needs an interactive dialog). Not possible from a script.

**Conclusion on cause.** Nothing inside the renderer presents a wrong frame. Remaining suspects
are display-level and outside Flux: Chromium logs `'--ozone-platform=wayland' is not compatible
with Vulkan` at every start (Vulkan stays `enabled_on` under `--disable-features=Vulkan,…`,
`--use-vulkan=none`, `--disable-vulkan-surface` — all confirmed to reach the process), and the
desktop runs fractional scaling on NVIDIA. The A/B the owner can run: `OZONE=x11 electron .`, and
separately fractional scaling off.

**What was changed anyway, so nothing in the app can produce it.** The live zoom was the last
per-tick main-thread work: Blink relayouts and repaints every SVG `<text>` when an ancestor's scale
changes (~300 texts per tick, ~20 ms, 30 fps, blur→sharp pops at every mid-gesture fold). This is
exactly the class of motion the owner said may be blurry-then-sharp, so the zoom proxy was built
(`interact/zoomProxy.ts` + Canvas):

- After 1.5 s of scene quiet and a real idle slot, the mounted scene is serialized in world units
  over the visible box plus half a host per side (≤ 4096 px / 3 MP), rasterized ONCE to a PNG
  bitmap at device resolution, and kept warm as a promoted `<img>` at opacity 0.01. Keyed by scene
  content only (revisions, mounted-set generation, plot DOM generation, presentation), never by the
  viewport or the baked zoom, so folds keep it and pans keep it while the view stays inside its
  box. Scenes above 20k nodes get no snapshot and zoom live as before.
- The first tick of a burst flips it live: the image rides its own compositor drive with the exact
  viewport mapping; the live scene is frozen (its drive stores the pending transform) and hidden
  (opacity 0). At the settle fold the scene layer is demoted FIRST, then the pending transform, the
  baked `<g>` scale, the scene's return and the proxy's retreat land in one flush — a non-animating
  layer's tiles are required for activation, so the swap is atomic.
- Result: fast zoom 931 → ~150 ms of main thread per 1.6 s burst at 16.7 ms p95 frames, the
  scene's transform unchanged across every frame of the burst; the fold is one 55–90 ms repaint
  after the pointer stops.

**Iterations the proxy went through (each one a measured failure first).**
1. Viewport-keyed snapshot → retaken after every pan and every fold (55 ms idle task each,
   bursts with pauses raced it) → world-space keying.
2. Whole-scene world snapshot → an 8 MP image on the 5,000-element fixture squeezed cc's tile
   budget (+30 ms per production key-to-paint) → region-bounded (view ± half a host, ≤ 3 MP) with
   a coverage check.
3. Proxy transform written per pan tick at rest → re-layerized every frame again (pan 100 →
   330 ms) → writes gated to the live phase.
4. Snapshot on `requestIdleCallback` with a 700 ms timeout → landed between two nudges as a
   40–150 ms outlier (native gate red; lazy-assets gate caught a 255 ms decode on 30k nodes) →
   1.5 s quiet rule, no forced timeout, 20k-node cap.
5. SVG-backed `<img>` as the proxy → Chromium redraws an SVG image as vector content on every
   repaint of its area, composited or not (dev nudge ratio 4.5× vs HEAD's 4.0×) → rasterized to a
   PNG bitmap once.

Also in this step: no hover outline while a burst is live (it flapped per frame under a still
pointer), and the owner's request for a **content-scale row in the F-menu** (`h`, plots only,
reset to 1 clears the field like the Inspector).

**Why the proxy, not something else.** The principle is what Chromium's own pinch-zoom, pdf.js's
zoom layer, CATiledLayer and every image viewer do: scale the last raster during the gesture,
re-render at settle. Alternatives measured or considered: `geometricPrecision` (partial, visual
change), plot text as paths (kills editability), harder culling (scales cost, does not remove it),
a GPU scene (a rewrite that breaks the "markup is the display" premise). Confidence: high on the
principle, high on the implementation with one known gap — the gate checks behaviour, not pixel
parity between the resting proxy and the live scene.

---

## 4. Numbers (production bundle, Wayland, before → after)

| Phase | Before | After |
| --- | --- | --- |
| Trackpad pan inside a figure (1.6 s) | 630 ms main thread, 47 % busy, 73 layerizations | 55–70 ms, 2 layerizations |
| Hover sweep across plots | 510 ms | 55 ms |
| 12 rapid clicks on plots | 1094 ms, 2–4 s paint backlog | ~280 ms, paint p95 30 ms |
| Drag a plot | 445 ms | ~106 ms |
| 3 s idle after an edit | one 170 ms task | one ~50 ms snapshot task at idle (after 1.5 s quiet) |
| Fast ctrl-wheel zoom (1.6 s) | 931 ms, 33 ms frames, folds mid-gesture | ~150 ms, 16.7 ms p95, scene frozen, one fold |
| Paper scroll / typing | 60–130 ms tasks | none |
| Native key-to-paint, 1,600 el | ~50 ms | ~50 ms |
| Native key-to-paint, 5,000 el | 91–122 ms band (HEAD and this tree alike today) | same band |

The 5,000-element native number did not reproduce the September review's 62.7 ms on either HEAD's
canvas or this tree; it is machine drift, documented in the guide (§9) so a single red run is
rerun, not chased.

---

## 5. Gates

New: `verify-figure-input-hygiene.mjs` (drive present while hot / absent at rest, no hidden-pane
selection, no mount/unmount during a burst, TaskDuration per tick), `verify-zoom-proxy.mjs`
(8-panel fixture under the density cap: warm snapshot, live during the burst, scene frozen and
hidden, proxy scale follows zoom, fold lands, edit re-keys, pan keeps), `verify-plot-style-bake.ts`
(bake + hoist, pure). Updated: cursor-gui (firewall leg), crisp (burst sampling accepts the proxy
path), vanilla-inline §2b (zero plot stylesheets in the scene), clip-collision (image embeds),
scale-lazy-assets (tiny cap: resident == mounted), changed-pathmap (routing), the native figure
gate prints its metrics. Pre-existing reds on this box, unchanged: `verify-paper-slide-embeds`
(fails on HEAD) and `verify-slide-stash-electron` without `FLUX_XVFB`.

---

## 6. Open items and recommended next steps

1. **Pixel-parity gate for the proxy** — screenshot the resting proxy at opacity 1 against the live
   scene at k = 1 and diff; turns the fidelity assumption (five inlined classes, embedded webfont)
   into a contract. Small, high value.
2. **Display-level flicker** — needs the owner's A/B (`OZONE=x11`; fractional scaling off); if
   XWayland fixes it, consider defaulting `ozone-platform-hint` to x11 on NVIDIA+Wayland.
3. **Per-plot bitmap level-of-detail** (the "endgame" the owner asked about): plots not being
   edited as owned bitmaps, the hovered/selected one live; ~3–5k lines, 3–5 weeks; reuses the
   snapshot pipeline and swap discipline; worth it only when figures reach dozens of dense plots.
4. **Fold cost** — the one 55–90 ms repaint after a zoom is the accepted trade; if it ever reads as
   a hitch, slicing the `<g>` rescale across plots is the lever.
