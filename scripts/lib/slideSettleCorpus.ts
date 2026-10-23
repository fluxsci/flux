// The lane-J settle corpus: decks that exercise every preset of the catalog on every element kind, plus the transform
// family (Change move/resize/rotate/recolour/rewrite, Become, Ghost), camera, chains, springs and plot-part builds.
// Pure construction through the product's own ops (the bytes the GUI/CLI write; `authoredFields` supplies the pace a new
// animation gets). `corpus("compact")` is the curated subset the gate runs (every preset family and element kind, fixtures
// from the repo only); `"synthetic"` is the full grid; `"rig"` adds the Release-1 review deck and the study rigs' decks
// under notes/manim_exploration (probe only: they live outside the repo).
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas } from "@napi-rs/canvas";
import { createDeck, addSlide, addElement, addBeat, setAnimation, setTransform, addGhostTransform } from "../../src/lib/slide/ops";
import { pathD } from "../../src/lib/path";
import { authoredFields } from "../../src/lib/slide/presetCatalog";
import { applyAutoAnimation, SWEEP_CURVE, V2_PACE } from "../../src/lib/slide/autobuild";
import { plotMeasures } from "../../src/lib/slide/partLength";
import { parseHTML } from "linkedom";
import type { Deck, Track, TargetRef, BecomeSpec } from "../../src/lib/slide/types";
import type { SweepPayload } from "./slideSettleSweep";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(here, "../fixtures/plots");
const NOTES = process.env.FLUX_NOTES_DIR ?? path.resolve(here, "../../../../notes/manim_exploration");
export interface CorpusDeck { name: string; payload: SweepPayload }

const C = { blue: "#4385be", blueD: "#205ea6", red: "#d14d41", redD: "#af3029", green: "#879a39", yellow: "#d0a215", purple: "#8b7ec8", cyan: "#3aa99f", orange: "#da702c", ink: "#100f0f" };
const star = (cx: number, cy: number, R: number, r: number) => "M " + Array.from({ length: 10 }, (_, i) => { const a = -Math.PI / 2 + i * Math.PI / 5, rad = i % 2 ? r : R; return `${(cx + rad * Math.cos(a)).toFixed(2)} ${(cy + rad * Math.sin(a)).toFixed(2)}`; }).join(" L ") + " Z";

/** The element kinds of the corpus (one grid cell each). */
export const KINDS = ["text", "rect", "rectS", "ellipse", "line", "arrow", "path", "star", "image"] as const;
export type Kind = (typeof KINDS)[number];
const CELL: Record<Kind, [number, number]> = { text: [40, 40], rect: [250, 40], rectS: [460, 40], ellipse: [40, 150], line: [250, 150], arrow: [460, 150], path: [40, 260], star: [250, 260], image: [460, 260] };

const el = (kind: Kind, id: string, x: number, y: number, o: Record<string, unknown> = {}): Record<string, unknown> => {
  const base = { id, x, y, rotation: 0 };
  switch (kind) {
    case "text": return { ...base, type: "text", width: 150, height: 30, text: "Flux 42", fontFamily: "Georgia", fontSize: 22, fontWeight: 400, fontStyle: "normal", align: "left", color: C.ink, sizing: "auto", ...o };
    case "rect": return { ...base, type: "rect", width: 100, height: 56, fill: C.blue, stroke: "none", strokeWidth: 0, cornerRadius: 8, ...o };
    case "rectS": return { ...base, type: "rect", width: 100, height: 56, fill: "#f2f0e5", stroke: C.blueD, strokeWidth: 5, cornerRadius: 0, ...o };
    case "ellipse": return { ...base, type: "ellipse", width: 100, height: 56, fill: C.red, stroke: "none", strokeWidth: 0, ...o };
    case "line": return { ...base, type: "line", width: 110, height: 40, x1: 0, y1: 40, x2: 110, y2: 0, stroke: C.ink, strokeWidth: 4, arrowStart: false, arrowEnd: false, cap: "round", ...o };
    case "arrow": return { ...base, type: "line", width: 110, height: 40, x1: 0, y1: 40, x2: 110, y2: 0, stroke: C.redD, strokeWidth: 4, arrowStart: false, arrowEnd: true, cap: "round", ...o };
    case "path": return { ...base, type: "path", width: 110, height: 60, d: "M0 50 C 30 -10, 60 90, 110 10", fill: "none", stroke: C.purple, strokeWidth: 4, closed: false, cap: "round", ...o };
    case "star": return { ...base, type: "path", width: 80, height: 80, d: star(40, 40, 38, 16), fill: C.yellow, stroke: C.orange, strokeWidth: 3, closed: true, cap: "round", ...o };
    case "image": return { ...base, type: "image", width: 80, height: 60, assetId: "img", ...o };
  }
};

/** A small gradient PNG: an `image` element needs bytes. Deterministic. */
function pngDataUrl(): string {
  const c = createCanvas(64, 48), g = c.getContext("2d"), grad = g.createLinearGradient(0, 0, 64, 48);
  grad.addColorStop(0, C.cyan); grad.addColorStop(1, C.purple);
  g.fillStyle = grad; g.fillRect(0, 0, 64, 48); g.fillStyle = "#fffcf0"; g.fillRect(8, 8, 20, 12);
  return `data:image/png;base64,${c.toBuffer("image/png").toString("base64")}`;
}

const readPlot = async (name: string) => ({ svg: await fs.readFile(path.join(FIXTURES, `${name}_FLUXPLOT.svg`), "utf8"), manifest: JSON.parse(await fs.readFile(path.join(FIXTURES, `${name}_FLUXPLOT.fluxplot.json`), "utf8")) });

class Builder {
  deck: Deck;
  constructor(id: string) { this.deck = createDeck({ id, title: id, theme: "flux-paper", withTitleSlide: false }); this.deck.defaults.transition = "none"; this.deck.assets = [{ id: "img", name: "img", kind: "png", path: "assets/img.png", naturalWidth: 64, naturalHeight: 48 }]; }
  slide(id: string) { addSlide(this.deck, { id, layout: "blank" }); return id; }
  add(slide: string, e: Record<string, unknown>) { addElement(this.deck, slide, e as never); return e.id as string; }
  beat(slide: string, o: { advance?: "click" | "with-prev" | "auto"; autoDelayMs?: number } = {}) { return addBeat(this.deck, slide, { advance: "click", ...o })!; }
  /** a track with the AUTHORED fields (what the app writes for a new animation) */
  anim(slide: string, beat: { id: string }, target: string, preset: string, extra: Partial<Track> = {}): Track {
    const t = { id: `t_${target}_${preset}_${beat.id}`, target, preset, ...authoredFields(preset), start: 0, ...extra } as Track;
    setAnimation(this.deck, slide, beat.id, t); return t;
  }
  /** a track with OLD authored timing (explicit, so it plays like a deck made before the new pace) */
  old(slide: string, beat: { id: string }, target: string, preset: string, duration: number, extra: Partial<Track> = {}): Track {
    const t = { id: `t_${target}_${preset}_${beat.id}_old`, target, preset, duration, easing: "standard", start: 0, ...extra } as Track;
    setAnimation(this.deck, slide, beat.id, t); return t;
  }
  change(slide: string, beat: { id: string }, target: string, state: Record<string, unknown>, o: Record<string, unknown> = {}) {
    return setTransform(this.deck, slide, beat.id, target, { state, duration: 1200, easing: "smooth", ...o });
  }
  become(slide: string, beat: { id: string }, source: string, ref: TargetRef, spec: Partial<BecomeSpec> = {}, o: Record<string, unknown> = {}) {
    const t = setTransform(this.deck, slide, beat.id, source, { state: {}, duration: 1200, easing: "smooth", ...o })!;
    t.to!.become = { mode: "handoff", ref, ...spec };
    return t;
  }
}

