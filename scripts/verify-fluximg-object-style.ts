// fluximg objects styled by a column of their layer's table (pure tier): the law of `objectStyle.ts` on hand cases
// and seeded random tables (kinds, the order of categories, palette and wrap-around, the numeric colour law against
// the channel law, the pixel renderer and the plot colour scale, degenerate ranges, opacity, missing values both ways,
// unknown columns), the view field through resolveView / patchView / viewCheck / pixelKey, the legend, the drawing
// (`layerMarkup` attributes, the key furniture) and resvg pixels of styled outlines and of the key; the export
// context reads a table only for a styled layer.
//
// Run: npx tsx scripts/verify-fluximg-object-style.ts
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Resvg } from "@resvg/resvg-js";
import { harness } from "./lib/harness.mjs";
import { fixtures, writeFixture, rng } from "./lib/fluximgFixtures";
import {
  DEFAULT_PALETTE, DIM_COLOR, DIM_OPACITY, STYLE_CACHE_BYTES, cachedObjectStyles, categoriesOf, columnHistogram, columnKind, columnSummaries, describeStyleBy, missingStyle,
  naturalCompare, numberColor, objectStyles, previewStyleBy, shownObjects, styleCacheStats, styleColumnNames, styleTable, styleWork,
} from "../src/lib/fluximg/objectStyle";
import { channelTable, makeNormalizer, normalizeValue, slotOf } from "../src/lib/fluximg/lut";
import { renderView } from "../src/lib/fluximg/render";
import { lookupIndex } from "../src/lib/plot/colorscale";
import { patchView, pixelKey, resolveView } from "../src/lib/fluximg/viewOps";
import { checkMergedView, checkViewPatch } from "../src/lib/fluximg/viewCheck";
import { layerMarkup } from "../src/lib/fluximg/layers";
import { furnitureSvg, keyLayer, KEY_MAX_ROWS } from "../src/lib/fluximg/furniture";
import { fluximgStaticSvg } from "../src/lib/fluximg/static";
import { fluximgElementMarkup, prepareFluximgContext } from "../src/lib/fluximg/exportStatic";
import { ensureColormapLuts, colormapLut } from "../src/lib/color/colormapLuts";
import { PALETTE_COLLECTIONS } from "../src/lib/color/collections.gen";
import type { FluximgManifest, FluximgTable } from "../src/lib/fluximg/types";
import type { FluximgStyleBy, ResolvedView } from "../src/lib/fluximg/view";

const h = harness("verify-fluximg-object-style");
await ensureColormapLuts();
const lut = (name: string): string[] | null => colormapLut(name)?.lut ?? null;
const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "fluximg-objstyle-"));
const fx = Object.fromEntries(fixtures().map((f) => [f.name, f]));
await writeFixture(tmp, fx.mean_f64_layers);
const dir = path.join(tmp, "mean_f64_layers.fluximg");
const M: FluximgManifest = JSON.parse(await fsp.readFile(path.join(dir, "fluximg.json"), "utf8"));
const footprintsSvg = await fsp.readFile(path.join(dir, "layers/footprints.svg"), "utf8");
const footprints = M.layers.find((l) => l.id === "footprints")!;
if (footprints.kind !== "labels") throw new Error("fixture drift: footprints is a label layer");
const T: FluximgTable = JSON.parse(await fsp.readFile(path.join(dir, footprints.table), "utf8"));
const hex = (s: string): [number, number, number] => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];

h.section("A. kinds and the order of categories");
{
  h.eq([columnKind([1, 2.5, null]), columnKind(["a", 1]), columnKind([null, null]), columnKind([]), columnKind([true, false])], ["number", "category", "empty", "empty", "category"], "a column is numeric when every non-null value is a finite number; none at all is empty");
  h.eq(categoriesOf(["d10", "d2", "D1", "a", "d2", null, "d01"]), ["a", "D1", "d01", "d2", "d10"], "strings in natural order: digit runs by value, letters case-insensitively, ties by code point");
  h.ok(naturalCompare("d1", "D1") !== 0 && naturalCompare("d1", "D1") === -naturalCompare("D1", "d1"), "case ties are broken (by code point), so the order is total");
  h.eq(categoriesOf([true, "b", 3, false, "a", 1, null]), [1, 3, "a", "b", false, true], "numbers ascending, then strings, then false, true");
  h.eq(categoriesOf([1, "1"]).length, 2, "1 and \"1\" are different values");
  h.eq(categoriesOf(["1.5", "1.25", "9", "10", "-3", "-10", "b"]), ["-10", "-3", "1.25", "1.5", "9", "10", "b"], "strings that are numbers sort by value (decimals, minus signs), before other strings");
  h.eq(categoriesOf(T.columns.dendrite), ["d1", "d2"], "the fixture's dendrite column has two categories (its null is not one)");
}

