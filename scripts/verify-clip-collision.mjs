// The 2026-08-13 blank-plots regression, pinned at three layers. Mechanism:
// Chromium resolves `url(#clipPath-id)` to the FIRST matching id in the
// document and composes clip geometry from RENDERED children only — so a
// DUPLICATE-id copy of a plot inside a visibility:hidden subtree (ModeContent
// keep-alive) makes the winning clipPath EMPTY, and every data mark clipped by
// it vanishes from the VISIBLE copy while unclipped axes/text survive. Paper
// inline renders (embeds/hover/pickers) used to share the figure editor's
// element-id prefix, so visiting the manuscript and returning to the figure
// editor blanked real projects. Verifies:
//   1. the raw mechanism still exists (if Chromium ever fixes it, this tells us);
//   2. the ModeContent guard rule (`.mc.hidden clipPath * {visibility:visible}`)
//      neutralizes it, and the rule is still present in the source;
//   3. the namespace fix: paper display renders carry `pap__` ids (never the
//      editor's bare element prefix), live in the app, and the embed's clipped
//      data marks actually PAINT.
//   Run (dev server on :1420 must be up): node scripts/verify-clip-collision.mjs
import * as fs from "node:fs/promises";
import { launch, gotoApp, clickMode, sleep, realErrors, waitFor, waitForSelector, APP_URL } from "./lib/driver.mjs";
import { harness } from "./lib/harness.mjs";

const h = harness("verify-clip-collision");
const { browser, page } = await launch({ width: 900, height: 700 });

// Screenshot a page region and count green data-mark pixels by decoding the
// PNG in-page (a screenshot is a flat raster — no clip semantics left).
async function greenPixels(selector) {
  const clip = await page.evaluate((sel) => {
    const r = document.querySelector(sel).getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }, selector);
  const b64 = await page.screenshot({ clip, encoding: "base64" });
  return page.evaluate(async (data) => {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = `data:image/png;base64,${data}`; });
    const c = document.createElement("canvas");
    c.width = img.width; c.height = img.height;
    const ctx = c.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4)
      if (d[i + 1] > 100 && d[i + 1] > d[i] + 40 && d[i + 1] > d[i + 2] + 40) n++;
    return n;
  }, b64);
}

try {
  // ---- 1+2: the mechanism and the guard, on a self-contained page ----------
  const PLOT = (prefix) =>
    `<svg width="120" height="80" viewBox="0 0 120 80">` +
    `<defs><clipPath id="${prefix}__clip"><rect x="0" y="0" width="120" height="80"/></clipPath></defs>` +
    `<path d="M10 70H110M10 70V10" stroke="#333" fill="none"/>` +
    `<g clip-path="url(#${prefix}__clip)"><rect x="30" y="20" width="60" height="40" fill="#0a9f3e"/></g></svg>`;
  await page.setContent(`<!doctype html><html><head><style>
    body { background:#fff; margin:0; }
    .hid { visibility: hidden; position: absolute; top: 0; left: 0; }
    /* the ModeContent guard rule, verbatim semantics */
    .guard clipPath * { visibility: visible; }
    .row { padding: 6px; }
  </style></head><body>
    <div class="hid">${PLOT("plot_el_1")}</div>
    <div class="hid guard">${PLOT("plot_el_2")}</div>
    <div class="hid">${PLOT("pap__plot_el_3")}</div>
    <div class="row" id="bug">${PLOT("plot_el_1")}</div>
    <div class="row" id="guarded">${PLOT("plot_el_2")}</div>
    <div class="row" id="namespaced">${PLOT("plot_el_3")}</div>
    <div class="row" id="control">${PLOT("solo_el")}</div>
  </body></html>`);
  await sleep(300); // paint settle
  const control = await greenPixels("#control");
  h.ok(control > 500, `control paints its clipped data marks (${control} px)`);
  const bug = await greenPixels("#bug");
  h.ok(bug < control / 10,
    `MECHANISM: unguarded hidden duplicate-id twin blanks the visible copy (${bug} px) — if this ever fails, Chromium changed and the guard can be revisited`);
  const guarded = await greenPixels("#guarded");
  h.ok(guarded > control / 2, `the ModeContent guard rule restores painting under duplicate ids (${guarded} px)`);
  const namespaced = await greenPixels("#namespaced");
  h.ok(namespaced > control / 2, `a pap__-namespaced hidden twin never collides (${namespaced} px)`);

  const modeContent = await fs.readFile(new URL("../src/shell/ModeContent.svelte", import.meta.url), "utf8");
  h.ok(/\.mc\.hidden\s+:global\(clipPath \*\)/.test(modeContent) && /visibility:\s*visible/.test(modeContent),
    "ModeContent.svelte carries the hidden-clipPath guard rule");

  // ---- 3: live app — embeds render namespaced AND their clipped data paints -
  await gotoApp(page, { url: `${APP_URL}?fixture=demo`, settle: 3000 });
  await clickMode(page, "Paper").catch(() => {});
  await waitFor(page, () => !!(window.__flux?.editors ?? [])[0], null, { timeout: 15000, label: "paper editor mounted" });
  await page.evaluate(() => {
    const PLOT =
      `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="120" viewBox="0 0 200 120">` +
      `<defs><clipPath id="clipA"><rect x="0" y="0" width="200" height="120"/></clipPath></defs>` +
      `<g id="axis.x" data-role="axis"><path d="M20 100H180" stroke="#333" fill="none"/></g>` +
      `<g id="series.a" data-role="line" clip-path="url(#clipA)">` +
      `<rect x="40" y="30" width="120" height="60" fill="#0a9f3e"/></g></svg>`;
    const ref = { id: "clipfig", label: "fig-clipfig", name: "Clip", family: "figure", number: 1,
      display: "Fig. 1", captionLabel: "", order: 1, canvas: "c1", caption: "", panels: [] };
    const fig = { id: "clipfig", name: "Clip", width: 200, height: 120,
      elements: [{ type: "plot", id: "plot_clip_el", assetId: "a1", x: 0, y: 0, width: 200, height: 120, rotation: 0, overrides: {} }] };
    window.__fluxSeedFigures([ref], { clipfig: fig }, { a1: `data:image/svg+xml;base64,${btoa(PLOT)}` }, [], {}, [], []);
    const view = (window.__flux?.editors ?? [])[0];
    view.dispatch({
      changes: { from: view.state.doc.length, insert: "\n\n![](../fig/renders/clipfig.svg){#fig-clipfig}\n" },
    });
  });
  await waitForSelector(page, ".flux-embed svg", { timeout: 8000, label: "embed svg mounted" });
  await sleep(400); // widget/paint settle
  const ids = await page.evaluate(() => {
    const svg = document.querySelector(".flux-embed svg");
    svg.scrollIntoView({ block: "center" }); // the paint check screenshots the viewport
    return [...svg.querySelectorAll("[id]")].map((el) => el.id);
  });
  await sleep(300); // scroll + repaint settle before the pixel capture
  h.ok(ids.some((i) => i.startsWith("pap__plot_clip_el__")), "embed inline ids carry the paper namespace");
  h.ok(!ids.some((i) => i.startsWith("plot_clip_el__")), "no embed id uses the figure editor's bare element prefix");
  const embedGreen = await greenPixels(".flux-embed svg");
  h.ok(embedGreen > 200, `embed's clipped data marks actually paint (${embedGreen} px)`);

  const errs = realErrors(page);
  h.ok(errs.length === 0, `console clean (${errs.length ? errs[0].slice(0, 120) : "no errors"})`);
} finally {
  await browser.close();
}
await h.done();
