// figure-v1 P8 gate (browser) — the X-ray SURFACE, asserted on computed styles
// (2026-09-15 surface redesign supersedes the CRT radiograph contract: same
// always-dark phosphor identity, but FLAT — the panel is a surface that opens
// beside the selection, not a show):
//   · NO backdrop-filter, NO gradient field, NO ::after scanline/vignette layer
//   · no text glow (text-shadow none on rows and header)
//   · mono type on the tree rows + header; uppercase letterspaced header
//   · selection = translucent phosphor tint (never a solid fill); the primary
//     row of a pick carries an inset 2px rail
//   · nothing animates at rest (document.getAnimations() empty ≥ 200ms after
//     open) and prefers-reduced-motion opens with no entrance animation at all
//   · it opens beside the selection: the panel never covers the selection box
//   · Alt+R opens it (the chord moved to the left hand)
//   Run (dev server on :1420): node scripts/verify-xray-theme.mjs
import { readFileSync } from "node:fs";
import { launch, gotoApp, clickMode, shot, sleep, realErrors } from "./lib/driver.mjs";

let fails = 0;
const ok = (cond, msg) => (cond ? console.log("  ✓ " + msg) : (fails++, console.log("  ✗ " + msg)));

const SVG = readFileSync("scripts/fixtures/pre-regen/06_scatter_regression.svg", "utf8");
const MANIFEST = JSON.parse(readFileSync("scripts/fixtures/pre-regen/06_scatter_regression.fluxplot.json", "utf8"));

