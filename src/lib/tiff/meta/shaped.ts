/**
 * The "shaped" JSON description Python writers leave on a series' first page: `{"shape": [20, 512, 512]}`, with an
 * optional `"axes": "TZCYX"`. Pure.
 *
 * The shape's trailing entries are the plane (y, x, and the samples when a pixel has several); the leading ones
 * are the dims over the pages, slowest first. Axis letters name them (T time, Z depth, C channel); letters that
 * mean "some sequence" (Q, I) or anything else leave the name to the person.
 */
import type { DimSpec, Hint } from "../types";

export interface ShapedInfo { shape: number[]; axes: string | null }

/** The shaped JSON among a page's descriptions, or null. */
export function findShaped(descriptions: readonly string[]): ShapedInfo | null {
  for (const d of descriptions) {
    const t = d.trim();
    if (!t.startsWith("{")) continue;
    try {
      const j = JSON.parse(t);
      if (j && Array.isArray(j.shape) && j.shape.length >= 2 && j.shape.every((v: unknown) => Number.isInteger(v) && (v as number) >= 1)) {
        return { shape: j.shape as number[], axes: typeof j.axes === "string" && j.axes.length === j.shape.length ? j.axes.toUpperCase() : null };
      }
    } catch { /* not JSON */ }
  }
  return null;
}

const LETTER: Record<string, string> = { T: "t", Z: "z", C: "c" };

export function shapedHint(info: ShapedInfo, pages: number, width: number, height: number, samples: number): Hint {
  const reasons: string[] = [`shaped JSON description: shape ${JSON.stringify(info.shape)}${info.axes ? `, axes "${info.axes}"` : " (no axis names)"}`];
  const problems: string[] = [];
  let lead = info.shape.slice(), axes = info.axes ? info.axes.split("") : null;
  // Trailing plane: (y, x) or (y, x, samples).
  if (samples > 1 && lead[lead.length - 1] === samples) { lead = lead.slice(0, -1); axes = axes?.slice(0, -1) ?? null; }
  const [h, w] = lead.slice(-2);
  if (h !== height || w !== width) problems.push(`the shape's plane ${h} x ${w} is not the page's ${height} x ${width}`);
  lead = lead.slice(0, -2); axes = axes?.slice(0, -2) ?? null;
  // Size-1 dims carry nothing (a single-page image is often written with a leading 1).
  const dims: DimSpec[] = [];
  let named = true;
  lead.forEach((n, i) => {
    if (n === 1) return;
    const letter = axes?.[i];
    const name = letter ? LETTER[letter] ?? "" : "";
    if (!name) named = false;
    dims.push({ name, size: n });
  });
  const product = dims.reduce((p, d) => p * (d.size as number), 1);
  if (product !== pages) problems.push(`the shape accounts for ${product} pages; the file has ${pages}`);
  if (dims.length && !named) reasons.push(info.axes ? `axes "${info.axes}" do not name every dimension (Q or I mean "a sequence")` : "the description gives sizes, not names");
  if (new Set(dims.map((d) => d.name).filter(Boolean)).size !== dims.filter((d) => d.name).length) problems.push("an axis letter repeats");
  const hint: Hint = { source: "shaped", confidence: problems.length ? "low" : named ? "high" : "medium", dims, reasons, ...(problems.length ? { problems } : {}) };
  return hint;
}
