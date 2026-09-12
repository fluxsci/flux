#!/usr/bin/env -S npx tsx
// Word paints NOTHING for an SVG picture whose <a:blip> carries no raster fallback.
//
// Pandoc can only emit the raster+vector pair when `rsvg-convert` is on PATH, which it
// is not on a stock Windows/macOS machine (Quarto does not bundle it). It then writes a
// blip holding only the asvg:svgBlip extension and no r:embed. Word reserves the
// picture's space and draws nothing — verified 2026-09-12 by driving Word over COM: it
// reported 2 InlineShapes at their correct 60×30pt, and the PDF it exported from that
// document contained no painted image. The export reported success the whole time.
//
// This gate pins the repair: the blip gains its own r:embed pointing at a PNG part that
// really exists, the svgBlip extension survives so a capable Word still gets the vector,
// and the package stays valid OPC — every part content-typed, every relationship id
// unique. The rasterizer is injected, so this runs hermetically with a stub.
//   npx tsx scripts/verify-docx-svg-fallback.ts

import { zipSync, unzipSync, strToU8, strFromU8 } from "fflate";
import { harness } from "./lib/harness.mjs";
import { addSvgRasterFallbacks, rasterSizeFor } from "../src/lib/references/docxSvgFallback";

const h = harness("verify-docx-svg-fallback");

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const stubRaster = async () => PNG;
const failingRaster = async () => {
  throw new Error("no rasterizer");
};

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300"><rect width="400" height="300"/></svg>';

/** A docx shaped exactly like pandoc's rsvg-less output. */
function docx(opts: { blip: string; extraRels?: string; media?: Record<string, Uint8Array> } = { blip: "" }): Uint8Array {
  const drawing =
    '<w:drawing><wp:inline><wp:extent cx="5334000" cy="4000500"/><a:graphic><a:graphicData><pic:pic><pic:blipFill>' +
    opts.blip +
    "</pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing>";
  return zipSync({
    "[Content_Types].xml": strToU8(
      '<?xml version="1.0"?><Types xmlns="x"><Default Extension="xml" ContentType="application/xml"/>' +
        '<Default Extension="rels" ContentType="a"/><Default Extension="svg" ContentType="image/svg+xml"/>' +
        '<Override PartName="/word/document.xml" ContentType="d"/></Types>',
    ),
    "_rels/.rels": strToU8('<?xml version="1.0"?><Relationships xmlns="x"><Relationship Id="rId1"/></Relationships>'),
    "word/document.xml": strToU8(`<?xml version="1.0"?><w:document><w:body><w:p>${drawing}</w:p></w:body></w:document>`),
    "word/_rels/document.xml.rels": strToU8(
      '<?xml version="1.0"?><Relationships xmlns="x">' +
        '<Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/pic.svg"/>' +
        (opts.extraRels ?? "") +
        "</Relationships>",
    ),
    "word/media/pic.svg": strToU8(SVG),
    ...(opts.media ?? {}),
  });
}

const SVG_ONLY_BLIP =
  "<a:blip><a:extLst><a:ext uri=\"{96DAC541-7B7A-43D3-8B79-37D633B846F1}\">" +
  '<asvg:svgBlip xmlns:asvg="http://schemas.microsoft.com/office/drawing/2016/SVG/main" r:embed="rId9"/>' +
  "</a:ext></a:extLst></a:blip>";

const doc = (b: Uint8Array) => strFromU8(unzipSync(b)["word/document.xml"]);
const names = (b: Uint8Array) => Object.keys(unzipSync(b));