// WP 2.2 (Release 2) appended its fade-free vocabulary at the END of each family, so earlier decks keep their cue numbers
const ENTER = ["fade", "fadeRise", "popIn", "drawOn", "growBaseline", "stagger", "writeOn", "scaleIn"] as const;
const EXIT = ["fadeOut", "popOut", "drawOff", "wipeOut", "scaleOut"] as const;
const EMPH = ["highlight", "dim", "pulse", "encircle"] as const;
const LEGACY: Record<string, Partial<Track>> = { move: { to: { x: 60, y: 24 } }, scale: { to: { scale: 1.35 } }, rotate: { to: { rotation: 28 } } };

/** Slides of one preset applied to `kinds`: one cue per kind. */
function presetSlide(b: Builder, preset: string, kinds: readonly Kind[], extra: Partial<Track> = {}, tag = preset): void {
  const s = b.slide(`p_${tag}`);
  const ids = Object.fromEntries(kinds.map(k => [k, b.add(s, el(k, `${k}`, ...CELL[k]))])) as Record<Kind, string>;
  for (const k of kinds) {
    const beat = b.beat(s);
    if (LEGACY[preset]) b.old(s, beat, ids[k], preset, 700, { ...LEGACY[preset], ...extra });
    else b.anim(s, beat, ids[k], preset, extra);
  }
}

/** Plot decks: parts of the three fixture plots. */
async function plotDecks(compact: boolean): Promise<CorpusDeck[]> {
  const out: CorpusDeck[] = [];
  const plots = { scatter: await readPlot("mpl_scatter"), bars: await readPlot("mpl_bars"), sine: await readPlot("mpl_sine_waves") };
  const place = (b: Builder, s: string, id: string, asset: string, o: Record<string, unknown> = {}) => b.add(s, { id, type: "plot", assetId: asset, x: 60, y: 60, width: 520, height: 270, rotation: 0, ...o });
  {
    const b = new Builder("plots_build"); const D = (p: string, extra: Partial<Track> = {}) => ({ preset: p, ...extra });
    // scatter markers: the build's four phases, one cue each (axes, points, fit/legend)
    const s = b.slide("scatter"); place(b, s, "pl", "scatter");
    const axes = b.beat(s);
    b.anim(s, axes, "pl", "drawOn", { part: "axis.x.spine" }); b.anim(s, axes, "pl", "drawOn", { part: "axis.y.spine" });
    b.anim(s, axes, "pl", "drawOn", { part: "axis.x.ticks", stagger: { by: "x", from: "start", totalMs: 450 }, duration: 140 });
    b.anim(s, axes, "pl", "fade", { part: "axis.x.tick-labels", start: 40, duration: 200, stagger: { by: "x", from: "start", totalMs: 450 } });
    b.anim(s, axes, "pl", "fade", { part: "axis.y.tick-labels", start: 40, duration: 200, stagger: { by: "y", from: "start", totalMs: 450 } });
    // Every point child enters FRESH points, one slide each. The points of one slide enter ONCE: a second enter of the same (visible) points makes each
    // of them leave and grow back at its own turn (a node that is already shown has to vanish before its enter can show it again: `fade` twice
    // pops exactly like `scaleIn` after `popIn`), which is what entering a shown part MEANS, not a defect of the child (R2 F2 measured both). The
    // authored scatter build enters its points once.
    const children = compact ? ["fade", "popIn", "scaleIn"] : ["fade", "fadeRise", "popIn", "growBaseline", "scaleIn"];  // scaleIn: the V2 point child (WP 2.2)
    const enter = (slide: string, child: string) => {
      const beat = b.beat(slide);
      b.anim(slide, beat, "pl", "stagger", { selector: { role: "point" }, stagger: { by: "index", from: "start", totalMs: 1200 }, params: { child }, duration: 400 });
    };
    enter(s, children[0]);
    for (const child of children.slice(1)) { const slide = b.slide(`scatter_${child}`); place(b, slide, "pl", "scatter"); enter(slide, child); }
    // ... and the second enter of the SAME points, kept as the pinned meaning of re-entering a shown part (KNOWN_OPEN, "by definition")
    { const slide = b.slide("scatter_reenter"); place(b, slide, "pl", "scatter"); enter(slide, "scaleIn"); enter(slide, "scaleIn"); }
    out.push({ name: "plot_scatter", payload: { deck: b.deck, plots: { scatter: plots.scatter } } });
    void D;
  }
  {
    // part effects on VISIBLE points (no enter): every transform-writing part effect leaves a visible part's first frame equal to its rest
    // (a scaleIn / popIn / scaleOut / pulse / legacy scale / rotate / popOut / dim wrapper must add no step of its own)
    const b = new Builder("plot_parts");
    for (const [preset, extra] of [["pulse", {}], ["scaleOut", {}], ["popOut", {}], ["scale", { to: { scale: 1.4 } }], ["rotate", { to: { rotation: 40 } }], ["dim", {}]] as [string, Partial<Track>][]) {
      const s = b.slide(`parts_${preset}`); place(b, s, "pl", "scatter");
      const beat = b.beat(s);
      if (LEGACY[preset]) b.old(s, beat, "pl", preset, 700, { selector: { role: "point" }, ...extra }); else b.anim(s, beat, "pl", preset, { selector: { role: "point" }, ...extra });
    }
    out.push({ name: "plot_parts", payload: { deck: b.deck, plots: { scatter: plots.scatter } } });
  }
  {
    const b = new Builder("plots_bars"); const s = b.slide("bars"); place(b, s, "pl", "bars", { x: 200, width: 240 });
    const axes = b.beat(s);
    b.anim(s, axes, "pl", "drawOn", { part: "axis.x.spine" }); b.anim(s, axes, "pl", "drawOn", { part: "axis.y.spine" });
    b.anim(s, axes, "pl", "drawOn", { part: "axis.y.ticks", stagger: { by: "y", from: "start", totalMs: 450 }, duration: 140 });
    const grow = b.beat(s); b.anim(s, grow, "pl", "stagger", { selector: { role: "bar" }, stagger: { by: "x", from: "start", totalMs: 600 }, params: { child: "growBaseline" }, duration: 750 });
    if (!compact) { const beat = b.beat(s); b.anim(s, beat, "pl", "fade", { selector: { role: "errorbar" }, duration: 500 }); }
    out.push({ name: "plot_bars", payload: { deck: b.deck, plots: { bars: plots.bars } } });
  }
  {
    const b = new Builder("plots_lines"); const s = b.slide("lines"); place(b, s, "pl", "sine");
    const axes = b.beat(s);
    b.anim(s, axes, "pl", "drawOn", { part: "axis.x.spine" }); b.anim(s, axes, "pl", "drawOn", { part: "axis.y.spine" });
    b.anim(s, axes, "pl", "drawOn", { part: "axis.x.ticks", stagger: { by: "x", from: "start", totalMs: 450 }, duration: 140 });
    const lines = b.beat(s); b.anim(s, lines, "pl", "drawOn", { part: "2hz.line", duration: 1600 }); b.anim(s, lines, "pl", "drawOn", { part: "1hz.line", duration: 1600 });
    if (!compact) {
      const wipe = b.beat(s); b.anim(s, wipe, "pl", "writeOn", { part: "axis.x.tick-labels" });
      const off = b.beat(s); b.anim(s, off, "pl", "drawOff", { part: "1hz.line" });
    }
    out.push({ name: "plot_lines", payload: { deck: b.deck, plots: { sine: plots.sine } } });
  }
  {
    // WP 3.1: the x-clock sweep exactly as the auto-build writes it (a line, its band and its markers on one front; bare lines with the lead
    // dot), and a retreat along x with the dot riding the retreating end
    const b = new Builder("plot_sweep"), band = await readPlot("ts_band_line");
    const auto = (slide: string, plot: { svg: string; manifest: never }) => applyAutoAnimation(b.deck, slide, "pl", plot.manifest, { pace: V2_PACE, ...plotMeasures(parseHTML(plot.svg).document, plot.manifest, 520) });
    const s = b.slide("sweep"); place(b, s, "pl", "band"); auto(s, band as never);
    const w = b.slide("sweep_pen"); place(b, w, "pl", "sine"); auto(w, plots.sine as never);
    b.anim(w, b.beat(w), "pl", "drawOff", { part: "1hz.line", duration: 1100, curve: SWEEP_CURVE, params: { clock: "x", pen: true } });
    out.push({ name: "plot_sweep", payload: { deck: b.deck, plots: { band, sine: plots.sine } } });
  }
  {
    // CHAINED plot Changes (R2 F3): every step starts from the plot the step before it left, whatever it changed. The fixtures are the same plot with
    // five and with ten bars (same size, so the asset Change is a value morph). A chain compiled against the element's BASE asset began its second
    // Change on the merged wide bars (PRE-ROLL CHANGE 4,558).
    const bars5 = await readPlot("mpl_bars_5"), bars10 = await readPlot("mpl_bars_10");
    const b = new Builder("plot_chain"); const to = (id: string) => ({ toAssetId: id, duration: 1200 });
    const chain = (slide: string, steps: Record<string, unknown>[]) => { for (const o of steps) b.change(slide, b.beat(slide), "pl", (o.state as Record<string, unknown>) ?? {}, o); };
    const zoom = { view: { y: { domain: [2, 8] } } };
    { const s = b.slide("bars_chain"); place(b, s, "pl", "bars5", { x: 120, width: 400 }); chain(s, [to("bars10"), to("bars5"), to("bars10")]); }
    { const s = b.slide("asset_then_view"); place(b, s, "pl", "bars5", { x: 120, width: 400 }); chain(s, [to("bars10"), { state: zoom }]); }
    { const s = b.slide("view_then_asset"); place(b, s, "pl", "bars5", { x: 120, width: 400 }); chain(s, [{ state: zoom }, to("bars10")]); }
    // an asset chain between plots of DIFFERENT intrinsic size (sine 360x108 pt, scatter 180x108 pt): open, see KNOWN_OPEN
    const sine = await readPlot("mpl_sine_waves"), scatter = await readPlot("mpl_scatter");
    { const s = b.slide("sine_scatter_sine"); place(b, s, "pl", "sine", { x: 120, width: 400 }); chain(s, [to("scatter"), to("sine")]); }
    out.push({ name: "plot_chain", payload: { deck: b.deck, plots: { bars5, bars10, sine, scatter } } });
  }
  return out;
}

