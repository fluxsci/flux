// Generates scripts/fixtures/reader-sample.pdf — the committed 3-page fixture the
// reader verify scripts seed via window.__fluxSeedReaderItem (devSeed.ts). Kept as a
// generator (not just the binary) so the fixture is reproducible/extensible:
//   node scripts/fixtures/gen-reader-sample.mjs
// Layout: page 1 = selectable prose + a "[1]" citation carrying a /Link annotation
// whose /Dest is the bibliography entry on page 3 (Phase 4's citation-hover target);
// page 2 = filler prose (virtualization + orphan tests); page 3 = "References".
// Plain PDF 1.4, uncompressed streams, core Helvetica (pdf.js standard_fonts).
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const esc = (s) => s.replace(/[\\()]/g, (c) => "\\" + c);

/** One BT…ET block: `lines` drawn from (x, y) downward with the given leading. */
function block(lines, { x = 72, y = 720, size = 12, leading = 16 } = {}) {
  const parts = [`BT`, `/F1 ${size} Tf`, `${leading} TL`, `${x} ${y} Td`];
  lines.forEach((l, i) => parts.push(`${i ? "T* " : ""}(${esc(l)}) Tj`));
  parts.push(`ET`);
  return parts.join("\n");
}

const page1Lines = [
  "FluxReader Fixture: Conscious Overflow, Downgraded",
  "The quick brown fox jumps over the lazy dog on page one.",
  "We seem to experience a rich visual world as we move through it.",
  "Vision scientists have a special affinity for phenomenologically",
  "convincing demonstrations of visual phenomena and their limits.",
  "When a new phenomenon works as a demo, it effectively reveals",
  "an aspect of how the mind works to anyone willing to look.",
  "Change blindness and inattentional blindness are failures of",
  "awareness that any serious theory must accommodate in full.",
  "In short, vision scientists take phenomenology seriously.",
];
const stream1 =
  block(page1Lines, { y: 720 }) +
  "\n" +
  block(["The key evidence for this claim is reviewed in"], { x: 72, y: 420 }) +
  "\n" +
  block(["[1]"], { x: 330, y: 420 });

const stream2 = block(
  [
    "Page two continues the argument about conscious overflow and",
    "the degree to which phenomenology outruns cognitive access.",
    "Sparse theories hold that awareness is thin; rich theories hold",
    "that experience overflows report. The debate turns on whether",
    "failures of memory or comparison can be ruled out as causes.",
  ],
  { y: 720 },
);

const stream3 = block(
  [
    "References",
    "",
    "[1] Ward, E. J. (2018). Downgraded phenomenology: how conscious",
    "overflow lost its richness. Phil. Trans. R. Soc. B 373: 20170355.",
    "",
    "[2] Block, N. (2011). Perceptual consciousness overflows cognitive",
    "access. Trends in Cognitive Sciences 15(12): 567-575.",
  ],
  { y: 720 },
);

const contents = (s) => `<< /Length ${s.length} >>\nstream\n${s}\nendstream`;
const page = (contentsRef, extra = "") =>
  `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 9 0 R >> >> /Contents ${contentsRef}${extra} >>`;

const objs = [];
objs[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
objs[2] = `<< /Type /Pages /Kids [3 0 R 5 0 R 7 0 R] /Count 3 >>`;
objs[3] = page("4 0 R", " /Annots [10 0 R]");
objs[4] = contents(stream1);
objs[5] = page("6 0 R");
objs[6] = contents(stream2);
objs[7] = page("8 0 R");
objs[8] = contents(stream3);
objs[9] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`;
// "[1]" sits at x=330, y=420 (12pt) → clickable rect with a little padding.
objs[10] = `<< /Type /Annot /Subtype /Link /Rect [326 414 356 434] /Border [0 0 0] /Dest [7 0 R /XYZ 50 740 null] >>`;

let out = "%PDF-1.4\n";
const offsets = [0];
for (let i = 1; i < objs.length; i++) {
  offsets[i] = out.length;
  out += `${i} 0 obj\n${objs[i]}\nendobj\n`;
}
const xref = out.length;
out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
for (let i = 1; i < objs.length; i++) out += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

const here = dirname(fileURLToPath(import.meta.url));
writeFileSync(join(here, "reader-sample.pdf"), out, "latin1");
console.log(`wrote reader-sample.pdf (${out.length} bytes, 3 pages)`);
