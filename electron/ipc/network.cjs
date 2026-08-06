"use strict";
// WS-9.4b: the NETWORK family — API-key store, cite:* metadata fetches,
// pdf:netGet (cookie-jar acquisition), and the full library-proxy (EZProxy)
// machinery: credentials (OS-keychain encrypted), login window, status probe,
// the capture engine + its exclusivity mutex, and per-call cancellation —
// extracted verbatim from main.cjs. Channel names and behavior unchanged.

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { createNetGet } = require("../netFetch.cjs");
const { createProxyEngine } = require("../proxyFetch.cjs");

/**
 * deps:
 *   session, BrowserWindow, safeStorage, net — Electron modules
 *   fluxLibDir      — () => machine-global FluxLib root (keys.json/.proxy.json home)
 *   getMainWindow   — () => BrowserWindow | null (proxy:login parent)
 *   resolveToDoi    — ./resolveDoi.cjs (cite:resolveUrl)
 *   locks           — { lockDirFor, writeLockFile, LOCK_TTL_MS } (keys:set shares
 *                     flux-core's FluxLib "keys" lock — owned by the project family)
 *   files           — { atomicWriteMain, noteWrite } (the FILES family write core)
 */
function createNetworkFamily({ session, BrowserWindow, safeStorage, net, fluxLibDir, getMainWindow, resolveToDoi, locks, files }) {
  const { lockDirFor, writeLockFile, LOCK_TTL_MS } = locks;
  const { atomicWriteMain, noteWrite } = files;
  let proxyEngineRef = null; // set during registerHandlers (dispose needs it after)
const fluxKeysPath = () => path.join(fluxLibDir(), "keys.json");
function readKeys() {
  try {
    return JSON.parse(fs.readFileSync(fluxKeysPath(), "utf8"));
  } catch {
    return {};
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
      { headers: { "User-Agent": "Flux/0.1 (manuscript editor)", Accept: "application/json" } },
    );
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const json = await res.json();
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
    });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const bibtex = (await res.text()).trim();
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
    });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    return await res.json();
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
    });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    return await res.json();
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

// --- Library proxy (EZProxy) — user-initiated paywalled access, last resort -----
// A persistent, isolated session partition ("persist:fluxproxy") holds the user's
// library SSO cookies across runs. We NEVER store passwords; the login happens in a
// real window the user drives. Paywalled fetch runs an in-page fetch() inside the
// proxied publisher page (carries its TLS fingerprint + cf_clearance + cookies —
// the native-Electron port of ~/fluxfinder/fetch/browser.py). OA is always tried
// first (the renderer only calls this after the OA waterfall fails).
const PROXY_PARTITION = "persist:fluxproxy";
function ezproxyPrefix() {
  return (getKey("ezproxyPrefix") || "").trim();
}

