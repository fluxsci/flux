#!/usr/bin/env -S node --import tsx
// Slide decks export to PDF (2026-09-24, owner request) — the pure half.
//
// deckPdfDocument builds the printable HTML the main process's static print
// worker turns into a PDF (print:pdf, @page-sized, scripts off). Checked here
// against a real on-disk project:
//   • "final": one page per slide, each with every build step applied;
//   • "steps": one page per build step, so an element that enters at step 2 is
//     absent from pages 1-2 and present from page 3;
//   • pages are exactly the deck stage (@page size, page boxes, block svgs), and
//     the last page does not push a blank sheet after itself;
//   • a slide's video contributes its poster, never the movie bytes.
// Also the content-scale applicability check (owner report 2026-09-24: "the
// content scale seems not to work" on PNG-wrapped-in-SVG pictures):
// hasContentScaleTargets is false for a raster-only or fill-only graphic and
// true once there is text or a stroke.
//   Run: node --import tsx scripts/verify-slide-pdf.ts
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parseHTML } from "linkedom";
import { harness } from "./lib/harness.mjs";
import { createDeck } from "../src/lib/slide/ops";
import { buildScaffoldTree } from "../src/lib/project/scaffoldTree";
import { deckPdfDocument, pdfStepsFor } from "../src/lib/slide/export/deckPdf";
import { hasContentScaleTargets } from "../src/lib/plot/compensate";

const h = harness("verify-slide-pdf");
const { document, DOMParser, XMLSerializer } = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, { document, DOMParser, XMLSerializer });


// ---- the page plan ----------------------------------------------------------
h.ok(JSON.stringify(pdfStepsFor(1, "final")) === "[0]" && JSON.stringify(pdfStepsFor(3, "final")) === "[2]",
  "final: one page per slide, at its last build step");
h.ok(JSON.stringify(pdfStepsFor(3, "steps")) === "[0,1,2]" && JSON.stringify(pdfStepsFor(0, "steps")) === "[0]",
  "steps: one page per build step (a slide with no steps still gets its page)");

// ---- a real project on disk -------------------------------------------------
const root = await fs.mkdtemp(path.join(os.tmpdir(), "flux-slide-pdf-"));
try {
  const deck = createDeck({ id: "pdf-deck", title: "PDF <acceptance>", withTitleSlide: false });
  deck.stage = { width: 640, height: 360 };
  const text = (id: string, t: string, y: number) => ({ id, type: "text", name: id, x: 40, y, width: 400, height: 40, rotation: 0,
    text: t, fontFamily: "Arial", fontSize: 24, fontWeight: 400, fontStyle: "normal", align: "left", color: "#111111", sizing: "fixed" });
  deck.slides = [
    { id: "s1", name: "Title", elements: [text("title", "PDF-TITLE-MARK", 40)], beats: [{ id: "b0", tracks: [] }] },
    { id: "s2", name: "Builds", elements: [text("always", "ALWAYS-MARK", 40), text("late", "LATE-MARK", 120)],
      beats: [{ id: "c0", tracks: [] }, { id: "c1", tracks: [] }, { id: "c2", tracks: [{ id: "enter", target: "late", preset: "fade", duration: 300, easing: "linear" }] }] },
  ] as typeof deck.slides;
  const tree = buildScaffoldTree({ title: "PDF acceptance" }, deck);
  for (const dir of tree.dirs) await fs.mkdir(path.join(root, dir), { recursive: true });
  for (const [rel, body] of tree.files) { await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true }); await fs.writeFile(path.join(root, rel), body); }
  let videoReads = 0;
  const io = {
    readText: (p: string) => fs.readFile(p, "utf8"),
    readFile: async (p: string) => { if (p.toLowerCase().endsWith(".mp4") || p.toLowerCase().endsWith(".mov")) videoReads++; const b = await fs.readFile(p); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); },
  };
  const rootPath = root.replace(/\\/g, "/");

  const final = await deckPdfDocument(rootPath, "pdf-deck", io, "final");
  const pagesOf = (html: string) => html.split('<div class="page">').slice(1);
  h.ok(final.pages === 2 && pagesOf(final.html).length === 2, `final: 2 slides make 2 pages (${final.pages})`);
  h.ok(pagesOf(final.html)[1].includes("LATE-MARK"), "final: the builds slide shows the element that enters at its last step");

  const steps = await deckPdfDocument(rootPath, "pdf-deck", io, "steps");
  const sp = pagesOf(steps.html);
  h.ok(steps.pages === 4 && sp.length === 4, `steps: 1 + 3 build steps make 4 pages (${steps.pages})`);
  const lateVisible = (page: string) => {
    const at = page.indexOf("LATE-MARK");
    if (at < 0) return false;
    const open = page.lastIndexOf("<g", at);
    const head = page.slice(open, at);
    return !head.includes('visibility="hidden"') && !head.includes('display="none"');
  };
  h.ok(sp[0].includes("PDF-TITLE-MARK") && sp[1].includes("ALWAYS-MARK") && !lateVisible(sp[1]) && !lateVisible(sp[2]) && lateVisible(sp[3]),
    "steps: the late element is absent before its step and present on its step's page");
  h.ok(steps.html.includes("@page{size:640px 360px;margin:0}") && steps.html.includes(".page{width:640px;height:360px;"),
    "pages are exactly the stage size");
  h.ok(steps.html.includes(".page:last-child{break-after:auto"), "the last page does not add a blank sheet");
  h.ok(steps.html.includes("<title>PDF &lt;acceptance></title>"), "the deck title is escaped into the document title");
  h.ok(!steps.html.toLowerCase().includes("<script"), "the printable document carries no script");
  h.ok(videoReads === 0, "no movie bytes are read for a static export");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}

// ---- content scale applicability -------------------------------------------
const svg = (body: string) => new DOMParser().parseFromString(`<svg xmlns="http://www.w3.org/2000/svg" width="80" height="60">${body}</svg>`, "image/svg+xml").documentElement as unknown as Element;
h.ok(!hasContentScaleTargets(svg(`<image width="80" height="60" href="data:image/png;base64,AAAA"/>`)),
  "a raster picture wrapped in SVG has nothing content scale acts on");
h.ok(!hasContentScaleTargets(svg(`<rect width="10" height="10" fill="#f00"/><path d="M0 0L5 5" fill="#00f"/>`)),
  "filled shapes alone have nothing content scale acts on");
h.ok(hasContentScaleTargets(svg(`<g><text x="1" y="10">label</text></g>`)), "text is a content-scale target");
h.ok(hasContentScaleTargets(svg(`<path d="M0 0L5 5" stroke="#000"/>`)), "a stroke is a content-scale target");
h.ok(!hasContentScaleTargets(svg(`<defs><text>x</text></defs><image width="8" height="6"/>`)), "text inside <defs> does not count");

await h.done();
