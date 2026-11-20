// The property menu's look, the pure half (2026-11-20 redesign): how interact/menuLook.ts lays the field model
// out (rows, pairs, keys on the group head, columns) and which instrument draws a number; and the measure the
// canvas draws on the object for a geometric row (interact/measure.ts).
//
// Pure tier. Hermetic: no browser, no project. It also reads interact/propertyMenu.ts and
// interact/elementProperties.ts as TEXT, so a new on/off property without a mark, or a renamed numeric property
// the look keys on, fails here and not on a screen.
// Run: node --import tsx scripts/verify-fmenu-look.ts
import { readFileSync } from "node:fs";
import { harness } from "./lib/harness.mjs";
import {
  MENU, MENU_GLYPHS, actionGlyph, instrumentOf, looksOf, measureOf, menuColumns, menuLines, menuWidth, rangeOf, shortNum, toggleGlyph, toggleWord, valueAtFraction,
  type LookField,
} from "../src/lib/interact/menuLook";
import { measureDrawing } from "../src/lib/interact/measure";
import { numericFraction } from "../src/lib/interact/numericStep";

const h = harness("verify-fmenu-look");
const num = (key: string, label: string, group: string, prop?: string, range: Partial<LookField> = {}): LookField => ({ key, label, group, kind: "number", prop, ...range });
const tog = (key: string, label: string, group: string): LookField => ({ key, label, group, kind: "toggle" });
const groupsOf = (fs: LookField[]) => { const out: { name: string; fields: LookField[] }[] = []; for (const f of fs) { let g = out.find((o) => o.name === f.group); if (!g) out.push(g = { name: f.group, fields: [] }); g.fields.push(f); } return out; };

// The owner's scenario: one rectangle, as the field model lists it.
const RECT: LookField[] = [
  num("x", "x position", "Geometry", "x"), num("z", "y position", "Geometry", "y"), num("w", "width", "Geometry", "width", { min: 1 }), num("e", "height", "Geometry", "height", { min: 1 }),
  tog("1", "lock aspect ratio", "Geometry"), num("r", "rotation", "Geometry", "rotation", { softMin: -180, softMax: 180 }), num("a", "opacity", "Geometry", "opacity", { min: 0, max: 1 }),
  { key: "c", label: "fill color", group: "Fill", kind: "color" }, tog("2", "no fill (outline only)", "Fill"), num("v", "corner radius", "Fill", "cornerRadius", { min: 0, softMax: 120 }),
  { key: "g", label: "stroke color", group: "Stroke", kind: "color" }, num("d", "stroke width", "Stroke", "strokeWidth", { min: 0, softMax: 24 }), tog("3", "no stroke", "Stroke"), tog("4", "dashed stroke", "Stroke"),
  num("b", "fill opacity", "Fill", "fillOpacity", { min: 0, max: 1 }), num("t", "stroke opacity", "Stroke", "strokeOpacity", { min: 0, max: 1 }),
  { key: "`", label: "save as preset…", group: "Presets", kind: "action" },
];

