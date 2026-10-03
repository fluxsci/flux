# Slide transforms — one action, three ways (Change · Ghost · Become)

Status: Animation v2 implementation on `av2/X1`, based on `animation-v2` @ `9822a62` (2026-09-28).
The historical September 15 measurements in §7 are identified separately from this implementation.

## 1. The product shape

A slide object can be **transformed** at a step in exactly three ways. They are one class of
action in the UI (the **Transform** menu in the animator, the **Transform** chip on a lane) and
one family in the deck model (`familyOf(track) === "transform"`):

| Way | What the user does | What the deck stores | Completion |
| --- | --- | --- | --- |
| **Change** | Edits the object after the step (move, resize, recolor, rewrite, restyle). | One transform track for that target and step; `to.state` is the sparse patch against its pre-state. | The same object keeps the edited endpoint. |
| **Ghost** | Creates copies that start where the source is and transform independently. | Ordinary result elements, each born by a transform carrying `ghostFrom`. | Each copy keeps its own endpoint. |
| **Become** | Points at another object, plot parts, a group, or a gallery plot. | The source's transform carries `to.become`; consume also writes the endpoint in `to.state` and the plot/image content half. An asset-only Become uses `to.assetId`. | **Consume** deletes the destination and retypes the source. **Hand-off** keeps both objects, hides the source and reveals the destination. |

All three use the transform family. Hand-off is a completion mode of Become, not another
transform way. The family law keys on the complete `TargetRef`, so one box's hand-off and a
whole-plot Change can coexist in the same step.

## 2. Plot content is a Become

The September 15 transform unification (`70cca1c`) retired the separate `morph` preset,
`set-morph` verb and Data morph button. Migration folds those records into a transform,
retaining their authored timing and the legacy 1200 ms default when duration was absent.
A data-only Become writes `to.assetId` plus source paths and keeps the plot's frame; a
Consume of a placed plot also writes its evaluated geometry and style into `to.state`.

Animation v2 replaces the remaining all-or-nothing plot driver with `plot/project.ts` and
`projectDom.ts`. Supported shared series tween through blended axis fits; semantic SVG
parts bind by identity, and unmatched or unsupported matches fade locally. Only an SVG
without semantic IDs uses a whole-content fade. **From gallery…** authors this content
form; it is still one of Become's destinations, not a fourth transform way.

## 3. Model semantics

Deck `0.6.0` retains the existing track binding (`target`, `part`/`parts`, `selector`) and
adds a shared `TargetRef`: `{element, parts?, selector?, group?}`. `trackRef` derives it,
`targetKey` gives its canonical identity, and `resolveTargetLeaves` expands parts and groups.
The family law allows one transform per complete source ref per step. A whole-plot Change
and a hand-off of one box can coexist; part styling Changes still use the whole plot's
`overrides` patch. Camera, media and appearance effects remain independent families.

- **Change** writes a sparse `to.state` patch folded over earlier whole-element endpoints.
  A `type` change keeps identity/base properties and completes the new kind, dropping old
  kind-specific fields. `to.assetId` and source paths supply a plot/image's content half.
- **Ghost** creates ordinary result elements. Each birth track's `ghostFrom` names its
  source, whose previous-step endpoint supplies the starting state. Unborn copies remain
  absent in Design and with Show hidden enabled; later steps address the copy normally.
- **Become** uses `to.become = {ref, mode, pair?, reveal?}`. **Consume** writes the evaluated
  destination into the source's state/content, removes the destination and its tracks, and
  keeps `to.become` as provenance. Whole loose drawn/text destinations default to Consume.
  Plot/image, group and part-set destinations, or part-set sources, default to **hand-off**.
  A hand-off writes `to.state = {}` and no content half; both model identities survive.

```ts
to: {
  become: { ref: { element: "plot", parts: ["axis.x.spine", "axis.y.spine"] },
            mode: "handoff", pair: "auto", reveal: "flip" },
  state: {}
}
```

`becomeTransform` and destination-side `appearFrom` write the same source-owned record.
Pair choices derive from `PAIR_POLICIES`: auto, spatial, order, data, tile. Reveal is flip
or draw. New transform timing comes from `defaultTimingFor("transform")` (600 ms/Smooth,
start 0); replacing an existing transform retains its timing unless supplied. The same
catalog keeps camera commands at 900 ms/Smooth and omitted camera playback at 320 ms/Standard.