h.section("B. categorical colours: palette, wrap-around, independent of rows");
{
  const s = objectStyles(T, "source_id", { color: { column: "dendrite" } }, lut);
  h.eq(s.issues, [], "no issues");
  h.eq([s.byKey.get("s1")?.color, s.byKey.get("s2")?.color, s.byKey.get("s3")?.color], [DEFAULT_PALETTE[0], DEFAULT_PALETTE[0], DEFAULT_PALETTE[1]], "d1 → the palette's first colour, d2 → its second");
  h.eq(s.byKey.get("s7"), { color: DIM_COLOR, opacity: DIM_OPACITY }, "the null one is dimmed: neutral grey, faint");
  h.eq(objectStyles(T, "source_id", { color: { column: "dendrite" }, missing: "hide" }, lut).byKey.get("s7"), { hidden: true }, "…or hidden, with missing: hide");
  // B3: 24 colours by default, every one distinct; past them the colours repeat and the legend says so.
  h.eq(new Set(DEFAULT_PALETTE).size, 24, "the default palette has 24 distinct colours");
  const ten: FluximgTable = { key: "k", columns: { k: Array.from({ length: 10 }, (_, i) => `o${i}`), c: Array.from({ length: 10 }, (_, i) => `c${i}`) } };
  const w = objectStyles(ten, "k", { color: { column: "c" } }, lut);
  h.eq(new Set(ten.columns.k.map((k) => w.byKey.get(String(k))?.color)).size, 10, "ten categories: ten different colours (the palette no longer wraps at 8)");
  h.ok(w.legend?.color?.kind === "category" && !w.legend.color.repeats, "…and the legend says no colour is shared");
  const many: FluximgTable = { key: "k", columns: { k: Array.from({ length: 26 }, (_, i) => `o${i}`), c: Array.from({ length: 26 }, (_, i) => `c${i}`) } };
  const wm = objectStyles(many, "k", { color: { column: "c" } }, lut);
  h.ok(wm.byKey.get("o24")?.color === DEFAULT_PALETTE[0] && wm.legend?.color?.kind === "category" && wm.legend.color.repeats, "past 24 categories colours repeat (category 24 = colour 0), and the legend marks it");
  const own = objectStyles(ten, "k", { color: { column: "c", palette: ["#ff0000", "#00FF00", "nonsense"] } }, lut);
  h.eq([own.byKey.get("o0")?.color, own.byKey.get("o1")?.color, own.byKey.get("o2")?.color], ["#ff0000", "#00ff00", "#ff0000"], "an own palette (colours only, lower-cased) wraps too");
  h.ok(own.legend?.color?.kind === "category" && own.legend.color.repeats, "…and says so");
  // Seeded random tables: shuffling rows and appending rows never recolour a category.
  let shuffleOk = true, appendOk = true;
  for (let seed = 1; seed <= 40; seed++) {
    const r = rng(seed), n = 5 + Math.floor(r() * 60), cats = ["alpha", "beta", "g2", "g10", "Delta", "eps", "7", "zeta", "eta", "theta"];
    const rows = Array.from({ length: n }, (_, i) => ({ k: `o${i}`, v: r() < 0.1 ? null : cats[Math.floor(r() * cats.length)] }));
    const table = (rs: typeof rows): FluximgTable => ({ key: "k", columns: { k: rs.map((x) => x.k), v: rs.map((x) => x.v) } });
    const base = objectStyles(table(rows), "k", { color: { column: "v" } }, lut);
    const shuffled = rows.slice().sort(() => r() - 0.5);
    const again = objectStyles(table(shuffled), "k", { color: { column: "v" } }, lut);
    for (const x of rows) if (base.byKey.get(x.k)?.color !== again.byKey.get(x.k)?.color) shuffleOk = false;
    // Appended rows carry values the table already has: every category keeps its colour.
    const present = rows.map((x) => x.v).filter((v): v is string => v !== null);
    if (!present.length) continue;
    const more = [...rows, ...Array.from({ length: 10 }, (_, i) => ({ k: `n${i}`, v: present[Math.floor(r() * present.length)] }))];
    const grown = objectStyles(table(more), "k", { color: { column: "v" } }, lut);
    for (const x of rows) if (base.byKey.get(x.k)?.color !== grown.byKey.get(x.k)?.color) appendOk = false;
  }
  h.ok(shuffleOk, "40 seeded tables: every object keeps its colour when the rows are shuffled");
  h.ok(appendOk, "…and when rows of existing values are appended");
}

h.section("C. the numeric law is the channel law");
{
  const values = [0, 3, 7.5, 10, 12, -2, 5.000001];
  const range: [number, number] = [0, 10];
  for (const name of ["viridis", "magma", "crameri.batlow"]) for (const reverse of [false, true]) {
    const t = styleTable(name, reverse, lut), ref = channelTable({ color: null, lut: name, invert: reverse }, lut);
    const n = makeNormalizer(range, "linear");
    const ok = values.every((v) => { const s = slotOf(normalizeValue(n, v)); return numberColor(t, range, v) === `#${[ref[s * 4], ref[s * 4 + 1], ref[s * 4 + 2]].map((c) => c.toString(16).padStart(2, "0")).join("")}`; });
    h.ok(ok, `${name}${reverse ? " reversed" : ""}: an object's colour is channelTable[slotOf(normalize(v))], bit for bit`);
  }
  // The pixel renderer: a plane of exactly these values under the same map and window draws the same colours.
  const r = rng(99), N = 200, vals = Float64Array.from({ length: N }, () => -1 + r() * 12);
  const t = channelTable({ color: null, lut: "viridis", invert: false }, lut);
  const px = renderView({ width: N, height: 1, channels: [{ plane: { data: vals, map: null }, view: { index: 0, name: "v", visible: true, color: null, lut: "viridis", range, norm: "linear", gamma: 1, invert: false }, table: t }],
    layers: [], composite: "blend", solo: 0, background: "#000000", smooth: false, crop: { x: 0, y: 0, width: N, height: 1 }, outWidth: N, outHeight: 1 });
  const st = styleTable("viridis", false, lut);
  h.ok(Array.from(vals).every((v, i) => { const c = hex(numberColor(st, range, v)); return c[0] === px[i * 4] && c[1] === px[i * 4 + 1] && c[2] === px[i * 4 + 2]; }), "200 random values: each object's colour equals the pixel renderView draws for that value");
  h.ok(Array.from({ length: 257 }, (_, i) => i / 256).every((x) => lookupIndex(256, x, false) === slotOf(x)), "the slot is the plot colour scale's (colorscale.lookupIndex at N = 256)");
  const deg: FluximgTable = { key: "k", columns: { k: ["a", "b"], v: [4, 4] } };
  h.eq(objectStyles(deg, "k", { color: { column: "v" } }, lut).byKey.get("a")?.color, numberColor(st, [0, 1], 0.5), "a degenerate range (min = max) puts every value in the map's middle");
  const flat = objectStyles(T, "source_id", { color: { column: "pixels", range: [10, 10] } }, lut);
  const own = objectStyles(T, "source_id", { color: { column: "pixels" } }, lut);
  h.eq(flat.byKey.get("s1")?.color, own.byKey.get("s1")?.color, "an invalid range is ignored: the column's own min..max");
  h.eq([own.byKey.get("s7")?.color, own.byKey.get("s2")?.color], [numberColor(st, [5, 32], 5), numberColor(st, [5, 32], 32)], "the default range is the column's min..max (viridis, the default map)");
  const pal = objectStyles({ key: "k", columns: { k: ["a", "b", "c"], cluster: [2, 0, 2] } }, "k", { color: { column: "cluster", palette: ["#111111", "#222222"] } }, lut);
  h.eq([pal.byKey.get("b")?.color, pal.byKey.get("a")?.color, pal.legend?.color?.kind], ["#111111", "#222222", "category"], "a numeric column with an own palette (and no map) is coloured as categories: integer codes");
}

