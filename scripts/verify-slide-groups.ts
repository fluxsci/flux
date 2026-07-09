#!/usr/bin/env -S npx tsx
// figure-v1 P9 gate (pure) — groups → slides, end to end on the pure substrate:
//  1. export wrappers: figureToSvg iterates buildRenderTree and emits nested
//     `<g data-flux-group="<escaped name>" id="<figId>__group:<gid>">` around
//     each group's members — nesting nests, hidden groups (and all-hidden
//     groups) are omitted, z-order/paint order is unchanged, and an UNGROUPED
//     figure's output is BYTE-identical to the old flat render.
//  2. player targeting: a deck Track {target: <embedFigureEl>, part:
//     "group:<gid>"} resolves to the wrapper node inside the mounted figure
//     svg (player.ts resolveNodes, linkedom DOM); applyStatic hides it before
//     its intro beat / shows it after; an exit re-baselines; a later re-enter
//     supersedes the exit (the standard key-window semantics).
//  3. quick-action defaults: suggestElementTrack/animateElement with `part`
//     author the enter-fade / exit-fadeOut track (deterministic for groups).
//  4. export parity: flux-core gatherDeckPayload's figureSvg carries the same
//     wrappers (renderFigureSvg → the ONE figureToSvg), and the payload svg
//     resolves the group track through the same player code the offline
//     runtime bundles — the exported .html inherits group animation.
// Run: npx tsx scripts/verify-slide-groups.ts
import { parseHTML } from "linkedom";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { figureToSvg, elementToSvg } from "../src/lib/export";
import { computeSlideAnims, applyStatic } from "../src/lib/slide/player/player";
import { suggestElementTrack, animateElement } from "../src/lib/slide/autobuild";
import * as slideOps from "../src/lib/slide/ops";
import { FLUX_DARK } from "../src/lib/slide/theme";
import type { RenderedSlide } from "../src/lib/slide/player/render";
import type { Slide, StageSize, Deck } from "../src/lib/slide/types";
import type { Element, Figure } from "../src/lib/types";

let fails = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log("  ok:", msg);
  else {
    fails++;
    console.error("  FAIL:", msg);
  }
}

const rect = (id: string, x: number, fill: string, groupId?: string): Element =>
  ({ type: "rect", id, x, y: 20, width: 100, height: 80, rotation: 0, fill, stroke: "#222222", strokeWidth: 2, cornerRadius: 0, ...(groupId ? { groupId } : {}) }) as Element;

const baseFig = (over: Partial<Figure>): Figure =>
  ({ id: "figX", name: "F", canvasId: "c1", x: 0, y: 0, width: 800, height: 500, background: "transparent", elements: [], ...over }) as Figure;

// ---------------------------------------------------------------------------
console.log("1) figureToSvg group wrappers");
// ---------------------------------------------------------------------------
const grouped = baseFig({
  elements: [
    rect("r1", 10, "#d62728", "gA"), // direct member of gA
    rect("r2", 120, "#2ca02c", "gB"), // member of gB, nested in gA
    rect("r3", 240, "#1f77b4"), // loose
    rect("r4", 360, "#9467bd", "gH"), // member of a HIDDEN group
  ],
  groups: {
    gA: { id: "gA", name: 'Panel "A" & <friends>' },
    gB: { id: "gB", name: "Inset", parentId: "gA" },
    gH: { id: "gH", name: "Hidden grp", hidden: true },
  },
});
const svg = figureToSvg(grouped, () => undefined);
assert(svg.includes('id="figX__group:gA"') && svg.includes('id="figX__group:gB"'), "wrapper <g> per registered group, id = <figId>__group:<gid>");
assert(svg.includes('data-flux-group="Panel &quot;A&quot; &amp; &lt;friends&gt;"'), "group NAME escaped in data-flux-group");
assert(!svg.includes("#9467bd") && !svg.includes("group:gH"), "hidden group: members AND wrapper omitted");
{
  const { document } = parseHTML(`<html><body>${svg}</body></html>`);
  const gA = document.querySelector('[id="figX__group:gA"]');
  const gB = document.querySelector('[id="figX__group:gB"]');
  assert(!!gA && !!gB && gB!.parentElement === gA, "nested group's wrapper NESTS inside its parent's wrapper");
  assert(gA!.querySelectorAll("rect").length === 2, "outer wrapper holds both deep members (r1 + nested r2)");
  const loose = document.querySelector('rect[fill="#1f77b4"]');
  assert(!!loose && !loose!.closest("[data-flux-group]"), "loose element stays OUTSIDE every wrapper");
}
assert(
  svg.indexOf("#d62728") < svg.indexOf("#2ca02c") && svg.indexOf("#2ca02c") < svg.indexOf("#1f77b4"),
  "paint order (z-order) preserved through the tree render",
);

