// Cascade popover (Ctrl+Shift+C) — GUI wiring over ops.cascadeElements:
//  - the chord opens the popover on a ≥2-unit selection; the owner's sketch
//    example (rotation +25, first NOT fixed) live-previews 25/50/75/100;
//  - the whole tuning session is ONE undo entry (Enter keeps it, one undo
//    reverts everything);
//  - Esc rolls the session back and leaves NO history entry;
//  - the Order dropdown re-ranks (Left→right) and First-stays-fixed pins
//    rank 0;
//  - a color ramp on fill steps hue per rank;
//  - the "n of m apply" header reflects per-type applicability (width on a
//    selection containing a path);
//  - clicking outside the popover applies (Enter semantics), never abandons.
import { launch, gotoApp, clickMode, realErrors, shot, waitFor } from "./lib/driver.mjs";

let fails = 0;
function assert(cond, msg) {
  if (cond) console.log("  ok:", msg);
  else {
    fails++;
    console.error("  FAIL:", msg);
  }
}

const { browser, page } = await launch({ width: 1440, height: 900 });
try {
  await gotoApp(page, { url: "http://127.0.0.1:1420/?fixture=demo", settle: 3500 });
  await clickMode(page, "Figure");
  await waitFor(page, () => !!(window.__flux?.fig && window.__flux.figures().length && document.querySelector(".canvas-host")), null, {
    timeout: 15000,
    label: "figure mode ready",
  });

  // Seed: 4 rects whose SELECTION order (r1..r4) differs from x order
  // (r2,r4,r1,r3), plus one path (width-ineligible) left unselected for now.
  await page.evaluate(() => {
    const F = window.__flux.fig;
    const rect = (id, x) => ({
      type: "rect", id, x, y: 120, width: 40, height: 160, rotation: 0,
      fill: "#ff0000", stroke: "#334455", strokeWidth: 2, cornerRadius: 0,
    });
    F.commit((p) => {
      const g = p.figures[0];
      g.x = 0; g.y = 0; g.width = 900; g.height = 700;
      g.elements = [
        rect("r1", 200), rect("r2", 100), rect("r3", 250), rect("r4", 150),
        { type: "path", id: "pth", x: 400, y: 120, width: 80, height: 80, rotation: 0,
          d: "M 0 0 L 80 80", fill: "none", stroke: "#000000", strokeWidth: 2, closed: false },
      ];
    });
    F.selection.set(new Set(["r1", "r2", "r3", "r4"]));
    F.viewport.set({ panX: 40, panY: 40, zoom: 0.9 });
  });
  const past = () => page.evaluate(() => window.__flux.fig.historyStats().past);
  const rots = () => page.evaluate(() => ["r1", "r2", "r3", "r4"].map((id) => window.__flux.figures()[0].elements.find((e) => e.id === id).rotation));
  const xs = () => page.evaluate(() => ["r1", "r2", "r3", "r4"].map((id) => window.__flux.figures()[0].elements.find((e) => e.id === id).x));
  const chord = async () => {
    await page.keyboard.down("Control");
    await page.keyboard.down("Shift");
    await page.keyboard.press("KeyC");
    await page.keyboard.up("Shift");
    await page.keyboard.up("Control");
  };
  const setNum = (sel, v) =>
    page.evaluate(
      ([sel, v]) => {
        const el = document.querySelector(sel);
        const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
        desc.set.call(el, String(v));
        el.dispatchEvent(new Event("input", { bubbles: true }));
      },
      [sel, v],
    );
  const popOpen = () => page.evaluate(() => !!document.querySelector(".cascade-pop"));

  // ---- 1. the owner's sketch: rotation +25, first NOT fixed --------------------
  const past0 = await past();
  await chord();
  await waitFor(page, () => !!document.querySelector(".cascade-pop"), null, { label: "chord opens the popover" });
  await page.select(".cascade-pop select.prop", "rotation");
  await setNum(".cascade-pop input.delta", 25);
  await waitFor(page, () => window.__flux.figures()[0].elements.find((e) => e.id === "r4")?.rotation === 100, null, {
    label: "live preview applied",
  });
  assert(JSON.stringify(await rots()) === JSON.stringify([25, 50, 75, 100]), `rotation +25 live-previews 25/50/75/100 (got ${await rots()})`);
  assert((await past()) === past0 + 1, "the tuning session is ONE history entry");
  await shot(page, "cascade-preview");
  await page.keyboard.press("Enter");
  await waitFor(page, () => !document.querySelector(".cascade-pop"), null, { label: "Enter closes the popover" });
  assert(JSON.stringify(await rots()) === JSON.stringify([25, 50, 75, 100]), "Enter keeps the cascaded values");
  assert((await past()) === past0 + 1, "…still exactly one entry after apply");
  await page.evaluate(() => window.__flux.fig.undo());
  assert(JSON.stringify(await rots()) === JSON.stringify([0, 0, 0, 0]), "ONE undo reverts the whole cascade");

  // ---- 2. Esc rolls back and burns no entry -------------------------------------
  const past1 = await past();
  await chord();
  await waitFor(page, () => !!document.querySelector(".cascade-pop"), null, { label: "reopened for the Esc path" });
  await page.select(".cascade-pop select.prop", "rotation");
  await setNum(".cascade-pop input.delta", 25);
  await waitFor(page, () => window.__flux.figures()[0].elements.find((e) => e.id === "r1")?.rotation === 25, null, {
    label: "Esc-path preview applied",
  });
  await page.keyboard.press("Escape");
  await waitFor(page, () => !document.querySelector(".cascade-pop"), null, { label: "Esc closes the popover" });
  assert(JSON.stringify(await rots()) === JSON.stringify([0, 0, 0, 0]), "Esc reverts the preview");
  assert((await past()) === past1, "Esc leaves NO history entry");

  // ---- 3. order override (Left→right) + first stays fixed ------------------------
  await chord();
  await waitFor(page, () => !!document.querySelector(".cascade-pop"), null, { label: "reopened for the order test" });
  await page.select(".cascade-pop select.prop", "x"); // the popover retains the last-used property
  await page.click(".cascade-pop label.ff input");
  await page.select(".cascade-pop select.ord", "x");
  await setNum(".cascade-pop input.delta", 30);
  await waitFor(page, () => window.__flux.figures()[0].elements.find((e) => e.id === "r3")?.x === 340, null, {
    label: "x-order preview applied",
  });
  assert(JSON.stringify(await xs()) === JSON.stringify([260, 100, 340, 180]), `Left→right + first-fixed ranks by position (got ${await xs()})`);
  await page.keyboard.press("Escape");

  // ---- 4. color ramp on fill -------------------------------------------------------
  await chord();
  await waitFor(page, () => !!document.querySelector(".cascade-pop"), null, { label: "reopened for the color test" });
  await page.select(".cascade-pop select.prop", "fill");
  await waitFor(page, () => !!document.querySelector(".cascade-pop input.dh"), null, { label: "color deltas shown for a color prop" });
  await setNum(".cascade-pop input.dh", 40);
  await waitFor(page, () => window.__flux.figures()[0].elements.find((e) => e.id === "r1")?.fill !== "#ff0000", null, {
    label: "hue ramp previewed",
  });
  const fills = await page.evaluate(() => ["r1", "r2", "r3", "r4"].map((id) => window.__flux.figures()[0].elements.find((e) => e.id === id).fill));
  assert(new Set(fills).size === 4, `each rank gets a distinct hue (${fills.join(" ")})`);
  await page.keyboard.press("Escape");

  // ---- 5. "n of m apply" with a width-ineligible path ---------------------------------
  await page.evaluate(() => window.__flux.fig.selection.set(new Set(["r1", "r2", "r3", "r4", "pth"])));
  await chord();
  await waitFor(page, () => !!document.querySelector(".cascade-pop"), null, { label: "reopened with the path selected" });
  await page.select(".cascade-pop select.prop", "width");
  const hdr = await page.evaluate(() => document.querySelector(".cascade-pop .n")?.textContent?.replace(/\s+/g, " ").trim());
  assert(/5 units\s*· 4 apply/.test(hdr ?? ""), `header shows the reduced applicability (got "${hdr}")`);
  await page.keyboard.press("Escape");
  await page.evaluate(() => window.__flux.fig.selection.set(new Set(["r1", "r2", "r3", "r4"])));

  // ---- 6. outside click = apply-and-close ----------------------------------------------
  const past2 = await past();
  await chord();
  await waitFor(page, () => !!document.querySelector(".cascade-pop"), null, { label: "reopened for the outside-click test" });
  await page.select(".cascade-pop select.prop", "rotation");
  await setNum(".cascade-pop input.delta", 10);
  await waitFor(page, () => window.__flux.figures()[0].elements.find((e) => e.id === "r4")?.rotation === 40, null, {
    label: "outside-click-path preview applied",
  });
  await page.mouse.click(300, 780); // canvas, well below the popover
  await waitFor(page, () => !document.querySelector(".cascade-pop"), null, { label: "outside click closes the popover" });
  assert(JSON.stringify(await rots()) === JSON.stringify([10, 20, 30, 40]), "outside click APPLIES the preview (Enter semantics)");
  assert((await past()) === past2 + 1, "…as one history entry");
  await page.evaluate(() => window.__flux.fig.undo());

  assert(!(await popOpen()), "popover closed at the end");
  const errs = realErrors(page);
  assert(errs.length === 0, `no console errors (${errs.length})`);
  if (errs.length) console.error(errs.slice(0, 5));
  console.log(fails === 0 ? "\nVERIFY-CASCADE-GUI ALL PASS" : `\nVERIFY-CASCADE-GUI ${fails} FAILURE(S)`);
} finally {
  await browser.close();
}
process.exit(fails === 0 ? 0 : 1);