// Build a proxied entry URL from the configured "login?url=" prefix by appending the
// target RAW (exactly like the library's bookmarklet: `...login?url=' + location.href`).
// CRITICAL: do NOT percent-encode it. EZProxy only accepts the url= value as a real
// target when it literally begins with "http(s)://"; a %3A%2F%2F-encoded value is
// rejected and EZProxy falls back to url=menu → its dead-end "Remote Access Menu". An
// EMPTY target hits the same menu, so always pass a real, unencoded target.
function proxiedUrl(target) {
  return ezproxyPrefix() + String(target || "");
}
// A resource the university licenses, used only to drive the login/status flow through
// NetID SSO. Any non-empty proxiable target works; the landing page is irrelevant because
// the login window auto-closes once it reaches a proxied host, and the status probe only
// inspects the redirect chain.
const PROXY_AUTH_TARGET = "https://www.nature.com/";
// True if `u` is EZProxy's own login/menu plumbing or an identity provider (NetID SSO,
// Shibboleth, Duo) rather than a proxied resource — i.e. the request bounced to sign-in.
// This is what distinguishes "signed in" from "session expired".
function isProxyLoginUrl(u) {
  try {
    const h = new URL(u).hostname;
    if (/^login\./i.test(h)) return true; // EZProxy auth connector + NetID SSO (login.wisc.edu)
    if (/(^|\.)duosecurity\.com$/i.test(h)) return true; // Duo MFA
    return /\/(login|connect|idp|saml|sso|shibboleth)\b|[?&]url=menu\b/i.test(u);
  } catch {
    return false;
  }
}
// Probe whether the persisted session is ACTUALLY authenticated (not just "a cookie
// exists"): request a proxied resource with the partition's cookies, follow the redirect
// chain, and see where it lands. A proxied host ⇒ signed in; the NetID/EZProxy login ⇒
// session expired. Best-effort — resolves false on any error and never hangs the pill.
function probeProxySignedIn() {
  return new Promise((resolve) => {
    let url, prefixHost;
    try {
      prefixHost = new URL(ezproxyPrefix()).hostname;
      url = proxiedUrl(PROXY_AUTH_TARGET);
    } catch {
      return resolve(false);
    }
    let settled = false;
    const decide = (u) => {
      let h = "";
      try {
        h = new URL(u).hostname;
      } catch {
        return false;
      }
      const onResource = h === prefixHost || h.endsWith("." + prefixHost);
      return onResource && !isProxyLoginUrl(u);
    };
    const finish = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    try {
      const req = net.request({ url, session: session.fromPartition(PROXY_PARTITION), redirect: "manual" });
      let finalUrl = url;
      let hops = 0;
      req.on("redirect", (_status, _method, redirectUrl) => {
        finalUrl = redirectUrl || finalUrl;
        if (++hops > 8) {
          try {
            req.abort();
          } catch {
            /* ignore */
          }
          return finish(decide(finalUrl));
        }
        try {
          req.followRedirect();
        } catch {
          finish(decide(finalUrl));
        }
      });
      req.on("response", (res) => {
        finish(decide(finalUrl));
        res.on("data", () => {});
        res.on("end", () => {});
        try {
          req.abort();
        } catch {
          /* ignore */
        }
      });
      req.on("error", () => finish(false));
      req.end();
      setTimeout(() => finish(false), 8000);
    } catch {
      finish(false);
    }
  });
}

// Credentials are stored ENCRYPTED via the OS keychain (Electron safeStorage:
// macOS Keychain / Windows DPAPI / Linux libsecret) in ~/FluxLib/.proxy.json (0600) —
// never plaintext. They auto-fill the SSO login form so re-auth is seamless; combined
// with the persistent session + a trusted-device (Duo "remember me") cookie, the user
// signs in rarely. We never transmit them anywhere but the university's own login page.
function proxyCredPath() {
  return path.join(fluxLibDir(), ".proxy.json");
}
function readProxyCred() {
  try {
    return JSON.parse(fs.readFileSync(proxyCredPath(), "utf8"));
  } catch {
    return {};
  }
}
function proxyPassword() {
  const c = readProxyCred();
  if (!c.passwordEnc || !safeStorage.isEncryptionAvailable()) return null;
  try {
    return safeStorage.decryptString(Buffer.from(c.passwordEnc, "base64"));
  } catch {
    return null;
  }
}
// Fill a detected SSO login form with the stored NetID + password and tick any
// "remember/trust this device" box (so Duo MFA is skipped on later sessions). Fires on
// every navigation; a no-op when the page has no password field. Best-effort; the user
// still approves Duo the first time in the visible window.
function autofillCreds(win, submit) {
  const user = String(readProxyCred().username || "").trim();
  const pass = proxyPassword();
  if (!user && !pass) return;
  const js =
    `(() => { try {
      const p = document.querySelector('input[type=password]');
      if (!p) return false;
      const form = p.form || document;
      const u = form.querySelector('input[type=text],input[type=email],input[name*=user i],input[id*=user i],input[name=j_username]');
      if (u && ${JSON.stringify(user)}) { u.value = ${JSON.stringify(user)}; u.dispatchEvent(new Event('input',{bubbles:true})); }
      if (${JSON.stringify(pass || "")}) { p.value = ${JSON.stringify(pass || "")}; p.dispatchEvent(new Event('input',{bubbles:true})); }
      for (const c of document.querySelectorAll('input[type=checkbox]')) {
        const t = (c.name||'')+(c.id||'')+((c.closest('label')||{}).textContent||'');
        if (/remember|trust|stay|keep/i.test(t)) c.checked = true;
      }
      ${submit ? "if (u && u.value && p.value) { const b = form.querySelector('button[type=submit],input[type=submit],button'); if (b) b.click(); else if (form.submit) form.submit(); }" : ""}
      return true;
    } catch (e) { return false; } })()`;
  win.webContents.executeJavaScript(js, true).catch(() => {});
}

