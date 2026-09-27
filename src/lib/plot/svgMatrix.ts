// SVG affine transforms, shared by headless geometry and the slide renderer.
// Column vectors: compose(a, b) applies b first, then a (SVG list order).
import type { VectorNode } from "../types";

export type SvgMatrix = readonly [number, number, number, number, number, number];
export const IDENTITY: SvgMatrix = [1, 0, 0, 1, 0, 0];

export function compose(a: SvgMatrix, b: SvgMatrix): SvgMatrix {
  return [
    a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

export function applyToPoint(p: { x: number; y: number }, m: SvgMatrix): { x: number; y: number } {
  return { x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] };
}

/** Handles are offsets, so only the linear part acts on them. Never mutate input. */
export function applyToNodes(nodes: readonly VectorNode[], m: SvgMatrix): VectorNode[] {
  const handle = (h: { dx: number; dy: number }) => ({ dx: m[0] * h.dx + m[2] * h.dy, dy: m[1] * h.dx + m[3] * h.dy });
  return nodes.map((n) => ({
    ...n, ...applyToPoint(n, m),
    ...(n.hIn ? { hIn: handle(n.hIn) } : {}), ...(n.hOut ? { hOut: handle(n.hOut) } : {}),
  }));
}

/** Missing/malformed commands are ignored, as are non-finite values. */
export function parseTransform(value: string | null | undefined): SvgMatrix {
  let out = IDENTITY;
  for (const match of (value ?? "").matchAll(/([a-zA-Z]+)\s*\(([^)]*)\)/g)) {
    const v = (match[2].match(/[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?/g) ?? []).map(Number);
    if (!v.every(Number.isFinite)) continue;
    let m: SvgMatrix = IDENTITY;
    const r = v[0] * Math.PI / 180;
    switch (match[1].toLowerCase()) {
      case "matrix": if (v.length === 6) m = v as unknown as SvgMatrix; break;
      case "translate": if (v.length === 1 || v.length === 2) m = [1, 0, 0, 1, v[0], v[1] ?? 0]; break;
      case "scale": if (v.length === 1 || v.length === 2) m = [v[0], 0, 0, v[1] ?? v[0], 0, 0]; break;
      case "rotate":
        if (v.length === 1 || v.length === 3) {
          const c = Math.cos(r), s = Math.sin(r), x = v[1] ?? 0, y = v[2] ?? 0;
          m = [c, s, -s, c, x - c * x + s * y, y - s * x - c * y];
        }
        break;
      case "skewx": if (v.length === 1) m = [1, 0, Math.tan(r), 1, 0, 0]; break;
      case "skewy": if (v.length === 1) m = [1, Math.tan(r), 0, 1, 0, 0]; break;
    }
    if (m.every(Number.isFinite)) out = compose(out, m);
  }
  return out;
}

/** Node-local → ancestor-local; ancestor's own transform is deliberately excluded. */
export function transformToAncestor(node: Element, ancestor: Element): SvgMatrix {
  let out = IDENTITY;
  for (let n: Element | null = node; n && n !== ancestor; n = n.parentElement) {
    out = compose(parseTransform(n.getAttribute("transform")), out);
  }
  return out;
}
