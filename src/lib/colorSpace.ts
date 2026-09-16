// Colour-space arithmetic for the spectrum picker (2026-09-15): hex ⇄ RGB ⇄
// HSV. Pure and tiny — gated by scripts/verify-color-space.ts. Hue in degrees
// (0–360), saturation and value in 0–1; hex always lower-case #rrggbb.

export interface Rgb { r: number; g: number; b: number }
export interface Hsv { h: number; s: number; v: number }

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

export function hexToRgb(hex: string): Rgb | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

export function rgbToHex({ r, g, b }: Rgb): string {
  const c = (x: number) => Math.round(Math.min(255, Math.max(0, x))).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

export function rgbToHsv({ r, g, b }: Rgb): Hsv {
  const R = r / 255, G = g / 255, B = b / 255;
  const max = Math.max(R, G, B), min = Math.min(R, G, B);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === R) h = 60 * (((G - B) / d) % 6);
    else if (max === G) h = 60 * ((B - R) / d + 2);
    else h = 60 * ((R - G) / d + 4);
    if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

export function hsvToRgb({ h, s, v }: Hsv): Rgb {
  const S = clamp01(s), V = clamp01(v);
  const H = ((h % 360) + 360) % 360;
  const c = V * S;
  const x = c * (1 - Math.abs(((H / 60) % 2) - 1));
  const m = V - c;
  const [R, G, B] =
    H < 60 ? [c, x, 0] : H < 120 ? [x, c, 0] : H < 180 ? [0, c, x] : H < 240 ? [0, x, c] : H < 300 ? [x, 0, c] : [c, 0, x];
  return { r: (R + m) * 255, g: (G + m) * 255, b: (B + m) * 255 };
}

export const hexToHsv = (hex: string): Hsv | null => { const rgb = hexToRgb(hex); return rgb ? rgbToHsv(rgb) : null; };
export const hsvToHex = (hsv: Hsv): string => rgbToHex(hsvToRgb(hsv));
