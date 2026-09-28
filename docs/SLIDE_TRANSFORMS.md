# Slide transforms — one action, three ways (Change · Ghost · Become)

Status: design + implementation notes for the `slides-transforms` branch (2026-09-15).
Verification evidence is appended at the end of this document as it lands.

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
3. A **consume** Become whose target is *another placed plot* ("axes and all") writes the same content half
   plus the geometry/style half the target already carries (`x, y, width, height, rotation,
   crop, contentScale, overrides`) — again the ordinary `to.state` patch.
4. Playback for both is the plot branch of the transform driver. `seriesTweenable` checks
   each shared series; `hasTweenableSeries` reports whether any can tween. Matched series
   project through blended axis fits while SVG attributes bind by semantic ID. Unmatched
   parts and vertices fade; anonymous topology changes crossfade only their containing part.
   Only an SVG without semantic IDs uses a whole-plot crossfade. The frame still tweens.

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

Timing lives on the track (and in `AnimStyle.track` / `PresetTrack`). Deck 0.6.0 accepts
an optional `curve` record without another version bump:

```ts
curve?:
  | { kind: "bezier"; p: [number, number, number, number] }
  | { kind: "spring"; bounce: number; velocity?: number }
  | { kind: "steps"; n: number; jump?: "start" | "end" };
```

Bezier x handles are 0–1 and y handles −1–2; bounce is −0.5–0.8; steps are integers
1–60 with end as the default jump. The disk validator refuses malformed or out-of-range
specs; `parseCurve` clamps grammar inputs. Catalog names are authoring sugar: Bouncy writes
`{kind:"spring",bounce:0.35}`, so catalog renaming cannot change saved playback.

`curve`, `influence` and `easing` are **one logical field**. If a track owns any of the
three, it inherits none of the three from its style; other style fields still inherit.
Old records that contain several use curve > influence > easing > preset default.
Field edits clear the other representations. `setTrackCurve(..., null)` deletes all
three, restoring inheritance/defaults. Style detach, animation templates and portable
slide presets copy the resolved curve. CLI/MCP `set-track`, `set-transform` and
`anim-style create|set` parse the same grammar through `parseCurve`.


