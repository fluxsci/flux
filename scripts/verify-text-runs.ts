#!/usr/bin/env -S node --import tsx
// Per-RANGE text formatting (2026-09-22) — the pure contract of
// `src/lib/textRuns.ts` and everything downstream of it:
//
//   • normalization: runs are clamped, sorted, non-overlapping and merged, a
//     later run wins an overlap, and a flag that merely restates the element
//     is pruned — so an element with nothing to say carries NO `runs` field
//     and every pre-runs file stays byte-identical;
//   • toggling: a range that is entirely on turns off, anything else turns on,
//     against the element's own look as the inherited default;
//   • remapping: runs survive typing, pasting and deleting; text typed inside
//     a run joins it, text typed at either edge does not;
//   • layout: `blockLayout` cuts each VISUAL line into segments at run
//     boundaries — through the wrap cache, which means mapping wrapped lines
//     back onto text offsets — and a cache that cannot be mapped degrades to
//     an unformatted line rather than to wrong offsets;
//   • serialization: `export.ts` emits nested tspans carrying ONLY the
//     attributes that differ from the element, so the SVG for an unformatted
//     text is unchanged, and justification still rides the line tspan;
//   • persistence: runs round-trip through the fig writer and the load gate.
//
//   Run: node --import tsx scripts/verify-text-runs.ts

import {
  normalizeRuns,
  segmentRange,
  toggleRunRange,
  remapRuns,
  rangeIsOn,
  resolvedRunStyle,
  elementFlags,
  setRunColor,
  rangeColor,
  toggleScriptRange,
  rangeScript,
  scriptMetrics,
  type TextRun,
} from "../src/lib/textRuns";
import * as ops from "../src/lib/ops";
import { blockLayout } from "../src/lib/text";
import { textSvgLayout, elementToSvg } from "../src/lib/export";
import { harness } from "./lib/harness.mjs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as core from "../flux-core/index";
import { migrateProject } from "../src/lib/migrate";
import type { Project, TextElement } from "../src/lib/types";

const h = harness("verify-text-runs");
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const text = (extra: Partial<TextElement> = {}): TextElement =>
  ({
    id: "t1", type: "text", x: 10, y: 20, width: 100, height: 200, rotation: 0,
    text: "hello world", fontFamily: "Arial", fontSize: 10, fontWeight: 400,
    fontStyle: "normal", align: "left", color: "#000000", sizing: "fixed",
    ...extra,
  }) as TextElement;

// ---------------------------------------------------------------- normalize
{
  h.ok(eq(normalizeRuns(undefined, 10), []), "no runs normalizes to nothing");
  h.ok(eq(normalizeRuns([{ from: 4, to: 4, italic: true }], 10), []), "an empty range is dropped");
  h.ok(eq(normalizeRuns([{ from: 2, to: 99, italic: true }], 10), [{ from: 2, to: 10, italic: true }]),
    "an out-of-range end clamps to the text");
  h.ok(eq(normalizeRuns([{ from: -3, to: 4, bold: true }], 10), [{ from: 0, to: 4, bold: true }]),
    "a negative start clamps to zero");
  h.ok(eq(normalizeRuns([{ from: 5, to: 8, bold: true }, { from: 0, to: 3, bold: true }], 10),
    [{ from: 0, to: 3, bold: true }, { from: 5, to: 8, bold: true }]), "runs come back sorted");
  h.ok(eq(normalizeRuns([{ from: 0, to: 4, italic: true }, { from: 4, to: 7, italic: true }], 10),
    [{ from: 0, to: 7, italic: true }]), "adjacent runs with the same look merge");
  h.ok(eq(normalizeRuns([{ from: 0, to: 6, italic: true }, { from: 3, to: 9, italic: false }], 10),
    [{ from: 0, to: 3, italic: true }, { from: 3, to: 9, italic: false }]),
    "a later run wins the overlap it covers, and only that part");
  h.ok(eq(normalizeRuns([{ from: 0, to: 6, italic: true }, { from: 2, to: 4, bold: true }], 10),
    [{ from: 0, to: 2, italic: true }, { from: 2, to: 4, italic: true, bold: true },
     { from: 4, to: 6, italic: true }]), "overlapping runs compose per key");
  h.ok(eq(normalizeRuns([{ from: 1, to: 5 }], 10), []), "a run that says nothing is dropped");
  const base = elementFlags(text({ fontStyle: "italic" }));
  h.ok(eq(normalizeRuns([{ from: 1, to: 5, italic: true }], 10, base), []),
    "a run restating the element's own look is pruned");
  h.ok(eq(normalizeRuns([{ from: 1, to: 5, italic: false }], 10, base), [{ from: 1, to: 5, italic: false }]),
    "a run contradicting the element survives pruning");
}

