// Real-Electron smoke gate (npm run test:electron — opt-in; needs a display).
// Builds the renderer, launches the actual app on an isolated userData dir
// with a real disk fixture (LT_OPEN), connects over CDP, and demands POSITIVE
// boot evidence — window title, aligned cell count, and an ltfile://thumb/…
// image that actually painted (naturalWidth > 0). This proves the whole
// scan → thumbnail-cache → privileged-protocol path end to end; a hung
// compositor or a silent main-process crash cannot look like success.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { makeFixture, DEFAULT_SPEC } from "./make-fixture.mjs";
import { check, section, finish, waitFor, sleep } from "./lib/harness.mjs";

const require = createRequire(import.meta.url);
const puppeteer = require("puppeteer-core");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 9345;
const base = mkdtempSync(path.join(os.tmpdir(), "lighttable-electron-"));

const children = [];
const browsers = [];
async function cleanup() {
  for (const b of browsers) {
    try {
      b.disconnect();
    } catch {}
  }
  for (const c of children) {
    if (c && c.pid) {
      try {
        process.kill(-c.pid, "SIGTERM");
      } catch {}
    }
  }
  await sleep(300);
  for (const c of children) {
    if (c && c.pid) {
      try {
        process.kill(-c.pid, "SIGKILL");
      } catch {}
    }
  }
  rmSync(base, { recursive: true, force: true });
}

function launchApp(openPath, userData, port) {
  const c = spawn(
    path.join(ROOT, "node_modules", ".bin", "electron"),
    [".", `--remote-debugging-port=${port}`, "--no-sandbox", "--ozone-platform=x11"],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        DISPLAY: process.env.DISPLAY || ":0",
        LT_OPEN: openPath,
        LT_USER_DATA: userData,
      },
      stdio: "ignore",
      detached: true,
    }
  );
  children.push(c);
  return c;
}

async function connectApp(port) {
  const cdp = `http://127.0.0.1:${port}`;
  await waitFor(
    async () => {
      try {
        const r = await fetch(`${cdp}/json/version`, { signal: AbortSignal.timeout(800) });
        return r.ok;
      } catch {
        return false;
      }
    },
    { timeout: 30000, interval: 400, desc: `Electron CDP endpoint :${port}` }
  );
  const b = await puppeteer.connect({ browserURL: cdp, defaultViewport: null });
  browsers.push(b);
  const page = await waitFor(
    async () => (await b.pages()).find((p) => p.url().startsWith("file://") && p.url().includes("index.html")),
    { timeout: 20000, interval: 300, desc: "app page (file://…/dist/index.html)" }
  );
  return page;
}
const hardTimeout = setTimeout(async () => {
  console.log("  ✗ verify-electron timed out (180s) — NO positive boot evidence");
  await cleanup();
  process.exit(2);
}, 180000);

// ---- build + fixture ---------------------------------------------------------
section("build + fixture");
const build = spawnSync(path.join(ROOT, "node_modules", ".bin", "vite"), ["build"], {
  cwd: ROOT,
  stdio: "pipe",
  encoding: "utf8",
});
check("vite build succeeds", build.status === 0, (build.stderr || "").slice(-300));
// The collection sits beside a sister collection so the switcher is testable.
const fixture = await makeFixture(path.join(base, "collections", "fixture"), DEFAULT_SPEC);
await makeFixture(path.join(base, "collections", "fixture2"), {
  sets: { A: ["item_001.png", "item_002.png", "item_003.png"] },
});
console.log(`  fixture: ${fixture}`);

// ---- launch the real app -----------------------------------------------------
section("boot evidence");
launchApp(fixture, path.join(base, "userdata"), PORT);
const page = await connectApp(PORT);

const consoleErrors = [];
page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
page.on("pageerror", (e) => consoleErrors.push(`PAGEERR ${e.message}`));

// The LT_OPEN manifest is pushed after did-finish-load — wait for the grid.
await waitFor(async () => (await page.$$("[data-cell]")).length === 6, { timeout: 15000, desc: "6 aligned cells" });
const title = await page.title();
console.log(`  ##BOOT## windows=1 title="${title}" cells=6`);
check("window booted with the app document (title carries Lighttable)", title.includes("Lighttable"));
check("collection name in the title", title.includes("fixture"));
check("grid shows the aligned union (6 cells for 5+6 files)", (await page.$$eval("[data-cell]", (els) => els.length)) === 6);

