// figure-v1 Phase 3 (ui) — Ctrl/Cmd+B/I/U:
//   • on a text selection (toggle all-on→off; live DOM shows weight/style/
//     text-decoration)
//   • inside the inline textarea editor (same toggles, one edit session)
//   • on a drilled TEXT-KIND plot part (id-keyed override + style drilled onto
//     the live <text> drawable)
//   • ctrl+I NO LONGER IMPORTS (italic instead); import is Ctrl+Shift+K —
//     asserted live via an openFiles spy + source/tooltip tripwires.
// Screenshot: an underlined italic bold text (render evidence).
import { readFileSync } from "node:fs";
import { launch, gotoApp, clickMode, shot, realErrors, sleep } from "./lib/driver.mjs";

let fails = 0;
function assert(cond, msg) {
  if (cond) console.log("  ok:", msg);
  else {
    fails++;
    console.error("  FAIL:", msg);
  }
}

const SVG = readFileSync("scripts/fixtures/pre-regen/06_scatter_regression.svg", "utf8");
const MANIFEST = JSON.parse(readFileSync("scripts/fixtures/pre-regen/06_scatter_regression.fluxplot.json", "utf8"));
const PART = "axis.x.ticklabel.2";

const { browser, page } = await launch({ width: 1440, height: 900 });
try {
  await gotoApp(page, { url: "http://127.0.0.1:1420/?fixture=demo", settle: 3500 });
  await clickMode(page, "Figure");
  await sleep(700);

  await page.evaluate(
    (svg, manifest) => {
      const F = window.__flux.fig;
      window.__flux.io.reimportPlot("biu-asset", svg, manifest);
      F.commit((p) => {
        const g = p.figures.find((f) => f.id === "growth") || p.figures[0];
        g.x = 0;
        g.y = 0;
        g.width = 1000;
        g.height = 700;
        g.elements = [];
        g.elements.push({
          type: "text", id: "biu-t1", x: 60, y: 40, width: 200, height: 24, rotation: 0,
          text: "Panel label", fontFamily: "Arial", fontSize: 18, fontWeight: 400,
          fontStyle: "normal", align: "left", color: "#111111", sizing: "auto",
        });
        g.elements.push({
          type: "text", id: "biu-t2", x: 320, y: 40, width: 200, height: 24, rotation: 0,
          text: "Second label", fontFamily: "Arial", fontSize: 18, fontWeight: 700,
          fontStyle: "normal", align: "left", color: "#111111", sizing: "auto",
        });
        g.elements.push({
          type: "plot", id: "biu-plot", x: 60, y: 120, width: 504, height: 360, rotation: 0,
          assetId: "biu-asset", overrides: {},
        });
      });
      F.viewport.set({ panX: 120, panY: 120, zoom: 1 });
      F.selectOnly("biu-t1");
      // spy: prove ctrl+I never reaches the importer and Ctrl+Shift+K does
      window.__openFilesCalls = 0;
      const orig = window.fig.openFiles;
      window.fig.openFiles = async (...a) => {
        window.__openFilesCalls++;
        return null; // never actually open a picker
      };
      void orig;
    },
    SVG,
    MANIFEST,
  );
  await sleep(400);

  const el = (id) => page.evaluate((id) => window.__flux.figures().flatMap((f) => f.elements).find((e) => e.id === id), id);
  const mod = async (k, shift = false) => {
    await page.keyboard.down("Control");
    if (shift) await page.keyboard.down("Shift");
    await page.keyboard.press(k);
    if (shift) await page.keyboard.up("Shift");
    await page.keyboard.up("Control");
    await sleep(180);
  };

  // ---- selection B/I/U --------------------------------------------------------
  await mod("b");
  assert((await el("biu-t1")).fontWeight === 700, "ctrl+B bolds the selected text");
  await mod("i");
  assert((await el("biu-t1")).fontStyle === "italic", "ctrl+I italicizes (NOT import)");
  await mod("u");
  assert((await el("biu-t1")).underline === true, "ctrl+U underlines");
  assert(
    await page.evaluate(() => window.__openFilesCalls === 0),
    "ctrl+I did NOT open the import picker",
  );
  const dom = await page.evaluate(() => {
    const t = [...document.querySelectorAll(".scene-svg text")].find((n) => (n.textContent ?? "").includes("Panel label"));
    return t
      ? { w: t.getAttribute("font-weight"), s: t.getAttribute("font-style"), d: t.getAttribute("text-decoration") }
      : null;
  });
  assert(dom && dom.w === "700" && dom.s === "italic" && dom.d === "underline", `live <text> carries weight/style/decoration (${JSON.stringify(dom)})`);
  await shot(page, "text-biu-01-underlined-italic-bold");

  // mixed selection: t1 bold, t2 bold → all-on → ctrl+B turns BOTH off
  await page.evaluate(() => window.__flux.fig.selection.set(new Set(["biu-t1", "biu-t2"])));
  await sleep(120);
  await mod("b");
  const [t1, t2] = [await el("biu-t1"), await el("biu-t2")];
  assert(t1.fontWeight === 400 && t2.fontWeight === 400, "all-bold selection → ctrl+B unbolds everywhere");

  // one undo reverts the whole toggle
  await page.evaluate(() => window.__flux.fig.undo());
  await sleep(120);
  assert((await el("biu-t1")).fontWeight === 700, "one undo reverts the group toggle");

  // ---- inside the inline editor -------------------------------------------------
  await page.evaluate(() => window.__flux.fig.selectOnly("biu-t2"));
  await sleep(120);
  const c = await page.evaluate(() => {
    const vp = window.__flux.get(window.__flux.fig.viewport);
    const host = document.querySelector(".canvas-host").getBoundingClientRect();
    return { x: host.left + vp.panX + 340 * vp.zoom, y: host.top + vp.panY + 52 * vp.zoom };
  });
  await page.mouse.click(c.x, c.y, { count: 2 });
  await sleep(400);
  assert(await page.evaluate(() => !!document.querySelector("textarea.text-edit")), "editor open");
  await mod("i");
  assert((await el("biu-t2")).fontStyle === "italic", "ctrl+I toggles italic INSIDE the editor");
  await mod("u");
  assert((await el("biu-t2")).underline === true, "ctrl+U toggles underline INSIDE the editor");
  const taDeco = await page.evaluate(() => {
    const t = document.querySelector("textarea.text-edit");
    return t ? getComputedStyle(t).textDecorationLine : null;
  });
  assert(taDeco === "underline", `editor textarea mirrors the underline (${taDeco})`);
  await page.keyboard.press("Escape");
  await sleep(200);

  // ---- drilled text-kind plot part ------------------------------------------------
  await page.evaluate((part) => {
    const F = window.__flux.fig;
    F.selectOnly("biu-plot");
    F.partSelection.set({ elementId: "biu-plot", partId: part });
  }, PART);
  await sleep(250);
  await mod("b");
  let ov = await page.evaluate((part) => {
    const el = window.__flux.figures().flatMap((f) => f.elements).find((e) => e.id === "biu-plot");
    return el.overrides?.[part];
  }, PART);
  assert(ov && ov.fontWeight === 700, `ctrl+B on a ticklabel part writes override fontWeight 700 (${JSON.stringify(ov)})`);
  await mod("i");
  await mod("u");
  ov = await page.evaluate((part) => {
    const el = window.__flux.figures().flatMap((f) => f.elements).find((e) => e.id === "biu-plot");
    return el.overrides?.[part];
  }, PART);
  assert(ov && ov.fontStyle === "italic" && ov.textDecoration === "underline", "ctrl+I/U on the part write fontStyle/textDecoration overrides");
  const drilled = await page.evaluate((part) => {
    const wrap = document.getElementById(`biu-plot__${part}`);
    if (!wrap) return null;
    const t = wrap.tagName.toLowerCase() === "text" ? wrap : wrap.querySelector("text");
    if (!t) return null;
    return { w: t.style.fontWeight, s: t.style.fontStyle, d: t.style.textDecoration };
  }, PART);
  assert(
    drilled && String(drilled.w) === "700" && drilled.s === "italic" && drilled.d === "underline",
    `override style DRILLED onto the live <text> drawable (${JSON.stringify(drilled)})`,
  );
  await shot(page, "text-biu-02-part");
  await page.evaluate(() => window.__flux.fig.partSelection.set(null));
  await sleep(120);

  // ---- import remap: Ctrl+Shift+K opens the picker ---------------------------------
  const before = await page.evaluate(() => window.__openFilesCalls);
  await page.evaluate(() => window.__flux.fig.clearSelection());
  await sleep(120);
  await mod("i"); // nothing selected → no toggle target AND no import
  await mod("k", true); // Ctrl+Shift+K = import
  const after = await page.evaluate(() => window.__openFilesCalls);
  assert(before === 0 && after === 1, `Ctrl+Shift+K (and ONLY it) reaches the importer (calls ${before}→${after})`);

  // source/tooltip tripwires (the remap must not silently regress)
  const src = readFileSync("src/lib/keyboard.ts", "utf8");
  assert(/k === "k" && e\.shiftKey/.test(src) && /importAssets\(\)/.test(src), "keyboard.ts routes import through Ctrl+Shift+K");
  assert(!/k === "i"\)\s*\{\s*e\.preventDefault\(\);\s*importAssets/.test(src), "keyboard.ts no longer imports on ctrl+I");
  const tb = readFileSync("src/lib/Toolbar.svelte", "utf8");
  assert(tb.includes("Ctrl+Shift+K"), "Toolbar tooltip advertises Ctrl+Shift+K");

  const errs = realErrors(page);
  assert(errs.length === 0, `no console errors (${errs.length})`);
  if (errs.length) console.error(errs.slice(0, 5));
  console.log(fails === 0 ? "\nTEXT B/I/U ALL PASS" : `\nTEXT B/I/U ${fails} FAILURE(S)`);
} finally {
  await browser.close();
}
process.exit(fails === 0 ? 0 : 1);