// Store / inspect / clear the proxy credentials (OS-keychain encrypted).
ipc.handle("proxy:setCredentials", (_e, { username, password } = {}) => {
  try {
    if (!safeStorage.isEncryptionAvailable())
      return { error: "Your OS secure storage (keychain) isn't available, so credentials can't be stored safely." };
    fs.mkdirSync(fluxLibDir(), { recursive: true });
    const cur = readProxyCred();
    const next = { username: username != null ? String(username) : cur.username || "" };
    if (password) next.passwordEnc = safeStorage.encryptString(String(password)).toString("base64");
    else if (cur.passwordEnc) next.passwordEnc = cur.passwordEnc;
    fs.writeFileSync(proxyCredPath(), JSON.stringify(next), { mode: 0o600 });
    return { ok: true };
  } catch (err) {
    return { error: String((err && err.message) || err) };
  }
});
ipc.handle("proxy:hasCredentials", () => {
  const c = readProxyCred();
  return { username: c.username || "", hasPassword: !!c.passwordEnc, available: safeStorage.isEncryptionAvailable() };
});
ipc.handle("proxy:clearCredentials", () => {
  try {
    fs.unlinkSync(proxyCredPath());
  } catch {
    /* already gone */
  }
  return { ok: true };
});

// Open a real window to the library's EZProxy login and let the user sign in. We enter
// through a PROXIED resource (proxiedUrl, not the bare /login origin — that lands on
// EZProxy's dead-end "Remote Access Menu") so EZProxy routes into NetID SSO. Credentials
// auto-fill; the user completes Duo and ticks "trust this browser". The window then
// auto-closes the moment navigation reaches a proxied host = authentication succeeded.
ipc.handle("proxy:login", async () => {
  const prefix = ezproxyPrefix();
  if (!prefix) return { error: "Set your library's EZProxy prefix in ⚙ Keys first." };
  let loginUrl, prefixHost;
  try {
    prefixHost = new URL(prefix).hostname; // validate + capture the proxy host
    loginUrl = proxiedUrl(PROXY_AUTH_TARGET);
  } catch {
    return { error: "Invalid EZProxy prefix URL." };
  }
  return await new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 920,
      height: 820,
      title: "Sign in to your library",
      autoHideMenuBar: true,
      parent: getMainWindow() || undefined,
      webPreferences: { partition: PROXY_PARTITION },
    });
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve({ ok: true });
      if (!win.isDestroyed()) win.close();
    };
    // Auto-fill stored NetID + password on each login page (no auto-submit — the user
    // reviews credentials, approves Duo, and ticks "trust this browser").
    win.webContents.on("did-finish-load", () => autofillCreds(win, false));
    // Past all the login/connect/SSO/Duo hops, navigation lands on the proxied resource
    // host (a subdomain of the proxy) — the session cookie is now set, so sign-in worked.
    win.webContents.on("did-navigate", (_e, url) => {
      try {
        const h = new URL(url).hostname;
        if ((h === prefixHost || h.endsWith("." + prefixHost)) && !isProxyLoginUrl(url)) finish();
      } catch {
        /* ignore non-URL navigations */
      }
    });
    win.loadURL(loginUrl).catch(() => {});
    win.on("closed", () => finish());
  });
});

