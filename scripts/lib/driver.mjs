// Reusable headless-Chrome driver for Flux's Live Visual Verification Protocol
// (notes/Flux_Improvement_Plan.md §1). Surface A = in-browser dev server (no Electron).
//
// Usage from a scenario script (run from repo root so node_modules resolves):
//   import { launch, gotoApp, clickNew, shot, errors, dispatchEditor } from "./lib/driver.mjs";
//   const { browser, page } = await launch();
//   await gotoApp(page);            // navigate + settle
//   await clickNew(page);           // enter in-memory demo workspace
//   await shot(page, "02-editor");  // screenshot -> OUT/02-editor.png
//   console.log(JSON.stringify({ errs: errors(page) }, null, 2));
//   await browser.close();
//
// Screenshot dir defaults to the session scratchpad; override with FLUX_OUT.

import puppeteer from "puppeteer-core";

export const CHROME = process.env.FLUX_CHROME || "/usr/bin/google-chrome";
export const APP_URL = process.env.FLUX_URL || "http://127.0.0.1:1420/";
export const OUT =
  process.env.FLUX_OUT ||
  "/tmp/claude-1329238735/-home-driessen2-flux/e94eddd8-b1a7-4307-9148-adb4ab3daba6/scratchpad/out";

const _errs = new WeakMap();

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function launch({ width = 1440, height = 900 } = {}) {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    args: ["--no-sandbox", `--window-size=${width},${height}`, "--force-device-scale-factor=1"],
    defaultViewport: { width, height },
  });
  const page = await browser.newPage();
  const errs = [];
  _errs.set(page, errs);
  page.on("console", (m) => m.type() === "error" && errs.push(m.text()));
  page.on("pageerror", (e) => errs.push("PAGEERR " + e.message));
  return { browser, page };
}

export function errors(page) {
  return _errs.get(page) || [];
}

// Navigate to the app and let intro animations settle. Retries while the dev
// server is still warming up.
export async function gotoApp(page, { settle = 1200, url = APP_URL } = {}) {
  let lastErr;
  for (let i = 0; i < 30; i++) {
    try {
      await page.goto(url, { waitUntil: "networkidle0", timeout: 8000 });
      await sleep(settle);
      return;
    } catch (e) {
      lastErr = e;
      await sleep(500);
    }
  }
  throw lastErr;
}

// Click the Home "New" button -> enters the in-memory demo workspace.
export async function clickNew(page, { settle = 1500 } = {}) {
  const clicked = await page.evaluate(() => {
    const el = [...document.querySelectorAll("button,a,[role=button]")].find((e) =>
      /^\s*new\b/i.test(e.textContent || "")
    );
    if (el) {
      el.click();
      return true;
    }
    return false;
  });
  await sleep(settle);
  return clicked;
}

// Click an ActivityRail mode button by its aria-label ("Figure" | "Paper" | "Slide").
export async function clickMode(page, label, { settle = 900 } = {}) {
  const ok = await page.evaluate((lbl) => {
    const b = [...document.querySelectorAll("button[aria-label]")].find(
      (e) => e.getAttribute("aria-label") === lbl
    );
    if (b) {
      b.click();
      return true;
    }
    return false;
  }, label);
  await sleep(settle);
  return ok;
}

// Send a single key to the focused window (for app-level hotkeys like F).
export async function pressKey(page, key) {
  await page.keyboard.press(key);
  await sleep(250);
}

export async function shot(page, name) {
  const path = `${OUT}/${name}.png`;
  await page.screenshot({ path });
  return path;
}

// Run a function in the page against the live CodeMirror view (window.__fluxView).
// `fn` receives (view, arg) inside the page.
export async function dispatchEditor(page, fn, arg) {
  return page.evaluate(
    (src, a) => {
      const v = window.__fluxView;
      if (!v) throw new Error("window.__fluxView not present");
      // eslint-disable-next-line no-new-func
      return new Function("view", "arg", `(${src})(view, arg)`)(v, a);
    },
    fn.toString(),
    arg
  );
}

// Replace the whole editor doc.
export async function setDoc(page, text) {
  return dispatchEditor(
    page,
    (view, t) => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: t } }),
    text
  );
}

// Profile a hot path: run `action()` while tracing, return frame stats.
// `action` is a node-side async fn receiving the page.
export async function profile(page, action, { name = "trace" } = {}) {
  const tracePath = `${OUT}/${name}.json`;
  await page.tracing.start({ path: tracePath, screenshots: false, categories: ["devtools.timeline"] });
  await action(page);
  await page.tracing.stop();
  return tracePath;
}
