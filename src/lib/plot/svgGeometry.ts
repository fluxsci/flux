// flux-core/coordscan.ts — SVG intrinsic sizing + extreme-coordinate hygiene
// (split out of index.ts; WS-6.2). Pure string/regex logic — no fs, no deps.

/** Intrinsic size of an SVG in CSS px (96/inch), matching how the BROWSER sizes it on
 *  GUI import: the width/height attributes with their units converted (matplotlib
 *  writes pt → ×96/72), falling back to the viewBox (unitless user units = px).
 *  Physical size is the placement contract — a plot must land at the same true size
 *  whether it arrives via the GUI, the CLI, or an agent. (The old version preferred
 *  the unitless viewBox, silently placing pt-sized SVGs at 0.75× physical.) */
export function svgIntrinsicSize(svg: string): { w: number; h: number } {
  const m = /<svg\b[^>]*>/i.exec(svg);
  const tag = m ? m[0] : svg.slice(0, 600);
  const PX_PER: Record<string, number> = { px: 1, pt: 96 / 72, pc: 16, mm: 96 / 25.4, cm: 96 / 2.54, in: 96 };
  const dim = (name: string): number | null => {
    const d = new RegExp(`\\b${name}="\\s*([\\d.]+)\\s*(px|pt|pc|mm|cm|in)?\\s*"`, "i").exec(tag);
    return d ? +d[1] * PX_PER[(d[2] || "px").toLowerCase()] : null; // "100%" etc. → null
  };
  const w = dim("width");
  const h = dim("height");
  if (w && h) return { w, h };
  const vb = /viewBox="\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(tag);
  if (vb) return { w: +vb[1], h: +vb[2] };
  return { w: 240, h: 180 };
}

// ---------------------------------------------------------------------------
// Extreme-geometry hygiene. matplotlib serializes a bar anchored at data 0 on
// a log axis as a HUGE off-canvas path coordinate (moma fig2a: x ≈ −61,500 in
// a ~380-unit viewBox; the magnitude scales with the axes width). Standalone
// it renders invisibly, but under compose-figure's nested-<svg> scaling resvg
// PANICS on it (geom.rs Rect unwrap → "resvg exit null"). The threshold is
// viewBox-relative, so plots with legitimately large canvases are never
// touched, and the clamp target stays far off-canvas (identical pixels — the
// visible part of such a shape is bounded by its clip rect) while every
// number stays small enough to survive any nested transform.
//
// The previous version matched raw DIGIT RUNS (/-?\d{6,}/), which (a) fired on
// the FRACTIONAL digits of ordinary coordinates ("12.972623" → "12.90000"),
// flooding valid linear plots with hundreds of false "absurd coordinate"
// warnings while silently nudging their geometry, and (b) missed the real
// offenders below 100k — the moma crash coordinate was −61,514 (moma #5/#7).
// ---------------------------------------------------------------------------
const NUM_TOKEN = /-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g;
const NONFINITE_TOKEN = /-?\b(?:NaN|Inf(?:inity)?)\b/gi;

export interface CoordScan {
  svg: string;
  /** numeric tokens beyond ±threshold (plus non-finite tokens). */
  clamped: number;
  /** sample of offending values, worst first (NaN for non-finite tokens). */
  values: number[];
  /** nearest enclosing/preceding element ids of offending paths (deduped). */
  ids: string[];
  threshold: number;
  bound: number;
}

/** Scan (and with `clamp` rewrite) path data whose coordinates are absurdly
 *  far outside the SVG's own canvas: |v| ≥ max(thresholdFactor × the larger
 *  viewBox dimension, 8192); thresholdFactor defaults to 64 (only unambiguous
 *  pathology). Offenders clamp NEGATIVE → −0.25× / POSITIVE → 1.25× the
 *  canvas — just outside the viewport, so the pixels are identical (such
 *  shapes are bounded by their clip rect / the viewport) but the geometry
 *  stays small enough for resvg: empirically its geom.rs panics on clipped
 *  paths reaching ≈1.6× beyond the canvas under nested-<svg> composition, so
 *  the old ±90,000 "clamp" (and anything canvas-scale×4) still crashed it.
 *  Non-finite tokens (NaN/Inf) become 0. */
