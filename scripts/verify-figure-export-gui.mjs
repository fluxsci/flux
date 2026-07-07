// 3.1 gate (browser) — the REAL render path: a figure rasterized on an actual canvas at a
// journal column width × dpi, then encoded to TIFF/PNG. Complements the pure encoder gate
// (verify-figure-export.ts) by proving the canvas dimensions + getImageData→encoder wiring.
//   Run (dev server on :1420 must be up): node scripts/verify-figure-export-gui.mjs
import { launch, gotoApp, sleep, realErrors } from "./lib/driver.mjs";

let fails = 0;
const ok = (c, msg, extra = "") => (c ? console.log("  ✓ " + msg) : (fails++, console.log("  ✗ " + msg + (extra ? ` — ${extra}` : ""))));

const { browser, page } = await launch();
await gotoApp(page, { url: "http://127.0.0.1:1420/?fixture=demo", settle: 2500 });

const r = await page.evaluate(async () => {
  const io = await import("/src/lib/io.ts");
  const { planExport } = await import("/src/lib/figure/journalSizing.ts");
  // A shapes-only figure needs no asset store → renderFigureBytes is self-contained here.
  const fig = {
    id: "t",
    name: "Test",
    canvasId: "c",
    x: 0,
    y: 0,
    width: 800,
    height: 600,
    background: "#ffffff",
    elements: [{ id: "e1", type: "rect", x: 100, y: 100, width: 300, height: 200, fill: "#3366cc", stroke: "#000000", strokeWidth: 2, rotation: 0 }],
  };
  const u8 = (b) => Array.from(b.slice(0, 4));
  // Double column (190 mm) @ 300 dpi TIFF.
  const planT = planExport(800, 600, 190, 300);
  const tiff = await io.renderFigureBytes(fig, { format: "tiff", mm: 190, dpi: 300, transparent: false });
  const dvT = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  const leT = dvT.getUint16(0, true) === 0x4949;
  const ifd = dvT.getUint32(4, true);
  const nT = dvT.getUint16(ifd, true);
  const tags = {};
  for (let i = 0; i < nT; i++) {
    const p = ifd + 2 + i * 12;
    tags[dvT.getUint16(p, true)] = dvT.getUint32(p + 8, true);
  }
  // Single column (90 mm) @ 600 dpi PNG, transparent.
  const planP = planExport(800, 600, 90, 600);
  const png = await io.renderFigureBytes(fig, { format: "png", mm: 90, dpi: 600, transparent: true });
  const sig = Array.from(png.slice(0, 8));
  // find pHYs
  const dvP = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let p = 8;
  let phys = null;
  while (p + 8 <= png.length) {
    const len = dvP.getUint32(p);
    const type = String.fromCharCode(png[p + 4], png[p + 5], png[p + 6], png[p + 7]);
    if (type === "pHYs") phys = { ppm: dvP.getUint32(p + 8), unit: png[p + 16] };
    if (type === "IEND") break;
    p += 12 + len;
  }
  return {
    tiffHead: u8(tiff),
    leT,
    tiffW: tags[256],
    tiffH: tags[257],
    tiffResUnit: tags[296],
    planTW: planT.pxWidth,
    planTH: planT.pxHeight,
    pngSig: sig,
    phys,
    expectPpm: Math.round(600 / 0.0254),
    planPW: planP.pxWidth,
  };
});

ok(r.leT && JSON.stringify(r.tiffHead) === JSON.stringify([0x49, 0x49, 0x2a, 0x00]), "TIFF magic header from the real render", JSON.stringify(r.tiffHead));
ok(r.tiffW === r.planTW && r.tiffH === r.planTH, `TIFF dims = planExport(190mm,300dpi) = ${r.planTW}×${r.planTH} (${r.tiffW}×${r.tiffH})`);
ok(r.tiffW === 2244, `190 mm @ 300 dpi ≈ 2244 px wide (${r.tiffW})`);
ok(r.tiffResUnit === 2, "TIFF ResolutionUnit = inch");
ok(JSON.stringify(r.pngSig) === JSON.stringify([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), "PNG signature from the real render");
ok(!!r.phys && r.phys.ppm === r.expectPpm, `PNG pHYs ppm = ${r.expectPpm} (${r.phys?.ppm})`);
ok(r.phys?.unit === 1, "PNG pHYs unit = metre");

const errs = realErrors(page);
ok(errs.length === 0, "no console/page errors", errs.join(" | "));

await browser.close();
console.log(fails ? `\n${fails} FAILED` : "\nall green");
process.exit(fails ? 1 : 0);
