// 3.1 gate (pure) — journal-spec figure export core: the baseline TIFF encoder (structure
// + resolution tags + pixel round-trip), the PNG pHYs DPI stamp (write + read), the mm↔px
// sizing, and the physical-size placement contract (assetDisplaySize / BLANK_FIGURE).
// P9: + figureToSvg group WRAPPERS (nested data-flux-group <g>s, escaped names, hidden
// groups omitted, z-order preserved) — the slides-animation handshake substrate.
//   Run: npx tsx scripts/verify-figure-export.ts
import { encodeTiff } from "../src/lib/figure/tiff";
import { injectPngDpi, readPngDpi } from "../src/lib/figure/pngDpi";
import { mmToPx, planExport, describeSize, MM_PER_INCH } from "../src/lib/figure/journalSizing";
import { assetDisplaySize, BLANK_FIGURE } from "../src/lib/ops";
import { figureToSvg } from "../src/lib/export";
import type { Element, Figure, Project } from "../src/lib/types";

let fails = 0;
const ok = (c: boolean, name: string, extra = "") => {
  console.log(`${c ? "✓" : "✗"} ${name}${c || !extra ? "" : ` — ${extra}`}`);
  if (!c) fails++;
};

// --- a tiny hand TIFF-decoder (little-endian baseline) for the round-trip -----------------
function decodeTiff(b: Uint8Array) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const LE = dv.getUint16(0, true) === 0x4949;
  const magic = dv.getUint16(2, LE);
  const ifd = dv.getUint32(4, LE);
  const n = dv.getUint16(ifd, LE);
  const tags: Record<number, { type: number; count: number; value: number }> = {};
  for (let i = 0; i < n; i++) {
    const p = ifd + 2 + i * 12;
    tags[dv.getUint16(p, LE)] = { type: dv.getUint16(p + 2, LE), count: dv.getUint32(p + 4, LE), value: dv.getUint32(p + 8, LE) };
  }
  const rational = (off: number) => dv.getUint32(off, LE) / dv.getUint32(off + 4, LE);
  return { LE, magic, tags, rational, dv };
}

// --- TIFF: opaque RGB round-trip ---------------------------------------------------------
{
  const w = 2;
  const h = 2;
  // 4 distinct pixels; alpha varies (should be dropped in opaque mode).
  const rgba = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 255, 10, 20, 30, 0]);
  const tif = encodeTiff(rgba, w, h, { dpi: 300 });
  const d = decodeTiff(tif);
  ok(d.LE && d.magic === 42, "TIFF little-endian header + magic 42");
  ok(d.tags[256].value === w && d.tags[257].value === h, "ImageWidth/Length correct");
  ok(d.tags[259].value === 1, "Compression = none");
  ok(d.tags[262].value === 2, "Photometric = RGB");
  ok(d.tags[277].value === 3, "SamplesPerPixel = 3 (opaque drops alpha)");
  ok(d.tags[296].value === 2, "ResolutionUnit = inch");
  ok(d.rational(d.tags[282].value) === 300 && d.rational(d.tags[283].value) === 300, "X/YResolution = 300");
  ok(d.tags[338] === undefined, "no ExtraSamples when opaque");
  // pixel round-trip (RGB only)
  const strip = d.tags[273].value;
  const got = [...tif.slice(strip, strip + w * h * 3)];
  const want = [255, 0, 0, 0, 255, 0, 0, 0, 255, 10, 20, 30];
  ok(JSON.stringify(got) === JSON.stringify(want), "RGB pixels round-trip", JSON.stringify(got));
}

// --- TIFF: transparent RGBA ---------------------------------------------------------------
{
  const rgba = new Uint8Array([1, 2, 3, 200, 4, 5, 6, 100]);
  const tif = encodeTiff(rgba, 2, 1, { dpi: 600, alpha: true });
  const d = decodeTiff(tif);
  ok(d.tags[277].value === 4, "SamplesPerPixel = 4 with alpha");
  ok(d.tags[338]?.value === 2, "ExtraSamples = unassociated alpha");
  ok(d.rational(d.tags[282].value) === 600, "XResolution = 600");
  const strip = d.tags[273].value;
  ok(JSON.stringify([...tif.slice(strip, strip + 8)]) === JSON.stringify([1, 2, 3, 200, 4, 5, 6, 100]), "RGBA pixels round-trip");
}