h.section("D. opacity, missing, unknown columns");
{
  const o = objectStyles(T, "source_id", { opacity: { column: "pixels" } }, lut);
  h.eq([o.byKey.get("s7")?.opacity, o.byKey.get("s2")?.opacity, o.byKey.get("s1")?.color], [0.15, 1, undefined], "opacity: min..max onto [0.15, 1]; no colour is set");
  const o2 = objectStyles(T, "source_id", { opacity: { column: "pixels", range: [10, 20], to: [0, 0.8] } }, lut);
  h.eq([o2.byKey.get("s7")?.opacity, o2.byKey.get("s3")?.opacity, o2.byKey.get("s2")?.opacity], [0, 0.64, 0.8], "a given range onto a given `to`, clamped at both ends");
  const bad = objectStyles(T, "source_id", { opacity: { column: "dendrite" } }, lut);
  h.ok(bad.issues.length === 1 && /not numeric/.test(bad.issues[0]) && bad.byKey.size === 0 && bad.legend === null, "opacity by a categorical column: an issue, no styling");
  let threw = false, un: ReturnType<typeof objectStyles> | null = null;
  try { un = objectStyles(T, "source_id", { color: { column: "nope" } }, lut); } catch { threw = true; }
  h.ok(!threw && !!un && /no column "nope"/.test(un.issues[0]) && /"dendrite"/.test(un.issues[0]) && un.legend === null, "an unknown column is an issue naming the columns there are, never a throw");
  const half = objectStyles(T, "source_id", { color: { column: "nope" }, opacity: { column: "pixels" } }, lut);
  h.ok(half.issues.length === 1 && half.byKey.get("s2")?.opacity === 1 && !half.byKey.get("s2")?.color, "the part that can apply still applies");
  h.eq(objectStyles(null, "k", { color: { column: "x" } }, lut).issues.length, 1, "no table: an issue");
  // C7: nothing to style by is an issue and no styling, never "everything missing".
  const nulls: FluximgTable = { key: "k", columns: { k: ["a", "b"], v: [null, null] } };
  const en = objectStyles(nulls, "k", { color: { column: "v" } }, lut);
  h.ok(en.legend === null && en.byKey.size === 0 && /has no values/.test(en.issues[0]), "an all-null colour column: an issue, no styling (not every object dimmed)");
  h.ok(/has no values/.test(objectStyles(nulls, "k", { opacity: { column: "v" } }, lut).issues[0] ?? ""), "…opacity by it says it has no values (not \"not numeric\")");
  const none = objectStyles({ key: "k", columns: { k: [], v: [] } }, "k", { color: { column: "v" } }, lut);
  h.ok(none.legend === null && /no rows/.test(none.issues[0]), "a table without rows: an issue, no styling");
  // C6: a null key names no object; of two rows with one key the first is the object's.
  const dup: FluximgTable = { key: "k", columns: { k: ["a", "a", null, "b"], c: ["x", "y", "z", "y"] } };
  const ds = objectStyles(dup, "k", { color: { column: "c" } }, lut);
  h.ok(!ds.byKey.has("null") && ds.legend?.color?.kind === "category" && ds.legend.color.entries.map((e) => e.keys.join()).join("|") === "a|b|", "duplicate keys: the first row is the object's (listed once); a null key names nothing");
  h.eq(objectStyles(T, "source_id", null, lut).byKey.size, 0, "no request: nothing");
  h.eq(missingStyle({ color: { column: "x" } }), { color: DIM_COLOR, opacity: DIM_OPACITY }, "a shape with no row gets the missing style (dim)");
  h.eq(missingStyle({ color: { column: "x" }, missing: "hide" }), { hidden: true }, "…or hidden");
  const both = objectStyles(T, "source_id", { color: { column: "dendrite" }, opacity: { column: "pixels" } }, lut);
  h.eq(both.byKey.get("s1"), { color: DEFAULT_PALETTE[0], opacity: 0.6222 }, "both parts on one object");
  h.ok(cachedObjectStyles(T, "source_id", { color: { column: "dendrite" } }, lut) === cachedObjectStyles(T, "source_id", { color: { column: "dendrite" } }, lut), "cached per table object and request: asked again, the same result object");
  // B6: the cache is bounded. A 20,000-object table, a range dragged through 40 positions.
  const N = 20000, big: FluximgTable = { key: "k", columns: { k: Array.from({ length: N }, (_, i) => `o${i}`), v: Array.from({ length: N }, (_, i) => i % 997) } };
  for (let i = 0; i < 40; i++) cachedObjectStyles(big, "k", { color: { column: "v", range: [i, 1000] } }, lut);
  const stats = styleCacheStats(big);
  h.ok(stats.entries <= 3 && stats.bytes <= STYLE_CACHE_BYTES + 2 * N * 200, `a range dragged over 40 positions at 20,000 objects keeps ${stats.entries} results (${(stats.bytes / 1e6).toFixed(1)} MB), not 32`);
  const last = cachedObjectStyles(big, "k", { color: { column: "v", range: [39, 1000] } }, lut), before = styleWork.styles;
  h.ok(cachedObjectStyles(big, "k", { color: { column: "v", range: [39, 1000] } }, lut) === last && styleWork.styles === before, "…and what is on screen stays cached (asked again: no recomputation)");
  // A1: column summaries once per table object.
  const s0 = styleWork.summaries;
  for (let i = 0; i < 30; i++) columnSummaries(big);
  h.eq(styleWork.summaries - s0, 1, "column summaries: computed once per table, then looked up (30 asks, 1 computation)");
  // C8: one rule for what a layer can be styled by.
  h.eq(styleColumnNames(T, { kind: "labels", key: "source_id" }), ["dendrite", "pixels"], "a label layer is styled by its columns, never by what names an object (key, label)");
  h.eq(columnSummaries(T, { kind: "labels", key: "source_id" }).map((c) => c.name), ["dendrite", "pixels"], "…the summaries the board, the Inspector and image-info list");
  h.eq(styleColumnNames({ key: "k", columns: { k: [], other_key: [], v: [] } }, { kind: "vector", key: "other_key" }), ["v"], "…nor by the layer's own key column when the table's key differs");
  // B5: hidden objects have no names.
  h.eq(shownObjects([{ key: "s1" }, { key: "s7" }, { key: "zz" }], objectStyles(T, "source_id", { color: { column: "dendrite" }, missing: "hide" }, lut).byKey, { hidden: true }).map((o) => o.key), ["s1"], "names are drawn only for objects that are drawn (hidden: s7, and zz without a row)");
  // B2: a preview is the model plus one override.
  h.eq(previewStyleBy({ color: { column: "pixels", range: [1, 2] }, opacity: { column: "pixels" } }, "color", "dendrite"), { color: { column: "dendrite" }, opacity: { column: "pixels" } }, "a preview sets one part on the current styling");
  h.eq(previewStyleBy({ color: { column: "pixels", range: [1, 2] } }, "color", "pixels"), { color: { column: "pixels", range: [1, 2] } }, "…the chosen column keeps its settings");
  h.eq(previewStyleBy({ color: { column: "pixels" } }, "color", null), null, "…none: nothing styled");
  h.eq(describeStyleBy("footprints", { color: { column: "dendrite" }, opacity: { column: "pixels" } }), "footprints coloured by dendrite, opacity by pixels", "in words");
  h.eq(describeStyleBy("footprints", { color: { column: "gone" }, opacity: { column: "pixels" } }, objectStyles(T, "source_id", { color: { column: "gone" }, opacity: { column: "pixels" } }, lut).issues),
    `footprints opacity by pixels; footprints: styling not applied (colour: no column "gone" in the table (it has "label", "dendrite", "pixels"))`, "B4: a column the table lacks is said, never claimed");
  h.eq(columnSummaries(T).map((c) => [c.name, c.kind, c.distinct, c.range, c.missing]), [["label", "number", 4, [1, 7], 0], ["dendrite", "category", 2, null, 1], ["pixels", "number", 4, [5, 32], 0]], "column summaries (what image-info lists): kind, distinct values, range, missing");
  h.eq(columnHistogram([0, 1, 1, 2], 2)?.counts, [1, 3], "a column's distribution for the board's strip");
}

