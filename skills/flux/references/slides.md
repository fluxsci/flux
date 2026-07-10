# Flux Slide — build & animate a scientific talk (the 4th pillar)

Flux Slide is a **figure-first talk creator and animator** — "PowerPoint meets 3blue1brown."
You author a deck, animate it with one-click presets (including the signature **data-space
morph**), and export **one self-contained `.html`** you can present offline on any browser
(the flash-drive file). Agents are first-class authors: every slide mutation is a pure op,
surfaced through flux-core **and the CLI *and* MCP** (structure, content, beats, animation —
full parity), so you can build a whole animated talk from files, app open or closed.

**The file is the API.** A deck is plain JSON at `slides/<deckId>/deck.json`, registered in
`project.json.slides[]`. Edit it through the verbs (which lock + journal) or, for bulk authoring,
through the pure ops — never hand-wave the schema; run `validate-deck` after.

## The one rule that matters: ops-core-first

Every mutation lives in `src/lib/slide/ops.ts` as a **pure function** `(deck, args) => result`.
The GUI, flux-core, and the CLI all call the same ops. When scripting a deck in Node, import the
ops directly; when driving from the shell, use the CLI verbs (thin wrappers over flux-core).

## CLI + MCP verbs (the agent entry point)

Every verb below is BOTH a CLI verb (`flux <verb>`) and an MCP tool (name in parens) — one
core, two surfaces (see `references/cli.md` for the wrapper + the one gotcha). They lock +
journal, so they coexist with a live human editor.

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
flux add-text <deck> <slideId> "text…" [--x --y --width --height --align --color --font-size]   # (add_slide_text)
flux add-math <deck> <slideId> "\\tex…" [--display] [--x …]                                       # (add_slide_math)
flux add-embed-figure <deck> <slideId> <figureId> [--fit contain|cover|fill] [--x …]             # (add_slide_figure)

# animation
flux add-beat <deck> <slideId> [--label L]     # (add_beat)     append a build/advance step
flux set-animation <deck> <slideId> <beatId> --target <elId|@camera|@stage> [--preset P] [--part id]
     [--start ms] [--duration ms] [--easing e] [--to-asset id] [--to-x --to-y --to-zoom] [--track '<json>']
                                               # (set_animation)  --track passes a full Track JSON; else built from flags

# verify + ship
flux validate-deck [deck]                       # (validate_deck)  check against the bundled schema
flux export-deck <deck> [--out F]              # (export_deck)   → self-contained exports/<deck>.html (offline)
```

`add-embed-figure` is the primary way to put your composed figures into a deck: it references a
project figure by id (no asset upload) and keeps the figure's **panels addressable**, so you can
stagger them (a→b→c) or morph a plot inside it. `export-deck` gathers everything off disk
(deck-local images → data URIs, semantic plots incl. morph targets → inline SVG + manifest,
project figures → standalone SVG) and emits ONE file with the player, fonts (Gelasio + KaTeX),
and KaTeX CSS all inlined. No network, no install to present.

> Adding raw image/plot *assets* (uploading media bytes into a deck) is still GUI/Node-only —
> from an agent, embed a **project figure** (above) instead, or script `ops.addAsset` +
> `ops.addImageToSlide`/`addPlotToSlide` in Node (below).

## Authoring a deck in Node (bulk / precise work)

For anything beyond a slide or two, script it with the pure ops + `flux-core/slides.ts`:

```ts
import * as core from "./flux-core/slides";
import * as ops from "./src/lib/slide/ops";

const deck = ops.createDeck({ id: "defense", title: "Mycelial Growth" });   // seeds 1 slide
const title = deck.slides[0].id;
ops.addTextBox(deck, title, { text: "Mycelial growth under stress", x: 120, y: 250,
                              width: 1040, height: 160, fontSize: 64, fontWeight: 700 });

