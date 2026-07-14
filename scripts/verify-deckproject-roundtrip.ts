#!/usr/bin/env -S npx tsx
// slide-migration §7.1 — the deck ⇄ figure-Project projection is the heart of
// the slides-are-figures reuse, and it must be a pure IDENTITY:
//   projectIntoDeck(deckToProject(d), d) === d
// for a fixture covering EVERY element type, groups, guides, palette/
// colorGroups/textStyles, per-slide + inherited backgrounds, and non-empty
// beats. A static round-trip leaves beats/overlay untouched. Also gates the
// fold-back rules (inherited background never materialized; external assets
// never folded into deck.assets) and the shared clone/placement core behind
// Send-to-deck / add_slide_figure.
//   npx tsx scripts/verify-deckproject-roundtrip.ts

import { deckToProject, projectIntoDeck, DECK_CANVAS_ID, cloneContentWithFreshIds, placeContentOnStage, slideDefaultBackground } from "../src/lib/slide/deckProject";
import * as slideOps from "../src/lib/slide/ops";
import type { Deck } from "../src/lib/slide/types";
import type { Element, Asset } from "../src/lib/types";

function assert(c: unknown, m: string) { if (!c) throw new Error("FAIL: " + m); console.log("  ok:", m); }
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// --- the everything fixture ------------------------------------------------------
const EVERY_ELEMENT: Element[] = [
  { type: "text", id: "e-text", x: 10, y: 12, width: 200, height: 40, rotation: 0, text: "hello\nworld", fontFamily: "Arial", fontSize: 12, fontWeight: 700, fontStyle: "italic", underline: true, lineHeight: 1.4, align: "center", color: "#123456", sizing: "auto-h", groupId: "g1" },
  { type: "rect", id: "e-rect", x: 30, y: 40, width: 100, height: 60, rotation: 15, fill: "#ff0000", stroke: "#000000", strokeWidth: 2, cornerRadius: 4, dash: [6, 4], opacity: 0.8, groupId: "g1" },
  { type: "ellipse", id: "e-ell", x: 50, y: 60, width: 80, height: 80, rotation: 0, fill: "none", stroke: "#00ff00", strokeWidth: 1.5, flipX: true },
  { type: "line", id: "e-line", x: 0, y: 0, width: 120, height: 0, rotation: 0, x1: 0, y1: 0, x2: 120, y2: 0, stroke: "#0000ff", strokeWidth: 3, arrowStart: false, arrowEnd: true, arrowStyle: "vee", arrowSize: 5, cap: "round" },
  { type: "path", id: "e-path", x: 5, y: 5, width: 50, height: 50, rotation: 0, d: "M 0 0 L 50 50", fill: "none", stroke: "#333333", strokeWidth: 2, closed: false, nodes: [{ x: 0, y: 0, type: "corner" }, { x: 50, y: 50, type: "corner" }], arrowEnd: true },
  { type: "image", id: "e-img", x: 200, y: 20, width: 96, height: 96, rotation: 0, assetId: "asset-png", crop: { x: 10, y: 10, width: 50, height: 50 }, locked: true },
  { type: "plot", id: "e-plot", x: 300, y: 30, width: 240, height: 180, rotation: 0, assetId: "asset-svg", source: { svgPath: "plots/p.svg", manifestPath: "plots/p.fluxplot.json" }, overrides: { "axis.x": { hidden: true }, "fit.line": { stroke: "#bc5215" } }, contentScale: 1.25, hidden: false },
];