h.section("E. the legend");
{
  const c = objectStyles(T, "source_id", { color: { column: "dendrite" } }, lut).legend!;
  h.eq(c.color?.kind === "category" ? c.color.entries.map((e) => [e.label, e.color, e.count, e.keys]) : null, [["d1", DEFAULT_PALETTE[0], 2, ["s1", "s2"]], ["d2", DEFAULT_PALETTE[1], 1, ["s3"]]], "categories with their colours, counts and objects");
  h.eq(c.missing && [c.missing.mode, c.missing.count, c.missing.keys], ["dim", 1, ["s7"]], "objects without a value, counted");
  const n = objectStyles(T, "source_id", { color: { column: "pixels", lut: "magma", reverse: true } }, lut).legend!;
  h.ok(n.color?.kind === "number" && n.color.column === "pixels" && n.color.lut === "magma" && n.color.reverse && n.color.range[0] === 5 && n.color.range[1] === 32 && n.color.stops.length === 9, "a numeric column: its map, direction, range and nine colour stops");
  h.ok(n.color?.kind === "number" && n.color.stops[0] === numberColor(styleTable("magma", true, lut), [0, 1], 0), "…the stops are the same table (reversed)");
}

h.section("F. the view field: resolveView, patchView, viewCheck, pixelKey");
{
  const rv = resolveView(M, { layers: { footprints: { styleBy: { color: { column: "dendrite", range: [3, 1], palette: ["#f00", "x"], lut: "" }, missing: "hide" } }, activity: { styleBy: { color: { column: "x" } } } as never, discs: { styleBy: { color: { column: "x" } } } } });
  h.eq(rv.layers.find((l) => l.id === "footprints")?.styleBy, { color: { column: "dendrite", palette: ["#f00"] }, missing: "hide" }, "resolveView keeps the request, leniently (a bad range, a bad palette entry and an empty map name dropped)");
  h.eq([rv.layers.find((l) => l.id === "activity")?.styleBy, rv.layers.find((l) => l.id === "discs")?.styleBy], [null, null], "an intensity layer, or a vector layer without a table, has nothing to style by");
  h.eq(resolveView(M, {}).layers.map((l) => l.styleBy), M.layers.map(() => null), "absent: null on every layer");
  h.eq(resolveView(M, { layers: { footprints: { styleBy: { missing: "hide" } } } }).layers.find((l) => l.id === "footprints")?.styleBy, null, "missing alone styles nothing");
  let v = patchView({}, { layers: { footprints: { styleBy: { color: { column: "pixels", range: [5, 20] } } } } });
  v = patchView(v, { layers: { footprints: { styleBy: { color: { lut: "magma" } as never } } } });
  h.eq(v.layers?.footprints?.styleBy, { color: { column: "pixels", range: [5, 20], lut: "magma" } }, "styleBy merges per key: a colour field joins the column it styles by");
  v = patchView(v, { layers: { footprints: { styleBy: { opacity: { column: "pixels" } } } } });
  h.eq(v.layers?.footprints?.styleBy, { color: { column: "pixels", range: [5, 20], lut: "magma" }, opacity: { column: "pixels" } }, "…opacity joins colour");
  v = patchView(v, { layers: { footprints: { styleBy: { color: { column: "dendrite" } } } } });
  h.eq(v.layers?.footprints?.styleBy?.color, { column: "dendrite" }, "another column starts that part afresh (a range belongs to the column it was chosen for)");
  v = patchView(v, { layers: { footprints: { styleBy: { color: { column: "dendrite", range: null } as never } } } });
  h.eq(v.layers?.footprints?.styleBy?.color, { column: "dendrite" }, "null clears a field");
  v = patchView(v, { layers: { footprints: { styleBy: { color: null } } } });
  h.eq(v.layers?.footprints?.styleBy, { opacity: { column: "pixels" } }, "null clears a part");
  v = patchView(v, { layers: { footprints: { styleBy: { opacity: null } } } });
  h.eq(v, {}, "nothing left to style by: styleBy, the layer entry and the view are empty again");
  const w = patchView({ layers: { footprints: { opacity: 0.5, styleBy: { color: { column: "dendrite" } } } } }, { layers: { footprints: { styleBy: null } } });
  h.eq(w, { layers: { footprints: { opacity: 0.5 } } }, "styleBy: null removes it whole and keeps the layer's other settings");
  const a = resolveView(M, {}), b = resolveView(M, { layers: { footprints: { styleBy: { color: { column: "dendrite" } } } }, furniture: { key: {} } });
  const crop = { x: 0, y: 0, width: 90, height: 60 };
  h.eq(pixelKey(M, b, crop, 90, 60), pixelKey(M, a, crop, 90, 60), "pixelKey does not change: objects are vectors, never the still's pixels");

  const tables = { footprints: T };
  const check = (p: unknown, withTables = true) => checkViewPatch(M, p, withTables ? { tables } : {});
  h.eq(check({ layers: { footprints: { styleBy: { color: { column: "dendrite" }, opacity: { column: "pixels", to: [0.2, 1] }, missing: "hide" } } } }).problems, [], "a good request passes");
  h.ok(check({ layers: { footprints: { styleBy: { colour: {} } } } }).problems.some((p) => /unknown setting "colour"/.test(p)), "an unknown key is named");
  h.ok(check({ layers: { footprints: { styleBy: { color: { column: "pixels", range: [5, 1] } } } } }).problems.some((p) => /color.range/.test(p)), "a range with white below black is refused");
  h.ok(check({ layers: { footprints: { styleBy: { opacity: { column: "pixels", to: [0, 2] } } } } }).problems.some((p) => /opacity.to/.test(p)), "an opacity above 1 is refused");
  h.ok(check({ layers: { footprints: { styleBy: { missing: "drop" } } } }).problems.some((p) => /missing/.test(p)), "missing is dim or hide");
  h.ok(check({ layers: { footprints: { styleBy: { color: { column: "nope" } } } } }).problems.some((p) => /no column "nope".*"dendrite"/.test(p)), "with the table at hand, an unknown column is refused, naming the ones there are");
  h.eq(check({ layers: { footprints: { styleBy: { color: { column: "nope" } } } } }, false).problems, [], "…without it, column names are not checked");
  h.ok(check({ layers: { footprints: { styleBy: { opacity: { column: "dendrite" } } } } }).problems.some((p) => /not numeric/.test(p)), "an opacity column that is not numeric is refused");
  h.ok(check({ layers: { footprints: { styleBy: { color: { column: "dendrite", lut: "magma" } } } } }).warnings.some((p) => /categorical/.test(p)), "a colour map on a categorical column is a warning (it does not apply)");
  h.ok(check({ layers: { discs: { styleBy: { color: { column: "x" } } } } }).problems.some((p) => /no table/.test(p)), "a layer without a table is refused");
  h.ok(check({ layers: { activity: { styleBy: {} } } }).problems.some((p) => /unknown setting "styleBy"/.test(p)), "an intensity layer has no styleBy");
  h.eq(check({ furniture: { key: { layer: "footprints", corner: "bottom-left", fontSize: 7 } } }).problems, [], "the key furniture is accepted");
  h.ok(check({ furniture: { key: { layer: "activity" } } }).problems.some((p) => /furniture.key.layer/.test(p)), "…naming an object layer only");
  h.ok(check({ furniture: { key: { layer: "discs" } } }).problems.some((p) => /not a layer with a table/.test(p)), "…and one with a table (a vector layer without one is refused)");
  const many = { footprints: { key: "source_id", columns: { source_id: T.columns.source_id, c: Array.from({ length: 4 }, (_, i) => `v${i}`) } } };
  h.ok(checkViewPatch(M, { layers: { footprints: { styleBy: { color: { column: "c", palette: ["#ff0000", "#00ff00"] } } } } }, { tables: many }).warnings.some((x) => /share a colour/.test(x)), "more values than palette colours: a warning that some share one");
  h.ok(checkMergedView(M, { layers: { footprints: { styleBy: { color: { lut: "magma" } as never } } } }).some((p) => /needs a "column"/.test(p)), "a part assembled without a column is refused after the merge");
  const rk = resolveView(M, { furniture: { key: {} } }).furniture.key;
  h.eq(rk, { layer: null, corner: "top-right", color: "#ffffff", fontSize: 6 }, "the key's defaults: the topmost styled layer, top right, white, 6 pt");
}

