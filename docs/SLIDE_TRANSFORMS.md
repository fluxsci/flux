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
parts bind by identity, and unmatched or unsupported matches fade locally (a bar with no counterpart is the
exception: it grows from, or shrinks onto, its own baseline). Only an SVG
without semantic IDs uses a whole-content fade. **From gallery…** authors this content
form; it is still one of Become's destinations, not a fourth transform way.

## 3. Model semantics

Deck `0.6.0` retains the existing track binding (`target`, `part`/`parts`, `selector`) and
adds a shared `TargetRef`: `{element, parts?, selector?, group?, members?}`. `members` (Oct-2)
is an ad-hoc destination SET: one level of element or part-set refs of any objects/plots,
never a group or a set; `normalizeRef` dedupes it, merges one element's parts, collapses a
single member and sets `element = members[0].element`; Become stores members in slide order.
A set is only ever a Become destination (always hand-off; never a source, Consume or Swap).
**Merge** is the reverse: several hand-offs of one step whose destination refs are identical
(`sameRef`) co-land instead of being refused as overlapping. `CompiledSlide.handoffs[].merge`
= `{trackIds, landAt}`; the destination stays hidden until `landAt` (the group's latest end),
each lander plans ONE shared correspondence of all sources (the destination tiles among
them) and keeps its own pairs, earlier landers hold their landed frame, and the last
lander's layer (with the destination's leftovers) lies beneath the others. Partial overlaps and
crossfading mesh landings are still refused. `trackRef` derives it,
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
or draw. New transform timing comes from `defaultTimingFor("transform")` (1200 ms/Smooth,
start 0); replacing an existing transform retains its timing unless supplied. The same
catalog keeps camera commands at 900 ms/Smooth. A transform or camera track that OMITS timing
still plays at the frozen catalog fallback (600 ms/Smooth, and 320 ms/Standard for the camera):
old decks never change; only newly authored tracks carry the pace table (`authoringTiming`).

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
filled/non-series marks remain unchanged and log data must be positive. A view Change hands the axis ticks
off in flight and ends exactly on the editor's re-ticked render (§4, data hand-offs); axes that are not
re-ticked (category, date, fixed labels) keep their guides, which fade in the outer 4%, including exactly
on a new limit. A re-ticked y axis now places each label at its tick plus the plot's own label offset,
about 0.36 em lower than before (labels used to sit on their tick): paper embeds, exports, thumbnails and
PowerPoint posters of existing decks and papers with a y view shift accordingly.

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
motion. The same unclamped eased progress drives compiler and player box paths. Hand-off
flights (set, glyph and box-crossfade flights, with a thick ring's stroke band and fixed
arrowheads riding along) bend by the same law about their CENTRE-to-centre travel
(`correspondence.arcOffset`, on the clamped progress; `planBends`); letter-strip, shatter,
text-morph and 3D flights stay straight. Arc equivalents: `arc = 2·tan(θ/4)` matches the apex
of a circular arc of included angle θ, i.e. manim's `path_arc` (30° 0.26, 45° 0.40, 60° 0.54,
90° 0.83). Authored arcs run 0.2–0.45; manim's Swap is 0.83. **Suggest arcs**
(`suggestArcsForBeat`, CLI `suggest-arcs`) writes an explicit arc, from {0.25, 0.45, 0.83}, onto
the tracks of one step whose flights collide, judged on their real clocks; more than 12 colliding
moves are refused with a reason, and it never touches a track whose resolved arc is set (an
authored 0 is a decision).

**Piece lag (WP 4.3, `Track.pairLag`).** A hand-off Become's PIECES (the plan's non-interior pairs, ranked by destination
centre, x then y: `correspondence.lagRanks`) each run the track's own curve over their own window of the same duration
(`stagger.lagWindow`: `w = max(LAG_MIN_WINDOW 0.3, 1/(1+(n−1)·lag))`, start `(1−w)·rank/(n−1)`, exact 0/1 at the ends); a leaving
interior runs over `[0, 1−w]`, an arriving one over `[w, 1]` (`pairProgress`, one array per frame read by shapes, heads, interiors and
crossfades). Path driver only (glyph flights, text morphs and 3D ignore it); a merge lander's windows run over its own first
`1/holdK`. Lag 0 is byte-identical to unison; a NEW hand-off of 3+ pieces is authored with 0.15 (`BECOME_PAIR_LAG_DEFAULT`, D4);
ops refuse it on anything but a hand-off. Not stamped (Q8).

