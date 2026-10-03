# Flux Slide — build and animate a scientific talk (stock — shipped with Flux, do not edit)

Flux Slide is a **figure-first talk creator and animator** — "PowerPoint meets 3blue1brown."
A slide (deck `0.6.0`) reuses the figure editor and its elements
(`text`, `rect`, `ellipse`, `line`, `path`, `image`, `plot`), adds a slide-only `video` element,
and carries a presentation overlay of beats/transition/notes/camera. Appearance,
transform, and video playback commands are independent. You can
export **one self-contained `.html`** that presents offline on any browser. Agents are
first-class authors: every mutation is a pure op surfaced through flux-core **and the CLI
*and* MCP**, so you can build a whole animated talk from files, app open or closed.

**The file is the API.** A deck is plain JSON at `slides/<deckId>/deck.json`, registered in
`project.json.slides[]`. Edit it through the verbs (which lock + journal) or, for bulk
authoring, through the pure ops — never hand-wave the schema; run `validate-deck` after.
(`0.2`–`0.5` decks auto-migrate on load; `0.1.x` is a sanctioned clean break.)

## The one rule that matters: ops-core-first

Every mutation lives in `src/lib/slide/ops.ts` as a **pure function** `(deck, args) => result`.
The GUI, flux-core, and the CLI all call the same ops. When scripting a deck in Node, import the
ops directly; when driving from the shell, use the CLI verbs (thin wrappers over flux-core).

## CLI + MCP verbs (the agent entry point)

Every verb below is BOTH a CLI verb (`flux <verb>`) and an MCP tool (name in parens) — one
core, two surfaces (see `CLI-REFERENCE.md` for the invocation + root-resolution rules).
They lock + journal, so they coexist with a live human editor.