- `to.state` may now carry `type`. `tween.applyState` treats a type change as a **retype**: the
  result keeps the element's identity/base props (`id, name, groupId, locked, hidden, lockAspect,
  x, y, width, height, rotation, flipX, flipY, opacity`) and takes every other property from the
  patch — nothing of the old kind lingers. `diffState` records `type` like any other prop, so
  `applyState(pre, diffState(pre, cur)) ≡ cur` still holds across kinds.
- `to.assetId` is the content target for any element that has an `assetId` slot (plots today);
  `transformPreState` folds it forward so chains (A→B→C) start where they should.
- The family law allows one transform per complete source ref per step. Part-set hand-offs
  carry no state patch, leaving whole-element pre-state folding unchanged. Their
  presentation hides the source after landing, just like an exit. A later entrance can show it again.
- `ops.becomeTransform(deck, slideId, beatId, sourceRef, dest, opts)` accepts strings as
  whole-element refs and `TargetRef` for parts, selectors or destination groups. Whole loose
  drawn/text destinations with whole sources default to consume; plot/image, group or part-set
  destinations and part-set sources default to hand-off. `mode` can override that choice.
- **Consume** preserves the existing operation: resolve the source pre-state and the
  destination's evaluated step endpoint, keep source identity through `withGhostIdentity`,
  write the retype-aware `diffState` and content half, delete the destination and its tracks,
  then GC groups. `to.become = {ref, mode: "consume"}` is provenance only; playback still reads
  `to.state` / `to.assetId`. Parts/groups and ghost-copy destinations cannot be consumed.
- **Hand-off** writes exactly this endpoint (no asset or source-path half):

  ```ts
  to: {
    become: { ref: { element: "plot", parts: ["axis.x.spine", "axis.y.spine"] },
              mode: "handoff", pair: "auto", reveal: "flip" },
    state: {}
  }
  ```

  New tracks use 600 ms, smooth easing and start 0; existing timing survives unless supplied.
  `pair` accepts auto/spatial/order/data/tile; `reveal` accepts flip/draw. `appearFrom(dest,
  source, opts)` writes the same source-owned record, with hand-off forced. Both ops are one
  deck mutation and one live undo entry.
- Hand-off validation uses `resolveTargetLeaves` over canonical slide identities with the
  step's effective manifests, then verifies actual leaf membership. Missing/unresolvable
  destinations, self refs, video on either side, unavailable ghost destinations and a second
  landing on overlapping destination leaves in the same beat are refused before mutation.
  A whole-element landing overlaps any of its parts; disabled tracks claim nothing. A ghost
  can receive a hand-off from its enabled birth time onward. Source groups have no track
  binding; select one source object or a part set instead.
- `CompiledSlide.handoffs` publishes `{trackId, beat, source, destination, spec}` for valid
  enabled flights, with both sides resolved once for the runtime. `resolveTarget(ref, beat)`
  supplies that same manifest-aware resolution to authoring. Missing/overlapping/unborn
  destinations produce compiler issues; text/raster-only pairs report the informational
  crossfade message when geometry is available (`plotRoot` supplies pristine plot roots).
- Destination presentation keys begin hidden unless an earlier entrance already claimed
  them; a reverse hand-off preserves the first source's initial visibility. Before start the
  source keeps its prior state; at raw progress 0 it still shows, at 0 < progress < 1 both
  sides hide for the flight layer, and at progress >= 1 only the destination shows. Visibility
  persists across steps and reverse seeks are deterministic. Emphasis cannot resurrect a
  hidden side; a later Dim on landed spines yields opacity 0.3. Editor, embeds and PPTX builds
  use these compiled states; PPTX also includes destinations in phase ownership.
- Duplicate slide/beat, preset insertion and embed namespaces remap destination element and
  group ids. Removing a destination or its ghost birth leaves a dangling ref with a compiler
  issue; it never silently deletes the source effect. `clearTransformContent` drops Become
  metadata along with the content half.

### Curves (Animation v2 M1–M2)

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
at 0.002. Player specs and compiled tracks retain this same resolved curve; sampled
frames never reconstruct a function from CSS. Native WAAPI receives `css` only for
specs without a transform. Mixed keyframes choose the curve per property.

| Channel | Progress | Constraint |
| --- | --- | --- |
| Box x/y, width/height, rotation, contentScale; wrapper transform keyframes | `fn(raw)` | Extrapolate the first/last keyframe segment; floor size at 0 and contentScale at .01. Rotation keeps the shortest arc. |
| Camera x/y/zoom | `fn(raw)` | Geometric (log) zoom stays positive; the player's overshoot frames sample `sampleCamera` exactly instead of extrapolating a keyframe segment. |
| Opacity and OKLab colours | `clamped(raw)` | Stay within the authored endpoints and colour gamut. |
| Trim, draw-on, wipe, stroke width and dash | `clamped(raw)` | No negative widths or overshooting dash windows. |
| CountUp and plot data/view | `clamped(raw)` | Data never overshoots. |
| Hand-off correspondence and glyph landings | `clamped(raw)` | Data pairing never extrapolates. |
| Same-element outline morph | `clamped(raw)` | Shape interpolation stays bounded in v1; its outer box can overshoot. |

`seek(u, raw)` carries both eased and raw progress. Every discrete phase decision—A/M/B
visibility, endpoint settlement, hand-off reveal, drawOn cleanup and the glyph's final
15% fade—reads **raw**, so crossing eased 1 never finishes a flight early. CountUp restores
verbatim endpoint formatting only at raw 1. Static seeks pass `(0, 0)` or `(1, 1)`.
`overshootBox` changes only the physical box and retains the sampled object in range;
inner content uses the clamped state, including its SVG viewBox, so it cannot cancel the
outer box's motion. `staggerDelay` supplies playback, compiler and timeline span arithmetic.
Schema, validators and authoring writes belong to M3; the curve UI and user docs to M4.

### Camera paths (Animation v2 M5)

`slide/camera.ts` exports the one `sampleCamera(a, b, u, stage, path, out?)` used by the
compiler and player; `out` reuses a pose without allocations. A pose is a world centre
`c = (x,y)` and positive zoom `z`. The screen transform is `T(p) = z·p + τ`, where
`τ = (W/2,H/2) − c·z`. For the default `pole` path, `k = z1/z0`,
`p* = (τ1 − k·τ0)/(1 − k)`, `z(u) = z0·k^u` and
`τ(u) = p* + k^u·(τ0 − p*)`. The sampler evaluates the equivalent `expm1` form for
numerical stability and recovers `c(u) = ((W/2,H/2) − τ(u))/z(u)`. With
`|ln k| < 1e-4`, centres pan linearly. Endpoint poses are exact; eased `u` outside
0–1 extrapolates geometrically, retaining positive zoom.

`to.path: "fly"` opts into van Wijk–Nuij in `(centre, W/zoom)` space with ρ = √2.
The near-zero-distance branch interpolates log width. `flyDuration` returns the
nonnegative natural length S in seconds at unit speed; the Inspector displays
`round(1000·S)` ms (at least 1 ms) and applies it through `setTrack`. Zoom writes no
`path` field; explicit `"pole"` is also valid. The additive field needs no version bump.

The player emits 24 uniformly spaced transform keyframes and applies the timing curve to
time. It rebuilds all frames from the live camera at play start, then restores compiled
FROM poses on random seek. Transform flight promotion/demotion is unchanged. Both
readers take the unclamped curve (`fn`). Keyframes cover eased progress 0–1 only; when a
spring carries `u` past either end, the player samples `sampleCamera` at that `u`
(`NodeAnim.transformAt`) instead of extrapolating the last keyframe segment, which drifts
9.1 px from the compiler at a spring(0.5) 1→2 zoom and turns zoom NEGATIVE (a mirrored
stage) for a spring(0.8) zoom-out to 0.05. `verify-slide-camera` drives
both the exported compiler and `createPlayer`, including chained/reverse seeks and the
T7 fixture that differed by 23.58 px on the old code.

Release note: the default path changes for every deck, including existing zooming tracks;
mid-flight frames change while endpoints stay identical. No legacy switch is provided.

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