/** The transform family: Change (move / resize / rotate / recolour / rewrite), Become, Ghost, springs, camera, chains. */
async function transformDecks(compact: boolean): Promise<CorpusDeck[]> {
  const out: CorpusDeck[] = [];
  const plots = { scatter: await readPlot("mpl_scatter"), sine: await readPlot("mpl_sine_waves") };
  {
    const b = new Builder("change"); const s = b.slide("change");
    const kinds: readonly Kind[] = compact ? ["text", "rect", "rectS", "line", "path", "star"] : KINDS;
    // a text that is RESIZED is a fixed box (the GUI turns a hugging text fixed the moment its box is dragged)
    for (const k of kinds) b.add(s, el(k, k, ...CELL[k], k === "text" ? { sizing: "fixed", width: 150, height: 30 } : {}));
    for (const k of kinds) {
      const [x, y] = CELL[k], bx = x + 33.37, by = y - 11.21;
      b.change(s, b.beat(s), k, { x: bx, y: by });                                  // pure move (rides a compositor layer)
      b.change(s, b.beat(s), k, { x: bx, y: by, width: (el(k, k, 0, 0).width as number) * 1.4, height: (el(k, k, 0, 0).height as number) * 1.4 }); // resize
      if (!compact) b.change(s, b.beat(s), k, { rotation: 35 });                      // rotate
      if (k === "rect" || k === "ellipse" || k === "star") b.change(s, b.beat(s), k, { fill: C.green });  // recolour
      if (k === "text") b.change(s, b.beat(s), k, { text: "Flux 4.2 rewritten" });  // text rewrite
    }
    // the compact set rotates a text (a hugging box re-lays its glyphs out per frame and is placed by its rest law, not a frozen box) and a rect
    // at the END of the deck, so the cues above keep their numbers
    if (compact) for (const k of ["text", "rect"]) b.change(s, b.beat(s), k, { rotation: 35 });
    // an anagram rewrite (WP 2.5: a new text Change is authored with letters travel and roll leftovers), last so the cues above keep their numbers
    b.add(s, el("text", "anagram", 40, 318, { text: "LISTEN", fontSize: 28 }));
    b.change(s, b.beat(s), "anagram", { text: "SILENT" });
    // a stem edit (Microscope -> Microscopy: the changed letters ride the word's glide and roll in place), after it so the cues above keep their numbers
    b.add(s, el("text", "stem", 300, 318, { text: "Microscope images", fontSize: 28, sizing: "fixed", width: 330, height: 40 }));
    b.change(s, b.beat(s), "stem", { text: "Microscopy images" });
    // a rewrite that also MOVES its box (the wrapper rides a layer for the flight while the spans stay in place inside it)
    b.add(s, el("text", "mv", 40, 262, { text: "Moving words here", fontSize: 24, sizing: "fixed", width: 250, height: 34 }));
    b.change(s, b.beat(s), "mv", { text: "Words moving there", x: 100.5, y: 281.25 });
    out.push({ name: "change", payload: { deck: b.deck, assets: { img: pngDataUrl() }, assetSizes: { img: { width: 64, height: 48 } } } as SweepPayload });
  }
  {
    // Become (hand-off): shape <-> shape, line -> shape, path -> path, text -> shape, set morph (text -> text)
    const b = new Builder("become"); const s = b.slide("become");
        const pairs: [Kind, Kind][] = compact ? [["rect", "ellipse"], ["line", "star"], ["text", "ellipse"]] : [["rect", "ellipse"], ["rectS", "ellipse"], ["ellipse", "star"], ["line", "star"], ["arrow", "ellipse"], ["path", "star"], ["text", "ellipse"], ["star", "rect"]];
    const used = new Set<string>();
    pairs.forEach(([from, to], i) => {
      const src = `s_${from}_${i}`, dst = `d_${to}_${i}`, [x, y] = CELL[(["text", "rect", "ellipse", "line", "path", "star", "arrow", "rectS", "image"] as Kind[])[i % 9]];
      b.add(s, el(from, src, 40 + (i % 3) * 200, 30 + Math.floor(i / 3) * 110)); used.add(src);
      b.add(s, el(to, dst, 140 + (i % 3) * 200 + 20, 70 + Math.floor(i / 3) * 110, to === "text" ? { text: "Result" } : {})); used.add(dst);
      void x; void y;
      b.become(s, b.beat(s), src, { element: dst });
    });
    b.add(s, el("text", "txtA", 40, 335, { text: "Mycelial growth" })); b.add(s, el("text", "txtB", 320, 335, { text: "growth Mycelial" }));
    b.become(s, b.beat(s), "txtA", { element: "txtB" });
    out.push({ name: "become", payload: { deck: b.deck } });
  }
  {
    // R2 follow-up F3: a hand-off flies at the DEPTH its destination rests at. The flight surface used to be the top of the stack, so a flight that
    // crossed an element ABOVE the destination covered it all the way, and the landing frame (the destination appearing under that element) flipped
    // the paint order of the overlap (the synthetic `become#1-1`: END SNAP 59.8). `dest_under` lands an ellipse under an element drawn after it, `dest_over`
    // lands one OVER an element drawn before it (the control: nothing covers the landing, the flight is the top of the stack either way).
    const b = new Builder("become_depth");
    { const s = b.slide("dest_under"); b.add(s, el("rect", "a", 60, 100, { width: 120, height: 80 }));
      b.add(s, el("ellipse", "b", 330, 100, { width: 160, height: 100 })); b.add(s, el("rectS", "x", 420, 130, { width: 140, height: 90, fill: "#f2f0e5" }));
      b.become(s, b.beat(s), "a", { element: "b" }, { mode: "handoff" }); }
    { const s = b.slide("dest_over"); b.add(s, el("rect", "a", 60, 100, { width: 120, height: 80 }));
      b.add(s, el("rectS", "x", 420, 130, { width: 140, height: 90, fill: "#f2f0e5" })); b.add(s, el("ellipse", "b", 330, 100, { width: 160, height: 100 }));
      b.become(s, b.beat(s), "a", { element: "b" }, { mode: "handoff" }); }
    // the MIRRORED configurations (the destination and the SOURCE sit on different sides of a covering element X): the flight draws at the destination's depth, so
    // when the source was above X (`src_over`) the flight is covered by X from its first moving frame, and when the source was under X (`src_under`) it
    // appears above X: a flip of the overlap's paint order at the START (3,651 on both; the landing is exact). KNOWN_OPEN, with the reason.
    { const s = b.slide("src_over"); b.add(s, { id: "b", type: "ellipse", x: 360, y: 100, width: 160, height: 100, rotation: 0, fill: C.red, stroke: "none", strokeWidth: 0 });
      b.add(s, el("rectS", "x", 40, 80, { width: 520, height: 160, stroke: "none", strokeWidth: 0 })); b.add(s, el("rect", "a", 60, 100, { width: 120, height: 80, cornerRadius: 0 }));
      b.become(s, b.beat(s), "a", { element: "b" }, { mode: "handoff" }); }
    { const s = b.slide("src_under"); b.add(s, el("rect", "a", 60, 100, { width: 120, height: 80, cornerRadius: 0 }));
      b.add(s, el("rectS", "x", 40, 80, { width: 520, height: 160, stroke: "none", strokeWidth: 0 })); b.add(s, { id: "b", type: "ellipse", x: 360, y: 100, width: 160, height: 100, rotation: 0, fill: C.red, stroke: "none", strokeWidth: 0 });
      b.become(s, b.beat(s), "a", { element: "b" }, { mode: "handoff" }); }
    out.push({ name: "become_depth", payload: { deck: b.deck } });
  }
  {
    // The Release 1 review deck's two hardest hand-offs, authored the way that deck is (a state Become, mode "consume"): a THICK-stroked
    // line and arrow becoming an ellipse and a rect (slide 11), and a 12 px stroked, unfilled rect becoming an ellipse (slide 13). Their first
    // frame stepped 20 to 30 stage px^2 on BOTH domains until R2 follow-up F1 (the stroke band, the trimmed arrow body, the stage's ellipse path).
    const b = new Builder("become_stroked");
    const l = b.slide("line_shape");
    b.add(l, el("line", "l1", 60, 180, { width: 200, height: 10, x1: 0, y1: 5, x2: 200, y2: 5, stroke: C.blueD, strokeWidth: 6 }));
    b.add(l, el("arrow", "l2", 360, 180, { width: 220, height: 10, x1: 0, y1: 5, x2: 220, y2: 5, stroke: C.redD, strokeWidth: 6 }));
    { const beat = b.beat(l);
      b.become(l, beat, "l1", { element: "e1" }, { mode: "consume" }, { state: { type: "ellipse", x: 90, y: 110, width: 140, height: 140, stroke: C.blueD, strokeWidth: 6, fill: C.blue } });
      b.become(l, beat, "l2", { element: "r2" }, { mode: "consume" }, { state: { type: "rect", x: 380, y: 120, width: 180, height: 120, stroke: C.redD, strokeWidth: 6, fill: C.red, cornerRadius: 0 } }); }
    const c = b.slide("corners");
    b.add(c, el("rectS", "r1", 200, 110, { width: 240, height: 160, fill: "none", stroke: C.ink, strokeWidth: 12 }));
    b.become(c, b.beat(c), "r1", { element: "e3" }, { mode: "consume" }, { state: { type: "ellipse", x: 220, y: 100, width: 200, height: 180, fill: "none", stroke: C.ink, strokeWidth: 12 } });
    out.push({ name: "become_stroked", payload: { deck: b.deck } });
  }
  {
    // R2 follow-up F1 (geometry): hand-offs between ROUND shapes. The flight draws the stroke law (the path stroker), and the stage draws a resting
    // ellipse as the path of its outline (render.ts stageMarkup), so both ends are one rasteriser: a lone dot, a dot at fractional coordinates, a dot
    // that grows, a thick ring, and six dots at once (the per-dot raster noise adds up: 8.6 stage px^2 on the GPU with the oval primitive, 0.6 now).
    const b = new Builder("handoff_round");
    const dot = (s: string, id: string, cx: number, cy: number, r: number, fill: string, sw = 2) => b.add(s, { id, type: "ellipse", x: cx - r, y: cy - r, width: 2 * r, height: 2 * r, rotation: 0, fill, stroke: C.ink, strokeWidth: sw });
    const ho = (s: string, a: string, to: string) => b.become(s, b.beat(s), a, { element: to }, { mode: "handoff" });
    { const s = b.slide("dot_int"); dot(s, "a", 140, 70, 18, C.blue); dot(s, "b", 480, 250, 18, C.red); ho(s, "a", "b"); }
    { const s = b.slide("dot_frac"); dot(s, "a", 85.3, 55.6, 15, C.red); dot(s, "b", 470.7, 240.2, 15, C.green); ho(s, "a", "b"); }
    { const s = b.slide("dot_grow"); dot(s, "a", 140, 70, 15, C.blue); dot(s, "b", 420, 200, 60, C.orange, 3); ho(s, "a", "b"); }
    { const s = b.slide("ring_ring"); dot(s, "a", 180, 180, 60, "none", 12); dot(s, "b", 460, 180, 90, "none", 12); ho(s, "a", "b"); }
    { const s = b.slide("six_dots"); for (let i = 0; i < 6; i++) { dot(s, `a${i}`, 70 + i * 95, 60 + (i % 2) * 30, 12, C.blue); dot(s, `b${i}`, 90 + i * 85, 280 - (i % 3) * 22, 12, C.red); } const beat = b.beat(s); for (let i = 0; i < 6; i++) b.become(s, beat, `a${i}`, { element: `b${i}` }, { mode: "handoff" }); }
    out.push({ name: "handoff_round", payload: { deck: b.deck } });
  }
  {
    // R2 follow-up F1: stroked shapes with CORNERS become other shapes (the stroke band: outline.ts planStrokeBand). A triangle path (round join) and a
    // rect (mitre) become circles, a round-capped arrow becomes a circle (its body ends inside the head), a butt-capped line becomes a rect, and the
    // same arrow is handed off to the circle (the hand-off driver's band and trimmed body).
    const b = new Builder("become_corners");
    const tri = [{ x: 100, y: 0, type: "corner" }, { x: 200, y: 200, type: "corner" }, { x: 0, y: 200, type: "corner" }];
    const circle = (id: string, o: Record<string, unknown> = {}) => b.add(b.deck.slides[b.deck.slides.length - 1].id, { id, type: "ellipse", x: 220, y: 80, width: 200, height: 200, rotation: 0, fill: C.red, stroke: C.redD, strokeWidth: 6, ...o });
    { const s = b.slide("tri_circle"); b.add(s, { id: "a", type: "path", x: 220, y: 80, width: 200, height: 200, rotation: 0, nodes: tri, d: pathD(tri as never, true), closed: true, fill: C.blue, stroke: C.blueD, strokeWidth: 6, cap: "round" }); circle("b");
      b.become(s, b.beat(s), "a", { element: "b" }, { mode: "consume" }, { state: { type: "ellipse", fill: C.red, stroke: C.redD, strokeWidth: 6 } }); }
    { const s = b.slide("rect_circle"); b.add(s, el("rect", "a", 220, 80, { width: 200, height: 200, fill: C.blue, stroke: C.blueD, strokeWidth: 6 })); circle("b");
      b.become(s, b.beat(s), "a", { element: "b" }, { mode: "consume" }, { state: { type: "ellipse", fill: C.red, stroke: C.redD, strokeWidth: 6 } }); }
    { const s = b.slide("arrow_circle"); b.add(s, el("arrow", "a", 140, 180, { width: 360, height: 0, x1: 0, y1: 0, x2: 360, y2: 0, stroke: C.blueD, strokeWidth: 6 })); circle("b", { x: 220, y: 80 });
      b.become(s, b.beat(s), "a", { element: "b" }, { mode: "consume" }, { state: { type: "ellipse", x: 220, y: 80, width: 200, height: 200, fill: C.red, stroke: C.redD, strokeWidth: 4 } }); }
    { const s = b.slide("arrow_circle_ho"); b.add(s, el("arrow", "a", 140, 180, { width: 360, height: 0, x1: 0, y1: 0, x2: 360, y2: 0, stroke: C.blueD, strokeWidth: 6 })); circle("b", { strokeWidth: 4 });
      b.become(s, b.beat(s), "a", { element: "b" }, { mode: "handoff" }); }
    { const s = b.slide("butt_line_rect"); b.add(s, el("line", "a", 60, 180, { width: 200, height: 10, x1: 0, y1: 5, x2: 200, y2: 5, stroke: C.blueD, strokeWidth: 8, cap: "butt" })); b.add(s, el("rect", "b", 330, 110, { width: 200, height: 140, fill: C.red, stroke: C.redD, strokeWidth: 8 }));
      b.become(s, b.beat(s), "a", { element: "b" }, { mode: "handoff" }); }
    // the REVERSE direction on a thick ring (round -> corners: the same band-vs-stroker seam as the 12 px landing of become_stroked/corners, at the START),
    // and a translucent stroke over a translucent fill (the band and the fill body composite as two nodes on the GPU)
    { const s = b.slide("ell_rect"); b.add(s, { id: "a", type: "ellipse", x: 220, y: 90, width: 200, height: 180, rotation: 0, fill: "none", stroke: C.ink, strokeWidth: 12 }); b.add(s, el("rect", "b", 220, 90, { width: 200, height: 180, fill: "none", stroke: C.ink, strokeWidth: 12, cornerRadius: 0 }));
      b.become(s, b.beat(s), "a", { element: "b" }, { mode: "consume" }, { state: { type: "rect", x: 220, y: 90, width: 200, height: 180, fill: "none", stroke: C.ink, strokeWidth: 12, cornerRadius: 0 } }); }
    { const s = b.slide("ell_rect_ho"); b.add(s, { id: "a", type: "ellipse", x: 60, y: 90, width: 200, height: 180, rotation: 0, fill: "none", stroke: C.ink, strokeWidth: 12 }); b.add(s, el("rect", "b", 380, 90, { width: 200, height: 180, fill: "none", stroke: C.ink, strokeWidth: 12, cornerRadius: 0 }));
      b.become(s, b.beat(s), "a", { element: "b" }, { mode: "handoff" }); }
    // the REVERSE of line -> shape: a rect becomes a butt-capped line (the other half of the hairpin stadium; 8.9 seek / 9.5 GPU at the start before F3)
    { const s = b.slide("rect_line"); b.add(s, el("rect", "a", 100, 110, { width: 200, height: 140, fill: C.blue, stroke: C.blueD, strokeWidth: 8 })); b.add(s, el("line", "b", 340, 180, { width: 200, height: 10, x1: 0, y1: 5, x2: 200, y2: 5, stroke: C.redD, strokeWidth: 8, cap: "butt" }));
      b.become(s, b.beat(s), "a", { element: "b" }, { mode: "handoff" }); }
    // ... into a ROUND-capped line, and the forward direction from one: the hairpin tips carry the line's own round join (cornerJoinOf), so the round caps do not appear at
    // the landing (END SNAP 18.4 before F3) and a round-capped line does not start from square tips
    { const s = b.slide("rect_line_round"); b.add(s, el("rect", "a", 100, 110, { width: 200, height: 140, fill: C.blue, stroke: C.blueD, strokeWidth: 8 })); b.add(s, el("line", "b", 340, 180, { width: 200, height: 10, x1: 0, y1: 5, x2: 200, y2: 5, stroke: C.redD, strokeWidth: 8, cap: "round" }));
      b.become(s, b.beat(s), "a", { element: "b" }, { mode: "handoff" }); }
    { const s = b.slide("line_rect_round"); b.add(s, el("line", "a", 100, 175, { width: 200, height: 10, x1: 0, y1: 5, x2: 200, y2: 5, stroke: C.blueD, strokeWidth: 8, cap: "round" })); b.add(s, el("rect", "b", 340, 110, { width: 200, height: 140, fill: C.red, stroke: C.redD, strokeWidth: 8 }));
      b.become(s, b.beat(s), "a", { element: "b" }, { mode: "handoff" }); }
    { const s = b.slide("rect_line_consume"); b.add(s, el("rect", "a", 100, 110, { width: 200, height: 140, fill: C.blue, stroke: C.blueD, strokeWidth: 8 }));
      b.become(s, b.beat(s), "a", { element: "b" }, { mode: "consume" }, { state: { type: "line", x: 100, y: 175, width: 200, height: 10, x1: 0, y1: 5, x2: 200, y2: 5, stroke: C.redD, strokeWidth: 8, cap: "butt" } }); }
    // a CIRCLE <-> its inscribed DIAMOND (a rect turned 45 degrees whose corners sit on the circle's four points): the anchors coincide and the whole
    // change lives in the bezier handles (round on the circle, none on the diamond), so a hand-over distance that read anchors alone stayed on A until
    // an anchor finally moved and then jumped to the flight (START POP 6.6 / END SNAP 6.6)
    { const R = 100, side = R * Math.SQRT2, cx = 300, cy = 180;
      { const s = b.slide("circ_diamond_ho"); b.add(s, { id: "a", type: "ellipse", x: cx - R, y: cy - R, width: 2 * R, height: 2 * R, rotation: 0, fill: "none", stroke: C.ink, strokeWidth: 12 });
        b.add(s, el("rect", "b", cx - side / 2, cy - side / 2, { width: side, height: side, rotation: 45, fill: "none", stroke: C.ink, strokeWidth: 12, cornerRadius: 0 }));
        b.become(s, b.beat(s), "a", { element: "b" }, { mode: "handoff" }); }
      { const s = b.slide("diamond_circ_ho"); b.add(s, el("rect", "a", cx - side / 2, cy - side / 2, { width: side, height: side, rotation: 45, fill: "none", stroke: C.ink, strokeWidth: 12, cornerRadius: 0 }));
        b.add(s, { id: "b", type: "ellipse", x: cx - R, y: cy - R, width: 2 * R, height: 2 * R, rotation: 0, fill: "none", stroke: C.ink, strokeWidth: 12 });
        b.become(s, b.beat(s), "a", { element: "b" }, { mode: "handoff" }); } }
    { const s = b.slide("translucent"); b.add(s, el("rect", "a", 220, 90, { width: 200, height: 180, fill: C.blue, fillOpacity: 0.5, stroke: C.ink, strokeOpacity: 0.5, strokeWidth: 14 })); circle("b", { x: 220, y: 90, width: 200, height: 180, fill: C.red, fillOpacity: 0.5, stroke: C.ink, strokeOpacity: 0.5, strokeWidth: 14 });
      b.become(s, b.beat(s), "a", { element: "b" }, { mode: "consume" }, { state: { type: "ellipse", x: 220, y: 90, width: 200, height: 180, fill: C.red, fillOpacity: 0.5, stroke: C.ink, strokeOpacity: 0.5, strokeWidth: 14 } }); }
    out.push({ name: "become_corners", payload: { deck: b.deck } });
  }
  {
    // R2 follow-up F1: a Change of cornerRadius with REAL element data (the sharp `nodes` skeleton plus the rounded `d` the app writes). Lane S measured
    // a 222-px^2 start pop on a path whose `d` was hand-written sharp while its cornerRadius said 20 (an element the app never produces): with the
    // data it writes, rounding a corner and sharpening it are smooth from the first frame to the last (this deck pins that).
    const b = new Builder("corner_radius");
    const sq = [{ x: 0, y: 0, type: "corner" }, { x: 140, y: 0, type: "corner" }, { x: 140, y: 140, type: "corner" }, { x: 0, y: 140, type: "corner" }];
    const pathEl = (s: string, id: string, radius: number) => b.add(s, { id, type: "path", x: 250, y: 110, width: 140, height: 140, rotation: 0, nodes: sq, d: pathD(sq as never, true, radius), closed: true, cornerRadius: radius, fill: C.blue + "99", stroke: C.blue, strokeWidth: 4 });
    { const s = b.slide("path_20_0"); pathEl(s, "a", 20); b.change(s, b.beat(s), "a", { cornerRadius: 0 }); }
    { const s = b.slide("path_0_20"); pathEl(s, "a", 0); b.change(s, b.beat(s), "a", { cornerRadius: 20 }); }
    { const s = b.slide("rect_20_0"); b.add(s, el("rect", "a", 250, 110, { width: 140, height: 140, fill: C.blue + "99", stroke: C.blue, strokeWidth: 4, cornerRadius: 20 })); b.change(s, b.beat(s), "a", { cornerRadius: 0 }); }
    out.push({ name: "corner_radius", payload: { deck: b.deck } });
  }
  {
    // R2 follow-up F1: compound paths (outline + hole). Lane S's lerpCompoundD pairs the subpaths; a hole with no partner collapses at its own centroid and
    // is dropped at its own end, so the hole opens and closes in place with nothing popping (a 4 px stroke: the dot a collapsed stroked hole leaves is
    // 0.24 x stroke^2 = 3.8 stage px^2, under the floor; at 12 px it is 34.8 and is an inherent trade-off, see the report).
    const b = new Builder("compound");
    const D = (hx: number, hw: number) => `M 0 0 L 180 0 L 180 180 L 0 180 Z M ${hx} 40 L ${hx} 140 L ${hx + hw} 140 L ${hx + hw} 40 Z`, SQ = "M 0 0 L 180 0 L 180 180 L 0 180 Z";
    const pathEl = (s: string, id: string, d: string, fill: string, stroke: string) => b.add(s, { id, type: "path", x: 230, y: 90, width: 180, height: 180, rotation: 0, d, fill, stroke, strokeWidth: 4, closed: true, cap: "round" });
    { const s = b.slide("hole_moves"); pathEl(s, "a", D(40, 60), C.blue + "cc", C.blue); b.change(s, b.beat(s), "a", { d: D(90, 50), fill: C.red + "cc", stroke: C.red }); }
    { const s = b.slide("hole_fills"); pathEl(s, "a", D(40, 100), C.blue + "cc", C.blue); b.change(s, b.beat(s), "a", { d: SQ, fill: C.red + "cc", stroke: C.red }); }
    { const s = b.slide("hole_opens"); pathEl(s, "a", SQ, C.blue + "cc", C.blue); b.change(s, b.beat(s), "a", { d: D(40, 100), fill: C.red + "cc", stroke: C.red }); }
    // a compound path that BECOMES a ring: the 1-1 driver closes its hole at the hole's own centroid while the outer ring morphs; the hand-off driver
    // (which flies one outline per element) takes a compound path by its box. Both were a start pop of ~2,000 stage px^2 (a flattened, bridged chain).
    const ring = (s: string) => b.add(s, { id: "b", type: "ellipse", x: 230, y: 90, width: 180, height: 180, rotation: 0, fill: C.red + "cc", stroke: C.red, strokeWidth: 4 });
    { const s = b.slide("donut_circle"); pathEl(s, "a", D(40, 100), C.blue + "cc", C.blue); ring(s); b.become(s, b.beat(s), "a", { element: "b" }, { mode: "consume" }, { state: { type: "ellipse", fill: C.red + "cc", stroke: C.red, strokeWidth: 4 } }); }
    { const s = b.slide("donut_circle_ho"); pathEl(s, "a", D(40, 100), C.blue + "cc", C.blue); ring(s); b.become(s, b.beat(s), "a", { element: "b" }, { mode: "handoff" }); }
    // an extra subpath that winds WITH its outline rests as solid (Flux fills nonzero only): no hole may open as the Become runs
    { const s = b.slide("donut_same_wind"); pathEl(s, "a", "M 0 0 L 180 0 L 180 180 L 0 180 Z M 40 40 L 140 40 L 140 140 L 40 140 Z", C.blue + "cc", C.blue); ring(s); b.become(s, b.beat(s), "a", { element: "b" }, { mode: "consume" }, { state: { type: "ellipse", fill: C.red + "cc", stroke: C.red, strokeWidth: 4 } }); }
    out.push({ name: "compound", payload: { deck: b.deck } });
  }
  {
    // R2 follow-up F1: flights that land on a SET of ellipses (lane S's decks: a rect split into three ellipses, six dots joining one ring, three dots into one rect)
    const b = new Builder("set_flights");
    { const s = b.slide("rect_3ellipses"); b.add(s, el("rect", "r", 120, 60, { width: 400, height: 80, fill: "#e6e4d9", stroke: C.ink, strokeWidth: 3, cornerRadius: 0 }));
      [140, 320, 500].forEach((cx, i) => b.add(s, { id: "e" + i, type: "ellipse", x: cx - 30, y: 230, width: 60, height: 60, rotation: 0, fill: [C.blue, C.orange, C.green][i], stroke: C.ink, strokeWidth: 2 }));
      b.become(s, b.beat(s), "r", { element: "e0", members: [{ element: "e0" }, { element: "e1" }, { element: "e2" }] }, { mode: "handoff" }); }
    { const s = b.slide("six_ring"); for (let i = 0; i < 6; i++) b.add(s, { id: "d" + i, type: "ellipse", x: 70 + i * 90, y: 40, width: 30, height: 30, rotation: 0, fill: [C.blue, C.orange, C.green, C.red, C.blue, C.orange][i], stroke: C.ink, strokeWidth: 2 });
      b.add(s, { id: "ring", type: "ellipse", x: 220, y: 150, width: 200, height: 170, rotation: 0, fill: "none", stroke: C.ink, strokeWidth: 5 });
      const beat = b.beat(s); for (let i = 0; i < 6; i++) b.become(s, beat, "d" + i, { element: "ring" }, { mode: "handoff" }); }
    out.push({ name: "set_flights", payload: { deck: b.deck } });
  }
  {
    const b = new Builder("ghost"); const s = b.slide("ghost");
    const gk: Kind[] = compact ? ["rect", "text"] : ["rect", "text", "star"];
    for (const k of gk) b.add(s, el(k, k, ...CELL[k]));
    for (const k of gk) {
      const beat = b.beat(s);
      addGhostTransform(b.deck, s, beat.id, k, { count: 2, original: "stay", duration: 1200, states: [{ x: CELL[k][0] + 120, y: CELL[k][1] + 30 }, { x: CELL[k][0] + 60, y: CELL[k][1] + 70, rotation: 20 }] });
    }
    out.push({ name: "ghost", payload: { deck: b.deck } });
  }
  {
    // springs and overshooting curves: the landing must still converge
    const b = new Builder("springs"); const s = b.slide("springs");
    const ks: Kind[] = compact ? ["rect", "text"] : ["rect", "text", "star", "path"];
    for (const k of ks) b.add(s, el(k, k, ...CELL[k], k === "text" ? { sizing: "fixed", width: 150, height: 30 } : {}));
    for (const k of ks) {
      b.change(s, b.beat(s), k, { x: CELL[k][0] + 90.3, y: CELL[k][1] + 22.6 }, { curve: { kind: "spring", bounce: 0.35 }, easing: undefined });
      b.change(s, b.beat(s), k, { width: (el(k, k, 0, 0).width as number) * 1.3, height: (el(k, k, 0, 0).height as number) * 1.3 }, { curve: { kind: "bezier", p: [0.34, 1.56, 0.64, 1] } });
    }
    for (const k of (compact ? ["rect"] : ["rect", "ellipse"]) as Kind[]) { b.add(s, el(k, `${k}2`, 300, 280)); b.anim(s, b.beat(s), `${k}2`, "popIn", { curve: { kind: "spring", bounce: 0.35 } }); }
    out.push({ name: "springs", payload: { deck: b.deck } });
  }
  {
    // camera: pan only, zoom only, both (a text and a shape under it)
    const b = new Builder("camera"); const s = b.slide("camera");
    for (const k of ["text", "rect", "line", "star"] as Kind[]) b.add(s, el(k, k, ...CELL[k]));
    const cam = (to: Record<string, unknown>) => { const beat = b.beat(s); b.anim(s, beat, "@camera", "camera", { to } as Partial<Track>); };
    cam({ x: 420, y: 180, zoom: 1 }); cam({ x: 420, y: 180, zoom: 2 }); cam({ x: 200, y: 120, zoom: 2.5 });
    // a 4x zoom toward the stage corner: the longest travel (the early re-bake is taken at the landing pose whatever the distance), and
    // ONE cue with two camera flights (each flight early-bakes; the later one lands on its own raster, not the first one's)
    cam({ x: 60, y: 50, zoom: 4 });
    { const beat = b.beat(s); b.anim(s, beat, "@camera", "camera", { to: { x: 480, y: 300, zoom: 2 } } as Partial<Track>); b.anim(s, beat, "@camera", "camera", { to: { x: 150, y: 90, zoom: 3 }, start: 1000 } as Partial<Track>); }
    if (!compact) cam({ x: 320, y: 180, zoom: 1 });
    out.push({ name: "camera", payload: { deck: b.deck } });
  }
  {
    // chains: after-previous (separate cues) and with-previous (one cue), delays, concurrent enters of different presets
    const b = new Builder("chains"); const s = b.slide("chains");
    for (const k of ["text", "rect", "ellipse", "line"] as Kind[]) b.add(s, el(k, k, ...CELL[k]));
    b.anim(s, b.beat(s), "text", "fadeRise");
    b.anim(s, b.beat(s, { advance: "auto" }), "rect", "popIn");
    b.anim(s, b.beat(s, { advance: "auto" }), "line", "drawOn");
    const w1 = b.beat(s); b.anim(s, w1, "ellipse", "fade"); const w2 = b.beat(s, { advance: "with-prev" }); b.anim(s, w2, "text", "highlight", { start: 120 });
    const w3 = b.beat(s, { advance: "with-prev" }); b.anim(s, w3, "rect", "fadeOut", { start: 300 });
    out.push({ name: "chains", payload: { deck: b.deck } });
  }
  {
    // a click during a moving step: the cue finishes on its warped clock, then the click's own cue plays (timing.ts settleTime)
    const b = new Builder("interrupt"); const s = b.slide("int");
    for (const k of ["rect", "text"] as Kind[]) b.add(s, el(k, k, ...CELL[k]));
    b.change(s, b.beat(s), "rect", { x: CELL.rect[0] + 140.5, y: CELL.rect[1] + 31.25 });
    b.change(s, b.beat(s), "rect", { x: CELL.rect[0] + 20, y: CELL.rect[1] + 90.5 });
    b.anim(s, b.beat(s), "text", "fadeRise");
    out.push({ name: "interrupt", payload: { deck: b.deck } });
  }
  if (!compact) {
    // old-pace decks as made: explicit classic timing must keep playing and still start/land clean
    const b = new Builder("classic"); const s = b.slide("classic");
    const ks: Kind[] = ["text", "rect", "ellipse", "line", "path", "star"];
    for (const k of ks) b.add(s, el(k, k, ...CELL[k]));
    for (const [k, p] of [["text", "fadeRise"], ["rect", "popIn"], ["ellipse", "fade"], ["line", "drawOn"], ["path", "drawOn"], ["star", "drawOn"]] as [Kind, string][]) b.old(s, b.beat(s), k, p, p === "drawOn" ? 600 : 380);
    out.push({ name: "classic", payload: { deck: b.deck } });
  }
  void plots;
  return out;
}

