#!/usr/bin/env -S npx tsx
// WS-10(1) — design-token drift gate. flexoki.tokens.json (the Figma export,
// consumed by flexoki.ts + the ambient palette) and src/styles/tokens.css (the
// hand-maintained ramp) are parallel Flexoki sources with no reconciliation.
// Direction: every --flx-* hex the CSS ramp defines must equal the JSON's
// value for the same token (CSS ⊆ JSON) — the JSON may carry more tokens.
//   npx tsx scripts/verify-tokens-sync.ts

import { promises as fs } from "node:fs";
import * as path from "node:path";

let failures = 0;
const ok = (m: string) => console.log("  ok:", m);
const fail = (m: string) => {
  console.error("  ✗ FAIL:", m);
  failures++;
};

const root = path.join(import.meta.dirname, "..");
const json = JSON.parse(await fs.readFile(path.join(root, "flexoki.tokens.json"), "utf8")) as Record<string, unknown>;
const css = await fs.readFile(path.join(root, "src", "styles", "tokens.css"), "utf8");

// Flatten the Figma export: leaf name → hex (lowercased). Leaf names are
// unique across groups in the Flexoki set (base-600, red-400, …).
const jsonHex = new Map<string, string>();
(function walk(o: Record<string, unknown>) {
  for (const [k, v] of Object.entries(o)) {
    if (!v || typeof v !== "object") continue;
    const t = v as { $type?: string; $value?: { hex?: string } };
    if (t.$type === "color" && t.$value?.hex) {
      const hex = t.$value.hex.toLowerCase();
      if (jsonHex.has(k) && jsonHex.get(k) !== hex) fail(`token name "${k}" is ambiguous across JSON groups`);
      jsonHex.set(k, hex);
    } else {
      walk(v as Record<string, unknown>);
    }
  }
})(json);
ok(`flexoki.tokens.json defines ${jsonHex.size} color tokens`);

// CSS ramp: --flx-<name>: #hex;  (names map to JSON leaves: base-600 → base-600,
// black → black, paper → paper, red-600 → red-600, …)
let checked = 0;
let bad = 0;
for (const m of css.matchAll(/--flx-([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})/g)) {
  const name = m[1];
  const hex = m[2].toLowerCase();
  const want = jsonHex.get(name);
  if (want === undefined) {
    fail(`CSS defines --flx-${name} but the Figma export has no token "${name}"`);
    bad++;
    continue;
  }
  if (want !== hex) {
    fail(`--flx-${name} drifted: CSS ${hex} vs Figma export ${want}`);
    bad++;
  }
  checked++;
}
if (!bad) ok(`all ${checked} CSS ramp tokens match the Figma export exactly`);

// The stale light-mode comment must stay gone (the .paper scope IS light mode).
if (/open question/i.test(css)) fail('tokens.css still claims light mode is "an open question"');
else ok("tokens.css comment truth: no stale light-mode caveat");

console.log(failures ? `\nTOKENS SYNC: FAIL (${failures})` : "\nTOKENS SYNC: PASS");
process.exit(failures ? 1 : 0);
