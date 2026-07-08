// Physical-size import gate: every import lands at its TRUE physical size on the
// canvas (96 px/inch) — an SVG's declared pt units (×4/3), a PNG's pHYs dpi
// (×96/dpi), a bare raster 1:1 — and is NEVER fit-scaled to the frame, even when
// it overflows (Figma-style; an info toast says so). Guards against the old
// 70%-fit rule, which rescaled each import by a different factor and made
// same-pt fonts land at different apparent sizes across plots.
import zlib from "node:zlib";
import { launch, gotoApp, clickNew, clickMode, sleep, realErrors } from "./lib/driver.mjs";

// A real 300×150 RGBA PNG (correct CRCs, decodable) with a pHYs chunk declaring
// 300 dpi → must place at 96×48 canvas px (1 × 0.5 inch).
function pngWithDpi300(w = 300, h = 150) {
  const crc32 = (buf) => {
    const t = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    let c = 0xffffffff;
    for (const b of buf) c = t[(c ^ b) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const phys = Buffer.alloc(9);
  phys.writeUInt32BE(11811, 0); // round(300 / 0.0254) ppm
  phys.writeUInt32BE(11811, 4);
  phys[8] = 1; // metre
  const raw = Buffer.alloc(h * (1 + w * 4));
  for (let y = 0; y < h; y++) {
    const o = y * (1 + w * 4);
    for (let x = 0; x < w; x++) {
      raw[o + 1 + x * 4] = 200;
      raw[o + 1 + x * 4 + 3] = 255;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("pHYs", phys),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]).toString("base64");
}

const svgPt = (wpt, hpt) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${wpt}pt" height="${hpt}pt" viewBox="0 0 ${wpt} ${hpt}"><rect width="${wpt}" height="${hpt}" fill="#d95f02"/></svg>`;

const { browser, page } = await launch();
await gotoApp(page);
await clickNew(page);
await clickMode(page, "Figure");
await sleep(400);

// Import via the real drop pipeline (buildIncoming → intrinsicSize → placeIncoming)
// and return only the newly added elements.
const doImport = (specs) =>
  page.evaluate(async (list) => {
    const F = window.__flux;
    const fig = F.figures()[0];
    const before = fig.elements.length;
    const files = list.map((s) =>
      s.svg
        ? new File([s.svg], s.name, { type: "image/svg+xml" })
        : new File([Uint8Array.from(atob(s.b64), (c) => c.charCodeAt(0))], s.name, { type: "image/png" }),
    );
    await F.io.importDroppedFiles(files, fig.id);
    return F.figures()[0]
      .elements.slice(before)
      .map((e) => ({ type: e.type, x: e.x, y: e.y, w: e.width, h: e.height }));
  }, specs);

const frame = await page.evaluate(() => {
  const f = window.__flux.figures()[0];
  return { w: f.width, h: f.height };
});

// 1) A 3-inch-square SVG (216 pt) → exactly 288 px, centered in the frame.
const [small] = await doImport([{ name: "small.svg", svg: svgPt(216, 216) }]);
// 2) A 14×2-inch-ish SVG (817.87 pt wide, wider than the 680 px frame) → 1090.5 px,
//    UNSCALED — it must overflow (negative x when centered), not clamp to the frame.
const [wide] = await doImport([{ name: "wide.svg", svg: svgPt(817.87, 148.84) }]);
const toastJson = await page.evaluate(() => JSON.stringify(window.__flux.get(window.__flux.toast.toasts)));
// 3) A 300-dpi 300×150 px PNG (pHYs) → 96×48 canvas px (1 × 0.5 inch).
const [png] = await doImport([{ name: "dpi300.png", b64: pngWithDpi300() }]);
// 4) Multi-import: both at true size — no group fit-downscale either.
const multi = await doImport([
  { name: "m1.svg", svg: svgPt(216, 216) },
  { name: "m2.svg", svg: svgPt(817.87, 148.84) },
]);

const near = (v, t, tol = 1) => Math.abs(v - t) <= tol;
const checks = {
  frameIsDefault: frame.w === 680 && frame.h === 850,
  svgAtPhysicalSize: !!small && near(small.w, 288) && near(small.h, 288),
  svgCentered: !!small && near(small.x, (frame.w - 288) / 2) && near(small.y, (frame.h - 288) / 2),
  oversizedUnscaled: !!wide && near(wide.w, 817.87 * (4 / 3)) && near(wide.h, 148.84 * (4 / 3)),
  oversizedOverflows: !!wide && wide.x < 0,
  overflowToastShown: /physical size/i.test(toastJson),
  pngHonorsPhys: !!png && near(png.w, 96, 0.5) && near(png.h, 48, 0.5),
  multiNoDownscale:
    multi.length === 2 && near(multi[0].w, 288) && near(multi[1].w, 817.87 * (4 / 3)),
  errs: realErrors(page),
};
const pass =
  Object.entries(checks).every(([k, v]) => (k === "errs" ? v.length === 0 : v === true));

console.log(JSON.stringify({ frame, small, wide, png, multi, ...checks, pass }, null, 2));
await browser.close();
process.exit(pass ? 0 : 1);