```
# deck structure
flux decks                                     # (list_decks)   list the project's decks
flux new-deck [--title T] [--theme T]          # (create_deck)  scaffold + register a deck
flux add-slide <deck> [--name N] [--layout L]  # (add_slide)    layout: title|section|content-figure|two-column|full-bleed|blank
flux delete-slide <deck> <slideId>             # (delete_slide)
flux duplicate-slide <deck> <slideId>          # (duplicate_slide)  deep copy, fresh ids
flux reorder-slides <deck> --order id1,id2,…   # (reorder_slides)   exact permutation
flux set-slide <deck> <slideId> [--name|--layout|--background|--transition|--notes|--notes-file|--camera-x/-y/-zoom]
                                               # (set_slide)    notes = speaker notes; camera = base pose
flux set-theme <deck> <theme>                  # (set_deck_theme)  flux-dark|flux-light|flux-paper|flux-midnight|flux-slate|flux-sepia|flux-contrast

# content (returns the new element id on stdout)
flux add-text <deck> <slideId> "text…" [--x --y --width --height --align --color --size-pt --weight --sizing]   # (add_slide_text)
flux add-figure <deck> <slideId> <figureId> [--x --y]   # (add_slide_figure)  COPY a project figure's content (fresh ids, native size)

# video clips (MP4/MOV sources; source files remain unchanged)
flux add-video <deck> <slideId> plots/_videos/clip.mov [--x N --y N --width N --height N --muted --loop]
flux set-video-track <deck> <slideId> <beatId> <elId> start [--start ms]   # start|pause|stop; a playback step after Design
flux set-video-settings <deck> <slideId> <elId> [--muted true|false --loop true|false]

# animation — (dis)appearances
flux add-beat <deck> <slideId> [--label L]     # (add_beat)     append a build/advance step
flux set-animation <deck> <slideId> <beatId> --target <elId|@camera|@stage> [--preset P] [--part id]
     [--start ms] [--duration ms] [--easing e] [--to-asset id] [--to-x --to-y --to-zoom] [--track '<json>']
                                               # (set_animation)  --track passes a full Track JSON; else built from flags
flux animate-element <deck> <slideId> <elId> [--exit] [--preset P] [--beat-index n]   # (animate_element)  smart per-kind default
flux animate-part <deck> <slideId> <elId> <part> [--beat-index n]                     # (animate_part)     plot-part default reveal

flux set-plot-view <figureId|deckId/slideId> <elId> [--x-min N --x-max N --y-min N --y-max N]
     [--x-scale linear|log --y-scale linear|log --y2-min N --y2-max N --y2-scale linear|log --reset] [--beat beatId]  # (set_plot_view) data view (a twin axis by --y2-*/--x2-*), or a Change at a deck beat
flux set-plot-color-scale <figureId|deckId/slideId> <elId> [--scale id --cmap crameri.batlow --reversed --norm log
     --vmin N --vmax N --center N --gamma N --extend both --reset] [--beat beatId] [--regenerate]  # (set_plot_color_scale) live colour scale, or a Change
flux get-plot-color-scales <figureId|deckId/slideId> <elId> [--beat beatId]                  # (get_plot_color_scales) scales, editability, live view

# animation — transforms (the signature family: ONE track kind, three ways of authoring it)
flux set-transform <deck> <slideId> <beatId> <elId> --state '<json patch>' [--replace-state] [--curve 'spring(0.35)']
     [--start ms] [--duration ms] [--easing e] [--arc -1..1] [--to-asset id]                        # (set_transform)  CHANGE: edit the object's own endpoint
flux ghost-transform <deck> <slideId> <beatId> <sourceId> --count 3
     --original stay --states '[{"x":200,"y":60},{"x":300,"y":160},{"x":400,"y":260}]'
     [--original-state '<json patch>' --duration ms --start ms --easing e]         # (ghost_transform)  GHOST: copies that transform independently
flux become <deck> <slideId> <beatId> <sourceId> --target <elId>                     # (become) BECOME
     [--part id,id --source-part id,id --mode consume|handoff]
     [--pair auto|spatial|order|data|tile --reveal flip|draw --start ms --duration ms --easing e]
flux appear-from <deck> <slideId> <beatId> --dest <elId> --from <sourceId>             # (appear_from) same hand-off from the destination side
     [--part id,id --source-part id,id --pair auto|spatial|order|data|tile --reveal flip|draw]
     [--start ms --duration ms --easing e]
flux swap-become <deck> <slideId> <trackId>                                        # (swap_become) reverse a hand-off, keeping timing/style/followers
flux become <deck> <slideId> <beatId> <plotElId> --asset <assetId> [--force]          # data-only: keep the frame, replace the plot content
     [--start ms --duration ms --easing e]                                         # shared series tween; with none, force authors it (series fade)

# linked deck styles + relative timing
flux anim-style create <deck> --name L --family appearance|transform|media --preset P
     [--duration ms --start ms --curve grammar --arc -1..1 --params json --influence json --stagger '{"perMs":30}'] # (anim_style)
flux anim-style set <deck> <styleId> [--name L --preset P --duration ms --start ms --curve grammar --arc -1..1 --params json --influence json --stagger json]
flux anim-style delete <deck> <styleId>                         # detach linked effects, preserving their settings
flux anim-style list <deck>
flux animate-like <deck> <slideId> --from t1 --to t2,t3 [--beat beatId] # (animate_like) share the source style; family mismatches reported
flux set-track <deck> <slideId> <trackId> [--style id | --no-style]
     [--anchor t1:start|end[:offsetMs] | --no-anchor] [--start ms --duration ms --curve grammar] # (set_track)
     [--stagger-each ms | --stagger-total ms] [--stagger-curve token|spring|bezier|steps]
     [--stagger-from start|end|center|edges|random] [--stagger-by index|x|y|value|count|data-index] [--seed uint32]

# lane organization + reuse
flux group-tracks <deck> <slideId> <beatId> t1,t2… [--label L]    # (group_tracks)    collapsible animator lane group
flux ungroup-tracks <deck> <slideId> <beatId> t1,t2…              # (ungroup_tracks)
flux cascade-tracks <deck> <slideId> <property> t1,t2… [--delta n | --factor n]
     [--order timeline|list] [--reverse] [--first-fixed]          # (cascade_tracks)  stepped timing delta
                                               # across tracks: rank k gets value+delta·step (step = k with
                                               # --first-fixed, else k+1); property ∈ start|duration|
                                               # influence.in|influence.out|curve.bounce|stagger.perMs|stagger.totalMs|arc; a start cascade
                                               # with --first-fixed IS the classic stagger
flux apply-anim-template <deck> <slideId> <name|path.json> [--element id [--part axis.y] | --elements a,b,c] [--beat id]
                                               # (apply_anim_template)  bind a saved preset bundle by role/type

# verify + ship
flux validate-deck [deck]                      # (validate_deck)  check against the bundled schema
flux export-deck <deck> [--out F]              # (export_deck)   → self-contained exports/<deck>.html (offline)
```

