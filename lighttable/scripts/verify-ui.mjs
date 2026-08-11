// UI gate: puppeteer-core (system Chrome) against the dev app on :1440 using
// the dev-only client-side mock (?mock=default / ?mock=big). Spawns vite ONLY
// if :1440 isn't already serving (and then kills what it spawned). Asserts
// behavior, coarse <100ms latency (one retry, like Flux's timing gates), the
// bounded-DOM structural budget, and a clean console.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { check, section, finish, waitFor, sleep } from "./lib/harness.mjs";

const require = createRequire(import.meta.url);
const puppeteer = require("puppeteer-core");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHROME = process.env.LT_CHROME || "/usr/bin/google-chrome";
const URL_BASE = "http://127.0.0.1:1440/";
const LATENCY_MS = 100;

let vite = null;
let browser = null;
async function cleanup() {
  try {
    if (browser) await browser.close();
  } catch {}
  if (vite && vite.pid) {
    try {
      process.kill(-vite.pid, "SIGTERM");
    } catch {}
  }
}
process.on("exit", () => {
  if (vite && vite.pid) {
    try {
      process.kill(-vite.pid, "SIGTERM");
    } catch {}
  }
});
const hardTimeout = setTimeout(async () => {
  console.log("  ✗ verify-ui timed out (120s)");
  await cleanup();
  process.exit(2);
}, 120000);

async function serving() {
  try {
    const r = await fetch(URL_BASE, { signal: AbortSignal.timeout(1000) });
    return r.ok;
  } catch {
    return false;
  }
}

// ---- dev server (reuse if already up — repo etiquette) -----------------------
if (!(await serving())) {
  vite = spawn(path.join(ROOT, "node_modules", ".bin", "vite"), [], {
    cwd: ROOT,
    stdio: "ignore",
    detached: true,
  });
  await waitFor(serving, { timeout: 30000, interval: 250, desc: "vite on :1440" });
}

// ---- browser -----------------------------------------------------------------
browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox", "--window-size=1440,900", "--force-device-scale-factor=1"],
  defaultViewport: { width: 1440, height: 900 },
});

const consoleErrors = [];
async function openPage(mock) {
  const page = await browser.newPage();
  page.on("console", (m) => m.type() === "error" && consoleErrors.push(`[${mock}] ${m.text()}`));
  page.on("pageerror", (e) => consoleErrors.push(`[${mock}] PAGEERR ${e.message}`));
  await page.goto(`${URL_BASE}?mock=${mock}`, { waitUntil: "networkidle0", timeout: 15000 });
  await page.waitForSelector("[data-cell]", { timeout: 8000 });
  return page;
}

const state = (page, prop) => page.evaluate((p) => window.__ltState[p], prop);

// Dispatch a key in-page and wait (rAF-polled) for `condFn` to become true;
// returns elapsed ms, or -1 on 1s timeout. Measures actual visible change.
function keyAndWait(page, key, condJs) {
  return page.evaluate(
    async (k, condSrc) => {
      const cond = new Function("return (" + condSrc + ")()");
      const t0 = performance.now();
      window.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
      for (;;) {
        if (cond()) return performance.now() - t0;
        if (performance.now() - t0 > 1000) return -1;
        await new Promise((r) => requestAnimationFrame(r));
      }
    },
    key,
    condJs
  );
}

// Timing gates get one retry (load blips happen; a real regression fails twice).
async function timed(page, name, run) {
  let ms = await run();
  if (ms < 0 || ms > LATENCY_MS) {
    await sleep(150);
    ms = await run();
  }
  check(`${name} (${ms < 0 ? "timeout" : Math.round(ms) + "ms"} < ${LATENCY_MS}ms)`, ms >= 0 && ms <= LATENCY_MS);
}

// =====================================================================
section("mock=default: grid renders + selection");
const p1 = await openPage("default");
check("grid renders 6 aligned cells for set A", (await p1.$$eval("[data-cell]", (els) => els.length)) === 6);
check("set A active", (await state(p1, "setName")) === "A");
check("one selected cell (first item)", (await p1.$$eval("[data-cell].selected", (els) => els.map((e) => e.dataset.key))).join() === "item_001");
await waitFor(async () => (await p1.$$eval("[data-cell] img", (els) => els.filter((i) => i.complete && i.naturalWidth > 0).length)) === 6, { desc: "all 6 thumbs painted" });
check("all 6 thumbnails painted", true);