// Report whether the proxy is configured + can ACTUALLY reach paywalled content (drives
// the status pill). We always probe a proxied resource rather than checking cookies:
// access can come from a signed-in session OR from IP-based autologin (on-campus / VPN),
// which grants access with no cookie at all — so cookie presence is neither necessary nor
// sufficient. The probe is the ground truth: does a proxied request reach the resource?
ipc.handle("proxy:status", async () => {
  const prefix = ezproxyPrefix();
  if (!prefix) return { configured: false, signedIn: false };
  try {
    new URL(prefix);
  } catch {
    return { configured: false, signedIn: false };
  }
  // Fast path: the net.request probe. If it says signed-in, trust it. If it says NOT
  // signed-in, it may be a FALSE negative — net.request can't run the JavaScript that
  // EZProxy's IP-based-autologin `/connect?session=…&qurl=…` page uses to forward to the
  // resource, so it stalls on that page and misreads it as a login bounce. Confirm with a
  // real browser navigation (the same window that actually fetches), serialized via the mutex.
  let signedIn = await probeProxySignedIn();
  if (!signedIn) {
    const cachedFresh = Date.now() - lastProxyOkAt < PROXY_STATUS_TTL_MS;
    if (cachedFresh) {
      // A capture/check confirmed the session recently — the probe's false negative loses.
      signedIn = true;
    } else if (proxyPending > 0) {
      // A bulk capture owns the window. NEVER queue a status ping behind a ~30s capture
      // (the pill used to lag half a minute during exactly the "is my session alive?"
      // moment) — answer from what we know now; the pill refreshes after the run.
      signedIn = false;
    } else {
      try {
        const r = await runProxyExclusive(() => proxyEngine.checkSignedIn({ target: PROXY_AUTH_TARGET }));
        signedIn = !!(r && r.signedIn);
        if (signedIn) lastProxyOkAt = Date.now();
      } catch {
        /* keep the net.request result */
      }
    }
  } else {
    lastProxyOkAt = Date.now();
  }
  return { configured: true, signedIn };
});

// Last moment the proxy session was POSITIVELY confirmed (a probe/check success or a
// successful capture). Lets proxy:status answer instantly during bulk runs instead of
// queueing a real navigation behind every in-flight capture.
let lastProxyOkAt = 0;
const PROXY_STATUS_TTL_MS = 5 * 60_000;

// The publisher-agnostic capture engine (electron/proxyFetch.cjs). Instead of scraping a
// PDF link and fetching it (fragile per-publisher; blocked by anti-bot; broken by viewer
// pages), it drives the real authenticated browser toward the PDF and captures the bytes
// off the network however the publisher delivers them (CDP interception + forced download
// + in-page fetch). Deps are the same proxy primitives defined above.
const proxyEngine = (proxyEngineRef = createProxyEngine({
  session,
  BrowserWindow,
  ezproxyPrefix,
  proxiedUrl,
  isProxyLoginUrl,
  PROXY_PARTITION,
  path,
  fs,
  os,
}));

// Only ONE proxy window may exist at a time: the capture net's `will-download` hook lives
// on the shared persist:fluxproxy session, so overlapping fetches would cross-capture each
// other's bytes. This promise-chain mutex serializes every proxy call (bulk loop items AND
// a stray manual "Get via library" click) through a single queue. A cancelled *queued*
// call is rejected before it ever creates a window.
let proxyChain = Promise.resolve();
let proxyPending = 0; // how many exclusive users are queued/running (busy signal for proxy:status)
function runProxyExclusive(fn) {
  proxyPending++;
  const run = proxyChain.then(fn, fn);
  // Keep the chain alive regardless of this call's outcome (never let a rejection break it).
  proxyChain = run.then(
    () => {
      proxyPending--;
    },
    () => {
      proxyPending--;
    },
  );
  return run;
}
// Per-call cancellation registry. The renderer passes an opaque token with each fetch and
// can abort it (or all in-flight, "*") via proxy:cancel — which fires the AbortController
// so the engine tears down its window and the fetch returns in ~1s instead of ~50s.
const proxyCalls = new Map(); // token -> AbortController

