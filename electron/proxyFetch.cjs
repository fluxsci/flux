// Publisher-agnostic institutional-proxy PDF capture engine.
//
// Instead of scraping a PDF link and fetch()ing it (fragile per-publisher; blocked by
// anti-bot; broken by viewer/reader pages), we DRIVE the real authenticated browser
// toward the PDF and CAPTURE the actual bytes off the network, however the publisher
// delivers them. Three capture layers feed one "first valid %PDF wins" gate:
//   1. CDP network interception (webContents.debugger + Network domain) — grabs the PDF
//      even when it's rendered inline or loaded as an iframe/subresource by a viewer
//      (e.g. Atypon's ePDF reader), regardless of link structure.
//   2. will-download — for publishers that force a Content-Disposition: attachment.
//   3. in-page fetch(landedUrl) — for when navigation lands directly on a PDF URL.
//
// Extracted from main.cjs so the verification harness can require() it under `electron .`
// without booting the whole app. main.cjs builds the engine with createProxyEngine(deps),
// serializes calls behind a mutex, and wires cancellation.

const isPdfBuf = (b) => !!b && b.length > 4 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46; // %PDF
// A COMPLETE PDF: starts with %PDF and ends with the mandatory %%EOF end-of-file marker
// (spec §7.5.5). This rejects TRUNCATED captures — e.g. the 256 KB partial that Chromium's
// PDF viewer caches from its first 206 range request, which a naive grab would read back and
// wrongly accept (valid %PDF header, corrupt body). We scan a generous tail window because a
// few publishers append small trailers after %%EOF.
const isCompletePdf = (b) => isPdfBuf(b) && b.length > 1024 && b.subarray(Math.max(0, b.length - 8192)).includes("%%EOF");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hostOf = (u) => {
  try {
    return new URL(u).hostname;
  } catch {
    return "";
  }
};

// --- Cell Press cell.com hop -------------------------------------------------------
// Cell Press journal DOIs (10.1016/j.<token>.…) resolve, via doi.org, to ScienceDirect,
// whose anti-bot (PerimeterX / "There was a problem providing the content you requested")
// serves a block page to our automated window — even though the user's real browser (and
// the same institutional IP) gets the article. The IDENTICAL article is also on Cell
// Press's OWN site cell.com, which is NOT bot-walled and exposes a real citation_pdf_url /
// journal-agnostic /action/showPdf?pii=… endpoint. So when we detect a ScienceDirect PII
// for a Cell Press paper, we hop to cell.com and capture the PDF there. `showPdf` needs no
// journal name, so one URL shape covers every Cell Press title. (Verified live: Neuron
// 10.1016/j.neuron.2021.06.030 → complete 3.87 MB PDF.)
const CELL_PRESS_TOKENS = new Set([
  // Cell Press research journals (DOI j.<token>)
  "cell", "neuron", "immuni", "molcel", "devcel", "ccell", "celrep", "cmet", "stem", "cub",
  "str", "chempr", "chembiol", "chom", "cels", "isci", "joule", "matt", "medj", "oneear",
  "patter", "xcrm", "xgen", "xcrp", "crmeth", "xpro", "biophysj", "ajhg", "hgg",
  // Trends reviews family (also Cell Press, also on cell.com)
  "tics", "tins", "tcb", "tig", "tem", "tibs", "tree", "tips", "tim", "molmed", "it", "pt",
  "tibtech", "tplants", "trechm",
]);

/** True if `doi` is a Cell Press journal DOI (10.1016/j.<token>.…) — the ones on cell.com. */
function isCellPressDoi(doi) {
  const m = String(doi || "").toLowerCase().match(/^10\.1016\/j\.([a-z]+)\d*\./);
  return !!(m && CELL_PRESS_TOKENS.has(m[1]));
}

/** True if `doi` is an AAAS DOI (10.1126/… — Science, Sci. Adv., Sci. Transl. Med., …).
 *  Every AAAS journal is served on science.org, whose main-text PDF is the fixed shape
 *  /doi/pdf/<doi> — so we can synthesize it directly instead of hoping the page links it. */
function isAaasDoi(doi) {
  return /^10\.1126\//i.test(String(doi || ""));
}

// Main-text-vs-supplement judgement lives in ONE place, shared with the TypeScript side
// (flux-core, the renderer, the verify scripts) so the engine and the write-time check can
// never disagree. See electron/supplementRules.cjs for why the rules are shaped as they are.
const { isSupplementUrl, partitionCandidates, supplementNameFromUrl } = require("./supplementRules.cjs");

/** Compact ScienceDirect PII (S + 16 SICI chars) → Cell Press hyphenated form used by
 *  cell.com, e.g. S0896627321004955 → S0896-6273(21)00495-5. null if not PII-shaped. */
function hyphenatePii(compact) {
  const m = String(compact || "").match(/^S([0-9X]{16})$/i);
  if (!m) return null;
  const d = m[1];
  return `S${d.slice(0, 4)}-${d.slice(4, 8)}(${d.slice(8, 10)})${d.slice(10, 15)}-${d.slice(15)}`;
}