await p1.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true })));
check("ArrowRight moves selection", (await state(p1, "selectedKey")) === "item_002");

section("mock=default: set switching (the flip-book)");
const srcBefore = await p1.$eval("[data-cell].selected img", (i) => i.src);
await timed(p1, "set switch '2' repaints the selected cell", () =>
  keyAndWait(p1, "2", `() => {
    const img = document.querySelector("[data-cell].selected img");
    return window.__ltState.setName === "B" && img && img.src !== ${JSON.stringify(srcBefore)} && img.complete;
  }`)
);
check("set B active after '2'", (await state(p1, "setName")) === "B");
check("selection survived the switch", (await state(p1, "selectedKey")) === "item_002");
check("missing item shows a placeholder in set B", (await p1.$$eval("[data-cell][data-missing]", (els) => els.map((e) => e.dataset.key))).join() === "item_004");
check("cell count unchanged (alignment holds)", (await p1.$$eval("[data-cell]", (els) => els.length)) === 6);
await p1.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })));
check("Tab wraps to the next set", (await state(p1, "setName")) === "A");

section("mock=default: column control");
await timed(p1, "column change ']' re-lays out", () =>
  keyAndWait(p1, "]", `() => window.__ltState.cols === 9`)
);
check("readout shows 9 cols", (await p1.$eval("[data-cols-readout]", (e) => e.textContent)) === "9 cols");
await p1.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "[", bubbles: true, cancelable: true })));
check("'[' back to 8 cols", (await state(p1, "cols")) === 8);

section("mock=default: captions toggle");
check("captions on by default", (await p1.$$eval("[data-cell] .caption", (els) => els.length)) === 6);
await p1.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "c", bubbles: true, cancelable: true })));
check("'c' hides captions", (await p1.$$eval("[data-cell] .caption", (els) => els.length)) === 0);
await p1.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "c", bubbles: true, cancelable: true })));
check("'c' again shows captions", (await p1.$$eval("[data-cell] .caption", (els) => els.length)) === 6);

section("mock=default: detail view");
await p1.evaluate(() => {
  window.__ltState; // touch
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
});
await p1.waitForSelector("[data-detail]", { timeout: 3000 });
check("Enter opens Detail", (await state(p1, "view")) === "detail");
check("detail caption shows the file", (await p1.$eval("[data-detail-file]", (e) => e.textContent)) === "item_002.png");
await p1.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true })));
check("→ next item", (await state(p1, "selectedKey")) === "item_003");
await p1.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true })));
check("↓ switches set on the SAME item", (await state(p1, "setName")) === "B" && (await state(p1, "selectedKey")) === "item_003");
await p1.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true })));
check("→ skips the missing item in set B (003 → 005)", (await state(p1, "selectedKey")) === "item_005");
await p1.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true })));
check("← skips back over it", (await state(p1, "selectedKey")) === "item_003");
await p1.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true, cancelable: true })));
check("digit '1' jumps to set 1 in detail", (await state(p1, "setName")) === "A");
await p1.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
await waitFor(async () => (await state(p1, "view")) === "grid", { desc: "back to grid" });
check("Esc returns to Grid with the viewed item selected", (await state(p1, "selectedKey")) === "item_003");
check("selected ring on the viewed item", (await p1.$eval("[data-cell].selected", (e) => e.dataset.key)) === "item_003");

section("mock=default: detail zoom/pan interaction model");
// The wheel is modal: Ctrl+scroll zooms at the cursor, plain scroll pans ↑↓,
// Shift+scroll pans ↔, and drag pans ONLY while Space is held (hand tool).
// Real mouse/keyboard input throughout — pointer capture retargets the pan's
// release click to the stage, which used to read as a backdrop click and
// kick the user back to the grid mid-pan (the regression this section pins).
await p1.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
await p1.waitForSelector("[data-detail]", { timeout: 3000 });
await waitFor(async () => await p1.$('[data-detail] img.fit:not([alt=""])'), { desc: "full-res image decoded" });
await p1.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
await p1.waitForSelector(".zoomwrap", { timeout: 3000 });
check("Enter toggles to 1:1 zoom", (await p1.$eval(".detail .zoom", (e) => e.textContent)) === "100%");
await p1.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "0", bubbles: true, cancelable: true })));
await waitFor(async () => !(await p1.$(".zoomwrap")), { desc: "'0' back to fit" });
const stageBox = await (await p1.$("[data-detail] .stage")).boundingBox();
const scx = stageBox.x + stageBox.width / 2;
const scy = stageBox.y + stageBox.height / 2;
const pan = () =>
  p1.$eval(".zoomwrap", (el) => {
    const m = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(el.style.transform);
    return { x: +m[1], y: +m[2] };
  });
