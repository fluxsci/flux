#!/usr/bin/env -S npx tsx
// 2026-09-15 — the spectrum picker's colour arithmetic (src/lib/colorSpace.ts).
//   Run: npx tsx scripts/verify-color-space.ts
import { hexToRgb, rgbToHex, rgbToHsv, hsvToRgb, hexToHsv, hsvToHex } from "../src/lib/colorSpace";
function assert(cond: unknown, msg: string) { if (!cond) throw new Error("FAIL: " + msg); console.log("  ok:", msg); }
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps;
assert(JSON.stringify(hexToRgb("#ff8000")) === '{"r":255,"g":128,"b":0}' && JSON.stringify(hexToRgb("abc")) === '{"r":170,"g":187,"b":204}', "hex parses long and short forms, with or without #");
assert(hexToRgb("#12345") === null && hexToRgb("none") === null && hexToRgb("") === null, "bad hex → null");
assert(rgbToHex({ r: 255, g: 128, b: 0 }) === "#ff8000" && rgbToHex({ r: 300, g: -5, b: 7.6 }) === "#ff0008", "rgb → lower-case #rrggbb, clamped and rounded");
const red = rgbToHsv({ r: 255, g: 0, b: 0 }), green = rgbToHsv({ r: 0, g: 255, b: 0 }), grey = rgbToHsv({ r: 128, g: 128, b: 128 }), black = rgbToHsv({ r: 0, g: 0, b: 0 });
assert(near(red.h, 0) && near(red.s, 1) && near(red.v, 1), "red is h0 s1 v1");
assert(near(green.h, 120) && near(green.s, 1), "green is h120");
assert(near(grey.s, 0) && near(grey.v, 128 / 255) && near(black.v, 0) && near(black.s, 0), "greys have no saturation; black has no value");
for (const hex of ["#d95f02", "#4385be", "#100f0f", "#fffcf0", "#ce5d97", "#00ffff"]) {
  const back = hsvToHex(hexToHsv(hex)!);
  assert(back === hex, `${hex} survives hex → hsv → hex`);
}
assert(hsvToHex({ h: 360 + 30, s: 2, v: -1 }) === "#000000" && hsvToHex({ h: -90, s: 1, v: 1 }) === hsvToHex({ h: 270, s: 1, v: 1 }), "hue wraps, s/v clamp");
const rgb = hsvToRgb({ h: 200, s: 0.5, v: 0.8 });
assert(near(rgb.r, 102, 0.5) && near(rgb.g, 170, 0.5) && near(rgb.b, 204, 0.5), "hsv → rgb matches a known point");
console.log("VERIFY-COLOR-SPACE PASS");
