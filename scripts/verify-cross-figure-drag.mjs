// Cross-figure drag + Ctrl+X cut (2026-09-25). Drives the REAL gestures on the
// demo fixture: an element dragged from one figure and released over another
// figure's frame joins that figure (world position kept, captions follow, the
// target frame lit while the cursor is over it, ONE undo entry); Ctrl+X puts
// the editable selection on the clipboard and removes it, so a paste brings
// back exactly what was cut and nothing that stayed (a locked unit).
import { launch, gotoApp, clickMode, shot, realErrors, sleep } from "./lib/driver.mjs";
import { waitFor } from "./lib/wait.mjs";
import { harness } from "./lib/harness.mjs";

const h = harness("verify-cross-figure-drag");
const { browser, page } = await launch();
try {
  await gotoApp(page, { url: "http://127.0.0.1:1420/?fixture=demo", settle: 3000 });
  await clickMode(page, "Figure");
  await sleep(700);

  const state = () =>
    page.evaluate(() => {
      const F = window.__flux;
      const p = F.get(F.fig.project);
      return {
        active: F.get(F.fig.activeFigureId),
        selection: [...F.get(F.fig.selection)],
        droptargets: document.querySelectorAll(".figure-bg.droptarget").length,
        figures: p.figures.map((f) => ({
          id: f.id, x: f.x, y: f.y,
          els: f.elements.map((e) => ({ id: e.id, type: e.type, x: e.x, y: e.y, fill: e.fill, groupId: e.groupId, locked: e.locked })),
          captions: f.captions ?? {},
          groups: f.groups ?? {},
        })),
      };
    });

  // A second figure, below the first (the store's duplicate places it there).
  const dupId = await page.evaluate(() => {
    const F = window.__flux;
    F.fig.duplicateFigure("growth");
    const p = F.get(F.fig.project);
    const dup = p.figures.find((f) => f.id !== "growth");
    F.fig.selectedFrameId.set(null);
    F.fig.activeFigureId.set("growth");
    F.fig.selection.set(new Set(["el-a-rect", "el-a"]));
    return dup.id;
  });
  let s0 = await state();
  h.ok(s0.figures.length === 2 && s0.figures[1].id === dupId, "fixture: two figures on the canvas");
  const src0 = s0.figures.find((f) => f.id === "growth");
  const dst0 = s0.figures.find((f) => f.id === dupId);
  h.ok(dst0.y > src0.y + 300, `fixture: the duplicate sits below the source (y=${dst0.y})`);

  // Screen coordinates of the rect's centre in the source and of the same
  // local spot inside the destination frame (a pure vertical drag).
  const pts = await page.evaluate(({ dupId }) => {
    const F = window.__flux;
    const vp = F.get(F.fig.viewport);
    const p = F.get(F.fig.project);
    const src = p.figures.find((f) => f.id === "growth");
    const dst = p.figures.find((f) => f.id === dupId);
    const el = src.elements.find((e) => e.id === "el-a-rect");
    const host = document.querySelector(".canvas-host").getBoundingClientRect();
    const toScreen = (wx, wy) => ({ x: host.left + vp.panX + wx * vp.zoom, y: host.top + vp.panY + wy * vp.zoom });
    return {
      from: toScreen(src.x + el.x + el.width / 2, src.y + el.y + el.height / 2),
      stillHome: toScreen(src.x + el.x + el.width / 2 + 10, src.y + el.y + el.height / 2 + 10),
      to: toScreen(dst.x + el.x + el.width / 2, dst.y + el.y + el.height / 2),
      zoom: vp.zoom,
      el: { x: el.x, y: el.y },
    };
  }, { dupId });

  // --- 1. the drag: frame feedback mid-gesture, re-parent on release ---
  await page.mouse.move(pts.from.x, pts.from.y);
  await page.mouse.down();
  await page.mouse.move(pts.stillHome.x, pts.stillHome.y, { steps: 4 });
  await sleep(60);
  let mid = await state();
  h.eq(mid.droptargets, 0, "over its own figure nothing is lit");
  await page.mouse.move(pts.to.x, pts.to.y, { steps: 12 });
  await sleep(80);
  mid = await state();
  h.eq(mid.droptargets, 1, "the other figure's frame lights up while the cursor is over it");
  h.ok(mid.figures.find((f) => f.id === "growth").els.some((e) => e.id === "el-a-rect"), "mid-drag the model is untouched (transient move)");
  await shot(page, "cross-figure-mid-drag");
  await page.mouse.up();
  await sleep(200);

  const s1 = await state();
  const src1 = s1.figures.find((f) => f.id === "growth");
  const dst1 = s1.figures.find((f) => f.id === dupId);
  const rect1 = dst1.els.find((e) => e.id === "el-a-rect");
  const lbl1 = dst1.els.find((e) => e.id === "el-a");
  h.ok(!src1.els.some((e) => e.id === "el-a-rect" || e.id === "el-a"), "released over the other figure: the selection left the source");
  h.ok(!!rect1 && !!lbl1, "…and joined the destination (rect + its panel label)");
  const tol = 6 / pts.zoom + 1; // a snap line may pull by up to the snap threshold
  h.ok(!!rect1 && Math.abs(rect1.x - pts.el.x) <= tol && Math.abs(rect1.y - pts.el.y) <= tol,
    `world position kept: local (${rect1?.x},${rect1?.y}) ≈ (${pts.el.x},${pts.el.y}) inside the destination`);
  h.eq(dst1.captions["el-a"], "Control vs treatment extension.", "the panel caption followed its label");
  h.ok(!("el-a" in src1.captions), "…and left the source's caption map");
  h.eq(s1.active, dupId, "the destination is now the active figure");
  h.eq([...s1.selection].sort().join(","), "el-a,el-a-rect", "the selection is intact (same ids, new figure)");
  h.eq(s1.droptargets, 0, "the lit frame clears on release");
  h.ok(dst1.els[dst1.els.length - 2].id === "el-a-rect" && dst1.els[dst1.els.length - 1].id === "el-a", "the moved run lands on top of the destination z-order in its original order");

  // --- 2. ONE undo entry brings both back; redo re-applies ---
  await page.evaluate(() => window.__flux.fig.undo());
  await sleep(120);
  const s2 = await state();
  const src2 = s2.figures.find((f) => f.id === "growth");
  h.ok(src2.els.some((e) => e.id === "el-a-rect") && src2.els.some((e) => e.id === "el-a"), "one undo restores both elements to the source");
  h.ok(!s2.figures.find((f) => f.id === dupId).els.some((e) => e.id === "el-a-rect"), "…and the destination no longer has them");
  h.eq(src2.captions["el-a"], "Control vs treatment extension.", "…caption included");
  await page.evaluate(() => window.__flux.fig.redo());
  await sleep(120);
  const s3 = await state();
  h.ok(s3.figures.find((f) => f.id === dupId).els.some((e) => e.id === "el-a-rect"), "redo re-applies the move");

  // --- 3. a drop on EMPTY canvas is a plain move (no re-parent) ---
  const empty = await page.evaluate(({ dupId }) => {
    const F = window.__flux;
    const vp = F.get(F.fig.viewport);
    const p = F.get(F.fig.project);
    const dst = p.figures.find((f) => f.id === dupId);
    const el = dst.elements.find((e) => e.id === "el-a-rect");
    const host = document.querySelector(".canvas-host").getBoundingClientRect();
    const toScreen = (wx, wy) => ({ x: host.left + vp.panX + wx * vp.zoom, y: host.top + vp.panY + wy * vp.zoom });
    F.fig.selection.set(new Set(["el-a-rect"]));
    return { from: toScreen(dst.x + el.x + el.width / 2, dst.y + el.y + el.height / 2), to: toScreen(dst.x + dst.width + 200, dst.y + el.y + el.height / 2) };
  }, { dupId });
  await page.mouse.move(empty.from.x, empty.from.y);
  await page.mouse.down();
  await page.mouse.move(empty.to.x, empty.to.y, { steps: 10 });
  await sleep(60);
  h.eq((await state()).droptargets, 0, "over empty canvas no frame is lit");
  await page.mouse.up();
  await sleep(150);
  const s4 = await state();
  const dst4 = s4.figures.find((f) => f.id === dupId);
  const rect4 = dst4.els.find((e) => e.id === "el-a-rect");
  h.ok(!!rect4 && rect4.x > 600, `dropped on empty canvas: still the destination's element, moved outside its frame (x=${rect4?.x})`);
  await page.evaluate(() => window.__flux.fig.undo());
  await sleep(100);

  // --- 4. Ctrl+X: cut = copy + delete; paste brings back exactly what left ---
  await page.evaluate(() => {
    const F = window.__flux;
    F.fig.activeFigureId.set("growth");
    F.fig.selectedFrameId.set(null);
    // Lock panel label b: a locked unit is not editable, so it must survive
    // the cut AND stay off the clipboard.
    F.fig.commit((p) => { const f = p.figures.find((ff) => ff.id === "growth"); f.elements.find((e) => e.id === "el-b").locked = true; });
    F.fig.selection.set(new Set(["el-b-rect", "el-b"]));
    document.activeElement?.blur?.();
  });
  const before = await state();
  const rectsBefore = before.figures.find((f) => f.id === "growth").els.filter((e) => e.type === "rect").length;
  await page.keyboard.down("Control");
  await page.keyboard.press("x");
  await page.keyboard.up("Control");
  await sleep(150);
  const s5 = await state();
  const src5 = s5.figures.find((f) => f.id === "growth");
  h.ok(!src5.els.some((e) => e.id === "el-b-rect"), "Ctrl+X removed the editable element");
  h.ok(src5.els.some((e) => e.id === "el-b"), "…and left the locked one in place");
  h.eq(s5.selection.join(","), "el-b", "the selection keeps only what stayed");
  h.eq(src5.els.filter((e) => e.type === "rect").length, rectsBefore - 1, "one rect fewer in the figure");

  // Paste rides the native paste event (keyboard.ts handleEditorPaste); no
  // OS clipboard in headless Chrome, so dispatch the event with empty data →
  // the internal clipboard wins.
  await page.evaluate(() => {
    const dt = new DataTransfer();
    let evt = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
    if (!evt.clipboardData) Object.defineProperty(evt, "clipboardData", { value: dt });
    window.dispatchEvent(evt);
  });
  await waitFor(
    page,
    (n) => window.__flux.figures().find((f) => f.id === "growth").elements.filter((e) => e.type === "rect").length === n,
    rectsBefore,
    { label: "paste restores the cut rect" },
  );
  const s6 = await state();
  const src6 = s6.figures.find((f) => f.id === "growth");
  const pasted = src6.els.filter((e) => e.fill === "#1b9e77");
  h.eq(pasted.length, 1, "the pasted copy is the cut rect (by fill), once");
  h.ok(pasted[0]?.id !== "el-b-rect" && pasted[0]?.x === 340 && pasted[0]?.y === 52, `pasted as a new element at the paste offset (${pasted[0]?.id} @ ${pasted[0]?.x},${pasted[0]?.y})`);
  h.eq(src6.els.filter((e) => e.type === "text" && e.id !== "el-a").length, 1, "the locked label was NOT duplicated by the paste (it was never cut)");
  h.eq(s6.selection.join(","), pasted[0]?.id, "the paste selects the pasted element");

  // One undo undoes the paste, the next undoes the cut.
  await page.evaluate(() => { window.__flux.fig.undo(); window.__flux.fig.undo(); });
  await sleep(120);
  const s7 = await state();
  h.ok(s7.figures.find((f) => f.id === "growth").els.some((e) => e.id === "el-b-rect"), "undo ×2 (paste, then cut) restores the original rect");

  // --- 5. Ctrl+X with nothing editable is a no-op (clipboard untouched) ---
  await page.evaluate(() => { window.__flux.fig.selection.set(new Set(["el-b"])); });
  await page.keyboard.down("Control");
  await page.keyboard.press("x");
  await page.keyboard.up("Control");
  await sleep(100);
  const s8 = await state();
  h.ok(s8.figures.find((f) => f.id === "growth").els.some((e) => e.id === "el-b"), "Ctrl+X on a locked-only selection removes nothing");

  await shot(page, "cross-figure-done");
  const errs = realErrors(page);
  h.eq(errs.length, 0, `console clean (${errs.join(" | ")})`);
} finally {
  await browser.close();
}
await h.done();