h.section("layout: rows, pairs, keys on the group head");
{
  const looks = looksOf(groupsOf(RECT));
  h.eq(looks.map((g) => g.name), ["Geometry", "Fill", "Stroke", "Presets"], "groups keep the field model's order");
  const geo = looks[0];
  h.eq(geo.keys.map((f) => f.key), ["1"], "an on/off property is a key on its group's head (lock aspect ratio)");
  h.eq(geo.rows.map((r) => `${r.f.key}${r.half || ""}`), ["x1", "w2", "z1", "e2", "r", "a"], "position pairs with size: x | width over y | height, then the rest in order");
  h.eq(geo.rows.filter((r) => r.half).map((r) => r.lead ?? r.f.label), ["x", "width", "y", "height"], "a paired cell leads with one word (x, y); width and height say themselves");
  h.ok(geo.rows.every((r) => !r.lead || r.f.label.startsWith(r.lead)), "…and the lead is the START of the full label, which stays in the cell to be read");
  h.eq(looks[1].keys.map((f) => f.key).concat(looks[2].keys.map((f) => f.key)), ["2", "3", "4"], "no fill; no stroke and dashed: keys on Fill and Stroke");
  h.eq(looks[1].rows.map((r) => r.f.key), ["c", "v", "b"], "Fill's rows keep their order without the key");
  h.ok(looks[3].bare && !looks[0].bare, "a group that is one 'run this' row stands without a head (Presets)");
  const every = looks.flatMap((g) => [...g.keys, ...g.rows.map((r) => r.f)]);
  h.eq(every.map((f) => f.key).sort(), RECT.map((f) => f.key).sort(), "every field is shown exactly once");
  h.eq(menuLines(looks), 14, "the rectangle takes 14 lines (3 heads, 2 paired lines, 9 rows)");
  h.eq(menuColumns(menuLines(looks), looks.length, 1500, 950), 1, "…one column");
  // a line: position only, no box
  const line = looksOf(groupsOf([num("x", "x position", "Geometry", "x"), num("z", "y position", "Geometry", "y"), num("r", "rotation", "Geometry", "rotation")]));
  h.eq(line[0].rows.map((r) => `${r.f.key}${r.half || ""}`), ["x1", "z2", "r"], "without a box, x and y share one line");
  // a plot part: no geometry to pair
  const part = looksOf(groupsOf([num("e", "size", "Plot part", "fontSize", { min: 0.5, softMax: 40 }), tog("q", "italic", "Plot part"), num("x", "dx (plot units)", "Plot part", "dx"), num("z", "dy (plot units)", "Plot part", "dy"), tog("v", "visible", "Plot part")]));
  h.eq(part[0].rows.map((r) => `${r.f.key}${r.half || ""}`), ["e", "x", "z"], "a part's dx / dy are not a position: they stay rows");
  h.eq(part[0].keys.map((f) => f.key), ["q", "v"], "…and its italic and visible are keys");
  // pairs that do not lead their group stand where the first of them stood
  const mid = looksOf(groupsOf([{ key: "t", label: "text", group: "G", kind: "text" }, num("x", "x position", "G", "x"), num("a", "opacity", "G", "opacity", { min: 0, max: 1 }), num("z", "y position", "G", "y")]));
  h.eq(mid[0].rows.map((r) => `${r.f.key}${r.half || ""}`), ["t", "x1", "z2", "a"], "a pair stands where its first member stood");
}

h.section("columns: never a scroll");
{
  h.eq(menuWidth(1), 272, "one column is 272 px wide");
  h.eq([menuWidth(2), menuWidth(3)], [540, 808], "two and three columns");
  h.eq(menuColumns(13, 4, 1500, 950), 1, "13 lines: one column");
  h.eq(menuColumns(30, 5, 1500, 950), 2, "30 lines: two");
  h.eq(menuColumns(50, 8, 1500, 950), 3, "50 lines: three");
  h.eq(menuColumns(20, 3, 1500, 420), 2, "a short window takes a second column instead of scrolling");
  h.eq(menuColumns(50, 8, 500, 950), 1, "a narrow window holds one column however many lines");
  h.eq(menuColumns(50, 8, 700, 950), 2, "…and two when two fit");
  let fits = true;
  for (let lines = 1; lines <= 60; lines++) for (const vh of [500, 700, 950, 1200]) { const c = menuColumns(lines, 4, 1500, vh); if (c < 3 && (lines * MENU.row + 40) / c > vh - MENU.chrome - 16 + MENU.row * 2) fits = false; }
  h.ok(fits, "with room for three columns, the lines of a column fit the window's height");
}

