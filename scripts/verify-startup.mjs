// W15 (SHL-4) gate: Home must be interactive on a small eager JS payload, with
// the five modes split into their own lazily-loaded chunks (not in the entry).
// Serves the REAL production build (vite preview) and measures the JS the browser
// pulls to render Home.
//   Prereq: npm run build.  Run: node scripts/verify-startup.mjs
import { spawn } from "node:child_process";
import puppeteer from "puppeteer-core";
import { CHROME } from "./lib/driver.mjs";

const PORT = 4319;
const URL = `http://127.0.0.1:${PORT}/`;
const BUDGET = 800 * 1024; // eager shell JS ceiling (raw bytes)
const MODE_RE = /(Paper|Figure|Slide|Reader|Library)Mode-/;
const WORKER_RE = /worker|pdf\.worker|pdfjs/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Serve the built dist/ exactly as shipped.
const preview = spawn("npx", ["vite", "preview", "--port", String(PORT), "--strictPort"], {
  cwd: process.cwd(),
  stdio: "ignore",
});
process.on("exit", () => preview.kill("SIGKILL"));

async function reachable() {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(URL);
      if (r.ok) return true;
    } catch {
      /* not up yet */
    }
    await sleep(150);
  }
  return false;
}

let browser;
try {
  if (!(await reachable())) throw new Error("vite preview did not come up");

  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage();

  // Record every JS response with its RAW (decompressed) byte length.
  const js = new Map(); // url → bytes
  page.on("response", async (res) => {
    const url = res.url();
    if (!url.endsWith(".js")) return;
    try {
      const buf = await res.buffer();
      js.set(url.split("/").pop(), buf.byteLength);
    } catch {
      /* redirect / no body */
    }
  });

  await page.goto(URL, { waitUntil: "load", timeout: 30000 });
  await page.waitForSelector(".wordmark", { timeout: 15000 }); // Home is interactive

  // WS-9.1: the SERVED production HTML must carry the STRICT CSP (no dev
  // loopback entries) — the cspStrict() vite plugin's output, end to end.
  const servedCsp = await page.evaluate(
    () => document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute("content") ?? "",
  );
  const cspStrictOk =
    servedCsp.includes("default-src 'self'") &&
    !servedCsp.includes("ws://localhost") &&
    !/script-src[^;]*'unsafe-inline'/.test(servedCsp);
  // Snapshot the eager set the instant Home is up (before idle-warm settles).
  const eagerFiles = [...js.entries()];

  const modeChunks = eagerFiles.filter(([f]) => MODE_RE.test(f));
  const workerChunks = eagerFiles.filter(([f]) => WORKER_RE.test(f));
  const shellBytes = eagerFiles
    .filter(([f]) => !MODE_RE.test(f) && !WORKER_RE.test(f))
    .reduce((a, [, b]) => a + b, 0);

  // Now confirm the modes really are separate, loadable chunks (warm them).
  await sleep(1500);
  const afterIdle = [...js.keys()];
  const modeChunkFiles = afterIdle.filter((f) => MODE_RE.test(f));

  const out = {
    shellEagerKB: +(shellBytes / 1024).toFixed(1),
    budgetKB: BUDGET / 1024,
    modeChunksEagerAtHome: modeChunks.map(([f]) => f),
    workerAtHome: workerChunks.map(([f]) => f),
    modeChunksSeenAfterWarm: modeChunkFiles,
    totalJsFiles: js.size,
    cspStrictOk,
  };
  console.log(JSON.stringify(out, null, 2));

  const pass =
    shellBytes < BUDGET && // eager shell under budget
    modeChunks.length === 0 && // no mode blocked Home
    workerChunks.length === 0 && // pdf worker never eager
    cspStrictOk; // WS-9.1: strict CSP served
  console.log(pass ? "\nW15 STARTUP VERIFY: PASS" : "\nW15 STARTUP VERIFY: FAIL");
  await browser.close();
  preview.kill("SIGKILL");
  process.exit(pass ? 0 : 1);
} catch (e) {
  console.error("W15 STARTUP VERIFY: ERROR", e?.message || e);
  await browser?.close().catch(() => {});
  preview.kill("SIGKILL");
  process.exit(1);
}