const deck: Deck = {
  schemaVersion: "0.2.0",
  id: "rt-deck",
  title: "Roundtrip",
  created: "2026-07-13T00:00:00.000Z",
  modified: "2026-07-13T00:00:00.000Z",
  stage: { width: 640, height: 360 },
  theme: "flux-dark",
  defaults: { transition: "fade", buildEasing: "smooth", advance: "click" },
  background: "#101418",
  palette: ["#111111", "#222222"],
  colorGroups: [{ name: "G", swatches: [{ name: "a", hex: "#333333" }] }],
  textStyles: [{ id: "ts1", name: "Body", fontFamily: "Arial", fontSize: 12, fontWeight: 400, fontStyle: "normal" }],
  assets: [
    { id: "asset-png", name: "shot.png", kind: "png", path: "assets/asset-png.png", naturalWidth: 300, naturalHeight: 200, dpi: 300 },
  ],
  slides: [
    {
      id: "s1",
      name: "One",
      layout: "content-figure",
      elements: EVERY_ELEMENT,
      groups: { g1: { id: "g1", name: "Pair", hidden: false } },
      guides: { x: [100, 200], y: [50] },
      background: "#222222", // explicit per-slide background
      transition: "push",
      notes: "speak slowly",
      camera: { x: 320, y: 180, zoom: 1.5 },
      beats: [
        { id: "b0", label: "base", tracks: [] },
        {
          id: "b1", label: "reveal", advance: "with-prev",
          tracks: [
            { id: "t1", target: "e-text", preset: "fadeRise", start: 0, duration: 320, easing: "smooth" },
            { id: "t2", target: "e-plot", part: "fit.line", preset: "drawOn", duration: 600, stagger: { perMs: 40, by: "x", from: "start" }, influence: { in: 30, out: 10 } },
            { id: "t3", target: "e-plot", preset: "morph", to: { assetId: "other-plot", svgPath: "plots/o.svg" }, duration: 1200 },
            { id: "t4", target: "gone-element", preset: "fade" }, // DANGLING — must survive untouched
          ],
        },
        { id: "b2", advance: "auto", autoDelayMs: 800, tracks: [{ id: "t5", target: "@camera", preset: "camera", to: { x: 100, y: 100, zoom: 2 } }] },
      ],
    },
    {
      id: "s2",
      name: "Two (inherits background)",
      elements: [],
      // no background → inherits deck.background; the fold must NOT materialize it
      beats: [{ id: "b0", label: "base", tracks: [] }],
    },
  ],
};

// external (project-resolved) assets ride the projection but never fold back
const externalAsset: Asset = { id: "asset-svg", name: "p.svg", kind: "svg", path: "plots/p.svg", naturalWidth: 240, naturalHeight: 180 };
const resolvedAssets: Asset[] = [...deck.assets, externalAsset];

// --- projection shape -------------------------------------------------------------
const project = deckToProject(deck, resolvedAssets);
assert(project.canvases.length === 1 && project.canvases[0].id === DECK_CANVAS_ID, "one synthetic 'deck' canvas");
assert(project.figures.length === 2 && project.figures.every((f) => f.canvasId === DECK_CANVAS_ID), "one figure per slide, all on the deck canvas");
assert(project.figures.every((f) => f.x === 0 && f.y === 0), "all frames coincide at (0,0) — viewport carries across slide switches");
assert(project.figures.every((f) => f.width === 640 && f.height === 360), "every frame is the stage size");
assert(project.figures[0].background === "#222222", "explicit slide background projects into Figure.background");
assert(project.figures[1].background === "#101418", "inherited background projects as the deck default (canvas paints it live)");
assert(eq(project.figures[0].groups, deck.slides[0].groups), "the group registry projects verbatim");
assert(eq(project.figures[0].guides, deck.slides[0].guides), "guides project verbatim");
assert(project.figures[0].elements.length === EVERY_ELEMENT.length, "every element type projects");
assert(project.assets.length === 2, "resolved assets (deck-owned + external) ride the projection");
assert(eq(project.palette, deck.palette) && eq(project.colorGroups, deck.colorGroups) && eq(project.textStyles, deck.textStyles), "design tokens project (palette/colorGroups/textStyles)");
assert(project.figures[0].elements !== deck.slides[0].elements && !project.figures[0].elements.includes(EVERY_ELEMENT[0]), "elements are CLONED (single source of truth per store, no aliasing)");

// --- round-trip identity ------------------------------------------------------------
const back = projectIntoDeck(project, deck, { externalAssetIds: new Set([externalAsset.id]) });
assert(eq(back, deck), "projectIntoDeck(deckToProject(d), d) === d — full fixture identity (elements, groups, guides, tokens, backgrounds, beats incl. the dangling track)");

// --- fold-back rules ---------------------------------------------------------------
{
  // an edit through the figure store folds back into the slide
  const p2 = deckToProject(deck, resolvedAssets);
  const rect = p2.figures[0].elements.find((e) => e.id === "e-rect") as Extract<Element, { type: "rect" }>;
  rect.fill = "#00aa00";
  p2.figures[0].background = "#333333";
  p2.figures[1].background = slideDefaultBackground(deck); // still the inherited default
  const d2 = projectIntoDeck(p2, deck, { externalAssetIds: new Set([externalAsset.id]) });
  assert((d2.slides[0].elements.find((e) => e.id === "e-rect") as { fill: string }).fill === "#00aa00", "a figure-store element edit folds back into the slide");
  assert(d2.slides[0].background === "#333333", "an explicit background edit folds back");
  assert(d2.slides[1].background === undefined, "an INHERITED background is never materialized onto the slide");
  assert(eq(d2.slides[0].beats, deck.slides[0].beats), "a static edit leaves beats/overlay untouched");
  assert(!d2.assets.some((a) => a.id === externalAsset.id), "external (project-resolved) assets never fold into deck.assets");
}

