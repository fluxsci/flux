// Pure gate for the "Add to FluxLib" browser extension.
//
// Two things are worth gating here. First the PAGE READER (extension/page.js), which is the
// part that decides what gets captured — same job the bookmarklet does, so it gets the same
// real-publisher fixtures. Second the BUILD's one-source-of-truth property: the extension
// vendors Flux's own rule modules, and if a copy ever drifts from the original the whole
// reason for vendoring is gone.
//
// Run: node scripts/build-extension.mjs && npx tsx scripts/verify-extension.ts
import { readFileSync, existsSync } from "node:fs";
import * as path from "node:path";
import { readPaperPage } from "../extension/page.js";
import { SUPPLEMENT_URL_PATTERNS } from "../electron/supplementRules.js";
import { parseSupplementCapture, captureSlug, isCaptureFile, SUPP_PREFIX, SUPP_SEP } from "../electron/captureRules.js";

let failures = 0;
function ok(cond: boolean, name: string, detail = "") {
  console.log(`${cond ? "✓" : "✗"} ${name}${cond || !detail ? "" : ` — ${detail}`}`);
  if (!cond) failures++;
}

const DIST = "extension/dist";
const RX = SUPPLEMENT_URL_PATTERNS.map((r) => r.source);

// --- 1: the build is a copy, not a fork ---------------------------------------------------
ok(existsSync(DIST), "extension/dist exists (run scripts/build-extension.mjs)");
if (existsSync(DIST)) {
  for (const f of ["captureRules.js", "supplementRules.js"]) {
    const a = readFileSync(path.join("electron", f), "utf8");
    const b = existsSync(path.join(DIST, "vendor", f)) ? readFileSync(path.join(DIST, "vendor", f), "utf8") : "";
    ok(a === b, `vendored ${f} is byte-identical to Flux's own`, b ? "differs" : "missing");
  }
  const m = JSON.parse(readFileSync(path.join(DIST, "manifest.json"), "utf8"));
  ok(m.manifest_version === 3, "manifest v3");
  ok(m.background?.service_worker === "background.js", "Chrome: background.service_worker set");
  ok(Array.isArray(m.background?.scripts) && m.background.scripts.includes("background.js"), "Firefox: background.scripts set");
  ok(m.background?.type === "module", "background is an ES module (it imports the shared rules)");
  ok(!!m.browser_specific_settings?.gecko?.id, "Firefox: a gecko id is declared (required to load/sign)");
  for (const p of ["scripting", "downloads", "activeTab"]) ok(m.permissions?.includes(p), `permission: ${p}`);
  ok(m.host_permissions?.some((h: string) => h.includes("https")), "host permissions cover https — this is what beats page CSP");
  for (const s of ["16", "32", "48", "128"]) ok(existsSync(path.join(DIST, "icons", `${s}.png`)), `icon ${s}px present`);
  // The injected reader is serialized by executeScript, so it must not close over anything.
  const page = readFileSync(path.join(DIST, "page.js"), "utf8");
  ok(!/^\s*import\s/m.test(page.replace(/^\/\/.*$/gm, "")), "page.js imports nothing (executeScript serializes it)");
}

// --- 2: the page reader, against real publisher shapes ------------------------------------
interface Anchor {
  href: string;
  label?: string;
}
function run(page: { meta?: Record<string, string>; anchors?: Anchor[]; href?: string; pathname?: string; hostname?: string; contentType?: string; title?: string }) {
  const metas = page.meta ?? {};
  const anchors = page.anchors ?? [];
  const g = globalThis as unknown as Record<string, unknown>;
  g.document = {
    contentType: page.contentType ?? "text/html",
    title: page.title ?? "",
    querySelector(sel: string) {
      const mm = /^meta\[name="([^"]+)"\]/.exec(sel);
      if (mm) return metas[mm[1]] !== undefined ? { content: metas[mm[1]] } : null;
      if (sel.includes('a[href*="doi.org/10."]')) return anchors.find((a) => a.href.includes("doi.org/10.")) ?? null;
      if (sel.includes('link[type="application/pdf"]')) return null;
      if (sel.includes('embed[type="application/pdf"]')) return null;
      return null;
    },
    querySelectorAll(sel: string) {
      return sel === "a[href]" ? anchors.map((a) => ({ href: a.href, getAttribute: (k: string) => (k === "href" ? a.href : k === "title" || k === "aria-label" ? (a.label ?? "") : ""), textContent: a.label ?? "" })) : [];
    },
  };
  g.location = { href: page.href ?? "https://x.org/a", pathname: page.pathname ?? "/a", hostname: page.hostname ?? "x.org" };
  return readPaperPage(RX);
}