Admission resolves canonical targets against effective step manifests. It refuses missing
parts, self refs, video, unborn ghosts and overlapping destinations in one step; disabled
tracks claim nothing. Source groups have no track binding. Consume requires whole objects
and cannot consume ghost copies. `swapBecome` reverses the refs atomically while preserving
HOW fields and rebinding followers. It also refuses a group source, ghost birth, missing
outline or destination already carrying a transform. GUI and CLI/MCP share these ops.

`CompiledSlide.handoffs` publishes resolved source/destination leaves for the player.
Destination presentation starts hidden unless an earlier entrance claimed it; the first
source of a reverse chain keeps its initial visibility. At raw 0 the source is visible;
at 0 < raw < 1 both sides hide for the flight layer; at raw >= 1 only the destination shows.
A later entrance can reveal the source again; emphasis cannot resurrect it. Design keeps
ordinary appearances editable while preserving future hand-off hiding. Show hidden reveals
these destinations as editor ghosts. Poster, editor, HTML and PPTX readers use compiled states.
Duplication and embeds remap destination element/group ids; deletion leaves diagnosed dangling refs.

### Axis view

A plot's `view` is `{x?: {domain?, scale?}, y?: {domain?, scale?}}`, where each domain is a
pair of data limits and scale is linear or log. It belongs to the shared figure element;
`to.state.view` makes it an ordinary Change, including on ghosts. `plot/project.ts` owns
axis fitting, interpolation and inverse projection; `projectDom.ts` writes series and guides.
Axis view needs series and calibrated axes. Lines, points and existing guides re-project;
filled/non-series marks remain unchanged, log data must be positive, and no new ticks are
invented. Existing guides fade in the outer 4%, including exactly on a new limit.

### Curves, styles and anchors

`curve` is a tagged bezier (`p:[x1,y1,x2,y2]`), spring (`bounce, velocity?`) or steps (`n,
jump?`) record. Bezier x is 0–1 and y −1–2; bounce is −0.5–0.8; steps is an integer 1–60.
`parseCurve` clamps grammar inputs; disk validation refuses invalid records. Catalog names
store concrete specs. Migration from 0.2–0.5 stamps 0.6 and drops unknown easing tokens;
known legacy curves retain their sampled timing.

`curve`, `influence` and `easing` are one inheritance group: any own value blocks all three
from a linked style. Resolution is curve > active influence > easing > catalog default.
Editing one clears the others. `setTrackCurve(..., null)` and GUI both-zero influence reset
the group to inheritance/defaults; the disk's `{in:0,out:0}` sentinel still suppresses inheritance.

`deck.animStyles` holds named HOW definitions and `styleId` links a track. Own fields win;
`INHERITED_STYLE_FIELDS` derives from `ANIM_STYLE_FIELDS` without preset. Preset stays on the
track and propagates by write. Detach and saved presets materialize resolved settings.
**Animate like…** links compatible effects; **Follow timing** stores `anchor:{trackId, edge,
offsetMs?}` in the same beat. End includes stagger; cycles/missing targets diagnose and fall
back to stored start. Cross-step moves detach anchors at their resolved start.

### Stagger, arcs and camera

`stagger` stores Each (`perMs`) or Total (`totalMs`), `curve`, `by`, `from` and optional
uint32 `seed`. Each/Total edits clear the other field; loaded Total wins. Total normalizes
symmetric ranks, breaking all-tied ranks by input order. Random is seeded; missing seeds
hash the track id. `staggerDelay` owns the delay law; one target has no tail. Resolved curves,
ranks and maxRank are prepared before frames.

`arc` is a HOW field in −1…1. `arcBox` changes only box x/y using a quadratic control offset
of `arc × distance / 2`; its halfway apex is `arc × distance / 4`. Zero preserves straight
motion. The same unclamped eased progress drives compiler and player box paths.

Camera `to.path` selects the default pole/log Zoom path (absent or `pole`) or van Wijk–Nuij
`fly`. `sampleCamera` is the shared geometry sampler; `flyDuration` supplies the suggested
seconds converted to ms by the inspector. Player keyframes are rebuilt from live FROM before
play and restored to compiled FROM for random seek. Overshoot samples the geometric path
exactly, keeping zoom positive. Existing decks use the new path: endpoints stay identical,
mid-flight frames change, and no legacy switch exists.

## 4. Rendering: one geometry core, two placements

