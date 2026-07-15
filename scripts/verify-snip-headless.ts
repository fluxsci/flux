// Pure gate for the headless paper-snip engine (flux-core/snips.ts + the
// snip_paper/get_citation registry verbs): rasterizes a real fixture PDF via
// pdf.js legacy + @napi-rs/canvas into a temp project, and asserts the exact
// same provenance contract the GUI writes (pHYs dpi, flux-snip tEXt, sidecar,
// naming, dedup, citation). Hermetic: temp dirs, no network, no dev server.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { harness } from "./lib/harness.mjs";
import { snipPaper, getCitation } from "../flux-core/snips";
import { NotFoundError } from "../flux-core/errors";
// via registry, not ./verbs: entering verbs.ts first trips the registry⇄verbs
// ESM cycle (registry's module body iterates VERBS).
import { VERBS } from "../flux-core/registry";
import { readPngDpi, readPngText } from "../src/lib/figure/pngDpi";
import { decodeSnipMeta, parseSidecar, SNIP_TEXT_KEYWORD } from "../src/lib/references/snips";

const h = harness("verify-snip-headless");

// --- hermetic FluxLib + project ------------------------------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "flux-snip-"));
const lib = path.join(tmp, "FluxLib");
const root = path.join(tmp, "project");
const KEY = "driessen2026snips";
fs.mkdirSync(path.join(lib, "items", KEY), { recursive: true });
fs.mkdirSync(path.join(lib, "items", KEY, "supplements"), { recursive: true });
fs.mkdirSync(root, { recursive: true });
fs.copyFileSync("scripts/fixtures/reader-sample.pdf", path.join(lib, "items", KEY, "paper.pdf"));
fs.copyFileSync("scripts/fixtures/reader-sample.pdf", path.join(lib, "items", KEY, "supplements", "supp1.pdf"));
fs.writeFileSync(
  path.join(lib, "library.bib"),
  `@article{${KEY},\n  title = {Snips at scale},\n  author = {Driessen, Kort and Kim, A. and Zhou, B.},\n  year = {2026},\n  journal = {Nature Neuroscience},\n}\n`,
);
process.env.FLUX_NO_MIGRATE = "1";
// Isolation: every call below passes libPath (the flux-core optional-libPath
// convention, cf. hasPdf/loadIndex) — the machine FluxLib is never touched.

const CITATION = "Driessen et al., 2026, Nat. Neurosci.";

