# Flux Electron / Compositor Notes — crispness + tile/latency diagnosis (Phase 0a)

**Date:** 2026-07-09 · **Branch:** `feat/figure-v1-upgrade` · **Author:** overnight figure-V1 run (Phase 0a)
**Complaints under investigation** (flux_figure_upgrades_fixes/flux_figure_changes_list.md #8/#9):
1. Figure-canvas content is blurry after zooming until you drag something.
2. Electron console spam: `tile memory limits exceeded` (tile_manager.cc) + `Frame latency is negative`.

**Machine caveat (owner-provided, governs interpretation):** this box has NO monitor.
The graphical session is a headless GNOME/Xwayland (`:0`); `dri3 extension not
supported` + no GBM buffer sharing + WebGL unavailable in the Electron renderer —
i.e. the compositor here runs a software/shared-memory raster path, not the
GPU/vsync path a monitor-attached session uses. Findings below therefore
demonstrate the *mechanism*; absolute repro of the user-visible symptom on this
box is not expected to match the owner's on-monitor experience. Final on-monitor
confirmation of the Phase 6 fix is the owner's morning pass.

---

## 1. Measurement protocol (how to rerun)

Tool: `scripts/diagnose-crisp.mjs` (standalone; intentionally NOT in
scripts/verify-manifest.json — run-verifies.mjs only executes manifest entries).
Dev server must already be on :1420.

```sh
# Headless Chrome discrimination matrix at device-scale-factor 1 and 2
node scripts/diagnose-crisp.mjs --dsf 1,2

# Official run (also appends the findings section to
# flux_figure_upgrades_fixes/IMPLEMENTATION_NOTES.md)
node scripts/diagnose-crisp.mjs --dsf 1,2 --notes

# Real-Electron leg: launch Electron with logging + a debug port, then run the
# SAME matrix on its real compositor via --connect, then grep the log.
VITE_DEV_SERVER_URL="http://127.0.0.1:1420/" DISPLAY=:0 \
  XAUTHORITY=/run/user/$(id -u)/.mutter-Xwaylandauth.* \
  npx electron . --enable-logging=stderr --remote-debugging-port=9223 2> /tmp/flux-electron.log &
node scripts/diagnose-crisp.mjs --connect http://127.0.0.1:9223
grep -c tile_manager.cc /tmp/flux-electron.log
grep -ci "frame latency" /tmp/flux-electron.log
```

What one matrix run does (all on a live page, real input paths):

1. **Scene**: seeds a content-heavy figure — one semantic plot (fixtures/plots/growth.*
   via `__flux.io.reimportPlot`), one 575 KB matplotlib SVG rendered on the opaque
   `<image>` path (~/Master_flux_test/plots/overview_traces/eeg.svg as a
   `type:"svg"` element), ~200 mixed rect/ellipse/line/text elements, and a dense
   9 px-text + 0.5 px-hairline "sharpness target". Seeded INTO the existing figure
   (demo `growth`, or `figures[0]` on a real project) resized to 2600×1800 — the
   figure-spanning background/clip rects stretch the permanent composited `.scene`
   layer to content-bounds × zoom (**the repro configuration**; see §4 control).
2. **Zoom**: 7 real `ctrl+wheel` WheelEvents on `.canvas-host` (the exact
   Canvas.svelte onWheel path), zoom-about-cursor pinned on the target → zoom 3.525.
3. **Sharpness metric**: `page.screenshot({clip})` over a 320×320 CSS-px clip on
   the target → PNG loaded back into the page → canvas → mean absolute Laplacian
   (edge energy). Higher = crisper. Identical viewport/content per comparison
   (zoom-out+in bursts are exactly invertible), so ratios are exact.
4. **Conditions**: `S_settled` (600 ms after last tick) → `S_afterDrag` (small real
   mouse drag of an off-clip element + 300 ms; repro iff ratio > 1.15) → from a
   re-blurred state: (a) `.scene` `will-change:auto` (+ restore = causality check),
   (b0) no-op `commit(p=>{})`, (b1) 1 px off-clip element mutation.
5. **CDP LayerTree**: `.scene`-attributed layer bounds/paintCount at zoom 0.5/1/4/16.

## 2. Headless Chrome findings (dev server :1420, Chrome 141, swiftshader raster)

Numbers are deterministic across runs (repeated runs bit-identical).

| condition | DSF 1 | DSF 2 |
|---|---|---|
| elements seeded / rendered (culled) | 220 / 139 | 220 / 139 |
| zoom at measurement | 3.525 | 3.525 |
| S @zoom1 (context) | 26.385 | 18.457 |
| **S_settled** (600 ms post-wheel) | 45.583 | **17.467** |
| **S_afterDrag** (user workaround) | 45.583 (=, no change) | 17.467 (=, no change) |
| (a) will-change → auto | 45.583 (1.000) | **22.522 (×1.289 — crisp)** |
| (a′) will-change restored | 45.583 (1.000) | **17.467 (re-softens, ×0.776)** |
| (b0) no-op commit | 1.000 | 1.000 (bit-identical) |
| (b1) 1 px element mutation (repaint) | 1.000 | 1.000 (bit-identical) |

LayerTree, `.scene` layer bounds (w×h), zoom 0.5 / 1 / 4 / 16:

| | DSF 1 | DSF 2 |
|---|---|---|
| zoom 0.5 | 1303×925 | 2604×1850 |
| zoom 1 | 2604×1805 | 5208×3700 |
| zoom 4 | 10416×7220 (~75 Mpx) | 20832×14800 (~308 Mpx) |
| zoom 16 | 41664×29232 (~1.22 Gpx) | 83328×59200 (~4.93 Gpx) |

paintCount increments on every zoom change — confirms zoom is per-tick **content**
invalidation today (`<g scale(zoom)>` inside the layer), as the architecture note
says; there is no zoom-settle re-raster.

**Reading:**
- **DSF 2 reproduces a soft settled state.** After a real wheel zoom to 3.5×, the
  settled render sits at 78% of achievable sharpness (17.467 vs 22.522).
- **Only demoting `will-change` releases full sharpness; re-promoting re-softens
  to the exact prior value — causality confirmed.** Repaints don't help: a no-op
  commit and a real 1 px content mutation both leave the clip bit-identical, i.e.
  the repaint re-rasters at the same capped raster scale.
- The user's **drag workaround does NOT fix it headless** (afterDrag == settled).
  On the owner's real setup the drag evidently reaches a raster-scale
  re-evaluation that this headless path doesn't — attribute to the display/GPU
  difference, don't chase (owner caveat).
- DSF 1 headless shows no softness anywhere (raster budget never binds).

## 3. Electron leg (real compositor, headless Xwayland `:0`)

Ran for real (not deferred): Electron 43 / Chrome 150 with
`--enable-logging=stderr --remote-debugging-port=9223`, the same matrix driven
via `--connect` (fixture memBridge can't install over the Electron preload —
contextBridge props are read-only — so the tool opens the disposable
`~/Master_flux_test` project via `__flux.shell.openProjectAt`; seeded elements are
id-prefixed `diag-`/`bg-` and cleaned idempotently on re-runs).

| condition | Electron, DPR 1 |
|---|---|
| elements seeded / rendered | 224 / 143 (real project + seed) |
| S @zoom1 / S_settled / S_afterDrag | 48.703 / 59.162 / 59.162 |
| (a) will-change → auto | 56.479 (×0.955 — no softness to release) |
| (b0)/(b1) | 1.000 / 1.000 |
| `.scene` layer at zoom 0.5/1/4/16 | 892×793 / 892×793 / 2604×1805 / **2604×1805 (clamped)** |
| log: `tile_manager.cc` lines | **0** (whole session incl. zoom-16 sweeps) |
| log: `Frame latency` lines | **0** |

- **No tile-memory or frame-latency spam reproduces on this box** — 0 hits across
  boot + the full zoom/pan matrix. The owner's reported spam is therefore tied to
  the monitor-attached GPU path (dri3/GBM + real vsync — both absent here; WebGL
  is unavailable in this session's renderer, `Frame latency is negative` is a
  presentation-feedback message that needs real display timing feedback).
- Notably, cc on this path **clamps the `.scene` layer bounds** (≤ 2604×1805 even
  at zoom 16) instead of growing them like headless Chrome — with clamped bounds
  there is no budget pressure and no softness, consistent with §2's mechanism.

## 4. Surprise control: layer-bounds dependence (strongest single datum)

Seeding the IDENTICAL content into an isolated far-away figure (instead of the
2600×1800-spanning demo figure) keeps the `.scene` layer near viewport size
(≤ 2880×1800 at DSF 2) — and the DSF 2 softness **disappears entirely**
(settled = 22.522 = the crisp value, all toggles 1.000). Same DSF, same zoom,
same measured pixels; the only variable is the composited layer's content
bounds. Softness appears exactly when the permanent will-change layer's bounds
blow past the raster budget.

## 5. Phase 6 decision inputs

Which hypothesis does the data support?

- **(i) will-change demotion sufficient? — YES (demonstrated).** Toggle (a) fully
  restores sharpness in the repro configuration; restoring will-change re-softens.
  This is exactly Phase 6 part B (will-change lifecycle: permanent CSS
  `will-change: transform` removed; promote only while `sceneHot`; idle demotion
  → full-quality re-raster + releases tile allocation).
- **(ii) plain repaint sufficient (staleness)? — NO (refuted).** A real content
  mutation repaints at the same capped raster scale (bit-identical clip); a no-op
  commit likewise. Any fix built on "just trigger a repaint on settle" would NOT
  fix the blur.
- **(iii) budget-limited tiles (a-not-b)? — YES; this is the mechanism.**
  Softness ⇔ giant layer bounds (§4), released only by demotion (§2), and the
  bounds measurements show why Electron-on-a-real-GPU logs
  `tile memory limits exceeded`: the permanent layer's raster area grows as
  content-bounds × zoom² (≈4.9 Gpx-equivalents at zoom 16 / DSF 2).
- Part A of the Phase 6 fix (renderZoom + settle fold) is additionally justified
  by the paintCount data: today every wheel tick is a full content repaint of a
  huge layer; the fold makes it one repaint per gesture.

Gate-design note for `verify-crisp.mjs` (Phase 6): the planned "sharpness ≥0.9×
post-drag reference" must NOT use the drag as the crisp reference headless — the
drag does not re-raster here (§2). Use the will-change-demoted state (or DSF 2
settled-after-fix vs 22.522-class reference) instead, and assert at DSF 2, where
the defect actually reproduces.

Electron errors closure (plan §"Electron errors"): with 0/0 counts on this box,
the before/after comparison for the log spam can only be completed on-monitor.
The env-gated `TILEMEM` hatch remains the only planned default-flag change, to be
adopted only if the owner's post-fix on-monitor counts still show budget-limited
tiles. `Frame latency is negative`: not emitted here; benign-ruling per the plan's
criteria (bare LOG(ERROR) on presentation-feedback skew) stays provisional until
an on-monitor session can trace it.

## 6. Artifacts

- Tool: `scripts/diagnose-crisp.mjs` (this doc §1 = its manual).
- Findings also appended to `flux_figure_upgrades_fixes/IMPLEMENTATION_NOTES.md`
  ("Phase 0a findings", morning-review copy).
- Raw run outputs (session scratchpad, ephemeral): crisp-final.txt,
  crisp-electron.txt, electron-stderr.log.
- Side effect (documented): the Electron leg seeded diagnosis elements into
  `~/Master_flux_test` figures[0] (project is disposable per plan; elements are
  `diag-`/`bg-`-prefixed and are cleaned/re-seeded idempotently by re-runs).
