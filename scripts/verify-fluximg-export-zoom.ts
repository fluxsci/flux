#!/usr/bin/env -S npx tsx
// Review B4 (export half): a step whose camera rests zoomed in on an image exports a still at the resolution that zoom
// needs (offline deck, PDF, PPTX), bounded by the crop's own pixels and the pixel cap (crop.zoomedStillScale, the ONE
// rule the live player shares); a deck without a camera zoom exports exactly the stills it did.
// Run: npx tsx scripts/verify-fluximg-export-zoom.ts
import "./lib/cssStub.mjs";
import fs from "node:fs/promises";
import { harness } from "./lib/harness.mjs";
import { makeProject, standardDeck, V0 } from "./lib/fluximgSlideExportFixture";

const h = harness("verify-fluximg-export-zoom");
const { zoomedStillScale } = await import("../src/lib/fluximg/crop");

h.section("A. the rule");
{
  const crop = { x: 0, y: 0, width: 512, height: 512 }, box = { width: 128, height: 128 };
  h.eq(zoomedStillScale(crop, box, 2, 1), 2, "no zoom: the export scale exactly");
  h.eq(zoomedStillScale(crop, box, 2, 0.5), 2, "a zoom out: the export scale exactly");
  h.eq(zoomedStillScale(crop, box, 2, 1.5), 3, "a 1.5x zoom on a crop with pixels to spare: 3 still px per canvas px");
  h.eq(zoomedStillScale(crop, box, 2, 3), 4, "a 3x zoom: bounded by the crop's own pixels (512 px over a 128 px box = 4)");
  h.eq(zoomedStillScale({ x: 0, y: 0, width: 64, height: 48 }, { width: 320, height: 240 }, 2, 3), 2, "a crop already magnified at 2x: unchanged (a zoom shows the same pixels larger)");
}

const P = await makeProject({ T: 2, H: 768, W: 1024 });
const { ensureDom } = await import("../flux-core/index");
await ensureDom();
const { renderSlidePosterSvg } = await import("../src/lib/slide/embedRender");
const { deckPptxBytes } = await import("../src/lib/slide/export/deckPptx");
const { ensureColormapLuts } = await import("../src/lib/color/colormapLuts");
await ensureColormapLuts();
process.env.FLUX_VIDEO_ENCODER = "/nonexistent/ffmpeg"; // stills only: this gate is about stills
const stills = (payload: any) => Object.keys(payload.assets ?? {}).filter((k) => k.startsWith("fluximg:"));
const sizes = (payload: any) => stills(payload).map((k) => /;out=(\d+x\d+)/.exec(k)![1]).sort();
const gather = async () => (await P.slidesCore.gatherDeckPayload(P.root, "talk", undefined, { refreshSources: false })).payload;
/** Design: the image 320 x 240 at (40, 20); step 1: the camera moves to `to` (absent: no camera step). */
const deckWith = (to: Record<string, number> | null, crop: Record<string, number> | null = null) => P.slidesCore.mutateDeck(P.root, "talk", "zoom", (deck: any) => {
  deck.defaults.transition = "none";
  const s = deck.slides[0], el = s.elements.find((e: any) => e.type === "fluximg");
  Object.assign(el, { x: 40, y: 20, width: 320, height: 240, view: { index: { t: 0 } } });
  if (crop) el.crop = crop; else delete el.crop;
  s.beats = [s.beats[0], { id: "b1", tracks: to ? [{ id: "cz", target: "@camera", preset: "camera", start: 0, duration: 600, easing: "linear", to }] : [] }];
});
const pptxRasters = async (payload: any) => {
  const asked: string[] = [];
  const png = new Uint8Array(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"));
  await deckPptxBytes("t", [{ payload }], async (_svg: string, w: number, hh: number) => { asked.push(`${w}x${hh}`); return png; }, undefined, "animated");
  return asked;
};

h.section("B. no camera zoom: the stills it always had (2x the box)");
await deckWith(null);
const none = await gather();
h.eq([...new Set(sizes(none))], ["640x480"], "no camera: every still 640 x 480");
await deckWith({ x: 250, y: 160, zoom: 1 });
const pan = await gather();
h.eq(JSON.stringify(Object.keys(pan.assets ?? {})), JSON.stringify(Object.keys(none.assets ?? {})), "a pan (zoom 1): the same stills, the same keys");

h.section("C. a camera that rests 2.5x on the image");
await deckWith({ x: 200, y: 140, zoom: 2.5 });
const zoomed = await gather();
h.eq(sizes(zoomed), ["1024x768", "640x480"], "step 0 at 2x; the zoomed step at the crop's own 1024 x 768 (2 x 2.5 = 5x would pass the crop's 3.2x)");
const big = stills(zoomed).find((k) => k.includes("out=1024x768"))!;
h.ok(renderSlidePosterSvg(zoomed, 1).includes(zoomed.assets[big]) && !renderSlidePosterSvg(zoomed, 0).includes(zoomed.assets[big]), "the poster / PDF page of the zoomed step shows the zoomed still; step 0's does not");
h.ok((await pptxRasters(zoomed)).includes("1024x768"), "PowerPoint rasterises the zoomed step's picture at its resolution");
h.ok((await pptxRasters(none)).every((s) => s === "640x480"), "and every picture at 640 x 480 without a zoom");
await deckWith({ x: 900, y: 700, zoom: 2.5 });
h.eq([...new Set(sizes(await gather()))], ["640x480"], "a zoom that rests elsewhere (the image out of view): no zoomed still");
await deckWith({ x: 200, y: 140, zoom: 2.5 }, { x: 0, y: 0, width: 256, height: 192 });
h.eq([...new Set(sizes(await gather()))], ["640x480"], "a crop with fewer pixels than 2x the box: no zoomed still (the zoom would only magnify them)");

await fs.rm(P.scratch, { recursive: true, force: true });
await h.done();