**Attachments (WP 3.2).** `ElementBase.attach` makes an element's geometry a PURE function of other
elements' boxes (`slide/attach.ts`): a line's ends stick to drivers (an `auto` end leaves its driver's outline
toward the other end's point, or its driver's centre when that end is auto too; a side or `{fx,fy}` point is
placed), and a connector never points backwards (the ends meet, `lineRender` thins an attached connector
below 4x its stroke width to nothing); anything else sits beside one driver by both boxes as SEEN (rotated
boxes' AABBs, `solveBox`). The canvas sticks a released end with `stickEnd`: auto on a shape, the exact spot on
a plot / image / 3D / video or with Ctrl/⌘. The solve runs
in `compile.sample` after every Change, arc and overshoot and before appearance offsets (`resolveAttachments`),
and in the player as ONE controller registered last (`player/attach.ts`): connectors re-serialised in place
on their own tight box (the rest law; their geometry carries `ATTACHED_GEOMETRY_ATTR` so a draw's samplers
read the shaft length and head origins LIVE, and undashed strokes ride `pathLength` 1000), labels composited
over their Design layout box while anything they hang on moves, unless their own Change resizes them (the
rest law then; a per-beat marker controller carries their flight mark). `transform.ts` records the frame's
box for the driver AFTER a text re-layout, and a hugging text's stored-vs-measured difference is blended
from end to end (an unmeasured, agent-made label never jumps on a tween's first frame). Stored geometry is
the Design solve: the editor store re-solves after every edit (`settleAttachments`, which also frees what hung
on a deleted driver; a dependent MOVED by hand, position changed and size not, while its drivers stayed is
detached first, `detachHandMoved`; typing, bold, a font size or a rotation keep it), an attachment set at a
step re-solves the Design state at once, the deck and canvas write points re-solve on copies, `userDiff` keeps a dependent's solved
geometry out of captured Changes. Clone sites remap or drop attachments (`reattachClones`); gaps scale with
content. Schema: a deck with an attachment is 0.7.0, a canvas 0.3.0 (`schemaStamp.ts`).

`params.turn = "rigid"` (CLI `set-transform --turn rigid`; absent = `shrink`) makes a `line`
or a straight 2-node path turn without shrinking (`tween.rigidSegment`: the centre lerps, the
angle takes the shortest turn, the length lerps; a stationary end is a pivot). The player
redraws the shaft and its arrowheads from the turned line (`compileStaticContent` `rigidTurn`).
Off by default: a bond or connector whose end points are shared with neighbouring elements must
keep lerping them straight or it detaches.

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
and pairs spatial (minimum squared travel, `assignMinCost`, nearest-first paint order; a ring layout that
avoids crossing flights, refused whenever it would cross more than the legacy layout; non-finite centres
fall back to `greedyAssign`) / order / data / tile sets. Data ↔ summary uses data-axis fits in stage coordinates;
reverse expansion uses the summary's source fit. The existing `planOutlines` seam/winding/
arc-length planner supplies each pair, and `sampleNodes` is the shared sampling loop.
`prepare()` runs before sampling; warmed buffers and paint conversions are retained.

Convex ring pairs pair by tangent angle (`slide/normalMatch.ts`, each ring in its unit frame;
boxes thinner than `THIN_BOX = 1` stage unit use the pixel frame), so every in-between of two
convex shapes is convex and a square rounds off progressively into a circle. Straight segments
carry implicit 1/3-chord handles, `sampleNodes` needs the two end boxes (`ends`; `pixelLaw` picks
the sampling law), fixed arrowheads ride the support point of the swelling ring
(`fixedHeadPoints` / `pairHeadPoints`), and dashed destinations land on their static pattern
(`dashShift` / `dashOffsetAt`). The M layer's gradient ids are namespaced (`<id>-morph`), and
per-channel alpha and colormap gradients ride t in both drivers (the A, M and B layers each own
their gradient ids: `-morph-tN` / `-tN`). Non-convex pairs (star, L, pen shapes) and rings over 600
nodes keep the arc-length pairing. Stroke corners follow one join law (`src/lib/strokeStyle.ts`):
rect corners are miter, path corners round, and a morph layer draws `morphJoin(pre, end, t)`, the
source's join until t = 0.5 and then the destination's, a kind without corners inheriting the
other side's. The hand-off paths and glyph flights use the same law (`pairJoin`), so no stroked
corner pops at a layer swap.

A Become's STROKE is drawn as the band between two contours (`strokeBand.ts`): the centreline offset
by half the width outwards (the element's own join: a rect's mitre, a path's round, bevelled past the
SVG miter limit) and inwards, normal-matched like the centreline (`outline.planStrokeBand`), so a
mitred outer corner is the source's at t = 0, rounds continuously and is the destination's at t = 1
(the centreline law rounded it by half the width on the first frame). A pair takes the band only when an
end has a corner (a rect, a polygon, a butt- or square-capped line) and its strokes are solid and
undashed; everything else (ellipses, rounded rects, dashes, gradient strokes, non-convex rings, a stroke
thicker than the ring's smallest curvature radius) keeps the stroke law. A stroke that inflates into a
ring starts from the body it is drawn with, which stops inside a filled arrowhead (`trimUnderHeads`).
The stage draws an ellipse as a `<path data-shape="ellipse">` (four arcs from 3 o'clock, butt caps like
the ellipse it replaces), so a round Become's flight and the resting ellipse share one rasteriser;
the figure serializer, the editor canvas and every export still write `<ellipse>`, and the slide
ellipse differs from the old oval primitive by under one device pixel of edge position.

A shape flight hands over to the real renders at its ends (`player/shapeHandover.ts`, the text law of lane
F2 for shapes): the start render, the flight and the end render are ADDED (plus-lighter, isolated host)
with weights from the distance still to travel over the first and last `HANDOVER_EPS` = 0.75 stage px,
every term of change counting (anchors, a turn, a stroke width, a look); a travel shorter than the window
crossfades start into end; the weights snap to a layer that owns the picture. The 1-1 driver hands over for
a stroke-BAND pair; the hand-off driver flies copies of its sources and destinations and hands over where
there is a seam (a band, or an owner cut into pieces). A plain round pair, a merge group, text, rasters,
glyph flights, slices, media and gradient paints keep their own laws. A hand-off draws on a surface at the
DEPTH its destination rests at (`RenderedSlide.flightAt`), so the element that covers the destination
covers the flight and the landing never flips the paint order. When an element painted BETWEEN the source
and the destination overlaps the flight (the two sit on different sides of it), no single depth is right
at both ends: the flight flies on the upper of the two depths and passes under that element by a veil
(handoff `covers`, 2026-10-24): copies of its own rendered wrapper above the flight, masked to the
flight's coverage dilated by 0.75 stage px and faded with the motion's progress, in when the destination
rests under it (the shape sinks), out when the source did (it rises). Both ends are the real paint order
(an opaque cover); it used to flip at the first frame. No flight whose box stays put is promoted to a
compositor layer (a recolour, an outline morph, a rewrite in place: there is nothing a layer could move);
the second half of an outline morph is laid on the END's layout box. A round-capped line carries a round
join into the join law.

A same-kind path Change (and a Consume of two paths) is paired by `tween.alignedPair`, not by the
outline planner: a CLOSED ring keeps its authored index pairing unless another start node or direction
costs under 0.8x of it (`outline.alignChains`; rings of unequal counts are sampled once and every seam
is a rotation of the table; rings above 128 nodes choose their seam on 32 stations), so a reversed-start
or reversed-winding ring no longer collapses through zero area. OPEN chains are never re-paired (a bond
or rung shares end points with its neighbours, and arrowhead/dash direction belongs to the end element),
and a ring with a dash pattern on either end keeps its authored pairing too (dashes start at the first
node: a reversed dashed ring still collapses mid-flight). A compound `d` (outline + holes) pairs its
subpaths largest area first; an unmatched subpath, a hole, an island or a solid same-wound extra,
shrinks to or grows from its own node mean (a hole closes or opens in place); every hole keeps the
winding it was authored with relative to its outline, and the subpaths are written in the end's order.
A compound path Become is planned the same way in the one-element driver (a donut closes its hole as it
becomes a disc), while the hand-off driver flies a compound path by its box. A stroked hole that closes
leaves a stroke-width dot in its last frames (a path has one stroke width), under the visibility floor
up to about 8 px strokes. The aligned pair is memoised by CONTENT (a full coordinate compare confirms
every hit and entries own copies of their nodes), and `warmSlideMorphs` fills it for same-kind path
Changes.

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
retained drawing. Text/raster pairs use box fades; text is measured once from live geometry. A box crossfade (a text/raster
pair of a hand-off, an asset-swap Change) adds its two sides in premultiplied space (`mix-blend-mode:
plus-lighter`) so coverage never dips: each two-sided hand-off pair sits in its own isolated
`g[data-xfade]` (the flight layer is not isolated) and an asset-swap Change isolates its content host;
one-sided fades, glyph flights and shatter pieces keep plain opacity.

**Text rewrites (oct2 W3).** A text → text Change, a text Consume and a hand-off between two
whole upright texts play the **glyph-matched text morph**. `slide/textMatch.ts` (pure) matches
the strings: exact word LCS, case/accent-folded LCS inside gaps, reorders by content, digit
count-ups, and character blocks between close leftover words (similarity ≥ 0.4, ≤ 60 chars,
blocks ≥ 2). It cuts runs at visual lines and style segments and caps the plan (48 spans; more
than 200 characters → line level). It also gives every span its window: glides span the whole
morph; word fades end by 55 % / start at 40 %; letter waves (when the letters fit the cap) sweep
25 % / 30 %. `player/textMorph.ts` renders both endpoints once through the serializer, reads
every glyph position with `getStartPositionOfChar` / `getExtentOfChar`, and flies one
`<svg><text>` clone per span; each clone carries its endpoint's own view-box mapping
(`EndpointFrame`) under that endpoint's residual scale, so it is drawn exactly as the static render
draws that text. The static render (A at the start, B at the end) and the span layer are ADDED
(plus-lighter, inside an isolated content host, set once and never toggled) with weights from the
distance still to travel over the first and last `HANDOVER_EPS = 0.75` stage px of change, so the phase
of a layer's first raster never shows at either end; between them the spans ride compositor layers (a
slow glide stays smooth: painted in place it would move in quarter-device-pixel hops), and a rewrite
whose box travels paints its spans into the wrapper's one layer. A glide whose own look changes in place
(a count's digits, a colour lerp, a weight cross-fade) counts that change in its distance, so the span
layer owns the picture from the first frames. The Change driver hosts it as A / span layer / B, with the
span layer counter-scaled so it is in stage px. Hand-offs fly it on a stage-level `div.sl-flight-text`
placed before `svg.sl-flight`, with their own copies of A and B in that layer for the same hand-over.
Unmappable texts (a legacy whole-line justification stretch) crossfade A and B at their natural size.
The shown precision of a digit tween moves from the start text's to the end text's with the count.

**Glide lanes, roll, letters.** `slide/lanes.ts` (pure, neutral) keeps `crossArc` for every glide and
only moves the glides whose arcs would overprint another word (any glide, static ones included, is an
obstacle): each takes a signed bow (`(-dy, dx)` normal, the same as `arcBox`; negative = left of travel =
the `crossArc` side) chosen to minimise ink overlap, never leaving the stage; more than 16 colliding
glides keep `crossArc`, and each is scored against at most its 12 deepest neighbours
(`LANE_POLICY.maxObstacles`). Offsets are 0 at both ends and planning runs in the idle warm-up. Two
authored params on the text-rewrite `transform` track (`PRESET_PARAMS.transform`): `fadeStyle: "roll"`
(leftover words lift 0.35 em / rise from 0.35 em below with no scale change; when the other side's
leftovers are more than 1.5 em away they lean toward them by min(0.9 em, 30 %); leftover letters glued
to a glide, as in *Microscope* to *Microscopy*, roll in place too) and `letters: "travel"` (when the
leftover letters of both texts are a near-permutation, an anagram, each letter flies to its partner;
`LETTER_BAG_POLICY`: 5-30 letters, 80 % overlap, at least two runs). Absent means `"drift"` / `"fade"`:
old tracks play exactly as made (there is no re-pace command), and `resolveTextLook(params)`
(`timing.ts`) is the one reader. NEW text transforms are written with both, since roll and travel are
the default look (strip `params` for the classic one). Limits: a one-word-per-line vertical reorder is
not solved, and letter anagrams overprint where letters converge.

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

**Ghost copies.** A Ghost copy's ink emerges with its separation from its source (`ghostEmergence`, one
law in `ghost.ts`): 0 while it coincides, 1 once it has left by a tenth of its smaller side (3 to 12
stage px); a copy that never separates fades in over the first quarter of its flight. Two layers of the
same anti-aliased glyphs read bolder (1-(1-c)^2), which is what a copy born on its source used to show.

**Data hand-offs (WP 2.3).** A plot view Change hands the axis ticks off in flight (asset Changes keep
their guide pairing): ticks pair by data value (`matchTickSets`, within 2 % of the smaller step), matched
ticks walk to their new values, ticks only in the start leave over t .10-.45, ticks only in the end
arrive over .45-.80, and a re-formatted label for the same value ("1" to "1.0") hard-swaps once at
t = .5, never a glyph morph. Labels are placed against the tick of their own index. The last frame is the
editor's static re-ticked render. Bars that exist in only one plot version grow from, or shrink onto, their
own baseline (`barGrowWeight`; nothing fades, though a bar carrying its own `transform` attribute still
does). Count-ups hold their digits still on SVG text: each digit sits in a place-value slot, centred and
right-aligned numbers too (the hidden param `steadyDigits: false` restores the plain count).

**A plot Change starts from the plot the step before it left.** A transform is compiled while the live
content still shows the element's BASE asset, so a filled mark (a bar) starts from the START asset's own
pristine polygon (`projectDom.bind`, `opts.sourceRoot`), never from the live node: a chained Change (bars5
-> bars10 -> bars5) begins on exactly the bars the step before it left. Every step re-projects the DOM the
slide MOUNTED (the design state's asset), so its pt-true compensation and natural viewBox are that asset's
(`render.plotAssetOf`), whichever asset the step starts from: a chain between plots of different intrinsic
size (sine 360 x 108 pt -> scatter 180 x 108 pt -> sine) began its second step with every glyph rescaled
(2026-10-24). An asset Change whose start or end
view re-ticks an axis hands the generated ticks off through the same pool as a view Change (each side's
tick set read from its own version, the pool placed against the lerped anchor); a mark only the end version
has stands where it rests under the end view and grows in place.

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
flight and demote at rest (a gliding node keeps its layer through the landing, below); nothing animates
at rest. Per-frame work writes retained-node
attributes, with no SVG serialization, parsing or geometry planning.

**Starts and landings (Release 2).** Nothing pops at either end of an animation, in the editor, in
Present or in an export. A draw is a pen: the stroke width grows with the ink laid down (`penWidth`), so a
round cap never blinks a dot in on frame 1 or leaves one at the end of a drawOff. The clock starts at the
first presented frame: the first tick of a cue advances it by at most 20 ms (`FIRST_TICK_MAX_MS`), so a
frame delayed by setup is a hitch, never a skipped beginning. A hidden enter is primed once, invisibly, at
its rest placement just before it flies, and frame 0 is really presented before anything moves. A camera
flight re-bakes the stage raster for the pose it LANDS on under its last two frames
(`EARLY_BAKE_LEAD_FRAMES`), so the landing finds it sharp. Slide text is grayscale-antialiased end to end
(the stage is a `will-change` layer), so a promotion cannot flip LCD to grayscale.

**Fractionally scaled displays (2026-10-24).** On a display scaled by 1.25 or 1.5 (devicePixelRatio not a
whole number) a whole stage pixel is not a whole device pixel, and these laws keep every frame where its
numbers say and every layer identical to the stage's own paint:

1. *The layout box origin is on the device grid.* Blink snaps a box's paint offset (`left` / `top`) to
   whole pixels of its local space at the device scale. `render.layoutBoxOf` quantises the origin to
   multiples of 1 / devicePixelRatio (Math.round at 1, so nothing changed there) and the residual transform
   carries the exact rest. Before, whole stage pixels were snapped by a different error at a move's start
   box (its flight frames) and its end box (its landing): every move ended with a jump of up to 0.4 stage px
   (0.7 device px in the editor preview), on main and in every release, made visible by the manim smooth
   easing, which almost stops before the end.
2. *Compositing is a constant of the slide.* A node that ever glides (a pure move, a text turn, a
   translate preset, an attached label) carries its flight mark (`armFlightMark`, a paused no-op transform
   animation) from the slide's first frame to its teardown (`player.glidesEver`, armed when the plan
   binds, kept through a with-previous run's re-base). A node on its own layer and the same node painted
   in place differ by a fraction of a device pixel of anti-aliasing, and a mark composites everything
   painted after the node too ("assumed overlap"), so a mark that followed the beat stepped those nodes on
   still frames at the start of a glide and of every later cue that changed the node's picture (a stroked
   rect 20, a text resized after a move 63 stage px^2).
3. *The device grid* (`player/deviceGrid.ts`). A layer and the stage's paint are pixel-identical only on a
   whole device pixel (measured: 0 px differ there, up to 117 levels off it). The stage hosts put the stage
   origin on the grid (`gridFit`: the exported deck, Present, the editor preview; `left: 50%` +
   `translate(-50%, -50%)` landed on a fraction the browser snapped by its own rule, and getBoundingClientRect
   no longer told where the stage was), and a marked node RESTS on a whole device pixel
   (`applyWrapperBox` + `restGridShift`, the grid read once per paint): its glides fly between the snapped
   ends (the transform driver blends the shift with the motion's progress), so the landing frame IS the
   rest and both are crisp. Text that glides to a fractional position, or turns, therefore lands sharp.
   An attached label rests `exact` (its flights follow what it hangs on frame by frame and cannot blend a
   shift); mid-flight frames placed by the rest law are never snapped. A marked node takes its EXACT layout
   size (no residual scale): Chromium freezes the raster scale of a layer it treats as animating, so a
   text that re-laid out on its layer (a resize after a move) rested on a raster a few tenths of a percent
   off scale. A text rewrite whose box stays put promotes its spans INSIDE the wrapper, which turns the
   wrapper into a layer: its driver reports `glide`, so that wrapper is marked for the slide too.
4. *A marked node that resizes is laid out every frame* (2026-10-25). The frozen start box scaled onto the
   frame's box is the right flight for a node painted in place, but on a layer Chromium keeps the raster
   scale while the transform animates: the frames were the start's raster stretched (a rect resized after
   a move stepped 17 at its landing at devicePixelRatio 1, where Release 4 painted it in place). Such a
   flight writes the exact box per frame (`laidOut` in the transform driver) and its content writers take
   that box as their frame (`frameOf`). A fixed text laid out per frame draws its glyphs through its svg's
   viewBox -> viewport mapping, and the browser keeps the viewport in 1/64 of a device pixel: a frame size off
   that grid mapped the glyphs through a scale a hair off 1, another glyph-positioning path than the
   identity at rest (the whole text 0.07 device px aside for the whole flight, 8.3 at both ends of a text box
   resized after a move). Between two rests whose sizes are whole sixteenths of a stage px, every frame's size
   is a whole sixteenth too (exact in binary, on the layout grid at any devicePixelRatio in quarter steps).
5. *A morphing text's static renders keep their layers* (2026-10-25). The browser rasterises the hand-over
   layers (A, the spans, B) into compositor layers whose bounds are the union of what they paint, and a
   layer built mid-flight keeps the sub-pixel offset of its first raster. Two rules: a render that does not
   show is painted at `HANDOVER_FLOOR` (0.0005: nothing in 8 bits, above the 0.0004 below which the
   browser skips it) instead of hidden, so its layer lives from the slide's first frame (hidden, B's layer
   was built the frame it first showed and the text landed 0.66 device px off a fresh render of the same
   beat); and each static render carries a BOUNDS HALO (`appendBoundsHalo`: a rect three font sizes beyond
   its box at alpha 1e-4), so the spans, whose font boxes reach past the text's box, never grow the layer up
   or left (one stage px of growth moved the text's raster grid and shifted the whole word: 65 on the first
   frame of a rewrite that moves).

Measured with `slide-settle-realtime.mts` at `DSF=1.25` (offscreen Electron, `offscreen: { deviceScaleFactor }`;
headless Chrome's emulated device scale snaps differently and is no stand-in) on a window whose size is a
whole number of device pixels (a real Wayland surface is; an odd CSS size at 1.25 is not); gated by
`verify-slide-device-grid.ts` and the settle gate's device-scale pass.

## 5. UI

- **Transform ▾** offers **Change**, **Ghost…** and **Become**. Become arms a source object
  or part set. Click a destination immediately, Ctrl/Cmd-click a plot part, or Shift-click
  to accumulate picks. Enter/**Become** confirms one object, one plot's parts, an X-ray
  group, or — when several things are picked — one destination SET of all of them. The bar names both sides and exposes Pair. Escape or a step/slide change cancels.
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
- `verify-slide-morph-geometry.ts` / `verify-slide-morph-geometry-browser.ts`: convex normal
  matching, rigid heads, dash phase, gradient and alpha paint through both drivers, seek purity;
  the browser gate also pins unique gradient ids per transform.
- `verify-slide-raster-pure.ts` / `verify-slide-raster-electron.cjs`: the raster keeper, the
  exact capture camera, the join law and the BT.709 video colour (offscreen Electron).
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
- `verify-morph-path.ts` (pure): ring alignment, compound subpaths and holes, crossing-free set pairing.
- `verify-slide-xfade-browser.ts` (pure tier, Chrome): plus-lighter crossfades keep full coverage.
- `verify-slide-stroke-band.ts` / `verify-slide-stroke-band-browser.ts`: the stroke band and the ellipse path.
- `verify-slide-shape-handover.ts` (pure): the shape hand-over weights, the flight's depth, the hand-over host.
- `verify-text-lanes.ts` (pure): glide lanes, the stage bound, the obstacle bound.
- `verify-plot-tick-handoff.ts`, `verify-count-up-slots.ts`, `verify-bar-grow.ts`: tick hand-off, count-up
  slots and bar grow/shrink.
- `verify-appear-emphasis.ts` (pure): the fade-free vocabulary (scaleIn, scaleOut, pulse, encircle), lead highlight.
- `verify-slide-settle-sweep.ts` / `verify-slide-settle-electron.cjs`: start and landing of every preset
  and element kind, in the seek domain and in the offscreen-Electron compositor domain (the settle
  corpus includes the stroked hand-offs, round hand-offs, compound holes and the text morph).
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
   animation (`armFlightMark`: on for the whole slide on every node that ever glides, 2026-10-24, see
   "Fractionally scaled displays" in §4) marks the transform as animating and the repainting text glides (Δy sd
   0.135 → 0.010; a hidden enter is primed, rendered once at opacity 0.001 at its rest placement just before it
   flies, and frame 0 is presented first, because a layer bakes the fractional offset of its first raster); and the video capture runtime holds flight
   layers across frames (`holdFlightLayers`), since a fresh layer bakes its first frame's
   offset and an encoder's worth of wall time between frames would otherwise mean a fresh
   layer per frame (`slide-video-frames-probe`: 400 ms between frames, text Δy per frame
   1.017 ± 0.015 stage px — sub-pixel). The player's camera (`.sl-camera`) is itself a permanent compositor layer (2026-10-03): otherwise a promoted flight made Chromium squash every overlapping later sibling onto composited layers, flipping their text anti-aliasing at the first and last frame of every transform. A permanent layer is
   rasterised once and never again when its scale, fractional offset or an ancestor's scale changes,
   so after a resize, fullscreen switch, camera zoom or pan the stage was a resampled bitmap. The
   **raster keeper** (`player/rasterKeeper.ts`, owner of the camera's `will-change` hint) re-bakes it:
   drop the hint for exactly one presented frame, keyed on camera pose, host scale and device pixel
   ratio. Live it bakes `EARLY_BAKE_LEAD_FRAMES` (2) frames before a camera flight lands, for the pose the flight
   lands on (a re-bake is two frame hops, so a progress threshold, a fixed fraction of the travel, cannot
   do it), at the natural end of any other flight and 80 ms after a scrub, resize or refresh,
   and skips slides above 30,000 nodes under the camera; in video capture it settles after every
   frame whose pose changed, and a slide that zooms its camera paints wrapper flights in place and
   samples the camera exactly (`sampleCamera`) instead of by the live player's 24 chords. Measured
   with `slide-raster-probe.mts` and `verify-slide-raster-electron.cjs`, both offscreen Electron.

Frame pacing in the editor preview (`scripts/perf/slide-playback-profile.mjs`): 89 consecutive
16.7 ms frames, zero drops, on the normal fixture before and after; the dense fixture (1,200-mark
data morph + 120 part fades) is bound by native rasterization in this 2-vCPU container on both
main and the branch.

Historical verification at `848dda0`: `npm run check` 0/0; pure tier 218/219 (the one failure,
`verify-slide-media-browser.ts`, is the container's H.264-less Chromium and fails on main too);
`group:slide-transforms` + `group:slide-ghosts` 14/14; slide UI gates 14/17 (the three failures —
`verify-paper-slide-embeds`, `verify-slide-embed-lifecycle`, `verify-slide-video-clips-gui` — time
out identically on main in this environment); docs gate 158/158; registry parity PASS.
