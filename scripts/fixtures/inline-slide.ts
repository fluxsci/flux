import { createDeck } from "../../src/lib/slide/ops";
import type { Deck } from "../../src/lib/slide/types";
export function inlineSlideFixture(id = "talk", color = "#4385be"): Deck {
  const deck = createDeck({ id, title: `Evidence ${id}` });
  deck.stage = { width: 640, height: 360 };
  deck.slides = [{ id: "results", name: "Results", notes: "PRIVATE speaker notes /home/private/source", background: "#ffffff", elements: [
    { id: "title", type: "text", x: 28, y: 24, width: 580, height: 42, rotation: 0, text: "Signals and evidence", fontFamily: "Gelasio", fontSize: 26, fontWeight: 400, fontStyle: "normal", align: "left", color: "#222222" },
    { id: "signal", type: "rect", x: 42, y: 124, width: 140, height: 136, rotation: 0, fill: color, stroke: "none", strokeWidth: 0, cornerRadius: 0 },
    { id: "plot", type: "plot", x: 262, y: 100, width: 320, height: 200, rotation: 0, assetId: "shared", source: { svgPath: `slides/${id}/assets/shared.svg`, frozen: true } },
  ], beats: [
    { id: "zero", label: "Initial", tracks: [] },
    { id: "reveal", label: "Signal", advance: "auto", autoDelayMs: 10, tracks: [{ id: "fade", target: "signal", preset: "fade", duration: 160, easing: "linear" }] },
    { id: "build", label: "Points", advance: "with-prev", tracks: [{ id: "points", target: "plot", part: "dot", preset: "fade", duration: 160, easing: "linear" }] },
  ] }, { id: "other", name: "Other slide", notes: "PRIVATE other slide", elements: [], beats: [{ id: "z", tracks: [] }] }];
  deck.assets = [{ id: "shared", name: "shared", kind: "svg", path: "assets/shared.svg", naturalWidth: 320, naturalHeight: 200 }];
  return deck;
}
export const inlineSlideSvg = (color = "#4385be") => `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200" viewBox="0 0 320 200"><defs><clipPath id="clip"><rect width="320" height="200"/></clipPath></defs><g clip-path="url(#clip)"><path id="axis" d="M20 20V180H300" stroke="#555" fill="none"/><circle id="dot" cx="180" cy="65" r="24" fill="${color}"/></g></svg>`;
