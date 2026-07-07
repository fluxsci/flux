// Gate for the Cell Press → cell.com hop: the REAL capture engine must retrieve a complete
// PDF for a Cell Press DOI whose doi.org route lands on the ScienceDirect anti-bot block.
// Also exercises the pure helpers (PII conversion, DOI classification, host rewrite).
//   Run: DISPLAY=:0 ./node_modules/.bin/electron scripts/verify-cellpress.cjs --no-sandbox
const { app, session, BrowserWindow } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const engineMod = require("../electron/proxyFetch.cjs");
const { createProxyEngine, hyphenatePii, isCellPressDoi, rewriteToProxyHost } = engineMod;

const PROXY_PARTITION = "persist:fluxproxy";
const PREFIX = String(JSON.parse(fs.readFileSync(path.join(os.homedir(), "FluxLib", "keys.json"), "utf8")).ezproxyPrefix || "").trim();
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

app.whenReady().then(async () => {
  // --- pure helpers (also importable/testable) ---
  ok(hyphenatePii("S0896627321004955") === "S0896-6273(21)00495-5", "PII compact→hyphenated");
  ok(hyphenatePii("not-a-pii") === null, "non-PII → null");
  ok(isCellPressDoi("10.1016/j.neuron.2021.06.030"), "Neuron DOI classified Cell Press");
  ok(isCellPressDoi("10.1016/j.cell.2026.05.048"), "Cell DOI classified Cell Press");
  ok(isCellPressDoi("10.1016/j.tins.2020.01.001"), "Trends in Neurosciences classified Cell Press");
  ok(!isCellPressDoi("10.1016/j.neuroimage.2019.116081"), "plain Elsevier (NeuroImage) NOT Cell Press");
  ok(!isCellPressDoi("10.1038/s41586-020-2649-2"), "Nature DOI NOT Cell Press");
  ok(
    rewriteToProxyHost("https://www.cell.com/action/showPdf?pii=X", "ezproxy.library.wisc.edu") ===
      "https://www-cell-com.ezproxy.library.wisc.edu/action/showPdf?pii=X",
    "host rewrite → proxied cell.com host",
  );

  if (!PREFIX) {
    console.log("\n(no ezproxyPrefix configured — skipping the live capture)");
    return app.exit(failures ? 1 : 0);
  }

  // --- live capture through the real engine ---
  const t0 = Date.now();
  const trace = process.env.FLUX_PROXY_DEBUG ? (m) => console.error(`  [${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`) : undefined;
  const engine = createProxyEngine({ session, BrowserWindow, ezproxyPrefix, proxiedUrl, isProxyLoginUrl, PROXY_PARTITION, path, fs, os, log: trace });

  const cases = [
    ["Neuron (Cell Press via SD block)", "10.1016/j.neuron.2021.06.030", true],
  ];
  for (const [label, doi, expect] of cases) {
    const r = await engine.capturePdfViaBrowser({ target: "https://doi.org/" + doi });
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
  app.exit(failures ? 1 : 0);
});
