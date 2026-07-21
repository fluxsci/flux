// figure-v1 P8 gate (browser) — the RADIOGRAPH theme, asserted on computed
// styles (the vibe is CSS-only; the machinery must stay cheap):
//   · NO backdrop-filter anywhere in the panel (the blur(16px) layer is gone)
//   · mono type on the tree rows + header
//   · the ::after CRT layer exists: static scanlines (repeating-linear-gradient)
//     + vignette, and the panel field is the phosphor gradient stack
//   · one-shot CRT boot flicker: present right after open, FINISHED and gone
//     from document.getAnimations() after 600ms (nothing animates at rest)
//   · prefers-reduced-motion: reduce disables the boot entirely
//   · evidence screenshot → flux_figure_upgrades_fixes/evidence-xray.png
//   Run (dev server on :1420): node scripts/verify-xray-theme.mjs
import { readFileSync, copyFileSync, mkdirSync } from "node:fs";
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

  // Seed one real fluxplot, centered-ish so the radiograph reads over the scene.
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
            type: "plot", id: "plot1", x: 40, y: 40, width: 604, height: 432, rotation: 0,
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

  // --- open + catch the one-shot boot mid-flight -----------------------------
  await page.keyboard.down("Alt");
  await page.keyboard.press("KeyP");
  await page.keyboard.up("Alt");
  await sleep(120); // boot runs 340ms — sample it live
  const boot = await page.evaluate(() =>
    document.getAnimations().map((a) => ({
      name: a.animationName ?? "",
      pseudo: a.effect?.pseudoElement ?? null,
    })),
  );
  ok(boot.some((a) => /xr-boot/.test(a.name) && a.pseudo === "::after"),
    `one-shot CRT boot flicker runs on ::after at open (${boot.map((a) => a.name).join(", ")})`);

  await sleep(700); // > 340ms boot + 180ms forge + slack
  const rest = await page.evaluate(() => document.getAnimations().length);
  ok(rest === 0, `document.getAnimations().length === 0 after 600ms (${rest}) — nothing animates at rest`);

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
    return {
      backdropFiltered: bf,
      afterBg: after.backgroundImage,
      afterEvents: after.pointerEvents,
      panelBg: getComputedStyle(panel).backgroundImage,
      panelFont: getComputedStyle(panel).fontFamily,
      rowFont: row ? getComputedStyle(row).fontFamily : "",
      ttlTransform: ttl ? getComputedStyle(ttl).textTransform : "",
      ttlSpacing: ttl ? parseFloat(getComputedStyle(ttl).letterSpacing) : 0,
      selBg: null,
    };
  });
  ok(styles.backdropFiltered === 0, "NO backdrop-filter anywhere in the panel (blur layer deleted)");
  ok(/repeating-linear-gradient/.test(styles.afterBg), "::after carries the static scanline layer");
  ok(/radial-gradient/.test(styles.afterBg), "…plus the vignette");
  ok(styles.afterEvents === "none", "the CRT glass never eats pointer events");
  ok(/radial-gradient/.test(styles.panelBg) && /linear-gradient/.test(styles.panelBg),
    "panel field = phosphor wash over the near-black tube");
  ok(/mono/i.test(styles.rowFont), `mono type on tree rows (${styles.rowFont.split(",")[0]})`);
  ok(styles.ttlTransform === "uppercase" && styles.ttlSpacing > 1,
    `mono uppercase letterspaced header (${styles.ttlTransform}, ${styles.ttlSpacing}px)`);

  // Selection = phosphor tint + inset rail, NOT the solid accent fill.
  // (Default seeding already expands depth<2 — "Plot area" is open; drill one
  // level further into "X axis", then select its "Tick labels" group row.)
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
    return { bg: cs.backgroundColor, shadow: cs.boxShadow, glow: cs.textShadow };
  });
  ok(!!sel, "a selected row exists");
  // Translucent tint (alpha ≪ 1), whatever color space Chrome serializes
  // (oklab from color-mix) — NEVER the old solid accent fill.
  const alphaM = sel && (sel.bg.match(/\/\s*([\d.]+)\s*\)/) || sel.bg.match(/rgba\([^)]+,\s*([\d.]+)\)/));
  const alpha = alphaM ? parseFloat(alphaM[1]) : 1;
  ok(sel && alpha > 0 && alpha < 0.5, `.sel = translucent phosphor tint, not a solid fill (alpha ${alpha}: ${sel?.bg})`);
  ok(sel && /inset/.test(sel.shadow), "…with the inset phosphor rail");
  ok(sel && sel.glow !== "none", "…and a text glow");

  // Dim a row's eye for the screenshot (shows the off state) + evidence shot.
  await page.evaluate(() => {
    [...document.querySelectorAll(".xray .row")]
      .find((r) => (r.querySelector(".rlabel")?.textContent ?? "").trim() === "Gridlines")
      ?.querySelector("button.eye")?.click();
  });
  await sleep(300);
  const clip = await page.evaluate(() => {
    const r = document.querySelector(".xray").getBoundingClientRect();
    return { x: Math.max(0, r.x - 120), y: Math.max(0, r.y - 24), width: Math.min(1500, r.width + 160), height: Math.min(950, r.height + 48) };
  });
  const outPath = `${process.env.FLUX_OUT || "test-results/out"}/xray-theme.png`;
  await page.screenshot({ path: outPath, clip });
  mkdirSync("flux_figure_upgrades_fixes", { recursive: true }); // local evidence dir — not tracked
  copyFileSync(outPath, "flux_figure_upgrades_fixes/evidence-xray.png");
  console.log("  evidence → flux_figure_upgrades_fixes/evidence-xray.png");
  await shot(page, "xray-theme-full");

  // --- reduced motion kills the boot -----------------------------------------
  await page.keyboard.press("Escape");
  await sleep(300);
  await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
  await page.keyboard.down("Alt");
  await page.keyboard.press("KeyP");
  await page.keyboard.up("Alt");
  await sleep(150);
  const reduced = await page.evaluate(() => ({
    anim: getComputedStyle(document.querySelector(".xray"), "::after").animationName,
    running: document.getAnimations().filter((a) => /xr-boot/.test(a.animationName ?? "")).length,
  }));
  ok(reduced.anim === "none" && reduced.running === 0,
    `prefers-reduced-motion disables the boot flicker (animation: ${reduced.anim})`);

  const errs = realErrors(page);
  ok(errs.length === 0, `no console errors (${errs.length})`);
  if (errs.length) console.error(errs.slice(0, 5));
  console.log(fails === 0 ? "\nVERIFY-XRAY-THEME ALL PASS" : `\nVERIFY-XRAY-THEME ${fails} FAILURE(S)`);
} finally {
  await browser.close();
}
process.exit(fails === 0 ? 0 : 1);
