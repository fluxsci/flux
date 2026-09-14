import * as fs from "node:fs/promises";
import path from "node:path";
import { buildScaffoldTree } from "../../src/lib/project/scaffoldTree";
import { createDeck } from "../../src/lib/slide/ops";
import type { Deck } from "../../src/lib/slide/types";

export function videoFixture(): Deck {
  const deck = createDeck({ id: "video-deck", title: "Video verification", withTitleSlide: false });
  deck.stage = { width: 640, height: 360 }; deck.background = "#ffffff"; deck.defaults.transition = "fade";
  deck.slides = [{ id: "motion", name: "Smooth motion", elements: [
    { id: "box", type: "rect", x: 40, y: 80, width: 40, height: 40, rotation: 0, fill: "#ff0000", stroke: "none", strokeWidth: 0, cornerRadius: 0 },
    { id: "dot", type: "ellipse", x: 400, y: 80, width: 40, height: 40, rotation: 0, fill: "#0000ff", stroke: "none", strokeWidth: 0 },
    { id: "label", type: "text", x: 40, y: 200, width: 400, height: 50, rotation: 0, text: "Count 10", fontFamily: "Gelasio", fontSize: 24, fontWeight: 400, fontStyle: "normal", align: "left", color: "#111111", sizing: "fixed" },
  ], beats: [
    { id: "base", tracks: [] },
    { id: "move", tracks: [{ id: "movement", target: "box", preset: "transform", duration: 1000, easing: "linear", to: { state: { x: 240 } } }] },
    { id: "together", advance: "with-prev", tracks: [{ id: "entrance", target: "dot", preset: "fade", duration: 1000, easing: "linear" }] },
    { id: "number", tracks: [{ id: "digits", target: "label", preset: "transform", duration: 500, easing: "linear", to: { state: { text: "Count 30" } } }] },
  ] }, { id: "other", name: "Must not appear", elements: [], background: "#00ff00", beats: [{ id: "base2", tracks: [] }] }];
  return deck;
}
export async function writeVideoFixture(root: string): Promise<void> {
  const tree = buildScaffoldTree({ title: "Video verification" }, videoFixture());
  for (const dir of tree.dirs) await fs.mkdir(path.join(root, dir), { recursive: true });
  for (const [rel, text] of tree.files) { await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true }); await fs.writeFile(path.join(root, rel), text); }
}
if (process.argv[1]?.endsWith("slideVideoFixture.ts") && process.argv[2]) await writeVideoFixture(process.argv[2]);
