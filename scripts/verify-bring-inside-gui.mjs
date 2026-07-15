// Ctrl+Shift+I "bring inside the frame" (GUI wiring over ops.bringInside):
//  - the chord translates every SELECTED element inside the figure frame
//    (minimal move; overlap allowed) without resizing anything;
//  - an oversized element is positioned to fully cover the frame;
//  - unselected elements never move; ONE undo reverts the whole chord;
//  - an empty selection is a silent no-op (no history entry burned);
//  - the post-import state (all new elements selected, some outside the
//    frame — placeIncoming's true-physical-size contract) is exactly the
//    state the chord rescues.
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

  // Seed: a 600×400 frame with three overflowing rects (post-import shape),
  // one compliant rect, one oversized image-stand-in, and one UNSELECTED stray.
  await page.evaluate(() => {
    const F = window.__flux.fig;
    const rect = (id, x, y, w, h, extra = {}) => ({
      type: "rect", id, x, y, width: w, height: h, rotation: 0,
      fill: "#888", stroke: "none", strokeWidth: 0, cornerRadius: 0, ...extra,
    });
    F.commit((p) => {
      const g = p.figures[0];
      g.x = 0;
      g.y = 0;
      g.width = 600;
      g.height = 400;
      g.elements = [
        rect("r-off-right", 700, 100, 120, 90),
        rect("r-off-bl", -80, 500, 120, 90),
        rect("r-in", 20, 20, 120, 90),
        rect("r-big", 900, 900, 800, 600), // larger than the frame on both axes
        rect("r-stray", 1500, 40, 60, 60), // NOT selected — must not move
      ];
    });
    F.selection.set(new Set(["r-off-right", "r-off-bl", "r-in", "r-big"]));
    F.viewport.set({ panX: 60, panY: 60, zoom: 0.8 });
  });
  await waitFor(page, () => window.__flux.get(window.__flux.fig.selection).size === 4, null, {
    label: "post-import selection seeded (4 of 5 elements)",
  });

  const els = () =>
    page.evaluate(() =>
      Object.fromEntries(
        window.__flux
          .figures()[0]
          .elements.map((e) => [e.id, { x: e.x, y: e.y, w: e.width, h: e.height }]),
      ),
    );
  const before = await els();

  // ---- 1. the chord brings the selection inside, resizing nothing ------------
  await page.keyboard.down("Control");
  await page.keyboard.down("Shift");
  await page.keyboard.press("KeyI");
  await page.keyboard.up("Shift");
  await page.keyboard.up("Control");
  await waitFor(page, () => window.__flux.figures()[0].elements.find((e) => e.id === "r-off-right")?.x === 480, null, {
    label: "chord committed the translation",
  });
  const after = await els();
  assert(after["r-off-right"].x === 480 && after["r-off-right"].y === 100, `off-right clamped to the inside edge (${after["r-off-right"].x},${after["r-off-right"].y})`);
  assert(after["r-off-bl"].x === 0 && after["r-off-bl"].y === 310, `off-bottom-left clamped (${after["r-off-bl"].x},${after["r-off-bl"].y})`);
  assert(after["r-in"].x === 20 && after["r-in"].y === 20, "already-inside element did not move");
  assert(after["r-big"].x === 0 && after["r-big"].y === 0, `oversized element covers the frame (${after["r-big"].x},${after["r-big"].y})`);
  assert(after["r-stray"].x === 1500, "UNSELECTED element never moves");
  for (const id of Object.keys(before))
    assert(after[id].w === before[id].w && after[id].h === before[id].h, `${id}: width/height untouched`);
  const inside = (b) => b.x >= 0 && b.y >= 0 && b.x + b.w <= 600 && b.y + b.h <= 400;
  assert(inside(after["r-off-right"]) && inside(after["r-off-bl"]) && inside(after["r-in"]), "every fitting selected element lies inside the frame");
  await shot(page, "bring-inside-after");

  // ---- 2. ONE undo reverts the whole chord ------------------------------------
  await page.evaluate(() => window.__flux.fig.undo());
  await waitFor(page, () => window.__flux.figures()[0].elements.find((e) => e.id === "r-off-right")?.x === 700, null, {
    label: "undo restored the pre-chord positions",
  });
  const undone = await els();
  assert(JSON.stringify(undone) === JSON.stringify(before), "ONE undo restores every element exactly");

  // ---- 3. empty selection = silent no-op --------------------------------------
  await page.evaluate(() => window.__flux.fig.clearSelection());
  const beforeNoop = await els();
  await page.keyboard.down("Control");
  await page.keyboard.down("Shift");
  await page.keyboard.press("KeyI");
  await page.keyboard.up("Shift");
  await page.keyboard.up("Control");
  await new Promise((res) => setTimeout(res, 250)); // annotated sleep: proving the ABSENCE of a commit — nothing to condition-wait on
  assert(JSON.stringify(await els()) === JSON.stringify(beforeNoop), "empty selection: the chord is a no-op");

  const errs = realErrors(page);
  assert(errs.length === 0, `no console errors (${errs.length})`);
  if (errs.length) console.error(errs.slice(0, 5));
  console.log(fails === 0 ? "\nVERIFY-BRING-INSIDE-GUI ALL PASS" : `\nVERIFY-BRING-INSIDE-GUI ${fails} FAILURE(S)`);
} finally {
  await browser.close();
}
process.exit(fails === 0 ? 0 : 1);