// ----------------------------------------------------------------- segments
{
  const e = text({ text: "Homo sapiens here", runs: [{ from: 5, to: 12, italic: true }] });
  h.ok(eq(segmentRange(e.text, e.runs, 0, e.text.length).map((s) => s.text),
    ["Homo ", "sapiens", " here"]), "a range cuts into segments at the run boundaries");
  h.ok(eq(segmentRange(e.text, e.runs, 6, 8), [{ text: "ap", from: 6, to: 8, italic: true }]),
    "a range inside a run is one formatted segment carrying absolute offsets");
  h.ok(eq(segmentRange(e.text, undefined, 0, 4), [{ text: "Homo", from: 0, to: 4 }]),
    "an unformatted range is a single bare segment");
  h.ok(eq(segmentRange(e.text, e.runs, 3, 3), []), "an empty range has no segments");
}

// ------------------------------------------------------------------ toggles
{
  const plain = text({ text: "Homo sapiens here" });
  const runs = toggleRunRange(plain, 5, 12, "italic");
  h.ok(eq(runs, [{ from: 5, to: 12, italic: true }]), "toggling a plain range turns it on");
  const marked = text({ text: "Homo sapiens here", runs });
  h.ok(rangeIsOn(marked, 5, 12, "italic") && !rangeIsOn(marked, 0, 12, "italic"),
    "a range reads on only when every character is on");
  h.ok(eq(toggleRunRange(marked, 5, 12, "italic"), []), "toggling a fully-on range turns it off");
  h.ok(eq(toggleRunRange(marked, 0, 12, "italic"), [{ from: 0, to: 12, italic: true }]),
    "toggling a partly-on range turns the whole range on");
  const italicBox = text({ text: "Homo sapiens here", fontStyle: "italic" });
  h.ok(eq(toggleRunRange(italicBox, 0, 4, "italic"), [{ from: 0, to: 4, italic: false }]),
    "a word inside an italic box can be turned upright");
  h.ok(eq(toggleRunRange(plain, 4, 4, "bold"), []), "an empty selection changes nothing");
}

// ------------------------------------------------------------------ remap
{
  const runs: TextRun[] = [{ from: 5, to: 12, italic: true }];
  h.ok(eq(remapRuns(runs, "Homo sapiens here", "The Homo sapiens here"), [{ from: 9, to: 16, italic: true }]),
    "text inserted before a run shifts it");
  h.ok(eq(remapRuns(runs, "Homo sapiens here", "Homo sapiens there"), [{ from: 5, to: 12, italic: true }]),
    "text inserted after a run leaves it alone");
  h.ok(eq(remapRuns(runs, "Homo sapiens here", "Homo sapXiens here"), [{ from: 5, to: 13, italic: true }]),
    "text typed inside a run joins it");
  h.ok(eq(remapRuns(runs, "Homo sapiens here", "Homo Xsapiens here"), [{ from: 6, to: 13, italic: true }]),
    "text typed at a run's start stays outside it");
  h.ok(eq(remapRuns(runs, "Homo sapiens here", "Homo sapiensX here"), [{ from: 5, to: 12, italic: true }]),
    "text typed at a run's end stays outside it");
  h.ok(eq(remapRuns(runs, "Homo sapiens here", "Homo here"), []),
    "deleting a run's whole text deletes the run");
  h.ok(eq(remapRuns(runs, "Homo sapiens here", "Homo sap here"), [{ from: 5, to: 8, italic: true }]),
    "deleting a run's tail shortens it");
  h.ok(eq(remapRuns(runs, "Homo sapiens here", "Homo sapiens here"), [{ from: 5, to: 12, italic: true }]),
    "an edit that changed nothing preserves the runs");
}

