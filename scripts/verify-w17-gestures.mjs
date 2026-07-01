// W17 figure gesture/undo fixes:
//  • FIG-5: undo snapshots no longer clone the bundled Flexoki colorGroups — undo
//    still works and the palette survives (re-attached on restore).
//  • FIG-9: alt-drag duplicates on the FIRST MOVE, so an alt-CLICK with no drag
//    leaves nothing behind (no stray copy, no history entry); an alt-DRAG does copy.
import { launch, gotoApp, clickMode, sleep, realErrors } from "./lib/driver.mjs";

const { browser, page } = await launch();
await gotoApp(page, { url: "http://127.0.0.1:1420/?fixture=demo", settle: 3200 });
await clickMode(page, "Figure");
await sleep(1000);

// Seed a big, easy-to-hit rect in the active figure and return its screen rect.
const target = await page.evaluate(async () => {
  const F = window.__flux;
  const figId = F.get(F.fig.activeFigureId) ?? F.figures()[0].id;
  F.fig.commit((p) => {
    const f = p.figures.find((x) => x.id === figId);
    f.elements.push({ type: "rect", id: "w17rect", x: 40, y: 40, width: 300, height: 220, rotation: 0, fill: "#4488cc" });
  });
  await new Promise((r) => requestAnimationFrame(r));
  // Find the just-added element's on-screen box.
  const els = [...document.querySelectorAll(".scene .el")];
  const g = els[els.length - 1];
  const b = g.getBoundingClientRect();
  return { cx: b.x + b.width / 2, cy: b.y + b.height / 2 };
});

const countEls = () =>
  page.evaluate(() => window.__flux.figures().reduce((a, f) => a + f.elements.length, 0));

// --- FIG-5: undo keeps colorGroups + reverts the edit ------------------------
const fig5 = await page.evaluate(() => {
  const F = window.__flux;
  // Seed a palette so we can prove it SURVIVES undo (the snapshot excludes it and
  // restore() re-attaches the live value — if that were broken it'd come back empty).
  F.fig.commit((p) => {
    p.colorGroups = [
      { name: "a", colors: [] },
      { name: "b", colors: [] },
      { name: "c", colors: [] },
    ];
  });
  const groupsBefore = (F.get(F.fig.project).colorGroups ?? []).length;
  const nameBefore = F.figures()[0].name;
  F.fig.commit((p) => (p.figures[0].name = "W17 edited"));
  const editedName = F.figures()[0].name;
  F.fig.undo();
  const groupsAfter = (F.get(F.fig.project).colorGroups ?? []).length;
  const nameAfter = F.figures()[0].name;
  return { groupsBefore, groupsAfter, nameBefore, editedName, nameAfter };
});

// --- FIG-9: alt-click (no drag) must NOT duplicate --------------------------
const beforeClick = await countEls();
await page.keyboard.down("Alt");
await page.mouse.move(target.cx, target.cy);
await page.mouse.down();
await page.mouse.up(); // no movement between down and up
await page.keyboard.up("Alt");
await sleep(150);
const afterClick = await countEls();

// --- FIG-9: alt-DRAG must duplicate -----------------------------------------
await page.keyboard.down("Alt");
await page.mouse.move(target.cx, target.cy);
await page.mouse.down();
await page.mouse.move(target.cx + 60, target.cy + 50, { steps: 6 });
await page.mouse.up();
await page.keyboard.up("Alt");
await sleep(150);
const afterDrag = await countEls();

const out = {
  fig5,
  fig9: { beforeClick, afterClick, afterDrag },
  errs: realErrors(page),
};
console.log(JSON.stringify(out, null, 2));
await browser.close();

const pass =
  fig5.groupsBefore > 0 &&
  fig5.groupsAfter === fig5.groupsBefore && // palette survived undo
  fig5.editedName === "W17 edited" &&
  fig5.nameAfter === fig5.nameBefore && // undo reverted the edit
  afterClick === beforeClick && // FIG-9: alt-click left nothing
  afterDrag > beforeClick && // FIG-9: alt-drag duplicated
  out.errs.length === 0;
console.log(pass ? "\nW17 GESTURES VERIFY: PASS" : "\nW17 GESTURES VERIFY: FAIL");
process.exit(pass ? 0 : 1);
