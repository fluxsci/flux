#!/usr/bin/env -S npx tsx
// Regression: AE-style influence → cubic-bezier mapping, the easing resolver (CSS
// string for WAAPI + JS sampler for morph), and the bezier sampler's shape.
//   npx tsx scripts/verify-slide-easing.ts
import { parseHTML } from "linkedom";
const { document } = parseHTML("<!doctype html><html><body></body></html>");
(globalThis as { document?: unknown }).document = document;

const { influenceToBezier, influenceToCss, cubicBezierFn } = await import("../src/lib/motion/tokens");
const { resolveEasing, resolveEasingFn } = await import("../src/lib/slide/player/player");
function assert(c: unknown, m: string) { if (!c) throw new Error("FAIL: " + m); console.log("  ok:", m); }
const close = (a: number, b: number, e = 1e-3) => Math.abs(a - b) < e;

// influence → bezier: out → x1 (start handle), in → x2 = 1 − in/100 (end handle)
assert(JSON.stringify(influenceToBezier({ in: 0, out: 0 })) === "[0,0,1,1]", "0/0 → linear bezier [0,0,1,1]");
assert(JSON.stringify(influenceToBezier({ in: 100, out: 100 })) === "[1,0,0,1]", "100/100 → strong [1,0,0,1]");
assert(JSON.stringify(influenceToBezier({ in: 50, out: 50 })) === "[0.5,0,0.5,1]", "50/50 → [0.5,0,0.5,1]");
assert(JSON.stringify(influenceToBezier({ in: 25, out: 75 })) === "[0.75,0,0.75,1]", "out=75→x1=0.75, in=25→x2=0.75");
assert(JSON.stringify(influenceToBezier({ in: 200, out: -5 })) === "[0,0,0,1]", "out-of-range clamps to [0,100]");

// css formatting (WAAPI string)
assert(influenceToCss({ in: 50, out: 50 }) === "cubic-bezier(0.500, 0, 0.500, 1)", "influenceToCss formats the bezier");

// resolveEasing: influence overrides the named token; 0/0 is treated as "no influence"
assert(resolveEasing(undefined, { in: 50, out: 50 }) === "cubic-bezier(0.500, 0, 0.500, 1)", "resolveEasing uses influence when set");
assert(resolveEasing("standard", { in: 0, out: 0 }) === resolveEasing("standard"), "0/0 influence falls back to the named token");
assert(resolveEasing("linear") === "linear", "named linear unchanged (no influence)");

// the JS sampler: endpoints, symmetry, slow-at-the-edges for a strong profile, monotonic
const f = cubicBezierFn(influenceToBezier({ in: 100, out: 100 }));
assert(close(f(0), 0) && close(f(1), 1), "sampler hits 0 and 1 at the ends");
assert(close(f(0.5), 0.5), "symmetric ease-in-out is 0.5 at the midpoint");
assert(f(0.15) < 0.15 && f(0.85) > 0.85, "strong influence is slow at the start and end");
let prev = -1, mono = true;
for (let i = 0; i <= 40; i++) { const y = f(i / 40); if (y < prev - 1e-6) mono = false; prev = y; }
assert(mono, "sampler is monotonically non-decreasing");

// resolveEasingFn (morph time-easing) mirrors the same curve
const g = resolveEasingFn(undefined, { in: 50, out: 50 });
assert(close(g(0), 0) && close(g(1), 1) && close(g(0.5), 0.5), "resolveEasingFn samples the influence curve");
assert(resolveEasingFn("linear")(0.3) === 0.3, "resolveEasingFn linear is the identity");

console.log("\nSLIDE EASING / INFLUENCE REGRESSION PASSED");
