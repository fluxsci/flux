#!/usr/bin/env -S npx tsx
// WS-9.2 (fortify plan) — SSRF hardening, the hermetic half:
//   · isPrivateAddress: v4/v6 edge table (loopback, RFC1918, link-local/
//     metadata, CGNAT, ULA, v4-mapped, zone ids, unspecified);
//   · assertPublicResolved: rejects when ANY resolved address is private
//     (rebinding), literal IPs classified without DNS — injected lookups only;
//   · resolveToDoi's manual hop loop: follows validated chains, blocks a
//     private Location, caps hops — stub fetches;
//   · undici (Node/Electron-main global fetch) really does expose a readable
//     3xx + Location under redirect:"manual" — probed on a local server (the
//     assumption the hop loop stands on).
// The Electron-session half (webRequest gate, cookie jar across hops) lives in
// verify-netget.cjs (electron tier).
//   npx tsx scripts/verify-ssrf-ranges.ts

import * as http from "node:http";
import { createRequire } from "node:module";

const require2 = createRequire(import.meta.url);
const { isPrivateAddress, assertPublicResolved, publicHttpUrl } = require2("../electron/netFetch.cjs");
const { resolveToDoi } = require2("../electron/resolveDoi.cjs");

let failures = 0;
const ok = (m: string) => console.log("  ok:", m);
const fail = (m: string) => {
  console.error("  ✗ FAIL:", m);
  failures++;
};
const assert = (c: unknown, m: string) => (c ? ok(m) : fail(m));

// ---- 1. the range classifier ---------------------------------------------------
const PRIVATE = [
  "127.0.0.1", "127.255.255.255", "10.0.0.1", "10.255.255.255",
  "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254",
  "0.0.0.0", "100.64.0.1", "100.127.255.255",
  "::1", "::", "fe80::1", "fe80::1%eth0", "fc00::1", "fd12:3456::1",
  "::ffff:127.0.0.1", "::ffff:10.0.0.5", "::ffff:192.168.0.9",
  "[::1]", "not-an-ip", // non-IP input ⇒ treated private (callers resolve first)
];
const PUBLIC = [
  "8.8.8.8", "1.1.1.1", "93.184.216.34", "172.15.255.255", "172.32.0.1",
  "100.63.255.255", "100.128.0.1", "11.0.0.1", "128.0.0.1", "192.167.1.1", "192.169.1.1",
  "2606:4700:4700::1111", "2001:4860:4860::8888", "fe00::1", "::ffff:8.8.8.8", "[2606:4700:4700::1111]",
];
{
  let bad = 0;
  for (const a of PRIVATE) if (!isPrivateAddress(a)) { fail(`classifier: ${a} should be PRIVATE`); bad++; }
  for (const a of PUBLIC) if (isPrivateAddress(a)) { fail(`classifier: ${a} should be PUBLIC`); bad++; }
  if (!bad) ok(`classifier: ${PRIVATE.length} private + ${PUBLIC.length} public edge addresses all correct`);
}

// ---- 2. assertPublicResolved (injected lookups — no real DNS) --------------------
const lk = (addrs: string[]) => async () => addrs.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
const throws = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
    return null;
  } catch (e) {
    return String(e);
  }
};
{
  assert((await throws(() => assertPublicResolved("meta.example", lk(["169.254.169.254"])))) !== null,
    "hostname resolving to the metadata IP is rejected");
  assert((await throws(() => assertPublicResolved("rebind.example", lk(["93.184.216.34", "10.0.0.7"])))) !== null,
    "MIXED resolution (one public + one private) is rejected — the rebinding case");
  assert((await throws(() => assertPublicResolved("ok.example", lk(["93.184.216.34", "2606:4700::1"])))) === null,
    "all-public resolution passes");
  assert((await throws(() => assertPublicResolved("empty.example", lk([])))) !== null, "non-resolving hostname is rejected");
  assert((await throws(() => assertPublicResolved("127.0.0.1"))) !== null, "literal private IP rejected WITHOUT DNS");
  assert((await throws(() => assertPublicResolved("[::1]"))) !== null, "bracketed v6 loopback literal rejected");
  assert((await throws(() => assertPublicResolved("8.8.8.8"))) === null, "literal public IP passes without DNS");
}

