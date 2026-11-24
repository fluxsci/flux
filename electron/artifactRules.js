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
 * app owns, follows the app's requests to scroll, and shows the comments the app says the page
 * carries (finding each one's passage or element again in whatever the page has become). It
 * reads nothing the page did not already show, and the app treats every message as untrusted
 * (src/lib/artifacts/frameProtocol.ts).
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

  // ---- text: the page's words as one string, to find a commented passage again ---------------
  // White space is left out on both sides of every comparison: a selection across two paragraphs
  // reads "end.\n\nNext" while the page's text nodes hold "end." and "Next". Scripts and styles
  // are not text. Built when a comment or a selection needs it, and again after the page changes.
  var SKIP = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, TEXTAREA: 1, TITLE: 1 };
  var TEXT_CAP = 3000000;
  var textIndex = null;
  var isSpace = function (c) { return c === 32 || (c >= 9 && c <= 13) || c === 160 || c === 8203 || c === 8239 || c === 65279; };
  var squeeze = function (s) {
    var out = "";
    s = String(s == null ? "" : s);
    for (var i = 0; i < s.length; i++) if (!isSpace(s.charCodeAt(i))) out += s.charAt(i);
    return out;
  };
  var buildIndex = function () {
    var nodes = [], firstAt = [], chunks = [], nodeAt = [], offAt = [], total = 0, n;
    var walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT, {
      acceptNode: function (t) { var parent = t.parentNode; return parent && SKIP[String(parent.nodeName).toUpperCase()] ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT; },
    });
    while (total < TEXT_CAP && (n = walker.nextNode())) {
      var s = n.nodeValue || "", ni = nodes.length, kept = "";
      nodes.push(n);
      firstAt.push(total);
      for (var i = 0; i < s.length; i++) {
        if (isSpace(s.charCodeAt(i))) continue;
        kept += s.charAt(i);
        nodeAt.push(ni);
        offAt.push(i);
      }
      chunks.push(kept);
      total += kept.length;
    }
    var where = new Map();
    for (var k = 0; k < nodes.length; k++) where.set(nodes[k], k);
    return { text: chunks.join(""), nodes: nodes, firstAt: firstAt, nodeAt: nodeAt, offAt: offAt, where: where };
  };
  var theIndex = function () { return textIndex || (textIndex = buildIndex()); };
  var lastTextIn = function (el) {
    var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT), last = null, n;
    while ((n = walker.nextNode())) last = n;
    return last;
  };
  /** Where a range boundary falls in the squeezed text (-1 when it is in text the index does not hold). */
  var positionOf = function (index, node, offset, atEnd) {
    if (node.nodeType !== 3) {
      // A boundary between elements: the nearest text on the side the range covers.
      var walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT), found = null;
      if (atEnd) {
        var before = node.childNodes[offset - 1];
        if (before && before.nodeType === 3) found = before;
        else if (before) { found = lastTextIn(before); if (!found) { walker.currentNode = before; found = walker.previousNode(); } }
        else { walker.currentNode = node; found = walker.previousNode(); }
        if (!found) return 0;
        node = found; offset = (found.nodeValue || "").length;
      } else {
        var after = node.childNodes[offset];
        if (after && after.nodeType === 3) found = after;
        else { walker.currentNode = after || lastTextIn(node) || node; found = walker.nextNode(); }
        if (!found) return index.text.length;
        node = found; offset = 0;
      }
    }
    var ni = index.where.get(node);
    if (ni === undefined) return -1;
    var s = node.nodeValue || "", count = 0;
    for (var i = 0; i < offset && i < s.length; i++) if (!isSpace(s.charCodeAt(i))) count++;
    return index.firstAt[ni] + count;
  };
  /** A quoted passage in the squeezed text: the occurrence its surroundings agree with best. */
  var findQuote = function (index, quote, prefix, suffix) {
    var q = squeeze(quote), text = index.text;
    if (!q) return null;
    var before = squeeze(prefix), after = squeeze(suffix);
    var best = -1, bestScore = -1, seen = 0, at = text.indexOf(q), k;
    while (at >= 0 && seen++ < 200) {
      var score = 0;
      for (k = 1; k <= before.length && at - k >= 0 && text.charCodeAt(at - k) === before.charCodeAt(before.length - k); k++) score++;
      for (k = 0; k < after.length && at + q.length + k < text.length && text.charCodeAt(at + q.length + k) === after.charCodeAt(k); k++) score++;
      if (score > bestScore) { bestScore = score; best = at; }
      at = text.indexOf(q, at + 1);
    }
    if (best >= 0) return { start: best, end: best + q.length };
    // The passage was reworded in the middle: its first and last words still bound it.
    if (q.length >= 32) {
      var head = q.slice(0, 14), tail = q.slice(-14), tries = 0, a = text.indexOf(head);
      while (a >= 0 && tries++ < 50) {
        var b = text.indexOf(tail, a + head.length);
        if (b >= 0 && b + tail.length - a <= q.length * 2) return { start: a, end: b + tail.length };
        a = text.indexOf(head, a + 1);
      }
    }
    return null;
  };
  var rangeOf = function (index, start, end) {
    if (end <= start || end > index.text.length) return null;
    var r = document.createRange();
    try {
      r.setStart(index.nodes[index.nodeAt[start]], index.offAt[start]);
      r.setEnd(index.nodes[index.nodeAt[end - 1]], index.offAt[end - 1] + 1);
    } catch (e) { return null; }
    return r;
  };
  var rectOf = function (r) { return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; };
  var headingBefore = function (node) {
    var at = "";
    for (var i = 0; i < headings.length; i++) {
      if (headings[i] === node || (headings[i].compareDocumentPosition(node) & (Node.DOCUMENT_POSITION_FOLLOWING | Node.DOCUMENT_POSITION_CONTAINED_BY))) at = headingText(headings[i]);
      else break;
    }
    return at;
  };

  // ---- selection: the words a comment would be about, and what surrounds them ----------------
  var selTimer = 0;
  var lastSel = "";
  var selData = null;
  document.addEventListener("selectionchange", function () {
    clearTimeout(selTimer);
    selTimer = setTimeout(function () {
      var sel = document.getSelection();
      var has = sel && !sel.isCollapsed && sel.rangeCount > 0;
      var text = has ? clip(sel.toString(), 600) : "";
      var data = { text: text };
      if (text) {
        try {
          var range = sel.getRangeAt(0), index = theIndex();
          var start = positionOf(index, range.startContainer, range.startOffset, false);
          var end = positionOf(index, range.endContainer, range.endOffset, true);
          if (start >= 0 && end > start) {
            data.prefix = index.text.slice(Math.max(0, start - 32), start);
            data.suffix = index.text.slice(end, end + 32);
          }
          data.rect = rectOf(range.getBoundingClientRect());
          data.heading = headingBefore(range.startContainer);
        } catch (e) { /* a selection in a part of the page the index does not hold: the words alone */ }
      }
      var key = JSON.stringify(data);
      if (key === lastSel) return;
      lastSel = key;
      selData = text ? data : null;
      post("selection", data);
    }, 150);
  });

  // ---- comments on the page: passages tinted, elements outlined ------------------------------
  // The app says which comments this page carries; the page finds each one again (by its quoted
  // words and what surrounded them, or by the element it named) and shows it. Passages are drawn
  // with the CSS highlight registry, so not one node of the page is touched; element outlines
  // live in a closed shadow tree of our own.
  var anchors = [];
  var placed = {};
  var activeId = "";
  var tint = "#4385be";
  var styleEl = null, layerHost = null, layerRoot = null, probe = null;
  var canHighlight = typeof w.Highlight === "function" && !!(w.CSS && w.CSS.highlights);
  var ensureLayer = function () {
    if (!styleEl || !styleEl.isConnected) {
      styleEl = document.createElement("style");
      styleEl.setAttribute("data-flux-artifact", "");
      (document.head || document.documentElement).appendChild(styleEl);
    }
    var css = "::highlight(flux-comment){background-color:color-mix(in srgb," + tint + " 24%,transparent);}" +
      "::highlight(flux-comment-on){background-color:color-mix(in srgb," + tint + " 46%,transparent);}" +
      "html[data-flux-pick],html[data-flux-pick] *{cursor:crosshair !important;}";
    if (styleEl.textContent !== css) styleEl.textContent = css;
    if (!layerHost || !layerHost.isConnected) {
      layerHost = document.createElement("flux-artifact-marks");
      layerHost.setAttribute("aria-hidden", "true");
      layerHost.style.cssText = "position:absolute;left:0;top:0;width:0;height:0;margin:0;padding:0;border:0;pointer-events:none;z-index:2147483647;";
      layerRoot = layerHost.attachShadow({ mode: "closed" });
      document.documentElement.appendChild(layerHost);
      probe = null;
      for (var id in placed) if (placed[id]) placed[id].box = null;
    }
  };
  var elementFor = function (a) {
    var el = null;
    try { el = a.selector ? document.querySelector(a.selector) : null; } catch (e) { el = null; }
    if (el && (!a.tag || el.localName === a.tag)) return el;
    if (!a.tag) return null;
    // The page was rebuilt and the path moved: the same kind of element with the same label or first words.
    var list = document.getElementsByTagName(a.tag), want = squeeze(a.label || a.text || "").slice(0, 60);
    if (!want) return null;
    for (var i = 0; i < list.length && i < 800; i++) {
      var has = squeeze(labelOf(list[i]) || list[i].textContent || "").slice(0, 60);
      if (has && has === want) return list[i];
    }
    return null;
  };
  var boxFor = function (id, el, active) {
    var slot = placed[id];
    if (!slot.box) {
      slot.box = document.createElement("div");
      var pin = document.createElement("div");
      pin.style.cssText = "position:absolute;right:-9px;top:-9px;width:18px;height:18px;border-radius:9px 9px 9px 2px;pointer-events:auto;cursor:pointer;box-shadow:0 1px 3px rgba(0,0,0,.28);";
      pin.addEventListener("mouseenter", function () { hoverSoon(id, function () { return rectOf(pin.getBoundingClientRect()); }); });
      pin.addEventListener("mouseleave", function () { hoverSoon("", null); });
      pin.addEventListener("click", function (e) { e.stopPropagation(); post("anchor", { id: id, how: "click", rect: rectOf(pin.getBoundingClientRect()) }); });
      slot.box.appendChild(pin);
      layerRoot.appendChild(slot.box);
    }
    var r = el.getBoundingClientRect(), origin = layerHost.getBoundingClientRect();
    slot.box.style.cssText = "position:absolute;box-sizing:border-box;border-radius:5px;pointer-events:none;" +
      "left:" + (r.left - origin.left - 3) + "px;top:" + (r.top - origin.top - 3) + "px;width:" + (r.width + 6) + "px;height:" + (r.height + 6) + "px;" +
      "border:" + (active ? "2px" : "1.5px") + " solid color-mix(in srgb," + tint + " " + (active ? "95" : "70") + "%,transparent);" +
      (active ? "background:color-mix(in srgb," + tint + " 9%,transparent);" : "") + (r.width && r.height ? "" : "display:none;");
    slot.box.firstChild.style.background = tint;
  };
  var paint = function () {
    if (canHighlight) {
      var all = [], on = [];
      for (var id in placed) if (placed[id] && placed[id].range) (id === activeId ? on : all).push(placed[id].range);
      if (all.length) w.CSS.highlights.set("flux-comment", new w.Highlight(...all)); else w.CSS.highlights.delete("flux-comment");
      if (on.length) w.CSS.highlights.set("flux-comment-on", new w.Highlight(...on)); else w.CSS.highlights.delete("flux-comment-on");
    }
    for (var eid in placed) if (placed[eid] && placed[eid].el) boxFor(eid, placed[eid].el, eid === activeId);
  };
  var placeAll = function () {
    var next = {}, report = [], needsText = false, i, a;
    for (i = 0; i < anchors.length; i++) if (anchors[i].quote && !anchors[i].selector) needsText = true;
    if (anchors.length) ensureLayer();
    var index = needsText ? theIndex() : null;
    for (i = 0; i < anchors.length; i++) {
      a = anchors[i];
      var slot = { range: null, el: null, box: placed[a.id] ? placed[a.id].box : null };
      if (a.selector || a.tag) slot.el = elementFor(a);
      else if (a.quote && index) { var hit = findQuote(index, a.quote, a.prefix, a.suffix); slot.range = hit ? rangeOf(index, hit.start, hit.end) : null; }
      if (!slot.el && slot.box) { slot.box.remove(); slot.box = null; }
      next[a.id] = slot;
      report.push({ id: a.id, found: !!(slot.range || slot.el) });
    }
    for (var old in placed) if (!next[old] && placed[old] && placed[old].box) placed[old].box.remove();
    placed = next;
    if (anchors.length || layerHost) paint();
    var key = JSON.stringify(report);
    if (key !== placeAll.last) { placeAll.last = key; post("anchors", { items: report }); }
  };
  placeAll.last = "[]";
  var rectOfAnchor = function (id) {
    var slot = placed[id];
    if (!slot) return null;
    if (slot.range) return rectOf(slot.range.getBoundingClientRect());
    if (slot.el) return rectOf(slot.el.getBoundingClientRect());
    return null;
  };
  // The pointer on a tinted passage: which comment, and after a moment's rest, tell the app.
  var caretAt = function (x, y) {
    if (document.caretPositionFromPoint) { var p = document.caretPositionFromPoint(x, y); return p ? { node: p.offsetNode, offset: p.offset } : null; }
    if (document.caretRangeFromPoint) { var r = document.caretRangeFromPoint(x, y); return r ? { node: r.startContainer, offset: r.startOffset } : null; }
    return null;
  };
  var passageAt = function (x, y) {
    var c = null;
    for (var id in placed) {
      var range = placed[id] && placed[id].range;
      if (!range) continue;
      c = c || caretAt(x, y);
      if (!c) return null;
      var inside = false;
      try { inside = range.isPointInRange(c.node, c.offset); } catch (e) { inside = false; }
      if (!inside) continue;
      var rects = range.getClientRects();
      for (var i = 0; i < rects.length; i++) {
        var r = rects[i];
        if (x >= r.left - 1 && x <= r.right + 1 && y >= r.top - 1 && y <= r.bottom + 1) return { id: id, rect: rectOf(r) };
      }
    }
    return null;
  };
  var hoverId = "", hoverTimer = 0;
  var hoverSoon = function (id, rect) {
    if (id === hoverId) return;
    hoverId = id;
    clearTimeout(hoverTimer);
    if (!id) { hoverTimer = setTimeout(function () { post("anchor", { id: "", how: "leave" }); }, 120); return; }
    hoverTimer = setTimeout(function () { var r = rect(); if (r) post("anchor", { id: id, how: "hover", rect: r }); }, 220);
  };
  var moveFrame = 0, moveX = 0, moveY = 0;
  addEventListener("mousemove", function (e) {
    moveX = e.clientX; moveY = e.clientY;
    if (moveFrame) return;
    moveFrame = requestAnimationFrame(function () {
      moveFrame = 0;
      if (picking) return probeAt(document.elementFromPoint(moveX, moveY));
      var any = false;
      for (var id in placed) if (placed[id] && placed[id].range) { any = true; break; }
      if (!any) return;
      var hit = passageAt(moveX, moveY);
      if (hit) hoverSoon(hit.id, function () { return hit.rect; });
      else if (hoverId && placed[hoverId] && placed[hoverId].range) hoverSoon("", null);
    });
  }, { passive: true });
  addEventListener("click", function (e) {
    if (picking || e.button !== 0) return;
    var sel = document.getSelection();
    if (sel && !sel.isCollapsed) return; // a selection being made over commented words is a selection
    var hit = passageAt(e.clientX, e.clientY);
    if (hit) post("anchor", { id: hit.id, how: "click", rect: hit.rect });
  }, true);
  // An open card follows its passage, and the Comment key the selected words, while the page moves.
  var followFrame = 0;
  var follow = function () {
    if (followFrame || (!activeId && !selData && !hasBoxes())) return;
    followFrame = requestAnimationFrame(function () {
      followFrame = 0;
      // The app's Comment key sits on the selected words: it has to know where they went.
      var sel = selData ? document.getSelection() : null;
      if (sel && !sel.isCollapsed && sel.rangeCount) {
        selData.rect = rectOf(sel.getRangeAt(0).getBoundingClientRect());
        lastSel = JSON.stringify(selData);
        post("selection", selData);
      }
      for (var id in placed) if (placed[id] && placed[id].el) boxFor(id, placed[id].el, id === activeId);
      var r = activeId ? rectOfAnchor(activeId) : null;
      if (r) post("anchor", { id: activeId, how: "move", rect: r });
    });
  };
  var hasBoxes = function () { for (var id in placed) if (placed[id] && placed[id].el) return true; return false; };
  addEventListener("scroll", follow, { passive: true, capture: true });
  addEventListener("resize", follow);
  // The pointer left the page (for the app's card on it, or for anywhere else).
  document.documentElement.addEventListener("mouseleave", function () { if (hoverId) hoverSoon("", null); });

  // ---- picking: point at a plot, a figure, a table, to comment on it -------------------------
  var picking = false, picked = null;
  var PICKABLE = "figure, table, img, canvas, video, svg, pre, blockquote, details, section, article, li, p, h1, h2, h3, h4, h5, h6, [id]";
  var labelOf = function (el) {
    var own = el.getAttribute && (el.getAttribute("aria-label") || el.getAttribute("alt") || el.getAttribute("title"));
    if (own) return clip(own, 80);
    if (el.classList && el.classList.contains("js-plotly-plot")) {
      // A Plotly plot: its title, or what its axes say it plots ("gain by number of states").
      var title = el.querySelector(".gtitle"), y = el.querySelector(".ytitle"), x = el.querySelector(".xtitle");
      var axes = [y && clip(y.textContent, 60), x && clip(x.textContent, 60)].filter(Boolean).join(" by ");
      return clip((title && clip(title.textContent, 80)) || axes, 100);
    }
    var part = el.querySelector && el.querySelector("figcaption, caption, .gtitle, h1, h2, h3, h4, h5, h6, legend, summary");
    return part ? clip(part.textContent, 80) : "";
  };
  var pickTarget = function (el) {
    if (!el || el.nodeType !== 1 || el === layerHost) return null;
    var plot = el.closest(".js-plotly-plot");
    if (plot) return plot;
    while (el.ownerSVGElement) el = el.ownerSVGElement;
    var hit = el.closest(PICKABLE);
    return hit && hit !== document.body && hit !== document.documentElement ? hit : (el !== document.body && el !== document.documentElement ? el : null);
  };
  var cssPath = function (el) {
    var parts = [];
    for (var n = el; n && n.nodeType === 1 && n !== document.documentElement && parts.length < 40; n = n.parentNode) {
      var unique = false;
      try { unique = !!n.id && document.querySelectorAll("#" + w.CSS.escape(n.id)).length === 1; } catch (e) { unique = false; }
      if (unique) { parts.unshift("#" + w.CSS.escape(n.id)); break; }
      var nth = 1, sib = n;
      while ((sib = sib.previousElementSibling)) if (sib.localName === n.localName) nth++;
      parts.unshift(n.localName + ":nth-of-type(" + nth + ")");
    }
    return parts.join(" > ");
  };
  var pointOf = function (el) {
    // A Plotly plot keeps the point under the pointer: the trace's name and the point's values.
    var gd = el.closest ? el.closest(".js-plotly-plot") : null, hd = gd && gd._hoverdata && gd._hoverdata[0];
    if (!hd) return null;
    var show = function (v) { return v == null ? "" : clip(typeof v === "number" ? String(Math.round(v * 1e6) / 1e6) : v, 60); };
    var trace = (hd.data && hd.data.name) || (hd.fullData && hd.fullData.name) || "";
    return { trace: show(trace), x: show(hd.x), y: show(hd.y), z: show(hd.z), text: show(hd.text) };
  };
  var probeAt = function (under) {
    picked = pickTarget(under);
    if (!probe || !probe.isConnected) {
      ensureLayer();
      probe = document.createElement("div");
      layerRoot.appendChild(probe);
    }
    if (!picked) { probe.style.display = "none"; return; }
    var r = picked.getBoundingClientRect(), origin = layerHost.getBoundingClientRect();
    probe.style.cssText = "position:absolute;box-sizing:border-box;pointer-events:none;border-radius:5px;border:2px solid " + tint + ";background:color-mix(in srgb," + tint + " 9%,transparent);" +
      "left:" + (r.left - origin.left - 3) + "px;top:" + (r.top - origin.top - 3) + "px;width:" + (r.width + 6) + "px;height:" + (r.height + 6) + "px;";
  };
  var setPicking = function (on) {
    picking = !!on;
    if (picking) ensureLayer();
    if (picking) document.documentElement.setAttribute("data-flux-pick", ""); else document.documentElement.removeAttribute("data-flux-pick");
    if (!picking && probe) probe.style.display = "none";
    picked = null;
  };
  // While picking, a press belongs to the pick: the page must not act on it.
  ["pointerdown", "mousedown", "mouseup", "pointerup", "dblclick", "contextmenu"].forEach(function (name) {
    addEventListener(name, function (e) { if (picking) { e.preventDefault(); e.stopPropagation(); } }, true);
  });
  addEventListener("click", function (e) {
    if (!picking) return;
    e.preventDefault();
    e.stopPropagation();
    var el = pickTarget(e.target) || picked;
    setPicking(false);
    if (!el) return post("pick", { cancel: true });
    var isPlot = !!(el.classList && el.classList.contains("js-plotly-plot"));
    // (A plot's text is its tick labels run together: no use in finding it again.)
    var data = { selector: cssPath(el), tag: el.localName, plot: isPlot, label: labelOf(el), text: isPlot ? "" : clip(el.textContent, 80), heading: headingBefore(el), rect: rectOf(el.getBoundingClientRect()) };
    var point = pointOf(e.target);
    if (point) data.point = point;
    post("pick", data);
  }, true);
  addEventListener("keydown", function (e) {
    if (picking && e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setPicking(false); post("pick", { cancel: true }); }
  }, true);

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
  var text = function (v, max) { return typeof v === "string" ? v.slice(0, max) : ""; };
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
    } else if (d.type === "anchors" && Array.isArray(d.items)) {
      if (/^#[0-9a-f]{6}$/i.test(d.color || "")) tint = d.color;
      anchors = d.items.slice(0, 400).map(function (a) {
        return { id: text(a && a.id, 80), quote: text(a && a.quote, 700), prefix: text(a && a.prefix, 64), suffix: text(a && a.suffix, 64), selector: text(a && a.selector, 1200), tag: text(a && a.tag, 40), label: text(a && a.label, 120), text: text(a && a.text, 120) };
      }).filter(function (a) { return a.id; });
      placeAll.last = "";
      placeAll();
    } else if (d.type === "active") {
      activeId = text(d.id, 80);
      paint();
      if (d.reveal && activeId) {
        stopRestore();
        var slot = placed[activeId];
        if (slot && slot.el) slot.el.scrollIntoView({ block: "center" });
        else if (slot && slot.range) { var box = slot.range.getBoundingClientRect(), s2 = scroller(); s2.scrollTop += box.top - Math.max(80, (window.innerHeight - box.height) / 2); }
        queueState();
        var r = rectOfAnchor(activeId);
        if (r) post("anchor", { id: activeId, how: "move", rect: r });
      }
    } else if (d.type === "pick") {
      setPicking(d.on === true);
    } else if (d.type === "unselect") {
      var sel = document.getSelection();
      if (sel) sel.removeAllRanges();
    }
  });

  var start = function () {
    readOutline();
    post("ready", { path: location.pathname, view: location.search + location.hash, title: clip(document.title, 200) });
    sendState();
    // Pages build themselves after load (a data file arrives, a section fills in), and a comment's
    // passage has to be found again in what they became. A plot redrawing itself under the
    // pointer changes only its own SVG: that moves no words and is not worth a pass.
    var outlineTimer = 0, placeTimer = 0;
    new MutationObserver(function (records) {
      clearTimeout(outlineTimer);
      outlineTimer = setTimeout(function () { readOutline(); queueState(); }, 400);
      var words = records.length > 24;
      for (var i = 0; !words && i < records.length; i++) {
        var t = records[i].target, host = t.nodeType === 1 ? t : t.parentNode;
        if (t === styleEl || t === layerHost || !host || host === styleEl || host.ownerSVGElement || host.localName === "svg") continue;
        if (records[i].addedNodes.length === 1 && (records[i].addedNodes[0] === styleEl || records[i].addedNodes[0] === layerHost)) continue;
        words = true;
      }
      if (!words) return;
      textIndex = null;
      if (!anchors.length) return;
      clearTimeout(placeTimer);
      placeTimer = setTimeout(placeAll, 400);
    }).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    var title = document.querySelector("title");
    if (title) new MutationObserver(queueState).observe(title, { childList: true, characterData: true, subtree: true });
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
}

/** The bridge as the text the server sends for ARTIFACT_BRIDGE_PATH. */
export const artifactBridgeSource = () => `(${artifactBridge.toString()})();\n`;
