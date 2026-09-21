// Gate for the Cell Press → cell.com hop: the REAL capture engine must retrieve a complete
// PDF for a Cell Press DOI whose doi.org route lands on the ScienceDirect anti-bot block.
// Helper behavior runs separately in verify-cellpress-helpers.cjs without Electron/network.
// Explicit opt-in: FLUX_ALLOW_TEST_NETWORK=1 FLUX_TEST_EZPROXY_PREFIX=https://...
// Run through scripts/run-verifies.mjs with a private display and disposable HOME.
const { app, session, BrowserWindow } = require("electron");
const { liveProxyFixture } = require("./lib/liveProxyFixture.cjs");
const fixture = liveProxyFixture();
if (fixture.missing.length) {
  console.error("BLOCKED: " + fixture.missing.join("; "));
  app.exit(2);
}
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const engineMod = require("../electron/proxyFetch.cjs");
const { createProxyEngine } = engineMod;

const PROXY_PARTITION = "cellpress-live-fixture";
const PREFIX = fixture.prefix;
const ezproxyPrefix = () => PREFIX;
const proxiedUrl = (t) => PREFIX + String(t || "");
function isProxyLoginUrl(u) {
  try {
    const h = new URL(u).hostname;
    if (/^login\./i.test(h)) return true;
    if (/(^|\.)duosecurity\.com$/i.test(h)) return true;
    return /\/(login|connect|idp|saml|sso|shibboleth)\b|[?&]url=menu\b/i.test(u);
  } catch {
    return false;
  }
}
const isPdf = (b) => b && b.length > 4 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46;

let failures = 0;
const ok = (c, n, d = "") => {
  console.log(`${c ? "✓" : "✗"} ${n}${c || !d ? "" : ` — ${d}`}`);
  if (!c) failures++;
};

let engine;
const watchdog=setTimeout(()=>{console.error("FAIL: Cell Press live probe exceeded its110s deadline");engine?.dispose();app.exit(1);},110000);
app.whenReady().then(async () => {
  // --- live capture through the real engine ---
  const t0 = Date.now();
  const trace = process.env.FLUX_PROXY_DEBUG ? (m) => console.error(`  [${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`) : undefined;
  engine = createProxyEngine({ session, BrowserWindow, ezproxyPrefix, proxiedUrl, isProxyLoginUrl, PROXY_PARTITION, path, fs, os, log: trace });

  const cases = [
    ["Neuron (Cell Press via SD block)", "10.1016/j.neuron.2021.06.030", true],
  ];
  for (const [label, doi, expect] of cases) {
    const r = await engine.capturePdfViaBrowser({ target: "https://doi.org/" + doi, signal: AbortSignal.timeout(100000) });
    const buf = r && r.bytesB64 ? Buffer.from(r.bytesB64, "base64") : null;
    const got = !!(buf && isPdf(buf) && buf.length > 100 * 1024);
    ok(
      got === expect,
      `${label}: ${got ? (buf.length / 1024 / 1024).toFixed(2) + " MB via=" + r.via : (r && r.reason) + "/" + (r && r.error)}`,
      got ? "" : JSON.stringify(r && r.diag),
    );
  }
  engine.dispose();
  await new Promise((res) => setTimeout(res, 300));

  console.log(failures ? `\nCELLPRESS VERIFY: ${failures} FAILED` : "\nCELLPRESS VERIFY: PASS");
  clearTimeout(watchdog);
  app.exit(failures ? 1 : 0);
}).catch(error=>{
  clearTimeout(watchdog);engine?.dispose();
  console.error("FAIL: Cell Press live probe: " + String(error?.message || error));
  app.exit(1);
});