export async function syntheticCorpus(compact: boolean): Promise<CorpusDeck[]> {
  const decks: CorpusDeck[] = [];
  const png = { assets: { img: pngDataUrl() }, assetSizes: { img: { width: 64, height: 48 } } };
  const grid = async (name: string, fill: (b: Builder) => void) => { const b = new Builder(name); fill(b); decks.push({ name, payload: { deck: b.deck, ...png } as SweepPayload }); };
  // compact: every preset on the kinds it is meant for and on one text, one filled and one stroked shape
  const kindsFor = (preset: string): readonly Kind[] => {
    if (!compact) return KINDS;
    switch (preset) {
      case "drawOn": case "drawOff": return ["rectS", "ellipse", "line", "arrow", "path", "star", "text"];
      case "writeOn": case "wipeOut": return ["text", "rect", "image"];
      case "growBaseline": return ["rect", "text"];
      default: return ["text", "rect", "star", "arrow", "image"];
    }
  };
  for (const p of [...ENTER, ...EXIT, ...EMPH]) await grid(`preset_${p}`, b => presetSlide(b, p, kindsFor(p)));
  for (const p of Object.keys(LEGACY)) await grid(`preset_${p}`, b => presetSlide(b, p, compact ? ["text", "rect", "star"] : KINDS));
  await grid("preset_countUp", b => {
    const s = b.slide("p_countUp"); b.add(s, el("text", "n", 60, 150, { text: "1,234", fontSize: 40 }));
    b.anim(s, b.beat(s), "n", "countUp", { params: { from: 0 } });
  });
  // a stagger over several whole elements (selection) and with a non-default child
  await grid("preset_stagger_many", b => {
    const s = b.slide("p_many"); const ks: Kind[] = ["rect", "ellipse", "star", "text"];
    ks.forEach((k, i) => b.add(s, el(k, `m${i}`, 40 + i * 140, 140)));
    const beat = b.beat(s); ks.forEach((_, i) => b.anim(s, beat, `m${i}`, "fadeRise", { start: i * 150 }));
  });
  // the draw seam (Release 2 residual): a closed stroke dashed from a corner landed with that corner closing in one step (a 12 px rect:
  // LANDING STEP 31.6 on the GPU). Thick strokes, a bare and a filled rect, a mitred closed path; on and off. GPU-only: in PLAY.
  await grid("draw_seam", b => {
    const s = b.slide("seam");
    b.add(s, el("rectS", "box", 40, 120, { width: 150, height: 100, fill: "none", strokeWidth: 12 }));
    b.add(s, el("rectS", "card", 240, 120, { width: 150, height: 100, strokeWidth: 12 }));
    b.add(s, el("path", "frame", 440, 120, { width: 150, height: 100, d: "M0 0 L 150 0 L 150 100 L 0 100 Z", closed: true, cap: "butt", strokeWidth: 12 }));
    for (const id of ["box", "card", "frame"]) b.anim(s, b.beat(s), id, "drawOn");
    for (const id of ["box", "card", "frame"]) b.anim(s, b.beat(s), id, "drawOff");
  });
  decks.push(...await transformDecks(compact), ...await plotDecks(compact));
  return decks;
}