`targetOutlines` maps drawn elements, plot leaves and groups into stage-pixel `StageOutline`
geometry and paint, applying crop, pt-true factors, overrides, view projection and placement.
Pristine roots/manifests are immutable cache keys. `correspondence.ts` merges connected chains
and pairs spatial/order/data/tile sets. Data ↔ summary uses data-axis fits in stage coordinates;
reverse expansion uses the summary's source fit. The existing `planOutlines` seam/winding/
arc-length planner supplies each pair, and `sampleNodes` is the shared sampling loop.
`prepare()` runs before sampling; warmed buffers and paint conversions are retained.

A same-element retype/outline morph stays inside `player/transform.ts`'s content host:
A is original content, M a retained sampled path/head set, B endpoint markup rendered once
through the shared serializer. Later tracks bind B through `targetRoot`. Same-kind content
uses attribute bindings. Plot content binds semantic ids and fades unmatched/unsupported
residue locally; positional counter ids bind structurally. At rest the endpoint's own SVG
is exact. Part DOM ids are built/decoded only through `partDomId`/`partIdFromDom`.

A cross-object **hand-off** uses `player/handoff.ts`, with one retained drawing group per
controller inside the camera's stage-level `svg.sl-flight` layer. `handoffPlan.ts` prepares
its geometry; source/destination nodes have reversible visibility leases. Whole-plot defaults
pair the merged spines; remaining parts fade in. Crops discard outside outlines and clip the
retained drawing. Text/raster pairs use box fades; text is measured once from live geometry.

**Text rewrites (oct2 W3).** A text → text Change, a text Consume and a hand-off between two
whole upright texts play the **glyph-matched text morph**. `slide/textMatch.ts` (pure) matches
the strings: exact word LCS, case/accent-folded LCS inside gaps, reorders by content, digit
count-ups, and character blocks between close leftover words (similarity ≥ 0.4, ≤ 60 chars,
blocks ≥ 2). It cuts runs at visual lines and style segments and caps the plan (48 spans; more
than 200 characters → line level). It also gives every span its window: glides span the whole
morph; word fades end by 55 % / start at 40 %; letter waves (when the letters fit the cap) sweep
25 % / 30 %. `player/textMorph.ts` renders both endpoints once through the serializer, reads
every glyph position with `getStartPositionOfChar` / `getExtentOfChar`, and flies one
`<svg><text>` clone per span on its own armed, promoted layer (demoted at rest). The Change driver
hosts it as A / span layer / B, with the span layer counter-scaled so it is in stage px. Hand-offs
fly it on a stage-level `div.sl-flight-text` placed before `svg.sl-flight`. Unmappable texts (a
legacy whole-line justification stretch) crossfade A and B at their natural size.