h.section("instruments: each number is drawn by the property it sets");
{
  const by = (key: string) => RECT.find((f) => f.key === key)!;
  h.eq(["a", "b", "t"].map((k) => instrumentOf(by(k))), ["fader", "fader", "fader"], "the three opacities are faders");
  h.eq(instrumentOf(by("r")), "dial", "rotation is a dial");
  h.eq(instrumentOf(by("v")), "corner", "corner radius is a corner");
  h.eq(instrumentOf(by("d")), "weight", "stroke width is a sample of the line");
  h.eq(["x", "z", "w", "e"].map((k) => instrumentOf(by(k))), [null, null, null, null], "position and size are plain numbers");
  h.eq(instrumentOf(num("5", "dash length", "Stroke", undefined, { min: 0.5, softMax: 40 })), "track", "any other ranged number gets a track");
  h.eq(instrumentOf(num("e", "size", "Plot part", "fontSize", { min: 0.5, softMax: 40 })), "track", "a part's font size too");
  h.eq(instrumentOf(num("x", "dx (plot units)", "Plot part", "dx")), null, "an open-ended number has no instrument");
  h.eq([instrumentOf(num("q", "Azimuth°", "3D view", "orbitAzimuth", { softMin: -180, softMax: 180 })), instrumentOf(num("t", "Elevation°", "3D view", "orbitElevation", { min: -90, max: 90 }))], ["dial", "track"], "a whole-turn angle is a dial; a half-turn one keeps its track");
  h.eq(instrumentOf(by("c")), null, "a colour is not a number");
  h.eq(rangeOf(by("v")), { min: 0, max: 120 }, "a soft maximum closes the range");
  h.eq(rangeOf(by("w")), null, "a one-sided range is no range");
  h.eq(["x", "z", "w", "e", "r", "v"].map((k) => measureOf(by(k))), ["x", "y", "width", "height", "rotation", "cornerRadius"], "the canvas can measure position, size, rotation and corner radius");
  h.eq([measureOf(by("a")), measureOf(by("c")), measureOf(null)], [null, null, null], "…and nothing else");
}

h.section("numbers at rest; a value from a fraction of the range");
{
  h.eq([26.024712, 119.689177, 0, 1, 0.85, -12.5, 0.005, NaN].map(shortNum), ["26.02", "119.69", "0", "1", "0.85", "-12.5", "0.01", "0"], "two decimals at rest, no trailing zeros");
  h.eq([0, 0.5, 1, -1, 2].map((t) => valueAtFraction(t, 0, 1, 0.05)), [0, 0.5, 1, 0, 1], "the ends of a fader are the ends of its range");
  h.eq(valueAtFraction(0.333, 0, 1, 0.05), 0.35, "a value lands on the field's step");
  h.eq(valueAtFraction(0.26, -180, 180, 1), -86, "a signed range");
  let inverse = true, on = true;
  for (let i = 0; i <= 200; i++) { const t = i / 200, v = valueAtFraction(t, 0.5, 40, 0.5); if (Math.abs(numericFraction(v, 0.5, 40) - t) > 0.5 / 39.5 / 2 + 1e-9) inverse = false; if (Math.abs(v / 0.5 - Math.round(v / 0.5)) > 1e-9) on = false; }
  h.ok(inverse, "valueAtFraction inverts numericFraction to within half a step");
  h.ok(on, "…and every value is a whole number of steps");
  let geo = true;
  for (let i = 0; i <= 100; i++) { const t = i / 100, v = valueAtFraction(t, 0.02, 50, 1, 1.1); if (Math.abs(numericFraction(v, 0.02, 50, 1.1) - t) > 0.002) geo = false; }
  h.ok(geo, "a geometric field (a zoom factor) is inverted along its own curve");
}

h.section("marks: every on/off property and every action has one");
{
  const src = readFileSync("src/lib/interact/propertyMenu.ts", "utf8");
  // every `kind: "toggle"` field's label, whether the label is written before or after the kind
  const labels = new Set<string>();
  for (const m of src.matchAll(/label:\s*"([^"]+)",\s*group:\s*[^,]+,\s*kind:\s*"toggle"/g)) labels.add(m[1]);
  for (const m of src.matchAll(/label:\s*"([^"]+)",\s*\n\s*group:\s*[^,]+,\s*\n\s*kind:\s*"toggle"/g)) labels.add(m[1]);
  h.ok(labels.size >= 10, `the field model's on/off properties were found (${labels.size}: ${[...labels].join(", ")})`);
  const bare = [...labels].filter((l) => !toggleGlyph(l));
  h.eq(bare, [], "each has a mark of its own");
  h.ok([...labels].every((l) => { const g = toggleGlyph(l); return !!g && typeof MENU_GLYPHS[g] === "string" && MENU_GLYPHS[g].length > 0; }), "…that the menu can draw");
  h.eq(toggleGlyph("something new"), null, "an on/off property the look does not know has no mark…");
  h.eq([toggleWord("something new"), toggleWord("snap to grid (always)")], ["something new", "snap to"], "…and its key carries a short word instead");
  h.eq([actionGlyph("save as preset…"), actionGlyph("save group as preset… (3 items)"), actionGlyph("reset crop (show full content)"), actionGlyph("copy citation — Smith 2020"), actionGlyph("colour scale… (X-ray)")], ["preset", "preset", "crop", "copy", "go"], "actions: preset, crop, copy, and a plain go");
  // the numeric properties the look keys on exist under those names
  const props = readFileSync("src/lib/interact/elementProperties.ts", "utf8");
  for (const p of ["x", "y", "width", "height", "rotation", "opacity", "fillOpacity", "strokeOpacity", "cornerRadius", "strokeWidth", "orbitAzimuth", "orbitRoll"]) h.ok(new RegExp(`\\n\\s*${p}:\\s*\\{\\s*label:`).test(props), `numeric property "${p}" exists`);
  h.ok(/kind: "number",\s*\n\s*prop: name,/.test(src) && /kind: "number",\s*\n\s*prop,/.test(src), "element and part number fields carry their property name");
}