export async function rigCorpus(): Promise<CorpusDeck[]> {
  const out: CorpusDeck[] = [];
  const rig = async (dir: string, file: string, plots?: string) => {
    const f = path.join(NOTES, "scratch", dir, "decks", file);
    const deck = JSON.parse(await fs.readFile(f, "utf8"));
    const payload: SweepPayload = { deck };
    if (plots) {
      const map = JSON.parse(await fs.readFile(path.join(NOTES, "scratch", dir, "rig", plots), "utf8")) as Record<string, { svg: string; manifest: string }>;
      payload.plots = Object.fromEntries(await Promise.all(Object.entries(map).map(async ([id, v]) => [id, { svg: await fs.readFile(v.svg, "utf8"), manifest: JSON.parse(await fs.readFile(v.manifest, "utf8")) }])));
    }
    out.push({ name: `${dir.replace("-final", "")}_${file.replace(/\.deck\.json$/, "")}`, payload });
  };
  const tryRig = async (dir: string, file: string, plots?: string) => { try { await rig(dir, file, plots); } catch { /* the rig decks live outside the repo: skip the ones this machine lacks */ } };
  await tryRig("T3-final", "t3.deck.json", "plots.json");
  await tryRig("T3-final", "write.deck.json", "plots.json");
  await tryRig("T4-final", "t4.deck.json");
  await tryRig("T5-final", "t5_tests.deck.json");
  await tryRig("T6-final", "t6.deck.json", "plots.json");
  await tryRig("W-final", "w_tests.deck.json");
  return out;
}

export async function corpus(kind: "synthetic" | "compact" | "rig" | "all"): Promise<CorpusDeck[]> {
  const out: CorpusDeck[] = [];
  if (kind === "compact") out.push(...await syntheticCorpus(true));
  if (kind === "synthetic" || kind === "all") out.push(...await syntheticCorpus(false));
  if (kind === "rig" || kind === "all") out.push(...await rigCorpus());
  return out;
}