// --- PNG pHYs injection ------------------------------------------------------------------
function findPhys(png: Uint8Array): { ppmX: number; ppmY: number; unit: number; count: number } | null {
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let p = 8;
  let found: { ppmX: number; ppmY: number; unit: number } | null = null;
  let count = 0;
  let afterIhdr = false;
  let physRightAfterIhdr = false;
  while (p + 8 <= png.length) {
    const len = dv.getUint32(p);
    const type = String.fromCharCode(png[p + 4], png[p + 5], png[p + 6], png[p + 7]);
    if (type === "pHYs") {
      count++;
      if (afterIhdr && found === null) physRightAfterIhdr = true;
      found = { ppmX: dv.getUint32(p + 8), ppmY: dv.getUint32(p + 12), unit: png[p + 16] };
    }
    if (type === "IHDR") afterIhdr = true;
    else if (type !== "pHYs") afterIhdr = false;
    if (type === "IEND") break;
    p += 12 + len;
  }
  return found ? { ...found, count, ...(physRightAfterIhdr ? {} : {}) } : null;
}
// A minimal valid PNG: signature + IHDR (1x1) + IDAT (empty-ish) + IEND. We don't need it to
// be decodable — injectPngDpi only walks chunk headers.
function fakePng(): Uint8Array {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const chunk = (type: string, data: number[]) => {
    const t = [...type].map((c) => c.charCodeAt(0));
    const len = data.length;
    return [(len >>> 24) & 255, (len >>> 16) & 255, (len >>> 8) & 255, len & 255, ...t, ...data, 0, 0, 0, 0];
  };
  return new Uint8Array([...sig, ...chunk("IHDR", [0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]), ...chunk("IDAT", [1, 2, 3]), ...chunk("IEND", [])]);
}
{
  const png = fakePng();
  const out = injectPngDpi(png, 300);
  const phys = findPhys(out);
  const expectPpm = Math.round(300 / 0.0254);
  ok(!!phys, "pHYs chunk present after injection");
  ok(phys?.ppmX === expectPpm && phys?.ppmY === expectPpm, `ppm = round(dpi/0.0254) = ${expectPpm} (${phys?.ppmX})`);
  ok(phys?.unit === 1, "pHYs unit = metre");
  // Re-injection replaces, not duplicates.
  const out2 = injectPngDpi(out, 600);
  const phys2 = findPhys(out2);
  ok(phys2?.count === 1, "re-inject replaces the existing pHYs (no duplicate)");
  ok(phys2?.ppmX === Math.round(600 / 0.0254), "re-inject updates the dpi");
  // Non-PNG passthrough.
  const notPng = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  ok(injectPngDpi(notPng, 300) === notPng, "non-PNG returned unchanged");
}

// --- PNG pHYs read-back (the import side of physical sizing) ------------------------------
{
  const png = fakePng();
  ok(readPngDpi(png) === null, "no pHYs → null (bare raster: 1 px = 1 canvas px)");
  const dpi = readPngDpi(injectPngDpi(png, 300));
  ok(dpi !== null && Math.abs(dpi - 300) < 0.01, `inject 300 → read ${dpi} (ppm rounding < 0.01)`);
  const dpi600 = readPngDpi(injectPngDpi(png, 600));
  ok(dpi600 !== null && Math.abs(dpi600 - 600) < 0.01, "inject 600 → read 600");
  ok(readPngDpi(new Uint8Array([1, 2, 3])) === null, "non-PNG → null");
  // A unit-0 pHYs (aspect-ratio only, no physical meaning) must NOT be read as a dpi.
  const stamped = injectPngDpi(png, 300);
  const unit0 = new Uint8Array(stamped);
  for (let p = 8; p + 8 <= unit0.length; ) {
    const len = (unit0[p] << 24) | (unit0[p + 1] << 16) | (unit0[p + 2] << 8) | unit0[p + 3];
    const type = String.fromCharCode(unit0[p + 4], unit0[p + 5], unit0[p + 6], unit0[p + 7]);
    if (type === "pHYs") unit0[p + 16] = 0;
    p += 12 + len;
  }
  ok(readPngDpi(unit0) === null, "unit-0 pHYs (aspect only) → null");
}

