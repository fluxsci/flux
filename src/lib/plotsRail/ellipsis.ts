// Middle ellipsis for plot names (pure; gate: scripts/verify-plots-rail-layout.ts).
// Scientific variants differ at the END — `_v2`, `_s07`, `_by_region` — so end-truncation hides
// exactly what tells two plots apart. The tail keeps the larger share.

const ELLIPSIS = "…";

/** `text` shortened in the middle to fit `maxWidth` as measured by `measure` (px). */
export function middleEllipsis(text: string, maxWidth: number, measure: (s: string) => number, tailShare = 0.6): string {
  if (!text || measure(text) <= maxWidth) return text;
  if (maxWidth <= measure(ELLIPSIS)) return "";
  const chars = [...text];
  // Binary search the number of kept characters.
  let lo = 0, hi = chars.length - 1, best = ELLIPSIS;
  const build = (keep: number) => {
    const tail = Math.ceil(keep * tailShare), head = keep - tail;
    return chars.slice(0, head).join("") + ELLIPSIS + (tail ? chars.slice(chars.length - tail).join("") : "");
  };
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = build(mid);
    if (measure(s) <= maxWidth) { best = s; lo = mid + 1; }
    else hi = mid - 1;
  }
  return best;
}

/** A canvas-backed width measurer for one CSS font, memoized per string. */
export function createMeasurer(font: string, doc: Document = document): (s: string) => number {
  const canvas = doc.createElement("canvas");
  const ctx = canvas.getContext("2d");
  const memo = new Map<string, number>();
  if (ctx) ctx.font = font;
  return (s: string) => {
    let w = memo.get(s);
    if (w === undefined) {
      w = ctx ? ctx.measureText(s).width : s.length * 6.3;
      if (memo.size > 20000) memo.clear();
      memo.set(s, w);
    }
    return w;
  };
}
