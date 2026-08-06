// Pure gate for the web-capture bookmarklet + the .fluxcap payload.
//
// It evals the SHIPPED string (BOOKMARKLET_HREF) against a DOM/fetch stub — not a
// reimplementation — so an escaping slip in the literal fails here rather than silently in
// someone's browser. That matters more than usual: the string is hand-minified with doubled
// backslashes, and a `\s` that collapses to `s` corrupts a regex without any syntax error.
//
// Run: npx tsx scripts/verify-bookmarklet.ts
import { BOOKMARKLET_HREF } from "../src/shell/modes/library/bookmarklet";
import { parseFluxCapture, isCaptureFile } from "../src/lib/references/capture";

let failures = 0;
function ok(cond: boolean, name: string, detail = "") {
  console.log(`${cond ? "✓" : "✗"} ${name}${cond || !detail ? "" : ` — ${detail}`}`);
  if (!cond) failures++;
}

interface Downloaded {
  name: string;
  type: string;
  text: string;
  size: number;
}

/** Run the bookmarklet against a fake page; returns whatever it "downloaded". */
async function run(page: {
  meta?: Record<string, string>;
  title?: string;
  href?: string;
  hostname?: string;
  anchorHref?: string;
  linkPdfHref?: string;
  /** The document's own MIME type — 'application/pdf' when the browser is showing a PDF. */
  contentType?: string;
  hasEmbed?: boolean;
  pathname?: string;
  /** Absolute hrefs of the page's anchors — how most publishers expose their PDF. */
  anchors?: string[];
  /** null = fetch rejects (CSP/network); otherwise the bytes the PDF URL serves. */
  pdfBody?: string | null;
  pdfOk?: boolean;
}): Promise<Downloaded[]> {
  const downloads: Downloaded[] = [];
  const metas = page.meta ?? {};

  const el = () => ({ style: { cssText: "" }, textContent: "", href: "", download: "", click() {}, remove() {} });
  const doc = {
    contentType: page.contentType ?? "text/html",
    title: page.title ?? "",
    body: { appendChild() {} },
    createElement: () => el() as unknown as Record<string, unknown>,
    querySelector(sel: string) {
      const m = /^meta\[name="([^"]+)"\]/.exec(sel);
      if (m) return metas[m[1]] !== undefined ? { content: metas[m[1]] } : null;
      if (sel.includes('a[href*="doi.org/10."]')) return page.anchorHref ? { href: page.anchorHref } : null;
      if (sel.includes('link[type="application/pdf"]')) return page.linkPdfHref ? { href: page.linkPdfHref } : null;
      if (sel.includes('embed[type="application/pdf"]')) return page.hasEmbed ? {} : null;
      return null;
    },
    querySelectorAll(sel: string) {
      if (sel === "a[href]") return (page.anchors ?? []).map((href) => ({ href }));
      return [];
    },
  };

  class FakeBlob {
    parts: string[];
    type: string;
    constructor(parts: string[], opts?: { type?: string }) {
      this.parts = parts;
      this.type = opts?.type ?? "";
    }
    get size() {
      return this.parts.join("").length;
    }
    slice(a: number, b: number) {
      return new FakeBlob([this.parts.join("").slice(a, b)], { type: this.type });
    }
    async text() {
      return this.parts.join("");
    }
  }

  const sandbox = {
    document: doc,
    location: { href: page.href ?? "https://example.org/a", hostname: page.hostname ?? "example.org", pathname: page.pathname ?? "/a" },
    URL: { createObjectURL: () => "blob:stub", revokeObjectURL() {} },
    Blob: FakeBlob,
    Date,
    JSON,
    String,
    setTimeout: () => 0,
    fetch: async () => {
      if (page.pdfBody === null) throw new Error("blocked by CSP");
      return { ok: page.pdfOk !== false, blob: async () => new FakeBlob([page.pdfBody ?? ""]) };
    },
  };

  // The stub anchor records what would have been downloaded.
  sandbox.document.createElement = () => {
    const a: Record<string, unknown> = { style: { cssText: "" }, textContent: "", href: "", download: "" };
    a.click = () => {
      if (typeof a.download === "string" && a.download) downloads.push({ name: a.download, type: lastBlob?.type ?? "", text: lastBlob ? lastBlob.parts.join("") : "", size: lastBlob?.size ?? 0 });
    };
    a.remove = () => {};
    return a;
  };
  let lastBlob: FakeBlob | null = null;
  sandbox.URL.createObjectURL = ((b: FakeBlob) => {
    lastBlob = b;
    return "blob:stub";
  }) as unknown as () => string;

  // NOT decodeURIComponent: the href is a raw `javascript:` URL (browsers accept it as-is),
  // and it contains a literal "%PDF" that would blow up percent-decoding.
  const body = BOOKMARKLET_HREF.replace(/^javascript:/, "");
  const args = Object.keys(sandbox);
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const fn = new Function(...args, `"use strict";return (async()=>{${body}})()`);
  await fn(...args.map((k) => (sandbox as Record<string, unknown>)[k]));
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  return downloads;
}

