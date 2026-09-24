// The colour picker at every Inspector width (2026-09-24).
//
// Owner report: with a narrow sidebar the picker's spectrum column (name, hex,
// saturation square, hue bar) sat ON TOP of the swatch grid. The picker was a
// fixed grid, `1fr | 204px`, whose swatch rows never wrap, so a sidebar
// narrower than palette + spectrum ran the rows underneath the spectrum. It is
// now a flex wrap: the spectrum stays beside the palette while both fit and
// drops below it, full width, when they do not. Narrower still, swatch rows wrap.
//
// Checked here, for the Inspector's text-colour picker across a sweep of real
// Inspector widths (the --insp-w the user drags), and for the F menu's colour
// mode:
//   • no swatch overlaps the spectrum column and none overflows the picker;
//   • a wide Inspector and the 620 px F menu keep the side-by-side layout,
//     with the 204 px spectrum;
//   • a narrow Inspector stacks the spectrum under the palette at full width.
// Screenshots: colorpicker-narrow-<width>.png.
import { launch, gotoApp, clickMode, shot, realErrors, sleep } from "./lib/driver.mjs";

let fails = 0;
function assert(cond, msg) {
  if (cond) console.log("  ok:", msg);
  else { fails++; console.error("  FAIL:", msg); }
}

// Measured in the page: the geometry of the picker inside `root`.
const geometry = (root) => {
  const host = document.querySelector(root);
  const cs = host?.querySelector(".cs");
  if (!cs) return null;
  const side = cs.querySelector(".side"), left = cs.querySelector(".left");
  const b = (e) => e.getBoundingClientRect();
  const s = b(side), c = b(cs);
  const swatches = [...cs.querySelectorAll(".sw")].map(b);
  return {
    stacked: s.top >= b(left).bottom - 1,
    sideWidth: Math.round(s.width),
    overlap: swatches.some((r) => r.right > s.left && r.left < s.right && r.bottom > s.top && r.top < s.bottom),
    overflow: swatches.some((r) => r.right > c.right + 1),
  };
};

const { browser, page } = await launch({ width: 1600, height: 1000 });
try {
  await gotoApp(page, { url: "http://127.0.0.1:1420/?fixture=demo", settle: 3500 });
  await clickMode(page, "Figure");
  await sleep(700);
  await page.evaluate(() => {
    const F = window.__flux.fig;
    F.commit((p) => {
      p.figures[0].elements = [{ type: "text", id: "cp-t", text: "Label", x: 40, y: 40, width: 100, height: 26, rotation: 0,
        fontFamily: "Arial", fontSize: 18, fontWeight: 400, fontStyle: "normal", align: "left", color: "#111111", sizing: "auto" }];
    });
    F.selectOnly("cp-t");
  });
  await sleep(300);
  await page.evaluate(() => [...document.querySelectorAll("button.swrow")].find((b) => (b.getAttribute("title") ?? "").startsWith("Text colour"))?.click());
  await sleep(400);
  assert(await page.evaluate(() => !!document.querySelector(".inspector .pop .cs")), "the Inspector's text-colour picker opens");

  for (const width of [900, 760, 620, 520, 420, 320, 248]) {
    await page.evaluate((w) => document.querySelector(".inspector").parentElement.style.setProperty("--insp-w", w + "px"), width);
    await sleep(150);
    const g = await page.evaluate(geometry, ".inspector .pop");
    assert(g && !g.overlap && !g.overflow, `Inspector ${width}px: no swatch under the spectrum or past the edge (${JSON.stringify(g)})`);
    if (width >= 760) assert(g && !g.stacked && g.sideWidth === 204, `Inspector ${width}px keeps the spectrum beside the palette at 204px`);
    if (width <= 520) assert(g && g.stacked && g.sideWidth > 204, `Inspector ${width}px stacks the spectrum below the palette, full width`);
    if (width === 520 || width === 248) await shot(page, `colorpicker-narrow-${width}`);
  }

  // The F menu's colour mode is a fixed 620px: it must keep the side-by-side
  // layout it was designed with, for every bundled collection.
  await page.evaluate(() => document.querySelector(".inspector").parentElement.style.removeProperty("--insp-w"));
  await page.evaluate(() => [...document.querySelectorAll(".inspector .pop .tab")].length && document.activeElement?.blur());
  await page.mouse.click(900, 600);
  await page.evaluate(() => window.__flux.fig.selectOnly("cp-t"));
  await sleep(200);
  await page.keyboard.press("f");
  await sleep(400);
  await page.evaluate(() => [...document.querySelectorAll(".colorbtn")][0]?.click());
  await sleep(500);
  assert(await page.evaluate(() => !!document.querySelector(".color-mode .cs")), "the F menu's colour mode opens");
  for (const tab of ["Flexoki", "ColorBrewer", "Paul Tol"]) {
    await page.evaluate((t) => [...document.querySelectorAll(".color-mode .tab")].find((b) => b.textContent.trim() === t)?.click(), tab);
    await sleep(250);
    const g = await page.evaluate(geometry, ".color-mode");
    assert(g && !g.stacked && !g.overlap && !g.overflow, `F menu (${tab}): side by side, nothing overlapping (${JSON.stringify(g)})`);
  }

  const errs = realErrors(page);
  assert(errs.length === 0, `no renderer errors (${errs.slice(0, 2).join(" | ")})`);
} finally {
  await browser.close();
}

console.log(fails === 0 ? "\nCOLORPICKER NARROW: ALL PASS" : `\nCOLORPICKER NARROW: ${fails} FAILURE(S)`);
process.exit(fails === 0 ? 0 : 1);
