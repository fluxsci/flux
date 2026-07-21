# Flux Slide — build & animate a scientific talk (the 4th pillar)

Flux Slide is a **figure-first talk creator and animator** — "PowerPoint meets 3blue1brown."
A **slide IS a figure** (deck `0.3.0`): its `elements` are the figure element union verbatim
(`text`, `rect`, `ellipse`, `line`, `path`, `image`, `plot`) plus a presentation overlay of
beats/transition/notes/camera. You animate with **two families** — (dis)Appearances and
**Transforms** (the signature: any object tweens into a different version of itself) — and
export **one self-contained `.html`** that presents offline on any browser. Agents are
first-class authors: every mutation is a pure op surfaced through flux-core **and the CLI
*and* MCP**, so you can build a whole animated talk from files, app open or closed.

**The file is the API.** A deck is plain JSON at `slides/<deckId>/deck.json`, registered in
`project.json.slides[]`. Edit it through the verbs (which lock + journal) or, for bulk
authoring, through the pure ops — never hand-wave the schema; run `validate-deck` after.
(`0.2.0` decks auto-migrate on load; `0.1.x` is a sanctioned clean break.)

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
flux set-theme <deck> <theme>                  # (set_deck_theme)  flux-dark|light|midnight|slate|sepia|contrast

# content (returns the new element id on stdout)
flux add-text <deck> <slideId> "text…" [--x --y --width --height --align --color --size-pt --weight --sizing]   # (add_slide_text)
flux add-figure <deck> <slideId> <figureId> [--x --y]   # (add_slide_figure)  COPY a project figure's content (fresh ids, native size)

# animation — (dis)appearances
flux add-beat <deck> <slideId> [--label L]     # (add_beat)     append a build/advance step
flux set-animation <deck> <slideId> <beatId> --target <elId|@camera|@stage> [--preset P] [--part id]
     [--start ms] [--duration ms] [--easing e] [--to-asset id] [--to-x --to-y --to-zoom] [--track '<json>']
                                               # (set_animation)  --track passes a full Track JSON; else built from flags
flux animate-element <deck> <slideId> <elId> [--exit] [--preset P] [--beat-index n]   # (animate_element)  smart per-kind default
flux animate-part <deck> <slideId> <elId> <part> [--beat-index n]                     # (animate_part)     plot-part default reveal

# animation — transforms (the signature family)
flux set-transform <deck> <slideId> <beatId> <elId> --state '<json patch>' [--replace-state]
     [--start ms] [--duration ms] [--easing e] [--to-asset id]                        # (set_transform)
flux set-morph <deck> <slideId> <beatId> <elId> <toAssetId> [--duration ms]           # (set_morph)  legacy data-space form

# lane organization + reuse
flux group-tracks <deck> <slideId> <beatId> t1,t2… [--label L]    # (group_tracks)    collapsible animator lane group
flux ungroup-tracks <deck> <slideId> <beatId> t1,t2…              # (ungroup_tracks)
flux cascade-tracks <deck> <slideId> <property> t1,t2… [--delta n | --factor n]
     [--order timeline|list] [--reverse] [--first-fixed]          # (cascade_tracks)  stepped timing delta
                                               # across tracks: rank k gets value+delta·step (step = k with
                                               # --first-fixed, else k+1); property ∈ start|duration|
                                               # influence.in|influence.out|stagger.perMs; a start cascade
                                               # with --first-fixed IS the classic stagger
flux apply-anim-template <deck> <slideId> <name|path.json> [--element id [--part axis.y] | --elements a,b,c] [--beat id]
                                               # (apply_anim_template)  bind a saved preset bundle by role/type

# verify + ship
flux validate-deck [deck]                      # (validate_deck)  check against the bundled schema
flux export-deck <deck> [--out F]              # (export_deck)   → self-contained exports/<deck>.html (offline)
```

`add-figure` is the primary way to put composed figures into a deck: it copies a project
figure's elements (same 96 px/inch ruler → native size) and keeps plot **panels addressable**,
so you can stagger their parts or morph them. `export-deck` gathers everything off disk and
emits ONE file with the player + fonts inlined. No network, no install to present.

## The two families

**1. (dis)Appearances** — an object arrives or leaves elegantly. Enters: `fade`, `fadeRise`,
`popIn`, `growBaseline`, `drawOn`, `writeOn`, `stagger` (fan a child preset across a part set).
Exits: `fadeOut`, `popOut`, `drawOff`, `wipeOut`. Emphasis: `highlight`, `dim`, `countUp`.
An enter and an exit for the same object belong in DIFFERENT beats (same-family tracks on one
beat replace each other).

- **Trim Paths** (`drawOn`/`drawOff` `params`) — the featured stroke draw:
  `anchor` (0..1, or `corner-tl|top|corner-tr|right|corner-br|bottom|corner-bl|left|start|middle|end`),
  `direction` (`forward|reverse`), `mode` (`single|both-ends|middle-out`), `from`/`to`
  (partial window, 0..1). A rect can draw from its top-right corner, meet in the middle from
  both ends, or draw only its top half. Only STROKE-rendered shapes self-draw (a filled shape
  fades — dash windows hide strokes alone). Defaults reproduce the classic full draw.
- `writeOn`/`wipeOut` take `params.direction: ltr|rtl|ttb|btt`.
- Timing knobs on every track: `start`, `duration`, `easing`
  (`smooth|standard|enter|exit|linear`), `influence` ({in, out} 0–100, the AE velocity
  profile), `stagger` ({perMs, by: index|x|y, from: start|end|center|edges}).

**2. Transforms** — the object BECOMES a different version of itself: position, size, shape
geometry, colors (blended in OKLab), opacity, dash, text (a pure numeric change digit-tweens;
a rewrite crossfades — moving all the while), plot part styles, and (for plots) the data-space
morph in one track. `set-transform` stores a **sparse patch** (`to.state`) against the
track's pre-state; **chaining composes**: t1 of a later transform = the earlier one's end.
Max ONE transform per element per beat — chain across beats. Never hand-compose states; pass
the patch and let the engine fold. `--to-asset` adds the same-structure plot-data morph half.

```
flux set-transform talk s1 b2 el_rect --state '{"x": 420, "width": 220, "stroke": "#d14d41"}' --duration 700
flux set-transform talk s1 b3 el_rect --state '{"opacity": 0.3}'        # chains: t1 = b2's end
flux set-transform talk s1 b2 el_plot --state '{"width": 500}' --to-asset growthB   # frame + data morph
```

**Camera** is its own small family: `--target @camera --preset camera --to-x --to-y --to-zoom`.

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
layout).

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
  `npx tsx scripts/verify-slide-{track-ops,player,tween,morph,export-transform}.ts` and
  `npx tsx scripts/verify-trim.ts`.
- The real test for a talk: export it and **open the `.html` offline** — title, builds, trims,
  transforms, and morphs must all play with arrow keys and a clicker, no network.

Related: `PROJECT-AND-FIGURES.md` (figures you copy in), `PLOTS-AND-STYLE.md`
(semantic plots you morph), `CLI-REFERENCE.md` (running the verbs).