// ------------------------------------------------------------------- layout
{
  const e = text({ text: "Homo sapiens here", runs: [{ from: 5, to: 12, italic: true }], sizing: "auto" });
  const [line] = blockLayout(e).lines;
  h.ok(eq(line.segments?.map((s) => [s.text, s.italic ?? null]),
    [["Homo ", null], ["sapiens", true], [" here", null]]),
    "blockLayout cuts a line into its run segments");
  const plainLine = blockLayout(text({ text: "Homo sapiens here" })).lines[0];
  h.ok(plainLine.segments === undefined, "an unformatted line carries no segments at all");

  // Wrapped: the flat `lines` cache has to map back onto text offsets.
  const wrapped = text({
    text: "Homo sapiens lives here",
    lines: ["Homo sapiens", "lives here"],
    runs: [{ from: 5, to: 12, italic: true }],
  });
  const laid = blockLayout(wrapped).lines;
  h.ok(eq(laid[0].segments?.map((s) => [s.text, s.italic ?? null]), [["Homo ", null], ["sapiens", true]]),
    "a wrapped line's segments come from its own offsets in the text");
  h.ok(laid[1].segments === undefined, "a wrapped line the runs do not touch stays unformatted");

  // A run crossing the wrap point lands on both lines.
  const across = text({
    text: "Homo sapiens lives here",
    lines: ["Homo sapiens", "lives here"],
    runs: [{ from: 5, to: 18, bold: true }],
  });
  const acrossLines = blockLayout(across).lines;
  h.ok(eq(acrossLines[0].segments?.map((s) => [s.text, s.bold ?? null]), [["Homo ", null], ["sapiens", true]]) &&
    eq(acrossLines[1].segments?.map((s) => [s.text, s.bold ?? null]), [["lives", true], [" here", null]]),
    "a run spanning the wrap formats both visual lines");

  // A cache that cannot be mapped must not produce wrong offsets.
  const stale = text({ text: "Homo sapiens here", lines: ["totally", "different"], runs: [{ from: 5, to: 12, italic: true }] });
  h.ok(blockLayout(stale).lines.every((l) => l.segments === undefined),
    "an unmappable wrap cache degrades to unformatted lines, never to wrong offsets");
}