`add-figure` is the primary way to put composed figures into a deck: it copies a project
figure's elements (same 96 px/inch ruler → native size) and keeps plot **panels addressable**,
so you can stagger their parts or make them become another plot. `export-deck` gathers everything off disk and
emits ONE file with the player + fonts inlined. No network, no install to present.

## The two principal object-animation families

Media commands and camera moves have their own independent families.

**1. (dis)Appearances** — an object arrives or leaves elegantly. Enters: `fade`, `fadeRise`,
`popIn`, `growBaseline`, `drawOn`, `writeOn`, `stagger` (fan a child preset across a part set).
Exits: `fadeOut`, `popOut`, `drawOff`, `wipeOut`. Emphasis: `highlight`, `dim`, `countUp`.
The default set-animation upserts by family; pass `--append` (MCP `append:true`)
to place multiple appearance effects on the same object in one step.

- **Trim Paths** (`drawOn`/`drawOff` `params`) — the featured stroke draw:
  `anchor` (0..1, or `corner-tl|top|corner-tr|right|corner-br|bottom|corner-bl|left|start|middle|end`),
  `direction` (`forward|reverse`), `mode` (`single|both-ends|middle-out`), `from`/`to`
  (partial window, 0..1). A rect can draw from its top-right corner, meet in the middle from
  both ends, or draw only its top half. Only STROKE-rendered shapes self-draw (a filled shape
  fades — dash windows hide strokes alone). Defaults reproduce the classic full draw.
- `writeOn`/`wipeOut` take `params.direction: ltr|rtl|ttb|btt`.
- Timing knobs on every track: `start`, `duration`, `curve`, `easing`
  (`smooth|standard|enter|exit|linear`), `influence` ({in, out} 0–100, the AE velocity
  profile), `stagger` ({perMs? or totalMs?, curve?, by: index|x|y, from: start|end|center|edges|random, seed?}).
  Each/Total authoring clears the other field. Total spans first-to-last starts; one target has
  no tail. The distribution uses the clamped curve grammar (`enter`, `bouncy`,
  `cubic-bezier(.2,.1,.8,1)`, `steps(8)`). Random replays from a uint32 seed or the track-id hash.
  Total normalizes symmetric ranks; if all ranks tie it uses input order.
- Transforms also carry `arc` (−1…1); zero is straight, either sign bends box x/y along a
  quadratic Bézier. The control point is offset by half the move distance times arc;
  at halfway the path offset is one quarter of the distance times arc. Styles/presets
  retain it. HTML/video play these paths; PPTX does not reproduce curves/distributions.

**2. Transforms** — ONE track kind (`preset: "transform"`, at most one per complete source `TargetRef` per
beat — chain across beats) authored three ways:

