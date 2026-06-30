// ---------------------------------------------------------------------------
// Flux Slide — the preset catalog (§5.3). Each preset turns a track's resolved
// target nodes into per-node WAAPI keyframes [from, to]. The player owns timing
// (start + stagger → delay) and static-state (apply `from` before a node's intro
// beat, `to` after); a preset only declares WHAT moves.
//
// Two-tier law (style_principles.md P5): every preset here is Tier-1
// (transform/opacity, compositor-free) EXCEPT `drawOn` (stroke-dashoffset, paint)
// and `writeOn` (clip-path) — Tier-2, reserved for the few signature plot/curve
// builds while the scene is otherwise still. `morph`/`countUp` live elsewhere.
// ---------------------------------------------------------------------------

import type { Track, DeckTheme, StageSize } from "../types";

export type TargetNode = HTMLElement | SVGElement;

export interface PresetCtx {
  theme: DeckTheme;
  stage: StageSize;
}

/** One node's animation within a track. `enter` marks an intro (the node is
 *  hidden — at `keyframes[0]` — until this beat plays). `index` orders staggers.
 *  `prep` runs once before play/static to set non-animated scaffolding (dash
 *  array, transform-origin). */
export interface NodeAnim {
  node: TargetNode;
  keyframes: Keyframe[];
  index: number;
  enter: boolean;
  prep?: () => void;
}

export type Preset = (nodes: TargetNode[], track: Track, ctx: PresetCtx) => NodeAnim[];

const num = (v: unknown, d: number): number => (typeof v === "number" ? v : d);
const each = (nodes: TargetNode[], fn: (node: TargetNode, index: number) => NodeAnim): NodeAnim[] =>
  nodes.map(fn);

export const PRESETS: Record<string, Preset> = {
  // --- enters (hidden before their beat) -----------------------------------
  fade: (nodes) => each(nodes, (node, index) => ({ node, index, enter: true, keyframes: [{ opacity: 0 }, { opacity: 1 }] })),

  fadeRise: (nodes, t) => {
    const y = num(t.params?.y, 14);
    return each(nodes, (node, index) => ({
      node, index, enter: true,
      keyframes: [{ opacity: 0, transform: `translateY(${y}px)` }, { opacity: 1, transform: "translateY(0)" }],
    }));
  },

  popIn: (nodes, t) => {
    const from = num(t.params?.from, 0.9);
    return each(nodes, (node, index) => ({
      node, index, enter: true,
      keyframes: [{ opacity: 0, transform: `scale(${from})` }, { opacity: 1, transform: "scale(1)" }],
    }));
  },

  growBaseline: (nodes) =>
    each(nodes, (node, index) => ({
      node, index, enter: true,
      prep: () => { (node as HTMLElement).style.transformOrigin = "bottom center"; },
      keyframes: [{ transform: "scaleY(0)" }, { transform: "scaleY(1)" }],
    })),

  // Tier-2: left→right reveal via a clip-path inset (math / axis labels / text).
  writeOn: (nodes) =>
    each(nodes, (node, index) => ({
      node, index, enter: true,
      keyframes: [{ clipPath: "inset(0 100% 0 0)" }, { clipPath: "inset(0 0 0 0)" }],
    })),

  // Tier-2: the SVG self-draw. Per-node path length → dashoffset.
  drawOn: (nodes) =>
    each(nodes, (node, index) => {
      let len = 1;
      try { len = (node as SVGGeometryElement).getTotalLength?.() || 1; } catch { len = 1; }
      return {
        node, index, enter: true,
        prep: () => { (node as SVGElement).style.strokeDasharray = `${len}`; },
        keyframes: [{ strokeDashoffset: len }, { strokeDashoffset: 0 }],
      };
    }),

  // --- transforms / emphasis (already-present elements) --------------------
  move: (nodes, t) => {
    const dx = num(t.to?.x, 0), dy = num(t.to?.y, 0);
    return each(nodes, (node, index) => ({
      node, index, enter: false,
      keyframes: [{ transform: "translate(0,0)" }, { transform: `translate(${dx}px, ${dy}px)` }],
    }));
  },

  scale: (nodes, t) => {
    const s = num(t.to?.scale ?? t.params?.scale, 1.15);
    return each(nodes, (node, index) => ({
      node, index, enter: false,
      keyframes: [{ transform: "scale(1)" }, { transform: `scale(${s})` }],
    }));
  },

  rotate: (nodes, t) => {
    const deg = num(t.to?.rotation ?? t.to?.deg ?? t.params?.deg, 15);
    return each(nodes, (node, index) => ({
      node, index, enter: false,
      keyframes: [{ transform: "rotate(0deg)" }, { transform: `rotate(${deg}deg)` }],
    }));
  },

  highlight: (nodes) =>
    each(nodes, (node, index) => ({ node, index, enter: false, keyframes: [{ opacity: 0.4 }, { opacity: 1 }] })),

  dim: (nodes) =>
    each(nodes, (node, index) => ({ node, index, enter: false, keyframes: [{ opacity: 1 }, { opacity: 0.3 }] })),

  // --- the stage camera (target = the camera layer) ------------------------
  camera: (nodes, t, ctx) => {
    const zoom = num(t.to?.zoom, 1);
    const cx = num(t.to?.x, ctx.stage.width / 2);
    const cy = num(t.to?.y, ctx.stage.height / 2);
    const tx = ctx.stage.width / 2 - cx * zoom;
    const ty = ctx.stage.height / 2 - cy * zoom;
    return each(nodes, (node, index) => ({
      node, index, enter: false,
      keyframes: [
        { transform: (node as HTMLElement).style.transform || "translate(0,0) scale(1)" },
        { transform: `translate(${tx}px, ${ty}px) scale(${zoom})` },
      ],
    }));
  },

  // `stagger` = apply a child preset (default fadeRise) over the node set; the
  // player adds the per-index delay from track.stagger.
  stagger: (nodes, t, ctx) => {
    const child = (t.params?.child as string) || "fadeRise";
    return (PRESETS[child] ?? PRESETS.fadeRise)(nodes, t, ctx);
  },
};

/** Whether a preset name introduces its targets (hidden before its beat). Used
 *  by the player's static-state pass for nodes it hasn't computed specs for yet. */
export const ENTER_PRESETS = new Set(["fade", "fadeRise", "popIn", "growBaseline", "writeOn", "drawOn", "stagger"]);