**Text ↔ shape.** `GeometryCtx.glyphs` (the player's `glyphProvider`) turns a text element into
letter outlines. Each letter is a filled ring from its font (`text/glyphFont.ts`, opentype.js),
placed at the browser's measured baseline start. Counters are keyholed into the outline, so each
letter is one ring. A letter with no font outline is a rounded glyph box instead.
`handoffPlan.ts` asks for letters only when the other side is drawn. A filled shape splitting into
letters is cut into vertical strips in reading order (`sliceIntoLetters`), each a closed, filled,
strokeless ring that morphs into its letter. The shape itself is held over the first (or, landing,
the last) 15 % of raw progress to cover the seams. Glyph boxes crossfade with the live text over
the same 15 %. A one-element retype (Consume/Change rect ↔ text) does the same inside
`player/transform.ts`. Fonts come from one registered loader per host: the GUI uses `fonts:lookup`
(Electron main → `text/fontFiles.mjs`); exported/embedded decks read `payload.glyphs`, which
`gatherPayload` bakes for exactly the morphing characters. The compiler reports a missing font
through `CompileOptions.glyphStatus`.

For more than 64 small source rings, the glyph driver moves retained marker clones to
prepared landing stations and fades them in the final 15% of raw progress. It writes SVG
transform attributes, never per-marker CSS transforms. Unsliced destinations and merged
owner members define the reveal set. Reverse/random seeks restore exact endpoint visibility;
disposal releases leases and drawings. Static hosts bake the sampled visibility before disposal.

`ResolvedCurve` is retained once per track/spec; never parse easing or SVG during a frame.
The channel law is:

| Channel | Progress | Constraint |
| --- | --- | --- |
| Box x/y/size/rotation/contentScale and camera | `fn(raw)` | May overshoot; sizes and zoom remain valid. Camera uses its exact geometric path. |
| Opacity, colour, trim, stroke, dash, CountUp, plot data/view | `clamped(raw)` | Remain bounded; data never overshoots. |
| Hand-off correspondence/glyph landing and same-element outlines | `clamped(raw)` | Geometry sampling stays bounded; an outer box may overshoot. |
| Visibility, endpoint settlement, discrete attributes/text and final glyph fade | raw progress | Eased crossings never finish/restart a flight or flip a discrete value repeatedly. |
| Text-morph glide positions and scale | `fn(raw)` | May overshoot like a box (a spring overshoots the words); lanes use the clamped curve. |
| Text-morph fades, colours, twin crossfades and count-up text | `clamped(raw)` | Opacity/colour never overshoot; windows from `textMorphTimeline`. |
| Shape/glyph-box 15 % holds at a letter flight's ends | raw progress | A phase: the live shape or text covers seams or boxes. |

Controllers receive `seek(u, raw)`. Static endpoints pass `(0,0)` or `(1,1)`.
`overshootBox` and `arcBox` change only wrapper geometry; the content frame/viewBox stays
bounded so it cannot cancel the outer motion. Wrapper layout boxes remain whole stage
pixels, with exact placement on composite transforms. Pure translations promote for the
flight and demote at rest; nothing animates at rest. Per-frame work writes retained-node
attributes, with no SVG serialization, parsing or geometry planning.

## 5. UI

- **Transform ▾** offers **Change**, **Ghost…** and **Become**. Become arms a source object
  or part set. Click a destination immediately, Ctrl/Cmd-click a plot part, or Shift-click
  to accumulate picks. Enter/**Become** confirms one object, one plot's parts, or an X-ray
  group. The bar names both sides and exposes Pair. Escape or a step/slide change cancels.
  X-ray **b** confirms picked rows; **a**, **5** starts **Appear from…** from the destination.
- **Appear ▾ → Appear from…** writes the same record by picking the source. **Animate like…**
  picks another effect's linked style. Ordinary X-ray appearance picks fan out per part;
  Change picks select whole objects, with part styling recorded in plot overrides.
- **Destination** shows “hands off to ‹target› · pair: ‹policy›”, “Became an ellipse
  (consumed)”, “Data becomes ‹asset›”, or the object's own After-state description. Pair,
  Reveal flip/draw and **↔ Swap direction** edit a hand-off. **Consume instead**, then
  **Confirm Consume**, removes an eligible whole destination. **Auto-animate the rest…**
  appears for manifested partial plot landings with no appearance effects, and builds after
  landing. **Become** retargets; **Data from gallery…**/**Keep own data** edit the content half.
- **Before/After** choose the endpoint; Δ chips drop captured properties and **clear t₂**
  resets all state changes. **Axis view**, **Style**, **Follow timing**, Easing and stagger
  controls write the shared model. CurveField exposes Steps count, overshoot readout, Paste,
  keep-arrival and bounded keyboard/drag editing. See `docs/modes/slide.qmd` for the user flow.

## 6. Gates

- `verify-slide-outline.ts` (pure): outlines, correspondence, endpoint exactness, retype law.
- `verify-slide-become.ts` (pure): the op, its refusals, plot targets, undo-equivalence, chains,
  ghost interplay, atomic Swap direction and the real `become`, `appear-from`, `swap-become` CLI paths.
- `verify-preset-catalog.ts`: defaults, labels, shared helpers, part-id and naming censuses.
- `verify-target-geometry.ts` / `verify-target-geometry-browser.ts`: pure/core parity and live CTM.
- `verify-correspondence.ts`: merge/pair/tiling and 1↔1 parity, real prepared geometry.
- `verify-slide-handoff-browser.ts`: exported player flight layer, glyph lifecycle and reverse seeks.
- `verify-text-match.ts` (pure): tokenizer, matcher passes, closeness policy, plan caps, timeline.
- `verify-glyph-outlines.ts` (pure): font resolution (fontconfig, scan index, collections,
  bundled faces), parsing, keyholes, em scaling, glyph boxes, area slicing, `fonts:lookup`, bake parity.
- `verify-text-morph-browser.ts` (pure tier, Chrome): the text morph and letter flights in the
  exported player — glides, landings ≤ 0.5 px, reverse seeks, Consume, the box fallback.
- `verify-plot-binding.ts`, `verify-plot-view.ts`: identity matching and projection.
- `verify-slide-curves.ts`, `verify-slide-stagger.ts`, `verify-slide-camera.ts`: timing and motion.
- `verify-slide-animator-gui.mjs`: real camera commands, curve/style/stagger controls and Undo.
- `verify-docs`, `verify-context-scheme`, `verify-registry-parity`, `verify-f1-mcp`,
  `verify-w11-verbs`: docs, generated manual and CLI/MCP surfaces.
- `verify-slide-become-browser.ts` (pure tier, Chrome): the three-layer driver in the exported
  player — mid-flight geometry, endpoint parity, no console errors.
- `verify-slide-become-gui.mjs` (ui): the pick flow in the editor.
- Existing gates updated where they encoded the superseded `morph` preset.

## 7. Historical smoothness evidence (September 15, `848dda0`)

These measurements and gate counts describe `848dda0` and its September 15 environment.
They are not an Animation v2 qualification; the X1 report records current gate results.

The complaint was jitter "especially as the transforming object is settling". Two mechanisms,
both measured on painted pixels (an rAF sampler shows perfect pacing throughout — this was
never jank):

1. **The settle snap.** Endpoints were written as a layout box (`left: 400.37px`), which
   Chromium pixel-snaps when painting, while the frame before it rode an exact composite
   transform: `scripts/perf/slide-settle-probe.mts` read Δcx −0.37 / Δcy +0.39 stage px between
   t = 999 and t = 1000 — about a device pixel at the fit scale, a visible click at the end of
   every move to a fractional position. **Fix:** the layout box is whole stage pixels always
   (`layoutBoxOf`), and the fraction rides a residual composite transform at rest as well as in
   flight — one formula (`compositeTransform`). After: Δ 0.000 across the endpoint for a rect,
   an ellipse and a text run.
2. **Text steps; shapes glide.** `scripts/perf/slide-motion-probe.mts` (1 ms seeks, linear
   easing, centroid per frame): a rect moved 0.300 ± 0.003 stage px/ms; text moved in y by 0 or
   0.445 — one device pixel at a time — because glyphs painted in place snap their baseline to
   the device grid. Only a compositor-moved raster is sub-pixel in both axes. **Fix (layer
   hygiene):** flights that only translate — the transform driver's pure moves, camera pans,
   `move`, fadeRise's lift — promote their node with `will-change: transform` for the flight and
   demote it at either endpoint (or 250 ms after a scrub parks). After: text Δy per ms 0.060
   ± 0.010, uniform, in every mode; a heavy plot moves without repainting. Scaling or rotating
   flights are never promoted (a fixed raster would be resampled — soft while growing, then a
   sharpen pop on settle); they keep painting exactly. Two refinements the probes forced:
   Chromium bakes a layer's fractional offset into its raster whenever it does not consider the
   transform animating, so a promoted element that also repaints per frame (MODE=recolor: a
   colour lerp, likewise a data morph) stepped again — a paused, additive, no-op transform
   animation armed at rest (`armFlightMark`) marks the transform as animating and the
   repainting text glides (Δy sd 0.135 → 0.010); and the video capture runtime holds flight
   layers across frames (`holdFlightLayers`), since a fresh layer bakes its first frame's
   offset and an encoder's worth of wall time between frames would otherwise mean a fresh
   layer per frame (`slide-video-frames-probe`: 400 ms between frames, text Δy per frame
   1.017 ± 0.015 stage px — sub-pixel).

Frame pacing in the editor preview (`scripts/perf/slide-playback-profile.mjs`): 89 consecutive
16.7 ms frames, zero drops, on the normal fixture before and after; the dense fixture (1,200-mark
data morph + 120 part fades) is bound by native rasterization in this 2-vCPU container on both
main and the branch.

Historical verification at `848dda0`: `npm run check` 0/0; pure tier 218/219 (the one failure,
`verify-slide-media-browser.ts`, is the container's H.264-less Chromium and fails on main too);
`group:slide-transforms` + `group:slide-ghosts` 14/14; slide UI gates 14/17 (the three failures —
`verify-paper-slide-embeds`, `verify-slide-embed-lifecycle`, `verify-slide-video-clips-gui` — time
out identically on main in this environment); docs gate 158/158; registry parity PASS.
