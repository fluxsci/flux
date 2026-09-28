"use strict";

/** Chromium quantizes custom paper sizes. Preserve the SVG's physical top-left
 * anchor while removing that paper-only rounding; never scale its content. */
async function exactFigurePdf(data, widthPt, heightPt) {
  if (![widthPt, heightPt].every(n => Number.isFinite(n) && n > 0)) {
    throw new Error("PDF dimensions must be finite and positive.");
  }
  // Native-only and lazy: document printing and the renderer do not load this.
  const { PDFDocument } = require("pdf-lib");
  const doc = await PDFDocument.load(data, { updateMetadata: false });
  if (doc.getPageCount() !== 1) {
    throw new Error("Figure PDF export produced more than one page; the previous output was preserved.");
  }
  const page = doc.getPage(0);
  if (page.getRotation().angle !== 0) throw new Error("Figure PDF export produced an unexpected page rotation.");
  const box = page.getMediaBox(), crop = page.getCropBox();
  const exact = b => b.x === 0 && b.y === 0 && b.width === widthPt && b.height === heightPt;
  if (exact(box) && exact(crop)) return data;
  // PDF origins are at bottom left. Moving by the difference between old/new
  // top edges preserves all SVG coordinates, text size and line widths. Merely
  // shrinking MediaBox clips the top edge and leaves extra paper at the bottom.
  page.translateContent(-box.x, heightPt - box.y - box.height);
  page.setMediaBox(0, 0, widthPt, heightPt);
  page.setCropBox(0, 0, widthPt, heightPt);
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

module.exports = { exactFigurePdf };
