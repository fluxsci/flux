// Artifacts: HTML pages an agent wrote for the reader (an explorer, a report), shown inside
// Paper. This file is the ONE set of rules for what counts as an artifact, how a page is
// addressed and served, and what the page is allowed to do. Pure and dependency-free ESM, sited
// under electron/ like documentRoots.js: Electron main loads it unbundled (artifactServe.cjs),
// the dev server's route loads the same server, and the pure gate imports it directly.
//
// What an artifact is:
//   - a folder with an index.html (or index.htm): one artifact, and its other top-level .html
//     files are its pages; nothing inside it is searched for further artifacts;
//   - a lone .html file in a folder that has no index: one artifact of one page;
//   - a folder with neither is a group, searched in turn.
// A page is served from its own origin (flux-artifact://<root id>/…), never from the app's, and
// by default may not reach the network.

export const ARTIFACT_SCHEME = "flux-artifact";
/** Reserved path, never a file: the script the server adds to every page (artifactBridge below). */
export const ARTIFACT_BRIDGE_PATH = "/__flux__/bridge.js";
/** The folder a project keeps its own artifacts in. A linked folder is machine state (preferences). */
export const PROJECT_ARTIFACT_DIR = "artifacts";

export const ARTIFACT_LIMITS = Object.freeze({
  /** Folder levels searched below a root. */
  depth: 6,
  /** Folders read in one listing; past this the listing says it stopped. */
  dirs: 3000,
  artifacts: 500,
  /** Bytes of a page read to find its <title>, and to place the bridge script. */
  head: 64 * 1024,
});

const SKIP_DIRS = new Set(["node_modules", "__pycache__", "__MACOSX"]);
/** A folder that is never an artifact or a group: hidden folders, dependency and cache folders. */
export const skipArtifactDir = (/** @type {string} */ name) => name.startsWith(".") || SKIP_DIRS.has(name);
export const isHtmlName = (/** @type {string} */ name) => /\.html?$/i.test(name) && !name.startsWith(".");
const isIndexName = (/** @type {string} */ name) => /^index\.html?$/i.test(name);
const byName = (/** @type {string} */ a, /** @type {string} */ b) => a.localeCompare(b, "en", { numeric: true, sensitivity: "base" });

/**
 * What one folder holds, from the names in it.
 * @param {{ name: string, dir: boolean }[]} entries
 * @returns {{ kind: "artifact", entry: string, pages: string[] } | { kind: "group", files: string[], dirs: string[] }}
 */
export function classifyArtifactFolder(entries) {
  const html = entries.filter((e) => !e.dir && isHtmlName(e.name)).map((e) => e.name).sort(byName);
  // index.html before index.htm, whatever the case of either.
  const index = html.filter(isIndexName).sort((a, b) => a.length - b.length || byName(a, b))[0];
  if (index) return { kind: "artifact", entry: index, pages: [index, ...html.filter((n) => n !== index)] };
  return { kind: "group", files: html, dirs: entries.filter((e) => e.dir && !skipArtifactDir(e.name)).map((e) => e.name).sort(byName) };
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", middot: "·" };
/** The page's <title>, from the first bytes of its text; "" when it has none. */
export function htmlTitle(/** @type {string} */ head) {
  const m = /<title(?:\s[^>]*)?>([\s\S]*?)<\/title\s*>/i.exec(head);
  if (!m) return "";
  return m[1]
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Math.min(Number(n), 0x10ffff)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(Math.min(parseInt(n, 16), 0x10ffff)))
    .replace(/&([a-z]+);/gi, (all, n) => ENTITIES[/** @type {keyof typeof ENTITIES} */ (n.toLowerCase())] ?? all)
    .replace(/\s+/g, " ").trim().slice(0, 200);
}

/** A name for an artifact whose page has no title: `pop_explorer` → "Pop explorer". */
export function artifactNameTitle(/** @type {string} */ name) {
  const words = name.replace(/\.html?$/i, "").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  return words ? words[0].toUpperCase() + words.slice(1) : name;
}