h.section("the measure on the object");
{
  const el = { x: 10, y: 20, width: 100, height: 50, rotation: 0, cornerRadius: 0 }, p = { x: 300, y: 200, zoom: 2 };
  const w = measureDrawing("width", el, p)!;
  h.eq(w.pill, { x: 300 + 10 * 2 + 100, y: 200 + 20 * 2 + 100 + 16, text: "100" }, "width: its value sits under the middle of the foot");
  h.ok(w.d.startsWith("M320 356L520 356"), `…on a line as long as the object on screen (${w.d.slice(0, 20)})`);
  const hh = measureDrawing("height", el, p)!;
  h.eq(hh.pill, { x: 320 - 16, y: 240 + 50, text: "50" }, "height: at the left side, half way up");
  const x = measureDrawing("x", el, p)!;
  h.eq(x.pill, { x: (300 + 320) / 2, y: 290, text: "10" }, "x: from the figure's left edge to the object, at its mid-height");
  h.ok(x.d.startsWith("M300 290H320"), "…a level line from the figure's edge");
  const y = measureDrawing("y", el, p)!;
  h.eq(y.pill, { x: 420, y: (200 + 240) / 2, text: "20" }, "y: from the figure's top edge, at its mid-width");
  const r0 = measureDrawing("rotation", el, p)!;
  h.ok(r0.wedge === "" && r0.pill.text === "0°" && !!r0.dot, "rotation at zero: no wedge, the value, a dot at the middle");
  const r90 = measureDrawing("rotation", { ...el, rotation: 90 }, p)!;
  h.ok(r90.wedge.length > 0 && / 0 0 1 /.test(r90.wedge) && r90.pill.text === "90°", "a quarter turn: a wedge opening clockwise");
  h.ok(/ 0 0 0 /.test(measureDrawing("rotation", { ...el, rotation: -45 }, p)!.wedge), "…and anticlockwise for a negative turn");
  const turned = measureDrawing("width", { ...el, rotation: 90 }, p)!;
  h.ok(Math.abs(turned.pill.x - (420 - (50 + 16))) < 1e-6 && Math.abs(turned.pill.y - 290) < 1e-6, "the width's mark turns with the object (a quarter turn puts it at the side)");
  const c0 = measureDrawing("cornerRadius", el, p)!;
  h.ok(c0.dash === "" && c0.pill.text === "r 0", "corner radius zero: a bracket on the corner");
  const c = measureDrawing("cornerRadius", { ...el, cornerRadius: 10 }, p)!;
  h.ok(c.dash.includes("a20 20") && !!c.dot && c.dot.x === 340 && c.dot.y === 260 && c.pill.text === "r 10", "a radius: the circle that rounds the corner, centred one radius in");
  h.ok(measureDrawing("cornerRadius", { ...el, cornerRadius: 999 }, p)!.dash.includes("a50 50"), "…never larger than half the object");
  h.eq([measureDrawing("width", { x: 0, y: 0 }, p), measureDrawing("height", { x: 0, y: 0 }, p), measureDrawing("cornerRadius", { x: 0, y: 0 }, p)], [null, null, null], "an object without a box has no size to measure");
  h.ok(!!measureDrawing("x", { x: 5, y: 5 }, p) && !!measureDrawing("rotation", { x: 5, y: 5 }, p), "…but it has a position and a turn");
  h.eq(measureDrawing("x", { ...el, x: 26.024712 }, p)!.pill.text, "26.02", "the value is written as the menu shows it");
}

await h.done();
