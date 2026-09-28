#!/usr/bin/env -S npx tsx
// Regression: AE-style influence → cubic-bezier mapping, the easing resolver (CSS
// string for WAAPI + JS sampler for morph), and the bezier sampler's shape.
//   FLUX_NO_MIGRATE=1 node scripts/run-verifies.mjs --tier pure --only slide-easing
import { createHash } from "node:crypto";
import { harness } from "./lib/harness.mjs";
import { resolveCurve, EASING_TOKENS } from "../src/lib/slide/curves";
import type { EasingToken } from "../src/lib/slide/types";
import { parseHTML } from "linkedom";
const { document } = parseHTML("<!doctype html><html><body></body></html>");
(globalThis as { document?: unknown }).document = document;

const { influenceToBezier, influenceToCss, cubicBezierFn } = await import("../src/lib/motion/tokens");
const { resolveEasing, resolveEasingFn } = await import("../src/lib/slide/player/player");
const h = harness("verify-slide-easing");
const assert = h.ok;
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

// Captured by executing git show 04f37e3:src/lib/slide/easing.ts with its
// pre-change motion/tokens.ts. Digests pin all 1,001 double-valued samples
// (JSON at i/1000), rather than reimplementing the old resolver as an oracle.
h.section("pre-M1 byte snapshots: five tokens by twelve influence pairs");
const LEGACY_TOKENS = {
  "smooth": {
    "css": "linear(0.0000,0.0007,0.0051,0.0161,0.0355,0.0645,0.1035,0.1522,0.2099,0.2752,0.3466,0.4222,0.5000,0.5778,0.6534,0.7248,0.7901,0.8478,0.8965,0.9355,0.9645,0.9839,0.9949,0.9993,1.0000)",
    "sha256": "61e3b0eaa2d7c6194a6c1cfc8c18da3f0721fb680599fdca3456efc360250851"
  },
  "standard": {
    "css": "cubic-bezier(0.4, 0, 0.2, 1)",
    "sha256": "5a477611523f4b4c8d8affe390ccf9d0ff3f44802e6cef6704579d153bdf5179"
  },
  "enter": {
    "css": "cubic-bezier(0.16, 1, 0.3, 1)",
    "sha256": "c0039067d0660e946fe813653f956fee53be49d252bfb017564ab31197f089d4"
  },
  "exit": {
    "css": "cubic-bezier(0.4, 0, 1, 1)",
    "sha256": "0feb67c1b33d166a7a70f1e5f1abdd096380f8cfaa7b81b1e3598c14549f27bd"
  },
  "linear": {
    "css": "linear",
    "sha256": "81a5a0d25d400eacd58793a3322a1c7516622354ecd95e9f5652bf12f41ff972"
  }
} as const;
const LEGACY_INFLUENCES = [
  {
    "in": 0,
    "out": 0,
    "css": "cubic-bezier(0.4, 0, 0.2, 1)",
    "sha256": "5a477611523f4b4c8d8affe390ccf9d0ff3f44802e6cef6704579d153bdf5179"
  },
  {
    "in": 100,
    "out": 100,
    "css": "cubic-bezier(1.000, 0, 0.000, 1)",
    "sha256": "dfdb226b343d0eb9e6c1b079554fcb8216eca6318e9b8d1d10bdcfff30d7ea24"
  },
  {
    "in": 50,
    "out": 50,
    "css": "cubic-bezier(0.500, 0, 0.500, 1)",
    "sha256": "a78ee553bccf0439228b70215ed7216886c9dc38e280b9abe707bbfcc5707c8f"
  },
  {
    "in": 25,
    "out": 75,
    "css": "cubic-bezier(0.750, 0, 0.750, 1)",
    "sha256": "ec4e8600fade41f59988c6d0864fb623877bd3c91ff83139d61826fb4bfad152"
  },
  {
    "in": 75,
    "out": 25,
    "css": "cubic-bezier(0.250, 0, 0.250, 1)",
    "sha256": "1d0feb9ff9498f35cce5f92ea87bdf28536e25e39438cb69fdc768e7abdfabe0"
  },
  {
    "in": 0,
    "out": 100,
    "css": "cubic-bezier(1.000, 0, 1.000, 1)",
    "sha256": "42062c6306da25745bca70f5be2db95457bd7c5b40ca2003f1953ce539b3a867"
  },
  {
    "in": 100,
    "out": 0,
    "css": "cubic-bezier(0.000, 0, 0.000, 1)",
    "sha256": "d1cba9a0b013ae88a7a0679c83bb96b49bb2e17874dbbae4afdcf82b99fb1af0"
  },
  {
    "in": 33,
    "out": 33,
    "css": "cubic-bezier(0.330, 0, 0.670, 1)",
    "sha256": "f62550c54d6a6feb794cb8e8a90ea7f1bd02784057ebfa4afd8566464fc376fc"
  },
  {
    "in": 12.345,
    "out": 67.891,
    "css": "cubic-bezier(0.679, 0, 0.877, 1)",
    "sha256": "c1cb447f23ab31e670c81e2f349b44e259adbb7b4ddbd1af29b2e8e5ba547c93"
  },
  {
    "in": 200,
    "out": -5,
    "css": "cubic-bezier(0.000, 0, 0.000, 1)",
    "sha256": "d1cba9a0b013ae88a7a0679c83bb96b49bb2e17874dbbae4afdcf82b99fb1af0"
  },
  {
    "in": -5,
    "out": 200,
    "css": "cubic-bezier(1.000, 0, 1.000, 1)",
    "sha256": "42062c6306da25745bca70f5be2db95457bd7c5b40ca2003f1953ce539b3a867"
  },
  {
    "in": -10,
    "out": -20,
    "css": "cubic-bezier(0.4, 0, 0.2, 1)",
    "sha256": "5a477611523f4b4c8d8affe390ccf9d0ff3f44802e6cef6704579d153bdf5179"
  }
] as const;
const digest = (fn: (t: number) => number) => createHash("sha256").update(JSON.stringify(Array.from({ length: 1001 }, (_, i) => fn(i / 1000)))).digest("hex");
for (const token of EASING_TOKENS) {
  for (const inf of [undefined, ...LEGACY_INFLUENCES]) {
    const active = inf && (inf.in > 0 || inf.out > 0), expected = active ? inf : LEGACY_TOKENS[token];
    const resolved = resolveCurve({ easing: token, influence: inf });
    const label = `${token} / ${inf ? `${inf.in},${inf.out}` : "absent"}`;
    h.eq(resolveEasing(token, inf), expected.css, `${label}: legacy CSS bytes`);
    h.eq(resolved.css, expected.css, `${label}: unified CSS bytes`);
    h.eq(digest(resolveEasingFn(token, inf)), expected.sha256, `${label}: legacy fn bytes at 1,001 probes`);
    h.eq(digest(resolved.fn), expected.sha256, `${label}: unified fn bytes at 1,001 probes`);
  }
}
const direct = await import("../src/lib/slide/easing");
h.ok(resolveEasing === direct.resolveEasing && resolveEasingFn === direct.resolveEasingFn, "player still re-exports both compatibility entry points");
h.eq(EASING_TOKENS.slice().sort(), Object.keys(LEGACY_TOKENS).sort(), "the token union keeps exactly the five historical names");
const typedTokens: readonly EasingToken[] = EASING_TOKENS;
h.eq(typedTokens.length, 5, "EasingToken derives from the runtime list");
await h.done();
