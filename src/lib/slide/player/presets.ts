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
import { trimKeyframes, resolveAnchor, isDefaultTrim, type TrimSpec } from "./trim";

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

/** [hidden, shown] clip-path insets for a writeOn/wipeOut direction. */
function wipeInsets(direction: string): [string, string] {
  const hidden =
    direction === "rtl" ? "inset(0 0 0 100%)" :
    direction === "ttb" ? "inset(0 0 100% 0)" :
    direction === "btt" ? "inset(100% 0 0 0)" :
    "inset(0 100% 0 0)"; // ltr
  return [hidden, "inset(0 0 0 0)"];
}

/** Inside a <defs> subtree? Such geometry is a shared TEMPLATE (fluxplot ticks
 *  reference one defs path via <use> per tick) — dashing it would animate every
 *  referencing instance at once. Never draw-on defs content. */
function inDefs(el: Element): boolean {
  for (let p: Element | null = el.parentElement ?? (el.parentNode as Element | null); p; p = p.parentElement ?? (p.parentNode as Element | null)) {
    if (p.tagName?.toLowerCase() === "defs") return true;
  }
  return false;
}

/** The strokable geometry to draw-on for a target. FluxPlot wraps each part in a
 *  <g id="…"> and the real path/line lives inside, so a draw-on target is usually
 *  a group — drill to its path/line/polyline/polygon descendants. Shape tags
 *  (rect/ellipse/circle) qualify ONLY when stroke-rendered (fill none): dash
 *  windows hide the STROKE alone, so a filled shape would flash its fill
 *  before its beat — those keep the fade fallback. <use> and anything living
 *  in <defs> are NOT strokable here (a <use>'s length can't be measured and
 *  its defs path is shared) — returns [] when nothing real is found so
 *  callers pick an explicit fallback instead of silently no-oping. */
function strokeRenderedShape(el: Element): boolean {
  const fill = (el.getAttribute?.("fill") ?? "").trim().toLowerCase();
  if (fill !== "none" && fill !== "transparent") return false;
  const stroke = (el.getAttribute?.("stroke") ?? "").trim().toLowerCase();
  return stroke !== "" && stroke !== "none";
}
function geometryEls(node: TargetNode): SVGElement[] {
  const el = node as Element;
  const tag = el.tagName?.toLowerCase();
  if (tag && /^(path|line|polyline|polygon)$/.test(tag)) return inDefs(el) ? [] : [el as SVGElement];
  if (tag && /^(rect|ellipse|circle)$/.test(tag)) return !inDefs(el) && strokeRenderedShape(el) ? [el as SVGElement] : [];
  const found = Array.from(el.querySelectorAll?.("path,line,polyline,polygon") ?? []) as SVGElement[];
  const shapes = (Array.from(el.querySelectorAll?.("rect,ellipse,circle") ?? []) as SVGElement[]).filter((s) => strokeRenderedShape(s));
  return [...found, ...shapes].filter((g) => !inDefs(g));
}

/** Measured length of a strokable node, honoring an explicit pathLength
 *  attribute (dash units must then be expressed in ITS scale). */
function geoLength(geo: SVGElement): number {
  const pl = Number(geo.getAttribute?.("pathLength"));
  if (Number.isFinite(pl) && pl > 0) return pl;
  try {
    return (geo as unknown as SVGGeometryElement).getTotalLength?.() || 1;
  } catch {
    return 1;
  }
}

/** Is this geometry a closed loop (dash windows wrap)? */
function geoClosed(geo: SVGElement): boolean {
  const tag = geo.tagName?.toLowerCase();
  if (tag === "rect" || tag === "ellipse" || tag === "circle" || tag === "polygon") return true;
  if (tag === "path") return /z\s*$/i.test((geo.getAttribute?.("d") ?? "").trim());
  return false;
}

/** Trim-path params from a track (documented schema — §5 of the rework plan). */
interface TrimParams {
  anchor?: number | string;
  direction?: "forward" | "reverse";
  mode?: "single" | "both-ends" | "middle-out";
  from?: number;
  to?: number;
}

