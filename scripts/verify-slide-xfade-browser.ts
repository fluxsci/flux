// T5: a (1-t, t) opacity crossfade of two opaque boxes leaves the content 75 % covering at t = .5 (it dips toward the
// backdrop). Both crossfade paths (a hand-off's box pair in handoff.ts, an asset-swap Change's layers in transform.ts)
// add the pair in premultiplied space (mix-blend-mode: plus-lighter) inside an isolated group, so coverage stays full.
// Runs the REAL capture document (the one video export seeks) in headless Chrome. Not covered here: Electron compositing.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { pathToFileURL } from "node:url";
import { createDeck, addSlide, addElement, addBeat, becomeTransform, setTransform } from "../src/lib/slide/ops";
import { exportSlideVideoHtml } from "../src/lib/slide/export/exportDeck";
import { harness } from "./lib/harness.mjs";
import { launch } from "./lib/driver.mjs";

const h = harness("verify-slide-xfade-browser");
/** A solid 64 x 40 RGB PNG (the gate needs a DARK raster as well as a white one). */
function solidPng(r: number, g: number, b: number): string {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf: Buffer) => { let c = 0xffffffff; for (const x of buf) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => { const body = Buffer.concat([Buffer.from(type), data]), out = Buffer.alloc(body.length + 8); out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE(crc(body), body.length + 4); return out; };
  const w = 64, h = 40, raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return "data:image/png;base64," + Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]).toString("base64");
}
const WHITE = solidPng(255, 255, 255), BLACK = solidPng(8, 8, 8);
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "flux-xfade-"));
let browser: Awaited<ReturnType<typeof launch>>["browser"] | undefined;
/** `dark` swaps the scene: a near-black box on a white stage (the coverage dip then LIGHTENS the box toward the paper). */
function build(mode: "handoff" | "change", dark = false) {
  const deck = createDeck({ id: "xf", title: "xf", withTitleSlide: false });
  deck.stage = { width: 640, height: 360 }; deck.background = dark ? "#ffffff" : "#100f0f"; deck.defaults.transition = "none";
  for (const id of ["img1", "img2"]) deck.assets.push({ id, name: id, kind: "png", path: `assets/${id}.png`, naturalWidth: 64, naturalHeight: 40 });
  const s = addSlide(deck, { id: "x", layout: "blank" });
  if (mode === "handoff") {
    addElement(deck, s.id, { type: "rect", id: "r", x: 120, y: 110, width: 160, height: 100, rotation: 0, fill: dark ? "#080808" : "#ffffff", stroke: "none", strokeWidth: 0, cornerRadius: 0 } as any);
    addElement(deck, s.id, { type: "image", id: "im", assetId: "img1", x: 360, y: 110, width: 160, height: 100, rotation: 0 } as any);
    const b = addBeat(deck, s.id, { id: "b1" }); becomeTransform(deck, s.id, b.id, "r", "im", { mode: "handoff" });
  } else {
    addElement(deck, s.id, { type: "image", id: "im", assetId: "img1", x: 240, y: 110, width: 160, height: 100, rotation: 0 } as any);
    const b = addBeat(deck, s.id, { id: "b1" }); setTransform(deck, s.id, b.id, "im", { toAssetId: "img2" });
  }
  for (const t of s.beats.flatMap((b) => b.tracks)) { t.duration = 1000; t.easing = "linear"; }
  const img = dark ? BLACK : WHITE;
  return { deck, assets: { img1: img, img2: img }, assetSizes: { img1: { width: 64, height: 40 }, img2: { width: 64, height: 40 } } };
}
/** The extreme luminance of a screenshot: its brightest pixel (white box on a dark stage) or darkest (dark box on paper). */
const extreme = (data: string, dark: boolean) => (async (d: string) => {
  const img = new Image(); img.src = "data:image/png;base64," + d; await img.decode();
  const c = document.createElement("canvas"); c.width = img.width; c.height = img.height; const k = c.getContext("2d")!; k.drawImage(img, 0, 0);
  const px = k.getImageData(0, 0, c.width, c.height).data; let m = dark ? 255 : 0;
  for (let i = 0; i < px.length; i += 4) { const l = 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]; m = dark ? Math.min(m, l) : Math.max(m, l); }
  return Math.round(m);
})(data);
try {
  ({ browser } = await launch({ width: 1280, height: 720 }));
  for (const dark of [false, true]) for (const mode of ["handoff", "change"] as const) {
    h.section(`${dark ? "near-black" : "white"} box crossfade (${mode}) on a ${dark ? "white" : "dark"} stage`);
    const file = path.join(tmp, `${mode}${dark ? "-dark" : ""}.html`);
    await fs.writeFile(file, await exportSlideVideoHtml(build(mode, dark) as any, { height: 720, fps: 60, startHoldMs: 100, stepDelayMs: 100, endHoldMs: 200 }));
    const page = await browser.newPage();
    await page.setViewport({ width: 2, height: 2, deviceScaleFactor: 1 });
    await page.goto(pathToFileURL(file).href);
    const info = await page.evaluate("window.fluxVideoReady") as { width: number; height: number; frames: number };
    await page.setViewport({ width: info.width, height: info.height, deviceScaleFactor: 1 });
    // light box: the worst (lowest) peak over the flight; dark box: the worst (highest) darkest pixel
    let worst = dark ? 0 : 255, worstFrame = -1;
    for (let f = 8; f <= 64; f += 2) {   // the flight (100 ms hold = frame 6, 1000 ms = 60 frames)
      await page.evaluate(`window.fluxVideo.frame(${f})`);
      await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
      const b64 = await page.screenshot({ encoding: "base64", type: "png" });
      const value = await page.evaluate(`(${extreme.toString()})(${JSON.stringify(b64)}, ${dark})`) as number;
      if (worstFrame < 0 || (dark ? value > worst : value < worst)) { worst = value; worstFrame = f; }
      if (mode === "handoff" && !dark && f === 36) {
        const dom = await page.evaluate(() => {
          const layer = document.querySelector("g.sl-handoff") as SVGElement | null, hosts = Array.from(document.querySelectorAll("g[data-xfade]")) as SVGElement[];
          return { layerIsolated: !!layer && layer.style.isolation === "isolate", hosts: hosts.length, hostsIsolated: hosts.every((g) => g.style.isolation === "isolate"), blended: hosts.every((g) => Array.from(g.children).every((c) => (c as SVGElement).style.mixBlendMode === "plus-lighter")) };
        });
        h.ok(!dom.layerIsolated, "the flight layer itself is NOT isolated (a path beneath a pair must not be added into)");
        h.ok(dom.hosts === 1 && dom.hostsIsolated && dom.blended, "each two-sided crossfade pair has its OWN isolated group with both clones plus-lighter");
      }
    }
    if (dark) h.ok(worst <= 40, `the near-black box never washes out toward the paper: its darkest pixel stays <= 40 for the whole flight (worst ${worst} at frame ${worstFrame}; was 73 with plain opacity)`);
    else h.ok(worst >= 250, `peak luminance of the white box stays >= 250 for the whole flight (worst ${worst} at frame ${worstFrame}; was 195 with plain opacity)`);
    await page.close();
  }
} finally { await browser?.close(); await fs.rm(tmp, { recursive: true, force: true }); }
await h.done();