// A hand view: only footprints shown, 2 px outlines, no fill, for pixel checks.
const box = { width: 180, height: 120 }, full = { x: 0, y: 0, width: 90, height: 60 };
const styledView = (styleBy: FluximgStyleBy | null, furniture: Partial<ResolvedView["furniture"]> = {}, over: Record<string, unknown> = {}): ResolvedView => {
  const rv = resolveView(M, { background: "#000000" });
  rv.layers = rv.layers.map((l) => ({ ...l, visible: l.id === "footprints", strokeWidth: 2, fillOpacity: 0, styleBy: l.id === "footprints" ? styleBy : null, ...(l.id === "footprints" ? over : {}) }));
  rv.furniture = { ...rv.furniture, ...furniture };
  return rv;
};

h.section("G. drawing: per-object presentation attributes");
{
  const lv = styledView({ color: { column: "dendrite" } }).layers.find((l) => l.id === "footprints")!;
  const s = objectStyles(T, "source_id", lv.styleBy, lut);
  const m = layerMarkup(footprints, footprintsSvg, lv, full, box, "p-", s.byKey, missingStyle(lv.styleBy));
  const shape = (key: string): string => new RegExp(`<path id="p-footprints/${key}"[^>]*/>`).exec(m)?.[0] ?? "";
  h.ok(shape("s1").includes(`stroke="${DEFAULT_PALETTE[0]}"`) && shape("s3").includes(`stroke="${DEFAULT_PALETTE[1]}"`), "each outline's stroke is its category's colour");
  h.ok(shape("s1").includes(`fill="${DEFAULT_PALETTE[0]}"`), "…and its fill (a label layer is filled, faintly), so the fill tint follows the object");
  h.ok(shape("s7").includes(`stroke="${DIM_COLOR}"`) && shape("s7").includes(`opacity="${DIM_OPACITY}"`), "the null one: grey, at the dim opacity");
  h.ok(!/style=|vector-effect|class=/.test(m), "plain attributes only: no style, no vector-effect, no class");
  h.ok(/<g [^>]*stroke-width="[^"]+"[^>]*fill-opacity="0"/.test(m) || /<g [^>]*fill-opacity="0"[^>]*stroke-width/.test(m), "the layer's own stroke width and fill opacity still apply on the group");
  const coloured = layerMarkup(footprints, footprintsSvg, { ...lv, color: "#ff0000" }, full, box, "p-", s.byKey, missingStyle(lv.styleBy));
  h.ok(/id="p-footprints\/s1"[^>]*stroke="#4385be"/.test(coloured) && /data-layer="footprints"[^>]*stroke="#ff0000"/.test(coloured), "a per-object colour wins over the layer colour (which stays the group's)");
  const hidden = layerMarkup(footprints, footprintsSvg, lv, full, box, "p-", objectStyles(T, "source_id", { color: { column: "dendrite" }, missing: "hide" }, lut).byKey, { hidden: true });
  h.ok(!hidden.includes('data-key="s7"') && hidden.includes('data-key="s1"'), "missing: hide leaves the shape out");
  const plain = layerMarkup(footprints, footprintsSvg, { ...lv, styleBy: null }, full, box, "p-");
  h.eq(layerMarkup(footprints, footprintsSvg, { ...lv, styleBy: null }, full, box, "p-", null, null), plain, "no styles: byte for byte the markup it always was");
  const op = layerMarkup(footprints, footprintsSvg, lv, full, box, "p-", objectStyles(T, "source_id", { opacity: { column: "pixels" } }, lut).byKey, null);
  h.ok(/id="p-footprints\/s7"[^>]*opacity="0.15"/.test(op) && /id="p-footprints\/s2"[^>]*opacity="1"/.test(op) && !/id="p-footprints\/s2"[^>]*stroke=/.test(op), "opacity by a column: the shape's own opacity attribute, colour untouched");
  const noTable = fluximgStaticSvg({ manifest: M, view: styledView({ color: { column: "dendrite" } }), crop: full, box, stillHref: null, layerSvg: { footprints: footprintsSvg }, idPrefix: "q-" });
  const unstyled = fluximgStaticSvg({ manifest: M, view: styledView(null), crop: full, box, stillHref: null, layerSvg: { footprints: footprintsSvg }, idPrefix: "q-" });
  h.eq(noTable, unstyled, "styled but without its table: drawn exactly as unstyled (never all \"missing\")");
  // B5: an object hidden by missing: "hide" has no name.
  const hideNames = fluximgStaticSvg({ manifest: M, view: styledView({ color: { column: "dendrite" }, missing: "hide" }, { names: { layers: ["footprints"], fontSize: 6 } }), crop: full, box, stillHref: null, layerSvg: { footprints: footprintsSvg }, idPrefix: "q-", tables: { footprints: T } });
  h.ok(/id="q-name.footprints\/s1"/.test(hideNames) && !/id="q-name.footprints\/s7"/.test(hideNames) && !/data-key="s7"/.test(hideNames), "B5: hidden by missing: \"hide\", s7 has neither outline nor name");
  const unknown = fluximgStaticSvg({ manifest: M, view: styledView({ color: { column: "nope" } }), crop: full, box, stillHref: null, layerSvg: { footprints: footprintsSvg }, idPrefix: "q-", tables: { footprints: T } });
  h.eq(unknown, unstyled, "a column the table lacks: drawn unstyled too");
}