const s = ops.addSlide(deck, { name: "Results", layout: "content-figure" }).id;
// rich text with bullets — blocks carry markers + emphasis
const body = ops.addTextBox(deck, s, { x: 90, y: 150, width: 560, height: 360, fontSize: 34, blocks: [
  ops.makeBlock("Growth doubles under stress", { marker: "bullet" }),
  ops.makeBlock("…but only above 24 °C",       { marker: "bullet", emphasis: "accent" }),
]});
ops.addMath(deck, s, { tex: "\\frac{dN}{dt}=rN\\left(1-\\frac{N}{K}\\right)", x: 90, y: 540,
                       width: 560, height: 110, display: true });
ops.addPlotToSlide(deck, s,  { assetId: "growthA", x: 700, y: 150, width: 480, height: 400 });
ops.addEmbedFigure(deck, s,  { figureId: "growth", x: 700, y: 150, width: 480, height: 400 });
ops.addImageToSlide(deck, s, { assetId: "scope-shot", x: 1100, y: 40, width: 120, height: 120 });
ops.addRect(deck, s, { x: 80, y: 120, width: 600, height: 4 });   // + addEllipse / addLine

await core.saveDeck(root, deck);          // locks + journals + registers in project.json
await core.exportDeck(root, "defense");   // → exports/defense.html
```

**Gotcha:** `ops.findElement(deck, elId)` returns `{ slide, el } | null` — use `.el`, not the
wrapper. Element types: `textBox`, `math`, `image`, `video`, `plot` (semantic, addressable parts),
`embedFigure`, and shapes `rect`/`ellipse`/`line`.

## Animation: beats + tracks + presets

Motion is built from **beats** (one-button advance steps) carrying **tracks** (animations). A track
names a `target` element, a `preset`, and an optional `selector`/`to`. The player computes a
deterministic **resting state** at any (slide, beat) — so preview, present, and export all agree,
and back/forward is reversible.

```ts
const reveal = ops.addBeat(deck, s, { label: "reveal", advance: "click" })!;
// stagger the bullets in (selector.blocks "all" → each .sl-block, offset by perMs)
ops.setAnimation(deck, s, reveal.id, { target: body, selector: { blocks: "all" },
                                       preset: "stagger", duration: 320, stagger: { perMs: 110 } });

const grow = ops.addBeat(deck, s, { label: "morph", advance: "click" })!;
// the crown jewel: morph plot A → plot B in DATA space (log-aware, axis-rescaling)
ops.setAnimation(deck, s, grow.id, { target: plotEl, preset: "morph",
                                     to: { assetId: "growthB" }, duration: 1200, easing: "smooth" });
```

**Preset catalog** (`src/lib/slide/player/presets.ts`): `fade`, `fadeRise`, `popIn`, `growBaseline`,
`writeOn`, `drawOn`, `move`/`scale`/`rotate`, `highlight`/`dim`, `camera` (push in on a region),
`stagger` (apply a child preset across text blocks / plot parts), and `morph`. **Targeting:** whole
element (default), text blocks via `selector.blocks`, a single plot part via `track.part`
(`${elId}__${semanticId}`), a set of parts via `selector` role/series/index, or `@camera`/`@stage`.

Keep the data model forward-compatible with full per-property keyframing — don't invent a parallel
animation format; extend tracks.

## The constitution (do not violate — `notes/style_principles.md`)

- **P1 Instantaneous authoring** — adding a slide/element/beat is immediate; never block the author.
- **P2/P3 Signature motion is rare & meaningful** — the morph and big builds earn their moment;
  everything else is a quick, quiet cut or fade. Don't animate for its own sake.
- **P5 Two-tier perf** — Tier-1 (transform/opacity) is free; Tier-2 (stroke-dashoffset, clip-path,
  morph `d` rewrites) is surgical. Never animate layout/paint properties in bulk.
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
- Headless ops/player/morph/export tests: `npx tsx scripts/verify-slide-{edit,player,morph,export,export-core}.ts`.
- The real test for a talk: export it and **open the `.html` offline** — title, math, builds, and
  morphs must all play with arrow keys and a clicker, no network.

Related: `references/project-and-figures.md` (figures you embed), `references/plots-and-style.md`
(semantic plots you morph), `references/cli.md` (running the verbs).