export function scanAbsurdPathCoords(
  svg: string,
  opts: { clamp: boolean; thresholdFactor?: number },
): CoordScan {
  const { w, h } = svgIntrinsicSize(svg);
  const maxDim = Math.max(w, h);
  const threshold = Math.max((opts.thresholdFactor ?? 64) * maxDim, 8192);
  const bound = 1.25 * maxDim;
  const boundNeg = -0.25 * maxDim;
  let clamped = 0;
  const offend: number[] = [];
  const ids: string[] = [];
  // Best-effort blame: the nearest id BEFORE the offending tag — fluxplot-
  // tagged marks wrap their <path> in <g id="series.bar.N"> immediately, so
  // this names the semantic part; a path's own id is the fallback.
  const idNear = (at: number): string | null => {
    const tagStart = svg.lastIndexOf("<", at);
    const back = svg.slice(Math.max(0, tagStart - 800), Math.max(0, tagStart));
    let last: string | null = null;
    const re = /\bid="([^"]+)"/g;
    for (let g; (g = re.exec(back)); ) last = g[1];
    if (last) return last;
    const tagEnd = svg.indexOf(">", at);
    const own = /\bid="([^"]+)"/.exec(svg.slice(Math.max(0, tagStart), tagEnd < 0 ? at : tagEnd));
    return own ? own[1] : null;
  };
  const out = svg.replace(/\bd="([^"]*)"/g, (whole: string, d: string, at: number) => {
    let touched = false;
    const nd = d
      .replace(NONFINITE_TOKEN, () => {
        touched = true;
        clamped++;
        offend.push(NaN);
        return "0";
      })
      .replace(NUM_TOKEN, (tok) => {
        const v = Number(tok);
        if (Number.isFinite(v) && Math.abs(v) < threshold) return tok;
        touched = true;
        clamped++;
        offend.push(v);
        return String(v < 0 ? boundNeg : bound);
      });
    if (!touched) return whole;
    const id = idNear(at);
    if (id && !ids.includes(id)) ids.push(id);
    return opts.clamp ? `d="${nd}"` : whole;
  });
  offend.sort((a, b) => (Number.isNaN(a) ? -1 : Number.isNaN(b) ? 1 : Math.abs(b) - Math.abs(a)));
  return { svg: opts.clamp ? out : svg, clamped, values: offend.slice(0, 8), ids: ids.slice(0, 8), threshold, bound };
}

/** Whether a FluxPlot manifest records any log-scaled axis (null = unknown —
 *  no/unreadable manifest). Drives the clamp warning's hint: the "anchor your
 *  bar at 1" advice is only offered when a log axis actually exists. */
export function manifestHasLogAxis(manifestText: string | null | undefined): boolean | null {
  if (manifestText == null) return null;
  try {
    const m = JSON.parse(manifestText) as { axes?: { x?: { scale?: string }; y?: { scale?: string } }[] };
    if (!Array.isArray(m.axes)) return null;
    return m.axes.some((a) => a?.x?.scale === "log" || a?.y?.scale === "log");
  } catch {
    return null;
  }
}

/** One human warning line for a scan that found offenders. */
export function absurdCoordWarning(file: string, scan: CoordScan, hasLogAxis: boolean | null): string {
  const finite = scan.values.filter((v) => !Number.isNaN(v));
  const worst = finite.slice(0, 3).map((v) => Math.round(v).toLocaleString("en-US")).join(", ");
  const nonFinite = scan.values.some((v) => Number.isNaN(v));
  const where = scan.ids.length ? ` near id(s) ${scan.ids.slice(0, 3).map((i) => `"${i}"`).join(", ")}` : "";
  const what =
    `${scan.clamped} path coordinate(s) beyond ±${Math.round(scan.threshold).toLocaleString("en-US")}` +
    (worst ? ` (worst: ${worst})` : "") +
    (nonFinite ? " (some non-finite)" : "") +
    where;
  const hint =
    hasLogAxis === true
      ? "a mark anchored at data 0 on this plot's log axis serializes that way — anchor at a positive value in the plot script (barh: left=1, bar: bottom=1)"
      : hasLogAxis === false
        ? "the plot has only linear axes, so this is unusual — check the plot script for stray huge/non-finite values"
        : "often a mark anchored at data 0 on a log axis — if so, anchor at a positive value in the plot script (e.g. left=1)";
  return `${file}: ${what} clamped to keep rendering stable — ${hint}`;
}