/** Build the trim NodeAnim for one geometry (the enriched drawOn/drawOff). */
function trimAnim(geo: SVGElement, index: number, enter: boolean, p: TrimParams): NodeAnim {
  const len = geoLength(geo);
  const box = (geo as unknown as { getBBox?: () => { width: number; height: number } }).getBBox?.();
  const spec: TrimSpec = {
    len,
    closed: geoClosed(geo),
    anchor: resolveAnchor(p.anchor, {
      tag: geo.tagName?.toLowerCase() ?? "path",
      width: box?.width ?? Number(geo.getAttribute?.("width")) ?? undefined,
      height: box?.height ?? Number(geo.getAttribute?.("height")) ?? undefined,
    }),
    direction: p.direction === "reverse" ? "reverse" : "forward",
    mode: p.mode === "both-ends" || p.mode === "middle-out" ? p.mode : "single",
    from: typeof p.from === "number" ? p.from : 0,
    to: typeof p.to === "number" ? p.to : 1,
  };
  const kfs = trimKeyframes(spec, enter);
  return {
    node: geo,
    index,
    enter,
    keyframes: kfs.map((k) => ({
      ...(k.offset != null ? { offset: k.offset } : {}),
      strokeDasharray: k.strokeDasharray,
      strokeDashoffset: k.strokeDashoffset,
    })),
  };
}

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

  // Tier-2: directional reveal via a clip-path inset (math / axis labels /
  // text). params.direction: ltr (default) | rtl | ttb | btt.
  writeOn: (nodes, t) => {
    const [hidden, shown] = wipeInsets((t.params?.direction as string) ?? "ltr");
    return each(nodes, (node, index) => ({
      node, index, enter: true,
      keyframes: [{ clipPath: hidden }, { clipPath: shown }],
    }));
  },

  // Tier-2: the SVG self-draw — Flux's Trim Paths. Drills through wrapper
  // <g>s to the strokable geometry, then dashes each child by its OWN length
  // so the stroke draws itself on (dashing the empty <g> would do nothing /
  // dot the children). DEFAULT params compile exactly the legacy way (constant
  // dasharray, offset len→0 — old decks byte-play identically); any trim
  // param (anchor / direction / mode / from / to) switches that geometry to
  // the full trim engine (trim.ts). A target with NO measurable geometry
  // (<use>-based ticks in pre-regen fluxplot SVGs, a FILLED rect/ellipse —
  // dash hides only strokes) falls back to a fade — never a silent no-op that
  // leaves the part visible before its beat.
  drawOn: (nodes, t) =>
    nodes.flatMap((node, index): NodeAnim[] => {
      const geos = geometryEls(node);
      if (!geos.length) return [{ node, index, enter: true, keyframes: [{ opacity: 0 }, { opacity: 1 }] }];
      const trim = !isDefaultTrim(t.params as TrimParams | undefined);
      return geos.map((geo): NodeAnim => {
        if (trim) return trimAnim(geo, index, true, (t.params ?? {}) as TrimParams);
        const len = geoLength(geo);
        return {
          node: geo, index, enter: true,
          prep: () => { geo.style.strokeDasharray = `${len}`; },
          keyframes: [{ strokeDashoffset: len }, { strokeDashoffset: 0 }],
        };
      });
    }),

  // --- exits (hidden AFTER their beat) --------------------------------------
  fadeOut: (nodes) =>
    each(nodes, (node, index) => ({ node, index, enter: false, keyframes: [{ opacity: 1 }, { opacity: 0 }] })),

  popOut: (nodes, t) => {
    const to = num(t.params?.to, 0.92);
    return each(nodes, (node, index) => ({
      node, index, enter: false,
      keyframes: [{ opacity: 1, transform: "scale(1)" }, { opacity: 0, transform: `scale(${to})` }],
    }));
  },

  // Tier-2: writeOn's mirror — a directional wipe via clip-path. The default
  // wipes back right-to-left (the reverse of the ltr write).
  wipeOut: (nodes, t) => {
    const [hidden, shown] = wipeInsets((t.params?.direction as string) ?? "ltr");
    return each(nodes, (node, index) => ({
      node, index, enter: false,
      keyframes: [{ clipPath: shown }, { clipPath: hidden }],
    }));
  },

  // Tier-2: drawOn reversed — the stroke un-draws itself. Same geometry drill,
  // same trim enrichment, same no-measurable-geometry fallback (a fade-out).
  drawOff: (nodes, t) =>
    nodes.flatMap((node, index): NodeAnim[] => {
      const geos = geometryEls(node);
      if (!geos.length) return [{ node, index, enter: false, keyframes: [{ opacity: 1 }, { opacity: 0 }] }];
      const trim = !isDefaultTrim(t.params as TrimParams | undefined);
      return geos.map((geo): NodeAnim => {
        if (trim) return trimAnim(geo, index, false, (t.params ?? {}) as TrimParams);
        const len = geoLength(geo);
        return {
          node: geo, index, enter: false,
          prep: () => { geo.style.strokeDasharray = `${len}`; },
          keyframes: [{ strokeDashoffset: 0 }, { strokeDashoffset: len }],
        };
      });
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

/** The disappear family — targets are hidden AFTER their beat. A later enter
 *  re-baselines the node (the player's static accumulation restarts at the last
 *  enter), so enter → exit → re-enter sequences are deterministic + reversible. */
export const EXIT_PRESETS = new Set(["fadeOut", "popOut", "drawOff", "wipeOut"]);

/** The WRAPPER-level style props each appearance preset animates — the
 *  transform-conflict map (rework §4.1): a transform on the same element in
 *  the same beat DROPS these props from its own writes so the appearance owns
 *  them for the overlap (and, at rest, the static pass's later-spec-wins
 *  ordering resolves the same way). Presets that drill to INNER geometry
 *  (drawOn/drawOff) touch no wrapper props and are absent deliberately. */
export const PRESET_WRAPPER_PROPS: Record<string, readonly string[]> = {
  fade: ["opacity"],
  fadeRise: ["opacity", "transform"],
  popIn: ["opacity", "transform"],
  growBaseline: ["transform"],
  writeOn: ["clipPath"],
  stagger: ["opacity", "transform"],
  fadeOut: ["opacity"],
  popOut: ["opacity", "transform"],
  wipeOut: ["clipPath"],
  highlight: ["opacity"],
  dim: ["opacity"],
  move: ["transform"],
  scale: ["transform"],
  rotate: ["transform"],
};
