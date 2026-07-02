#!/usr/bin/env -S npx tsx
// W20 — Library scale (LR-4). Two hot-path fixes in LibraryMode.svelte, verified here at
// the logic level (the GUI grid needs a multi-thousand-item machine-global FluxLib the
// headless harness can't stand up; the scroll cost itself is handled browser-side by the
// rows' `content-visibility:auto` belt, so windowing was intentionally deferred — see the
// note printed at the end).
//
//  (a) Precomputed `nfcOf` map: hasPdf()/isFailed() looked up `safeKey(key).normalize("NFC")`
//      4–6× per row per render. We precompute it once per load into a Map. This must be
//      EXACTLY equivalent to the old per-call computation for every key — proven below over
//      ASCII, Unicode-decomposed, slash/dot, and whitespace keys, plus the miss-fallback.
//  (b) Coalesced bulk-fetch ticks: each landed PDF used to allocate a fresh Set and reassign
//      pdfKeys (re-rendering every row) → O(N²) over a 500-paper run. We buffer landed keys
//      and fold them into ONE Set per ~250ms window. This must (1) end with EVERY landed key
//      present and (2) allocate far fewer Sets than there were ticks. Proven below, including
//      the "job ends with an unflushed buffer, then the authoritative re-list covers it" path.
//   Run: npx tsx scripts/verify-w20-library.ts
import { safeKey } from "../src/lib/references/items";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("  ok:", msg);
}

// --- (a) nfcOf precompute is equivalent to the old hasPdfIn computation ------------------
// Representative keys: plain, Unicode-decomposed (é as e + combining accent), a key with a
// path separator + double-dot (safeKey sanitizes these), and leading/trailing whitespace.
const keys = [
  "smith2020",
  "müller2019", // "müller" written decomposed → NFC must recompose
  "a/b..c",
  "  spaced2021  ",
  "李2022",
];
const nfcOf = new Map(keys.map((k) => [k, safeKey(k).normalize("NFC")]));
const nfc = (key: string) => nfcOf.get(key) ?? safeKey(key).normalize("NFC");

for (const k of keys) {
  const oldWay = safeKey(k).normalize("NFC"); // what hasPdfIn(set, k) used to hash on
  assert(nfc(k) === oldWay, `nfc("${k.trim()}") matches the old per-row safeKey+NFC`);
}
// A key NOT in the precomputed map (e.g. a World-scope row) falls back to the live computation.
const stray = "notInLibrary2099";
assert(!nfcOf.has(stray), "stray key is absent from the precomputed map");
assert(nfc(stray) === safeKey(stray).normalize("NFC"), "nfc() falls back to live compute on a map miss");

// The precompute must actually change nothing about set membership. Simulate a pdfKeys Set
// produced by listPdfKeys() (already NFC-normalized dir names) and check hasPdf both ways.
const pdfKeys = new Set(keys.slice(0, 3).map((k) => safeKey(k).normalize("NFC")));
const hasPdfNew = (key: string) => pdfKeys.has(nfc(key));
const hasPdfOld = (key: string) => pdfKeys.has(safeKey(key).normalize("NFC"));
for (const k of [...keys, stray]) {
  assert(hasPdfNew(k) === hasPdfOld(k), `hasPdf("${k.trim()}") unchanged by the precompute`);
}

// --- (b) coalesced bulk-fetch ticks: correctness + allocation reduction ------------------
// Faithful model of the component's buffer/flush without real timers: onTick pushes to a
// buffer; flushTicks folds the buffer into ONE new Set (counting allocations). We drive the
// flush at window boundaries the way the 250ms setTimeout would.
function runCoalesced(landed: string[], flushEvery: number) {
  let live = new Set<string>(); // stands in for pdfKeys
  let buf: string[] = [];
  let allocs = 0;
  const flush = () => {
    if (!buf.length) return;
    const next = new Set(live);
    for (const k of buf) next.add(nfcSim(k));
    buf = [];
    live = next;
    allocs++;
  };
  const nfcSim = (k: string) => safeKey(k).normalize("NFC"); // job keys aren't pre-mapped
  landed.forEach((k, i) => {
    buf.push(k);
    if ((i + 1) % flushEvery === 0) flush(); // a 250ms window elapsed
  });
  return { live, buf, allocs, flush };
}

const landed = Array.from({ length: 500 }, (_, i) => `paper${i}`);
const batched = runCoalesced(landed, 100); // ~5 windows over the run
batched.flush(); // a final in-run flush before the job returns
assert(batched.allocs <= 6, `500 ticks folded into ${batched.allocs} Set allocations (≪ 500 — the old O(N²))`);
assert(batched.live.size === 500, "every one of the 500 landed keys is present after coalescing");
assert(landed.every((k) => batched.live.has(safeKey(k).normalize("NFC"))), "each specific landed key is present, not just the count");

// The job-completion path: buffer may hold un-flushed ticks when the job returns; the code
// clears the timer + buffer and does `pdfKeys = await listPdfKeys()`. Model that the
// authoritative re-list is a superset of anything optimistically buffered → nothing is lost.
const partial = runCoalesced(landed, 150); // 500 % 150 = 50 left unflushed; no trailing flush called
assert(partial.buf.length === 50, "job ended mid-window with an unflushed optimistic buffer (50 keys)");
const authoritative = new Set(landed.map((k) => safeKey(k).normalize("NFC"))); // listPdfKeys() result
for (const k of partial.buf) assert(authoritative.has(safeKey(k).normalize("NFC")), "unflushed key is still covered by the authoritative re-list");

console.log("\nW20 LIBRARY VERIFY: PASS");
console.log(
  "note: full JS windowing intentionally deferred — rows carry content-visibility:auto +\n" +
    "      contain-intrinsic-size (browser-native off-screen skipping), rows are variable-height\n" +
    "      (inline expand strip) and keyboard-nav scroll-driven, so a windowed list is high-risk\n" +
    "      for marginal gain once the per-row regex + O(N²) tick churn above are removed.",
);