- **Change** (`set-transform`): the object becomes a different version of itself — position,
  size, shape geometry, colors (blended in OKLab), opacity, dash, text (a pure numeric change
  digit-tweens; a rewrite plays the TEXT MORPH — shared words glide to their new places,
  the rest fades by reading order — moving all the while), plot part styles. Stores a
  **sparse patch** (`to.state`) against the track's pre-state; **chaining composes**: t1 of a
  later transform = the earlier one's end. Never hand-compose states; pass the patch and let
  the engine fold. `--to-asset` sets the plot content half (see Become).
- **Ghost** (`ghost-transform`): copies that start where the source is and transform
  independently (below).
- **Become** (`become`): the source turns into another object or plot parts. A whole loose
  drawn/text destination defaults to **Consume**: its evaluated endpoint replaces the source
  (`to.state`, retype-aware) and the destination is deleted. Plot/image destinations, group
  refs and part-set sources/destinations default to **hand-off**: both identities stay, the
  source hides after landing and the destination reveals. `--mode consume` keeps the old
  whole-plot consume route; consume refuses part sets. `--part` selects destination parts,
  `--source-part` selects source parts. `--pair` chooses correspondence, `--reveal` flip/draw.
  A destination cannot receive overlapping hand-offs in one step. Neither side may be video;
  ghost destinations must already be born. New tracks use 600 ms / smooth / start 0; replacing
  an existing transform keeps timing unless supplied. **Appear from…** (`appear-from`) writes
  exactly the same source-owned hand-off record from the destination side.
  `--asset <assetId>` is the separate whole-plot content form (`to.assetId` + source paths):
  the frame stays, shared line/point series tween in data space, and incompatible plots require
  `--force` when none can tween; parts still bind by semantic ID, with local residual fades.
  It accepts no hand-off/part flags. All routes write a transform track.

```
flux set-transform talk s1 b2 el_rect --state '{"x": 420, "width": 220, "stroke": "#d14d41"}' --duration 700
flux set-transform talk s1 b3 el_rect --state '{"opacity": 0.3}'        # chains: t1 = b2's end
flux become talk s1 b2 el_line --target el_ellipse                        # the line becomes the ellipse (consumed)
flux become talk s1 b2 el_path --target el_plot --part axis.x.spine,axis.y.spine    # source hands off to live spines
flux appear-from talk s1 b2 --dest el_plot --part axis.x.spine,axis.y.spine --from el_path # same record
flux become talk s1 b2 el_plot --asset growthB                            # the plot's data becomes growthB's
```

**Camera** is its own small family: `--target @camera --preset camera --to-x --to-y --to-zoom`.

**Axis view** is an ordinary plot prop in Figure, Slide, Paper and export. `set-plot-view`
patches limits/scales; omitted fields inherit. A figure target writes the object; a
`deck/slide` target with `--beat` writes `state.view` on that step's Change and preserves
other state. Without `--beat`, it edits Design. `--reset` clears the view (at a step this
writes `view:null`). The Inspector and F-menu expose the same controls. Log limits and data
must be positive. Lines, points, bars, heatmap cells, hexagons, contour bands and box / violin
bodies project (fluxplot 0.3.2 records their data geometry); reference lines and rasters stay
put. During a glide the existing ticks move and fade in the outer 4%; at rest the viewed axis is
re-ticked for its new limits (categories / dates / fixed labels keep theirs). A twin value axis
(`axes[].y2` / `.x2`) takes `--y2-min --y2-max --y2-scale` (`--x2-…`) and moves only the series
drawn on it. Two versions of a keyed plot (bars by category, cells and hexagons by row.col —
`capabilities.valueMorph`) Become each other member by member: heights tween, colour values pass
through the colour law. `--stagger-by value|count|data-index` orders a ramp by each part's data
(`data-value` / `data-count` / `data-index`; `x` / `y` by position, `index` by target order).