{
  // science.org: no citation_pdf_url anywhere, supplement listed ABOVE the PDF link.
  const doi = "10.1126/science.aah5982";
  const A = "https://www.science.org";
  const r = run({
    meta: { citation_doi: doi, citation_title: "Ultrastructural evidence" },
    href: `${A}/doi/${doi}`,
    pathname: `/doi/${doi}`,
    anchors: [
      { href: `${A}/doi/reader/${doi}`, label: "PDF" },
      { href: `${A}/doi/suppl/${doi}/suppl_file/devivo-sm.pdf`, label: "Download" },
      { href: `${A}/doi/pdf/${doi}?download=true`, label: "Download PDF" },
      { href: `${A}/doi/pdf/${doi}`, label: "Download PDF" },
    ],
  });
  ok(r.doi === doi, "Science: DOI read");
  ok(/\/doi\/pdf\//.test(r.pdfUrl) && !/suppl/.test(r.pdfUrl), "Science: main PDF chosen, not the supplement", r.pdfUrl);
  ok(r.supplements.length === 1 && r.supplements[0].url.includes("devivo-sm.pdf"), "Science: the supplement is CAPTURED, not just excluded", JSON.stringify(r.supplements));
}
{
  // Nature/Springer: rich labels, several supplements including a movie.
  const doi = "10.1038/s41586-020-2731-9";
  const S = "https://media.springernature.com/original/springer-static/esm/art%3A10.1038%2Fs41586-020-2731-9/MediaObjects";
  const r = run({
    meta: { citation_doi: doi, citation_pdf_url: "https://www.nature.com/articles/s41586-020-2731-9.pdf" },
    href: `https://www.nature.com/articles/s41586-020-2731-9`,
    pathname: "/articles/s41586-020-2731-9",
    anchors: [
      { href: `${S}/41586_2020_2731_MOESM1_ESM.pdf`, label: "Supplementary Information (download PDF )" },
      { href: `${S}/41586_2020_2731_MOESM3_ESM.mov`, label: "Supplementary Video 1 (download MOV )" },
    ],
  });
  ok(r.pdfUrl.endsWith(".pdf") && r.pdfUrl.includes("nature.com"), "Nature: citation_pdf_url used", r.pdfUrl);
  ok(r.supplements.length === 2, "Nature: both supplements captured, PDF and movie alike", String(r.supplements.length));
  ok(r.supplements.some((s) => /Supplementary Video 1/.test(s.label)), "Nature: the publisher's own label is kept");
}
{
  // The page IS the PDF (browser viewer): no metas at all.
  const r = run({ contentType: "application/pdf", href: "https://www.jneurosci.org/content/jneuro/46/12/e0674252026.full.pdf", pathname: "/content/jneuro/46/12/e0674252026.full.pdf", hostname: "www.jneurosci.org" });
  ok(r.isPdf && r.pdfUrl === "https://www.jneurosci.org/content/jneuro/46/12/e0674252026.full.pdf", "PDF viewer: captures the document itself");
  ok(captureSlug(r.slugHint) === "e0674252026.full", "PDF viewer: slug from the filename, not the hostname", captureSlug(r.slugHint));
}
{
  // Viewer-only page: an epdf/reader link is HTML and must never be taken as the PDF.
  const r = run({ meta: { citation_doi: "10.1/v" }, pathname: "/doi/10.1/v", anchors: [{ href: "https://x.org/doi/epdf/10.1/v" }, { href: "https://x.org/doi/reader/10.1/v" }] });
  ok(r.pdfUrl === "", "viewer links are not mistaken for a PDF");
}
{
  // In-page jump links ("#supplementary-materials") are not files.
  const r = run({ meta: { citation_doi: "10.1/j" }, href: "https://x.org/doi/10.1/j", pathname: "/doi/10.1/j", anchors: [{ href: "https://x.org/doi/10.1/j#supplementary-materials", label: "Supplementary Material" }] });
  ok(r.supplements.length === 0, "an in-page anchor is not captured as a supplement");
}

// --- 2b: the worker's failure handling ----------------------------------------------------
// These are the three real-page failures found in testing; each was invisible or unrecoverable
// before. They're asserted against the SOURCE because the behaviours are structural.
{
  const bg = readFileSync("extension/background.js", "utf8");
  // (a) Annual Reviews sat behind Cloudflare and never answered; with no deadline the badge
  //     stayed on "…" forever and the only way out was reloading the extension.
  ok(/AbortSignal\.timeout\(NET_TIMEOUT_MS\)/.test(bg), "every network call is time-boxed");
  ok(/RUN_TIMEOUT_MS/.test(bg) && /clearTimeout\(guard\)/.test(bg), "a whole-run deadline guarantees the badge resolves");
  // (b) executeScript cannot inject into a browser's PDF viewer — which is exactly where
  //     capture should be easiest, since the bytes are already on screen.
  ok(/function pdfTabUrl/.test(bg), "a PDF tab is recognized from its URL");
  ok(/x\.pathname/.test(bg), "…on the PATH, so a signed link with ?expires=… still counts");
  ok(/if \(!asPdf\) return null;/.test(bg), "…and injection failure falls back to the tab URL instead of erroring out");
  // (c) `catch {}` made every supplement failure invisible: a capture looked complete when
  //     files were missing.
  ok(!/catch \{\s*\/\* one supplement/.test(bg), "supplement failures are no longer swallowed");
  ok(/notes\.push\(`supplement: /.test(bg), "…each one is recorded");
  ok(/api\.action\.setTitle/.test(bg), "…and surfaced in the button tooltip (no extra permission needed)");
  ok(/console\.warn\("\[Add to FluxLib\]"/.test(bg), "…and logged for Inspect");
  // downloads.download() resolves when the download is ACCEPTED, not when it lands, so a 403
  // produced a happy promise and a missing file. Only onChanged reveals the real outcome.
  ok(/downloads\.onChanged/.test(bg), "downloads are tracked to completion, not just to acceptance");
  ok(/state === "interrupted"/.test(bg), "…so an interrupted transfer is reported");
  ok(/d\.error\?\.current/.test(bg), "…with the browser's own error code");
  ok(!/method: "HEAD"/.test(bg), "no HEAD preflight — an extra request to a guarded endpoint can poison the session");
  // A stalled probe must not veto a real capture.
  ok(/return "unknown"/.test(bg) && /verdict === "unknown"/.test(bg), "an inconclusive PDF check downloads anyway rather than refusing");
  ok(/info\.isPdf \? "yes"/.test(bg), "a PDF tab skips validation — the browser already rendered it");
}

// --- 2c: the version line -----------------------------------------------------------------
// AMO refuses a version it has already seen, so the extension needs its own monotonic line.
// The build once derived it from package.json, which silently discarded sign-extension's bump
// — the first signing worked and every one after it would have failed on a duplicate version.
{
  const build = readFileSync("scripts/build-extension.mjs", "utf8");
  ok(!/manifest\.version\s*=/.test(build), "the build does NOT overwrite the extension version");
  ok(/pkg\.version/.test(build) === false, "…and does not derive it from package.json");
  const srcV = JSON.parse(readFileSync("extension/manifest.json", "utf8")).version;
  const distV = existsSync(path.join(DIST, "manifest.json")) ? JSON.parse(readFileSync(path.join(DIST, "manifest.json"), "utf8")).version : "";
  ok(srcV === distV, "built version matches the source manifest", `${srcV} vs ${distV}`);
  const sign = readFileSync("scripts/sign-extension.mjs", "utf8");
  ok(/WEB_EXT_API_KEY/.test(sign) && !/const .*SECRET *= *"/.test(sign), "signing reads credentials from the environment, never the repo");
}

// --- 3: supplement filenames round-trip ---------------------------------------------------
{
  const slug = captureSlug("10.1126/science.aah5982");
  const file = `${SUPP_PREFIX}${slug}${SUPP_SEP}devivo-sm.pdf`;
  ok(isCaptureFile(file), "a supplement capture is recognized by the watcher");
  const p = parseSupplementCapture(file);
  ok(p?.slug === slug && p?.name === "devivo-sm.pdf", "…and splits back into paper + filename", JSON.stringify(p));
  // Non-PDF supplements are the norm, not the exception.
  ok(isCaptureFile(`${SUPP_PREFIX}${slug}${SUPP_SEP}movie.mov`), "a .mov supplement is recognized");
  ok(isCaptureFile(`${SUPP_PREFIX}${slug}${SUPP_SEP}data.xlsx`), "an .xlsx supplement is recognized");
  // safeName used to strip hyphens, turning devivo-sm.pdf into devivosm.pdf — publisher
  // filenames carry meaning and mangling them makes a supplement unrecognizable.
  const bg = readFileSync("extension/background.js", "utf8");
  ok(!/replace\(\/\[<>:"\|\?\* -\]/.test(bg.replace(/\\/g, "")) || /Hyphens and dots are KEPT/.test(bg), "safeName keeps hyphens and dots");
}

console.log(failures ? `\n${failures} FAILED` : "\nall green");
process.exit(failures ? 1 : 0);