/**
 * The file a request names, relative to its root with forward slashes, or null when the path may
 * not be served (it climbs out, names a hidden file, or is not a path at all). A folder path
 * ("" or ending in "/") names that folder's index.html.
 * @param {string} pathname  URL pathname, still percent-encoded
 */
export function artifactRequestRel(pathname) {
  if (typeof pathname !== "string" || !pathname.startsWith("/") || pathname.length > 4096) return null;
  const parts = [];
  for (const raw of pathname.slice(1).split("/")) {
    let part;
    try { part = decodeURIComponent(raw); } catch { return null; }
    if (part === "" || part === ".") continue;
    if (part === ".." || part.startsWith(".") || /[\0\\/]/.test(part) || /^[a-zA-Z]:$/.test(part)) return null;
    parts.push(part);
  }
  if (pathname.endsWith("/") || !parts.length) parts.push("index.html");
  return parts.join("/");
}

/** The URL path of a file below a root (the inverse of artifactRequestRel for ordinary names). */
export const artifactUrlPath = (/** @type {string} */ rel) => "/" + rel.split("/").map(encodeURIComponent).join("/");

const MIME = {
  html: "text/html; charset=utf-8", htm: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8", mjs: "text/javascript; charset=utf-8", cjs: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8", json: "application/json; charset=utf-8", map: "application/json; charset=utf-8",
  geojson: "application/geo+json; charset=utf-8", webmanifest: "application/manifest+json; charset=utf-8",
  txt: "text/plain; charset=utf-8", md: "text/plain; charset=utf-8", log: "text/plain; charset=utf-8",
  csv: "text/csv; charset=utf-8", tsv: "text/tab-separated-values; charset=utf-8", xml: "application/xml; charset=utf-8",
  svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  avif: "image/avif", ico: "image/x-icon", bmp: "image/bmp",
  woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf",
  mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg",
  wasm: "application/wasm", pdf: "application/pdf", gz: "application/gzip", zip: "application/zip",
};
/** Content type by extension. An unknown extension is bytes: the page decides what they are. */
export function artifactMime(/** @type {string} */ rel) {
  const dot = rel.lastIndexOf(".");
  const ext = dot < 0 ? "" : rel.slice(dot + 1).toLowerCase();
  return MIME[/** @type {keyof typeof MIME} */ (ext)] ?? "application/octet-stream";
}

/**
 * The policy every artifact page is served under. The page is someone's program (an agent wrote
 * it), so its own inline scripts and eval are allowed: it runs in its own origin and its own
 * process, with nothing of the app's in reach. What the policy withholds is the network, unless
 * the reader allowed it for that folder.
 */
export function artifactCsp({ network = false } = {}) {
  const net = network ? " https: http:" : "";
  const ws = network ? " wss: ws:" : "";
  return [
    `default-src 'self' data: blob:${net}`,
    `script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' data: blob:${net}`,
    `style-src 'self' 'unsafe-inline' data: blob:${net}`,
    `img-src 'self' data: blob:${net}`,
    `font-src 'self' data: blob:${net}`,
    `media-src 'self' data: blob:${net}`,
    `connect-src 'self' data: blob:${net}${ws}`,
    `worker-src 'self' blob: data:`,
    `frame-src 'self' data: blob:`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
  ].join("; ");
}

const BRIDGE_TAG = `<script src="${ARTIFACT_BRIDGE_PATH}"></script>`;
/**
 * Where the bridge script goes in a page: the index just after <head>, else after <html>, else
 * after the doctype, else 0. `head` is the page's first bytes read as latin1, so the index is a
 * BYTE offset and the caller can splice bytes without decoding the page.
 */
export function bridgeInsertIndex(/** @type {string} */ head) {
  for (const re of [/<head(?:\s[^>]*)?>/i, /<html(?:\s[^>]*)?>/i, /<!doctype[^>]*>/i]) {
    const m = re.exec(head);
    if (m) return m.index + m[0].length;
  }
  return 0;
}
export const ARTIFACT_BRIDGE_TAG = BRIDGE_TAG;

