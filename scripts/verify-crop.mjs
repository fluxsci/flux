// figure-v1 P5 — the crop GESTURE, end to end in a real browser:
//   • ctrl+drag the E resize handle of a selected fluxplot inward → ONE commit
//     {x,y,width,height,crop}: the element box narrows, the crop window is set,
//     and a chosen part's SCREEN rect is UNMOVED (content pinned — the whole
//     point of Figma-style crop);
//   • mid-drag affordance: the full-content GHOST + clipped live copy + "Crop"
//     chip are on the overlay (screenshot);
//   • Esc mid-drag aborts with NO model change (and the ghost leaves);
//   • the live mount's viewBox = the crop sub-rect; the exported figure SVG
//     carries the same cropped viewBox (figureToSvg + plotToSvgMarkup path);
//   • ONE undo reverts the whole crop commit;
//   • Inspector "Reset crop" restores the original full-content box;
//   • a cropped PNG ImageElement renders as a nested-svg viewport in the scene.
//
//   Run (dev server on :1420): node scripts/verify-crop.mjs
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
const near = (a, b, tol = 1.5) => typeof a === "number" && Math.abs(a - b) <= tol;

const SVG = readFileSync("scripts/fixtures/pre-regen/06_scatter_regression.svg", "utf8");
const MANIFEST = JSON.parse(readFileSync("scripts/fixtures/pre-regen/06_scatter_regression.fluxplot.json", "utf8"));
const PART = "axis.x.ticklabel.2";
// 1×1 transparent PNG
const PNG_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const { browser, page } = await launch({ width: 1440, height: 900 });
try {
  await gotoApp(page, { url: "http://127.0.0.1:1420/?fixture=demo", settle: 3500 });
  await clickMode(page, "Figure");
  await sleep(700);

  // Seed: the fluxplot at its PHYSICAL size (504pt → 672 CSS px wide) so
  // kx = 1 (1 canvas px == 1 intrinsic px at zoom 1), plus the asset records
  // the crop gesture needs (assetDisplaySize) and a cropped PNG image element.
  // (Two evaluates: the async import first — a large-args async evaluate can
  // lose its promise to a Vite dep-optimizer reload; the model seed is sync.)
  await page.evaluate(async (pngUrl) => {
    const assets = await import("/src/lib/assets.ts");
    assets.setAssetData("png1", pngUrl);
  }, PNG_URL);
  await page.evaluate(
    (svg, manifest) => {
      const F = window.__flux.fig;
      window.__flux.io.reimportPlot("part-asset", svg, manifest);
      F.commit((p) => {
        const g = p.figures[0];
        g.x = 0;
        g.y = 0;
        g.width = 900;
        g.height = 700;
        g.elements = [];
        p.assets = [
          { id: "part-asset", name: "part.svg", kind: "svg", path: "assets/part-asset.svg", naturalWidth: 672, naturalHeight: 480 },
          { id: "png1", name: "shot.png", kind: "png", path: "assets/png1.png", naturalWidth: 320, naturalHeight: 160 },
        ];
        g.elements.push({
          type: "plot",
          id: "plot1",
          x: 40,
          y: 40,
          width: 672,
          height: 480,
          rotation: 0,
          assetId: "part-asset",
          overrides: {},
        });
        g.elements.push({
          type: "image",
          id: "img1",
          x: 740,
          y: 560,
          width: 100,
          height: 50,
          rotation: 0,
          assetId: "png1",
          crop: { x: 20, y: 10, width: 100, height: 50 },
        });
      });
      F.selectOnly("plot1");
      F.viewport.set({ panX: 120, panY: 120, zoom: 1 });
    },
    SVG,
    MANIFEST,
  );
  await sleep(500);

  const partRect = () =>
    page.evaluate((part) => {
      const n = document.getElementById(`plot1__${part}`);
      if (!n) return null;
      const r = n.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    }, PART);
  const model = () =>
    page.evaluate(() => {
      const el = window.__flux.figures().flatMap((f) => f.elements).find((e) => e.id === "plot1");
      return { x: el.x, y: el.y, w: el.width, h: el.height, crop: el.crop ?? null };
    });

  const r0 = await partRect();
  assert(r0 && r0.w > 0, "plot mounted; reference part rect measured");
  const m0 = await model();
  assert(m0.x === 40 && m0.w === 672 && m0.crop === null, "seeded plot at physical size, uncropped");

  // The E resize handle, measured from the real DOM (the overlay svg lives
  // inside the canvas host — page coords include the left panel offset).
  const eHandle = () =>
    page.evaluate(() => {
      const hs = [...document.querySelectorAll("svg.overlay-svg rect.handle")].map((h) => {
        const r = h.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      });
      if (hs.length !== 8) return null;
      const ys = hs.map((h) => h.y).sort((a, b) => a - b);
      const midY = ys[3]; // the E/W handles sit at the middle row
      const row = hs.filter((h) => Math.abs(h.y - midY) < 2);
      row.sort((a, b) => b.x - a.x);
      return row[0]; // rightmost = E
    });

  // ---- 1. ctrl+drag the E handle inward 200 px → crop, content pinned ----
  const h1 = await eHandle();
  assert(h1, `E handle located (${h1?.x},${h1?.y})`);
  await page.keyboard.down("Control");
  await page.mouse.move(h1.x, h1.y);
  await page.mouse.down();
  await page.mouse.move(h1.x - 100, h1.y, { steps: 5 });
  await sleep(120);

  // mid-drag affordance: ghost + clipped live copy + Crop chip
  const mid = await page.evaluate(() => ({
    ghost: !!document.getElementById("plot1-cropghost__figure"),
    live: !!document.getElementById("plot1-croplive__figure"),
    chip: [...document.querySelectorAll("text.crop-chip")].some((t) => /crop/i.test(t.textContent ?? "")),
    origHidden:
      document.getElementById("plot1__figure")?.closest("g.el")?.style.visibility === "hidden",
  }));
  assert(mid.ghost, "mid-drag: full-content GHOST mounted on the overlay");
  assert(mid.live, "mid-drag: clipped live copy mounted (the cropped preview)");
  assert(mid.chip, 'mid-drag: "Crop" chip follows the pointer');
  assert(mid.origHidden, "mid-drag: scene original hidden (gestureHiddenIds)");
  await shot(page, "crop-01-middrag");

  await page.mouse.move(h1.x - 200, h1.y, { steps: 5 });
  await sleep(80);
  await page.mouse.up();
  await page.keyboard.up("Control");
  await sleep(500);

  let m = await model();
  assert(near(m.w, 472, 0.5) && m.x === 40 && m.h === 480, `E crop: width 672→472, x/height unchanged (got ${m.w}, x=${m.x})`);
  assert(m.crop && near(m.crop.x, 0, 0.5) && near(m.crop.width, 472, 0.5) && near(m.crop.height, 480, 0.5), `el.crop set to the window (got ${JSON.stringify(m.crop)})`);
  const r1 = await partRect();
  assert(r1 && near(r1.x, r0.x, 1) && near(r1.y, r0.y, 1) && near(r1.w, r0.w, 1), "content PINNED: the part's screen rect is unmoved by the crop");
  const vb = await page.evaluate(() => document.getElementById("plot1__figure")?.closest("svg")?.getAttribute("viewBox") ?? "");
  assert(vb === "0 0 354 360", `live mount viewBox = the crop sub-rect in svg units (got "${vb}")`);
  const ghostGone = await page.evaluate(() => !document.getElementById("plot1-cropghost__figure"));
  assert(ghostGone, "overlay ghost cleaned up after commit");
  await shot(page, "crop-02-committed");

  // ---- 2. exported figure SVG carries the cropped viewBox ----
  const svgOut = await page.evaluate(async () => {
    const { figureToSvg } = await import("/src/lib/export.ts");
    const { plotToSvgMarkup } = await import("/src/lib/plot/export.ts");
    const { assetDisplaySize } = await import("/src/lib/ops.ts");
    const p = window.__flux.get(window.__flux.fig.project);
    return figureToSvg(
      p.figures[0],
      () => undefined,
      (el) => (el.type === "plot" ? (plotToSvgMarkup(el) ?? undefined) : undefined),
      (id) => assetDisplaySize(p, id) ?? undefined,
    );
  });
  assert(svgOut.includes('viewBox="0 0 354 360"'), "exported figure SVG contains the cropped viewBox");
  assert(/overflow="hidden"/.test(svgOut), "exported plot clips (overflow hidden)");

  // ---- 3. ONE undo reverts the whole crop commit ----
  await page.evaluate(() => window.__flux.fig.undo());
  await sleep(400);
  m = await model();
  assert(m.crop === null && m.w === 672 && m.x === 40, "ONE undo reverts the crop commit (window + box)");
  const rU = await partRect();
  assert(rU && near(rU.x, r0.x, 1), "part rect back at the reference after undo");

  // ---- 4. Esc mid-drag aborts with no model change ----
  const h2 = await eHandle();
  assert(h2, "E handle re-located after undo");
  await page.keyboard.down("Control");
  await page.mouse.move(h2.x, h2.y);
  await page.mouse.down();
  await page.mouse.move(h2.x - 130, h2.y, { steps: 4 });
  await sleep(100);
  const midGhost = await page.evaluate(() => !!document.getElementById("plot1-cropghost__figure"));
  await page.keyboard.press("Escape");
  await sleep(150);
  await page.mouse.up();
  await page.keyboard.up("Control");
  await sleep(400);
  m = await model();
  assert(midGhost, "Esc test: drag was live (ghost present) before Escape");
  assert(m.crop === null && m.w === 672 && m.x === 40, "Esc mid-drag: NO model change");
  const escGhost = await page.evaluate(() => !!document.getElementById("plot1-cropghost__figure"));
  assert(!escGhost, "Esc mid-drag: overlay ghost dropped");

  // ---- 5. Inspector: cropped-from note + Reset crop restores the box ----
  await page.evaluate(async () => {
    const ops = await import("/src/lib/ops.ts");
    window.__flux.fig.commit((p) => ops.setCrop(p, "plot1", { x: 100, y: 60, width: 300, height: 200 }));
  });
  await sleep(400);
  m = await model();
  assert(near(m.x, 140) && near(m.w, 300) && m.crop && near(m.crop.x, 100), "setCrop op from the page: box framed the window (content pinned)");
  const note = await page.evaluate(() => {
    const el = [...document.querySelectorAll(".note.phys")].find((n) => /cropped from/i.test(n.textContent ?? ""));
    return el ? el.textContent?.replace(/\s+/g, " ").trim() : null;
  });
  assert(note && /cropped from 177\.8 × 127\.0 mm/.test(note), `Inspector shows "cropped from W×H mm" (got: ${note})`);
  const clicked = await page.evaluate(() => {
    const b = [...document.querySelectorAll("button.true-size")].find((x) => /reset crop/i.test(x.textContent ?? ""));
    if (!b) return false;
    b.click();
    return true;
  });
  assert(clicked, "Inspector Reset crop button present + clicked");
  await sleep(400);
  m = await model();
  assert(m.crop === null && m.x === 40 && near(m.w, 672), "Reset crop restores the original full-content box");

  // ---- 5b. FluxFigMenu: 'v' = reset crop action for cropped elements ----
  await page.evaluate(async () => {
    const ops = await import("/src/lib/ops.ts");
    window.__flux.fig.commit((p) => ops.setCrop(p, "plot1", { x: 50, y: 40, width: 400, height: 300 }));
  });
  await sleep(300);
  await page.keyboard.press("f");
  await sleep(450);
  const menuField = await page.evaluate(() => {
    const m = document.querySelector(".fluxFigMenu");
    if (!m) return null;
    return /reset crop/i.test(m.textContent ?? "");
  });
  assert(menuField === true, "FluxFig Menu lists the 'reset crop' action for a cropped element");
  await page.keyboard.press("v");
  await sleep(400);
  m = await model();
  assert(m.crop === null && m.x === 40 && near(m.w, 672), "menu 'v' resets the crop (full box back)");
  const fieldGone = await page.evaluate(() => !/reset crop/i.test(document.querySelector(".fluxFigMenu")?.textContent ?? ""));
  assert(fieldGone, "the action disappears with the crop");
  await page.keyboard.press("Escape");
  await sleep(250);

  // ---- 6. cropped PNG ImageElement renders as a nested-svg viewport ----
  const png = await page.evaluate(() => {
    const nested = [...document.querySelectorAll('svg.scene-svg svg[viewBox="20 10 100 50"]')][0];
    if (!nested) return null;
    const img = nested.querySelector("image");
    return {
      par: nested.getAttribute("preserveAspectRatio"),
      w: img?.getAttribute("width"),
      h: img?.getAttribute("height"),
    };
  });
  assert(png && png.par === "none", "cropped PNG: nested svg viewport with viewBox = the window in the scene DOM");
  assert(png && png.w === "320" && png.h === "160", "cropped PNG: full display-size image inside the viewport");

  const errs = realErrors(page);
  assert(errs.length === 0, `no console errors (${errs.length})`);
  if (errs.length) console.error(errs.slice(0, 5));
  console.log(fails === 0 ? "\nVERIFY-CROP ALL PASS" : `\nVERIFY-CROP ${fails} FAILURE(S)`);
} finally {
  await browser.close();
}
process.exit(fails === 0 ? 0 : 1);
