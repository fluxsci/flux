// Reproducible manual playground. Never overwrites an existing directory.
// npx tsx scripts/create-ghost-playground.ts [new-output-directory]
// The shared scaffold builder avoids the CLI scaffold's machine-library init;
// every write below stays inside the newly created playground directory.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import * as ops from "../src/lib/slide/ops";
import { buildScaffoldTree } from "../src/lib/project/scaffoldTree";
import { validateDeckFile } from "../src/lib/project/validate";
import { compileSlide } from "../src/lib/slide/compile";
import { makeText } from "../src/lib/ops";
import { elementToSvg } from "../src/lib/export";
import { loadDeck, saveDeck, exportDeck } from "../flux-core/slides";
import type { Element, LineElement } from "../src/lib/types";

const root = path.resolve(process.argv[2] ?? "test-results/ghost-transform-playground");
try {
  await fs.lstat(root);
  throw new Error(`Refusing to overwrite ${root}. Pass a separate new output directory.`);
} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }

const colors = { page: "#F7F5ED", paper: "#FFFEFA", ink: "#263B3A", muted: "#697B76", line: "#D9E0D9", teal: "#25897D", amber: "#B87935" };
const deck = ops.createDeck({ id: "ghost-transform-lab", title: "Ghost transforms · one to many", stage: { width: 640, height: 360 }, theme: "flux-light", withTitleSlide: false });
deck.background = colors.page;
deck.defaults.transition = "none";

const chartSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="204" height="174" viewBox="0 0 204 174">
<rect x=".5" y=".5" width="203" height="173" rx="12" fill="${colors.paper}" stroke="${colors.line}"/>
<g stroke="#E7ECE6" stroke-width=".8"><path d="M28 29H183M28 84H183M28 139H183M71 20V147M122 20V147M173 20V147" fill="none"/></g>
<path d="M28 20V147H183" stroke="#A7B8AF" stroke-width="1.2" fill="none"/>
<text x="110" y="163" text-anchor="middle" font-family="Arial" font-size="9" fill="${colors.muted}">response</text>
<text x="13" y="86" transform="rotate(-90 13 86)" text-anchor="middle" font-family="Arial" font-size="9" fill="${colors.muted}">signal</text>
</svg>`;
const dotSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20"><circle id="signal.point.0" data-x="0" data-y="0" cx="10" cy="10" r="7" fill="${colors.teal}" stroke="#FFFFFF" stroke-width="1.8"/></svg>`;
const dotManifest = {
  spec: "fluxplot", schemaVersion: "0.2.0", plotType: "scatter", svg: "signal-dot.svg", size: { width: 20, height: 20, unit: "px" }, axes: [],
  series: [{ id: "signal", points: [{ index: 0, svgId: "signal.point.0", x: 0, y: 0 }] }],
  parts: { id: "figure", role: "figure", children: [{ id: "signal.points", role: "group", groupRole: "point", members: ["signal.point.0"] }] },
};
const assets = new Map([["chart-grid", chartSvg], ["signal-dot", dotSvg]]);
for (const [id, svg] of assets) {
  const dimensions = id === "chart-grid" ? [204, 174] : [20, 20];
  ops.addAsset(deck, { id, name: id === "chart-grid" ? "Plot axes" : "Signal point", kind: "svg", path: `assets/${id}.svg`, naturalWidth: dimensions[0], naturalHeight: dimensions[1] });
}

