# Slide transforms — one action, three ways (Change · Ghost · Become)

Status: design + implementation notes for the `slides-transforms` branch (2026-09-15).
Verification evidence is appended at the end of this document as it lands.

## 1. The product shape

A slide object can be **transformed** at a step in exactly three ways. They are one class of
action in the UI (the **Transform** menu in the animator, the **Transform** chip on a lane) and
one family in the deck model (`familyOf(track) === "transform"`):

| Way | What the user does | What the deck stores |
| --- | --- | --- |
| **Change** | Edits the object itself after the step (move, resize, recolor, rewrite, restyle). | The one transform track for that target on that step; `to.state` = the sparse patch vs the pre-state. (Unchanged.) |
| **Ghost** | Creates N copies that start where the source is and each get their own destination. | N ordinary result elements, each born by one transform track carrying `ghostFrom`. (Unchanged.) |
| **Become** | Points at *another* object — one just drawn, one already on the slide, or a plot picked from the gallery — and the source turns into it. | The same one transform track; `to.state` carries the target's properties (including `type` when the kind changes) and, for plots, `to.assetId` (+ source paths). The target object is consumed (deleted) in the same undo step. |

The three are not three track kinds. A Become writes exactly the record a Change would have
written had the user sculpted the same endpoint by hand — it is a different *way of authoring* the
endpoint, not a different animation. Everything downstream (chaining across steps, Before/After
checkout, ghost births, presets, export, video, CLI) therefore works on Become tracks unchanged.

## 2. Data morph is subsumed by Become — the assessment

Question: does the existing "data morph" (a plot's content half: `to.assetId`, the legacy
`preset: "morph"`, `set-morph`, the **Data morph…** button) survive as a fourth way, or is it a
Become?

Evidence from the code as it stood before this branch:

1. `family.ts` already put `morph` in the *transform* family; `ops.setTransform` already adopted a
   legacy morph track "into the transform form (same family, richer patch)"; the player and
   compiler treat `transform` and `morph` identically except for the default duration
   (1200 ms vs 600 ms). The two presets were one thing with two names.
2. Authoring a data morph writes only `to.assetId` + `to.svgPath/manifestPath` on the transform
   track (`acceptMorphTarget` → `setTransform({toAssetId})`). That is precisely what a Become
   whose target is *a plot from the gallery* must write: the source keeps its frame and only its
   content becomes the other plot's.
3. A Become whose target is *another placed plot* ("axes and all") writes the same content half
   plus the geometry/style half the target already carries (`x, y, width, height, rotation,
   crop, contentScale, overrides`) — again the ordinary `to.state` patch.
4. Playback for both is the existing plot branch of the transform driver: a structurally
   compatible pair (`morphCompatible`) tweens data in data space through blended axis fits
   while matching SVG attributes (axes, ticks, labels) bind and interpolate; an incompatible
   pair crossfades the complete plots while the frame still tweens.

Conclusion: **fully subsumed.** There is no residual behavior a "data morph" would have that a
plot-to-plot Become does not, so no fourth way exists. Concretely, this branch:

- removes the `morph` preset from the model (`PresetName`), the compiler, the player, and the
  animator; a deck that still carries `preset: "morph"` is normalized to `transform` at the
  `normalizeDeck` chokepoint (its authored duration is kept — no visual change on load);
- removes `ops.setMorphTrack` and the `set-morph` CLI/MCP verb in favor of the `become` verb
  (`--asset <id>` is the data-only form, `--target <elementId>` the object form);
- replaces the **Data morph…** button and the inspector's "data morph" select with
  **Transform ▸ Become…** (the picker offers *From gallery…* for plots).

## 3. Model semantics