section("real ltfile:// delivery");
await waitFor(
  async () =>
    (await page.$$eval("[data-cell] img", (els) => els.filter((i) => i.src.startsWith("ltfile://thumb/") && i.complete && i.naturalWidth > 0).length)) === 6,
  { timeout: 15000, desc: "6 ltfile thumbs painted" }
);
check("all 6 thumbnails stream over ltfile://thumb/ and PAINT", true);
const natural = await page.$eval("[data-cell] img", (i) => ({ w: i.naturalWidth, h: i.naturalHeight }));
check("thumb decoded at a real raster size", natural.w > 0 && natural.h > 0, JSON.stringify(natural));

section("flip-book + detail against the real backend");
await page.keyboard.press("2");
await waitFor(async () => (await page.$$eval("[data-cell][data-missing]", (els) => els.length)) === 1, { timeout: 5000, desc: "placeholder in set B" });
check("set B shows the missing-item placeholder (item_004)", (await page.$eval("[data-cell][data-missing]", (e) => e.dataset.key)) === "item_004");
await page.keyboard.press("1");
await page.keyboard.press("Enter");
await waitFor(async () => (await page.$$("[data-detail]")).length === 1, { timeout: 5000, desc: "detail open" });
await waitFor(
  async () => await page.$$eval("[data-detail] img", (els) => els.some((i) => i.src.startsWith("ltfile://full/") && i.complete && i.naturalWidth > 0)),
  { timeout: 8000, desc: "full-res ltfile image painted" }
);
check("Detail paints the full-res original over ltfile://full/", true);
await page.keyboard.press("Escape");
await waitFor(async () => (await page.$$("[data-detail]")).length === 0, { timeout: 5000, desc: "detail closed" });
check("Esc returns to the grid", true);

section("aspect-aware layout (real 640×400 sources)");
await waitFor(
  async () => {
    const r = await page.$eval("[data-cell] .surface", (e) => e.clientHeight / e.clientWidth);
    return Math.abs(r - 400 / 640) < 0.06;
  },
  { timeout: 10000, desc: "cell aspect settles to the measured image aspect" }
);
check("grid cells adopt the measured 640×400 aspect (no wasted letterbox)", true);

section("compare view against the real backend");
await page.evaluate(() => {
  document
    .querySelector('[data-cell][data-key="item_002"]')
    .dispatchEvent(new MouseEvent("click", { ctrlKey: true, bubbles: true }));
});
await waitFor(async () => (await page.$$("[data-compare]")).length === 1, { timeout: 5000, desc: "compare open" });
check(
  "Ctrl+click opens Compare with one tile per set",
  (await page.$$eval("[data-compare-tile]", (els) => els.map((e) => e.dataset.set))).join() === "A,B"
);
await waitFor(
  async () =>
    await page.$$eval("[data-compare-tile] img", (els) => els.length === 2 && els.every((i) => i.src.startsWith("ltfile://") && i.complete && i.naturalWidth > 0)),
  { timeout: 10000, desc: "compare tiles painted over ltfile://" }
);
check("both tiles painted from the real backend", true);
await page.keyboard.press("Escape");
await waitFor(async () => (await page.$$("[data-compare]")).length === 0, { timeout: 5000, desc: "compare closed" });
check("Esc leaves Compare", true);

section("sister-folder switcher against the real fs");
await page.evaluate(() => document.querySelector(".coll-name").click());
await waitFor(async () => (await page.$$("[data-sisters]")).length === 1, { timeout: 5000, desc: "sister menu" });
check(
  "menu lists the sibling collections",
  (await page.$$eval("[data-sisters] button", (els) => els.map((e) => e.textContent))).join() === "fixture,fixture2"
);
await page.evaluate(() => {
  [...document.querySelectorAll("[data-sisters] button")].find((b) => b.textContent === "fixture2").click();
});
await waitFor(async () => (await page.title()).startsWith("fixture2"), { timeout: 8000, desc: "sister collection opened" });
check("clicking a sister opens it (title + cells swap)", (await page.$$eval("[data-cell]", (els) => els.length)) === 3);