const text = (slideId: string, id: string, words: string, x: number, y: number, width: number, size: number, color = colors.ink, weight = 400, height = size * 1.5) => {
  const element = makeText(words, { x, y, width, height }, { fontFamily: "Arial", fontSize: size, fontWeight: weight, color, sizing: "fixed", lineHeight: 1.2 });
  element.id = id; element.name = words.replaceAll("\n", " "); element.locked = true;
  ops.addElement(deck, slideId, element);
};
const line = (id: string, x: number, y: number, length: number, color = colors.teal): LineElement => ({
  id, name: "Original arrow", type: "line", x, y, width: length, height: 0, rotation: 0,
  x1: 0, y1: 0, x2: length, y2: 0, stroke: color, strokeWidth: 2.4, cap: "round", arrowStart: false, arrowEnd: true, arrowStyle: "vee", arrowSize: 5,
});
// All three arrows remain the same length. Their endpoints sit on an arc,
// giving the three copies a common tail and a clean, legible fan-out.
const arrowLength = 111, pointGap = 11, fanTail = { x: 384, y: 183 };
const arrowToward = (point: { x: number; y: number }, rotation: number) => {
  const angle = rotation * Math.PI / 180;
  return { x: point.x - (pointGap + arrowLength / 2) * Math.cos(angle) - arrowLength / 2,
    y: point.y - (pointGap + arrowLength / 2) * Math.sin(angle), rotation };
};
const angles = [-27, 0, 27];
const destinations = angles.map(rotation => {
  const angle = rotation * Math.PI / 180, c = Math.cos(angle), s = Math.sin(angle);
  const tip = { x: fanTail.x + arrowLength * c, y: fanTail.y + arrowLength * s };
  return { rotation, point: { x: tip.x + pointGap * c, y: tip.y + pointGap * s },
    arrow: { x: fanTail.x + arrowLength * c / 2 - arrowLength / 2, y: fanTail.y + arrowLength * s / 2, rotation } };
});

const examples = [
  { id: "original-stays", behavior: "stay", title: "Keep the original", subtitle: "The source stays put. Three copies take their own paths.", badge: "ORIGINAL STAYS", caption: "Original is unchanged" },
  { id: "original-disappears", behavior: "disappear", title: "Let the original disappear", subtitle: "Copies move out as the original point and arrow fade away.", badge: "ORIGINAL EXITS", caption: "Original fades away" },
  { id: "original-transforms", behavior: "transform", title: "Give the original its own move", subtitle: "The original changes independently while three copies fan out.", badge: "ORIGINAL MOVES", caption: "Original takes a fourth path" },
] as const;
const records: { slideId: string; pointSource: string; arrowSource: string; pointCopies: string[]; arrowCopies: string[]; birthBeat: string; emphasisBeat: string; spareArrow: string }[] = [];