// ------------------------------------------------------------ serialization
{
  const plain = text({ text: "Homo sapiens here" });
  const before = elementToSvg(plain);
  h.ok(!before.includes("font-style") && (before.match(/<tspan/g) ?? []).length === 1,
    "an unformatted text serializes exactly as it always did");

  const e = text({ text: "Homo sapiens here", runs: [{ from: 5, to: 12, italic: true }] });
  const svg = elementToSvg(e);
  h.ok(svg.includes('<tspan font-style="italic">sapiens</tspan>'),
    "a formatted range becomes a nested tspan carrying only what differs");
  h.ok(!/<tspan font-style="italic"[^>]*\sx=/.test(svg),
    "a segment tspan never sets x — it would restart the line");

  const bolded = text({ text: "Homo sapiens here", fontWeight: 700, runs: [{ from: 0, to: 4, bold: false }] });
  h.ok(elementToSvg(bolded).includes('<tspan font-weight="400">Homo</tspan>'),
    "an explicit off inside a bold box serializes the lighter weight");

  const underlined = text({ text: "Homo sapiens here", runs: [{ from: 5, to: 12, underline: true }] });
  h.ok(elementToSvg(underlined).includes('<tspan text-decoration="underline">sapiens</tspan>'),
    "underline is a per-range decoration too");

  const spans = textSvgLayout(e).spans;
  h.ok(eq(spans[0].segments?.map((s) => s.text), ["Homo ", "sapiens", " here"]),
    "textSvgLayout carries the segments for the slide player and every headless render");

  const justified = text({
    text: "Homo sapiens lives here",
    lines: ["Homo sapiens", "lives here"],
    align: "justify",
    runs: [{ from: 5, to: 12, italic: true }],
  });
  const jsvg = elementToSvg(justified);
  h.ok(/<tspan x="[^"]*" dy="0" textLength="[^"]*" lengthAdjust="spacing">/.test(jsvg) &&
    jsvg.includes('<tspan font-style="italic">sapiens</tspan>'),
    "justification still rides the line tspan while its segments nest inside");

  const escaped = text({ text: "a <b> & c", runs: [{ from: 2, to: 5, italic: true }] });
  h.ok(elementToSvg(escaped).includes("&lt;b&gt;") && !elementToSvg(escaped).includes("<b>"),
    "segment text is escaped like every other author string");
}

// ------------------------------------------------------------ slide player
{
  // The player patches cached tspans in place across frames. A line that LOSES
  // its formatting mid-tween keeps the same plain text, so only the nested
  // pieces distinguish the two states — the update has to look at the children.
  const formatted = text({ text: "Homo sapiens here", runs: [{ from: 5, to: 12, italic: true }], sizing: "auto" });
  const plain = text({ text: "Homo sapiens here", sizing: "auto" });
  h.ok(textSvgLayout(formatted).spans[0].segments !== undefined && textSvgLayout(plain).spans[0].segments === undefined,
    "the same line reads as segmented or not, which is the only signal a frame patch has");
}

// ------------------------------------------------------------- style resolve
{
  const e = text({ fontWeight: 700, fontStyle: "italic", underline: true });
  h.ok(eq(resolvedRunStyle(e, {}), { fontWeight: 700, fontStyle: "italic", underline: true }),
    "a segment with no flags inherits the element exactly");
  h.ok(eq(resolvedRunStyle(e, { bold: false, italic: false, underline: false }),
    { fontWeight: 400, fontStyle: "normal", underline: false }),
    "explicit offs resolve against the element");
}

