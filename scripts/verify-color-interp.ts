#!/usr/bin/env -S npx tsx
// Animation rework — the color interpolation core (src/lib/color/interp.ts):
// parse/format round-trips, OKLab midpoints (perceptual, not sRGB-average),
// none-handling (alpha-0 endpoint of the other side), endpoint identity, and
// degenerate/unparseable inputs stepping at t=0.5.
// Run: npx tsx scripts/verify-color-interp.ts
import { parseColor, formatColor, lerpColor, isNone } from "../src/lib/color/interp";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("  ok:", msg);
}
const near = (a: number, b: number, eps = 2) => Math.abs(a - b) <= eps;

// --- parsing ---------------------------------------------------------------
assert(JSON.stringify(parseColor("#1b9e77")) === JSON.stringify({ r: 27, g: 158, b: 119, a: 1 }), "#rrggbb parses");
assert(parseColor("#abc")!.g === 0xbb, "#rgb shorthand expands per-digit");
assert(near(parseColor("#ffffff80")!.a * 255, 128, 1), "#rrggbbaa carries alpha");
assert(parseColor("#f00a")!.a === 2 / 3 ? true : near(parseColor("#f00a")!.a, 0xaa / 255, 0.01), "#rgba shorthand alpha");
assert(parseColor("rgb(255, 0, 0)")!.r === 255, "rgb() comma syntax");
assert(parseColor("rgba(10, 20, 30, 0.5)")!.a === 0.5, "rgba() alpha");
assert(parseColor("rgb(10 20 30 / 0.25)")!.a === 0.25, "rgb() space/slash syntax");
assert(parseColor("transparent")!.a === 0, "transparent = alpha 0");
assert(parseColor("none") === null && isNone("none") && isNone(" NONE "), "none is not a color — flagged by isNone");
assert(parseColor("var(--c-accent)") === null && parseColor("tomato") === null, "vars/names are out of scope (non-interpolable)");

// --- formatting ------------------------------------------------------------
assert(formatColor({ r: 27, g: 158, b: 119, a: 1 }) === "#1b9e77", "opaque formats as #rrggbb");
assert(formatColor({ r: 255, g: 0, b: 0, a: 0.5 }) === "#ff000080", "translucent formats as #rrggbbaa");
assert(formatColor(parseColor("#d95f02")!) === "#d95f02", "parse→format round-trips");

// --- endpoint identity -----------------------------------------------------
assert(lerpColor("#123456", "#654321", 0) === "#123456", "t=0 returns the A string verbatim");
assert(lerpColor("#123456", "#654321", 1) === "#654321", "t=1 returns the B string verbatim");
assert(lerpColor("none", "#ff0000", 1) === "#ff0000" && lerpColor("none", "#ff0000", 0) === "none", "none endpoints verbatim");

// --- OKLab blending (not naive sRGB averaging) ------------------------------
{
  // white → black: OKLab mid-L is ~perceptual mid-grey (~#636363), NOT sRGB's #808080
  const mid = parseColor(lerpColor("#ffffff", "#000000", 0.5))!;
  assert(near(mid.r, mid.g, 1) && near(mid.g, mid.b, 1), "grey axis stays neutral");
  assert(mid.r < 0x76 && mid.r > 0x50, `white→black midpoint is perceptual (~#636363), got ${formatColor(mid)}`);
}
{
  // red → blue through OKLab passes via purple (r and b both substantial), never muddy grey
  const mid = parseColor(lerpColor("#ff0000", "#0000ff", 0.5))!;
  assert(mid.r > 100 && mid.b > 100 && mid.g < 90, `red→blue midpoint is purple-ish, got ${formatColor(mid)}`);
}
{
  // monotone-ish lightness along the ramp (OKLab L is linear in t by construction)
  const L = (hex: string) => {
    const c = parseColor(hex)!;
    return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b; // rough luma probe
  };
  const l25 = L(lerpColor("#ffffff", "#000000", 0.25));
  const l75 = L(lerpColor("#ffffff", "#000000", 0.75));
  assert(l25 > l75, "lightness decreases monotonically along white→black");
}

// --- alpha + none ----------------------------------------------------------
assert(near(parseColor(lerpColor("#ff000080", "#ff0000", 0.5))!.a, 0.75, 0.02), "alpha lerps linearly");
assert(near(parseColor(lerpColor("none", "#1b9e77", 0.5))!.a, 0.5, 0.02), "none→color ramps the color's alpha from 0");
{
  const c = parseColor(lerpColor("none", "#1b9e77", 0.5))!;
  const target = parseColor("#1b9e77")!;
  assert(near(c.r, target.r) && near(c.g, target.g) && near(c.b, target.b), "…keeping the color's own hue throughout");
}
assert(near(parseColor(lerpColor("#1b9e77", "none", 0.75))!.a, 0.25, 0.02), "color→none ramps alpha toward 0");
assert(lerpColor("none", "none", 0.5) === "none", "none→none stays none");

// --- unparseable → step at 0.5 ---------------------------------------------
assert(lerpColor("url(#grad)", "#ff0000", 0.49) === "url(#grad)", "unparseable A holds until t=0.5");
assert(lerpColor("url(#grad)", "#ff0000", 0.5) === "#ff0000", "…then steps to B at t=0.5");
assert(lerpColor("#ff0000", "oklch(70% 0.1 200)", 0.6) === "oklch(70% 0.1 200)", "unparseable B steps the same way");

console.log("\nCOLOR INTERP (OKLab core): PASS");