**Colour scale** is the same kind of prop for colour-mapped plots (hexbin, heatmap, scatter
`c=`, contour bands, colour-mapped bars/lines) saved by fluxplot ≥ 0.3.1: `set-plot-color-scale`
patches the colormap, its direction, the norm kind (within what the scale allows), the limits
and norm parameters, and `extend`; omitted fields inherit, `--reset` clears the scale. A figure
target writes the object; a `deck/slide` target with `--beat` writes `state.colorScale` on that
step's Change, so colours tween through data values (limits interpolate, log limits in log
space, a changed colormap blends its tables); without `--beat` it edits Design. Every element
carrying a `data-value` recolours together with the colorbar's gradient and ticks, in place, with
no regeneration; raster scales (images, filled contours) report themselves and only regenerate.
`--regenerate` on a figure target writes the complete v2 `__fluxplot__` control into the recipe
and re-runs it, then clears the live override. `get-plot-color-scales` lists what a plot has.

**Ghost transforms** create ordinary independent result Elements with a birth Change track
(`ghostFrom` names the source; `target` names the result; `to.state` is its destination patch).
Use `ghost-transform` / `ghost_transform` / `ops.addGhostTransform`, which creates fresh identities
and returns `{elementIds, trackIds, groupId, originalTrackId?}`. Each source pose comes from the
end of the preceding step, so same-step motion of the original is independent. Copies do not
exist before birth, including when that track is disabled; they remain normal animation targets
afterward. The GUI edits destinations through **Edit after step**, with an explicit copy picker.
Deleting a birth deletes its result and result-targeting effects; normal duplicate/paste of an
element creates an independent static snapshot. Slide/step/track duplication uses the shared
ops to remap birth ownership, and both forward and reverse seeking use the same compiled state.

## Authoring a deck in Node (bulk / precise work)

For anything beyond a slide or two, script it with the pure ops + `flux-core/slides.ts`
(run the script from the Flux repo checkout — the imports below are repo-relative):

```ts
import * as core from "./flux-core/slides";
import * as ops from "./src/lib/slide/ops";

const deck = ops.createDeck({ id: "defense", title: "Mycelial Growth" });   // seeds 1 slide
const title = deck.slides[0].id;
ops.addSlideText(deck, title, { text: "Mycelial growth under stress", x: 60, y: 120,
                                width: 520, height: 60, fontSize: 32, fontWeight: 700 });

const s = ops.addSlide(deck, { name: "Results", layout: "blank" }).id;      // blank = no starter text
ops.addSlideText(deck, s, { text: "Growth doubles under stress", x: 45, y: 40, fontSize: 18 });
ops.addPlotToSlide(deck, s,  { assetId: "growthA", x: 320, y: 60, width: 280, height: 230 });
ops.addImageToSlide(deck, s, { assetId: "scope-shot", x: 40, y: 250, width: 90, height: 70 });
ops.addElement(deck, s, { type: "rect", id: "hero", x: 40, y: 90, width: 120, height: 80,
                          rotation: 0, fill: "none", stroke: "#4385be", strokeWidth: 3, cornerRadius: 0 });

const b1 = ops.addBeat(deck, s, { label: "draw" })!;
ops.setAnimation(deck, s, b1.id, { target: "hero", preset: "drawOn", duration: 700,
                                   params: { mode: "both-ends" } });
const b2 = ops.addBeat(deck, s, { label: "become" })!;
ops.setTransform(deck, s, b2.id, "hero", { state: { x: 420, stroke: "#d14d41" }, duration: 600 });
ops.groupTracks(deck, s, b2.id, [/* track ids */], "Hero move");

await core.saveDeck(root, deck);          // locks + journals + registers in project.json
await core.exportDeck(root, "defense");   // → exports/defense.html
```

**Gotchas:** `ops.findElement(deck, elId)` returns `{ slide, el } | null` — use `.el`. The
stage is the FIGURE ruler (default 640×360 = a ~6.7″ frame; fontSize in canvas px = pt × 4/3).
`addSlide` with a non-blank layout seeds placeholder starter text only when `starters: true`.

