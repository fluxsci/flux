// "View as" — see the canvas the way a colour-deficient reader does (colour-system plan B3,
// Flux half).
//
// The simulation is Machado, Oliveira & Fernandes (2009) at full severity — the same matrices
// fluxplot's accessibility lint uses (`colorcheck.machado_matrix(kind, 1.0)`), so what Flux
// shows is what fluxplot's `quality.color` findings measured. Each is a 3×3 linear-sRGB matrix;
// an SVG `<filter>` with `feColorMatrix` applies it to the whole canvas root at draw time —
// filter primitives operate in linearRGB by default, exactly the space the matrices want — and
// nothing in the document changes: it is a way of looking, never an edit. Greyscale is the
// Rec. 709 luminance.
import { writable } from "svelte/store";

export type CvdKind = "none" | "deuteranopia" | "protanopia" | "tritanopia" | "greyscale";
export const CVD_KINDS: readonly CvdKind[] = ["none", "deuteranopia", "protanopia", "tritanopia", "greyscale"];
export const CVD_LABEL: Record<CvdKind, string> = {
  none: "View as: everyone", deuteranopia: "Deuteranopia (no green cones)", protanopia: "Protanopia (no red cones)",
  tritanopia: "Tritanopia (no blue cones)", greyscale: "Greyscale (print / luminance)",
};

/** Machado 2009 severity-1.0 matrices (rows = R', G', B' out; columns = R, G, B in), linear sRGB. */
export const MACHADO_SEVERE: Record<Exclude<CvdKind, "none" | "greyscale">, number[][]> = {
  protanopia: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  deuteranopia: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.01182, 0.04294, 0.968881]],
  tritanopia: [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.3039]],
};
/** Rec. 709 luminance weights, written into every output channel. */
export const LUMINANCE = [0.2126, 0.7152, 0.0722];

/** The 3×3 matrix a kind applies (identity for none). */
export function cvdMatrix(kind: CvdKind): number[][] {
  if (kind === "none") return [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  if (kind === "greyscale") return [LUMINANCE, LUMINANCE, LUMINANCE];
  return MACHADO_SEVERE[kind];
}

/** The 4×5 `values` of an `feColorMatrix type="matrix"` for a kind: each colour row is the 3×3
 *  row, a zero alpha weight and a zero offset; the alpha row is identity. */
export function feColorMatrixValues(kind: CvdKind): string {
  const m = cvdMatrix(kind);
  const rows = m.map((r) => [...r, 0, 0].map(fmt).join(" "));
  rows.push("0 0 0 1 0");
  return rows.join("  ");
}
const fmt = (v: number) => (Object.is(v, -0) ? "0" : String(Number(v.toFixed(6))));

export const filterId = (kind: CvdKind) => `flux-view-as-${kind}`;

/** The `<filter>` definitions for every kind but none, to place once in the document (an
 *  `<svg>` of zero size). `color-interpolation-filters="linearRGB"` is the SVG default, stated
 *  so a host stylesheet cannot move the matrices out of the space they were fitted in. */
export function cvdFilterDefsMarkup(): string {
  return CVD_KINDS.filter((k) => k !== "none")
    .map((k) => `<filter id="${filterId(k)}" color-interpolation-filters="linearRGB"><feColorMatrix type="matrix" values="${feColorMatrixValues(k)}"/></filter>`)
    .join("");
}

/** The CSS `filter` for a kind, or null (no filter). */
export function viewAsFilter(kind: CvdKind): string | null {
  return kind === "none" ? null : `url(#${filterId(kind)})`;
}

/** Apply a kind's filter on a root (or remove it). Returns the applied kind. */
export function applyViewAs(root: { style: { setProperty(p: string, v: string): void; removeProperty(p: string): void } }, kind: CvdKind): CvdKind {
  const f = viewAsFilter(kind);
  if (f) root.style.setProperty("filter", f); else root.style.removeProperty("filter");
  return kind;
}

/** Simulate one sRGB colour (`#rrggbb`) the way `kind` sees it — the same law as the filter,
 *  for a pure check or a swatch preview. */
export function simulateHex(hex: string, kind: CvdKind): string {
  const v = parseInt(hex.slice(1, 7), 16);
  const lin = [(v >> 16) & 255, (v >> 8) & 255, v & 255].map((c) => { const s = c / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
  const m = cvdMatrix(kind);
  const out = m.map((row) => row[0] * lin[0] + row[1] * lin[1] + row[2] * lin[2]);
  return "#" + out.map((l) => { const c = Math.min(1, Math.max(0, l)); const s = c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055; return Math.round(s * 255).toString(16).padStart(2, "0"); }).join("");
}

/** The session's "View as" choice (never persisted: a way of looking, not a setting). */
export const viewAs = writable<CvdKind>("none");
