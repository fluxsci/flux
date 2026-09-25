// The colour picker at every Inspector width (2026-09-24; conventions 2026-09-25).
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
// Every wait is a condition (guide §7): the picker being open, the selected tab
// being on, a frame having painted after a width write. Screenshots:
// colorpicker-narrow-<width>.png.
import { launch, gotoApp, clickMode, shot, realErrors, waitFor, waitForSelector, waitForFrame, APP_URL } from "./lib/driver.mjs";
import { harness } from "./lib/harness.mjs";

const h = harness("verify-colorpicker-narrow");

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
  await gotoApp(page, { url: APP_URL + "?fixture=demo" });
  await clickMode(page, "Figure");
  await waitFor(page, () => !!window.__flux?.fig && !!document.querySelector(".canvas-host"), null, { label: "Figure editor mounted" });
  await page.evaluate(() => {
    const F = window.__flux.fig;
    F.commit((p) => {
      p.figures[0].elements = [{ type: "text", id: "cp-t", text: "Label", x: 40, y: 40, width: 100, height: 26, rotation: 0,
        fontFamily: "Arial", fontSize: 18, fontWeight: 400, fontStyle: "normal", align: "left", color: "#111111", sizing: "auto" }];
    });
    F.selectOnly("cp-t");
  });
  // The Inspector shows the text rows once the selection has landed.
  await waitFor(page, () => [...document.querySelectorAll("button.swrow")].some((b) => (b.getAttribute("title") ?? "").startsWith("Text colour")), null, { label: "Inspector shows the Text colour row" });
  await page.evaluate(() => [...document.querySelectorAll("button.swrow")].find((b) => (b.getAttribute("title") ?? "").startsWith("Text colour"))?.click());
  await waitForSelector(page, ".inspector .pop .cs", { label: "the text-colour picker opens" });
  h.ok(true, "the Inspector's text-colour picker opens");

  for (const width of [900, 760, 620, 520, 420, 320, 248]) {
    await page.evaluate((w) => document.querySelector(".inspector").parentElement.style.setProperty("--insp-w", w + "px"), width);
    await waitForFrame(page); // the layout has painted at the new width
    const g = await page.evaluate(geometry, ".inspector .pop");
    h.ok(g && !g.overlap && !g.overflow, `Inspector ${width}px: no swatch under the spectrum or past the edge (${JSON.stringify(g)})`);
    if (width >= 760) h.ok(g && !g.stacked && g.sideWidth === 204, `Inspector ${width}px keeps the spectrum beside the palette at 204px`);
    if (width <= 520) h.ok(g && g.stacked && g.sideWidth > 204, `Inspector ${width}px stacks the spectrum below the palette, full width`);
    if (width === 520 || width === 248) await shot(page, `colorpicker-narrow-${width}`);
  }

  // The F menu's colour mode is a fixed 620px: it must keep the side-by-side
  // layout it was designed with, for every bundled collection.
  await page.evaluate(() => document.querySelector(".inspector").parentElement.style.removeProperty("--insp-w"));
  await page.evaluate(() => document.activeElement?.blur());
  await page.mouse.click(900, 600); // an empty canvas spot: closes the picker, clears the selection
  await waitFor(page, () => !document.querySelector(".inspector .pop .cs"), null, { label: "the Inspector picker closed" });
  await page.evaluate(() => window.__flux.fig.selectOnly("cp-t"));
  await waitFor(page, () => window.__flux.get(window.__flux.fig.selection).has("cp-t"), null, { label: "the text box is selected again" });
  await page.keyboard.press("f");
  await waitForSelector(page, ".colorbtn", { label: "the F menu opens with a colour button" });
  await page.evaluate(() => [...document.querySelectorAll(".colorbtn")][0]?.click());
  await waitForSelector(page, ".color-mode .cs", { label: "the F menu's colour mode opens" });
  h.ok(true, "the F menu's colour mode opens");
  for (const tab of ["Flexoki", "ColorBrewer", "Paul Tol"]) {
    await page.evaluate((t) => [...document.querySelectorAll(".color-mode .tab")].find((b) => b.textContent.trim() === t)?.click(), tab);
    await waitFor(page, (t) => [...document.querySelectorAll(".color-mode .tab")].some((b) => b.textContent.trim() === t && b.getAttribute("aria-selected") === "true"), tab, { label: `${tab} tab selected` });
    await waitForFrame(page);
    const g = await page.evaluate(geometry, ".color-mode");
    h.ok(g && !g.stacked && !g.overlap && !g.overflow, `F menu (${tab}): side by side, nothing overlapping (${JSON.stringify(g)})`);
  }

  h.eq(realErrors(page), [], "clean browser console");
} catch (error) {
  h.fail(String(error));
  console.error(error);
}
await h.done(() => browser.close());