// ------------------------------------------------------------------- color
// Per-range COLOR (2026-09-24): one symbol red inside a black label.
{
  const e = text({ text: "p < 0.05 here" });
  let runs = setRunColor(e, 2, 3, "#AF3029");
  h.ok(eq(runs, [{ from: 2, to: 3, color: "#AF3029" }]), `a color on one character stores exactly that run (${JSON.stringify(runs)})`);
  h.ok(eq(setRunColor({ ...e, runs }, 2, 3, null), []), "resetting a range to the element's color removes the run");
  h.ok(eq(setRunColor(e, 0, 4, "#000000"), []), "a color equal to the element's (any case) says nothing and is pruned");
  const both = normalizeRuns([{ from: 0, to: 8, italic: true }, { from: 2, to: 3, color: "#af3029" }], e.text.length, elementFlags(e));
  h.ok(eq(both, [{ from: 0, to: 2, italic: true }, { from: 2, to: 3, italic: true, color: "#af3029" }, { from: 3, to: 8, italic: true }]),
    `a color overlapping an italic run splits it and keeps both (${JSON.stringify(both)})`);
  h.ok(eq(remapRuns(runs, "p < 0.05 here", "p <= 0.05 here").map(r => [r.from, r.to, r.color]), [[2, 3, "#AF3029"]]),
    "a colored range survives an edit next to it");
  h.ok(rangeColor({ ...e, runs }, 2, 3) === "#AF3029" && rangeColor({ ...e, runs }, 0, 4) === null && rangeColor(e, 0, 4) === "#000000",
    "rangeColor reports one color, or null when the range is mixed");
  const colored = text({ text: "p < 0.05", runs: [{ from: 2, to: 3, color: "#AF3029" }], sizing: "auto", width: 200 });
  const L = blockLayout(colored);
  h.ok(L.lines[0].segments?.some(s => s.text === "<" && s.color === "#AF3029"), "layout cuts a colored-only range into its own segment");
  const svg = elementToSvg(colored);
  h.ok(svg.includes('<tspan fill="#AF3029">&lt;</tspan>'), "the SVG export paints just that character");
  h.ok(eq(resolvedRunStyle(colored, {}), { fontWeight: 400, fontStyle: "normal", underline: false }),
    "a segment without a color of its own resolves to the element font with no color field");
  const p = { figures: [{ id: "f", elements: [text({ id: "tc", text: "abc" })] }], textStyles: [] } as unknown as Project;
  ops.setTextRunColor(p, "tc", 1, 2, "#24837B");
  h.ok(eq((p.figures[0].elements[0] as TextElement).runs, [{ from: 1, to: 2, color: "#24837B" }]), "ops.setTextRunColor writes the run on the element");
}

// ------------------------------------------------- superscript / subscript
// (2026-09-24) A run's `script` sets smaller glyphs off the baseline. SVG dy is
// relative and persists, so a piece entering a script shifts and the next
// piece shifts back; a line ENDING shifted hands the correction to the next
// line's own dy, so no later line drifts.
{
  const e = text({ text: "x2 + y2", fontSize: 20 });
  let runs = toggleScriptRange(e, 1, 2, "super");
  h.ok(eq(runs, [{ from: 1, to: 2, script: "super" }]), `superscript on one character stores that run (${JSON.stringify(runs)})`);
  h.ok(eq(toggleScriptRange({ ...e, runs }, 1, 2, "super"), []), "superscripting it again returns it to the baseline, leaving no run");
  h.ok(eq(toggleScriptRange({ ...e, runs }, 1, 2, "sub"), [{ from: 1, to: 2, script: "sub" }]), "subscript over a superscript switches it in one press");
  h.ok(rangeScript({ ...e, runs }, 1, 2) === "super" && rangeScript({ ...e, runs }, 0, 2) === null && rangeScript(e, 0, 2) === "normal",
    "rangeScript reports one script, or null when mixed");
  h.ok(eq(normalizeRuns([{ from: 0, to: 3, script: "normal" }], 7, elementFlags(e)), []), "an explicit baseline run says nothing and is pruned");
  runs = toggleScriptRange({ ...e, runs }, 6, 7, "super");
  const sized = text({ text: "x2 + y2", fontSize: 20, sizing: "auto", runs });
  const L = blockLayout(sized);
  const segs = L.lines[0].segments ?? [];
  const m = scriptMetrics("super", 20);
  const two = segs.find((s) => s.from === 1 && s.to === 2), after = segs.find((s) => s.from === 2);
  h.ok(two?.script === "super" && two.dy === m.shift && after?.dy === -m.shift,
    `layout raises the superscript and brings the next piece back (${JSON.stringify(segs.map((s) => [s.text, s.dy ?? 0]))})`);
  const svg = elementToSvg(sized);
  h.ok(svg.includes(`<tspan dy="${m.shift}" font-size="${m.size}">2</tspan>`) && svg.includes(`<tspan dy="${-m.shift}">`),
    "the SVG export sets the superscript smaller and shifted, and restores the baseline");
  const wrapped = text({ text: "a2\nb", fontSize: 20, sizing: "auto", runs: [{ from: 1, to: 2, script: "sub" }] });
  const W = blockLayout(wrapped);
  const plain = blockLayout(text({ text: "a2\nb", fontSize: 20, sizing: "auto" }));
  const sub = scriptMetrics("sub", 20).shift;
  h.ok(W.lines[1].dy === plain.lines[1].dy - sub,
    `a line ending in a subscript hands the correction to the next line (${W.lines[1].dy} vs ${plain.lines[1].dy})`);
  h.ok(eq(remapRuns([{ from: 1, to: 2, script: "super" }], "x2", "x2 + 1")[0], { from: 1, to: 2, script: "super" }), "a script run survives typing after it");
  const p = { figures: [{ id: "f", elements: [text({ id: "ts", text: "H2O" })] }], textStyles: [] } as unknown as Project;
  ops.toggleTextRunScript(p, "ts", 1, 2, "sub");
  const el = p.figures[0].elements[0] as TextElement;
  h.ok(eq(el.runs, [{ from: 1, to: 2, script: "sub" }]), "ops.toggleTextRunScript writes the run");
}

