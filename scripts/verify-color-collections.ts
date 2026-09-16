#!/usr/bin/env -S npx tsx
// 2026-09-16 — the bundled colour collections (src/lib/color/collections.gen.ts,
// generated from fluxplot's definitions) and the pure helpers over them.
//   Run: npx tsx scripts/verify-color-collections.ts
import {
  COLORMAP_COLLECTIONS, PALETTE_COLLECTIONS, COLORMAP_TYPES, findColormap, qualifiedName, colormapGradient,
  colormapColorAt, colormapsByType, paletteGroups, availablePaletteCollections, nextId,
} from "../src/lib/color/collections";

function assert(cond: unknown, msg: string) { if (!cond) throw new Error("FAIL: " + msg); console.log("  ok:", msg); }
const HEX = /^#[0-9a-f]{6}$/;

// (1) the bundle: four map collections, three palette collections, well-formed
assert(COLORMAP_COLLECTIONS.map((c) => c.id).join() === "mpl,crameri,tol,cmasher", "four colormap collections in fluxplot's order");
assert(PALETTE_COLLECTIONS.map((c) => c.id).join() === "flexoki,brewer,tol", "three palette collections, Flexoki first");
let maps = 0;
for (const c of COLORMAP_COLLECTIONS) {
  const names = new Set<string>();
  for (const m of c.maps) {
    maps++;
    if (names.has(m.name) || m.name.endsWith("_r")) throw new Error(`${c.id}.${m.name} is a duplicate or a stored reverse`);
    names.add(m.name);
    if (!COLORMAP_TYPES.includes(m.type)) throw new Error(`bad type ${m.type} on ${c.id}.${m.name}`);
    if (!m.colors.every((h) => HEX.test(h))) throw new Error(`bad hex in ${c.id}.${m.name}`);
    if (!m.discrete && m.colors.length !== 32) throw new Error(`${c.id}.${m.name} should carry 32 stops, has ${m.colors.length}`);
  }
}
console.log("  ok: every map well-formed (" + maps + " maps)");
assert(maps > 200, "the bundle carries the whole set (> 200 maps)");
for (const c of PALETTE_COLLECTIONS) for (const g of c.groups) if (!g.swatches.every((s) => HEX.test(s.hex) && s.name)) throw new Error(`bad swatch in ${c.id}/${g.name}`);
console.log("  ok: every palette swatch is a named lower-case hex");
assert(PALETTE_COLLECTIONS[1].groups.find((g) => g.name === "Blues")?.swatches.length === 9, "ColorBrewer Blues is the 9-class scheme");
assert(PALETTE_COLLECTIONS[2].groups.find((g) => g.name === "bright")?.swatches[0].hex === "#4477aa", "Tol's bright set starts with its blue");
assert(PALETTE_COLLECTIONS[0].groups.some((g) => g.name === "green"), "Flexoki keeps its hue groups");

// (2) resolution: qualified, bare, reversed, legacy prefix
const b = findColormap("crameri.batlow")!;
assert(b.collection.id === "crameri" && b.map.name === "batlow" && !b.reversed, "qualified names resolve");
assert(findColormap("batlow")?.collection.id === "crameri" && findColormap("PRGn")?.collection.id === "mpl", "bare names resolve through the collections in fluxplot's order");
assert(findColormap("tol.sunset_r")?.reversed === true && findColormap("cmr.amber")?.collection.id === "cmasher", "…_r marks the reverse; the legacy cmr. prefix maps to cmasher");
assert(findColormap("nosuch") === null && findColormap("") === null, "unknown names are null");
assert(qualifiedName(b.collection, b.map, true) === "crameri.batlow_r", "qualifiedName builds fluxplot's name");

// (3) previews and colour-at-position
const grad = colormapGradient(b.map);
assert(grad.startsWith("linear-gradient(to right, #") && grad.split(",").length === 32 + 1, "a continuous map previews as a 32-stop gradient");
const disc = findColormap("tol.rainbow_discrete")!.map;
assert(disc.discrete === true && /% /.test(colormapGradient(disc)), "a discrete map previews as hard steps");
assert(colormapColorAt(b.map, 0) === b.map.colors[0] && colormapColorAt(b.map, 1) === b.map.colors[31], "the ends of a map are its first and last stops");
assert(colormapColorAt(b.map, 1, true) === b.map.colors[0], "reversed reads from the other end");
assert(colormapColorAt(b.map, 1 / 62) !== b.map.colors[0] && HEX.test(colormapColorAt(b.map, 0.37)), "between stops the colour interpolates to a valid hex");
assert(colormapColorAt(disc, 0.99) === disc.colors[disc.colors.length - 1] && colormapColorAt(disc, 0.01) === disc.colors[0], "a discrete map picks the nearest step");
assert(colormapColorAt(b.map, NaN) === b.map.colors[0] && colormapColorAt(b.map, 7) === b.map.colors[31], "out-of-range positions clamp");

// (4) grouping, palette rows and cycling
const groups = colormapsByType(findColormap("viridis")!.collection);
assert(groups[0].type === "sequential" && groups.every((g) => g.maps.length) && groups.map((g) => g.type).join() === "sequential,diverging,cyclic,qualitative,misc", "matplotlib groups by type in picker order");
assert(colormapsByType(b.collection).map((g) => g.type).join() === "sequential,diverging,cyclic,qualitative", "Crameri has no misc group");
assert(paletteGroups("brewer").length === 35 && paletteGroups("project", { colorGroups: [] }).length === 0 && paletteGroups("nosuch").length === 0, "paletteGroups reads a collection or the project");
assert(availablePaletteCollections(null).map((c) => c.id).join() === "flexoki,brewer,tol" && availablePaletteCollections({ colorGroups: [{ name: "mine", swatches: [] }] }).at(-1)?.id === "project", "the project's own palette joins the list when it exists");
assert(nextId(["a", "b", "c"], "c") === "a" && nextId(["a", "b", "c"], "a", -1) === "c" && nextId(["a", "b"], "zzz") === "a", "nextId wraps both ways and starts over from an unknown current");
console.log("VERIFY-COLOR-COLLECTIONS PASS");