// --- 1: the happy path — a page advertising a PDF yields flux-<doi>.pdf ------------------
{
  const d = await run({
    meta: { citation_doi: "10.1126/science.aah5982", citation_pdf_url: "https://www.science.org/doi/pdf/10.1126/science.aah5982", citation_title: "Ultrastructural evidence" },
    pdfBody: "%PDF-1.6\n" + "x".repeat(4096),
  });
  ok(d.length === 1, "PDF page: exactly one download", `got ${d.length}`);
  ok(d[0]?.name === "flux-10.1126_science.aah5982.pdf", "PDF page: named flux-<doi>.pdf", d[0]?.name);
}

// --- 2: DOI extraction across the shapes publishers actually use --------------------------
for (const [label, meta] of [
  ["citation_doi bare", { citation_doi: "10.1038/s41586-020-2649-2" }],
  ["doi: prefix", { citation_doi: "doi:10.1038/s41586-020-2649-2" }],
  ["doi.org URL", { citation_doi: "https://doi.org/10.1038/s41586-020-2649-2" }],
  ["dx.doi.org URL", { citation_doi: "http://dx.doi.org/10.1038/s41586-020-2649-2" }],
  ["dc.identifier", { "dc.identifier": "10.1038/s41586-020-2649-2" }],
  ["prism.doi", { "prism.doi": "10.1038/s41586-020-2649-2" }],
] as [string, Record<string, string>][]) {
  const d = await run({ meta: { ...meta, citation_pdf_url: "https://x/p.pdf" }, pdfBody: "%PDF-1.4\n" + "y".repeat(4096) });
  ok(d[0]?.name === "flux-10.1038_s41586-020-2649-2.pdf", `DOI from ${label}`, d[0]?.name);
}
{
  // No meta DOI at all — fall back to a doi.org link in the page body.
  const d = await run({ anchorHref: "https://doi.org/10.1016/j.neuron.2021.06.030", meta: { citation_pdf_url: "https://x/p.pdf" }, pdfBody: "%PDF-1.4\n" + "z".repeat(4096) });
  ok(d[0]?.name === "flux-10.1016_j.neuron.2021.06.030.pdf", "DOI from a doi.org anchor", d[0]?.name);
}

