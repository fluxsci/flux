#!/usr/bin/env -S npx tsx
// WS-4.2 (fortify plan) — overlapping renderManuscript calls must not swap
// captions. The old module-global capStash was reset at the top of every
// render; two renders interleaving across the KaTeX await would have read each
// other's captions. capStash is per-render now — this pins it.
//   npx tsx scripts/verify-render-concurrency.ts

import "./lib/cssStub.mjs";

const { renderManuscript } = await import("../src/shell/modes/paper/render/renderManuscript");

let failures = 0;
const ok = (m: string) => console.log("  ok:", m);
const fail = (m: string) => {
  console.error("  ✗ FAIL:", m);
  failures++;
};
const assert = (c: unknown, m: string) => (c ? ok(m) : fail(m));

// Doc A: math-bearing (forces the getKatex() await inside the render window)
// with a labeled table caption unique to A.
const docA = [
  "---",
  'title: "Doc A"',
  "---",
  "",
  "Math here: $E = mc^2$ inline.",
  "",
  "| H | V |",
  "|---|---|",
  "| a | 1 |",
  "",
  ": CAPTION-ALPHA unique to doc A {#tbl-alpha}",
  "",
].join("\n");

// Doc B: no math (no katex await) with a caption unique to B.
const docB = [
  "---",
  'title: "Doc B"',
  "---",
  "",
  "Plain prose only.",
  "",
  "| H | V |",
  "|---|---|",
  "| b | 2 |",
  "",
  ": CAPTION-BETA unique to doc B {#tbl-beta}",
  "",
].join("\n");

// Fire A (slow path: katex import) and B (fast path) OVERLAPPING.
const [a, b] = await Promise.all([renderManuscript(docA, {}), renderManuscript(docB, {})]);

assert(a.inner.includes("CAPTION-ALPHA"), "A's caption landed in A");
assert(!a.inner.includes("CAPTION-BETA"), "B's caption did NOT leak into A");
assert(b.inner.includes("CAPTION-BETA"), "B's caption landed in B");
assert(!b.inner.includes("CAPTION-ALPHA"), "A's caption did NOT leak into B");

// And again with the interleave inverted (B first, A resolving later).
const [b2, a2] = await Promise.all([renderManuscript(docB, {}), renderManuscript(docA, {})]);
assert(b2.inner.includes("CAPTION-BETA") && !b2.inner.includes("CAPTION-ALPHA"), "inverted order: B clean");
assert(a2.inner.includes("CAPTION-ALPHA") && !a2.inner.includes("CAPTION-BETA"), "inverted order: A clean");

console.log(failures ? `\nRENDER CONCURRENCY: FAIL (${failures})` : "\nRENDER CONCURRENCY: PASS");
process.exit(failures ? 1 : 0);
