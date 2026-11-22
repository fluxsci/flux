// fluximg stage 2, W8: an image's OBJECTS as slide parts, and Become by key (pure tier; headless Chrome for the DOM part).
//
// Pins: the part index of a real bundle (objects in each layer's order, centres, boxes, outlines); `targetPartIds` for
// `layer:` and object ids, selectors, unknown ids and no index; compile issues (objects not loaded, count up); the ONE node
// finder (`fluximgPartNode`) on every host's markup (the editor element's, the slide overlay's, an export's id prefixes);
// stagger order by index, by a numeric and a categorical table column (nulls last), by x; rest states at steps in the
// static markup (an unborn object is left out, a fading one carries its opacity); the pair policy "key" (names, ids,
// numeric keys, case, unmatched members, the auto threshold, object to object); stage outlines of objects under crop,
// flip and rotation against hand-computed points; the per-object style tween (OKLab colours at t = 0, 0.5, 1; nothing
// when the styles are equal); the deck stamps for a column stagger and pair "key"; the headless verbs accept pair "key";
// a deck WITHOUT images compiles to byte-identical cues, issues and samples (noImageDeckDigest).
//
// Run: npx tsx scripts/verify-fluximg-slide-parts.ts
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { harness } from "./lib/harness.mjs";
import { fixtures, writeFixture } from "./lib/fluximgFixtures";
import type { FluximgManifest, FluximgTable } from "../src/lib/fluximg/types";
import { fluximgPartIndex, fluximgPartNode, fluximgPartNodes, fluximgPartTargets, fluximgPartIdOf, keyGroups, keyPolicyApplies, keyText, memberKeys, partIndexFromTexts, partIndexWork, columnCoordinates, objectStaggerCoordinates, imageToStage, applyMatrix, type FluximgPartIndex } from "../src/lib/fluximg/parts";
import { targetPartIds, PAIR_POLICY_IDS } from "../src/lib/slide/targets";
import { compileSlide } from "../src/lib/slide/compile";
import { layerSvgPath, fluximgStaticSvg, fluximgIdPrefix } from "../src/lib/fluximg/static";
import { resolveView } from "../src/lib/fluximg/viewOps";
import { clampCrop } from "../src/lib/fluximg/crop";
import { layerMarkup } from "../src/lib/fluximg/layers";
import { imageObjectStageOutlines } from "../src/lib/slide/targetGeometry";
import { planCorrespondence, choosePolicy, sampleCorrespondence } from "../src/lib/slide/correspondence";
import type { StageOutline } from "../src/lib/slide/stageOutline";
import type { Deck, Slide, Track } from "../src/lib/slide/types";
import type { FluximgElement } from "../src/lib/fluximg/element";
import { deckSchemaFor } from "../src/lib/slide/schemaStamp";
import { createDeck, becomeTransform as becomeTransformOp } from "../src/lib/slide/ops";
import { decksWithoutImages, deckDigest } from "./lib/noImageDeckDigest";
import { styleTweenAt, objectStyleTween } from "../src/lib/fluximg/objectStyle";
import { lerpColor } from "../src/lib/color/interp";

const h = harness("verify-fluximg-slide-parts");
const scratch = await mkdtemp(path.join(tmpdir(), "fluximg-slide-parts-"));
const close = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps;