await p1.mouse.move(scx, scy);
await p1.keyboard.down("Control");
await p1.mouse.wheel({ deltaY: -240 });
await p1.keyboard.up("Control");
await p1.waitForSelector(".zoomwrap", { timeout: 3000 });
const zoomPct = parseInt(await p1.$eval(".detail .zoom", (e) => e.textContent), 10);
check(`Ctrl+scroll zooms in from fit (${zoomPct}%)`, zoomPct > 110);
let before = await pan();
await p1.mouse.wheel({ deltaY: 120 });
await sleep(50);
let after = await pan();
check(`plain scroll pans ↑↓ (dy ${(after.y - before.y).toFixed(1)})`, Math.abs(after.y - before.y + 120) < 2 && Math.abs(after.x - before.x) < 2);
before = after;
await p1.keyboard.down("Shift");
await p1.mouse.wheel({ deltaY: 120 });
await p1.keyboard.up("Shift");
await sleep(50);
after = await pan();
check(`Shift+scroll pans ↔ (dx ${(after.x - before.x).toFixed(1)})`, Math.abs(after.x - before.x + 120) < 2 && Math.abs(after.y - before.y) < 2);
// Bare click-drag from the image out onto the backdrop: no pan, no close.
before = after;
await p1.mouse.move(scx, scy);
await p1.mouse.down();
await p1.mouse.move(scx + 300, scy + 200, { steps: 6 });
await p1.mouse.up();
await sleep(100);
after = await pan();
check("bare drag stays in detail (the original bug)", (await state(p1, "view")) === "detail");
check("bare drag does not pan", after.x === before.x && after.y === before.y);
// Hold Space + drag = pan.
await p1.keyboard.down("Space");
await p1.mouse.move(scx, scy);
await p1.mouse.down();
await p1.mouse.move(scx + 60, scy + 40, { steps: 6 });
await p1.mouse.up();
await p1.keyboard.up("Space");
await sleep(100);
const panned = await pan();
check("Space+drag stays in detail", (await state(p1, "view")) === "detail");
check(`Space+drag pans (+${(panned.x - after.x).toFixed(1)},+${(panned.y - after.y).toFixed(1)})`, Math.abs(panned.x - after.x - 60) < 2 && Math.abs(panned.y - after.y - 40) < 2);
// The pans moved the image center to (scx-60, scy-80) — click ON the image.
const imgBox = await (await p1.$(".zoomwrap")).boundingBox();
await p1.mouse.click(imgBox.x + imgBox.width / 2, imgBox.y + imgBox.height / 2);
await sleep(100);
check("clicking the zoomed image stays in detail", (await state(p1, "view")) === "detail");
await p1.mouse.click(stageBox.x + 40, stageBox.y + 40); // stationary backdrop click
await waitFor(async () => (await state(p1, "view")) === "grid", { desc: "backdrop click closes detail" });
check("stationary backdrop click still closes detail", true);

section("mock=default: search");
await timed(p1, "search keystroke filters", () =>
  p1.evaluate(async () => {
    const input = document.querySelector("input.search");
    const t0 = performance.now();
    input.value = "6";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    for (;;) {
      if (document.querySelectorAll("[data-cell]").length === 1) return performance.now() - t0;
      if (performance.now() - t0 > 1000) return -1;
      await new Promise((r) => requestAnimationFrame(r));
    }
  })
);
check("filtered grid shows only item_006", (await p1.$eval("[data-cell]", (e) => e.dataset.key)) === "item_006");
check("selection clamped into the filtered view", (await state(p1, "selectedKey")) === "item_006");
await p1.evaluate(() => {
  const input = document.querySelector("input.search");
  input.focus();
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
});
await waitFor(async () => (await p1.$$eval("[data-cell]", (els) => els.length)) === 6, { desc: "search cleared" });
check("Escape clears the search", (await state(p1, "search")) === "");
check("keymap inert while typing (digit stays in input)", await p1.evaluate(() => {
  const input = document.querySelector("input.search");
  input.focus();
  const before = window.__ltState.setName;
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "2", bubbles: true, cancelable: true }));
  input.blur();
  return window.__ltState.setName === before;
}));

