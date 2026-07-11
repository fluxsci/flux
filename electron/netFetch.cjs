// pdf:netGet backend — the generic PDF-acquisition fetch for the renderer's resolver
// waterfall (metadata JSON + PDF bytes), extracted from main.cjs so the verification
// harness can require() it under `electron .` without booting the app.
//
// Uses the CHROMIUM network stack via a persistent session partition (ses.fetch with
// credentials:"include"), NOT Node's fetch. This matters for publisher hosts: Node fetch
// has no cookie jar, so every request — and every hop of a redirect chain — arrived
// cookie-less and created a fresh server-side session. Cell Press temp-bans an IP at
// ">90 sessions created in 5 minutes", so a bulk run's 2-4-hop chains blew the wall even
// under a request-rate limiter. With a cookie jar, a publisher sees ONE session however
// many requests we make (and the request itself carries Chromium's TLS fingerprint).
const NET_PARTITION = "persist:fluxnet";
const dns = require("node:dns");
const net = require("node:net");

/** http(s)-only + private-range blocked (SSRF guard); returns the normalized URL or null. */
function publicHttpUrl(raw) {
  let u;
  try {
    u = new URL(String(raw || ""));
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const h = u.hostname.toLowerCase();
  if (h === "localhost" || h === "::1" || /\.local$/.test(h)) return null;
  if (/^(127\.|10\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.)/.test(h)) return null;
  return u.toString();
}

/** WS-9.2: is this LITERAL address (v4/v6) loopback/link-local/RFC1918/CGNAT/
 *  ULA/unspecified? The hostname-regex guard above only sees literals — this
 *  classifies what DNS actually RESOLVES to (metadata endpoints + rebinding). */
function isPrivateAddress(addr) {
  const bare = String(addr || "").replace(/^\[|\]$/g, "");
  const fam = net.isIP(bare);
  if (fam === 4) {
    const p = bare.split(".").map(Number);
    if (p[0] === 0 || p[0] === 127 || p[0] === 10) return true; // unspecified/loopback/RFC1918
    if (p[0] === 169 && p[1] === 254) return true; // link-local (cloud metadata)
    if (p[0] === 192 && p[1] === 168) return true; // RFC1918
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true; // RFC1918
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true; // CGNAT 100.64/10
    return false;
  }
  if (fam === 6) {
    let h = bare.toLowerCase();
    const zone = h.indexOf("%");
    if (zone >= 0) h = h.slice(0, zone);
    if (h === "::" || h === "::1") return true; // unspecified/loopback
    const v4 = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/); // v4-mapped
    if (v4) return isPrivateAddress(v4[1]);
    if (/^fe[89ab]/.test(h)) return true; // link-local fe80::/10
    if (/^f[cd]/.test(h)) return true; // ULA fc00::/7
    return false;
  }
  return true; // not an IP literal — callers resolve first; unknown ⇒ treat as private
}

/** WS-9.2: resolve the hostname and refuse if ANY address is private — a public
 *  DNS name pointing at loopback/RFC1918/metadata is the rebinding vector the
 *  literal check can't see. `lookup` is injectable for hermetic tests. */
async function assertPublicResolved(hostname, lookup = dns.promises.lookup) {
  const bare = String(hostname || "").replace(/^\[|\]$/g, "");
  if (net.isIP(bare)) {
    if (isPrivateAddress(bare)) throw new Error(`blocked: ${bare} is a private address`);
    return;
  }
  const addrs = await lookup(bare, { all: true, verbatim: true });
  if (!addrs || !addrs.length) throw new Error(`blocked: ${bare} did not resolve`);
  for (const a of addrs) {
    if (isPrivateAddress(a.address)) throw new Error(`blocked: ${bare} resolves to private address ${a.address}`);
  }
}

/**
 * Build the netGet(url, mode) handler. mode ∈ json | text | bytes.
 * deps: { session } — Electron's session module; { getKey } — secrets lookup (mailto).
 * Harness-only overrides: { allowPrivate } (target 127.0.0.1), { partition },
 * { timeouts: { bytes, meta } }.
 */
function createNetGet({ session, getKey, allowPrivate = false, partition = NET_PARTITION, timeouts = {}, lookup }) {
  // WS-9.2: a public URL used to be able to 302 to 169.254.169.254 (cloud
  // metadata) or to a DNS name resolving private (rebinding) — redirects were
  // followed unchecked. session.fetch CANCELS manual redirects outright
  // ("Redirect was cancelled"), so hop-by-hop looping is impossible with the
  // cookie-jar fetch; instead the partition's webRequest gate validates EVERY
  // request — the initial one and each redirect hop (Chromium issues each hop
  // as a fresh request through the network stack, so onBeforeRequest fires and
  // can CANCEL, and the async-callback form permits real DNS validation).
  // Set-Cookie semantics are untouched (normal follow behavior; the harness
  // proves a 2-hop chain still presents ONE session).
  // LAZY session init: createNetGet is called at module scope in main.cjs, and
  // session.fromPartition throws before app-ready.
  let ses = null;
  const getSession = () => {
    if (ses) return ses;
    ses = session.fromPartition(partition);
    if (!allowPrivate) {
      ses.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*"] }, (details, callback) => {
        (async () => {
          const safe = publicHttpUrl(details.url);
          if (!safe) return { cancel: true };
          await assertPublicResolved(new URL(safe).hostname, lookup); // throws ⇒ cancel
          return { cancel: false };
        })().then(callback, () => callback({ cancel: true }));
      });
    }
    return ses;
  };
  return async function netGet(url, mode = "bytes") {
    const safe = allowPrivate ? String(url || "") : publicHttpUrl(url);
    if (!safe) return { error: "blocked: non-public http(s) URL" };
    if (!allowPrivate) {
      // Friendly early refusal for the entry URL (the gate would cancel it
      // anyway, but "blocked: …" beats a generic net::ERR for callers).
      try {
        await assertPublicResolved(new URL(safe).hostname, lookup);
      } catch (err) {
        return { error: String((err && err.message) || err) };
      }
    }
    const mailto = (getKey && getKey("mailto")) || "flux";
    const UA = `Flux/0.1 (PDF acquisition; mailto:${mailto})`;
    try {
      const accept = mode === "json" ? "application/json" : mode === "text" ? "text/*,*/*" : "application/pdf,*/*";
      // Time-boxed: a hung publisher server must not stall a bulk run forever (bytes gets
      // longer for big PDFs on slow links; metadata calls are small and quick).
      const timeoutMs = mode === "bytes" ? (timeouts.bytes ?? 120_000) : (timeouts.meta ?? 30_000);
      const res = await getSession().fetch(safe, {
        redirect: "follow",
        credentials: "include", // the whole point: carry the partition's cookie jar
        headers: { "User-Agent": UA, Accept: accept },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) return { error: `HTTP ${res.status}`, status: res.status };
      if (mode === "json") return { json: await res.json() };
      if (mode === "text") return { text: await res.text() };
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > 80 * 1024 * 1024) return { error: "too large" };
      return {
        bytesB64: buf.toString("base64"),
        contentType: res.headers.get("content-type") || "",
        finalUrl: res.url || safe,
      };
    } catch (err) {
      const msg = String((err && err.message) || err);
      // The SSRF gate cancels a bad hop mid-chain — surface it as a block.
      if (/ERR_BLOCKED_BY_CLIENT/.test(msg)) return { error: "blocked: redirect to a non-public address" };
      return { error: msg };
    }
  };
}

module.exports = { createNetGet, publicHttpUrl, isPrivateAddress, assertPublicResolved, NET_PARTITION };