// ---- 3. resolveToDoi hop loop (stub fetches) -------------------------------------
const okPublic = async () => {};
const page = (doi: string) => `<html><head><meta name="citation_doi" content="${doi}"></head></html>`;
const resp = (status: number, headers: Record<string, string>, body = "") => ({
  ok: status >= 200 && status < 300,
  status,
  url: "",
  headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
  text: async () => body,
});
{
  // 2-hop public chain → scrapes the DOI at the end.
  const seen: string[] = [];
  const chain: Record<string, ReturnType<typeof resp>> = {
    "https://pub.example/a": resp(302, { location: "https://pub.example/b" }),
    "https://pub.example/b": resp(301, { location: "https://final.example/paper" }),
    "https://final.example/paper": resp(200, {}, page("10.1234/hop.ok")),
  };
  const fetchStub = async (u: string) => {
    seen.push(u);
    return chain[u] ?? resp(404, {});
  };
  const r = await resolveToDoi("https://pub.example/a", fetchStub, { assertPublic: okPublic });
  assert(r.doi === "10.1234/hop.ok" && seen.length === 3, `manual hop loop follows a validated chain (${seen.length} hops → ${r.doi})`);

  // Redirect to a private literal → blocked, the private URL NEVER fetched.
  const seen2: string[] = [];
  const evil = async (u: string) => {
    seen2.push(u);
    return resp(302, { location: "http://169.254.169.254/latest/meta-data/" });
  };
  const r2 = await resolveToDoi("https://pub.example/a", evil, { assertPublic: okPublic });
  assert(!!r2.error && /public/i.test(r2.error), `redirect to the metadata IP is refused (${r2.error})`);
  assert(seen2.length === 1 && !seen2.some((u) => u.includes("169.254")), "the private hop was never fetched");

  // Redirect to a host whose DNS resolves private → blocked by assertPublic.
  const gate = async (hostname: string) => {
    if (hostname === "rebind.example") throw new Error("blocked: resolves private");
  };
  const r3 = await resolveToDoi(
    "https://pub.example/a",
    async () => resp(302, { location: "https://rebind.example/x" }),
    { assertPublic: gate },
  );
  assert(!!r3.error && /blocked/.test(r3.error), "redirect to a private-RESOLVING host is refused (rebinding)");

  // Hop cap.
  const loop = async (u: string) => resp(302, { location: u.endsWith("z") ? u : u + "z" });
  const r4 = await resolveToDoi("https://pub.example/a", loop, { assertPublic: okPublic });
  assert(!!r4.error && /redirect/i.test(r4.error), `endless chain hits the hop cap (${r4.error})`);
}

// ---- 4. undici really exposes a readable 3xx under redirect:"manual" -------------
{
  const server = http.createServer((req, res) => {
    if (req.url === "/r") {
      res.statusCode = 302;
      res.setHeader("Location", "/final");
      return res.end();
    }
    res.end("FINAL");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  const res = await fetch(`http://127.0.0.1:${port}/r`, { redirect: "manual" });
  assert(
    res.status === 302 && res.headers.get("location") === "/final",
    `undici manual redirect: status ${res.status}, location readable — the hop loop's foundation`,
  );
  server.close();
}

// ---- 5. publicHttpUrl literal guard unchanged ------------------------------------
assert(publicHttpUrl("http://169.254.169.254/x") === null, "literal metadata URL still blocked at entry");
assert(publicHttpUrl("https://example.com/a?b=c") !== null, "public URL still passes");
assert(publicHttpUrl("file:///etc/passwd") === null, "non-http scheme still blocked");

console.log(failures ? `\nSSRF RANGES: FAIL (${failures})` : "\nSSRF RANGES: PASS");
process.exit(failures ? 1 : 0);