for (const [index, example] of examples.entries()) {
  const slide = ops.addSlide(deck, { id: example.id, name: `${index + 1} · ${example.title}`, layout: "blank" });
  slide.notes = `${example.subtitle}\n\nAdvance to “One becomes three” to play the Ghost transforms. “Edit just one copy” changes the upper point and arrow; the other copies remain unchanged.\n\nSelect the spare amber arrow at the bottom to try Ghost transform yourself. The two source groups in the animator expose every copy as an ordinary editable object.`;
  text(slide.id, `${slide.id}-eyebrow`, "GHOST TRANSFORMS  /  ONE TO MANY", 32, 17, 400, 9, colors.muted, 600);
  text(slide.id, `${slide.id}-title`, `${String(index + 1).padStart(2, "0")}  ${example.title}`, 32, 37, 580, 22, colors.ink, 700, 30);
  text(slide.id, `${slide.id}-subtitle`, example.subtitle, 32, 70, 580, 10.5, colors.muted, 400, 18);
  text(slide.id, `${slide.id}-source-label`, "SOURCE", 47, 94, 180, 9, colors.muted, 600);
  text(slide.id, `${slide.id}-copy-label`, "THREE INDEPENDENT COPIES", 419, 94, 190, 9, colors.muted, 600);
  for (const x of [32, 404]) {
    const id = ops.addPlotToSlide(deck, slide.id, { assetId: "chart-grid", x, y: 111, width: 204, height: 174 })!;
    const element = slide.elements.find(e => e.id === id)!;
    element.name = x === 32 ? "Source plot axes" : "Destination plot axes"; element.locked = true;
  }
  text(slide.id, `${slide.id}-center`, "1 → 3", 269, 124, 105, 25, colors.teal, 600, 35);
  text(slide.id, `${slide.id}-source-caption`, example.caption, 46, 288, 203, 9.5, colors.muted);
  text(slide.id, `${slide.id}-copy-caption`, "Same source. Separate endpoints.", 419, 288, 200, 9.5, colors.muted);
  const pointSource = ops.addPlotToSlide(deck, slide.id, { assetId: "signal-dot", x: 112, y: 173, width: 20, height: 20 })!;
  const point = slide.elements.find(e => e.id === pointSource)!;
  point.name = "Original point";
  if (point.type === "plot") point.manifestRef = { specVersion: "0.2.0" };
  const arrowSource = `${slide.id}-original-arrow`;
  const originalArrow = line(arrowSource, 133, 183, arrowLength);
  originalArrow.rotation = 180; // tail at244, tip at133: points toward the source dot at122
  ops.addElement(deck, slide.id, originalArrow);

  const birth = ops.addBeat(deck, slide.id, { id: `${slide.id}-spawn`, label: "One becomes three" })!;
  const pointCopies = ops.addGhostTransform(deck, slide.id, birth.id, pointSource, {
    count: 3, original: example.behavior, duration: 1800, easing: "smooth",
    states: destinations.map(d => ({ x: d.point.x - 10, y: d.point.y - 10 })),
    ...(example.behavior === "transform" ? { originalState: { x: 177, y: 235, overrides: { "signal.point.0": { fill: colors.amber } } } } : {}),
  })!;
  const arrowCopies = ops.addGhostTransform(deck, slide.id, birth.id, arrowSource, {
    count: 3, original: example.behavior, duration: 1800, easing: "smooth", states: destinations.map(d => d.arrow),
    ...(example.behavior === "transform" ? { originalState: { ...arrowToward({ x: 187, y: 245 }, 45), stroke: colors.amber } } : {}),
  })!;
  const emphasis = ops.addBeat(deck, slide.id, { id: `${slide.id}-independent`, label: "Edit just one copy" })!;
  ops.setTransform(deck, slide.id, emphasis.id, pointCopies.elementIds[0], { duration: 850,
    state: { contentScale: 1.35, overrides: { "signal.point.0": { fill: colors.amber } } } });
  ops.setTransform(deck, slide.id, emphasis.id, arrowCopies.elementIds[0], { duration: 850, state: { stroke: colors.amber, strokeWidth: 3.5 } });

  const rule: Element = { id: `${slide.id}-rule`, type: "rect", x: 32, y: 314, width: 576, height: 1, rotation: 0, fill: colors.line, stroke: "none", strokeWidth: 0, cornerRadius: 0, locked: true };
  ops.addElement(deck, slide.id, rule);
  text(slide.id, `${slide.id}-try`, "TRY IT  Select the spare arrow → Ghost transform", 32, 326, 425, 10, colors.muted, 400, 16);
  const spareArrow = `${slide.id}-try-this-arrow`;
  const spare = line(spareArrow, 535, 334, 56, colors.amber); spare.name = "Try me · spare arrow";
  ops.addElement(deck, slide.id, spare);
  records.push({ slideId: slide.id, pointSource, arrowSource, pointCopies: pointCopies.elementIds, arrowCopies: arrowCopies.elementIds, birthBeat: birth.id, emphasisBeat: emphasis.id, spareArrow });

  const compiled = compileSlide(slide, deck.stage, { plotManifest: id => id === "signal-dot" ? dotManifest : undefined });
  assert.deepEqual(compiled.issues, [], `No animation diagnostics on ${slide.id}`);
  const base = compiled.sample(0), atStart = compiled.sample(1, 0), end = compiled.sample(1);
  const sourceArrow = base.elements.find(e => e.id === arrowSource)!;
  assert.equal(sourceArrow.rotation, 180, "Original arrow points back at its own source point");
  assert.equal(sourceArrow.x - 122, pointGap, "Original arrowhead stops just before its source point");
  for (const [i, id] of pointCopies.elementIds.entries()) {
    assert(base.presentation.unbornElementIds.includes(id), "Ghosts are absent in Design");
    assert.equal(atStart.elements.find(e => e.id === id)?.x, 112, "Every dot starts from the original");
    assert.equal(end.elements.find(e => e.id === id)?.x, destinations[i].point.x - 10, "Each dot reaches its own destination");
  }
  for (const id of arrowCopies.elementIds) assert.equal(end.elements.find(e => e.id === id)?.width, arrowLength, "Arrow copies keep identical length");
}