// ------------------------------------------------------------------ loading
{
  // The schema is lenient by design, so the LOADER is what guarantees the
  // sorted, non-overlapping shape every reader downstream assumes.
  const p = {
    version: 2, name: "t", canvases: [], assets: [], palette: [],
    figures: [{ id: "f1", name: "F", canvasId: "c", x: 0, y: 0, width: 10, height: 10, background: "#fff",
      elements: [text({ text: "Homo sapiens here", runs: [
        { from: 12, to: 40, bold: true },   // past the end
        { from: 5, to: 12, italic: true },  // out of order
        { from: 0, to: 0, italic: true },   // empty
      ] })] }],
  } as unknown as Project;
  const runs = (migrateProject(p).figures[0].elements[0] as TextElement).runs;
  h.ok(eq(runs, [{ from: 5, to: 12, italic: true }, { from: 12, to: 17, bold: true }]),
    `loading clamps, sorts and drops runs a hand edit left behind (${JSON.stringify(runs)})`);
}

// --------------------------------------------------------------- on disk
{
  // The real writer and the real loader, not a hand-built object: runs are
  // element data like any other, and the point is that nothing along the way
  // drops or rewrites them.
  const root = await mkdtemp(join(tmpdir(), "flux-text-runs-"));
  try {
    await core.scaffold(root, { title: "Runs" });
    {
      const m = await core.loadFigModel(root);
      m.project.figures.push({
        id: "figR", canvasId: m.project.canvases[0]?.id ?? "canvas-1", name: "Fig R",
        x: 0, y: 0, width: 300, height: 200,
        elements: [text({ id: "tR", text: "Homo sapiens here", runs: [{ from: 5, to: 12, italic: true }] })],
      } as Project["figures"][number]);
      await core.saveFigModel(root, m.project, m.index);
    }
    const reloaded = await core.loadFigModel(root);
    const el = reloaded.project.figures.find((x) => x.id === "figR")!.elements[0] as TextElement;
    h.ok(eq(el.runs, [{ from: 5, to: 12, italic: true }]),
      `runs survive the fig writer and the load gate (${JSON.stringify(el.runs)})`);
    h.ok(elementToSvg(el).includes('<tspan font-style="italic">sapiens</tspan>'),
      "...and the headless render of the reloaded element still nests the segment");

    // An element with nothing to say must not gain the field on a round trip.
    {
      const m = await core.loadFigModel(root);
      const plain = text({ id: "tP", text: "Plain label" });
      m.project.figures.find((x) => x.id === "figR")!.elements.push(plain);
      await core.saveFigModel(root, m.project, m.index);
    }
    const again = await core.loadFigModel(root);
    const plain = again.project.figures.find((x) => x.id === "figR")!.elements[1] as TextElement;
    h.ok(!("runs" in plain), "an unformatted text is written and read back with NO runs field at all");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

await h.done();