// all-members-hidden group → no empty wrapper
{
  const f = baseFig({
    elements: [{ ...rect("h1", 10, "#aa0000", "gC"), hidden: true } as Element, rect("k1", 120, "#00aa00")],
    groups: { gC: { id: "gC", name: "C" } },
  });
  const s = figureToSvg(f, () => undefined);
  assert(!s.includes("group:gC") && s.includes("#00aa00"), "group whose members are all hidden emits NO empty wrapper");
}

// dangling groupId (alt-dup tolerance): renders loose, no wrapper, no crash
{
  const f = baseFig({ elements: [rect("d1", 10, "#123456", "no-def"), rect("d2", 120, "#654321")] });
  const s = figureToSvg(f, () => undefined);
  assert(s.includes("#123456") && !s.includes("data-flux-group"), "dangling groupId renders loose (no wrapper, nothing dropped)");
}

// flat-vs-tree BYTE identity for an ungrouped figure (the old render, exactly)
{
  const f = baseFig({ id: "flat", elements: [rect("a", 10, "#d62728"), rect("b", 120, "#2ca02c"), { ...rect("c", 240, "#1f77b4"), hidden: true } as Element], background: "#fffcf0" });
  const body = f.elements
    .filter((e) => !e.hidden)
    .map((e) => elementToSvg(e, () => undefined))
    .filter(Boolean)
    .join("\n  ");
  const expected =
    `<svg xmlns="http://www.w3.org/2000/svg" ` +
    `xmlns:xlink="http://www.w3.org/1999/xlink" ` +
    `width="${f.width}" height="${f.height}" ` +
    `viewBox="0 0 ${f.width} ${f.height}">\n  ` +
    `<rect x="0" y="0" width="${f.width}" height="${f.height}" fill="#fffcf0"/>\n  ${body}\n</svg>`;
  assert(figureToSvg(f, () => undefined) === expected, "ungrouped figure: tree render is BYTE-identical to the flat render");
}

// ---------------------------------------------------------------------------
console.log("2) player: Track {target: embedFigure, part: 'group:<gid>'}");
// ---------------------------------------------------------------------------
const { document } = parseHTML("<!doctype html><html><body></body></html>");
(globalThis as { document?: unknown }).document = document;

const stage: StageSize = { width: 1280, height: 720 };
const opts = { theme: FLUX_DARK } as const;

// mount the REAL exported figure svg the way fillEmbedFigure does (innerHTML)
const wrap = document.createElement("div") as unknown as HTMLElement;
wrap.innerHTML = svg;
const rendered: RenderedSlide = { elements: new Map([["emb", wrap]]) };
const camera = document.createElement("div") as unknown as HTMLElement;