const { browser, page } = await launch({ width: 1500, height: 950 });
try {
  await gotoApp(page, { url: "http://127.0.0.1:1420/?fixture=demo", settle: 3500 });
  await clickMode(page, "Figure");
  await sleep(700);

  // Seed one real fluxplot, left of centre so the panel has room on its right.
  await page.evaluate(
    (svg, manifest) => {
      const F = window.__flux.fig;
      window.__flux.io.reimportPlot("theme-asset", svg, manifest);
      F.commit((p) => {
        const g = p.figures[0];
        g.x = 0;
        g.y = 0;
        g.width = 900;
        g.height = 620;
        g.elements = [
          {
            type: "plot", id: "plot1", x: 40, y: 40, width: 504, height: 360, rotation: 0,
            assetId: "theme-asset", overrides: {},
            source: { svgPath: "plots/scatter_regression.svg" },
          },
        ];
        window.__figId = g.id;
        F.activeFigureId.set(g.id);
      });
      F.selectOnly("plot1");
      F.viewport.set({ panX: 60, panY: 140, zoom: 0.85 });
    },
    SVG,
    MANIFEST,
  );
  await sleep(400);
  await page.mouse.move(300, 300);

  // --- open with the left-hand chord -------------------------------------------
  await page.keyboard.down("Alt");
  await page.keyboard.press("KeyR");
  await page.keyboard.up("Alt");
  await sleep(300);
  ok(await page.evaluate(() => !!document.querySelector(".xray")), "Alt+R opens the X-ray");
  const rest = await page.evaluate(() => document.getAnimations().length);
  ok(rest === 0, `document.getAnimations().length === 0 after open (${rest}) — nothing animates at rest`);

  // --- computed-style contract -----------------------------------------------
  const styles = await page.evaluate(() => {
    const panel = document.querySelector(".xray");
    const nodes = [panel, document.querySelector(".xbackdrop"), ...panel.querySelectorAll("*")];
    const bf = nodes.filter((n) => {
      const v = getComputedStyle(n).backdropFilter;
      return v && v !== "none";
    }).length;
    const after = getComputedStyle(panel, "::after");
    const row = document.querySelector(".xray .row");
    const ttl = document.querySelector(".xray .ttl");
    const sel = document.querySelector(".canvas-host .sel-box")?.getBoundingClientRect();
    const pr = panel.getBoundingClientRect();
    return {
      backdropFiltered: bf,
      afterContent: after.content,
      panelBgImage: getComputedStyle(panel).backgroundImage,
      panelFont: getComputedStyle(panel).fontFamily,
      rowFont: row ? getComputedStyle(row).fontFamily : "",
      rowShadow: row ? getComputedStyle(row).textShadow : "",
      ttlTransform: ttl ? getComputedStyle(ttl).textTransform : "",
      ttlSpacing: ttl ? parseFloat(getComputedStyle(ttl).letterSpacing) : 0,
      ttlShadow: ttl ? getComputedStyle(ttl).textShadow : "",
      overlaps: sel ? !(pr.right <= sel.left || pr.left >= sel.right || pr.bottom <= sel.top || pr.top >= sel.bottom) : null,
      inViewport: pr.left >= 0 && pr.top >= 0 && pr.right <= innerWidth && pr.bottom <= innerHeight,
    };
  });
  ok(styles.backdropFiltered === 0, "NO backdrop-filter anywhere in the panel");
  ok(styles.afterContent === "none" || styles.afterContent === "" || styles.afterContent === "normal", `no ::after CRT layer (content: ${styles.afterContent})`);
  ok(styles.panelBgImage === "none", `flat panel field — no gradient (${styles.panelBgImage})`);
  ok(/mono/i.test(styles.rowFont), `mono type on tree rows (${styles.rowFont.split(",")[0]})`);
  ok(styles.rowShadow === "none", "no text glow on rows");
  ok(styles.ttlTransform === "uppercase" && styles.ttlSpacing > 1 && styles.ttlShadow === "none",
    `mono uppercase letterspaced header, no glow (${styles.ttlTransform}, ${styles.ttlSpacing}px)`);
  ok(styles.overlaps === false, "the panel opens BESIDE the selection (never covers the selection box)");
  ok(styles.inViewport, "…and inside the viewport");

  // Selection = phosphor tint + inset rail on the primary row — NOT a solid accent fill.
  await page.evaluate(() => {
    [...document.querySelectorAll(".xray .row")]
      .find((r) => (r.querySelector(".rlabel")?.textContent ?? "").trim() === "X axis")
      ?.querySelector("button.tw")?.click();
  });
  await sleep(200);
  await page.evaluate(() => {
    [...document.querySelectorAll(".xray .row")]
      .find((r) => (r.querySelector(".rlabel")?.textContent ?? "").trim() === "Tick labels")
      ?.click();
  });
  await sleep(250);
  const sel = await page.evaluate(() => {
    const r = document.querySelector(".xray .row.sel");
    if (!r) return null;
    const cs = getComputedStyle(r);
    return { bg: cs.backgroundColor, shadow: cs.boxShadow, glow: cs.textShadow, primary: r.classList.contains("primary") };
  });
  ok(!!sel, "a selected row exists");
  const alphaM = sel && (sel.bg.match(/\/\s*([\d.]+)\s*\)/) || sel.bg.match(/rgba\([^)]+,\s*([\d.]+)\)/));
  const alpha = alphaM ? parseFloat(alphaM[1]) : 1;
  ok(sel && alpha > 0 && alpha < 0.5, `.sel = translucent phosphor tint, not a solid fill (alpha ${alpha}: ${sel?.bg})`);
  ok(sel && sel.primary && /inset/.test(sel.shadow), "…the primary row carries the inset rail");
  ok(sel && sel.glow === "none", "…and no text glow");

  // Dim a row's eye for the screenshot (shows the off state) + evidence shot.
  await page.evaluate(() => {
    [...document.querySelectorAll(".xray .row")]
      .find((r) => (r.querySelector(".rlabel")?.textContent ?? "").trim() === "Gridlines")
      ?.querySelector("button.eye")?.click();
  });
  await sleep(300);
  await shot(page, "xray-theme-full");

  // --- reduced motion: no entrance animation at all --------------------------
  await page.keyboard.press("Escape");
  await sleep(300);
  await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
  await page.keyboard.down("Alt");
  await page.keyboard.press("KeyR");
  await page.keyboard.up("Alt");
  await sleep(60);
  const reduced = await page.evaluate(() => ({
    anim: getComputedStyle(document.querySelector(".xray")).animationName,
    running: document.getAnimations().length,
  }));
  ok(reduced.anim === "none" && reduced.running === 0, `prefers-reduced-motion opens with no animation (animation: ${reduced.anim})`);

  const errs = realErrors(page);
  ok(errs.length === 0, `no console errors (${errs.length})`);
  if (errs.length) console.error(errs.slice(0, 5));
  console.log(fails === 0 ? "\nVERIFY-XRAY-THEME ALL PASS" : `\nVERIFY-XRAY-THEME ${fails} FAILURE(S)`);
} finally {
  await browser.close();
}
process.exit(fails === 0 ? 0 : 1);
