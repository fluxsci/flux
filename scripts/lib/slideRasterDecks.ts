// Fixture decks for the raster gate (verify-slide-raster-electron.cjs): authored with the repo's own pure ops, every timing explicit so
// the pins are independent of the authoring pace. Stage 640x360; Gelasio is the one font the capture runtime embeds.
import { createDeck, addSlide, addElement, addBeat, setAnimation, becomeTransform } from "../../src/lib/slide/ops";
import type { Deck, Slide } from "../../src/lib/slide/types";

export type Pose = { x: number; y: number; zoom: number };
const text = (id: string, x: number, y: number, width: number, t: string, size: number, color = "#100f0f") =>
  ({ type: "text" as const, id, x, y, width, height: size * 1.4, rotation: 0, text: t, fontFamily: "Gelasio", fontSize: size, fontWeight: 400, fontStyle: "normal" as const, align: "left" as const, color, sizing: "fixed" as const });
function blank(id: string, title: string): { deck: Deck; add: (slideId: string) => Slide } {
  const deck = createDeck({ id, title, withTitleSlide: false });
  deck.stage = { width: 640, height: 360 }; deck.background = "#fffcf0"; deck.defaults.transition = "none";
  return { deck, add: (slideId) => addSlide(deck, { id: slideId, layout: "blank" }) };
}

/** Thin strokes + small text so a resampled bitmap is unmistakable. */
function scene(deck: Deck, s: Slide, camera?: Pose): Slide {
  addElement(deck, s.id, text("t1", 40, 40, 300, "Sharp text 12345", 22));
  addElement(deck, s.id, text("t2", 330, 250, 300, "Camera zoom target", 14, "#205ea6"));
  addElement(deck, s.id, text("t3", 60, 280, 300, "fine print: the quick brown fox", 9));
  addElement(deck, s.id, { type: "ellipse", id: "ring", x: 330, y: 60, width: 120, height: 120, rotation: 0, fill: "none", stroke: "#af3029", strokeWidth: 1 });
  addElement(deck, s.id, { type: "path", id: "zig", x: 40, y: 100, width: 220, height: 120, rotation: 0, d: "M 0 100 L 40 10 L 80 100 L 120 10 L 160 100 L 200 10", fill: "none", stroke: "#100f0f", strokeWidth: 1.5, closed: false, cap: "butt" });
  addElement(deck, s.id, { type: "rect", id: "box", x: 330, y: 200, width: 120, height: 40, rotation: 0, fill: "#f2f0e5", stroke: "#24837b", strokeWidth: 1, cornerRadius: 0 });
  for (let i = 0; i < 8; i++) addElement(deck, s.id, { type: "path", id: `g${i}`, x: 480, y: 60 + i * 14, width: 120, height: 2, rotation: 0, d: "M 0 1 L 120 1", fill: "none", stroke: "#b7b5ac", strokeWidth: 0.5, closed: false, cap: "butt" });
  if (camera) s.camera = camera;
  return s;
}
const cameraTrack = (deck: Deck, s: Slide, beat: string, id: string, to: Pose, duration = 900) => {
  const b = addBeat(deck, s.id, { id: beat });
  if (!b || !setAnimation(deck, s.id, b.id, { id, target: "@camera", preset: "camera", to, duration, easing: "smooth" })) throw new Error("camera track was refused");
};

export const ZOOM_POSE: Pose = { x: 390, y: 140, zoom: 2.5 };
export const ZOOM4_POSE: Pose = { x: 390, y: 140, zoom: 4 };
export const ZOOM10_POSE: Pose = { x: 560, y: 100, zoom: 10 };
export const PAN_FROM: Pose = { x: 260, y: 150, zoom: 2 };
export const PAN_POSE: Pose = { x: 420, y: 150, zoom: 3 };

/** One slide per camera case: zoom 2.5x / 4x / 10x, a pan then a zoom, a move + zoom in one beat, and a text-only slide that zooms. */
export function cameraDeck(): Deck {
  const { deck, add } = blank("raster-cam", "Raster camera");
  for (const [id, pose] of [["cam_zoom", ZOOM_POSE], ["cam_zoom4", ZOOM4_POSE], ["cam_zoom10", ZOOM10_POSE]] as const) cameraTrack(deck, scene(deck, add(id)), "b1", "cam", pose);
  const pan = scene(deck, add("cam_pan"), PAN_FROM);
  cameraTrack(deck, pan, "b1", "pan", { x: PAN_POSE.x, y: PAN_POSE.y, zoom: PAN_FROM.zoom }); cameraTrack(deck, pan, "b2", "zoom", PAN_POSE);
  // an element flies while the camera zooms in the same beat: capture paints the flight IN PLACE (no promoted layer at the pre-zoom scale)
  const mv = scene(deck, add("cam_move")), mb = addBeat(deck, mv.id, { id: "b1" })!;
  setAnimation(deck, mv.id, mb.id, { id: "cam", target: "@camera", preset: "camera", to: { x: 390, y: 140, zoom: 2 }, duration: 900, easing: "smooth" });
  setAnimation(deck, mv.id, mb.id, { id: "mv", target: "t1", preset: "transform", to: { state: { x: 120, y: 70 } }, duration: 900, easing: "smooth" });
  const txt = add("txt_cam");
  addElement(deck, txt.id, text("t1", 40, 60, 500, "Sharp text 12345 Hamburgefonts", 28)); addElement(deck, txt.id, text("t2", 40, 200, 500, "fine print: the quick brown fox jumps", 11));
  cameraTrack(deck, txt, "b1", "cam", { x: 200, y: 110, zoom: 1.6 });
  return deck;
}
/** The same scene resting at `pose` as its BASE camera: what a fresh render of that pose looks like. */
export function restingDeck(id: string, pose: Pose, kind: "scene" | "text" = "scene"): Deck {
  const { deck, add } = blank(`raster-ref-${id}`, "Raster reference");
  const s = add(id);
  if (kind === "scene") scene(deck, s, pose);
  else { addElement(deck, s.id, text("t1", 40, 60, 500, "Sharp text 12345 Hamburgefonts", 28)); addElement(deck, s.id, text("t2", 40, 200, 500, "fine print: the quick brown fox jumps", 11)); s.camera = pose; }
  return deck;
}

