// 2026-09-15 — the crosshair cursor family (styles/cursors.css + Canvas.svelte)
// gates in the browser (ui tier — dev server on :1420, demo fixture):
// the canvas default is the precise crosshair (a hardware `url()` cursor with a
// platform fallback), hovering an object adds the dot, a press contracts the
// arms and blooms one accent ring that is gone within a third of a second,
// objects inherit the host cursor (no stray `move`), the draw tools use the
// plain cross, pan keeps grab, and the text tool keeps the I-beam.
//   node scripts/verify-cursor-gui.mjs
import { launch, gotoApp, clickMode, realErrors, waitFor } from "./lib/driver.mjs";

const { browser, page } = await launch();
await gotoApp(page, { url: "http://127.0.0.1:1420/?fixture=demo", settle: 2500 });
await clickMode(page, "Figure").catch(() => {});
await waitFor(page, () => !!document.querySelector(".canvas-host") && !!document.querySelector("[data-editor-element-id]"), null, { timeout: 15000, label: "figure canvas" });

const checks = [];
const ok = (cond, msg) => { checks.push([!!cond, msg]); console.log(`${cond ? "✓" : "✗"} ${msg}`); };
const cursorOf = (sel = ".canvas-host") => page.$eval(sel, (el) => getComputedStyle(el).cursor);
const isCross = (c) => /data:image\/svg\+xml/.test(c) && /crosshair$/.test(c);
const isHover = (c) => isCross(c) && /circle/.test(c) && !/y1='4'/.test(c);
const isPress = (c) => isCross(c) && /y1='4'/.test(c);
const host = await page.$eval(".canvas-host", (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
const empty = { x: host.x + host.w - 60, y: host.y + host.h - 60 };
const el = await page.$eval("[data-editor-element-id]", (g) => { const r = g.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, id: g.getAttribute("data-editor-element-id") }; });

// --- 1. idle: the crosshair over empty canvas -----------------------------------------
await page.mouse.move(empty.x, empty.y);
await new Promise((r) => setTimeout(r, 80));
let c = await cursorOf();
ok(isCross(c) && !/circle/.test(c), `empty canvas shows the plain crosshair (hardware svg + crosshair fallback)`);

// --- 2. hover: the dot over a selectable object; the object inherits it ----------------
await page.mouse.move(el.x, el.y);
await waitFor(page, () => !!window.__flux?.get(window.__flux.fig.hoverId), null, { label: "hover registered" }).catch(() => {});
c = await cursorOf();
ok(isHover(c), "hovering an object switches to the crosshair with the accent dot");
const elCursor = await page.$eval("[data-editor-element-id]", (g) => getComputedStyle(g).cursor);
ok(elCursor === c, "the object inherits the host cursor (no stray `move`)");

// --- 3. press: contracted arms + one ring that leaves ---------------------------------
await page.mouse.move(empty.x, empty.y);
await page.mouse.down();
await new Promise((r) => setTimeout(r, 60));
c = await cursorOf();
ok(isPress(c), "a press contracts the crosshair (press variant)");
const rings = await page.$$eval(".canvas-host .click-ring", (l) => l.length);
ok(rings === 1, `one click ring blooms at the press (${rings})`);
await page.mouse.up();
await waitFor(page, () => document.querySelectorAll(".canvas-host .click-ring").length === 0, null, { timeout: 1500, label: "ring gone" });
ok(true, "the ring is gone within a third of a second");
c = await cursorOf();
ok(isCross(c) && !/circle/.test(c), "release returns to the plain crosshair");

// --- 4. tools: draw = plain cross, pan = grab, text = I-beam --------------------------
await page.keyboard.press("r");
await new Promise((r) => setTimeout(r, 60));
c = await cursorOf();
ok(isCross(c) && !/circle/.test(c), "the rect tool uses the plain crosshair");
await page.keyboard.press("h");
await new Promise((r) => setTimeout(r, 60));
ok((await cursorOf()) === "grab", "the pan tool keeps grab");
await page.keyboard.press("t");
await new Promise((r) => setTimeout(r, 60));
ok((await cursorOf()) === "text", "the text tool keeps the I-beam");
await page.keyboard.press("v");

// --- 5. reduced motion: no ring ----------------------------------------------------------
await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
await page.mouse.move(empty.x, empty.y);
await page.mouse.down();
await new Promise((r) => setTimeout(r, 40));
const rm = await page.$$eval(".canvas-host .click-ring", (l) => l.length);
await page.mouse.up();
ok(rm === 0, "reduced motion: no click ring");
await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "no-preference" }]);

const errs = await realErrors(page);
ok(errs.length === 0, `clean console (${errs.length} errors${errs.length ? ": " + errs[0] : ""})`);
await browser.close();
const failed = checks.filter(([c]) => !c).length;
console.log(`##VERIFY## ${JSON.stringify({ script: "verify-cursor-gui", ok: failed === 0, checks: checks.length, failed })}`);
console.log(failed ? `verify-cursor-gui: FAIL (${failed}/${checks.length})` : `verify-cursor-gui: PASS (${checks.length} checks)`);
process.exit(failed ? 1 : 0);