## Beats, resting state, and determinism

Motion is built from **beats** (one-button advance steps) carrying **tracks**. Beat 0 is the
slide's resting state — pinned, never animated. The player computes a deterministic resting
look at any (slide, beat): every transform ≤ the current beat rests at its composed end;
enters are hidden before their beat; exits after. Preview, present, and export share ONE
engine, so they agree by construction. Tracks whose element was deleted are TOLERATED
(no-op + ⚠ in the animator, never auto-pruned — undo restores the pair).

Track groups (`Beat.groups[]` + `Track.groupId`) are presentational animator lanes — they
never change playback. Collapse state persists in the deck (you can read the authoring
layout). Design keeps ordinary objects available for arranging, but hides future hand-off
destinations unless Show hidden is on. Unborn ghosts stay absent even with Show hidden.
X-ray Change picks select whole owning objects; appearance picks author per-part effects.

Cascade accepts `curve.bounce` (Spring bounce), `arc` and `stagger.totalMs` alongside
start/duration/influence/per-item stagger. Spring bounce ranks only resolved spring tracks
and clamps to −0.5…0.8; other effects consume no rank.

**Timing curves:** `set-track`, `set-transform` and `anim-style create|set` accept
`--curve '<grammar>'` (MCP: `curve` string). The grammar is:

- `standard`, `smooth`, `enter`, `exit`, `linear` — the existing easing tokens.
- `gentle`, `overshoot`, `anticipate`, `anticipate + overshoot`, `settle`, `snappy`,
  `bouncy`, `playful`, `steps`, `hold` — catalog names, stored as concrete specs.
- `spring(0.35)`, `spring(0.35, v=2)` or `spring(k=170, c=26, m=1)`.
- `bezier(0.34,1.56,0.64,1)` or `cubic-bezier(0.34,1.56,0.64,1)`.
- `steps(8)` or `steps(1,start)`; omitted jump means end.

Input values are clamped: bezier x handles 0–1, y handles −1–2, spring bounce
−0.5–0.8, steps a whole number 1–60. Decks store `curve:{kind:"spring",bounce:0.35}`,
`{kind:"bezier",p:[x1,y1,x2,y2]}` or `{kind:"steps",n:8,jump?:"start"|"end"}`.
Spring velocity is optional; m/k/c are input sugar, never stored. The bar's duration is
the settle time. PowerPoint uses Morph's own easing.

`curve`, `influence` and `easing` are one logical timing field. Any own value blocks
all three from a linked style. Editing one clears the other two; `--curve` wins when
combined with legacy options. `--easing` remains available for the five tokens.
In the pure ops, `setTrackCurve(deck, slideId, trackId, null)` clears all three to
inherit the style or use the preset default. Migration preserves known easing tokens and
drops unknown easing strings before validation, falling back to the style or preset default.
Legacy records with several representations still read curve > influence > easing > default.
The GUI also resets when both influence values become zero; the stored `{in:0,out:0}`
sentinel remains available to suppress inherited influence explicitly.

**Linked reuse:** `deck.animStyles` carries named HOW definitions. An own track field wins;
an absent field inherits. Linking removes own HOW fields except `preset`, which always stays on
the track: linking writes the style's preset (same family only), and `anim-style set --preset`
rewrites it on every linked track. "None though the style has one" is `stagger:{perMs:0}`,
`influence:{in:0,out:0}` or `params:{}` on the track (never `null`). Detaching or deleting a style
materializes the resolved settings; bindings and transform endpoints stay on each track.
**Animate like…** (`animate-like` / `animate_like`) links the source and targets to a shared style (creating `Like <label>` when
needed), refusing incompatible families per target. `--beat <beatId>` requires the source
and limits targets to that beat; omitted, it links across the slide. `anim-style` also accepts
`--params` and `--influence` as JSON; media styles refuse stagger. Portable slide snapshots carry referenced
styles; insertion merges by name and family.