// --- deck-op semantics over the composed model ---------------------------------------
{
  // deleting a figure (slide) in the project drops the slide on fold
  const p3 = deckToProject(deck, resolvedAssets);
  p3.figures = p3.figures.filter((f) => f.id !== "s2");
  const d3 = projectIntoDeck(p3, deck, { externalAssetIds: new Set([externalAsset.id]) });
  assert(d3.slides.length === 1 && d3.slides[0].id === "s1", "a deleted figure drops its slide (order = deck order)");
  // slide order follows PREV deck order even if figure array order differs
  const p4 = deckToProject(deck, resolvedAssets);
  p4.figures.reverse();
  const d4 = projectIntoDeck(p4, deck, { externalAssetIds: new Set([externalAsset.id]) });
  assert(d4.slides[0].id === "s1" && d4.slides[1].id === "s2", "figure array order is cosmetic — the deck's slide order is truth");
}

// --- the shared clone/placement core (Send to deck / add_slide_figure) ---------------
{
  const { elements, groups, idRemap } = cloneContentWithFreshIds(EVERY_ELEMENT, deck.slides[0].groups);
  assert(elements.length === EVERY_ELEMENT.length && elements.every((e, i) => e.id !== EVERY_ELEMENT[i].id), "clone remaps every element id");
  const g1clone = elements[0].groupId!;
  assert(g1clone !== "g1" && groups[g1clone]?.name === "Pair" && elements[1].groupId === g1clone, "group registry clones with fresh shared ids (names preserved)");
  assert(idRemap.get("e-text") === elements[0].id, "idRemap maps old → new (beat retargeting substrate)");

  // native size within the frame: no rescale
  const small: Element[] = [
    { type: "rect", id: "r1", x: 100, y: 100, width: 100, height: 50, rotation: 0, fill: "#111111", stroke: "none", strokeWidth: 0, cornerRadius: 0 },
  ];
  placeContentOnStage(small, { width: 640, height: 360 });
  assert(small[0].width === 100 && small[0].height === 50, "content within the frame keeps NATIVE size (no auto-fit ever)");
  assert(small[0].x === (640 - 100) / 2 && small[0].y === (360 - 50) / 2, "…centered on the stage");

  // an oversized portrait figure (680×850) fits ONLY because it exceeds the frame
  const big: Element[] = [
    { type: "rect", id: "r2", x: 0, y: 0, width: 680, height: 850, rotation: 0, fill: "#111111", stroke: "#000000", strokeWidth: 4, cornerRadius: 0 },
    { type: "text", id: "t2", x: 20, y: 20, width: 200, height: 40, rotation: 0, text: "cap", fontFamily: "Arial", fontSize: 28, fontWeight: 400, fontStyle: "normal", align: "left", color: "#000000", sizing: "auto" },
  ];
  placeContentOnStage(big, { width: 640, height: 360 });
  const s = 360 / 850;
  assert(Math.abs(big[0].width - 680 * s) < 1e-6 && Math.abs(big[0].height - 360) < 1e-6, "oversized content fits to the frame (uniform)");
  assert(Math.abs((big[1] as { fontSize: number }).fontSize - 28 * s) < 1e-6, "…scaling typography with geometry (internal proportions kept)");
  assert(Math.abs((big[0] as { strokeWidth: number }).strokeWidth - 4 * s) < 1e-6, "…and strokes");
}

// --- slide ops compose with the projection (duplicate retargets beats) ---------------
{
  const d = structuredClone(deck);
  const nid = slideOps.duplicateSlide(d, "s1")!;
  const copy = d.slides.find((s) => s.id === nid)!;
  assert(copy.elements.every((e) => !EVERY_ELEMENT.some((o) => o.id === e.id)), "duplicateSlide remaps element ids");
  const t1 = copy.beats[1].tracks[0];
  assert(t1.target !== "e-text" && copy.elements.some((e) => e.id === t1.target), "duplicateSlide RETARGETS tracks at the copies");
  assert(copy.beats[1].tracks[3].target === "gone-element", "…while a dangling target rides along untouched (tolerate, never prune)");
  assert(Object.keys(copy.groups ?? {})[0] !== "g1", "duplicateSlide clones the group registry with fresh ids");
}

console.log("\nDECKPROJECT ROUND-TRIP: PASS");