try {
  h.section("whole-page snip (rect omitted)");
  const r1 = await snipPaper(root, { key: KEY, page: 1, libPath: lib });
  h.eq(r1.path, "plots/paper_snips/driessen2026snips-p1.png", "project-relative path + auto-name");
  h.eq(r1.citation, CITATION, "citation composed from the bib entry");
  h.ok(r1.bibEntry, "bibEntry true");
  h.eq(r1.dpi, 288, "default scale 4 ⇒ 288dpi");
  const png1 = new Uint8Array(fs.readFileSync(path.join(root, r1.path)));
  h.ok(png1[0] === 0x89 && png1[1] === 0x50, "PNG signature");
  h.eq(Math.round(readPngDpi(png1) ?? 0), 288, "pHYs stamped");
  const meta1 = decodeSnipMeta(readPngText(png1, SNIP_TEXT_KEYWORD));
  h.eq(meta1?.citekey, KEY, "tEXt citekey");
  h.eq(meta1?.citation, CITATION, "tEXt citation");
  h.eq(meta1?.sourcePdf, "main", "tEXt sourcePdf main");
  const side1 = parseSidecar(fs.readFileSync(path.join(root, "plots/paper_snips/driessen2026snips-p1.snip.json"), "utf8"));
  h.eq(side1, meta1, "sidecar ≡ tEXt meta");
  // Whole-page dims: reader-sample.pdf page 1 view box × 4, ceil.
  const ihdr = new DataView(png1.buffer, png1.byteOffset + 16, 8);
  const w = ihdr.getUint32(0);
  const hgt = ihdr.getUint32(4);
  h.ok(w > 1000 && hgt > 1000, `whole page at 4× is full-size (${w}×${hgt})`);
  h.ok(
    Math.abs(w - Math.ceil((meta1!.rect[2] - meta1!.rect[0]) * 4)) <= 1 &&
      Math.abs(hgt - Math.ceil((meta1!.rect[3] - meta1!.rect[1]) * 4)) <= 1,
    "pixel dims match snipRasterPlan(rect, 4)",
  );
  // Not blank: some dark pixels — decode is heavy without a DOM; sample the
  // byte entropy instead (a blank white PNG compresses to almost nothing).
  h.ok(png1.length > 20_000, `rendered page carries real content (${(png1.length / 1024).toFixed(0)} KB)`);

  h.section("region snip + dedup + custom name");
  const rect: [number, number, number, number] = [50, 600, 300, 720];
  const r2 = await snipPaper(root, { key: KEY, page: 1, rect, libPath: lib });
  h.eq(r2.name, "driessen2026snips-p1-2", "second p1 snip dedups to -2");
  h.eq(r2.rect, rect, "in-box rect unchanged by clamping");
  const png2 = new Uint8Array(fs.readFileSync(path.join(root, r2.path)));
  const ihdr2 = new DataView(png2.buffer, png2.byteOffset + 16, 8);
  h.eq(ihdr2.getUint32(0), 1000, "region width = (300−50)×4");
  h.eq(ihdr2.getUint32(4), 480, "region height = (720−600)×4");
  const r3 = await snipPaper(root, { key: KEY, page: 1, rect, name: "Cortex Panel B!", libPath: lib });
  h.eq(r3.name, "cortex-panel-b", "custom name sanitized");
  const r4 = await snipPaper(root, { key: KEY, page: 1, rect: [-100, -100, 9999, 9999], libPath: lib });
  h.eq(r4.rect, meta1!.rect, "overflowing rect clamps to the page box");

  h.section("supplement + error paths + citekey fallback");
  const r5 = await snipPaper(root, { key: KEY, page: 1, rect, supplement: "supp1.pdf", libPath: lib });
  const meta5 = decodeSnipMeta(readPngText(new Uint8Array(fs.readFileSync(path.join(root, r5.path))), SNIP_TEXT_KEYWORD));
  h.eq(meta5?.sourcePdf, { supplement: "supp1.pdf" }, "supplement recorded in sourcePdf");
  await snipPaper(root, { key: KEY, page: 999, libPath: lib }).then(
    () => h.fail("page 999 should throw"),
    (e) => h.ok(e instanceof NotFoundError, `bad page → NotFoundError (${e.message})`),
  );
  await snipPaper(root, { key: "nosuchkey", page: 1, libPath: lib }).then(
    () => h.fail("missing key should throw"),
    (e) => h.ok(e instanceof NotFoundError, "missing PDF → NotFoundError"),
  );

  h.section("get_citation");
  const c1 = await getCitation(KEY, lib);
  h.eq(c1.citation, CITATION, "getCitation composes the full string");
  h.eq(c1.inText, "Driessen et al., 2026", "inText half");
  h.ok(c1.bibEntry, "bibEntry true");
  const c2 = await getCitation("unknownkey", lib);
  h.eq(c2.citation, "unknownkey", "unknown key falls back to the citekey");
  h.ok(!c2.bibEntry, "bibEntry false for unknown key");

  h.section("registry surface (shape — execution surfaces are golden-gated)");
  const snipVerb = VERBS.find((v) => v.name === "snip_paper");
  const citeVerb = VERBS.find((v) => v.name === "get_citation");
  h.ok(!!snipVerb && !!citeVerb, "both verbs registered");
  h.eq(snipVerb?.cli, "snip-paper", "CLI verb name");
  h.eq(citeVerb?.cli, "cite", "cite CLI verb name");
  h.eq(snipVerb?.cliRoot, "flags", "new-style root resolution (key is a plain positional)");
  h.eq(Object.keys(snipVerb?.params ?? {}).sort(), ["key", "name", "page", "rect", "scale", "supplement"], "param surface");
  const rectArg = snipVerb?.cliArgs.find((a) => a.into === "rect");
  h.eq(rectArg?.as, "csvNum", "--rect maps through csvNum ('x1,y1,x2,y2' → number[4])");
  h.ok(/PDF points, y-up/.test(snipVerb?.summary ?? ""), "summary documents the rect units contract");
  const keyArg = snipVerb?.cliArgs.find((a) => a.into === "key");
  h.ok(keyArg?.kind === "pos" && keyArg.required === true, "key is the required positional");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

await h.done();