h.section("H. the key");
{
  const legends = { footprints: objectStyles(T, "source_id", { color: { column: "dendrite" } }, lut).legend };
  const rv = styledView({ color: { column: "dendrite" } }, { key: { layer: null, corner: "top-right", color: "#ffffff", fontSize: 6 } });
  h.eq(keyLayer(rv, legends), "footprints", "the key describes the topmost shown styled layer");
  h.eq(keyLayer({ ...rv, layers: rv.layers.map((l) => ({ ...l, visible: false })) }, legends), null, "…and nothing when that layer is hidden");
  const k = furnitureSvg(M, rv, full, box, "k-", lut, legends);
  h.ok(/data-part="key"/.test(k) && /data-part="key.title"[^>]*>dendrite</.test(k), "on: a group titled with the column's name");
  h.eq([...k.matchAll(/data-part="key.entry"[^>]*data-legend-row="([^"]+)"/g)].map((x) => x[1]), ["0", "1", "missing"], "one row per category, then \"no value\"");
  h.ok(new RegExp(`<rect [^>]*fill="${DEFAULT_PALETTE[0]}"`).test(k) && />d1</.test(k) && />no value</.test(k), "swatches in the categories' colours, with their values");
  h.eq(furnitureSvg(M, { ...rv, furniture: { ...rv.furniture, key: false } }, full, box, "k-", lut, legends), "", "off: nothing");
  const many: FluximgTable = { key: "source_id", columns: { source_id: T.columns.source_id, kind: ["a", "b", "c", "d"] } };
  const longLegend = objectStyles({ key: "k", columns: { k: Array.from({ length: 20 }, (_, i) => `o${i}`), c: Array.from({ length: 20 }, (_, i) => `c${i}`) } }, "k", { color: { column: "c" } }, lut).legend;
  const kl = furnitureSvg(M, rv, full, box, "k-", lut, { footprints: longLegend });
  h.eq([[...kl.matchAll(/data-part="key.entry"/g)].length, />\+8 more</.test(kl)], [KEY_MAX_ROWS, true], `at most ${KEY_MAX_ROWS} rows, then "+N more"`);
  const rows12 = [...kl.matchAll(/data-legend-row="\d+"><rect [^>]*fill="([^"]+)"/g)].map((m) => m[1]);
  h.eq(new Set(rows12).size, KEY_MAX_ROWS, "B3: the key's rows never repeat a swatch (12 rows, 12 colours)");
  const repLegend = objectStyles({ key: "k", columns: { k: Array.from({ length: 30 }, (_, i) => `o${i}`), c: Array.from({ length: 30 }, (_, i) => `c${i}`) } }, "k", { color: { column: "c" } }, lut).legend;
  h.ok(/\+18 more share colours/.test(furnitureSvg(M, rv, full, box, "k-", lut, { footprints: repLegend })), "past the palette, the key says the rest share colours");
  const short = objectStyles(T, "source_id", { color: { column: "dendrite", palette: ["#ff0000"] } }, lut).legend;
  h.ok(/some values share a colour/.test(furnitureSvg(M, rv, full, box, "k-", lut, { footprints: short })), "…and so does a short own palette");
  void many;
  const num = furnitureSvg(M, rv, full, box, "k-", lut, { footprints: objectStyles(T, "source_id", { color: { column: "pixels" } }, lut).legend });
  h.ok(/data-part="key.bar"/.test(num) && /linearGradient/.test(num) && />5</.test(num) && />32</.test(num) && !/key.entry/.test(num), "a numeric column: a gradient bar with its two end values, no rows");
  const fade = furnitureSvg(M, rv, full, box, "k-", lut, { footprints: objectStyles(T, "source_id", { opacity: { column: "pixels" } }, lut).legend });
  h.ok(/stop-opacity="0.15"/.test(fade) && /stop-opacity="1"/.test(fade), "opacity by a column: a fade bar from the faint end to the opaque one");
  const corners = ["top-left", "top-right", "bottom-left", "bottom-right"] as const;
  const xs = corners.map((c) => { const s = furnitureSvg(M, { ...rv, furniture: { ...rv.furniture, key: { ...rv.furniture.key as object, corner: c } as never } }, full, box, "k-", lut, legends); return { anchor: /key.title[^>]*text-anchor="(\w+)"/.exec(s)?.[1], ty: Number(/data-part="key"[^>]*translate\(0 ([\d.]+)\)/.exec(s)?.[1]) }; });
  h.ok(xs[0].anchor === "start" && xs[1].anchor === "end" && xs[0].ty < 30 && xs[2].ty > 50, "corners: words anchored away from the edge, top or bottom as asked");
  h.ok(!/style=|vector-effect|dominant-baseline/.test(k), "explicit sizes and baselines: no style, no vector-effect, no dominant-baseline");
}

