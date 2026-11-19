/**
 * Label map → one exact outline per object.
 *
 * The outline follows pixel edges, so it encloses exactly the labelled pixels: nothing is smoothed or
 * resampled. Pixel (row r, column c) covers x in [c, c+1] and y in [r, r+1]. Outer boundaries run clockwise
 * on screen (y down) and holes counter-clockwise, so both fill rules agree. Pure.
 */

export interface LabelOutline {
  label: number;
  /** SVG path data: one closed subpath per boundary loop. */
  d: string;
  /** Number of pixels carrying the label. */
  pixels: number;
  /** Bounding box in pixels. */
  box: { x: number; y: number; width: number; height: number };
  /** Centroid of the labelled pixels, in pixel coordinates (pixel centres at +0.5). */
  cx: number;
  cy: number;
}

export function labelOutlines(labels: ArrayLike<number>, width: number, height: number): LabelOutline[] {
  const boxes = new Map<number, { x0: number; y0: number; x1: number; y1: number; n: number; sx: number; sy: number }>();
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const l = labels[y * width + x];
      if (!(l > 0)) continue;
      const b = boxes.get(l);
      if (!b) boxes.set(l, { x0: x, y0: y, x1: x, y1: y, n: 1, sx: x, sy: y });
      else { if (x < b.x0) b.x0 = x; if (x > b.x1) b.x1 = x; if (y > b.y1) b.y1 = y; b.n++; b.sx += x; b.sy += y; }
    }
  }
  const out: LabelOutline[] = [];
  for (const l of [...boxes.keys()].sort((a, b) => a - b)) {
    const b = boxes.get(l)!;
    const bw = b.x1 - b.x0 + 1, bh = b.y1 - b.y0 + 1;
    const inside = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < bw && y < bh && labels[(b.y0 + y) * width + b.x0 + x] === l;
    // Directed boundary edges between pixel corners, the object on the right-hand side of travel.
    const stride = bw + 1;
    const next = new Map<number, number[]>();
    const add = (ax: number, ay: number, bx: number, by: number): void => {
      const k = ay * stride + ax;
      const list = next.get(k);
      if (list) list.push(by * stride + bx); else next.set(k, [by * stride + bx]);
    };
    for (let y = 0; y < bh; y++) {
      for (let x = 0; x < bw; x++) {
        if (!inside(x, y)) continue;
        if (!inside(x, y - 1)) add(x, y, x + 1, y);
        if (!inside(x + 1, y)) add(x + 1, y, x + 1, y + 1);
        if (!inside(x, y + 1)) add(x + 1, y + 1, x, y + 1);
        if (!inside(x - 1, y)) add(x, y + 1, x, y);
      }
    }
    const parts: string[] = [];
    while (next.size) {
      const start = next.keys().next().value as number;
      let cur = start, pdx = 0, pdy = 0, first = true;
      const pts: number[] = [start];
      for (;;) {
        const cands = next.get(cur)!;
        const cx = cur % stride, cy = Math.floor(cur / stride);
        let pick = 0;
        if (cands.length > 1 && !first) {
          // Where two loops touch at a corner, turn right: that keeps diagonal neighbours as separate loops.
          let best = -Infinity;
          for (let i = 0; i < cands.length; i++) {
            const dx = (cands[i] % stride) - cx, dy = Math.floor(cands[i] / stride) - cy;
            const turn = pdx * dy - pdy * dx;
            if (turn > best) { best = turn; pick = i; }
          }
        }
        const nxt = cands[pick];
        cands.splice(pick, 1);
        if (!cands.length) next.delete(cur);
        const dx = (nxt % stride) - cx, dy = Math.floor(nxt / stride) - cy;
        if (!first && dx === pdx && dy === pdy) pts[pts.length - 1] = nxt; else pts.push(nxt);
        pdx = dx; pdy = dy; first = false; cur = nxt;
        if (cur === start) break;
      }
      if (pts.length > 1 && pts[pts.length - 1] === pts[0]) pts.pop();
      // The start corner may sit mid-edge: drop it when its neighbours are collinear through it.
      if (pts.length > 2) {
        const a = pts[pts.length - 1], m = pts[0], c = pts[1];
        const ax = a % stride, ay = Math.floor(a / stride), mx = m % stride, my = Math.floor(m / stride), cx2 = c % stride, cy2 = Math.floor(c / stride);
        if ((mx - ax) * (cy2 - my) === (my - ay) * (cx2 - mx)) pts.shift();
      }
      parts.push("M" + pts.map((p) => `${(p % stride) + b.x0},${Math.floor(p / stride) + b.y0}`).join(" L") + " Z");
    }
    out.push({
      label: l, d: parts.join(" "), pixels: b.n,
      box: { x: b.x0, y: b.y0, width: bw, height: bh },
      cx: b.sx / b.n + 0.5, cy: b.sy / b.n + 0.5,
    });
  }
  return out;
}

/** Signed area of path data produced above (clockwise on screen is positive): equals the pixel count. */
export function outlineArea(d: string): number {
  let area = 0;
  for (const sub of d.split("M").filter(Boolean)) {
    const pts = sub.replace("Z", "").split("L").map((p) => p.trim().split(",").map(Number));
    for (let i = 0; i < pts.length; i++) {
      const [x0, y0] = pts[i], [x1, y1] = pts[(i + 1) % pts.length];
      area += x0 * y1 - x1 * y0;
    }
  }
  return area / 2;
}