// Fetch a paywalled PDF for `target` (a DOI URL or landing page) through the proxy. Thin
// wrapper: validate config, register a cancel token, then run the capture engine inside the
// serialization mutex. Return contract is unchanged — { bytesB64, contentType, finalUrl } |
// { error, reason?, diag? } — so pdfFinderBridge needs no change (the extra reason/diag feed
// the Part C failure log).
ipc.handle("pdf:fetchViaProxy", async (_e, target, token, opts) => {
  const prefix = ezproxyPrefix();
  if (!prefix) return { error: "No EZProxy prefix configured.", reason: "not-configured" };
  try {
    new URL(prefix);
  } catch {
    return { error: "Invalid EZProxy prefix URL.", reason: "not-configured" };
  }
  const ctrl = new AbortController();
  if (token != null) {
    // A cancel that arrived before this call was dequeued: honor it immediately.
    if (proxyCalls.get(token) === "cancelled") {
      proxyCalls.delete(token);
      return { error: "Cancelled.", reason: "cancelled" };
    }
    proxyCalls.set(token, ctrl);
  }
  try {
    const r = await runProxyExclusive(() => {
      if (ctrl.signal.aborted) return { error: "Cancelled.", reason: "cancelled" };
      return proxyEngine.capturePdfViaBrowser({ target, signal: ctrl.signal, withSupplements: !!(opts && opts.withSupplements) });
    });
    // A successful capture proves the session is alive — keep the status pill honest
    // during bulk runs without ever queueing a real status navigation behind them.
    if (r && r.bytesB64) lastProxyOkAt = Date.now();
    return r;
  } catch (e) {
    if (e && e.name === "AbortError") return { error: "Cancelled.", reason: "cancelled" };
    return { error: String((e && e.message) || e), reason: "error" };
  } finally {
    if (token != null) proxyCalls.delete(token);
  }
});

// Cancel one in-flight/queued proxy fetch by token, or all of them with "*". Aborting the
// controller destroys the engine's window (hard-interrupts loadURL/executeJavaScript); a
// token with no live controller yet (still queued) is tombstoned so it aborts on dequeue.
ipc.handle("proxy:cancel", (_e, token) => {
  if (token == null || token === "*") {
    for (const ctrl of proxyCalls.values()) if (ctrl && ctrl.abort) ctrl.abort();
    return { ok: true };
  }
  const ctrl = proxyCalls.get(token);
  if (ctrl && ctrl.abort) ctrl.abort();
  else proxyCalls.set(token, "cancelled"); // arrived before the call registered — tombstone
  return { ok: true };
});

// API-key store (machine-global ~/FluxLib/keys.json). keys:get returns the raw map
// for the settings form (the user's own machine); keys:set merge-writes it.
ipc.handle("keys:get", () => readKeys());
ipc.handle("keys:set", async (_e, patch) => {
  // The read-modify-write runs under the FluxLib "keys" lock (flux-core's saveKeys
  // takes the same one) and the write is atomic — a concurrent `flux keys --…` can
  // no longer lose a field or tear the file.
  const lockDir = lockDirFor("fluxlib");
  const lockPath = path.join(lockDir, "keys.json");
  try {
    try {
      const info = JSON.parse(fs.readFileSync(lockPath, "utf8"));
      const t = Date.parse(info?.ts);
      if (Number.isFinite(t) && Date.now() - t < LOCK_TTL_MS && info.client !== "human") {
        return { error: `keys.json is being written by ${info.client} — retry in a moment` };
      }
    } catch {
      /* absent/corrupt lock — treat as free */
    }
    writeLockFile(lockPath);
    try {
      fs.mkdirSync(fluxLibDir(), { recursive: true });
      const next = { ...readKeys(), ...(patch || {}) };
      // W12 (SHL-8): API keys are plaintext — write owner-only, like the proxy creds.
      await atomicWriteMain(fluxKeysPath(), JSON.stringify(next, null, 2) + "\n");
      await fs.promises.chmod(fluxKeysPath(), 0o600).catch(() => {});
      return next;
    } finally {
      noteWrite(lockPath);
      fs.rmSync(lockPath, { force: true });
    }
  } catch (err) {
    return { error: String((err && err.message) || err) };
  }
});

  }

  return {
    registerHandlers,
    getKey,
    // main's quit path tears down the reusable proxy capture window.
    disposeProxy: () => proxyEngineRef && proxyEngineRef.dispose(),
  };
}

module.exports = { createNetworkFamily };