try {
  // ---- the bundle: the fixture with a keyed label layer, two vector layers ------------------------------------------
  const fx = fixtures().find((f) => f.name === "mean_f64_layers")!;
  await writeFixture(scratch, fx);
  const dir = path.join(scratch, "mean_f64_layers.fluximg");
  const manifest = JSON.parse(await readFile(path.join(dir, "fluximg.json"), "utf8")) as FluximgManifest;
  const texts: Record<string, string> = {};
  for (const l of manifest.layers) { const p = layerSvgPath(l); if (p) texts[l.id] = await readFile(path.join(dir, p), "utf8"); }
  const tables: Record<string, FluximgTable> = {};
  for (const l of manifest.layers) if (l.kind !== "intensity" && l.table) tables[l.id] = JSON.parse(await readFile(path.join(dir, l.table), "utf8")) as FluximgTable;
  const index = fluximgPartIndex(manifest, texts);

  h.section("A. the part index");
  h.eq(index.layers.map((l) => [l.id, l.kind, l.loaded]), [["footprints", "labels", true], ["prox_lines", "vector", true], ["discs", "vector", true]], "object layers only (intensity layers are not parts), manifest order");
  const fp = index.layers[0];
  h.eq(fp.objects.map((o) => o.key), ["s1", "s2", "s3", "s7"], "footprints in the layer's own order, named by key");
  h.eq(fp.objects.map((o) => o.partId), ["footprints/s1", "footprints/s2", "footprints/s3", "footprints/s7"], "object part ids are <layer>/<key>");
  h.ok(fp.objects.every((o) => o.closed && o.d.startsWith("M") && o.box.width > 0 && o.cx > o.box.x && o.cx < o.box.x + o.box.width), "footprints are closed rings with a box and a centre inside it");
  h.eq(index.layers[1].objects.map((o) => [o.key, o.closed, o.tag]), [["d1", false, "polyline"], ["d2", false, "polyline"]], "vector lines are open chains");
  h.ok(index.layers[2].objects.every((o) => o.closed && o.tag === "circle" && close(o.cx, Number(o.key === "a" ? 16.5 : o.key === "b" ? 22.5 : 28.5))), "circles are closed, centred where the file puts them");
  const partial = fluximgPartIndex(manifest, { footprints: texts.footprints });
  h.eq(partial.layers.map((l) => [l.id, l.loaded, l.objects.length]), [["footprints", true, 4], ["prox_lines", false, 0], ["discs", false, 0]], "a layer whose text is not loaded is listed, not loaded, with no objects");
  const before = partIndexWork.builds;
  const viaPaths = (p: string) => Object.entries(texts).find(([id]) => layerSvgPath(manifest.layers.find((l) => l.id === id)) === p)?.[1];
  const i1 = partIndexFromTexts(manifest, viaPaths), i2 = partIndexFromTexts(manifest, viaPaths);
  h.ok(i1 === i2 && partIndexWork.builds === before + 1, "the index is built once per (manifest, texts): a second lookup is the same object");

  h.section("B. targetPartIds");
  h.eq(targetPartIds({ part: "layer:footprints" }, index), ["footprints/s1", "footprints/s2", "footprints/s3", "footprints/s7"], "layer:<id> resolves to its objects in order");
  h.eq(targetPartIds({ parts: ["footprints/s3", "discs/a"] }, index), ["footprints/s3", "discs/a"], "object ids resolve to themselves, authored order");
  h.eq(targetPartIds({ parts: ["footprints/s9", "nope/x", "layer:nope", "bogus"] }, index), [], "unknown objects, layers and ids resolve to nothing");
  h.eq(fluximgPartTargets({ part: "footprints/s1" }, undefined), [], "no index: nothing (never the whole element)");
  h.eq(targetPartIds({ selector: { role: "object", series: "discs", index: [0, 2] } }, index), ["discs/a", "discs/c"], "a selector: role object, series = layer, index = ordinal");
  h.eq(targetPartIds({ part: "layer:footprints", selector: { except: ["footprints/s2"] } }, index), ["footprints/s1", "footprints/s3", "footprints/s7"], "except drops expanded leaves");
  h.eq(targetPartIds({ part: "layer:prox_lines" }, partial), [], "an object layer not loaded yet resolves to nothing");

  // ---- a slide with the image and part tracks -------------------------------------------------------------------------
  const el: FluximgElement = { id: "img", type: "fluximg", assetId: "A", x: 40, y: 30, width: 256, height: 160, rotation: 0, opacity: 1, view: { layers: { footprints: { visible: true } } } } as unknown as FluximgElement;
  const slideWith = (tracks: Track[][]): Slide => ({ id: "s", elements: [el as never], beats: [{ id: "b0", tracks: [] }, ...tracks.map((t, i) => ({ id: `b${i + 1}`, tracks: t }))] } as unknown as Slide);
  const partsOf = (i: FluximgPartIndex | undefined) => ({ fluximgParts: (id: string) => (id === "A" ? i : undefined), fluximgTable: (id: string, p: string) => Object.values(tables).find((_, k) => manifest.layers.filter((l) => l.kind !== "intensity" && l.table)[k]?.table === p) });

  h.section("C. compile: issues, ranks, rest states");
  {
    const s = slideWith([[{ id: "t1", target: "img", part: "layer:footprints", preset: "fade", duration: 400, stagger: { perMs: 100 } }]]);
    const none = compileSlide(s, { width: 640, height: 360 }, { fluximgParts: () => undefined });
    h.ok(none.issues.some((i) => i.trackId === "t1" && /objects are not loaded/.test(i.reason)), "no index: the part track is an issue ('objects are not loaded'), not a crash");
    h.eq(none.sample(1).presentation.elementStates.img, undefined, "… and never silently the whole element");
    const c = compileSlide(s, { width: 640, height: 360 }, partsOf(index));
    h.eq(c.issues.filter((i) => i.trackId === "t1"), [], "with the index: no issue");
    h.eq(c.cues[1].tracks[0].parts, fp.objects.map((o) => o.partId), "the cue's parts are the layer's objects");
    h.eq(c.cues[1].tracks[0].ranks, [0, 1, 2, 3], "default stagger order: the layer's order");
    const at = (t: number) => fp.objects.map((o) => +(c.sample(1, t).presentation.partStates.img?.[o.partId]?.opacity ?? -1).toFixed(3));
    h.eq(at(0).map((v) => v === 0), [true, true, true, true], "before the step every object is unborn (opacity 0)");
    const mid = at(250);
    h.ok(mid[0] > mid[1] && mid[1] > mid[2] && mid[2] >= mid[3], `mid-stagger opacities fall along the order (${mid.join(", ")})`);
    h.eq(at(Infinity), [1, 1, 1, 1], "after the step all are shown");
    h.eq(Object.keys(c.sample(0).presentation.partStates.img ?? {}).length, 4, "the Design step lists the unborn objects (rest state: hidden)");
    const count = compileSlide(slideWith([[{ id: "c1", target: "img", part: "footprints/s1", preset: "countUp", duration: 400 }]]), { width: 640, height: 360 }, partsOf(index));
    h.ok(count.issues.some((i) => i.trackId === "c1" && /Count up/.test(i.reason)), "count up on an image object is refused with an issue");
    const pend = compileSlide(slideWith([[{ id: "p1", target: "img", part: "layer:prox_lines", preset: "fade", duration: 400 }]]), { width: 640, height: 360 }, partsOf(partial));
    h.ok(pend.issues.some((i) => i.trackId === "p1" && /not loaded/.test(i.reason)), "a layer not loaded yet: the same issue");
  }

  h.section("D. stagger by a table column");
  {
    // The column has its own shape; the data keys are a closed list; anything else is plain order, never an exception
    // (a deck written by hand, or by a newer build: the real app crashed on `by: "column"` before this was pinned).
    const { staggerKey, staggerColumn } = await import("../src/lib/slide/staggerData");
    h.eq([staggerKey({ column: "pixels" }), staggerColumn({ column: "pixels" }), staggerKey({ key: "value" }), staggerColumn({ key: "value" })], [null, "pixels", "value", null], "a column is a column, a data key a data key");
    h.eq(["column", "nonsense", 7, null, { key: "weight" }, {}].map((by) => { try { return [staggerKey(by as never), staggerColumn(by as never)]; } catch (e) { return `threw: ${(e as Error).message}`; } }), [[null, null], [null, null], [null, null], [null, null], [null, null], [null, null]], "an unknown order is plain order for both readers, never an exception");
  }
  {
    const ids = fp.objects.map((o) => o.partId);
    h.eq(columnCoordinates(tables.footprints, "source_id", "pixels", ids), [2, 3, 1, 0], "numbers ascending (pixels 20, 32, 18, 5 → ranks 2, 3, 1, 0)");
    h.eq(columnCoordinates(tables.footprints, "source_id", "dendrite", ids), [0, 0, 1, null], "strings in natural order, null last");
    h.eq(columnCoordinates(tables.footprints, "source_id", "nope", ids), [null, null, null, null], "a column the table lacks: no order");
    h.eq(columnCoordinates({ key: "k", columns: { k: ["a10", "a2", "a1", "b"], v: ["x10", "x2", "x1", null] } }, "k", "v", ["L/a10", "L/a2", "L/a1", "L/b"]), [2, 1, 0, null], "natural order: x1 < x2 < x10");
    const byX = objectStaggerCoordinates(index, ids, { by: "x" }, () => undefined)!;
    h.eq(byX, fp.objects.map((o) => o.cx), "by x: the objects' centres");
    const s = slideWith([[{ id: "t2", target: "img", part: "layer:footprints", preset: "fade", duration: 300, stagger: { perMs: 100, by: { column: "pixels" } } }]]);
    const c = compileSlide(s, { width: 640, height: 360 }, partsOf(index));
    h.eq(c.cues[1].tracks[0].ranks, [2, 3, 1, 0], "the compiler ranks a column stagger by the column");
    const op = (t: number) => fp.objects.map((o) => c.sample(1, t).presentation.partStates.img?.[o.partId]?.opacity ?? 0);
    const m = op(150);
    h.ok(m[3] > m[2] && m[2] > m[0] && m[0] >= m[1], `the smallest value appears first (${m.map((v) => v.toFixed(2)).join(", ")})`);
  }

  h.section("D2. a stagger by a column the table no longer has (review NEW-C1)");
  {
    const gone = slideWith([[{ id: "g1", target: "img", part: "layer:footprints", preset: "fade", duration: 300, stagger: { perMs: 100, by: { column: "distance" } } } as Track]]);
    const c = compileSlide(gone, { width: 640, height: 360 }, partsOf(index));
    const issue = c.issues.find((i) => i.trackId === "g1")?.reason ?? "";
    h.ok(/"distance"/.test(issue) && /synapse footprints/.test(issue) && /keep their order/.test(issue), `a compile issue names the column and the layer: "${issue}"`);
    h.eq(c.cues[1].tracks[0].ranks, [0, 1, 2, 3], "…and the objects keep their order");
    const ok = compileSlide(slideWith([[{ id: "g2", target: "img", part: "layer:footprints", preset: "fade", duration: 300, stagger: { perMs: 100, by: { column: "pixels" } } } as Track]]), { width: 640, height: 360 }, partsOf(index));
    h.eq(ok.issues.filter((i) => i.trackId === "g2"), [], "another (existing) order clears it");
    const loading = compileSlide(gone, { width: 640, height: 360 }, { fluximgParts: () => index, fluximgTable: () => undefined } as never);
    h.eq(loading.issues.filter((i) => i.trackId === "g1"), [], "a table still loading is not judged");
  }

  h.section("E. the node finder on every host's markup");
  {
    const lv = resolveView(manifest, { layers: { footprints: { visible: true }, discs: { visible: true } } } as never);
    const crop = clampCrop(manifest, null), box = { width: 256, height: 160 };
    const hosts = { editor: fluximgIdPrefix("img"), overlay: `${fluximgIdPrefix("img")}s3-`, export: "deck-x-img-" };
    const { JSDOM } = await import("jsdom").catch(() => ({ JSDOM: null as never }));
    if (!JSDOM) h.ok(true, "jsdom unavailable: the DOM finder is pinned in the GUI gate");
    else for (const [host, prefix] of Object.entries(hosts)) {
      const layer = manifest.layers.find((l) => l.id === "footprints")!;
      const markup = layerMarkup(layer, texts.footprints, lv.layers.find((l) => l.id === "footprints")!, crop, box, prefix)
        + layerMarkup(manifest.layers.find((l) => l.id === "discs")!, texts.discs, lv.layers.find((l) => l.id === "discs")!, crop, box, prefix);
      const doc = new JSDOM(`<svg xmlns="http://www.w3.org/2000/svg"><g id="root">${markup}<g data-part="names"><text data-key="s1">s1</text></g></g></svg>`, { contentType: "image/svg+xml" }).window.document;
      const root = doc.getElementById("root")!;
      const n = fluximgPartNode<Element>(root, "footprints/s2");
      h.ok(n?.getAttribute("data-key") === "s2" && n.parentElement?.getAttribute("data-layer") === "footprints" && n.tagName === "path", `${host}: an object is its shape (not its name text)`);
      h.ok(fluximgPartNode<Element>(root, "layer:discs")?.getAttribute("data-layer") === "discs", `${host}: a layer is its group`);
      h.eq(fluximgPartIdOf(n as never), "footprints/s2", `${host}: the node's part id round-trips`);
      const many = fluximgPartNodes<Element>(root, [...fp.objects.map((o) => o.partId), "discs/a", "discs/b", "discs/c", "discs/zz", "footprints/s1"]);
      h.eq(many.map((x) => x?.getAttribute("data-key") ?? null), ["s1", "s2", "s3", "s7", "a", "b", "c", null, "s1"], `${host}: the batched finder agrees, unknown = null`);
    }
  }

  h.section("F. rest states in the static markup");
  {
    const rv = resolveView(manifest, el.view);
    const svg = fluximgStaticSvg({ manifest, view: rv, crop: clampCrop(manifest, null), box: { width: 256, height: 160 }, stillHref: null, layerSvg: texts, idPrefix: "p-",
      partOpacity: { "footprints/s1": 0, "footprints/s2": 0.5 } });
    h.ok(!/data-key="s1"/.test(svg.split("data-layer=\"footprints\"")[1] ?? ""), "an unborn object (opacity 0) is not drawn");
    h.ok(/data-key="s2"[^>]*opacity="0\.5"/.test(svg), "a fading object carries its opacity");
    h.ok(/data-key="s3"(?![^>]*opacity=)/.test(svg), "an object with no state draws as before");
    const plain = fluximgStaticSvg({ manifest, view: rv, crop: clampCrop(manifest, null), box: { width: 256, height: 160 }, stillHref: null, layerSvg: texts, idPrefix: "p-" });
    const none = fluximgStaticSvg({ manifest, view: rv, crop: clampCrop(manifest, null), box: { width: 256, height: 160 }, stillHref: null, layerSvg: texts, idPrefix: "p-", partOpacity: {} });
    h.eq(none, plain, "no part states: byte-identical to the markup without them");
  }

  h.section("G. pair policy key");
  {
    h.eq([keyText(" S1 "), keyText("3"), keyText("3.0"), keyText(" 03 "), keyText(3), keyText(""), keyText(null)], ["s1", "3", "3", "3", "3", null, null], "keys: trimmed, case-folded, numbers by value");
    const obj = (key: string) => ({ keys: memberKeys({ key }) }), ser = (series: string, seriesName?: string) => ({ keys: memberKeys({ series, seriesName }) });
    const A = [obj("s1"), obj("s2"), obj("S3"), obj("7")];
    const B = [ser("trace-s1", "s1"), ser("s2"), ser("x", "s3"), ser("7.0"), ser("other", "nothing")];
    const g = keyGroups(A, B);
    h.eq(g.groups.map((x) => [x.key, x.a, x.b]), [["s1", [0], [0]], ["s2", [1], [1]], ["s3", [2], [2]], ["7", [3], [3]]], "objects pair with series by name, id, case-insensitive, numeric key = number as text");
    h.eq([g.unmatchedA, g.unmatchedB, g.pairs], [[], [4], 4], "an unmatched series is left over; pair count = matched keys");
    h.ok(keyPolicyApplies(A, B), "auto: ≥ 2 pairs and more than half of the smaller side → key");
    h.ok(!keyPolicyApplies([obj("s1"), obj("q"), obj("r"), obj("t")], [ser("s1"), ser("z")]), "one matching key only: not key");
    h.ok(!keyPolicyApplies([obj("a"), obj("b"), obj("c"), obj("d"), obj("e")], [ser("a"), ser("b"), ser("x"), ser("y"), ser("z")]), "2 of 5 on the smaller side: not more than half, not key");
    h.ok(keyPolicyApplies([obj("a"), obj("b"), obj("c")], [obj("A"), obj("B"), obj("z")]), "object to object across layers: equal keys pair");
    h.ok(PAIR_POLICY_IDS.includes("key"), "'key' is a pair policy id (verbs, schema and the Pair select derive from the list)");
  }

  h.section("H. stage outlines of objects (crop, flip, rotation)");
  {
    const crop = { x: 10, y: 8, width: 40, height: 24 };
    const cases: Array<Partial<FluximgElement>> = [{}, { crop } as never, { crop, flipX: true } as never, { crop, flipY: true, rotation: 30 } as never, { rotation: -90, flipX: true, flipY: true } as never];
    for (const c of cases) {
      const e = { ...el, view: { layers: { discs: { visible: true } } }, ...c } as FluximgElement;
      const out = imageObjectStageOutlines(e, index, ["discs/b"]);
      // hand computation: image px → box (crop), + element origin, then flips and rotation about the box centre
      const cr = clampCrop(manifest, e.crop), sx = e.width / cr.width, sy = e.height / cr.height;
      const map = (x: number, y: number) => {
        let px = (x - cr.x) * sx + e.x, py = (y - cr.y) * sy + e.y;
        const cx = e.x + e.width / 2, cy = e.y + e.height / 2;
        let dx = px - cx, dy = py - cy;
        if (e.flipX) dx = -dx; if (e.flipY) dy = -dy;
        const a = (e.rotation * Math.PI) / 180;
        px = cx + dx * Math.cos(a) - dy * Math.sin(a); py = cy + dx * Math.sin(a) + dy * Math.cos(a);
        return { x: px, y: py };
      };
      const want = map(22.5 + 2, 18.5), m = imageToStage(manifest, e), got = applyMatrix(m, 24.5, 18.5);
      h.ok(close(got.x, want.x) && close(got.y, want.y), `matrix ${JSON.stringify(c)}: (24.5, 18.5) → (${want.x.toFixed(3)}, ${want.y.toFixed(3)})`);
      const ring = out[0]?.nodes ?? [];
      const centre = { x: ring.reduce((s, n) => s + n.x, 0) / Math.max(1, ring.length), y: ring.reduce((s, n) => s + n.y, 0) / Math.max(1, ring.length) };
      const wc = map(22.5, 18.5);
      h.ok(out.length === 1 && out[0].closed && close(centre.x, wc.x, 0.05) && close(centre.y, wc.y, 0.05) && out[0].owner.key === "b", `outline ${JSON.stringify(c)}: a closed ring about the mapped centre, owned by key b`);
    }
    const lines = imageObjectStageOutlines({ ...el, view: { layers: { prox_lines: { visible: true } } } } as FluximgElement, index, ["prox_lines/d1"]);
    h.ok(lines.length === 1 && !lines[0].closed && lines[0].nodes.length === 3, "a vector line is an open chain of its points");
    h.eq(imageObjectStageOutlines({ ...el, view: { layers: { footprints: { visible: false } } } } as FluximgElement, index, ["footprints/s1"]).length, 0, "a hidden layer has no outline");
  }

  h.section("I. a footprints → traces plan by key");
  {
    const objs = imageObjectStageOutlines(el, index, fp.objects.map((o) => o.partId));
    const trace = (series: string, y: number, name?: string): StageOutline => ({ nodes: [{ x: 400, y, type: "corner" }, { x: 600, y: y + 10, type: "corner" }], closed: false, bbox: { x: 400, y, w: 200, h: 10 }, owner: { elementId: "plot", partId: `${series}.line`, role: "line", series, ...(name ? { seriesName: name } : {}) }, paint: { fill: "none", stroke: "#fff", strokeWidth: 1.5, cap: "butt" } });
    const B = [trace("glu-s1", 300, "s1"), trace("s2", 250), trace("S3", 200), trace("q", 150, "unpaired")];
    h.eq(choosePolicy(objs, B), "key", "auto chooses key: 3 of 4 footprints match a trace");
    const plan = planCorrespondence(objs, B, {});
    h.eq(plan.policy, "key", "the plan pairs by key");
    const pairs = plan.pairs.map((p) => [p.a?.owner.key ?? null, p.b?.owner.series ?? null]);
    h.eq(pairs, [["s1", "glu-s1"], ["s2", "s2"], ["s3", "S3"], ["s7", null], [null, "q"]], "each footprint lands on its own trace; the unmatched footprint and trace fade");
    // the flight: its first frame is each footprint's own outline, its last each trace (within a pixel)
    plan.prepare();
    const ext = (nodes: { x: number; y: number }[]) => { const xs = nodes.map((n) => n.x), ys = nodes.map((n) => n.y); return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]; };
    const near = (a: number[], b: number[]) => a.every((v, i) => Math.abs(v - b[i]) <= 1);
    const first = sampleCorrespondence(plan, 0), last = sampleCorrespondence(plan, 1);
    for (const key of ["s1", "s2", "s3"]) {
      const src = objs.find((o) => o.owner.key === key)!, dst = B[["s1", "s2", "s3"].indexOf(key)];
      const f = first.find((p) => p.owner.a?.key === key), l = last.find((p) => p.owner.a?.key === key);
      h.ok(!!f && near(ext(f.nodes), ext(src.nodes)) && f.closed, `flight ${key}: the first frame is the footprint's outline (closed, box ${ext(f?.nodes ?? []).map((v) => v.toFixed(1)).join(",")})`);
      h.ok(!!l && near(ext(l.nodes), ext(dst.nodes)), `flight ${key}: the last frame is its trace (box ${ext(l?.nodes ?? []).map((v) => v.toFixed(1)).join(",")})`);
    }
    const spatialPlan = planCorrespondence(objs, B, { pair: "spatial" });
    h.eq(spatialPlan.policy, "spatial", "an explicit policy still wins");
    const twoPlots = planCorrespondence([trace("a", 10), trace("b", 40)], [trace("b", 300), trace("a", 330)], {});
    h.ok(twoPlots.policy !== "key", "two plots (no image object on either side): auto never picks key");
  }

  h.section("J. per-object style tween");
  {
    const a = new Map([["s1", { color: "#ff0000", opacity: 1 }], ["s2", { color: "#0000ff", opacity: 0.4 }], ["s3", { hidden: true }]]);
    const b = new Map([["s1", { color: "#00ff00", opacity: 0.5 }], ["s2", { color: "#0000ff", opacity: 0.4 }], ["s3", { color: "#ffffff", opacity: 1 }]]);
    const tween = objectStyleTween(a, null, b, null, ["s1", "s2", "s3", "s7"], { stroke: "#cccccc", fill: "none" });
    h.ok(!!tween, "two different style maps make a tween");
    for (const t of [0, 0.5, 1]) {
      const f = styleTweenAt(tween!, t);
      h.eq(f.get("s1")?.stroke, lerpColor("#ff0000", "#00ff00", t), `t=${t}: a coloured object's colour is the OKLab lerp`);
      h.ok(close(f.get("s1")!.opacity, 1 + (0.5 - 1) * t), `t=${t}: its opacity lerps`);
      h.ok(close(f.get("s3")!.opacity, t), `t=${t}: an object hidden at one end fades (${f.get("s3")!.opacity})`);
    }
    h.eq(styleTweenAt(tween!, 1).has("s7") || styleTweenAt(tween!, 1).has("s2"), false, "an object whose paint is equal at both ends is not in the tween (nothing written for it)");
    h.eq(objectStyleTween(a, null, new Map(a), null, ["s1", "s2", "s3"], { stroke: "#cccccc", fill: "none" }), null, "equal styles at both ends: no tween (nothing written)");
  }

  h.section("M. headless: pair \"key\" through the become verb and slideOps");
  {
    const { VERBS } = await import("../flux-core/registry");
    const verb = VERBS.find((v) => v.name === "become")!;
    const { z } = await import("zod");
    const schema = z.object(verb.params as Record<string, never>);
    h.ok(schema.safeParse({ deckId: "d", slideId: "s", beatId: "b", sourceId: "img", pair: "key" }).success, "the become verb accepts pair: \"key\" (no new verb)");
    const { becomeTransform } = await import("../src/lib/slide/ops");
    const deck = createDeck({ id: "dk", title: "k" });
    const s = deck.slides[0];
    s.elements = [el as never, { ...el, id: "img2", x: 360 } as never];
    s.beats.push({ id: "b1", tracks: [] });
    const r = becomeTransform(deck, s.id, "b1", { element: "img", parts: ["layer:footprints"] }, { element: "img2", parts: ["layer:footprints"] }, { pair: "key", compiled: compileSlide(s, deck.stage, partsOf(index)) });
    const t = s.beats[1].tracks.find((x) => x.id === r?.trackId);
    h.ok(t?.to?.become?.pair === "key" && t.to.become.mode === "handoff", "becomeTransform writes a hand-off paired by key between two images' objects");
    const c = compileSlide(s, deck.stage, partsOf(index));
    h.eq(c.issues.filter((i) => i.trackId === t?.id), [], "it compiles without issues (objects of two images may hand off)");
    const { handoffPairing } = await import("../src/lib/slide/handoffPlan");
    const hp = t ? handoffPairing(c.resolvedSlide.beats[1].tracks.find((x) => x.id === t.id)!, c.sample(1, 0), { manifest: () => undefined, plotRoot: () => undefined, fluximgParts: () => index } as never) : null;
    h.eq(hp && [hp.policy, hp.pairs, hp.auto], ["key", 4, true], "handoffPairing (the plan's answer): by key, 4 keys pair");
    h.eq(deckSchemaFor(deck), "0.8.0", "the deck is written as 0.8.0");
    // stagger by a table column from the CLI: set-track --stagger-by column:<name> writes the deck's column shape
    const st = VERBS.find((v) => v.name === "set_track")!, stSchema = z.object(st.params as Record<string, never>);
    h.ok(stSchema.safeParse({ deckId: "d", slideId: "s", trackId: "t", staggerBy: "column:pixels" }).success && !stSchema.safeParse({ deckId: "d", slideId: "s", trackId: "t", staggerBy: "column:" }).success
      && !stSchema.safeParse({ deckId: "d", slideId: "s", trackId: "t", staggerBy: "colour" }).success, "set_track accepts staggerBy column:<name> (and still refuses an empty column or an unknown order)");
    const core = await import("../flux-core/index"), slidesCore = await import("../flux-core/slides");
    const root = path.join(scratch, "proj");
    await core.scaffold(root, { title: "parts" });
    await core.createDeck(root, { id: "cols", title: "Cols" });
    const sid = (await slidesCore.loadDeck(root, "cols")).slides[0].id;
    await slidesCore.mutateDeck(root, "cols", "prep", (d) => {
      const sl = d.slides[0];
      sl.elements.push(el as never);
      sl.beats.push({ id: "b1", tracks: [{ id: "tc", target: "img", part: "layer:footprints", preset: "fade", duration: 300, stagger: { perMs: 100 } }] } as never);
    });
    await st.handler({ root, transport: "mcp" } as never, stSchema.parse({ deckId: "cols", slideId: sid, trackId: "tc", staggerBy: "column:pixels" }) as never);
    const written = (await slidesCore.loadDeck(root, "cols")).slides[0].beats[1].tracks[0];
    h.eq(written.stagger?.by, { column: "pixels" }, "set-track --stagger-by column:pixels writes stagger.by = {column: \"pixels\"}");
  }

  h.section("N. static writers: a slide where footprints appear one by one");
  {
    const { renderSlidePosterSvg } = await import("../src/lib/slide/embedRender");
    const byPath: Record<string, string> = {};
    for (const l of manifest.layers) { const p = layerSvgPath(l); if (p) byPath[p] = texts[l.id]; }
    const deck = { schemaVersion: "0.8.0", id: "d", title: "p", created: "", modified: "", stage: { width: 640, height: 360 }, theme: "flux-dark", defaults: { transition: "none" }, assets: [],
      slides: [{ id: "s", elements: [{ ...el, view: { layers: { footprints: { visible: true }, discs: { visible: true } } } }],
        beats: [{ id: "b0", tracks: [] }, { id: "b1", tracks: [{ id: "t", target: "img", parts: ["footprints/s1", "footprints/s2"], preset: "fade", duration: 400 }] }, { id: "b2", tracks: [{ id: "u", target: "img", part: "layer:footprints", preset: "fade", duration: 400, stagger: { perMs: 100 } }] }] }] };
    const payload = { deck, plots: {}, assets: {}, images: { A: { manifest, texts: byPath } } } as never;
    const keysAt = (step: number) => { const svg = renderSlidePosterSvg(payload, step); const g = /data-layer="footprints"[^]*?<\/g>/.exec(svg)?.[0] ?? ""; return [...g.matchAll(/data-key="([^"]+)"/g)].map((m) => m[1]); };
    h.eq(keysAt(0), [], "the poster of Design (PDF step 0, PPTX build 0): no footprint drawn yet");
    h.eq(keysAt(1), ["s1", "s2"], "step 1: the two that appeared");
    h.eq(keysAt(2), ["s1", "s2", "s3", "s7"], "step 2: all of them");
    h.ok(/data-layer="discs"/.test(renderSlidePosterSvg(payload, 0)), "an object layer without effects is drawn at every step");
  }

  h.section("O. auto Become into a WHOLE plot: the plan pairs by key when the series match (review NEW-B2)");
  {
    const { DOMParser, parseHTML } = await import("linkedom");
    const g = globalThis as Record<string, unknown>, had = { DOMParser: g.DOMParser, document: g.document };
    Object.assign(g, { DOMParser, document: parseHTML("<html><body></body></html>").document });
    try {
      const { preparePlot } = await import("../src/lib/plot/parse");
      const { planHandoff, handoffPairing } = await import("../src/lib/slide/handoffPlan");
      const plotOf = (names: string[]) => {
        const manifest = { spec: "fluxplot", schemaVersion: "0.3.0", plotType: "line", svg: "", size: { width: 300, height: 200, unit: "px" },
          axes: [{ x: { scale: "linear", label: "", domain: [0, 10], anchors: [{ data: 0, svg: 40 }, { data: 10, svg: 280 }], ticks: [] }, y: { scale: "linear", label: "", domain: [0, 4], anchors: [{ data: 0, svg: 180 }, { data: 4, svg: 20 }], ticks: [] } }],
          series: names.map((name, i) => ({ id: `tr${i}`, name, svg: { line: `tr${i}.line` } })), build: { order: [] },
          parts: { id: "figure", role: "figure", kind: "container", children: [{ id: "plot-area", role: "plot-area", kind: "container", children: [
            { id: "axis.x", role: "axis", axis: "x", kind: "container", children: [{ ref: "axis.x.spine", kind: "line" }] },
            { id: "axis.y", role: "axis", axis: "y", kind: "container", children: [{ ref: "axis.y.spine", kind: "line" }] },
            ...names.map((_, i) => ({ id: `tr${i}`, role: "series", kind: "container", children: [{ ref: `tr${i}.line`, kind: "line" }] }))] }] } };
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200" viewBox="0 0 300 200"><g id="figure"><path id="axis.x.spine" d="M40 180H280" stroke="#000"/><path id="axis.y.spine" d="M40 20V180" stroke="#000"/>${names.map((_, i) => `<path id="tr${i}.line" d="M40 ${150 - i * 30}L280 ${140 - i * 30}" fill="none" stroke="#f00"/>`).join("")}</g></svg>`;
        return preparePlot(svg, manifest as never);
      };
      const plotEl = { type: "plot", id: "pl", x: 360, y: 40, width: 240, height: 160, rotation: 0, assetId: "P", overrides: {} };
      const run = (names: string[], pair?: string) => {
        const prep = plotOf(names);
        const ctx = { manifest: () => prep.manifest, plotRoot: () => prep.root as unknown as Element, fluximgParts: () => index };
        const frame = { elements: [el, plotEl], partStates: {}, issues: [], presentation: { elementStates: {}, hiddenElementIds: [], partStates: {} } } as never;
        const track = { id: "h", target: "img", part: "layer:footprints", preset: "transform", to: { become: { ref: { element: "pl" }, mode: "handoff", ...(pair ? { pair } : {}) } } } as Track;
        return { plan: planHandoff(track, frame, ctx as never), pairing: handoffPairing(track, frame, ctx as never) };
      };
      const names = ["S1", " s2 ", "s3x", "q9", "S7 "];
      const auto = run(names);
      const flown = auto.plan.pairs.filter((p) => p.a && p.b).map((p) => [p.a!.owner.key, p.b!.owner.partId]);
      h.eq(auto.plan.policy, "key", "auto into a whole plot whose series are named by the footprints' keys: the plan pairs by key");
      h.eq(flown, [["s1", "tr0.line"], ["s2", "tr1.line"], ["s7", "tr4.line"]], "each footprint flies into its own trace (S1, ' s2 ', 'S7 '), none into a spine");
      h.ok(auto.plan.pairs.some((p) => !p.a && p.b?.owner.partId === "axis.x.spine") && auto.plan.pairs.some((p) => p.a?.owner.key === "s3" && !p.b), "the spines and unmatched traces take the b-only envelope; the unmatched footprint fades");
      h.eq([auto.pairing.policy, auto.pairing.pairs, auto.pairing.auto], ["key", 3, true], "the panel's answer is the plan's (handoffPairing: key, 3 pairs)");
      const few = run(["S1", "q8", "q9", "x"]);
      h.eq([few.plan.policy, few.pairing.policy, few.pairing.pairs], ["tile", "other", 1], "too few matches: the whole-plot default (tile into the spines) stays, and the panel says so");
      const tile = run(names, "tile");
      h.eq([tile.plan.policy, tile.pairing.policy], ["tile", "other"], "an explicit tile stays tile");
      const key = run(["S1", "q8", "q9", "x"], "key");
      h.eq([key.plan.policy, key.pairing.policy], ["key", "key"], "an explicit key pairs by key whatever the count");
    } finally { Object.assign(g, had); }
  }

  h.section("P. headless on a FRESH deck: become --source-part layer:… (review NEW-B3), and the GUI's bytes");
  {
    const fs = await import("node:fs/promises");
    const core = await import("../flux-core/index");
    const { placeImage } = await import("../flux-core/fluximg");
    const proj = await mkdtemp(path.join(tmpdir(), "w8-headless-"));
    try {
      await core.scaffold(proj, { title: "W8" });
      await fs.cp(dir, path.join(proj, "plots", "cells.fluximg"), { recursive: true });
      const { deckId } = await core.createDeck(proj, { id: "talk", title: "t" });
      const deckPath = path.join(proj, "slides", "talk", "deck.json");
      const sid = JSON.parse(await fs.readFile(deckPath, "utf8")).slides[0].id as string;
      const a = await placeImage(proj, sid, "plots/cells.fluximg", { x: 20, y: 20, width: 200 }) as unknown as { elementId: string };
      const b = await placeImage(proj, sid, "plots/cells.fluximg", { x: 360, y: 20, width: 200 }) as unknown as { elementId: string };
      const { beatId } = await core.addBeat(proj, deckId, sid, {});
      const before = JSON.parse(await fs.readFile(deckPath, "utf8")) as Deck;
      h.ok(!before.slides[0].beats.some((bt) => bt.tracks.length), "a fresh deck: no track names the images' objects yet");
      let error = "";
      let r: { trackId: string } | undefined;
      try { r = await core.become(proj, deckId, sid, beatId, a.elementId, { sourceParts: ["layer:footprints"], targetId: b.elementId, parts: ["layer:footprints"] }); }
      catch (e) { error = e instanceof Error ? e.message : String(e); }
      h.ok(!!r?.trackId && !error, `become --source-part layer:footprints --part layer:footprints works on a fresh deck${error ? ` (threw: ${error})` : ""}`);
      const after = JSON.parse(await fs.readFile(deckPath, "utf8")) as Deck;
      const written = after.slides[0].beats.flatMap((bt) => bt.tracks).find((t) => t.id === r?.trackId);
      // the GUI's bytes: the same pure op on the same deck, with the index the app would hand it
      const gui = structuredClone(before), slide = gui.slides[0];
      const opts = { fluximgParts: () => index, fluximgTable: () => null };
      const g = becomeTransformOp(gui, sid, beatId, { element: a.elementId, parts: ["layer:footprints"] }, { element: b.elementId, parts: ["layer:footprints"] }, { compiled: compileSlide(slide, gui.stage, opts as never) });
      const strip = (t: Track | undefined) => t && { ...t, id: undefined };
      h.eq(strip(written), strip(gui.slides[0].beats.flatMap((bt) => bt.tracks).find((t) => t.id === g?.trackId)), "the headless track is byte-for-byte the GUI's (twin engines)");
      const { setAnimation } = await import("../flux-core/slides");
      const ap = await setAnimation(proj, deckId, sid, beatId, { id: "ap", target: a.elementId, part: "layer:discs", preset: "fade", duration: 300, stagger: { perMs: 50 } } as Track);
      const c = await core.compileDeckSlide(proj, JSON.parse(await fs.readFile(deckPath, "utf8")) as Deck, sid);
      const ct = c.cues.flatMap((cu) => cu.tracks).find((t) => t.track.id === ap.id);
      h.ok(!!ct && ct.parts.length === 3 && !c.issues.some((i) => i.trackId === ap.id), `an Appear with --part layer:discs compiles headlessly to its 3 objects (${ct?.parts.join(", ")})`);
    } finally { await rm(proj, { recursive: true, force: true }); }
  }

  h.section("K. stamps and the deck without images");
  {
    const base = createDeck({ id: "d", title: "d" });
    const st = deckSchemaFor(base);
    const col = structuredClone(base); col.slides[0].beats.push({ id: "x", tracks: [{ id: "t", target: "gone", part: "l/1", preset: "fade", stagger: { by: { column: "dendrite" } } }] } as never);
    h.eq(deckSchemaFor(col), "0.8.0", "a column stagger (even on a dangling track) is written as 0.8.0");
    const plain = structuredClone(base); plain.slides[0].beats.push({ id: "x", tracks: [{ id: "t", target: "gone", preset: "fade", stagger: { by: { key: "value" } } }] } as never);
    h.eq(deckSchemaFor(plain), st, "a plot key stagger keeps the old stamp");
    const pk = structuredClone(base); pk.slides[0].beats.push({ id: "x", tracks: [{ id: "t", target: "a", preset: "transform", to: { become: { ref: { element: "b" }, mode: "handoff", pair: "key" } } }] } as never);
    h.eq(deckSchemaFor(pk), "0.8.0", "a Become paired by key is written as 0.8.0");
    const BASE: Record<string, string> = {
      talk: "42073a9bfc367ba4c8040028d990ceb3ca72b09b40f59ce8a8d86ba3e20e3ffc",
      "ghost-disappear": "a1cca8d7b82d0a8d788ff4c21113e7687853cac8ce9a46a9904143908f079568",
      vid: "4daf2262755f079dc5c3b72e24f7f1278f54c92764dae99055511f4497741720",
    };
    for (const d of decksWithoutImages()) h.eq(deckDigest(d), BASE[d.id], `${d.id}: cues, issues and samples byte-identical to the base`);
    void (null as unknown as Deck);
  }

  // ---- L. the player in headless Chrome: the real overlay, the real effects ------------------------------------------------
  h.section("L. the player (headless Chrome)");
  {
    const { build } = await import("esbuild");
    const { createServer } = await import("node:http");
    const { launch } = await import("./lib/driver.mjs");
    const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
    await build({
      absWorkingDir: root, bundle: true, format: "iife", globalName: "FX", platform: "browser", target: "es2022", outfile: path.join(scratch, "fx.js"), logLevel: "silent",
      stdin: { resolveDir: root, loader: "ts", sourcefile: "w8-entry.ts", contents: [
        `export { createPlayer } from "./src/lib/slide/player/player";`,
        `export { fluximgBindingOf } from "./src/lib/slide/player/fluximg";`,
        `export { createFluximgSlideHost } from "./src/lib/fluximg/slideSurfaces";`,
        `export { planViewTween } from "./src/lib/fluximg/viewTween";`,
        `export { pixelMaps } from "./src/lib/fluximg/still";`,
        `export { planeKey, layerKey } from "./src/lib/fluximg/service";`,
        `export { FLUX_DARK } from "./src/lib/slide/theme";`,
        `export { compileSlide } from "./src/lib/slide/compile";`,
        `export { transformPreState, transformEndState } from "./src/lib/slide/tween";`,
        `export { fluximgPartNode, partIndexFromTexts, imageToStage, applyMatrix } from "./src/lib/fluximg/parts";`,
        `export { lerpColor, parseColor } from "./src/lib/color/interp";`,
        `export { pulsePeak } from "./src/lib/slide/growOrigin";`,
        `export { imageObjectStageOutlines } from "./src/lib/slide/targetGeometry";`,
      ].join("\n") },
    });
    const server = createServer(async (req, res) => {
      const js = req.url === "/fx.js";
      res.setHeader("Content-Type", js ? "text/javascript" : "text/html");
      res.end(js ? await readFile(path.join(scratch, "fx.js")) : '<!doctype html><html><head><link rel="icon" href="data:,"><style>body{margin:0}</style></head><body></body></html>');
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}/`;
    const { browser, page } = await launch({ width: 1280, height: 720 });
    try {
      const pageErrors: string[] = [];
      page.on("pageerror", (e: Error) => pageErrors.push(e.message));
      await page.goto(origin);
      await page.evaluate("window.__name = (value) => value");
      await page.addScriptTag({ url: `${origin}fx.js` });
      const byPath: Record<string, string> = {}, tableByPath: Record<string, unknown> = {};
      for (const l of manifest.layers) { const p = layerSvgPath(l); if (p) byPath[p] = texts[l.id]; if (l.kind !== "intensity" && l.table) tableByPath[l.table] = tables[l.id]; }
      const r = await page.evaluate(w8Page as (d: unknown) => Promise<any>, { manifest, byPath, tableByPath }) as any;
      h.eq(pageErrors, [], "no page errors");
      // 1. stagger over a layer, by index: the player's opacities are the compiler's at every sampled time
      for (const s of r.stagger) h.ok(s.player.every((v: number, i: number) => Math.abs(v - s.compiled[i]) < 0.02), `index stagger at ${s.ms} ms: player ${s.player.map((v: number) => v.toFixed(2)).join(" ")} = compiler ${s.compiled.map((v: number) => v.toFixed(2)).join(" ")}`);
      h.ok(r.stagger.some((s: any) => s.player[0] > s.player[1] && s.player[1] > s.player[3]), "objects appear one by one in the layer's order");
      for (const s of r.column) h.ok(s.player.every((v: number, i: number) => Math.abs(v - s.compiled[i]) < 0.02), `column stagger (pixels) at ${s.ms} ms: player ${s.player.map((v: number) => v.toFixed(2)).join(" ")} = compiler`);
      h.ok(r.column.some((s: any) => s.player[3] > 0 && s.player[1] === 0), "by the pixels column the smallest object (s7) appears first, the largest (s2) last");
      // 2. composition with a crop tween
      for (const s of r.crop) h.ok(Math.abs(s.got.x - s.want.x) < 0.6 && Math.abs(s.got.y - s.want.y) < 0.6, `crop tween raw ${s.raw}: the dimming object stays on its place on the picture (${s.got.x.toFixed(2)}, ${s.got.y.toFixed(2)} vs ${s.want.x.toFixed(2)}, ${s.want.y.toFixed(2)})`);
      h.ok(r.crop.every((s: any) => Math.abs(s.opacity - s.wantOpacity) < 0.03), `… while its own opacity is its effect's (${r.crop.map((s: any) => `${(+s.opacity).toFixed(2)}/${(+s.wantOpacity).toFixed(2)}`).join(", ")})`);
      h.ok(r.crop.every((s: any) => !s.inlinePaint), "a Change that keeps the styling writes no per-object paint");
      // 3. node identity
      h.ok(r.identity.every(Boolean), `an object's node is the same object through a crop tween, a styling change and back (${r.identity.map(String).join(", ")})`);
      // 4. the per-object style tween
      h.ok(r.style.mid.every((m: any) => m.ok), `styling change mid-flight: each object's stroke is the OKLab lerp of its two ends (${r.style.mid.map((m: any) => `${m.key} ${m.got}~${m.want}`).join("; ")})`);
      h.ok(Math.abs(r.style.s7opacity - (1 + 0.35) / 2) < 0.02, `an object without a value dims halfway at mid-flight (${r.style.s7opacity})`);
      h.ok(r.style.endClean, "at the end the objects carry the end's own styling (no tween paint left)");
      // 5. a styled layer waits for its table
      h.ok(r.hold.hiddenWhileWaiting, "a styled layer is not shown before its table lands");
      h.ok(!r.hold.settledEarly, "settled() does not resolve before the table lands");
      h.ok(r.hold.settledAfter && r.hold.styledAfter, "once the table lands the layer shows, styled, and settled() resolves");
      h.eq(r.hold.unstyledFrames, 0, "no frame ever showed the styled layer unstyled");
      // 8. a Become by key between two images' objects
      h.ok(r.become.start.src.every(Boolean) && r.become.start.dst.every((v: boolean) => !v), `Become by key: before the flight the source footprints show, the destination's wait (${JSON.stringify(r.become.start)})`);
      h.ok(r.become.mid.flight >= 4 && r.become.mid.src.every((v: boolean) => !v), `mid-flight the footprints fly as ${r.become.mid.flight} paths on the flight layer (sources hidden)`);
      h.ok(r.become.end.dst.every(Boolean) && r.become.end.src.every((v: boolean) => !v), `at the landing the destination's footprints show and the source's are gone (${JSON.stringify(r.become.end)})`);
      // 6. rise in stage px under the crop's scale
      if (Math.abs(r.rise.lift - 12) >= 0.6) console.log(JSON.stringify(r.rise.debug));
      for (const p of r.presets) h.ok(p.sameNode && Number.isFinite(p.mid.x), `preset ${p.preset}: plays on the object (mid opacity ${(+p.midState.opacity).toFixed(2)}, transform ${p.midState.transform}, clip ${p.midState.clip}, dash ${p.midState.dash})`);
      const P = (name: string) => r.presets.find((p: any) => p.preset === name);
      // (an entrance is compared with its end: before it the object is unborn and has no box to speak of)
      for (const name of ["popIn", "scaleIn", "pulse", "scale", "rotate", "popOut", "scaleOut"]) { const ref = name === "popIn" || name === "scaleIn" ? P(name).end : P(name).rest; h.ok(Math.abs(P(name).mid.x - ref.x) < 0.6 && Math.abs(P(name).mid.y - ref.y) < 0.6, `${name} pivots about the object's own centre (mid centre ${P(name).mid.x.toFixed(1)},${P(name).mid.y.toFixed(1)} = ${ref.x.toFixed(1)},${ref.y.toFixed(1)})`); }
      for (const name of ["fade", "fadeRise", "popIn", "scaleIn", "drawOn", "growBaseline", "writeOn", "highlight", "dim", "pulse", "encircle", "move", "scale", "rotate"]) h.ok(P(name).endOpacity > (name === "dim" ? 0.1 : 0.99), `${name}: the object is shown at its end (${(+P(name).endOpacity).toFixed(2)})`);
      for (const name of ["fadeOut", "popOut", "scaleOut", "drawOff", "wipeOut"]) { const e = P(name); h.ok(e.endOpacity < 0.01 || e.end.w < 0.01 || e.endState.visibility === "hidden" || e.endState.display === "none" || /100%/.test(e.endState.clip) || /^0(px)?,/.test(e.endState.dash) || (parseFloat(e.endState.dash) > 0 && Math.abs(parseFloat(e.endState.offset)) >= parseFloat(e.endState.dash) - 0.01), `${name}: the object has left at its end (${JSON.stringify(e.endState)}, opacity ${(+e.endOpacity).toFixed(2)}, width ${e.end.w.toFixed(2)})`); }
      h.ok(Math.abs(r.pulse.got - r.pulse.own) < 0.02 * r.pulse.own && Math.abs(r.pulse.own - r.pulse.whole) > 0.05, `pulse on an image object peaks at the scale its OWN box asks (${r.pulse.got.toFixed(3)} = ${r.pulse.own.toFixed(3)}; the whole image's would be ${r.pulse.whole.toFixed(3)})`);
      h.ok(Math.abs(P("move").end.x - P("move").rest.x - 20) < 0.6, `move by 20 stage px moves the object 20 stage px (${(P("move").end.x - P("move").rest.x).toFixed(2)})`);
      h.ok(/\d/.test(String(P("drawOn").midState.dash)) && P("drawOn").midState.dash !== "none", `drawOn draws along the outline (mid dash ${P("drawOn").midState.dash})`);
      h.ok(Math.abs(r.rise.lift - 12) < 0.6, `fadeRise lifts an image object by its authored stage px (${r.rise.lift.toFixed(2)} of 12)`);
      h.ok(r.riseCrop.every((x: any) => Math.abs(x.lift - x.want) < 0.6), `fadeRise in a step that zooms the crop 2x: the lift follows the crop, the authored stage px at every moment (${r.riseCrop.map((x: any) => `${x.lift.toFixed(2)}/${x.want.toFixed(2)}`).join(", ")})`);
    } finally { await browser.close(); server.close(); }
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
}
await h.done();

// ---- the page of section L (runs in headless Chrome; FX = the real player bundle) -------------------------------------
async function w8Page(D: { manifest: any; byPath: Record<string, string>; tableByPath: Record<string, any> }): Promise<unknown> {
  const FX = (window as any).FX, { manifest } = D, out: Record<string, any> = {};
  const shape = manifest.pixels.shape, H = shape[shape.length - 2], W = shape[shape.length - 1];
  const maps = FX.pixelMaps(manifest);
  const source = () => ({
    manifest: (id: string) => (id === "A" ? manifest : undefined),
    need: () => Promise.resolve(manifest), bundle: () => "B", identity: () => "B-sha",
    planes: {
      plane: (b: string, level: number, leading: number[]) => Promise.resolve({ key: FX.planeKey(b, level, leading), width: W, height: H, dtype: "uint16", data: new Uint16Array(W * H), map: maps[leading[0]] ?? maps[0] }),
      projection: () => Promise.reject(new Error("none")),
      layer: (b: string, id: string, f: number) => Promise.resolve({ key: FX.layerKey(b, id, f), width: W, height: H, dtype: "uint16", data: new Uint16Array(W * H), map: null }),
    },
    still: () => Promise.reject(new Error("no stills")), stillNow: () => undefined, resolveLut: () => null,
  });
  const index = FX.partIndexFromTexts(manifest, (p: string) => D.byPath[p]);
  const fp = index.layers.find((l: any) => l.id === "footprints").objects, ids = fp.map((o: any) => o.partId);
  const hidden = Object.fromEntries(manifest.layers.filter((l: any) => l.kind === "intensity").map((l: any) => [l.id, { visible: false }]));
  const V = { layers: { ...hidden, footprints: { visible: true }, discs: { visible: true }, prox_lines: { visible: false } } };
  const VS = { layers: { ...V.layers, footprints: { visible: true, styleBy: { color: { column: "dendrite" } } } } };
  const el = (view: unknown) => ({ type: "fluximg", id: "img", x: 40, y: 30, width: 256, height: 160, rotation: 0, assetId: "A", view });
  const s2 = fp.find((o: any) => o.key === "s2");
  const CROP = { x: Math.max(0, s2.cx - W / 4), y: Math.max(0, s2.cy - H / 4), width: W / 2, height: H / 2 };
  const lin = { easing: "linear" };
  const db = index.layers.find((l: any) => l.id === "discs").objects.find((o: any) => o.key === "b");
  // (the step before rests on CROP, half the picture: this one zooms 2x further, onto disc b)
  const CROP2 = { x: Math.max(0, Math.min(W * 3 / 4, db.cx - W / 8)), y: Math.max(0, Math.min(H * 3 / 4, db.cy - H / 8)), width: W / 4, height: H / 4 };
  const deck = { schemaVersion: "0.8.0", id: "d", title: "w8", created: "", modified: "", stage: { width: 640, height: 360 }, theme: "flux-dark", defaults: { transition: "none" }, assets: [],
    slides: [
      { id: "s0", elements: [el(V)], beats: [{ id: "b0", tracks: [] },
        { id: "b1", tracks: [{ id: "ap", target: "img", part: "layer:footprints", preset: "fade", start: 0, duration: 300, ...lin, stagger: { perMs: 100 } }] },
        { id: "b2", tracks: [{ id: "cz", target: "img", preset: "transform", start: 0, duration: 1000, ...lin, to: { state: { crop: CROP } } }, { id: "dm", target: "img", part: "footprints/s2", preset: "dim", start: 0, duration: 1000, ...lin, params: { level: 0.3 } }] },
        { id: "b3", tracks: [{ id: "rz", target: "img", part: "discs/a", preset: "fadeRise", start: 0, duration: 400, ...lin, params: { y: 12 } }] },
        // a fadeRise in a step that also zooms the crop 2x: the lift is the authored stage px at every moment
        { id: "b4", tracks: [{ id: "rz2", target: "img", part: "discs/b", preset: "fadeRise", start: 0, duration: 400, ...lin, params: { y: 12 } }, { id: "cz2", target: "img", preset: "transform", start: 0, duration: 400, ...lin, to: { state: { crop: CROP2 } } }] }] },
      { id: "s1", elements: [el(V)], beats: [{ id: "c0", tracks: [] }, { id: "c1", tracks: [{ id: "ac", target: "img", part: "layer:footprints", preset: "fade", start: 0, duration: 300, ...lin, stagger: { perMs: 100, by: { column: "pixels" } } }] }] },
      { id: "s2", elements: [el(V)], beats: [{ id: "e0", tracks: [] }, { id: "e1", tracks: [{ id: "st", target: "img", preset: "transform", start: 0, duration: 1000, ...lin, to: { state: { view: VS } } }] }] },
      { id: "s3", elements: [el(VS)], beats: [{ id: "f0", tracks: [] }] },
      { id: "s4", elements: [el(V), { ...el(V), id: "img2", x: 360, y: 150, width: 200, height: 125 }], beats: [{ id: "g0", tracks: [] },
        { id: "g1", tracks: [{ id: "bk", target: "img", part: "layer:footprints", preset: "transform", start: 0, duration: 1000, ...lin, to: { become: { ref: { element: "img2", parts: ["layer:footprints"] }, mode: "handoff", pair: "key" } } }] }] },
    ] };
  let release = true;
  const tableOf = (_: string, p: string) => (release ? D.tableByPath[p] ?? null : undefined);
  const opts = { theme: FX.FLUX_DARK, mode: "present", reducedMotion: false, fluximgManifest: () => manifest, fluximgLayerText: (_: string, p: string) => D.byPath[p], fluximgTable: tableOf };
  const compileOpts = { fluximgParts: () => index, fluximgTable: (_: string, p: string) => D.tableByPath[p] };
  const mount = document.createElement("div"); document.body.append(mount);
  const host = FX.createFluximgSlideHost(source());
  const P = FX.createPlayer(mount, deck, { ...opts, fluximg: host });
  const at = async (slide: number, beat: number, ms: number) => { P.seek(slide, beat, ms); await P.captureMedia([], ms); };
  const rootOf = () => mount.querySelector("[data-slide-fluximg-root]")!;
  const node = (id: string) => FX.fluximgPartNode(rootOf(), id) as SVGElement;
  const opacityOf = (n: Element) => { let o = 1; for (let x: Element | null = n; x && x !== mount; x = x.parentElement) o *= Number(getComputedStyle(x).opacity); return o; };
  const ownOpacity = (n: Element) => Number(getComputedStyle(n).opacity) * Number(getComputedStyle(n.parentElement!).opacity);
  const origin = mount.getBoundingClientRect();
  const centre = (n: Element) => { const r = n.getBoundingClientRect(); return { x: r.left - origin.left + r.width / 2, y: r.top - origin.top + r.height / 2 }; };
  // 1. stagger by index, against the compiler
  const c0 = FX.compileSlide(deck.slides[0], deck.stage, compileOpts);
  out.stagger = [];
  for (const ms of [0, 100, 150, 250, 400]) { await at(0, 1, ms); out.stagger.push({ ms, player: ids.map((id: string) => ownOpacity(node(id))), compiled: ids.map((id: string) => c0.sample(1, ms).presentation.partStates.img?.[id]?.opacity ?? 1) }); }
  const before = ids.map(node);
  // 2. the crop tween with a dim on s2
  const pre = FX.transformPreState(deck.slides[0], "img", 2), end = FX.transformEndState(pre, deck.slides[0].beats[2].tracks[0]);
  const plan = FX.planViewTween(manifest, { view: pre.view, crop: pre.crop }, { view: end.view, crop: end.crop }, { blend: false });
  out.crop = [];
  for (const raw of [0, 0.25, 0.5, 1]) {
    await at(0, 2, raw * 1000);
    const crop = plan.frame(raw, raw).overlay.crop, m = FX.imageToStage(manifest, { ...el(V), crop }), want = FX.applyMatrix(m, s2.cx, s2.cy);
    out.crop.push({ raw, got: centre(node("footprints/s2")), want, opacity: ownOpacity(node("footprints/s2")), wantOpacity: c0.sample(2, raw * 1000).presentation.partStates.img?.["footprints/s2"]?.opacity ?? 1,
      inlinePaint: ids.some((id: string) => node(id).style.stroke || node(id).style.fill) });
  }
  // 3. fadeRise: the lift in stage px
  await at(0, 3, 0); const r0 = centre(node("discs/a")); await at(0, 3, 400); const r1 = centre(node("discs/a"));
  out.rise = { lift: r0.y - r1.y, debug: [node("discs/a").parentElement!.outerHTML.slice(0, 300), node("discs/a").parentElement!.parentElement!.getAttribute("transform")] };
  {
    // 3b. under a crop tween: how far below its resting place at this frame's crop the object still is
    const preB = FX.transformPreState(deck.slides[0], "img", 4), endB = FX.transformEndState(preB, deck.slides[0].beats[4].tracks[1]);
    const planB = FX.planViewTween(manifest, { view: preB.view, crop: preB.crop }, { view: endB.view, crop: endB.crop }, { blend: false });
    out.riseCrop = [];
    for (const raw of [0.25, 0.5, 0.75]) {
      await at(0, 4, raw * 400);
      const crop = planB.frame(raw, raw).overlay.crop, m = FX.imageToStage(manifest, { ...el(V), crop }), rest = FX.applyMatrix(m, db.cx, db.cy);
      out.riseCrop.push({ raw, lift: centre(node("discs/b")).y - rest.y, want: 12 * (1 - raw) });   // (it starts y below and rises)
    }
  }
  out.identity = [];
  // 4. column stagger (another slide)
  const c1 = FX.compileSlide(deck.slides[1], deck.stage, compileOpts);
  out.column = [];
  for (const ms of [0, 50, 150, 250, 400, 700]) { await at(1, 1, ms); out.column.push({ ms, player: ids.map((id: string) => ownOpacity(node(id))), compiled: ids.map((id: string) => c1.sample(1, ms).presentation.partStates.img?.[id]?.opacity ?? 1) }); }
  // 5. the styling change, object by object
  await at(2, 1, 0); const n2 = ids.map(node);
  const strokes = () => ids.map((id: string) => getComputedStyle(node(id)).stroke);
  const s0 = strokes(); await at(2, 1, 500); const sm = strokes(); const s7mid = Number(getComputedStyle(node("footprints/s7")).opacity);
  out.identity.push(ids.every((id: string, i: number) => node(id) === n2[i] && n2[i].isConnected));
  await at(2, 1, 1000); const s1 = strokes();
  out.identity.push(ids.every((id: string, i: number) => node(id) === n2[i] && n2[i].isConnected));
  const rgb = (c: string) => { const p = FX.parseColor(c); return p ? [p.r, p.g, p.b] : [NaN, NaN, NaN]; };
  out.style = { s7opacity: s7mid, endClean: ids.every((id: string) => !node(id).style.stroke && !node(id).style.fill),
    mid: ids.map((id: string, i: number) => { const want = rgb(FX.lerpColor(s0[i], s1[i], 0.5)), got = rgb(sm[i]); const k = want[0] > 1.5 ? 1 : 255; return { key: id.split("/")[1], got: sm[i], want: FX.lerpColor(s0[i], s1[i], 0.5), ok: got.every((v, j) => Math.abs(v - want[j]) * k <= 2.5) }; }) };
  // back to slide 0: the first slide's nodes are rebuilt with the slide (a new mount), so identity is pinned within a slide
  await at(0, 1, 400); const n0 = ids.map(node);
  for (const [beat, ms] of [[2, 300], [2, 1000], [3, 200], [1, 0], [0, 0]] as const) { await at(0, beat, ms); out.identity.push(ids.every((id: string, i: number) => node(id) === n0[i] && n0[i].isConnected)); }
  void before;
  // 7. every appearance preset on one image object (discs/b): it plays, it pivots about the object, it rests clean
  {
    const PRESETS = ["fade", "fadeRise", "popIn", "scaleIn", "drawOn", "growBaseline", "writeOn", "fadeOut", "popOut", "scaleOut", "drawOff", "wipeOut", "highlight", "dim", "pulse", "encircle", "move", "scale", "rotate"];
    const sweep = { schemaVersion: "0.8.0", id: "p", title: "p", created: "", modified: "", stage: deck.stage, theme: "flux-dark", defaults: { transition: "none" }, assets: [],
      slides: PRESETS.map((preset, i) => ({ id: `p${i}`, elements: [el(V)], beats: [{ id: `q${i}`, tracks: [] }, { id: `r${i}`, tracks: [{ id: `t${i}`, target: "img", part: "discs/b", preset, start: 0, duration: 400, ...lin, ...(preset === "move" ? { to: { x: 20, y: 0 } } : {}) }] }] })) };
    const mount3 = document.createElement("div"); document.body.append(mount3);
    const host3 = FX.createFluximgSlideHost(source());
    const P3 = FX.createPlayer(mount3, sweep, { ...opts, fluximg: host3 });
    const o3 = mount3.getBoundingClientRect();
    const at3 = async (si: number, beat: number, ms: number) => { P3.seek(si, beat, ms); await P3.captureMedia([], ms); };
    const shapeOf = () => FX.fluximgPartNode(mount3.querySelector("[data-slide-fluximg-root]"), "discs/b") as SVGElement;
    const c3 = (n: Element) => { const r = n.getBoundingClientRect(); return { x: r.left - o3.left + r.width / 2, y: r.top - o3.top + r.height / 2, w: r.width }; };
    out.presets = [];
    for (const [i, preset] of PRESETS.entries()) {
      await at3(i, 0, 0); const rest = c3(shapeOf());
      await at3(i, 1, 200); const n = shapeOf(), mid = c3(n), wrapper = n.parentElement!;
      const midState = { opacity: opacityOf(n), transform: getComputedStyle(wrapper).transform, clip: getComputedStyle(wrapper).clipPath, dash: getComputedStyle(n).strokeDasharray };
      await at3(i, 1, 400); const endN = shapeOf(), end = c3(endN);
      const endState = { visibility: getComputedStyle(endN).visibility, clip: getComputedStyle(endN.parentElement!).clipPath, dash: getComputedStyle(endN).strokeDasharray, offset: getComputedStyle(endN).strokeDashoffset, display: getComputedStyle(endN).display };
      out.presets.push({ preset, rest, mid, end, midState, endState, endOpacity: opacityOf(endN), sameNode: endN === n, errors: 0 });
    }
    // the pulse's peak: sized by the object's OWN stage box (its outline through the crop matrix), not the whole image's (review)
    {
      const i = PRESETS.indexOf("pulse"), e = sweep.slides[i].elements[0] as any;
      const box = FX.imageObjectStageOutlines(e, index, ["discs/b"])[0]?.bbox;
      const p = out.presets[i];
      out.pulse = { got: p.mid.w / p.rest.w, own: FX.pulsePeak(undefined, box, sweep.stage), whole: FX.pulsePeak(undefined, { x: e.x, y: e.y, w: e.width, h: e.height }, sweep.stage) };
    }
    P3.destroy(); host3.dispose();
  }
  // 8. a Become by key between two images' footprints (the hand-off driver over image objects)
  {
    const nodes = (el: string) => ids.map((id: string) => FX.fluximgPartNode(mount.querySelector(`[data-slide-fluximg-root="${el}"]`), id) as SVGElement);
    const visible = (n: Element) => { for (let x: Element | null = n; x && x !== mount; x = x.parentElement) { const cs = getComputedStyle(x); if (cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) === 0) return false; } return true; };
    await at(4, 1, 0);
    const start = { src: nodes("img").map(visible), dst: nodes("img2").map(visible) };
    await at(4, 1, 500);
    const flight = [...mount.querySelectorAll("svg path")].filter((p) => !p.closest("[data-slide-fluximg-root]")).length;
    const mid = { src: nodes("img").map(visible), dst: nodes("img2").map(visible), flight };
    await at(4, 1, 1000);
    const end = { src: nodes("img").map(visible), dst: nodes("img2").map(visible) };
    out.become = { start, mid, end };
  }
  // 6. a styled layer waits for its table
  release = false;
  const mount2 = document.createElement("div"); document.body.append(mount2);
  const host2 = FX.createFluximgSlideHost(source());
  let unstyledFrames = 0;
  const watch = new MutationObserver(() => {
    const g = mount2.querySelector('[data-layer="footprints"]') as SVGElement | null;
    if (!g || g.getAttribute("display") === "none" || g.closest('[style*="display: none"]')) return;
    if ([...g.querySelectorAll("[data-key]")].some((s) => !s.getAttribute("stroke") || s.getAttribute("stroke") === g.getAttribute("stroke"))) unstyledFrames++;
  });
  watch.observe(mount2, { subtree: true, childList: true, attributes: true });
  const P2 = FX.createPlayer(mount2, { ...deck, slides: [deck.slides[3]] }, { ...opts, fluximg: host2 });
  P2.seek(0, 0, 0);
  const g2 = () => mount2.querySelector('[data-layer="footprints"]') as SVGElement | null;
  let settled = false;
  const done = P2.captureMedia([], 0).then(() => { settled = true; });
  await new Promise((r) => setTimeout(r, 150));
  const hiddenWhileWaiting = !g2() || g2()!.getAttribute("display") === "none";
  const settledEarly = settled;
  release = true;
  FX.fluximgBindingOf(mount2.querySelector("[data-slide-fluximg-root]")).refresh();
  await Promise.race([done, new Promise((r) => setTimeout(r, 2000))]);
  const shapes = [...(g2()?.querySelectorAll("[data-key]") ?? [])];
  out.hold = { hiddenWhileWaiting, settledEarly, settledAfter: settled, styledAfter: !!g2() && g2()!.getAttribute("display") !== "none" && shapes.length > 0 && shapes.every((s) => !!s.getAttribute("stroke")), unstyledFrames };
  watch.disconnect();
  P.destroy(); P2.destroy(); host.dispose(); host2.dispose();
  return out;
}

