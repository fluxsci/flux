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
import { authoredFields } from "../../src/lib/slide/presetCatalog";
import type { Deck, Track, TargetRef, BecomeSpec } from "../../src/lib/slide/types";
import type { SweepPayload } from "./slideSettleSweep";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(here, "../fixtures/plots");
const NOTES = path.resolve(here, "../../../../notes/manim_exploration");
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

const ENTER = ["fade", "fadeRise", "popIn", "drawOn", "growBaseline", "stagger", "writeOn"] as const;
const EXIT = ["fadeOut", "popOut", "drawOff", "wipeOut"] as const;
const EMPH = ["highlight", "dim"] as const;
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
    for (const child of compact ? ["fade", "popIn"] : ["fade", "fadeRise", "popIn", "growBaseline"]) {
      const beat = b.beat(s);
      b.anim(s, beat, "pl", "stagger", { selector: { role: "point" }, stagger: { by: "index", from: "start", totalMs: 1200 }, params: { child }, duration: 400 });
    }
    if (!compact) { const beat = b.beat(s); b.anim(s, beat, "pl", "fade", { selector: { role: "point" }, duration: 500 }); }
    out.push({ name: "plot_scatter", payload: { deck: b.deck, plots: { scatter: plots.scatter } } });
    void D;
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
  return out;
}

/** The transform family: Change (move / resize / rotate / recolour / rewrite), Become, Ghost, springs, camera, chains. */
async function transformDecks(compact: boolean): Promise<CorpusDeck[]> {
  const out: CorpusDeck[] = [];
  const plots = { scatter: await readPlot("mpl_scatter"), sine: await readPlot("mpl_sine_waves") };
  {
    const b = new Builder("change"); const s = b.slide("change");
    const kinds: readonly Kind[] = compact ? ["text", "rect", "rectS", "line", "path", "star"] : KINDS;
    for (const k of kinds) b.add(s, el(k, k, ...CELL[k]));
    for (const k of kinds) {
      const [x, y] = CELL[k], bx = x + 33.37, by = y - 11.21;
      b.change(s, b.beat(s), k, { x: bx, y: by });                                  // pure move (rides a compositor layer)
      b.change(s, b.beat(s), k, { x: bx, y: by, width: (el(k, k, 0, 0).width as number) * 1.4, height: (el(k, k, 0, 0).height as number) * 1.4 }); // resize
      if (!compact) b.change(s, b.beat(s), k, { rotation: 35 });                      // rotate
      if (k === "rect" || k === "ellipse" || k === "star") b.change(s, b.beat(s), k, { fill: C.green });  // recolour
      if (k === "text") b.change(s, b.beat(s), k, { text: "Flux 4.2 rewritten" });  // text rewrite
    }
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
  if (!compact) {
    const b = new Builder("ghost"); const s = b.slide("ghost");
    for (const k of ["rect", "text", "star"] as Kind[]) b.add(s, el(k, k, ...CELL[k]));
    for (const k of ["rect", "text", "star"] as Kind[]) {
      const beat = b.beat(s);
      addGhostTransform(b.deck, s, beat.id, k, { count: 2, original: "stay", duration: 1200, states: [{ x: CELL[k][0] + 120, y: CELL[k][1] + 30 }, { x: CELL[k][0] + 60, y: CELL[k][1] + 70, rotation: 20 }] });
    }
    out.push({ name: "ghost", payload: { deck: b.deck } });
  }
  {
    // springs and overshooting curves: the landing must still converge
    const b = new Builder("springs"); const s = b.slide("springs");
    const ks: Kind[] = compact ? ["rect", "text"] : ["rect", "text", "star", "path"];
    for (const k of ks) b.add(s, el(k, k, ...CELL[k]));
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
    cam({ x: 420, y: 180, zoom: 1 }); cam({ x: 420, y: 180, zoom: 2 }); cam({ x: 200, y: 120, zoom: 2.5 }); if (!compact) cam({ x: 320, y: 180, zoom: 1 });
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