// --- 3: fallbacks — every one must still produce a usable capture -------------------------
{
  const d = await run({ meta: { citation_doi: "10.1126/science.x" }, href: "https://www.science.org/doi/10.1126/science.x" });
  ok(d[0]?.name?.endsWith(".fluxcap") === true, "no PDF on page → .fluxcap sidecar", d[0]?.name);
  const p = parseFluxCapture(d[0]?.text);
  ok(p?.doi === "10.1126/science.x", "sidecar carries the DOI");
  ok(p?.reason === "no-pdf-on-page", "sidecar records WHY it fell back", p?.reason);
  ok(p?.url === "https://www.science.org/doi/10.1126/science.x", "sidecar carries the page URL");
}
{
  const d = await run({ meta: { citation_doi: "10.1/x", citation_pdf_url: "https://x/p.pdf" }, pdfBody: null });
  ok(d[0]?.name?.endsWith(".fluxcap") === true, "CSP-blocked fetch → .fluxcap, not silence", d[0]?.name);
  ok(parseFluxCapture(d[0]?.text)?.reason === "pdf-fetch-blocked", "sidecar distinguishes a blocked fetch");
  ok(parseFluxCapture(d[0]?.text)?.pdfUrl === "https://x/p.pdf", "sidecar keeps the PDF url for Flux to retry");
}
{
  const d = await run({ meta: { citation_doi: "10.1/x", citation_pdf_url: "https://x/p.pdf" }, pdfBody: "<!doctype html><html>paywall</html>" });
  ok(d[0]?.name?.endsWith(".fluxcap") === true, "HTML served as a PDF is REJECTED (paywall interstitial)", d[0]?.name);
}
{
  const d = await run({ meta: { citation_doi: "10.1/x", citation_pdf_url: "https://x/p.pdf" }, pdfBody: "%PDF-tiny" });
  ok(d[0]?.name?.endsWith(".fluxcap") === true, "a truncated sub-1KB 'PDF' is rejected", d[0]?.name);
}
{
  const d = await run({ meta: { citation_doi: "10.1/x", citation_pdf_url: "https://x/p.pdf" }, pdfBody: "%PDF-1.4\n" + "q".repeat(4096), pdfOk: false });
  ok(d[0]?.name?.endsWith(".fluxcap") === true, "a non-2xx response falls back", d[0]?.name);
}

// --- 3b: THE PAGE IS THE PDF -------------------------------------------------------------
// Chrome renders a PDF in a viewer whose document has no HTML — no metas, no
// citation_pdf_url. The bookmarklet used to write a useless sidecar there, which is the worst
// possible place to fail: the bytes are already fetched and on screen. Reported live against
// jneurosci.org, which is behind Cloudflare and therefore unreachable to Flux's own capture.
{
  const url = "https://www.jneurosci.org/content/jneuro/46/12/e0674252026.full.pdf";
  const d = await run({ contentType: "application/pdf", href: url, pathname: "/content/jneuro/46/12/e0674252026.full.pdf", hostname: "www.jneurosci.org", pdfBody: "%PDF-1.7\n" + "j".repeat(8192) });
  ok(d[0]?.name?.endsWith(".pdf") === true, "PDF viewer (contentType): downloads the PDF, not a sidecar", d[0]?.name);
  ok(d[0]?.name === "flux-e0674252026.full.pdf", "PDF viewer: named from its own filename, not the hostname", d[0]?.name);
  ok(d[0]?.size > 8000, "PDF viewer: real bytes captured", String(d[0]?.size));
}
{
  // Same, detected by URL alone (a server that mislabels the content type).
  const d = await run({ href: "https://x.org/papers/foo.pdf", pathname: "/papers/foo.pdf", pdfBody: "%PDF-1.4\n" + "k".repeat(4096) });
  ok(d[0]?.name === "flux-foo.pdf", "PDF detected from a .pdf path", d[0]?.name);
}
{
  // Same, detected by the viewer's <embed> (URL carries no .pdf extension).
  const d = await run({ hasEmbed: true, href: "https://x.org/download?id=99", pathname: "/download", pdfBody: "%PDF-1.4\n" + "n".repeat(4096) });
  ok(d[0]?.name?.endsWith(".pdf") === true, "PDF detected from an <embed> viewer", d[0]?.name);
}
{
  // A normal HTML article page must NOT be mistaken for a PDF.
  const d = await run({ href: "https://x.org/doi/10.1/abc", pathname: "/doi/10.1/abc", meta: { citation_doi: "10.1/abc" } });
  ok(d[0]?.name?.endsWith(".fluxcap") === true, "an HTML page is still not treated as a PDF", d[0]?.name);
}