// =====================================================================
section("mock=default: aspect-aware layout (128×96 mock images)");
await waitFor(async () => Math.abs((await state(p1, "layoutAspect")) - 4 / 3) < 0.02, {
  desc: "layout aspect settles to 4/3",
});
check("measured aspect drives the grid", true);
const gAspect = await p1.evaluate(() => window.__ltState.grid);
check(
  `cell height = width / aspect (${gAspect.cellH} vs ${Math.round(gAspect.cellPx * 0.75)})`,
  Math.abs(gAspect.cellH - gAspect.cellPx / (4 / 3)) <= 2
);

section("mock=default: gap steppers (⋯ menu)");
await p1.click(".overflow");
await p1.waitForSelector("[data-vgap]", { timeout: 3000 });
const rowH0 = (await p1.evaluate(() => window.__ltState.grid)).rowH;
await p1.evaluate(() => {
  document.querySelector('button[aria-label="Larger vertical gap"]').click();
});
await waitFor(async () => (await state(p1, "vGap")) === 10, { desc: "vGap stepped to 10" });
check("vertical gap steps +2", true);
check("menu stays open while stepping", (await p1.$("[data-vgap]")) !== null);
check("row height grew by the gap delta", (await p1.evaluate(() => window.__ltState.grid)).rowH === rowH0 + 2);
await p1.evaluate(() => {
  document.querySelector('button[aria-label="Larger horizontal gap"]').click();
});
await waitFor(async () => (await state(p1, "hGap")) === 10, { desc: "hGap stepped to 10" });
check("horizontal gap steps +2 (cells narrow)", (await p1.evaluate(() => window.__ltState.grid)).cellPx <= gAspect.cellPx);
await p1.evaluate(() => {
  document.querySelector('button[aria-label="Smaller vertical gap"]').click();
  document.querySelector('button[aria-label="Smaller horizontal gap"]').click();
});
await p1.keyboard.press("Escape");
await p1.click(".grid-viewport").catch(() => {});

section("mock=default: low column counts fill the cells");
// At 1 column the ~1400px cell exceeds the largest thumb bucket: the grid
// must request the ORIGINAL file (thumbPx 0) and the 128×96 mock image must
// stretch to fill the cell — a thumb parked at natural size in the middle of
// a huge cell was the bug.
const colsBefore = await state(p1, "cols");
await p1.evaluate(() => {
  while (window.__ltState.cols > 1)
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "[", bubbles: true, cancelable: true }));
});
await waitFor(async () => (await state(p1, "cols")) === 1, { desc: "cols -> 1" });
check("past the largest bucket the grid asks for the original (thumbPx 0)", (await p1.evaluate(() => window.__ltState.grid)).thumbPx === 0);
await waitFor(
  async () =>
    await p1.evaluate(() => {
      const img = document.querySelector("[data-cell] img");
      if (!img || !img.complete) return false;
      const surf = img.closest(".surface");
      return Math.abs(img.clientWidth - surf.clientWidth) <= 2 && Math.abs(img.clientHeight - surf.clientHeight) <= 2;
    }),
  { desc: "1-col image stretches to fill its cell" }
);
const fill = await p1.evaluate(() => {
  const img = document.querySelector("[data-cell] img");
  const surf = img.closest(".surface");
  return `${img.clientWidth}×${img.clientHeight} in ${surf.clientWidth}×${surf.clientHeight}`;
});
check(`1-col cell image fills the cell (${fill})`, true);
await p1.evaluate((n) => {
  while (window.__ltState.cols < n)
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "]", bubbles: true, cancelable: true }));
}, colsBefore);
await waitFor(async () => (await state(p1, "cols")) === colsBefore, { desc: "cols restored" });