// --- physical-size placement contract ------------------------------------------------------
{
  // The default frame IS 180 × 225 mm expressed at 96 px/inch (within half-px rounding).
  ok(Math.abs((BLANK_FIGURE.width / 96) * MM_PER_INCH - 180) < 0.15, "BLANK_FIGURE width ≡ 180 mm");
  ok(Math.abs((BLANK_FIGURE.height / 96) * MM_PER_INCH - 225) < 0.15, "BLANK_FIGURE height ≡ 225 mm");
  const proj = {
    assets: [
      { id: "svg1", name: "a.svg", kind: "svg", path: "assets/svg1.svg", naturalWidth: 570, naturalHeight: 198 },
      { id: "png1", name: "b.png", kind: "png", path: "assets/png1.png", naturalWidth: 2126, naturalHeight: 2657, dpi: 300 },
      { id: "png2", name: "c.png", kind: "png", path: "assets/png2.png", naturalWidth: 800, naturalHeight: 600 },
    ],
  } as unknown as Project;
  const svg = assetDisplaySize(proj, "svg1");
  ok(!!svg && svg.width === 570 && svg.height === 198, "svg: natural CSS px ARE physical (no rescale)");
  const png = assetDisplaySize(proj, "png1");
  ok(!!png && Math.abs(png.width - 2126 * (96 / 300)) < 1e-9, "png with pHYs: ×96/dpi (300-dpi full-pager → 680.3 px)");
  ok(!!png && Math.abs((png.width / 96) * MM_PER_INCH - 180) < 0.05, "…which is 180 mm on the canvas");
  const bare = assetDisplaySize(proj, "png2");
  ok(!!bare && bare.width === 800, "bare png: 1 image px = 1 canvas px");
  ok(assetDisplaySize(proj, "missing") === null, "unknown asset → null");
}

// --- figureToSvg group wrappers (P9 — the groups→slides export substrate) -----------------
{
  const rect = (id: string, x: number, fill: string, groupId?: string): Element =>
    ({ type: "rect", id, x, y: 20, width: 100, height: 80, rotation: 0, fill, stroke: "#222222", strokeWidth: 2, cornerRadius: 0, ...(groupId ? { groupId } : {}) }) as Element;
  const fig: Figure = {
    id: "figW", name: "W", canvasId: "c1", x: 0, y: 0, width: 800, height: 500, background: "transparent",
    elements: [
      rect("a", 10, "#d62728", "gA"),
      rect("b", 120, "#2ca02c", "gB"), // nested: gB inside gA
      rect("c", 240, "#1f77b4"), // loose
      rect("d", 360, "#9467bd", "gH"), // hidden group
    ],
    groups: {
      gA: { id: "gA", name: 'A "quoted" & <named>' },
      gB: { id: "gB", name: "Inner", parentId: "gA" },
      gH: { id: "gH", name: "Off", hidden: true },
    },
  } as Figure;
  const svg = figureToSvg(fig, () => undefined);
  ok(svg.includes('id="figW__group:gA"') && svg.includes('id="figW__group:gB"'), "group wrappers emitted (<figId>__group:<gid>)");
  ok(svg.includes('data-flux-group="A &quot;quoted&quot; &amp; &lt;named&gt;"'), "group name escaped in data-flux-group");
  const iA = svg.indexOf('id="figW__group:gA"');
  const iB = svg.indexOf('id="figW__group:gB"');
  const closeB = svg.indexOf("</g>", iB);
  ok(iA >= 0 && iB > iA && svg.indexOf("</g>", closeB + 1) > closeB, "nested group's wrapper opens inside its parent's (nesting nests)");
  ok(!svg.includes("#9467bd") && !svg.includes("group:gH"), "hidden group omitted — members and wrapper");
  ok(svg.indexOf("#d62728") < svg.indexOf("#2ca02c") && svg.indexOf("#2ca02c") < svg.indexOf("#1f77b4"), "z-order preserved through the tree render");
  const flat: Figure = { ...fig, id: "flat", elements: fig.elements.map((e) => { const c = { ...e } as Element & { groupId?: string }; delete c.groupId; return c; }) } as Figure;
  delete (flat as { groups?: unknown }).groups;
  ok(!figureToSvg(flat, () => undefined).includes("data-flux-group"), "ungrouped figure exports with no wrappers (flat degenerate case)");
}

// --- sizing ------------------------------------------------------------------------------
{
  ok(mmToPx(90, 300) === Math.round((90 / MM_PER_INCH) * 300), `mmToPx(90,300) = ${mmToPx(90, 300)}`);
  ok(mmToPx(MM_PER_INCH, 300) === 300, "1 inch @ 300 dpi = 300 px");
  const plan = planExport(800, 600, 90, 300);
  ok(plan.pxWidth === mmToPx(90, 300), "planExport width = mmToPx");
  ok(Math.abs(plan.pxHeight / plan.pxWidth - 600 / 800) < 0.01, "planExport preserves aspect ratio");
  ok(Math.abs(plan.scale - plan.pxWidth / 800) < 1e-9, "planExport scale = pxWidth / designWidth");
  ok(/@ 300 dpi/.test(describeSize(plan.pxWidth, plan.pxHeight, 300)), "describeSize reports dpi");
}

console.log(fails ? `\n${fails} FAILED` : "\nall green");
process.exit(fails ? 1 : 0);
