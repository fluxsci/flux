"use strict";
// Node-only public HTTP transport. The resolver used by the connection itself
// vets every address; TLS still uses the original host/SNI. Chromium's publisher
// cookie partition deliberately retains its separately documented policy.
const http = require("node:http");
const https = require("node:https");
const dns = require("node:dns");
const { Readable } = require("node:stream");
const { publicHttpUrl, isPrivateAddress } = require("./netFetch.cjs");
function publicLookup(hostname, options, callback) {
  dns.lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
    if (error) return callback(error);
    if (!addresses.length || addresses.some(a => isPrivateAddress(a.address))) return callback(new Error("blocked: destination resolves to a non-public address"));
    if (options?.all) return callback(null, addresses);
    callback(null, addresses[0].address, addresses[0].family);
  });
}
const originBackoff = new Map();
function retryAfterMs(value, now = Date.now()) {
  if (!value) return 0;
  const seconds = Number(value);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
  return Number.isFinite(ms) ? Math.min(30000, Math.max(0, ms)) : 0;
}
async function publicFetch(input, init = {}) {
  const deadline = AbortSignal.timeout(120_000);
  const signal = init.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
  let current = String(input), previousOrigin = null;
  const headers = new Headers(init.headers || {});
  // Identity avoids unbounded compressed expansion; all consumers stream under a
  // mode-specific cap. Unlike fetch, node:http does not transparently decompress.
  headers.set("accept-encoding", "identity");
  for (let hop = 0; ; hop++) {
    const safe = publicHttpUrl(current);
    if (!safe) throw new Error("blocked: non-public http(s) URL");
    const url = new URL(safe);
    const delay = (originBackoff.get(url.origin) || 0) - Date.now();
    if (delay > 0) await require("node:timers/promises").setTimeout(delay, undefined, {signal});
    originBackoff.delete(url.origin);
    if (previousOrigin && previousOrigin !== url.origin) { headers.delete("authorization"); headers.delete("cookie"); headers.delete("x-api-key"); }
    const response = await new Promise((resolve, reject) => {
      const req = (url.protocol === "https:" ? https : http).request(url, {
        method: init.method || "GET", headers: Object.fromEntries(headers), lookup: publicLookup, signal,
      }, message => {
        try {
        const status = message.statusCode || 500;
        if (status < 200 || status > 599) { message.destroy(); reject(new Error("Invalid HTTP response status")); return; }
        const body = [101, 204, 205, 304].includes(status) || init.method === "HEAD" ? null : Readable.toWeb(message);
        const res = new Response(body, { status, statusText: message.statusMessage, headers: new Headers(Object.entries(message.headers).flatMap(([key, value]) => value == null ? [] : [[key, Array.isArray(value) ? value.join(", ") : value]])) });
        Object.defineProperty(res, "url", {value: safe}); resolve(res);
        } catch (error) { message.destroy(); reject(error); }
      });
      req.once("error", reject);
      if (init.body != null) req.write(init.body);
      req.end();
    });
    if (response.status === 429 || response.status === 503) {
      const delay = retryAfterMs(response.headers.get("retry-after"));
      if (delay) originBackoff.set(url.origin,Date.now()+delay);
    }
    const location = response.headers.get("location");
    if (response.status < 300 || response.status >= 400 || !location || init.redirect === "manual") return response;
    await response.body?.cancel();
    if (init.redirect === "error") throw new Error("Unexpected redirect");
    if (hop >= 5) throw new Error("Too many redirects");
    previousOrigin = url.origin; current = new URL(location, safe).href;
  }
}
module.exports = { publicFetch, publicLookup, retryAfterMs };