**Follow timing** (GUI **⛓ Follow timing…**): `anchor:{trackId,edge:"start"|"end",offsetMs?}` follows a same-step effect.
End includes duration and the stagger tail. Cycles and missing targets produce compiler issues
and fall back to the stored start. The setter refuses invalid anchors before saving.
`set-track --start` moves an anchor's offset; `--no-anchor` preserves its resolved start.
Moving or copying a track to another beat detaches its anchor and keeps the resolved start;
same-beat operations keep the anchor. A start cascade edits offsets, and a duration cascade
writes a local style override.

**Reuse:** presets (one track's settings) live at `<FluxConfig>/presets/animations/`,
templates (bundles with role/type matchers) at `<FluxConfig>/presets/anim-templates/`.
`apply-anim-template` binds a template by part ROLE within a container (an x-axis-derived
template lands on a y-axis) or by element type + document order — partial matches are
reported, never invented.

## The constitution (do not violate)

- **P1 Instantaneous authoring** — adding a slide/element/beat is immediate; never block the author.
- **P2/P3 Signature motion is rare & meaningful** — transforms and big builds earn their moment;
  everything else is a quick, quiet cut or fade. Don't animate for its own sake.
- **P5 Two-tier perf** — Tier-1 (transform/opacity) is free; Tier-2 (stroke-dashoffset, clip-path,
  transform/morph re-renders) is surgical. Never animate layout/paint properties in bulk.
- **P6 Reduced-motion collapses to cuts** — honored automatically by the player; don't fight it.
- **P7 Look** — Flexoki dark, serif body (Gelasio), a single blue accent. 1–2 themes; make/reuse a
  custom theme rather than reaching for a library of presets. `ops.setTheme` / `setStageSize`.

## 3D models

Import a GLB or a 3D fluxplot saved by `Scene3D.save` with its sibling manifest:

```sh
flux add-slide-model <deck> <slideId> plots/neuron.glb --width 480 --height 360
flux add-turntable <deck> <slideId> <beatId> <elementId> --turns 1 --duration 6000
```

Both commands return their created IDs. Model import also returns warnings in JSON/MCP;
`--no-poster` skips the derived still. Input paths may be project-relative or absolute
inside the project; escaping paths and symlinks are refused. The source stays intact,
and the prepared GLB and sidecars are stored under the deck's `assets/` directory.
Deck JSON and its undo journal contain metadata, never GLB bytes.

Turntable writes a normal Change track with linear timing and an unwrapped azimuth.
An existing whole-model Change at that step is reused: its other keys then share the
Turntable's timing (`--duration`, linear, `--start` or 0).
`--direction cw|ccw` chooses direction; `--start` offsets it within the step. Orbit zoom
interpolates geometrically, while azimuth retains complete turns. Projection switches
at the endpoint. Shape weights and field ranges can share the same Change.
Use `animate-element ... --part <partId>` for a mesh or furniture part; part IDs come
from the scene manifest, not a guessed DOM selector. Appearance timing does not change
the model's geometry or its saved Design view.

Ghost keeps an independent view of the same immutable mesh. Become uses vertex morphing
for compatible topology and crossfades otherwise; inspect compatibility with
`flux model-info <a.glb> --morph-with <b.glb>`. A hand-off keeps both objects; Consume
replaces the source's content and removes the destination in one edit. A shape state
changes geometry within the same asset and needs no second model.

Portable HTML and MP4 carry the moving 3D scene. PDF and PPTX use the Design-view still
with vector furniture where supported; they do not export an editable 3D object. Keep
GLBs present when saving: a missing model produces an actionable refusal rather than
an incomplete deck. Portable slide presets include model bytes explicitly for reuse
across projects.

## Video clips

`video` has ordinary element geometry plus `assetId`, `posterAssetId`, `durationMs`,
`muted?` (default false), and `loop?` (default false). Import through `add-video` so the
shared native preparation creates a portable H.264/AAC MP4 and PNG poster under the deck's
`assets/`; originals stay in `plots/_videos`. The canvas edits the poster without a decoder.
Use normal appearance tracks to reveal/hide it. A `videoStart`, `videoPause`, or `videoStop`
track controls playback independently, has zero duration and an optional start offset, and
must target a whole video element on a step after Design. Start restarts at zero, Pause
freezes, Stop resets. Playback continues across manual waits; navigation/blanking pauses it.
Clip media/settings cannot be changed through a sparse transform patch. Ordinary video
copies have independent playback commands; Ghost transforms are unavailable for video.
Portable HTML includes video/audio. `export-slide-video` includes decoded moving frames
and unmuted audio, waits for the final active non-looping clip, and bounds loops to the
export timeline. For another deck import the clip again or use a portable whole-slide preset.

## Present + export

- **Present (in app):** the `▶ Present` button (or drive the player). Keymap: →/Space/PageDown/click
  advance (Shift = next slide), ←/Backspace/PageUp back, ↑/↓ jump slides, digits+Enter jump, **S**
  speaker-notes + timer, **R** reset timer, **B**/**W** blank, **F** fullscreen, Esc exit. Add
  per-slide `notes` (markdown) to feed the speaker view.
- **Export:** `flux export-deck <id>` → `exports/<id>.html`. One file, offline, double-click to
  present. This is the definition of done for a talk — verify by opening it with no network.
- The **same player** drives in-app present AND the exported file → WYSIWYG. Never write a second
  renderer.

## Verify your work

- `flux validate-deck <id>` — schema-check the deck.
- Headless ops/player/tween/trim/export tests:
  `npx tsx scripts/verify-slide-{track-ops,player,tween,morph,become,outline,export-transform}.ts` and
  `npx tsx scripts/verify-trim.ts`.
- The real test for a talk: export it and **open the `.html` offline** — title, builds, trims,
  transforms, and morphs must all play with arrow keys and a clicker, no network.

Related: `PROJECT-AND-FIGURES.md` (figures you copy in), `PLOTS-AND-STYLE.md`
(semantic plots you morph), `CLI-REFERENCE.md` (running the verbs).

## Inline slides in Paper

`insert-slide-embed <deck> <slide> [--doc path.qmd] [--width 75%] [--caption "…"]`
(MCP: `insert_slide_embed`) embeds one existing project slide. Optional `--anchor "…"`
inserts after the containing line and must match exactly once; otherwise it appends.
The source is `![caption](relative/poster.svg){#slide-<occurrence> .flux-slide deck="id" slide="id" width=100%}`.
The IDs are authoritative; the poster is a rebuildable SVG of step 0. The document owns
caption/width; the deck owns content/animations. Playback state is transient per occurrence.

Paper and HTML use the shared player in manual step mode: auto/with-prev each require a
click, concurrent tracks retain their timing, and the final step stops. PDF/Word show step 0.
`compile --doc path.qmd --to html|pdf|docx` resolves includes and regenerates posters.
The HTML export contains only referenced slides and their required assets, without speaker
notes or local source paths. Deleting referenced slides fails unless `delete-slide --force`
is explicit; inspect the listed documents before overriding.

Saved 3D Design values can also be edited with `set-model-view <element> --deck <deck> --slide <slide>` and `set-model-field <element> <field> --deck <deck> --slide <slide>`. Use `render-model-posters --deck <deck>` (optionally `--slide <slide>`) to render the slides' Design stills and every build step's still, with that step's part visibility, into the project cache; Connect sheets and command-line Paper renders read only cached stills, and `--prune` keeps all of them. Timed changes remain ordinary animation tracks. Do not combine Figure and deck selectors.