section("annotations against the real fs");
// Create a class in fixture2, mark + note item_001, then prove the JSON file
// on disk — the whole preload → IPC → annotations.cjs → atomic-write path.
const annotFile = path.join(base, "collections", "fixture2", ".lt-annotations", "eyeball.json");
await page.evaluate(() => document.querySelector("[data-annot]").click());
await waitFor(async () => (await page.$$("[data-annot-new]")).length === 1, { timeout: 5000, desc: "annot menu" });
await page.evaluate(() => document.querySelector("[data-annot-new]").click());
await waitFor(async () => (await page.$$("[data-annot-input]")).length === 1, { timeout: 5000, desc: "name input" });
await page.type("[data-annot-input]", "eyeball");
await page.keyboard.press("Enter");
await waitFor(async () => existsSync(annotFile), { timeout: 5000, desc: "class file on disk" });
check("creating a class writes a real file", true);
check("top bar shows the class", (await page.$eval("[data-annot]", (e) => e.textContent)).includes("eyeball"));
await page.keyboard.press("v");
await waitFor(async () => (await page.$eval("[data-cell].selected", (e) => e.dataset.mark)) === "valid", { timeout: 5000, desc: "valid outline" });
await page.keyboard.press("n");
await waitFor(async () => (await page.$$("[data-notes-editor] textarea")).length === 1, { timeout: 5000, desc: "notes editor" });
await page.type("[data-notes-editor] textarea", "blurry axis");
await page.keyboard.press("Escape");
await waitFor(async () => (await page.$$("[data-notes-editor]")).length === 0, { timeout: 5000, desc: "notes closed" });
check("notes star on the caption", (await page.$("[data-cell].selected .star")) !== null);
// Switching collection flushes the class; switching back auto-reopens it.
await page.evaluate(() => document.querySelector(".coll-name").click());
await waitFor(async () => (await page.$$("[data-sisters]")).length === 1, { timeout: 5000, desc: "sister menu" });
await page.evaluate(() => {
  [...document.querySelectorAll("[data-sisters] button")].find((b) => b.textContent === "fixture").click();
});
await waitFor(async () => (await page.title()) === "fixture — Lighttable", { timeout: 8000, desc: "switched away" });
const onDisk = JSON.parse(readFileSync(annotFile, "utf8"));
check(
  "marks + notes persisted to the class file",
  onDisk.items.item_001?.mark === "valid" && onDisk.items.item_001?.notes === "blurry axis",
  JSON.stringify(onDisk.items)
);
await page.evaluate(() => document.querySelector(".coll-name").click());
await waitFor(async () => (await page.$$("[data-sisters]")).length === 1, { timeout: 5000, desc: "sister menu again" });
await page.evaluate(() => {
  [...document.querySelectorAll("[data-sisters] button")].find((b) => b.textContent === "fixture2").click();
});
await waitFor(async () => (await page.title()).startsWith("fixture2"), { timeout: 8000, desc: "switched back" });
await waitFor(async () => (await page.$eval("[data-annot]", (e) => e.textContent)).includes("eyeball"), { timeout: 5000, desc: "class auto-reopened" });
check("reopening the collection auto-opens the class with its marks", (await page.$eval('[data-cell][data-key="item_001"]', (e) => e.dataset.mark)) === "valid");

section("console contract");
check("renderer console is clean", consoleErrors.length === 0, consoleErrors.slice(0, 5).join(" | "));

// ---- burst survival (regression gate for the 2026-07-15 main-process SIGSEGV:
// @napi-rs/canvas in Electron main crashed under a thumbnail-generation burst;
// generation now runs in a crash-isolated utilityProcess) ----------------------
section("burst survival: fling over an 800-image set");
const bulk = await makeFixture(path.join(base, "bulk"), { big: { set: "all", count: 800 } });
launchApp(bulk, path.join(base, "userdata2"), PORT + 1);
const page2 = await connectApp(PORT + 1);
await waitFor(async () => (await page2.$$("[data-cell]")).length > 0, { timeout: 15000, desc: "bulk grid up" });
const fling = await page2.evaluate(async () => {
  const vp = document.querySelector("[data-grid]");
  for (let i = 0; i < 40; i++) {
    vp.scrollTop += 700;
    await new Promise((r) => requestAnimationFrame(r));
  }
  return { dom: document.querySelectorAll("[data-cell]").length, st: vp.scrollTop };
});
check(`DOM stays bounded during the fling (${fling.dom} cells)`, fling.dom < 200 && fling.st > 0);
await sleep(3000); // the crash landed while the generation queue drained
let alive = true;
try {
  await page2.evaluate(() => document.title);
} catch {
  alive = false;
}
check("app SURVIVES the thumbnail burst (no main-process crash)", alive);
if (alive) {
  await waitFor(
    async () =>
      (await page2.$$eval("[data-cell] img", (els) => els.filter((i) => i.src.startsWith("ltfile://thumb/") && i.complete && i.naturalWidth > 0).length)) > 10,
    { timeout: 20000, desc: "burst thumbs painting" }
  );
  check("thumbnails keep painting after the burst (worker healthy)", true);
}

clearTimeout(hardTimeout);
await cleanup();
finish("verify-electron");
