"use strict";
// WS-9.4b: the NETWORK family — API-key store, cite:* metadata fetches and
// pdf:netGet (cookie-jar acquisition), extracted from main.cjs.

const path = require("node:path");
const fs = require("node:fs");
const { createNetGet, readBoundedBody } = require("../netFetch.cjs");
const leases = require("../operationLease.cjs");
const { publicFetch: fetch } = require("../publicFetch.cjs");
const { withoutRetiredKeys } = require("../retiredLibraryProxy.cjs");

/**
 * deps:
 *   session         — Electron module (pdf:netGet's persistent cookie-jar partition)
 *   fluxLibDir      — () => machine-global FluxLib root (keys.json home)
 *   resolveToDoi    — ./resolveDoi.cjs (cite:resolveUrl)
 *   locks           — { lockDirFor } (keys:set shares flux-core's FluxLib "keys"
 *                     lock — owned by the project family)
 *   files           — { atomicWriteMain } (the FILES family write core)
 */
function createNetworkFamily({ session, fluxLibDir, resolveToDoi, locks, files }) {
  const { lockDirFor } = locks;
  const { atomicWriteMain } = files;
const fluxKeysPath = () => path.join(fluxLibDir(), "keys.json");
// Retired keys (withoutRetiredKeys) are never returned and never written back.
function readKeys() {
  try {
    const data = JSON.parse(fs.readFileSync(fluxKeysPath(), "utf8"));
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Expected key object");
    return withoutRetiredKeys(data);
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw new Error(`Cannot read canonical keys file ${fluxKeysPath()}: ${error.message}`, {cause: error});
  }
}
const KEY_ENV = { mailto: "FLUX_MAILTO", openAlexKey: "OPENALEX_API_KEY", s2Key: "S2_API_KEY" };
function getKey(name) {
  const e = process.env[KEY_ENV[name]];
  if (e && e.trim()) return e.trim();
  const v = readKeys()[name];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

  /** Register the family's channels on the (contract-wrapped) ipc. */
  function registerHandlers(ipc) {
// Citation metadata via CrossRef (main process has global fetch in Electron 33;
// running here avoids renderer CORS). Polite User-Agent per CrossRef etiquette.
ipc.handle("cite:fetchDoi", async (_e, doi) => {
  const clean = String(doi || "").replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").trim();
  try {
    const res = await fetch(
      "https://api.crossref.org/works/" + encodeURIComponent(clean),
      { headers: { "User-Agent": "Flux/0.1 (manuscript editor)", Accept: "application/json" }, signal: AbortSignal.timeout(30_000), redirect: "error" },
    );
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const json = JSON.parse((await readBoundedBody(res, 8 * 1024 * 1024)).toString("utf8"));
    return { message: json.message };
  } catch (err) {
    return { error: String((err && err.message) || err) };
  }
});

// DOI → raw BibTeX via doi.org content negotiation. Registrar-agnostic — this is
// how entry creation rescues DataCite DOIs (arXiv 10.48550/*, Zenodo, theses) that
// Crossref's works API 404s. Returns { bibtex } or { error: "HTTP <status>" | msg }.
ipc.handle("cite:fetchDoiBibtex", async (_e, doi) => {
  const clean = String(doi || "").replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").trim();
  if (!/^10\.\d{4,9}\/\S+$/.test(clean)) return { error: "not a DOI" };
  try {
    const res = await fetch("https://doi.org/" + encodeURIComponent(clean), {
      headers: { Accept: "application/x-bibtex", "User-Agent": "Flux/0.1 (manuscript editor)" },
      redirect: "follow",
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const bibtex = (await readBoundedBody(res, 8 * 1024 * 1024)).toString("utf8").trim();
    if (!bibtex.startsWith("@")) return { error: "DOI did not return BibTeX" };
    return { bibtex };
  } catch (err) {
    return { error: String((err && err.message) || err) };
  }
});

// Resolve a paper URL (or DOI) to a DOI: fetch the page (global fetch → no CORS)
// and scrape its citation meta tags. Backs the Library paste box and web capture.
ipc.handle("cite:resolveUrl", (_e, url) => resolveToDoi(url, fetch));

// OpenAlex fetch (library hydration + whole-world lookups) — runs in main to avoid
// renderer CORS. The renderer builds the URL via src/lib/references/openalex.ts and
// passes it here; we only allow the OpenAlex host. No API key needed (polite mailto).
ipc.handle("cite:openalex", async (_e, url) => {
  let u = String(url || "");
  if (!/^https:\/\/api\.openalex\.org\//i.test(u)) return { error: "blocked: non-OpenAlex URL" };
  const key = getKey("openAlexKey"); // free key → 10× daily budget
  const mailto = getKey("mailto");
  if (key && !/[?&]api_key=/.test(u)) u += (u.includes("?") ? "&" : "?") + "api_key=" + encodeURIComponent(key);
  if (mailto && !/[?&]mailto=/.test(u)) u += (u.includes("?") ? "&" : "?") + "mailto=" + encodeURIComponent(mailto);
  try {
    const res = await fetch(u, {
      headers: { "User-Agent": "Flux/0.1 (reference hydration)", Accept: "application/json" },
      signal: AbortSignal.timeout(30_000), redirect: "error",
    });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    return JSON.parse((await readBoundedBody(res, 8 * 1024 * 1024)).toString("utf8"));
  } catch (err) {
    return { error: String((err && err.message) || err) };
  }
});

// Semantic Scholar fetch (recommendations, citation contexts/intents) — runs in main
// to avoid CORS; attaches the x-api-key header when an S2 key is set. Host-restricted.
ipc.handle("cite:s2", async (_e, url) => {
  const u = String(url || "");
  if (!/^https:\/\/api\.semanticscholar\.org\//i.test(u)) return { error: "blocked: non-S2 URL" };
  const key = getKey("s2Key");
  try {
    const res = await fetch(u, {
      headers: {
        "User-Agent": "Flux/0.1 (reference)",
        Accept: "application/json",
        ...(key ? { "x-api-key": key } : {}),
      },
      signal: AbortSignal.timeout(30_000), redirect: "error",
    });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    return JSON.parse((await readBoundedBody(res, 8 * 1024 * 1024)).toString("utf8"));
  } catch (err) {
    return { error: String((err && err.message) || err) };
  }
});

// Generic PDF-acquisition fetch (FluxFinder GUI). The renderer runs the resolver
// waterfall (src/lib/references/pdfFinder.ts) and routes every fetch (metadata JSON +
// the PDF bytes) here to dodge renderer CORS — mirroring the flux-core/acquire.ts Node
// path so both share one waterfall. Backed by electron/netFetch.cjs: Chromium net stack
// on a persistent cookie-jar partition (one server-side session per publisher, not one
// per request/redirect-hop — the multiplier behind the Cell Press IP blocks), SSRF
// guard, per-mode timeouts. Always user-initiated ("Get PDF" / "Get PDFs").
const netGet = createNetGet({ session, getKey });
ipc.handle("pdf:netGet", (_e, url, mode = "bytes") => netGet(url, mode));

// API-key store (machine-global ~/FluxLib/keys.json). keys:get returns the map
// for the settings form (the user's own machine); keys:set merge-writes it. Both
// leave out retired keys, so any save also clears one left by an older version.
ipc.handle("keys:get", () => readKeys());
ipc.handle("keys:set", async (_e, patch) => {
  try {
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("Expected key patch object");
    return await leases.queued(lockDirFor("fluxlib"), "keys", async dir => {
      const got = await leases.acquire(dir, "keys", "human");
      if (!got.ok) throw new Error(`keys.json is being written by ${got.heldBy} — retry in a moment`);
      try {
        const next = withoutRetiredKeys({ ...readKeys(), ...patch });
        await leases.assertOwned(got.lease);
        await atomicWriteMain(fluxKeysPath(), JSON.stringify(next, null, 2) + "\n", false, 0o600);
        await fs.promises.chmod(fluxKeysPath(), 0o600);
        return next;
      } finally { await leases.release(got.lease); }
    });
  } catch (err) { return { error: String(err?.message || err) }; }
});

  }

  return {
    registerHandlers,
    getKey,
  };
}

module.exports = { createNetworkFamily };