assert.deepEqual(validateDeckFile(deck), [], "Playground passes the real shared deck schema");
const tree = buildScaffoldTree({ title: "Ghost transform playground" }, deck);
await fs.mkdir(path.dirname(root), { recursive: true });
await fs.mkdir(root); // atomic refusal if another process creates it after preflight
for (const dir of tree.dirs) await fs.mkdir(path.join(root, dir), { recursive: true });
for (const [rel, content] of tree.files) await fs.writeFile(path.join(root, rel), content);
for (const [id, svg] of assets) await fs.writeFile(path.join(root, "slides", deck.id, "assets", `${id}.svg`), svg);
await fs.writeFile(path.join(root, "slides", deck.id, "assets", "signal-dot.fluxplot.json"), JSON.stringify(dotManifest, null, 2) + "\n");
await saveDeck(root, deck, "create_ghost_playground");
const reopened = await loadDeck(root, deck.id);
assert.deepEqual(reopened.slides, deck.slides, "Core save/reopen preserves the three examples");
const exported = await exportDeck(root, deck.id);
assert.deepEqual(exported.warnings, [], "Standalone playback export has no missing content");

// A static overview uses the same element renderer and compiled endpoint as
// the app. The live HTML next to it is the full animation, not a mock-up.
const assetData = new Map([...assets].map(([id, svg]) => [id, `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`]));
const previews = deck.slides.map((slide, i) => {
  const frame = compileSlide(slide, deck.stage, { plotManifest: id => id === "signal-dot" ? dotManifest : undefined }).sample(2);
  const hidden = new Set(frame.presentation.hiddenElementIds);
  const body = frame.elements.filter(e => !e.hidden && !hidden.has(e.id)).map(e => elementToSvg(e, id => assetData.get(id))).join("\n");
  return `<g transform="translate(24 ${24 + i * 384})"><rect width="640" height="360" rx="12" fill="${colors.page}"/>${body}</g>`;
});
await fs.writeFile(path.join(root, "exports", "overview.svg"), `<svg xmlns="http://www.w3.org/2000/svg" width="688" height="1176" viewBox="0 0 688 1176"><rect width="688" height="1176" fill="#E7ECE7"/>${previews.join("\n")}</svg>`);
await fs.writeFile(path.join(root, "playground-map.json"), JSON.stringify({ project: "project.json", deck: `slides/${deck.id}/deck.json`, records }, null, 2) + "\n");
await fs.writeFile(path.join(root, "README.md"), `# Ghost transform playground\n\nOpen this folder in Flux, switch to Slides, and choose **Ghost transforms · one to many**.\n\n1. **Keep the original** — source point and arrow remain while three copies fan out.\n2. **Let the original disappear** — source point and arrow exit as copies take over.\n3. **Give the original its own move** — the original follows a separate amber path.\n\nEach slide has **One becomes three** and **Edit just one copy**. Preview either step, scrub in both directions, or present the deck. Only the upper point and arrow change in the second step.\n\nSelect an individual Ghost in either source group, choose **Edit after step**, and move it. Select the amber spare arrow along the footer to try creating another set with the Ghost transform dialog. **Add copy** makes another independently editable sibling.\n\nThe assets are generated, deck-owned SVGs. This project has no links to an existing project or to external source files.\n\n- Standalone animation: [Open HTML](exports/${deck.id}.html)\n- Static overview: [Overview](exports/overview.svg)\n- Stable fixture object IDs: [Playground map](playground-map.json)\n\nRegenerate into a separate new directory with:\n\n\`npx tsx scripts/create-ghost-playground.ts test-results/another-ghost-playground\`\n\nThe generator refuses an existing output directory.\n`);
console.log(`Ghost playground created: ${root}\nProject: ${path.join(root, "project.json")}\nDeck: ${path.join(root, "slides", deck.id, "deck.json")}\nOffline playback: ${exported.path}\nThree slides · six ghost results per slide · two steps per slide · spare editable arrows.`);
