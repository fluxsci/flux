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