section("mock=default: compare view (one item across all sets)");
await p1.evaluate(() => {
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true, cancelable: true }));
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
});
await waitFor(async () => (await state(p1, "selectedKey")) === "item_003", { desc: "item_003 selected" });
await timed(p1, "Ctrl+Enter opens Compare", () =>
  p1.evaluate(async () => {
    const t0 = performance.now();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true }));
    for (;;) {
      if (document.querySelector("[data-compare]")) return performance.now() - t0;
      if (performance.now() - t0 > 1000) return -1;
      await new Promise((r) => requestAnimationFrame(r));
    }
  })
);
check("header shows the item name", (await p1.$eval("[data-compare-item]", (e) => e.textContent)) === "item_003");
check(
  "one tile per set, captioned with the SET name",
  (await p1.$$eval("[data-compare-tile] .cap", (els) => els.map((e) => e.textContent))).join() === "A,B"
);
await waitFor(
  async () => (await p1.$$eval("[data-compare-tile] img", (els) => els.filter((i) => i.complete && i.naturalWidth > 0).length)) === 2,
  { desc: "both compare tiles painted" }
);
check("both tiles painted", true);
await p1.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true })));
await waitFor(async () => (await state(p1, "selectedKey")) === "item_004", { desc: "→ moves item in compare" });
check("→ moves to the next item without leaving Compare", (await p1.$("[data-compare]")) !== null);
check(
  "missing item shows a placeholder tile for set B",
  (await p1.$$eval("[data-compare-tile][data-missing]", (els) => els.map((e) => e.dataset.set))).join() === "B"
);
await p1.evaluate(() => {
  document.querySelector('[data-compare-tile][data-set="A"]').click();
});
await p1.waitForSelector("[data-detail]", { timeout: 3000 });
check("clicking a tile fullscreens that set's image", (await state(p1, "setName")) === "A" && (await state(p1, "view")) === "detail");
await p1.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
await waitFor(async () => (await state(p1, "view")) === "compare", { desc: "Esc returns to Compare" });
check("Esc from tile-Detail returns to Compare", true);
await p1.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
await waitFor(async () => (await state(p1, "view")) === "grid", { desc: "Esc exits Compare" });
check("Esc from Compare returns to the grid", true);
await p1.evaluate(() => {
  document.querySelector('[data-cell][data-key="item_002"]').dispatchEvent(new MouseEvent("click", { ctrlKey: true, bubbles: true }));
});
await p1.waitForSelector("[data-compare]", { timeout: 3000 });
check("Ctrl+click a cell opens Compare on that item", (await p1.$eval("[data-compare-item]", (e) => e.textContent)) === "item_002");
await p1.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
await waitFor(async () => (await state(p1, "view")) === "grid", { desc: "back to grid" });

section("mock=default: sister-folder switcher");
await p1.click(".coll-name");
await p1.waitForSelector("[data-sisters]", { timeout: 3000 });
check(
  "plain click lists sister folders (current marked)",
  (await p1.$$eval("[data-sisters] button", (els) => els.map((e) => `${e.textContent}${e.classList.contains("active") ? "*" : ""}`))).join() ===
    "mock-collection*,mock-sister"
);
await p1.evaluate(() => {
  [...document.querySelectorAll("[data-sisters] button")].find((b) => b.textContent === "mock-sister").click();
});
await waitFor(async () => (await state(p1, "collName")) === "mock-sister", { desc: "sister collection opened" });
check("clicking a sister opens it", true);
check("sister menu closed after the switch", (await p1.$("[data-sisters]")) === null);
await p1.keyboard.down("Control");
await p1.click(".coll-name");
await p1.keyboard.up("Control");
await waitFor(async () => (await state(p1, "collName")) === "mock-collection", { desc: "ctrl+click → open dialog (mock returns primary)" });
check("Ctrl+click opens the picker instead (no sister menu)", (await p1.$("[data-sisters]")) === null);

// =====================================================================
section("mock=default: annotations (v/x/n)");
const key = (k, init = {}) =>
  p1.evaluate((kk, ii) => window.dispatchEvent(new KeyboardEvent("keydown", { key: kk, bubbles: true, cancelable: true, ...ii })), k, init);