// --- 3c: PUBLISHERS THAT ADVERTISE NO citation_pdf_url ------------------------------------
// science.org emits none — confirmed against a live capture, whose affordance list held only
// anchors. Meta-only lookup therefore degraded to a sidecar on every Science paper. These are
// the real anchors that page serves, in the real order.
{
  const doi = "10.1126/science.aah5982";
  const A = "https://www.science.org";
  const d = await run({
    meta: { citation_doi: doi },
    href: `${A}/doi/${doi}`,
    pathname: `/doi/${doi}`,
    anchors: [`${A}/doi/reader/${doi}`, `${A}/doi/suppl/${doi}/suppl_file/devivo-sm.pdf`, `${A}/doi/pdf/${doi}?download=true`, `${A}/doi/pdf/${doi}`],
    pdfBody: "%PDF-1.6\n" + "s".repeat(8192),
  });
  ok(d[0]?.name === "flux-10.1126_science.aah5982.pdf", "Science: anchor scan finds the PDF (no citation_pdf_url exists)", d[0]?.name);
  ok(d[0]?.size > 8000, "Science: real PDF bytes, not a sidecar", String(d[0]?.size));
}
{
  // The supplement must never win — this exact mistake shipped twice in the fetch engine.
  const doi = "10.1126/science.x";
  const A = "https://www.science.org";
  const d = await run({ meta: { citation_doi: doi }, pathname: `/doi/${doi}`, anchors: [`${A}/doi/suppl/${doi}/suppl_file/x-sm.pdf`, `${A}/doi/pdf/${doi}`], pdfBody: "%PDF-1.6\n" + "t".repeat(4096) });
  ok(d[0]?.name?.endsWith(".pdf") === true, "supplement-first page still captures a PDF", d[0]?.name);
  const d2 = await run({ meta: { citation_doi: doi }, pathname: `/doi/${doi}`, anchors: [`${A}/doi/suppl/${doi}/suppl_file/x-sm.pdf`] });
  ok(d2[0]?.name?.endsWith(".fluxcap") === true, "a page offering ONLY a supplement captures nothing (never the supplement)", d2[0]?.name);
}
{
  // Viewer links are HTML; taking one would download a web page named .pdf.
  const d = await run({ meta: { citation_doi: "10.1/v" }, pathname: "/doi/10.1/v", anchors: ["https://x.org/doi/epdf/10.1/v", "https://x.org/doi/reader/10.1/v"] });
  ok(d[0]?.name?.endsWith(".fluxcap") === true, "viewer-only page (epdf/reader) is not mistaken for a PDF", d[0]?.name);
}

// --- 4: filenames must be safe (they become real files on disk) ---------------------------
{
  const d = await run({ meta: { citation_doi: "10.1000/a b/c..d", citation_pdf_url: "https://x/p.pdf" }, pdfBody: "%PDF-1.4\n" + "w".repeat(4096) });
  const n = d[0]?.name ?? "";
  ok(!/[/\\]/.test(n.replace(/^flux-/, "")), "no path separators survive in the filename", n);
  ok(n.startsWith("flux-") && n.endsWith(".pdf"), "prefix + extension intact", n);
}
{
  // No DOI anywhere: name it from the URL's last segment, which identifies the paper far
  // better than the bare hostname ever could.
  const d = await run({ hostname: "www.biorxiv.org", href: "https://www.biorxiv.org/content/10.1101/2020.01.01.891234v1", pathname: "/content/10.1101/2020.01.01.891234v1" });
  ok(d[0]?.name === "flux-2020.01.01.891234v1.fluxcap", "no DOI → named from the URL's last segment", d[0]?.name);
}
{
  // Nothing to go on at all (site root) — the hostname is the last resort.
  const d = await run({ hostname: "biorxiv.org", href: "https://biorxiv.org/", pathname: "/" });
  ok(d[0]?.name === "flux-biorxiv.org.fluxcap", "bare root → falls back to the hostname", d[0]?.name);
}

// --- 5: the watcher's file filter ---------------------------------------------------------
ok(isCaptureFile("flux-10.1126_science.aah5982.pdf"), "capture PDF recognized");
ok(isCaptureFile("flux-x.fluxcap"), "capture sidecar recognized");
ok(!isCaptureFile("paper.pdf"), "an ordinary download is NOT a capture");
ok(!isCaptureFile("flux-notes.txt"), "an unrelated flux- file is not a capture");

// --- 6: the parser never throws on junk ---------------------------------------------------
ok(parseFluxCapture("{ not json") === null, "corrupt sidecar → null");
ok(parseFluxCapture(null) === null, "missing sidecar → null");
ok(parseFluxCapture(JSON.stringify({ v: 1, title: "x" })) === null, "sidecar with nothing resolvable → null");

console.log(failures ? `\n${failures} FAILED` : "\nall green");
process.exit(failures ? 1 : 0);