// ---- the repair ---------------------------------------------------------------
{
  const { bytes, report } = await addSvgRasterFallbacks(docx({ blip: SVG_ONLY_BLIP }), stubRaster);
  h.ok(report.added === 1 && !report.failed.length, "an svg-only picture gains a fallback");
  const d = doc(bytes);
  const blip = /<a:blip[^>]*>/.exec(d)?.[0] ?? "";
  h.ok(/r:embed="rId\d+"/.test(blip), `the blip now carries its own r:embed (${blip})`);
  h.ok(d.includes("asvg:svgBlip"), "the svgBlip extension SURVIVES — a capable Word still paints the vector");

  const embed = /r:embed="(rId\d+)"/.exec(blip)![1];
  const rels = strFromU8(unzipSync(bytes)["word/_rels/document.xml.rels"]);
  const target = new RegExp(`Id="${embed}"[^>]*Target="([^"]+)"`).exec(rels)?.[1] ?? "";
  h.ok(!!target, `the new relationship exists (${embed} -> ${target})`);
  h.ok(names(bytes).includes(`word/${target}`), "…and the PNG part it names really exists in the package");
  h.ok(embed !== "rId9", "the fresh id does not collide with the existing image relationship");

  const ct = strFromU8(unzipSync(bytes)["[Content_Types].xml"]);
  h.ok(/Extension="png"/i.test(ct), "png is declared in [Content_Types].xml");
  // The whole-package invariant: an undeclared part makes Word refuse the document.
  const defaults = new Set([...ct.matchAll(/<Default Extension="([^"]+)"/g)].map((m) => m[1].toLowerCase()));
  const overrides = new Set([...ct.matchAll(/<Override PartName="([^"]+)"/g)].map((m) => m[1]));
  const untyped = names(bytes).filter(
    (n) => !n.endsWith("/") && !defaults.has(n.split(".").pop()!.toLowerCase()) && !overrides.has(`/${n}`),
  );
  h.ok(untyped.length === 0, `every part still has a content type (${JSON.stringify(untyped)})`);
}

// ---- what it must NOT touch ---------------------------------------------------
{
  const already =
    '<a:blip r:embed="rId9"><a:extLst><a:ext uri="{96DAC541-7B7A-43D3-8B79-37D633B846F1}">' +
    '<asvg:svgBlip xmlns:asvg="m" r:embed="rId9"/></a:ext></a:extLst></a:blip>';
  const { bytes, report } = await addSvgRasterFallbacks(docx({ blip: already }), stubRaster);
  h.ok(report.alreadyRaster === 1 && report.added === 0, "a picture that already has a raster is left alone");
  h.ok(bytes === (undefined as never) || names(bytes).every((n) => !n.includes("fallback")), "…and no PNG is added");

  const plain = '<a:blip r:embed="rId9"/>';
  const r2 = await addSvgRasterFallbacks(docx({ blip: plain }), stubRaster);
  h.ok(r2.report.added === 0, "an ordinary raster picture is untouched");

  const bare = "<a:blip/>";
  const r3 = await addSvgRasterFallbacks(docx({ blip: bare }), stubRaster);
  h.ok(r3.report.added === 0 && !r3.report.failed.length, "a blip with neither raster nor svg is not ours to repair");
}

// ---- failure is never silent, and never corrupts ------------------------------
{
  const { bytes, report } = await addSvgRasterFallbacks(docx({ blip: SVG_ONLY_BLIP }), failingRaster);
  h.ok(report.failed.length === 1 && report.added === 0, "a rasterizer failure is REPORTED, not swallowed");
  h.ok(doc(bytes).includes("asvg:svgBlip"), "…and the picture is left exactly as it was");
  h.ok(!doc(bytes).includes("r:embed=\"rId10\""), "…with no dangling reference to a PNG that was never written");
}

// ---- rasterization size -------------------------------------------------------
{
  // wp:extent is EMU; 9525 per px at 96dpi, times the 2x oversample.
  const withExtent = '<wp:extent cx="952500" cy="476250"/><a:blip>';
  const s1 = rasterSizeFor(withExtent, withExtent.indexOf("<a:blip"), SVG);
  h.ok(s1.width === 200 && s1.height === 100, `wp:extent drives the raster size (${s1.width}x${s1.height})`);

  const noExtent = "<a:blip>";
  const s2 = rasterSizeFor(noExtent, 0, SVG);
  h.ok(s2.width === 800 && s2.height === 600, `without an extent it falls back to the viewBox (${s2.width}x${s2.height})`);

  const huge = '<wp:extent cx="9999999999" cy="9999999999"/><a:blip>';
  const s3 = rasterSizeFor(huge, huge.indexOf("<a:blip"), SVG);
  h.ok(s3.width <= 32767 && s3.height <= 32767, `an absurd extent is clamped below the canvas ceiling (${s3.width})`);
  h.ok(s3.width >= 1 && s3.height >= 1, "…and never collapses to zero");
}

await h.done();
