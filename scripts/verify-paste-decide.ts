#!/usr/bin/env -S npx tsx
// Paste arbitration core (pure): the decision table between the in-app element
// clipboard and the OS clipboard (Figma-style screenshot paste), plus the
// pasted-asset display name. GUI behavior rides verify-paste-image.mjs.
import { FLUX_CLIP_MARKER, decidePaste, pastedImageName } from "../src/lib/clipboardPaste";

let fails = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log("  ok:", msg);
  else { fails++; console.error("  FAIL:", msg); }
}

// Marker + internal elements → elements, even with a stale image alongside.
assert(decidePaste({ text: FLUX_CLIP_MARKER, hasImage: false, internalCount: 2 }) === "elements", "marker + internal → elements");
assert(decidePaste({ text: FLUX_CLIP_MARKER, hasImage: true, internalCount: 2 }) === "elements", "marker beats a stale image (no double paste)");

// Image wins when the OS clipboard holds one and no marker (screenshot is the
// most recent copy) — even if the internal clipboard still has old elements.
assert(decidePaste({ text: "", hasImage: true, internalCount: 0 }) === "image", "image, empty internal → image");
assert(decidePaste({ text: "", hasImage: true, internalCount: 3 }) === "image", "image + stale internal → image (screenshot is newer)");
assert(decidePaste({ text: "some copied text", hasImage: true, internalCount: 3 }) === "image", "unrelated text + image → image");

// Fallbacks.
assert(decidePaste({ text: "", hasImage: false, internalCount: 2 }) === "elements", "no marker/no image → internal fallback (pre-marker copies)");
assert(decidePaste({ text: "unrelated", hasImage: false, internalCount: 2 }) === "elements", "unrelated text only → internal fallback");
assert(decidePaste({ text: "", hasImage: false, internalCount: 0 }) === "none", "nothing anywhere → none");
assert(decidePaste({ text: FLUX_CLIP_MARKER, hasImage: false, internalCount: 0 }) === "none", "marker but internal emptied → none (marker alone is not content)");

// Versioned marker prefix survives future suffixes.
assert(decidePaste({ text: FLUX_CLIP_MARKER + ":extra", hasImage: true, internalCount: 1 }) === "elements", "marker prefix match");

// Display name: dated, extension-correct, fixed shape.
const n = pastedImageName(new Date(2026, 6, 18, 9, 5, 7), "png");
assert(n === "pasted-2026-07-18-090507.png", `pastedImageName shape (got ${n})`);
assert(pastedImageName(new Date(2026, 11, 3, 23, 59, 59), "svg").endsWith(".svg"), "svg extension");

console.log(fails === 0 ? "\nPASTE-DECIDE ALL PASS" : `\nPASTE-DECIDE ${fails} FAILURE(S)`);
process.exit(fails === 0 ? 0 : 1);
