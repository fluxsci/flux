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
  /** null = fetch rejects (CSP/network); otherwise the bytes the PDF URL serves. */
  pdfBody?: string | null;
  pdfOk?: boolean;
}): Promise<Downloaded[]> {
  const downloads: Downloaded[] = [];
  const metas = page.meta ?? {};

  const el = () => ({ style: { cssText: "" }, textContent: "", href: "", download: "", click() {}, remove() {} });
  const doc = {
    title: page.title ?? "",
    body: { appendChild() {} },
    createElement: () => el() as unknown as Record<string, unknown>,
    querySelector(sel: string) {
      const m = /^meta\[name="([^"]+)"\]/.exec(sel);
      if (m) return metas[m[1]] !== undefined ? { content: metas[m[1]] } : null;
      if (sel.includes('a[href*="doi.org/10."]')) return page.anchorHref ? { href: page.anchorHref } : null;
      if (sel.includes('link[type="application/pdf"]')) return page.linkPdfHref ? { href: page.linkPdfHref } : null;
      return null;
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
    location: { href: page.href ?? "https://example.org/a", hostname: page.hostname ?? "example.org" },
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

// --- 4: filenames must be safe (they become real files on disk) ---------------------------
{
  const d = await run({ meta: { citation_doi: "10.1000/a b/c..d", citation_pdf_url: "https://x/p.pdf" }, pdfBody: "%PDF-1.4\n" + "w".repeat(4096) });
  const n = d[0]?.name ?? "";
  ok(!/[/\\]/.test(n.replace(/^flux-/, "")), "no path separators survive in the filename", n);
  ok(n.startsWith("flux-") && n.endsWith(".pdf"), "prefix + extension intact", n);
}
{
  const d = await run({ hostname: "biorxiv.org", href: "https://biorxiv.org/x" });
  ok(d[0]?.name === "flux-biorxiv.org.fluxcap", "no DOI anywhere → falls back to the hostname", d[0]?.name);
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