const embEl = { type: "embedFigure", id: "emb", figureId: "figX", x: 0, y: 0, width: 600, height: 420, rotation: 0 } as unknown as Slide["elements"][number];
const slide: Slide = {
  id: "s1",
  elements: [embEl],
  beats: [
    { id: "k0", label: "base", tracks: [] },
    { id: "k1", label: "in", tracks: [{ target: "emb", part: "group:gA", preset: "fade", start: 0, duration: 300 }] },
    { id: "k2", label: "out", tracks: [{ target: "emb", part: "group:gA", preset: "fadeOut", start: 0, duration: 250 }] },
    { id: "k3", label: "back", tracks: [{ target: "emb", part: "group:gA", preset: "fade", start: 0, duration: 300 }] },
  ],
};
const specs = computeSlideAnims(slide, rendered, camera, stage, opts);
const gaNode = wrap.querySelector('[id="figX__group:gA"]') as unknown as HTMLElement;
assert(!!gaNode, "the mounted figure svg carries the group wrapper node");
assert(specs.length === 3, `one spec per group track (${specs.length})`);
assert(specs.every((s) => (s.node as unknown as { getAttribute(n: string): string | null }).getAttribute?.("id") === "figX__group:gA"), "resolveNodes finds the WRAPPER <g> (figureId prefix, scoped to the element)");

const op = () => (gaNode.style as unknown as { opacity?: string }).opacity ?? "";
applyStatic(specs, 0);
assert(op() === "0", "beat 0: group hidden before its intro beat (static-state)");
applyStatic(specs, 1);
assert(op() === "1", "beat 1: group shown after its enter");
applyStatic(specs, 2);
assert(op() === "0", "beat 2: exit preset rests the group hidden (accumulated end-state)");
applyStatic(specs, 3);
assert(op() === "1", "beat 3: a re-enter SUPERSEDES the exit (re-baseline window)");
applyStatic(specs, 0);
assert(op() === "0", "back to beat 0 re-hides (reversible / O(1) nav)");

// unknown group id → resolves to no nodes, no crash, no spec
{
  const s2: Slide = { ...slide, beats: [slide.beats[0], { id: "u1", tracks: [{ target: "emb", part: "group:missing", preset: "fade", duration: 200 }] }] };
  const sp = computeSlideAnims(s2, rendered, camera, stage, opts);
  assert(sp.length === 0, "a track on an unknown group id resolves to nothing (no crash)");
}

// regression: plot-part targeting is untouched by the embedFigure branch
{
  const plotWrap = document.createElement("div") as unknown as HTMLElement;
  const m = document.createElement("div");
  m.setAttribute("id", "p1__s.line");
  plotWrap.appendChild(m);
  const plotEl = { type: "plot", id: "p1", assetId: "pa", x: 0, y: 0, width: 400, height: 300, rotation: 0 } as unknown as Slide["elements"][number];
  const s3: Slide = {
    id: "s3", elements: [plotEl],
    beats: [{ id: "b0", tracks: [] }, { id: "b1", tracks: [{ target: "p1", part: "s.line", preset: "fade", duration: 200 }] }],
  };
  const sp = computeSlideAnims(s3, { elements: new Map([["p1", plotWrap]]) }, camera, stage, opts);
  assert(sp.length === 1 && sp[0].node === (m as never), "plot elements still resolve parts by ELEMENT-id prefix (unchanged path)");
}

// ---------------------------------------------------------------------------
console.log("3) quick-action defaults (suggestElementTrack / animateElement)");
// ---------------------------------------------------------------------------
{
  const enter = suggestElementTrack(embEl as never, { part: "group:gA" });
  assert(enter.part === "group:gA" && enter.preset === "fade" && enter.duration === 400, "part enter default = fade 400ms");
  const exit = suggestElementTrack(embEl as never, { part: "group:gA", exit: true });
  assert(exit.part === "group:gA" && exit.preset === "fadeOut" && exit.duration === 300, "part exit default = fadeOut 300ms");

  const deck: Deck = slideOps.createDeck({ id: "d1", title: "T", withTitleSlide: false });
  const sid = slideOps.addSlide(deck, { name: "S" }).id;
  slideOps.addElement(deck, sid, embEl as never);
  const r = animateElement(deck, sid, "emb", { part: "group:gA" });
  const t = slideOps.slideById(deck, sid)!.beats.flatMap((b) => b.tracks).find((x) => x.id === r?.trackId);
  assert(!!r && r.beatIndex > 0 && t?.part === "group:gA" && t?.preset === "fade", "animateElement({part}) lands the group track on a build beat");
}

