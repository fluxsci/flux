// WS-3.2 (fortify plan): the ONE resize-handle vocabulary, shared by the
// figure Canvas and the slide Stage (they had drifted into byte-identical
// copies). Framework-free math/constants only — no Svelte, no DOM, no stores
// (the slide export runtime bundles through here).

import type { Rect } from "../geometry";

export type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

export const HANDLES: Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

export function handlePos(h: Handle, b: Rect): [number, number] {
  const map: Record<Handle, [number, number]> = {
    nw: [b.x, b.y],
    n: [b.x + b.w / 2, b.y],
    ne: [b.x + b.w, b.y],
    e: [b.x + b.w, b.y + b.h / 2],
    se: [b.x + b.w, b.y + b.h],
    s: [b.x + b.w / 2, b.y + b.h],
    sw: [b.x, b.y + b.h],
    w: [b.x, b.y + b.h / 2],
  };
  return map[h];
}

export const cursorFor: Record<Handle, string> = {
  nw: "nwse-resize",
  se: "nwse-resize",
  ne: "nesw-resize",
  sw: "nesw-resize",
  n: "ns-resize",
  s: "ns-resize",
  e: "ew-resize",
  w: "ew-resize",
};