/**
 * The script every artifact page runs first. It is the page's only line to the app: it reports
 * where the reader is (page, view, scroll, heading, selection), hands the app the key chords the
 * app owns, and follows the app's requests to scroll. It reads nothing the page did not already
 * show, and the app treats every message as untrusted (src/lib/artifacts/frameProtocol.ts).
 * Written as one self-contained function: the server sends `(${artifactBridge})()`.
 */
export function artifactBridge() {
  if (window.parent === window || window.parent !== window.top) return; // only the page Flux framed
  var w = /** @type {any} */ (window);
  if (w.__fluxArtifactBridge) return;
  w.__fluxArtifactBridge = true;
  var post = function (type, data) {
    var msg = { fluxArtifact: 1, type: type };
    if (data) for (var k in data) msg[k] = data[k];
    try { window.parent.postMessage(msg, "*"); } catch (e) { /* the frame is going away */ }
  };
  var clip = function (s, n) { s = String(s == null ? "" : s).replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n) : s; };

  // ---- headings: the page's outline, and the one the reader is at -------------------------
  var headings = [];
  var outlineKey = "";
  // A heading's parts read as separate words: a numbered badge beside its title is "1 The curve".
  var headingText = function (h) {
    var parts = [];
    for (var n = h.firstChild; n; n = n.nextSibling) parts.push(n.textContent || "");
    return clip(parts.join(" "), 120);
  };
  var readOutline = function () {
    headings = Array.prototype.slice.call(document.querySelectorAll("h1, h2, h3"), 0, 300).filter(function (h) {
      return h.getClientRects().length > 0 && clip(h.textContent, 1).length > 0;
    });
    var items = headings.map(function (h) { return { level: Number(h.tagName.slice(1)), text: headingText(h) }; });
    var key = JSON.stringify(items);
    if (key === outlineKey) return;
    outlineKey = key;
    post("outline", { items: items });
  };
  // The heading the reader is at: the last one that has reached the top of the page. At the very
  // end of a page the last sections can never reach the top, so there it is the last one in sight.
  var currentHeading = function () {
    var s = document.scrollingElement || document.documentElement;
    var limit = s.scrollTop > 0 && s.scrollTop >= s.scrollHeight - s.clientHeight - 2 ? window.innerHeight - 8 : 96;
    var at = -1;
    for (var i = 0; i < headings.length; i++) {
      if (headings[i].getBoundingClientRect().top <= limit) at = i; else if (at >= 0) break;
    }
    return at;
  };

  // ---- state: page, view, scroll ---------------------------------------------------------
  var scroller = function () { return document.scrollingElement || document.documentElement; };
  var stateTimer = 0;
  var lastState = "";
  var sendState = function () {
    stateTimer = 0;
    var s = scroller();
    var data = {
      path: location.pathname, view: location.search + location.hash, title: clip(document.title, 200),
      scrollY: Math.round(s.scrollTop), scrollMax: Math.max(0, Math.round(s.scrollHeight - s.clientHeight)), heading: currentHeading(),
    };
    var key = JSON.stringify(data);
    if (key === lastState) return;
    lastState = key;
    post("state", data);
  };
  var queueState = function () { if (!stateTimer) stateTimer = setTimeout(sendState, 120); };
  addEventListener("scroll", queueState, { passive: true, capture: true });
  addEventListener("hashchange", queueState);
  addEventListener("popstate", queueState);
  addEventListener("resize", queueState);
  // A page that keeps its view in the URL without navigating (history.replaceState) still tells us.
  ["pushState", "replaceState"].forEach(function (name) {
    var original = history[name];
    history[name] = function () { var r = original.apply(this, arguments); queueState(); return r; };
  });

  // ---- selection: the words a comment would be about ---------------------------------------
  var selTimer = 0;
  var lastSel = "";
  document.addEventListener("selectionchange", function () {
    clearTimeout(selTimer);
    selTimer = setTimeout(function () {
      var sel = document.getSelection();
      var text = sel && !sel.isCollapsed ? clip(sel.toString(), 400) : "";
      if (text === lastSel) return;
      lastSel = text;
      post("selection", { text: text });
    }, 150);
  });

  // ---- keys: chords belong to the app as well as the page ----------------------------------
  addEventListener("keydown", function (e) {
    if (e.key === "Control" || e.key === "Shift" || e.key === "Alt" || e.key === "Meta") return;
    var chord = e.ctrlKey || e.metaKey || e.altKey || /^F\d{1,2}$/.test(e.key) || e.key === "Escape";
    if (!chord) return;
    post("key", { key: e.key, code: e.code, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, shiftKey: e.shiftKey, repeat: e.repeat });
  }, true);
  addEventListener("pointerdown", function () { post("pointer"); }, true);

  // ---- links: the web opens in the reader's browser, never in this frame -------------------
  addEventListener("click", function (e) {
    if (e.defaultPrevented || e.button !== 0) return;
    var el = e.target;
    while (el && el.nodeType === 1 && el.tagName !== "A" && el.tagName !== "AREA") el = el.parentNode;
    if (!el || el.nodeType !== 1 || !el.href) return;
    var url;
    try { url = new URL(el.href, location.href); } catch (err) { return; }
    // "Here" is this page's own scheme and host (compared as text: a sandboxed page's origin is opaque).
    var here = url.protocol === location.protocol && url.host === location.host;
    if (!here && /^(https?|mailto):$/.test(url.protocol)) { e.preventDefault(); post("open", { url: url.href }); return; }
    // A page of this artifact asked for in a new window opens here: the frame may not open windows.
    if (here && el.target && el.target !== "_self") { e.preventDefault(); location.href = url.href; }
  }, false);

  // ---- what the policy refused, so the reader can see why something is missing --------------
  document.addEventListener("securitypolicyviolation", function (e) {
    post("blocked", { uri: clip(e.blockedURI, 300), directive: clip(e.effectiveDirective, 40) });
  });

  // ---- requests from the app ----------------------------------------------------------------
  var restoreTimer = 0;
  var stopRestore = function () { clearInterval(restoreTimer); restoreTimer = 0; };
  ["wheel", "pointerdown", "keydown", "touchstart"].forEach(function (name) { addEventListener(name, stopRestore, { passive: true, capture: true }); });
  addEventListener("message", function (e) {
    var d = e.data;
    if (e.source !== window.parent || !d || d.fluxArtifact !== 1) return;
    if (d.type === "scroll" && typeof d.y === "number") {
      // A page that fills itself in after load is not yet as tall as it was: keep trying until
      // it is, the reader takes over, or three seconds pass.
      var y = Math.max(0, d.y), tries = 0;
      stopRestore();
      var go = function () {
        var s = scroller();
        s.scrollTop = y;
        if (Math.abs(s.scrollTop - y) <= 2 || ++tries > 30) stopRestore();
      };
      go();
      if (Math.abs(scroller().scrollTop - y) > 2) restoreTimer = setInterval(go, 100);
    } else if (d.type === "jump" && typeof d.index === "number") {
      stopRestore();
      var h = headings[d.index];
      if (h) { h.scrollIntoView({ block: "start" }); queueState(); }
    }
  });

  var start = function () {
    readOutline();
    post("ready", { path: location.pathname, view: location.search + location.hash, title: clip(document.title, 200) });
    sendState();
    // Pages build themselves after load (a data file arrives, a section fills in).
    var outlineTimer = 0;
    new MutationObserver(function () {
      clearTimeout(outlineTimer);
      outlineTimer = setTimeout(function () { readOutline(); queueState(); }, 400);
    }).observe(document.documentElement, { childList: true, subtree: true });
    var title = document.querySelector("title");
    if (title) new MutationObserver(queueState).observe(title, { childList: true, characterData: true, subtree: true });
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
}

/** The bridge as the text the server sends for ARTIFACT_BRIDGE_PATH. */
export const artifactBridgeSource = () => `(${artifactBridge.toString()})();\n`;