h.section("I. rasterised by resvg");
{
  const at = (img: { width: number; pixels: Uint8Array }, x: number, y: number): [number, number, number] => { const i = (y * img.width + x) * 4; return [img.pixels[i], img.pixels[i + 1], img.pixels[i + 2]]; };
  const near = (p: number[], q: number[], tol = 3): boolean => p.every((v, i) => Math.abs(v - q[i]) <= tol);
  const doc = (inner: string): string => `<svg xmlns="http://www.w3.org/2000/svg" width="180" height="120" viewBox="0 0 180 120">${inner}</svg>`;
  const s = fluximgStaticSvg({ manifest: M, view: styledView({ color: { column: "dendrite" } }), crop: full, box, stillHref: null, layerSvg: { footprints: footprintsSvg }, idPrefix: "", tables: { footprints: T }, resolveLut: lut });
  const img = new Resvg(doc(s), { font: { loadSystemFonts: false } }).render();
  // s1 covers image x 14..19, y 12..16 → box x 28..38, y 24..32: its 2 px edge, d1's colour.
  h.ok(near(at(img, 28, 28), hex(DEFAULT_PALETTE[0])) && near(at(img, 37, 28), hex(DEFAULT_PALETTE[0])), `resvg draws s1's outline in d1's colour (${at(img, 28, 28)})`);
  // s3: image x 50..53 y 30..33 → box x 100.., y 60..: d2.
  h.ok(near(at(img, 100, 62), hex(DEFAULT_PALETTE[1])), `…s3 in d2's (${at(img, 100, 62)})`);
  // s7: (40,20) → box (40, 80): grey at the dim opacity over what is under it (no still here: the placeholder).
  const under = at(img, 36, 78), dim = hex(DIM_COLOR).map((c, i) => Math.round(under[i] + (c - under[i]) * DIM_OPACITY));
  h.ok(near(at(img, 40, 81), dim, 2), `…and the null one grey and faint (${at(img, 40, 81)} ≈ ${dim}, over ${under})`);
  // The key: its first swatch, in d1's colour.
  const k = fluximgStaticSvg({ manifest: M, view: styledView({ color: { column: "dendrite" } }, { key: { layer: null, corner: "bottom-left", color: "#ffffff", fontSize: 10 } }), crop: full, box, stillHref: null, layerSvg: { footprints: footprintsSvg }, idPrefix: "", tables: { footprints: T }, resolveLut: lut });
  const g = /data-part="key"[^>]*translate\(0 ([\d.]+)\)/.exec(k), r0 = /data-legend-row="0"><rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)"/.exec(k);
  const kimg = new Resvg(doc(k), { font: { loadSystemFonts: false } }).render();
  const cx = Math.round(Number(r0?.[1]) + Number(r0?.[3]) / 2), cy = Math.round(Number(g?.[1]) + Number(r0?.[2]) + Number(r0?.[3]) / 2);
  h.ok(!!g && !!r0 && near(at(kimg, cx, cy), hex(DEFAULT_PALETTE[0])), `resvg draws the key's first swatch in d1's colour at (${cx}, ${cy}): ${at(kimg, cx, cy)}`);
}