// no class open -> the annotation keys are inert
await key("v");
check("'v' inert with no annotation class", (await p1.$$eval("[data-cell][data-mark]", (els) => els.length)) === 0);
// create a class through the top-bar control
await p1.click("[data-annot]");
await p1.waitForSelector("[data-annot-new]", { timeout: 3000 });
await p1.click("[data-annot-new]");
await p1.waitForSelector("[data-annot-input]", { timeout: 3000 });
await p1.type("[data-annot-input]", "validated_by_eye");
await p1.keyboard.press("Enter");
await waitFor(async () => (await state(p1, "annotClass")) === "validated_by_eye", { desc: "class created + active" });
check("top bar shows the open class", (await p1.$eval("[data-annot]", (e) => e.textContent)).includes("validated_by_eye"));
check("typing the name never leaked into the keymap", (await state(p1, "view")) === "grid");
// mark the selected item (item_001 after the reopen above)
await key("Home");
await waitFor(async () => (await state(p1, "selectedKey")) === "item_001", { desc: "item_001 selected" });
// single-shot timing (no timed() retry — 'v' toggles, a second press would clear)
const vMs = await keyAndWait(p1, "v", `() => document.querySelector("[data-cell].selected")?.dataset.mark === "valid"`);
check(`'v' outlines the cell (${vMs < 0 ? "timeout" : Math.round(vMs) + "ms"} < ${LATENCY_MS}ms)`, vMs >= 0 && vMs <= LATENCY_MS);
await key("v");
check("'v' again clears the mark", (await p1.$eval("[data-cell].selected", (e) => e.dataset.mark ?? "none")) === "none");
await key("x");
check("'x' marks exclude", (await p1.$eval("[data-cell].selected", (e) => e.dataset.mark)) === "exclude");
await key("2");
await waitFor(async () => (await state(p1, "setName")) === "B", { desc: "set B" });
check("the mark follows the ITEM across sets", (await p1.$eval("[data-cell].selected", (e) => e.dataset.mark)) === "exclude");
await key("1");
await waitFor(async () => (await state(p1, "setName")) === "A", { desc: "back to set A" });
// notes: n opens the editor, typing saves, Esc closes, star appears
await key("n");
await p1.waitForSelector("[data-notes-editor] textarea", { timeout: 3000 });
await p1.type("[data-notes-editor] textarea", "axis is clipped");
await p1.keyboard.press("Escape");
await waitFor(async () => !(await state(p1, "notesOpen")), { desc: "notes editor closed" });
check("caption grows a notes star", (await p1.$("[data-cell].selected .star")) !== null);
check("notes stored on the item", (await p1.evaluate(() => window.__ltState.annotItems.item_001?.notes)) === "axis is clipped");
await key("n");
await p1.waitForSelector("[data-notes-editor] textarea", { timeout: 3000 });
check("reopening shows the saved notes", (await p1.$eval("[data-notes-editor] textarea", (t) => t.value)) === "axis is clipped");
await p1.keyboard.press("Escape");
await waitFor(async () => !(await state(p1, "notesOpen")), { desc: "notes editor closed again" });
// detail: ring + marking from fullscreen
await key("Enter");
await p1.waitForSelector("[data-detail]", { timeout: 3000 });
check("detail shows the mark ring", (await p1.$('[data-detail-mark="exclude"]')) !== null);
await key("v");
check("'v' in detail flips the mark", (await p1.$('[data-detail-mark="valid"]')) !== null);
await key("Escape");
await waitFor(async () => (await state(p1, "view")) === "grid", { desc: "back to grid" });
// compare: ring + marking from the all-sets view
await key("Enter", { ctrlKey: true });
await p1.waitForSelector("[data-compare]", { timeout: 3000 });
check("compare shows the mark ring", (await p1.$('[data-compare] [data-compare-mark="valid"]')) !== null);
await key("x");
check("'x' in compare re-marks", (await p1.$('[data-compare] [data-compare-mark="exclude"]')) !== null);
await key("Escape");
await waitFor(async () => (await state(p1, "view")) === "grid", { desc: "back to grid" });
// switching class away and back keeps the layer intact (mock in-memory)
await p1.click("[data-annot]");
await p1.waitForSelector("[data-annot-menu]", { timeout: 3000 });
await p1.evaluate(() => {
  [...document.querySelectorAll("[data-annot-menu] button")].find((b) => b.textContent === "Close annotation class").click();
});
await waitFor(async () => (await state(p1, "annotClass")) === null, { desc: "class closed" });
check("outlines vanish with the class", (await p1.$$eval("[data-cell][data-mark]", (els) => els.length)) === 0);
await p1.click("[data-annot]");
await p1.waitForSelector("[data-annot-menu]", { timeout: 3000 });
await p1.evaluate(() => {
  [...document.querySelectorAll("[data-annot-menu] button")].find((b) => b.textContent === "validated_by_eye").click();
});
await waitFor(async () => (await state(p1, "annotClass")) === "validated_by_eye", { desc: "class reopened" });
check("marks return with the class", (await p1.$eval('[data-cell][data-key="item_001"]', (e) => e.dataset.mark)) === "exclude");