// ---------------------------------------------------------------------------
console.log("4) export parity: gatherDeckPayload figureSvg carries the wrappers");
// ---------------------------------------------------------------------------
{
  const core = await import("../flux-core/index");
  const slides = await import("../flux-core/slides");
  const ops = await import("../src/lib/ops");
  const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "flux-p9-groups-"));
  try {
    await core.scaffold(TMP, { title: "P9 slide groups" });
    const { figureId } = await core.createFigure(TMP, { id: "figp9", name: "P9" });
    {
      const m = await core.loadFigModel(TMP);
      ops.addElement(m.project, figureId, rect("r1", 10, "#d62728"));
      ops.addElement(m.project, figureId, rect("r2", 150, "#2ca02c"));
      await core.saveFigModel(TMP, m.project, m.index, "seed");
    }
    const g = await core.groupElements(TMP, ["r1", "r2"], { name: "Panel A" });

    const deck = slideOps.createDeck({ id: "p9deck", title: "P9" });
    const sid = slideOps.addSlide(deck, { name: "Fig" }).id;
    slideOps.addElement(deck, sid, { type: "embedFigure", id: "embX", figureId, x: 100, y: 80, width: 800, height: 500, rotation: 0 } as never);
    const beat = slideOps.addBeat(deck, sid, { label: "build" })!;
    slideOps.setAnimation(deck, sid, beat.id, { id: "tg", target: "embX", part: `group:${g.groupId}`, preset: "fade", duration: 300 } as never);
    await slides.saveDeck(TMP, deck);

    const { payload, warnings } = await slides.gatherDeckPayload(TMP, "p9deck");
    const figSvg = payload.figures?.[figureId] ?? "";
    assert(figSvg.includes(`id="${figureId}__group:${g.groupId}"`), "payload figureSvg (renderFigureSvg) carries the group wrapper id");
    assert(figSvg.includes('data-flux-group="Panel A"'), "…with the escaped name attribute");
    assert(warnings.length === 0, `group-track deck gathers with zero warnings (got: ${warnings.join("; ")})`);

    // resolve the group track through the same player code the export runtime
    // bundles, over the PAYLOAD svg — the offline .html inherits the animation.
    const w2 = document.createElement("div") as unknown as HTMLElement;
    w2.innerHTML = figSvg;
    const s = payload.deck.slides.find((sl) => sl.elements.some((e) => e.id === "embX"))!;
    const sp = computeSlideAnims(s, { elements: new Map([["embX", w2]]) }, camera, stage, opts);
    const node = w2.querySelector(`[id="${figureId}__group:${g.groupId}"]`) as unknown as HTMLElement;
    assert(sp.length === 1 && sp[0].node === (node as never), "exported payload: the group track resolves to the wrapper node");
    applyStatic(sp, 0);
    assert(((node.style as unknown as { opacity?: string }).opacity ?? "") === "0", "…hidden at the resting beat");
    applyStatic(sp, 1);
    assert(((node.style as unknown as { opacity?: string }).opacity ?? "") === "1", "…revealed on its build beat");

    // figure-side group eye still wins: hide the group, re-gather, wrapper gone
    await core.setGroupState(TMP, g.groupId, { hidden: true });
    const g2 = await slides.gatherDeckPayload(TMP, "p9deck");
    assert(!(g2.payload.figures?.[figureId] ?? "").includes(`group:${g.groupId}`), "figure-side group eye excludes the group from the slide payload too");
  } finally {
    await fs.rm(TMP, { recursive: true, force: true });
  }
}

console.log(fails === 0 ? "\nVERIFY-SLIDE-GROUPS (P9) ALL PASS" : `\nVERIFY-SLIDE-GROUPS ${fails} FAILURE(S)`);
process.exit(fails === 0 ? 0 : 1);