h.section("J. the export context reads a table only for a styled layer");
{
  const asset = { id: "a1", kind: "fluximg", path: "assets/a1.fluximg", name: "img", sha256: "0".repeat(64) } as never;
  const element = (view: unknown) => ({ id: "e1", type: "fluximg", assetId: "a1", x: 0, y: 0, width: 180, height: 120, rotation: 0, view }) as never;
  const figure = (el: unknown) => [{ id: "f1", name: "F", x: 0, y: 0, width: 400, height: 300, elements: [el] }] as never;
  let tableReads = 0;
  const io = {
    manifest: async () => M,
    still: async () => "data:image/png;base64,AA==",
    text: async (_a: unknown, p: string) => fsp.readFile(path.join(dir, p), "utf8"),
    table: async (_a: unknown, p: string) => { tableReads++; return JSON.parse(await fsp.readFile(path.join(dir, p), "utf8")) as FluximgTable; },
  };
  const plainView = { layers: { footprints: { visible: true } } };
  const plainCtx = await prepareFluximgContext(figure(element(plainView)), [asset], io, { surface: "svg" });
  h.eq(tableReads, 0, "no styled layer: no table is read");
  const styled = { layers: { footprints: { visible: true, styleBy: { color: { column: "dendrite" } } } }, furniture: { key: {} } };
  const ctx = await prepareFluximgContext(figure(element(styled)), [asset], io, { surface: "svg" });
  h.eq(tableReads, 1, "a styled layer: its table, once");
  const markup = fluximgElementMarkup(element(styled), ctx);
  h.ok(new RegExp(`data-key="s1"[^>]*stroke="${DEFAULT_PALETTE[0]}"`).test(markup) && /data-part="key"/.test(markup), "the element's export markup carries the per-object colours and the key");
  h.ok(!/data-part="key"/.test(fluximgElementMarkup(element(plainView), plainCtx)), "…which an unstyled element does not have");
  // B4: styling that cannot apply is reported by the export, not silent.
  const said: string[] = [];
  await prepareFluximgContext(figure(element({ layers: { footprints: { visible: true, styleBy: { color: { column: "gone" } } } } })), [asset], io, { surface: "svg", onIssue: (_e, m) => said.push(m) });
  h.ok(said.length === 1 && /no column "gone"/.test(said[0]) && /drawn without that styling/.test(said[0]), `B4: a styled column the table lacks is an export warning (${said[0]?.slice(0, 90)}…)`);
}

h.section("K. the default palette is fluxplot's dark cycle");
{
  const flexoki = PALETTE_COLLECTIONS.find((c) => c.id === "flexoki")!;
  const hexOf = (name: string): string => { for (const g of (flexoki as unknown as { groups: Array<{ swatches: Array<{ name: string; hex: string }> }> }).groups) for (const s of g.swatches) if (s.name === name) return s.hex.toLowerCase(); return ""; };
  // fluxplot style.py: CYCLE_ORDER = blue, orange, purple, green, magenta, yellow, cyan, red; CYCLE_DARK = the 400 weights.
  const order = ["blue", "orange", "purple", "green", "magenta", "yellow", "cyan", "red"];
  h.eq(DEFAULT_PALETTE.slice(0, 8), order.map((c) => hexOf(`${c}-400`)), "first the Flexoki 400 weights in fluxplot's colour-blind-safe cycle order (CYCLE_DARK)");
  h.eq(DEFAULT_PALETTE.slice(8, 16), order.map((c) => hexOf(`${c}-200`)), "then the same hues in the same order at the 200 weight");
  h.eq(DEFAULT_PALETTE.slice(16, 24), order.map((c) => hexOf(`${c}-600`)), "then at the 600 weight (fluxplot's CYCLE_LIGHT)");
}

await h.done(async () => { await fsp.rm(tmp, { recursive: true, force: true }); });
