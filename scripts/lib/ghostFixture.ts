import type { Slide } from "../../src/lib/slide/types";
import type { Element } from "../../src/lib/types";
export function ghostFixture(): Slide {
  const source: Element = { id: "source", type: "rect", x: 10, y: 20, width: 60, height: 40, rotation: 0, opacity: .6, fill: "#4385be", stroke: "#000", strokeWidth: 1 };
  return { id: "ghosts", elements: [source, { ...source, id: "g1", name: "First copy", x: 900 }, { ...source, id: "g2", x: 800 }, { ...source, id: "child", x: 700 }], beats: [
    { id: "base", tracks: [] },
    { id: "prior", tracks: [
      { id: "prior-change", target: "source", preset: "transform", duration: 1000, easing: "linear", to: { state: { x: 100 } } },
      { id: "prior-move", target: "source", preset: "move", to: { x: 10 } },
      { id: "prior-dim", target: "source", preset: "dim", start: 400 },
    ] },
    { id: "birth", tracks: [
      { id: "birth1", target: "g1", ghostFrom: "source", preset: "transform", start: 100, duration: 1000, easing: "linear", to: { state: { x: 310, y: 80, fill: "#ff0000" } } },
      { id: "birth2", target: "g2", ghostFrom: "source", preset: "transform", duration: 1000, easing: "linear", to: { state: { x: 410, y: 140 } } },
      { id: "original", target: "source", preset: "transform", duration: 1000, easing: "linear", to: { state: { x: 500 } } },
    ] },
    { id: "chain", tracks: [
      { id: "birth-child", target: "child", ghostFrom: "g1", preset: "transform", duration: 1000, easing: "linear", to: { state: { x: 510 } } },
      { id: "later-parent", target: "g1", preset: "transform", duration: 1000, easing: "linear", to: { state: { x: 350 } } },
    ] },
  ] };
}