// =====================================================================
section("mock=big: virtualization on 3×2000 items");
const p2 = await openPage("big");
check("2000 keys loaded", (await state(p2, "keyCount")) === 2000);
const bound = await p2.evaluate(() => {
  const g = window.__ltState.grid;
  const vh = document.querySelector("[data-grid]").clientHeight;
  return (Math.ceil(vh / g.rowH) + 1 + 2 * 2) * window.__ltState.cols; // visibleRows+1 partial + 2·overscan
});
const domCells = await p2.$$eval("[data-cell]", (els) => els.length);
check(`DOM bounded at top (${domCells} <= ${bound})`, domCells <= bound);

const midScroll = await p2.evaluate(async () => {
  const vp = document.querySelector("[data-grid]");
  vp.scrollTop = vp.scrollHeight / 2;
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  return { dom: document.querySelectorAll("[data-cell]").length, st: vp.scrollTop };
});
check(`DOM bounded mid-fling (${midScroll.dom} <= ${bound})`, midScroll.dom <= bound && midScroll.st > 0);
const endScroll = await p2.evaluate(async () => {
  const vp = document.querySelector("[data-grid]");
  vp.scrollTop = vp.scrollHeight;
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  return { dom: document.querySelectorAll("[data-cell]").length, last: [...document.querySelectorAll("[data-cell]")].pop()?.dataset.key };
});
check(`DOM bounded at bottom (${endScroll.dom} <= ${bound})`, endScroll.dom <= bound);
check("last item reachable (item_2000)", endScroll.last === "item_2000");

section("mock=big: scroll + set switch keep place");
const keep = await p2.evaluate(async () => {
  const vp = document.querySelector("[data-grid]");
  vp.scrollTop = 5000;
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  // a cell that is actually VISIBLE (not one in the overscan rows above the
  // viewport — Esc deliberately nudges an offscreen selection into view)
  const r0 = vp.getBoundingClientRect();
  const cell = [...document.querySelectorAll("[data-cell]")].find((c) => {
    const r = c.getBoundingClientRect();
    return r.top >= r0.top && r.bottom <= r0.bottom;
  });
  cell.click(); // click opens Detail on that cell
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const inDetail = window.__ltState.view === "detail";
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  return { inDetail, key: cell.dataset.key, sel: window.__ltState.selectedKey, st: vp.scrollTop, view: window.__ltState.view };
});
check("click opens Detail on the clicked cell", keep.inDetail && keep.sel === keep.key);
check("Esc restores grid with scroll intact", keep.view === "grid" && keep.st === 5000);

const switchKeep = await p2.evaluate(async () => {
  const vp = document.querySelector("[data-grid]");
  const st0 = vp.scrollTop;
  const sel0 = window.__ltState.selectedKey;
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "2", bubbles: true, cancelable: true }));
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  return { ok: window.__ltState.setName === "s2" && vp.scrollTop === st0 && window.__ltState.selectedKey === sel0 };
});
check("set switch keeps scroll AND selection at 2000 items", switchKeep.ok);

section("mock=big: latency at scale");
await p2.evaluate(async () => {
  const vp = document.querySelector("[data-grid]");
  vp.scrollTop = 0;
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true, cancelable: true }));
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
});
const bigSrcBefore = await p2.$eval("[data-cell].selected img", (i) => i.src);
await timed(p2, "set switch at 2000 items", () =>
  keyAndWait(p2, "1", `() => {
    const img = document.querySelector("[data-cell].selected img");
    return window.__ltState.setName === "s1" && img && img.src !== ${JSON.stringify(bigSrcBefore)} && img.complete;
  }`)
);
await timed(p2, "column change at 2000 items", () => keyAndWait(p2, "]", `() => window.__ltState.cols === 9`));
await timed(p2, "search keystroke at 2000 items", () =>
  p2.evaluate(async () => {
    const input = document.querySelector("input.search");
    const t0 = performance.now();
    input.value = "item_19";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    for (;;) {
      if (window.__ltState.filteredCount < 2000) return performance.now() - t0;
      if (performance.now() - t0 > 1000) return -1;
      await new Promise((r) => requestAnimationFrame(r));
    }
  })
);

section("console contract");
check("console is clean across both pages", consoleErrors.length === 0, consoleErrors.slice(0, 5).join(" | "));

clearTimeout(hardTimeout);
await cleanup();
finish("verify-ui");
