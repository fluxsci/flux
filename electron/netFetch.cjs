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

/**
 * Build the netGet(url, mode) handler. mode ∈ json | text | bytes.
 * deps: { session } — Electron's session module; { getKey } — secrets lookup (mailto).
 * Harness-only overrides: { allowPrivate } (target 127.0.0.1), { partition },
 * { timeouts: { bytes, meta } }.
 */
function createNetGet({ session, getKey, allowPrivate = false, partition = NET_PARTITION, timeouts = {} }) {
  return async function netGet(url, mode = "bytes") {
    const safe = allowPrivate ? String(url || "") : publicHttpUrl(url);
    if (!safe) return { error: "blocked: non-public http(s) URL" };
    const mailto = (getKey && getKey("mailto")) || "flux";
    const UA = `Flux/0.1 (PDF acquisition; mailto:${mailto})`;
    try {
      const accept = mode === "json" ? "application/json" : mode === "text" ? "text/*,*/*" : "application/pdf,*/*";
      // Time-boxed: a hung publisher server must not stall a bulk run forever (bytes gets
      // longer for big PDFs on slow links; metadata calls are small and quick).
      const timeoutMs = mode === "bytes" ? (timeouts.bytes ?? 120_000) : (timeouts.meta ?? 30_000);
      const res = await session.fromPartition(partition).fetch(safe, {
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
      return { error: String((err && err.message) || err) };
    }
  };
}

module.exports = { createNetGet, publicHttpUrl, NET_PARTITION };