/** Rewrite an absolute publisher URL into EZProxy's host-rewrite form (dots→dashes,
 *  existing dashes doubled), so a hop to another publisher host stays inside the
 *  authenticated proxied session. Node twin of scrapeCandidates' in-page `rp()`. */
function rewriteToProxyHost(u, prefixHost) {
  try {
    const x = new URL(u);
    if (x.hostname === prefixHost || x.hostname.endsWith("." + prefixHost)) return u;
    const rw = x.hostname.replace(/-/g, "--").replace(/\./g, "-") + "." + prefixHost;
    return x.protocol + "//" + rw + x.pathname + x.search + x.hash;
  } catch {
    return u;
  }
}

/** Extract the first DOI in a string (target may be a doi.org URL or a landing URL). */
function doiFromTarget(t) {
  return (String(t || "").match(/10\.\d{4,9}\/[^\s?#"']+/) || [""])[0];
}

function createProxyEngine(deps) {
  const { session, BrowserWindow, ezproxyPrefix, proxiedUrl, isProxyLoginUrl, PROXY_PARTITION, path, fs, os } = deps;
  const log = typeof deps.log === "function" ? deps.log : () => {}; // optional step tracer (harness/debug)

  // ONE reusable hidden window for the whole engine lifetime. Creating + destroying a window
  // per fetch is fragile (in a --no-sandbox / restricted environment the renderer for the
  // SECOND window fails to fork → "No target available" on debugger.attach → the fetch dies)
  // AND wasteful (a bulk run does ~1,000 sequential fetches). The mutex in main.cjs guarantees
  // only one fetch runs at a time, so a single window — reset to about:blank between papers —
  // is correct and far more stable. CDP is attached once; each call swaps in its own handler.
  let win = null;
  let dbg = null;
  let cdpOk = false;
  let activeOnCdp = null; // the current call's CDP message handler (null between calls)

  async function ensureWindow() {
    if (win && !win.isDestroyed()) return win;
    win = new BrowserWindow({ show: false, width: 1200, height: 900, webPreferences: { partition: PROXY_PARTITION } }); // NOT offscreen — detected as headless
    const wc = win.webContents;
    // Hostile-page containment: this window loads live, untrusted publisher HTML/JS (its whole
    // job), carrying the authenticated proxy session — so lock the escape hatches our own code
    // never uses. (1) Deny window.open: we never spawn child windows, and a captured page must
    // not pop a visible child that inherits the proxy session. (2) Allow only http(s)/about
    // navigations — the only schemes the capture ever uses — so a page can't redirect the window
    // to a file:// or custom-scheme handler. loadURL() from the main process does NOT emit
    // will-navigate, so this never blocks our own driving of the capture.
    wc.setWindowOpenHandler(() => ({ action: "deny" }));
    const allowNav = (u) => /^(https?:|about:)/i.test(u || "");
    wc.on("will-navigate", (e, u) => { if (!allowNav(u)) e.preventDefault(); });
    wc.on("will-redirect", (e, u) => { if (!allowNav(u)) e.preventDefault(); });
    dbg = wc.debugger;
    cdpOk = false;
    // Strip the "Electron/x" + "flux/x" tokens from the User-Agent: a research tool shouldn't
    // advertise itself to publishers, and some anti-bot filters flag non-browser UAs. (Note:
    // this does NOT defeat Cloudflare managed challenges — those wall us regardless.)
    try {
      wc.setUserAgent(wc.getUserAgent().replace(/ (flux|Electron)\/[^ ]+/gi, ""));
    } catch {
      /* ignore */
    }
    // Commit an about:blank frame BEFORE attaching: it spawns the renderer/target (else
    // debugger.attach throws "No target available") and lets Network.enable resolve (it hangs
    // forever on a webContents that has never committed a navigation).
    await wc.loadURL("about:blank").catch(() => {});
    try {
      dbg.attach("1.3");
      await Promise.race([
        dbg.sendCommand("Network.enable", { maxTotalBufferSize: 300 * 1024 * 1024, maxResourceBufferSize: 120 * 1024 * 1024 }),
        new Promise((_res, rej) => setTimeout(() => rej(new Error("Network.enable timeout")), 8000)),
      ]);
      // One persistent router for the window's lifetime; it dispatches to whichever call is
      // currently active (per-call handlers close over that call's winner-gate).
      dbg.on("message", (_e, method, params) => {
        if (activeOnCdp) activeOnCdp(_e, method, params);
      });
      cdpOk = true;
      log("cdp-attached");
    } catch (e) {
      log("cdp-attach-failed: " + ((e && e.message) || e)); // degrade to Layers 2+3 (download + grab)
    }
    return win;
  }

  /** Destroy the reusable window (app shutdown / test teardown). */
  function dispose() {
    try {
      if (win && !win.isDestroyed()) win.destroy();
    } catch {
      /* ignore */
    }
    win = null;
    dbg = null;
    cdpOk = false;
    activeOnCdp = null;
  }

  // Gather candidate PDF affordances from the current page (navigation targets, not bytes).
  // Ordered by reliability: citation_pdf_url (Highwire/Atypon/Silverchair/Wiley/OUP/Sage/
  // APS/AAAS/PNAS), <link application/pdf>, Elsevier pdfDownload JSON, then PDF-ish anchors,
  // then PDF-looking buttons with no href (tagged for click). Non-proxied hosts are rewritten
  // into EZProxy's host-rewrite form so the fetch stays inside the authenticated session.
  // The supplement URL rules are SERIALIZED INTO the page script rather than duplicated:
  // the in-page sweep needs them to spot non-PDF supplements (.docx/.xlsx/.mov/.zip) that
  // the PDF-shaped selectors above would never match, and a second hand-maintained copy of
  // these patterns is exactly the drift that let the Science bug through the first time.
  const SUPP_RX_SRC = JSON.stringify(require("./supplementRules.cjs").SUPPLEMENT_URL_PATTERNS.map((r) => r.source));

  const scrapeCandidates = (wc, prefixHost) =>
    wc
      .executeJavaScript(
        `(() => {
      const PD = ${JSON.stringify(prefixHost)};
      const SUPP = ${SUPP_RX_SRC}.map((s) => new RegExp(s, 'i'));
      const abs = (h) => { try { return new URL(h, location.href).href; } catch (e) { return null; } };
      const lbl = (el) => ((el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 120));
      const out = [];
      const m = document.querySelector('meta[name="citation_pdf_url"]'); if (m && m.content) out.push({ url: abs(m.content), kind: 'citation_pdf_url' });
      for (const l of document.querySelectorAll('link[type="application/pdf"]')) if (l.href) out.push({ url: abs(l.href), kind: 'link-pdf' });
      try {
        const h = document.documentElement.innerHTML;
        const b = (h.match(/"pdfDownload":\\{[\\s\\S]{0,800}?\\}\\}/) || [])[0] || '';
        const g = (re) => (b.match(re) || [])[1];
        const md5 = g(/"md5":"([^"]+)"/), pid = g(/"pid":"([^"]+)"/), pii = g(/"pii":"([^"]+)"/), ext = g(/"pdfExtension":"([^"]+)"/), p = g(/"path":"([^"]+)"/);
        if (md5 && pid && pii && ext && p) out.push({ url: location.origin + '/' + p + '/' + pii + ext + '?md5=' + md5 + '&pid=' + encodeURIComponent(pid), kind: 'elsevier-json' });
      } catch (e) {}
      const rxHref = /\\.pdf(\\?|#|$)|\\/epdf\\b|\\/pdfft\\b|\\/doi\\/pdf\\b|\\/pdf\\b|pdfdirect|[?&](format|type)=pdf\\b/i;
      const rxText = /\\bpdf\\b|download pdf|view pdf|full text pdf/i;
      // Fragment links point back at THIS page ("Supplementary Materials" jump links), not
      // at a file — they'd otherwise be scraped as candidates and fetched as HTML.
      const here = location.href.split('#')[0];
      const isFragment = (u) => u.split('#')[0] === here;
      for (const a of document.querySelectorAll('a[href]')) {
        const hh = abs(a.getAttribute('href')); if (!hh || isFragment(hh)) continue;
        const txt = (a.textContent || '') + ' ' + (a.getAttribute('aria-label') || '') + ' ' + (a.getAttribute('title') || '') + ' ' + (a.className || '');
        if (rxHref.test(hh)) out.push({ url: hh, kind: 'anchor-href', label: lbl(a) });
        else if (rxText.test(txt)) out.push({ url: hh, kind: 'anchor-text', label: lbl(a) });
        // Supplements of ANY file type (.docx/.xlsx/.mov/.zip). The PDF-shaped selectors
        // above catch only supplementary PDFs; these are the rest of the SI set.
        else if (SUPP.some((r) => r.test(hh))) out.push({ url: hh, kind: 'supplement', label: lbl(a) });
      }
      let bi = 0;
      for (const el of document.querySelectorAll('button, [role=button], a:not([href])')) {
        const txt = (el.textContent || '') + ' ' + (el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('title') || '');
        if (/download pdf|view pdf|\\bpdf\\b/i.test(txt)) { el.setAttribute('data-flux-pdf', String(bi)); out.push({ sel: '[data-flux-pdf="' + bi + '"]', kind: 'button', label: lbl(el) }); bi++; }
      }
      const rp = (u) => { try { const x = new URL(u); if (x.hostname === PD || x.hostname.endsWith('.' + PD)) return u; const rw = x.hostname.replace(/-/g, '--').replace(/\\./g, '-') + '.' + PD; return x.protocol + '//' + rw + x.pathname + x.search + x.hash; } catch (e) { return u; } };
      const seen = new Set(), res = [];
      for (const c of out) {
        if (c.url) { const u = rp(c.url); if (!u || seen.has(u)) continue; seen.add(u); res.push({ url: u, kind: c.kind, label: c.label || '' }); }
        else if (c.sel) { if (seen.has(c.sel)) continue; seen.add(c.sel); res.push({ sel: c.sel, kind: c.kind, label: c.label || '' }); }
      }
      return res;
    })()`,
      )
      .catch(() => []);

  // Click a tagged element (last-resort PDF button). Neutralize target so the PDF loads in
  // THIS window (where our capture net is attached), not a new tab we don't watch.
  const clickInPage = (wc, sel) =>
    wc
      .executeJavaScript(
        `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false;
        try { el.removeAttribute('target'); const a = el.closest && el.closest('a'); if (a) a.removeAttribute('target'); } catch (e) {}
        try { el.scrollIntoView(); } catch (e) {} el.click(); return true; })()`,
      )
      .catch(() => false);

  /**
   * Capture the article PDF for `target` through the authenticated proxy.
   * `withSupplements` additionally captures the page's supplementary files (a best-effort
   * extra pass on a page we have already loaded and authenticated) and returns them as
   * `{ name, label, bytesB64, url }[]` — see the supplement pass below.
   */
  async function capturePdfViaBrowser({ target, signal, withSupplements = false }) {
    const aborted = () => !!(signal && signal.aborted);
    const throwIfAborted = () => {
      if (aborted()) {
        const e = new Error("cancelled");
        e.name = "AbortError";
        throw e;
      }
    };
    let prefixHost;
    try {
      prefixHost = new URL(ezproxyPrefix()).hostname;
    } catch {
      return { error: "Invalid EZProxy prefix URL.", reason: "not-configured" };
    }

    const ses = session.fromPartition(PROXY_PARTITION);
    throwIfAborted(); // cancelled while queued behind the mutex — bail before creating a window
    await ensureWindow();
    const wc = win.webContents;
    const tmpFiles = [];
    // Supplement affordances found while looking for the main PDF, and the article URL we
    // found them on — both consumed by the optional supplement pass after the main capture.
    let suppCandidates = [];
    let articleUrl = "";

    // ---- winner gate: first valid %PDF from any layer wins ----
    let settled = false;
    let resolveHit;
    const hit = new Promise((r) => (resolveHit = r));
    const win1 = (buf, finalUrl, via) => {
      // Require a COMPLETE pdf: a truncated capture is ignored (settled stays false) so a
      // later full capture from another layer can still win the gate.
      if (!settled && isCompletePdf(buf)) {
        settled = true;
        resolveHit({ buf, finalUrl, via });
      }
    };
    // Wait up to `ms` for the async gate (CDP/download), or bail on timeout/abort.
    const raceHit = (ms) =>
      new Promise((resolve) => {
        let done = false;
        const fin = (v) => {
          if (!done) {
            done = true;
            resolve(v);
          }
        };
        hit.then(fin);
        const t = setTimeout(() => fin(null), ms);
        const onA = () => {
          clearTimeout(t);
          fin(null);
        };
        if (signal) signal.addEventListener("abort", onA, { once: true });
      });

    // Layer 3: in-page fetch of a landed URL → { buf, finalUrl } | null. The in-page fetch
    // is time-boxed with AbortSignal.timeout so a publisher that streams an endless/huge
    // response can't make executeJavaScript hang forever (that would stall the whole run —
    // a .catch() can't rescue a promise that never settles). The executeJavaScript await is
    // ALSO wrapped in a JS-side race as a belt-and-braces guard.
    const grab = (u, ms = 25000) => {
      const p = wc
        .executeJavaScript(
          `(async () => { try {
          const r = await fetch(${JSON.stringify(u)}, { credentials: 'include', signal: AbortSignal.timeout(${ms}) });
          if (!r.ok) return null;
          const b = new Uint8Array(await r.arrayBuffer());
          if (!(b[0]===0x25 && b[1]===0x50 && b[2]===0x44 && b[3]===0x46)) return null;
          const cl = parseInt(r.headers.get('content-length') || '', 10);
          let s = ''; const CH = 0x8000; for (let i = 0; i < b.length; i += CH) s += String.fromCharCode.apply(null, b.subarray(i, i + CH));
          return { b64: btoa(s), url: r.url || ${JSON.stringify(u)}, len: b.length, contentLength: Number.isFinite(cl) ? cl : 0 };
        } catch (e) { return null; } })()`,
        )
        .then((g) => {
          if (!g) return null;
          const buf = Buffer.from(g.b64, "base64");
          // LR-14: accept if the %%EOF gate passes, OR we demonstrably got the WHOLE resource — a
          // full (non-ranged) 200 whose byte length matches Content-Length. The latter rescues
          // valid PDFs whose %%EOF sits beyond the last-8KB window (a large appended trailer),
          // which the window check false-negatives. This grab is always a full GET, never a 206.
          const whole = g.contentLength > 0 && g.len === g.contentLength && isPdfBuf(buf) && buf.length > 1024;
          return isCompletePdf(buf) || whole ? { buf, finalUrl: g.url } : null; // else reject truncated
        })
        .catch(() => null);
      // Outer guard: resolve null if executeJavaScript itself never settles (renderer wedged).
      return Promise.race([p, new Promise((res) => setTimeout(() => res(null), ms + 3000))]);
    };

    // Supplement twin of grab(): supplementary files are routinely .docx/.xlsx/.mov/.zip, so
    // the %PDF magic-byte gate doesn't apply. Completeness is judged by Content-Length match
    // instead (and %%EOF as well, when the file does turn out to be a PDF). Oversized media
    // is skipped rather than streamed — a supplementary video can be hundreds of megabytes,
    // and a research library shouldn't silently swallow that.
    const SUPPLEMENT_MAX_BYTES = 64 * 1024 * 1024;
    const grabAny = (u, ms = 25000) => {
      const p = wc
        .executeJavaScript(
          `(async () => { try {
          const r = await fetch(${JSON.stringify(u)}, { credentials: 'include', signal: AbortSignal.timeout(${ms}) });
          if (!r.ok) return null;
          const cl = parseInt(r.headers.get('content-length') || '', 10);
          if (Number.isFinite(cl) && cl > ${SUPPLEMENT_MAX_BYTES}) return { tooBig: cl };
          const b = new Uint8Array(await r.arrayBuffer());
          if (b.length > ${SUPPLEMENT_MAX_BYTES}) return { tooBig: b.length };
          let s = ''; const CH = 0x8000; for (let i = 0; i < b.length; i += CH) s += String.fromCharCode.apply(null, b.subarray(i, i + CH));
          return { b64: btoa(s), url: r.url || ${JSON.stringify(u)}, len: b.length, contentLength: Number.isFinite(cl) ? cl : 0, type: r.headers.get('content-type') || '' };
        } catch (e) { return null; } })()`,
        )
        .then((g) => {
          if (!g) return null;
          if (g.tooBig) {
            log("supplement-too-big (" + g.tooBig + " bytes): " + u);
            return null;
          }
          const buf = Buffer.from(g.b64, "base64");
          if (buf.length < 64) return null; // an error stub, not a file
          // An HTML error/login page served with 200 is the common failure here.
          if (/^\s*<(!doctype|html)/i.test(buf.subarray(0, 64).toString("latin1"))) return null;
          if (isPdfBuf(buf) && !isCompletePdf(buf) && !(g.contentLength > 0 && g.len === g.contentLength)) return null;
          return { buf, finalUrl: g.url };
        })
        .catch(() => null);
      return Promise.race([p, new Promise((res) => setTimeout(() => res(null), ms + 3000))]);
    };

    // Navigate `u`, but never block longer than `ms`: loadURL resolves on did-finish-load,
    // rejects on a PDF that turns into a download/ERR_ABORTED (both fine — we inspect what
    // landed), but a wedged main-frame load would otherwise await forever.
    const navigate = (u, ms = 30000) =>
      Promise.race([wc.loadURL(u).catch(() => {}), new Promise((res) => setTimeout(res, ms))]);

    // Cell Press → cell.com hop (see the CELL_PRESS_TOKENS note at top of file). Reads the
    // ScienceDirect PII off the current URL, converts it to cell.com's hyphenated form, and
    // navigates to cell.com's journal-agnostic showPdf endpoint (inside the proxied session),
    // then captures via the same net (CDP / will-download / in-page grab). `force` attempts it
    // for ANY ScienceDirect PII (used as a last resort before giving up), not just DOIs whose
    // token we recognize as Cell Press. Returns { buf, finalUrl, via } | null. Safe for
    // non-Cell-Press papers: cell.com returns a non-PDF and the completeness gate rejects it.
    const doi = doiFromTarget(target);
    const cellHopTried = new Set();
    const tryCellPressHop = async (force) => {
      const cur = wc.getURL();
      const pii = (cur.match(/\/pii\/(S[0-9X]+)/i) || [])[1];
      if (!pii) return null;
      if (!force && !isCellPressDoi(doi)) return null;
      const hyph = hyphenatePii(pii);
      if (!hyph || cellHopTried.has(hyph)) return null;
      cellHopTried.add(hyph);
      const cellUrl = rewriteToProxyHost("https://www.cell.com/action/showPdf?pii=" + encodeURIComponent(hyph), prefixHost);
      log("cellpress-hop: " + cellUrl);
      await navigate(cellUrl);
      throwIfAborted();
      if (isProxyLoginUrl(wc.getURL())) return null; // session bounce — caller handles SESSION
      const hit = await raceHit(5000); // CDP/forced-download may capture it
      if (hit) return hit;
      const grabbed = await grab(wc.getURL()); // else same-origin full GET on cell.com
      return grabbed ? { ...grabbed, via: "cellpress" } : null;
    };

    // Layer 1: CDP network interception.
    const pending = new Map(); // requestId -> { url, ranged }
    const onCdp = (_e, method, params) => {
      try {
        if (method === "Network.responseReceived") {
          const r = params.response || {};
          const mime = String(r.mimeType || "").toLowerCase();
          const url = r.url || "";
          const headers = r.headers || {};
          const cd = String(headers["content-disposition"] || headers["Content-Disposition"] || "");
          const dispPdf = /pdf|\.pdf|attachment/i.test(cd);
          const urlPdfish = /\.pdf(\?|#|$)|\/pdf\b|\/pdfft\b|\/epdf\b|\/doi\/pdf\b|pdfdirect/i.test(url);
          const octet = /^(application\/octet-stream|binary\/octet-stream|application\/download)$/.test(mime);
          // Skip supplement responses — a page may stream the supporting-information PDF as a
          // subresource, and we must never let that win the gate as the main article (paper.pdf).
          if ((mime === "application/pdf" || (octet && (urlPdfish || dispPdf))) && !isSupplementUrl(url))
            pending.set(params.requestId, { url, ranged: r.status === 206 });
        } else if (method === "Network.loadingFinished") {
          const p = pending.get(params.requestId);
          if (!p) return;
          pending.delete(params.requestId);
          if (p.ranged) {
            // 206 partial-content body would be truncated — refetch the whole thing.
            grab(p.url).then((g) => g && win1(g.buf, g.finalUrl, "grab-ranged"));
            return;
          }
          dbg
            .sendCommand("Network.getResponseBody", { requestId: params.requestId })
            .then(({ body, base64Encoded }) => win1(base64Encoded ? Buffer.from(body, "base64") : Buffer.from(body, "binary"), p.url, "cdp"))
            .catch(() => {}); // body may already be evicted — harmless
        } else if (method === "Network.loadingFailed") {
          pending.delete(params.requestId);
        }
      } catch {
        /* ignore */
      }
    };

    // Layer 2: forced download.
    const onDownload = (_e, item, itemWc) => {
      if (itemWc && itemWc !== wc) return; // scope to our window (serialization also guarantees this)
      try {
        const p = path.join(os.tmpdir(), "flux-proxy-" + Date.now() + "-" + tmpFiles.length + ".pdf");
        tmpFiles.push(p);
        item.setSavePath(p); // set a path so Electron never pops a blocking (invisible) save dialog
        item.once("done", (_e2, state) => {
          if (state === "completed") {
            try {
              win1(fs.readFileSync(p), item.getURL(), "download");
            } catch {
              /* ignore */
            }
          }
        });
      } catch {
        /* ignore */
      }
    };

    // On cancel, stop the in-flight load so a wedged navigation unblocks promptly (the
    // throwIfAborted at the next await boundary then returns cancelled). We do NOT destroy the
    // reusable window — it's reset to about:blank in finally and kept for the next fetch.
    const onAbort = () => {
      try {
        wc.stop();
      } catch {
        /* ignore */
      }
    };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });

    const ok = (g) => ({ bytesB64: g.buf.toString("base64"), contentType: "application/pdf", finalUrl: g.finalUrl, via: g.via });
    const fail = (reason, landedUrl, affordancesFound, detail) => ({
      error: reason === "no-affordances" ? "No PDF link found on the article page (it may need a different access route)." : "Found the article but couldn't capture a PDF (the publisher may block automated download).",
      reason,
      diag: { landedUrl, host: hostOf(landedUrl) || prefixHost, affordancesFound, detail },
    });
    const SESSION = { error: "Your library session isn't active. Open ⚙ Keys → Re-sign in, complete NetID + Duo, then try again.", reason: "session-expired" };

    // Supplementary files, captured on a page we have already loaded and authenticated —
    // so the marginal cost is a few same-session GETs, not another article fetch. Runs only
    // when the caller asks, only after the main text is safely in hand, and NEVER lets a
    // failure here affect the main result (a supplement is a bonus, not a prerequisite).
    const collectSupplements = async () => {
      const out = [];
      if (!suppCandidates.length) return out;
      // PASS 2 may have navigated us into a PDF; go back to the article so same-origin
      // credentialed fetches resolve the way they did when we scraped the links.
      try {
        if (articleUrl && wc.getURL() !== articleUrl) {
          await navigate(articleUrl);
          await sleep(400);
        }
      } catch {
        /* best-effort — grab() below simply returns null if we're on the wrong page */
      }
      for (const c of suppCandidates) {
        if (aborted()) break;
        if (!c.url) continue;
        log("supplement: " + c.url);
        const g = await grabAny(c.url).catch(() => null);
        if (!g) continue;
        out.push({
          name: supplementNameFromUrl(g.finalUrl) || supplementNameFromUrl(c.url) || "supplement.pdf",
          label: c.label || "",
          url: g.finalUrl || c.url,
          bytesB64: g.buf.toString("base64"),
        });
      }
      return out;
    };

    // The main-PDF capture. Split into its own step so the supplement pass can run while the
    // window is still on the article page — the `finally` below resets it to about:blank.
    const runMainCapture = async () => {
      // Navigate the proxied DOI + settle out the login?url→resource hops AND publisher
      // interstitials (e.g. Elsevier LinkingHub meta-refresh) until we're on a stable page.
      log("navigate: " + proxiedUrl(target));
      await navigate(proxiedUrl(target));
      let last = "";
      for (let start = Date.now(); Date.now() - start < 12000; ) {
        throwIfAborted();
        await sleep(400);
        const u = wc.getURL();
        if (!wc.isLoading() && u && u === last && !isProxyLoginUrl(u) && !/\/(retrieve|linkinghub|articleselect)/i.test(u)) break;
        last = u;
      }
      throwIfAborted();
      log("settled: " + wc.getURL());
      if (isProxyLoginUrl(wc.getURL())) return SESSION;
      articleUrl = wc.getURL(); // where the supplement pass returns to, if it runs

      // The landing page itself may already have streamed the PDF inline (viewer/CDN).
      let got = await raceHit(1200);
      if (got) return ok(got);
      throwIfAborted();
      log("grab-landing");
      const direct = await grab(wc.getURL());
      if (direct) return ok({ ...direct, via: "grab" });

      // Cell Press hop FIRST for recognized Cell Press DOIs: their ScienceDirect landing is
      // usually an anti-bot block page with no affordances, but cell.com serves the PDF.
      if (isCellPressDoi(doi)) {
        const cellGot = await tryCellPressHop(false);
        if (cellGot) return ok(cellGot);
        if (isProxyLoginUrl(wc.getURL())) return SESSION;
        await navigate(proxiedUrl(target)); // hop missed — restore the article page for the normal flow
        await sleep(600);
      }

      // Gather affordances (PDF links/buttons) from the article page, then SPLIT them:
      // supplements can never compete for the main-PDF slot, and the rest are RANKED so the
      // most article-like affordance is tried first. Ordering matters as much as filtering —
      // publishers routinely list the supplement above the PDF control, and consuming the
      // list in DOM order is what stored a supplement as paper.pdf (the Science bug).
      const scraped = await scrapeCandidates(wc, prefixHost);
      const split = partitionCandidates(scraped, doi);
      let candidates = split.main;
      suppCandidates = split.supplements; // captured later, if the caller asked for them
      // AAAS/Science (10.1126/…): the main text is always at the fixed /doi/pdf/<doi> on
      // science.org, so synthesize it and put it FIRST (mirrors the Cell Press cell.com hop).
      // NOTE: this MOVES the URL to the front even when the page already links it. The
      // previous "add only if absent" form silently did nothing on every page that exposes
      // /doi/pdf/<doi> — i.e. every modern Science article — which is precisely when the
      // supplement outranked it. Hoisting, not inserting, is the point.
      if (isAaasDoi(doi)) {
        const sci = rewriteToProxyHost("https://www.science.org/doi/pdf/" + doi, prefixHost);
        const at = candidates.findIndex((c) => c.url === sci);
        if (at >= 0) candidates.unshift(candidates.splice(at, 1)[0]);
        else candidates.unshift({ url: sci, kind: "aaas-doi-pdf" });
      }
      const affordancesFound = [...new Set(candidates.map((c) => c.kind))];
      log("candidates(" + candidates.length + "): " + JSON.stringify(candidates.slice(0, 8)));
      if (!candidates.length) {
        // Last resort before giving up: if the page exposes a ScienceDirect PII (even one whose
        // journal token we don't recognize), try the cell.com hop unconditionally.
        const cellGot = await tryCellPressHop(true);
        if (cellGot) return ok(cellGot);
        if (isProxyLoginUrl(wc.getURL())) return SESSION;
        return fail("no-affordances", wc.getURL(), affordancesFound, "no citation_pdf_url / pdf link / pdf button on the page");
      }

      // Known anti-bot challenge endpoints (Elsevier /pdfft) MUST be reached by real
      // navigation so Chromium solves the JS challenge; an XHR to them poisons the session
      // (per fluxfinder findings), so they're excluded from the direct-grab pass.
      const isChallenge = (u) => /\/pdfft\b|sciencedirect|pdfdirect|cra_js_challenge/i.test(u || "");

      // PASS 1 — direct in-page fetch of each candidate URL from the ARTICLE page context.
      // This returns the COMPLETE file for most publishers (Atypon/Wiley/OUP/Nature/…) and
      // avoids navigating into the PDF viewer, whose 206 range requests cache a truncated
      // partial that a post-navigation grab would read back. Cheap and the common win.
      for (const c of candidates) {
        if (!c.url || isChallenge(c.url)) continue;
        throwIfAborted();
        log("grab-direct " + c.kind + ": " + c.url);
        const g = await grab(c.url);
        if (g) return ok({ ...g, via: "grab-direct" });
      }

      // PASS 2 — navigate/click each affordance and let the capture net (CDP + forced
      // download + post-landing grab) get the bytes. Handles challenge endpoints, forced
      // downloads, and buttons with no href. Retry ≤3× on a cra_js_challenge bounce.
      for (const c of candidates) {
        for (let attempt = 0; attempt < 3; attempt++) {
          throwIfAborted();
          log("nav " + c.kind + " a" + attempt + ": " + (c.url || c.sel));
          if (c.sel && !c.url) await clickInPage(wc, c.sel);
          else await navigate(c.url); // a PDF nav often "fails" as ERR_ABORTED / becomes a download
          got = await raceHit(15000);
          if (got) return ok(got);
          const cur = wc.getURL();
          if (isProxyLoginUrl(cur)) return SESSION;
          if (!/cra_js_challenge/i.test(cur)) {
            const g = await grab(cur);
            if (g) return ok({ ...g, via: "grab" });
            break; // not an anti-bot challenge bounce → don't retry this candidate
          }
          await sleep(800); // backoff before retrying a failed challenge
        }
      }
      return fail("not-a-pdf", wc.getURL(), affordancesFound, "tried all affordances; no PDF captured");
    };

    try {
      activeOnCdp = onCdp; // route this window's CDP messages to THIS call's winner-gate
      ses.on("will-download", onDownload);
      const main = await runMainCapture();
      if (withSupplements && main && main.bytesB64) {
        try {
          main.supplements = await collectSupplements();
        } catch {
          /* a supplement pass must never turn a successful main capture into a failure */
        }
      }
      return main;
    } catch (e) {
      if (e && e.name === "AbortError") return { error: "Cancelled.", reason: "cancelled" };
      return { error: String((e && e.message) || e), reason: "error" };
    } finally {
      activeOnCdp = null; // stop routing CDP messages to this (now finished) call
      if (signal) signal.removeEventListener("abort", onAbort);
      try {
        ses.removeListener("will-download", onDownload);
      } catch {
        /* ignore */
      }
      // Reset the reusable window to a blank page: stops any lingering load and drops the
      // article's pending requests/cache so the next paper starts clean. Debugger stays
      // attached (Network domain enabled) for the next fetch.
      try {
        if (win && !win.isDestroyed()) {
          wc.stop();
          await wc.loadURL("about:blank").catch(() => {});
        }
      } catch {
        /* ignore */
      }
      for (const f of tmpFiles) fs.unlink(f, () => {});
    }
  }

  // Ground-truth "am I signed in?" check — a REAL browser navigation (not net.request).
  // EZProxy's IP-based autologin forwards through a `/connect?session=…&qurl=…` page via
  // JavaScript that net.request can't execute, so the net.request probe (main.cjs
  // probeProxySignedIn) falsely reports "not signed in" and skips the whole library phase.
  // Navigating in the real window completes that forward: land on the resource host = signed
  // in; land on login/connect/SSO = not. Runs on the shared window (serialize via the mutex).
  async function checkSignedIn({ target, signal } = {}) {
    let prefixHost;
    try {
      prefixHost = new URL(ezproxyPrefix()).hostname;
    } catch {
      return { configured: false, signedIn: false };
    }
    await ensureWindow();
    const wc = win.webContents;
    try {
      await Promise.race([wc.loadURL(proxiedUrl(target || "https://www.nature.com/")).catch(() => {}), new Promise((r) => setTimeout(r, 20000))]);
      let last = "";
      for (let start = Date.now(); Date.now() - start < 12000; ) {
        if (signal && signal.aborted) break;
        await sleep(400);
        const u = wc.getURL();
        // Settle until stable; keep waiting through EZProxy's /connect auto-forward hops.
        if (!wc.isLoading() && u && u === last && !/\/connect\b/i.test(u)) break;
        last = u;
      }
      const u = wc.getURL();
      let h = "";
      try {
        h = new URL(u).hostname;
      } catch {
        /* ignore */
      }
      const onResource = (h === prefixHost || h.endsWith("." + prefixHost)) && !isProxyLoginUrl(u);
      log("checkSignedIn landed: " + u + " → " + (onResource ? "signed-in" : "not-signed-in"));
      return { configured: true, signedIn: onResource };
    } finally {
      try {
        if (win && !win.isDestroyed()) {
          wc.stop();
          await wc.loadURL("about:blank").catch(() => {});
        }
      } catch {
        /* ignore */
      }
    }
  }

  return { capturePdfViaBrowser, checkSignedIn, dispose };
}

// Supplement helpers are re-exported from supplementRules.cjs so existing importers keep
// working against one implementation (there is no second copy to drift).
module.exports = {
  createProxyEngine,
  isPdfBuf,
  isCompletePdf,
  hyphenatePii,
  isCellPressDoi,
  isAaasDoi,
  rewriteToProxyHost,
  doiFromTarget,
  ...require("./supplementRules.cjs"),
};
