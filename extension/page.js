// Injected into the article page to READ it. Nothing is fetched here — that happens in the
// background worker, whose host-permission fetches are not subject to the page's
// Content-Security-Policy. That split is the whole reason this extension exists: it is what
// makes capture work on Firefox and on strict-CSP publishers, where a bookmarklet cannot.
//
// Injected via chrome.scripting.executeScript({func, args}), so this function is SERIALIZED —
// it can close over nothing. Every rule it needs (the supplement URL patterns, which live in
// electron/captureRules.js and are shared with Flux itself) arrives through `args`.

/**
 * @param {string[]} suppRxSources  SUPPLEMENT_URL_PATTERNS sources, from the shared module
 * @returns {{doi:string,title:string,isPdf:boolean,pdfUrl:string,supplements:{url:string,label:string}[],pageUrl:string,slugHint:string}}
 */
export function readPaperPage(suppRxSources) {
  const D = document;
  const L = location;
  const SUPP = suppRxSources.map((s) => new RegExp(s, "i"));

  const meta = (n) => {
    const e = D.querySelector(`meta[name="${n}"],meta[property="${n}"]`);
    return (e && e.content) || "";
  };
  const cleanDoi = (s) => {
    if (!s) return "";
    const t = String(s)
      .replace(/^\s*doi:\s*/i, "")
      .replace(/^https?:\/\/(dx\.)?doi\.org\//i, "");
    const h = t.match(/10\.\d{4,9}\/\S+/i);
    return h ? h[0].replace(/[)\]>.,;'"]+$/, "") : "";
  };
  const abs = (h) => {
    // Guard the empty case: `new URL("", href)` resolves to the PAGE, so an absent link would
    // otherwise masquerade as a PDF url pointing at the article page itself.
    if (!h) return "";
    try {
      return new URL(h, L.href).href;
    } catch {
      return "";
    }
  };

  // The page may itself BE the PDF: browsers render one in a viewer with no HTML document —
  // no metas, no citation_pdf_url, just an <embed>.
  const isPdf =
    (D.contentType || "") === "application/pdf" ||
    /\.pdf$/i.test(L.pathname) ||
    !!D.querySelector('embed[type="application/pdf"]');

  const doi =
    cleanDoi(meta("citation_doi")) ||
    cleanDoi(meta("bepress_citation_doi")) ||
    cleanDoi(meta("dc.identifier")) ||
    cleanDoi(meta("prism.doi")) ||
    cleanDoi(meta("DOI")) ||
    cleanDoi((D.querySelector('a[href*="doi.org/10."]') || {}).href);

  const isSupp = (h) => SUPP.some((r) => r.test(h));
  const isViewer = (h) => /\/doi\/(reader|epdf)\/|\/epdf\//i.test(h);
  const isPdfish = (h) => /\.pdf($|[?#])|\/doi\/pdf\/|\/pdfdirect\/|\/pdfft\b|\/article-pdf\//i.test(h);

  // Main PDF. Not every publisher advertises one — science.org emits no citation_pdf_url at
  // all — so fall back to scanning anchors, preferring the canonical /doi/pdf/<doi>, and
  // never taking a supplement or an HTML viewer.
  let pdfUrl = isPdf ? L.href : meta("citation_pdf_url") || meta("bepress_citation_pdf_url") || abs((D.querySelector('link[type="application/pdf"]') || {}).href || "");
  if (pdfUrl && (isSupp(pdfUrl) || isViewer(pdfUrl))) pdfUrl = "";
  const anchors = [...D.querySelectorAll("a[href]")].map((a) => ({ href: abs(a.getAttribute("href")), label: ((a.getAttribute("aria-label") || a.getAttribute("title") || a.textContent || "").replace(/\s+/g, " ").trim() || "").slice(0, 120) }));
  if (!pdfUrl) {
    for (const a of anchors) {
      if (!a.href || !isPdfish(a.href) || isSupp(a.href) || isViewer(a.href)) continue;
      if (doi && a.href.includes(`/doi/pdf/${doi}`)) {
        pdfUrl = a.href;
        break;
      }
      if (!pdfUrl) pdfUrl = a.href;
    }
  }

  // Supplementary files — the reason to have an extension rather than a bookmarklet. Any file
  // type counts (.pdf, .docx, .xlsx, .mov, .zip); the publisher's own link text becomes the
  // label the reader shows, which beats `41592_2023_1863_MOESM3_ESM` every time.
  const seen = new Set();
  const supplements = [];
  const here = L.href.split("#")[0];
  for (const a of anchors) {
    if (!a.href || !isSupp(a.href)) continue;
    if (a.href.split("#")[0] === here) continue; // an in-page jump link, not a file
    if (seen.has(a.href)) continue;
    seen.add(a.href);
    supplements.push({ url: a.href, label: a.label });
  }

  const seg = (L.pathname.split("/").filter(Boolean).pop() || "").replace(/\.pdf$/i, "");
  return {
    doi,
    title: meta("citation_title") || meta("dc.title") || D.title || "",
    isPdf,
    pdfUrl,
    supplements,
    pageUrl: L.href,
    slugHint: doi || seg || L.hostname,
  };
}