/** Decks with NO camera track: the keeper must never bake for them (their frames stay byte-identical to the pre-keeper renderer). */
export function plainDeck(): Deck {
  const { deck, add } = blank("raster-plain", "Raster plain");
  const move = add("txt_move"), still = add("txt_static");
  for (const s of [move, still]) { addElement(deck, s.id, text("t1", 40, 60, 500, "Sharp text 12345 Hamburgefonts", 28)); addElement(deck, s.id, text("t2", 40, 200, 500, "fine print: the quick brown fox jumps", 11)); }
  const mb = addBeat(deck, move.id, { id: "b1" })!;
  setAnimation(deck, move.id, mb.id, { id: "mv", target: "t1", preset: "transform", to: { state: { x: 120, y: 90 } }, duration: 600, easing: "smooth" });
  const fade = add("faderise_text"); addElement(deck, fade.id, text("tx", 60, 120, 400, "Fade and rise", 32));
  setAnimation(deck, fade.id, addBeat(deck, fade.id, { id: "b1" })!.id, { id: "fr", target: "tx", preset: "fadeRise", duration: 600, easing: "smooth" });
  const draw = add("drawon_curve");
  addElement(deck, draw.id, { type: "path", id: "curve", x: 60, y: 80, width: 480, height: 200, rotation: 0, d: "M 0 180 C 120 0 240 360 480 20", fill: "none", stroke: "#205ea6", strokeWidth: 3, closed: false, cap: "round" });
  setAnimation(deck, draw.id, addBeat(deck, draw.id, { id: "b1" })!.id, { id: "dr", target: "curve", preset: "drawOn", duration: 900, easing: "smooth" });
  const become = add("become_square_circle");
  addElement(deck, become.id, { type: "rect", id: "sq", x: 120, y: 110, width: 140, height: 140, rotation: 0, fill: "#d14d41", stroke: "none", strokeWidth: 0, cornerRadius: 0 });
  addElement(deck, become.id, { type: "ellipse", id: "ci", x: 380, y: 110, width: 140, height: 140, rotation: 0, fill: "#4385be", stroke: "none", strokeWidth: 0 });
  becomeTransform(deck, become.id, addBeat(deck, become.id, { id: "b1" })!.id, "sq", "ci");
  for (const s of [become]) for (const b of s.beats) for (const t of b.tracks) { t.duration = 900; t.easing = "smooth"; }
  return deck;
}

/** A thick-stroked rect that Becomes an ellipse: the rect's miter corners must not pop to round at the layer swap. */
export function joinDeck(): Deck {
  const { deck, add } = blank("raster-join", "Raster join");
  const s = add("rect_to_ellipse");
  addElement(deck, s.id, { type: "rect", id: "a", x: 120, y: 110, width: 140, height: 140, rotation: 0, fill: "none", stroke: "#205ea6", strokeWidth: 12, cornerRadius: 0 });
  addElement(deck, s.id, { type: "ellipse", id: "b", x: 380, y: 110, width: 140, height: 140, rotation: 0, fill: "none", stroke: "#af3029", strokeWidth: 12 });
  becomeTransform(deck, s.id, addBeat(deck, s.id, { id: "b1" })!.id, "a", "b");
  for (const b of s.beats) for (const t of b.tracks) { t.duration = 900; t.easing = "smooth"; }
  return deck;
}

/** The 18 Flexoki swatches the colour gate measures (accents 600 and 400, paper, ink). */
export const FLEXOKI_SWATCHES = ["#af3029", "#bc5215", "#ad8301", "#66800b", "#24837b", "#205ea6", "#5e409d", "#a02f6f", "#d14d41", "#da702c", "#d0a215", "#879a39", "#3aa99f", "#4385be", "#8b7ec8", "#ce5d97", "#fffcf0", "#100f0f"];
export const SWATCH_GRID = { cols: 6, size: 100, gap: 8, x0: 8, y0: 8 };
export function swatchDeck(): Deck {
  const { deck, add } = blank("raster-swatches", "Raster swatches");
  const s = add("swatches"), g = SWATCH_GRID;
  FLEXOKI_SWATCHES.forEach((fill, i) => addElement(deck, s.id, { type: "rect", id: `s${i}`, x: g.x0 + (i % g.cols) * (g.size + g.gap), y: g.y0 + Math.floor(i / g.cols) * (g.size + g.gap), width: g.size, height: g.size, rotation: 0, fill, stroke: "none", strokeWidth: 0, cornerRadius: 0 }));
  return deck;
}
