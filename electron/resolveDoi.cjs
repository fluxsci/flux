"use strict";
// URL/HTML → DOI resolution, factored out of main.cjs so it can be unit-tested
// without booting Electron. Pure string work: no HTML parser (so nothing new to
// bundle past electron-builder's node_modules carve-out) and no network except the
// injected fetch. Shared by the in-app paste box, Cmd-K, and flux:// web capture.

const { publicHttpUrl } = require("./netFetch.cjs");

/** Extract a clean DOI from a string (a bare DOI, a doi.org URL, a "doi:" prefix,
 *  or DOI-bearing text), or null. Trims trailing sentence punctuation. */
function cleanDoi(s) {
  if (!s) return null;
  const stripped = String(s)
    .replace(/^\s*doi:\s*/i, "")
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")
    .trim();
  const hit = stripped.match(/10\.\d{4,9}\/\S+/i);
  if (!hit) return null;
  return hit[0].replace(/[)\]>.,;'"]+$/, "");
}

// Meta tags publishers expose a DOI through, most-authoritative first.
const META_NAMES = [
  "citation_doi",
  "bepress_citation_doi",
  "dc.identifier.doi",
  "dc.identifier",
  "prism.doi",
  "doi",
];

/** Scrape a DOI out of a page's HTML via the common citation meta tags, falling
 *  back to a DOI embedded in the (post-redirect) URL, then any DOI in the body. */
function scrapeDoi(html, url = "") {
  const h = String(html || "");
  for (const name of META_NAMES) {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`<meta\\b[^>]*?\\b(?:name|property)\\s*=\\s*["']${esc}["'][^>]*>`, "gi");
    let tag;
    while ((tag = re.exec(h))) {
      const content = tag[0].match(/\bcontent\s*=\s*["']([^"']*)["']/i);
      const doi = cleanDoi(content && content[1]);
      if (doi) return doi;
    }
  }
  const inUrl = (String(url).match(/10\.\d{4,9}\/[^\s"'?#&]+/i) || [])[0];
  if (cleanDoi(inUrl)) return cleanDoi(inUrl);
  const inBody = (h.match(/10\.\d{4,9}\/[^\s"'<>)]+/i) || [])[0];
  return cleanDoi(inBody);
}

/** Resolve a DOI-or-URL string to a DOI. Bare DOIs and doi.org links resolve with
 *  no network; any other http(s) URL is fetched and scraped. `fetchImpl` is
 *  injected (Electron's global fetch in production; a stub in tests). */
async function resolveToDoi(input, fetchImpl) {
  const u = String(input || "").trim();
  if (!u) return { error: "Nothing to resolve." };
  if (!/^https?:\/\//i.test(u)) {
    const d = cleanDoi(u);
    return d ? { doi: d } : { error: "That doesn't look like a DOI or a URL." };
  }
  if (/^https?:\/\/(dx\.)?doi\.org\//i.test(u)) {
    const d = cleanDoi(u);
    if (d) return { doi: d };
  }
  if (typeof fetchImpl !== "function") return { error: "URL resolution needs the desktop app." };
  // Same SSRF guard as pdf:netGet — this fetch runs in main with the machine's
  // network position; localhost/private ranges are not resolvable "papers".
  const safe = publicHttpUrl(u);
  if (!safe) return { error: "Only public http(s) URLs can be resolved." };
  try {
    const res = await fetchImpl(safe, {
      headers: {
        "User-Agent": "Flux/0.1 (manuscript editor)",
        Accept: "text/html,application/xhtml+xml",
      },
      redirect: "follow",
    });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const html = await res.text();
    const doi = scrapeDoi(html, res.url || u);
    return doi ? { doi } : { error: "Couldn't find a DOI on that page." };
  } catch (err) {
    return { error: String((err && err.message) || err) };
  }
}

module.exports = { cleanDoi, scrapeDoi, resolveToDoi };