- `to.state` may now carry `type`. `tween.applyState` treats a type change as a **retype**: the
  result keeps the element's identity/base props (`id, name, groupId, locked, hidden, lockAspect,
  x, y, width, height, rotation, flipX, flipY, opacity`) and takes every other property from the
  patch — nothing of the old kind lingers. `diffState` records `type` like any other prop, so
  `applyState(pre, diffState(pre, cur)) ≡ cur` still holds across kinds.
- `to.assetId` is the content target for any element that has an `assetId` slot (plots today);
  `transformPreState` folds it forward so chains (A→B→C) start where they should.
- The pre-state fold, the "one transform per target per step" law, ghost births, and the
  endpoint checkout are unchanged. A Become at a step where the target already has a Change
  replaces that Change's endpoint (the object now "becomes" the picked thing at that step).
- The Become op (`ops.becomeTransform`, twin of `flux become`):
  1. resolves the source's pre-state at the step (ghost-aware, via `compileSlide.preState`);
  2. resolves the target's evaluated state at the end of the step (`sample(bi)`), keeps the
     source's structural identity (`withGhostIdentity`), and for plots carries the target's
     effective asset + source paths (`sourceAt`);
  3. writes `diffState(pre, target)` as the track's whole patch (`replaceState`) plus the content
     half; new tracks get the transform defaults (600 ms, `smooth`);
  4. deletes the target element and every track that referenced it, then GCs groups —
     one deck mutation, one undo entry.
  Refused: a missing/same-as-source target, a video target or source, an unborn ghost target.

### Curves (Animation v2 M1)

`slide/curves.ts` is the pure timing core shared with flux-core. A track may carry
`curve: {kind:"bezier", p:[x1,y1,x2,y2]}`, `{kind:"spring", bounce, velocity?}`, or
`{kind:"steps", n, jump?}`. Resolution is `curve` → active `influence` → `easing` →
`presetCatalog.defaultEasing`; legacy CSS and the 1,001-point token/influence snapshots
match their old values byte for byte. Off that grid the legacy functions overshot 1 by
floating-point roundoff near t = 1; the compatibility wrapper `resolveEasingFn` is the CLAMPED
curve and returns exactly 1 there (a clamp channel never exceeds 1 — the channel law), while
the raw `fn` keeps the old bytes. Catalog names are input sugar: store the spec, never its label.
Springs fit the bar's settle time (energy tolerance 0.005), with exact endpoints and a
reported first 90% arrival. Bounce clamps to [−0.5, 0.8]; bezier handles clamp x to [0, 1]
and y to [−1, 2]; steps clamp to 1–60. Jump-start keeps the authored t=0 endpoint, then
jumps immediately after it (CSS jump-start itself starts at 1/n).

Resolve once at spec construction and retain `ResolvedCurve`: `fn` permits overshoot,
`clamped` bounds it, and `css` represents the clamped curve. New springs/overshooting
beziers use 1,000 sample intervals and vertical-error Douglas–Peucker simplification
at 0.002. The M2 player/compiler integration must pass `fn` only to box and camera
channels, `clamped` to opacity/colour/trim/data/view/morph channels, and **raw progress**
to every discrete visibility/reveal/endpoint decision. M1 adds the type only; schema,
validators and authoring writes belong to M3. The curve UI and user docs belong to M4.

## 4. Rendering: morphing between kinds

`lerpElement(pre, end, t)` for two different kinds (or a path whose closedness changes) returns a
synthetic **path** element for `0 < t < 1` (endpoints stay verbatim clones):

- every drawn kind has an **outline** (`slide/outline.ts`): rect → 4 corners (+ corner radius
  fillets through `pathD`), ellipse → 4 smooth bezier nodes, line → 2 nodes (open), path → its
  nodes. Flips are baked into the outline so the intermediate carries none.
- both outlines are split by arc length to a common station set with boundary-preserving
  de Casteljau splits (`splitOutline` — every original corner survives, so a rect stays a rect
  until it must bend) and put into correspondence in their unit frames: closed↔closed aligns
  winding and picks the seam minimizing summed squared distance; open↔open picks the direction;
  closed↔open has two strategies (`RingStrategy`): when the ring side is **filled** the stroke
  **inflates** — it doubles back on itself as a degenerate ring that swells into the shape (no
  wedge; the stroke's own heads ride along as `fixedHeads` and melt away) — and when the ring
  is stroke-only it **cuts** open where it is nearest both of the stroke's ends and unrolls
  into it (the reverse closes seamlessly).
- the intermediate box is the lerped box; nodes are lerped in unit coordinates and mapped into
  it, so zero-height lines and full shapes interpolate without singularities.
- style: fill/stroke blend in OKLab (`none` is the alpha-0 endpoint), stroke width and dash lerp,
  caps step; arrowheads exist on the intermediate when either end has them and **fade** rather
  than pop (the driver writes head opacity; the pure sampler exposes `arrowFade`).

The runtime driver (`player/transform.ts`) renders such a morph with three layers in the
content host: **A** = the original nodes (kept alive for earlier inner-node animations, shown at
t = 0), **M** = one live `<path>` (+ head polygons) whose attributes are written per frame from
the pure sampler — no serialization or parsing on the frame path, and **B** = the end markup
rendered once through the one serializer (shown at t = 1; later tracks bind to it via
`targetRoot`). Same-kind transforms keep their existing attribute-binding fast path.

### Animation v2: N↔M correspondence core

`slide/correspondence.ts` accepts the shared `StageOutline` type. It merges open chains,
selects spatial/order/data/tile pairing, and retains the unsliced destinations for the reveal.
`owner.members` preserves every merged leaf. Data hints name `axis` (`x` or `y`) and
`destAxisFit`: either `{m,c,log}` or a manifest axis whose anchors already use stage pixels.
Reverse summary→data can supply `sourceAxisFit` for the summary's own placement.

Pair plans retain the exact unit-coordinate arrays from `planOutlines`; `sampleNodes` places
them through each pair's interpolated bbox. `prepare()` warms every lazy pair before sampling;
the sampler refuses an unprepared plan rather than planning during a frame. Pass the previous
`SampledPath[]` back to reuse path/node/handle/dash buffers and prepared color conversions.
Only CSS color strings are rebuilt during repeated sampling. Exact endpoint node chains have
separate reusable buffers, so seeking through either endpoint does not discard the flight buffer.

Above 64 small source rings (both bbox dimensions ≤12 stage px), the plan selects `glyph`
and supplies each matched marker's landing point and stroke-to-marker size ratio. The runtime
integration owns the glyph clones and visibility flip; this core does not mount DOM. Text/raster
pairs instead expose `crossfade` and both bboxes, with no outline plan. A bounded four-batch memo
keeps warmed large correspondences alive beyond the 256-entry individual-pair cache and
invalidates when input geometry, identity, paint or data hints change.

`verify-correspondence.ts` drives these public exports (including flux-core identity parity),
pins full tiled coverage and exact 1↔1 compatibility, and budgets the warmed 1,200-marker
plan including `prepare()` at 15 ms. Negative controls remove the public planner's merge step
and bias the midpoint rule; both must fail their behavioral assertions.

## 5. UI

- Animator bar: **Transform ▾** → *Change* (⌃⇧T), *Ghost…*, *Become…* (⌃⇧E). The old separate
  **Change** / **Ghost transform…** / **Data morph…** buttons fold into it.
- **Become…** enters a pick mode with a bar above the stage: "Select the object it becomes — draw
  one, click one, or pick a plot from the gallery". Selecting exactly one eligible object other
  than the source performs the Become; for plot sources *From gallery…* opens the plot gallery in
  data-target mode. Escape cancels. After a Become the source is checked out **After** the step,
  displayed as what it became.
- Animation inspector, transform lanes: a **Destination** row summarizes the endpoint —
  "Change · Δ x, y, fill", "Became ellipse", or "Data → other-plot.svg" — with *Become…* /
  *Change instead* / *clear* actions.

## 6. Gates

- `verify-slide-outline.ts` (pure): outlines, correspondence, endpoint exactness, retype law.
- `verify-slide-become.ts` (pure): the op, its refusals, plot targets, undo-equivalence, chains,
  ghost interplay, and the `become` CLI verb executed for real.
- `verify-slide-become-browser.ts` (pure tier, Chrome): the three-layer driver in the exported
  player — mid-flight geometry, endpoint parity, no console errors.
- `verify-slide-become-gui.mjs` (ui): the pick flow in the editor.
- Existing gates updated where they encoded the superseded `morph` preset.

## 7. The smoothness pass — measured, not felt

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

Verification of the whole branch: `npm run check` 0/0; pure tier 218/219 (the one failure,
`verify-slide-media-browser.ts`, is the container's H.264-less Chromium and fails on main too);
`group:slide-transforms` + `group:slide-ghosts` 14/14; slide UI gates 14/17 (the three failures —
`verify-paper-slide-embeds`, `verify-slide-embed-lifecycle`, `verify-slide-video-clips-gui` — time
out identically on main in this environment); docs gate 158/158; registry parity PASS.
