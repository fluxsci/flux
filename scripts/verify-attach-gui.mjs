// WP 3.2 (manim study, T9): attached connectors and labels in the Figure editor, driven by REAL pointer events.
//   * dragging a shape: the connector and the label attached to it follow on EVERY pointer move (the model is frozen during the drag; they
//     ride the scene-slot overrides), and at release the committed geometry is exactly the store's solve;
//   * a line drawn from one shape to another sticks both ends (a connector); a connector end dragged to empty space frees itself, dropped on
//     a shape it sticks to it;
//   * a label dragged by hand frees itself (its new place sticks, it no longer follows).
// UI tier: needs the dev server (FLUX_URL; never the owner's :1420 when one is running there).
import assert from "node:assert/strict";
import { launch, gotoApp, clickMode, waitFor, waitForFrame, realErrors, APP_URL } from "./lib/driver.mjs";
import { harness } from "./lib/harness.mjs";

const h = harness("verify-attach-gui");
const { browser, page } = await launch({ width: 1400, height: 950 });
async function seed() {
  await page.evaluate(() => {
    const F = window.__flux, s = F.fig;
    s.clearSelection(); s.activeTool.set("select"); s.nodeEditId.set(null);
    s.commit((p) => {
      const f = p.figures[0]; p.figures = [f]; f.x = 0; f.y = 0; f.width = 900; f.height = 600; delete f.groups; delete f.guides;
      f.elements = [
        { type: "rect", id: "A", name: "Box A", x: 80, y: 200, width: 160, height: 100, rotation: 0, fill: "#4385be", stroke: "none", strokeWidth: 0, cornerRadius: 0 },
        { type: "ellipse", id: "B", name: "Circle B", x: 600, y: 220, width: 140, height: 140, rotation: 0, fill: "#d14d41", stroke: "none", strokeWidth: 0 },
        { type: "line", id: "L", name: "Connector", x: 0, y: 0, width: 0, height: 0, rotation: 0, x1: 0, y1: 0, x2: 10, y2: 0, stroke: "#100f0f", strokeWidth: 3, attach: { start: { to: "A", gap: 4 }, end: { to: "B", gap: 4 } } },
        { type: "text", id: "T", name: "Label", x: 0, y: 0, width: 160, height: 30, rotation: 0, text: "label", fontFamily: "Arial", fontSize: 22, fontWeight: 400, fontStyle: "normal", align: "center", color: "#100f0f", sizing: "fixed", attach: { to: "A", side: "n", gap: 8 } },
      ];
      s.activeFigureId.set(f.id); s.activeCanvasId.set(f.canvasId);
    });
    F.settings.update((v) => ({ ...v, snapPixel: false, snapGrid: false, connectorsStick: true }));
    s.viewport.set({ panX: 60, panY: 60, zoom: 1 }); s.resetHistory(); s.dirty.set(false);
  });
  await waitForFrame(page);
}
/** figure-local point -> client px */
const pt = (x, y) => page.evaluate(([x, y]) => { const r = document.querySelector(".canvas-host").getBoundingClientRect(), v = window.__flux.get(window.__flux.fig.viewport); return { x: r.left + v.panX + x * v.zoom, y: r.top + v.panY + y * v.zoom }; }, [x, y]);
const model = (id) => page.evaluate((id) => { const F = window.__flux; return structuredClone(F.get(F.fig.project).figures[0].elements.find((e) => e.id === id)); }, id);
/** what the canvas DRAWS for a line (its full-length hit line: the model endpoints), figure-local */
const drawnLine = (id) => page.evaluate((id) => { const l = document.querySelector(`[data-editor-element-id="${id}"] line`); return l ? ["x1", "y1", "x2", "y2"].map((a) => +l.getAttribute(a)) : null; }, id);
const drawnBox = (id) => page.evaluate((id) => { const g = document.querySelector(`[data-editor-element-id="${id}"]`), r = g.getBoundingClientRect(), host = document.querySelector(".canvas-host").getBoundingClientRect(), v = window.__flux.get(window.__flux.fig.viewport); return { x: (r.left - host.left - v.panX) / v.zoom, y: (r.top - host.top - v.panY) / v.zoom }; }, id);
const solveNow = () => page.evaluate(async () => {
  const { resolveAttachments } = await import("/src/lib/slide/attach.ts");
  const F = window.__flux, els = structuredClone(F.get(F.fig.project).figures[0].elements); resolveAttachments(els);
  return els;
});
try {
  await gotoApp(page, { url: `${APP_URL.replace(/\/$/, "")}/?fixture=demo`, settle: 1000 }); await clickMode(page, "Figure");
  await waitFor(page, () => !!window.__flux?.fig && !!document.querySelector(".canvas-host"));

  h.section("a shape dragged: what is attached follows on every pointer move, and lands on the solve");
  await seed();
  // the store settles the seeded elements onto their solve at once
  const L0 = await model("L"), T0 = await model("T");
  h.ok(L0.x > 80 && L0.x2 > 300 && Math.abs(T0.y - (200 - 8 - 30)) < 1e-6, "seeding solved the connector between A and B and put the label above A");
  const from = await pt(160, 250); await page.mouse.move(from.x, from.y); await page.mouse.down();
  let followed = 0, labelFollowed = 0, steps = 0, prev = await drawnLine("L"), prevT = await drawnBox("T");
  for (let i = 1; i <= 12; i++) {
    await page.mouse.move(from.x + i * 14, from.y + i * 9); await waitForFrame(page); steps++;
    const now = await drawnLine("L"), t = await drawnBox("T");
    if (now && prev && (Math.abs(now[0] - prev[0]) > 1 || Math.abs(now[1] - prev[1]) > 1)) followed++;
    if (Math.abs(t.x - prevT.x) > 1 || Math.abs(t.y - prevT.y) > 1) labelFollowed++;
    prev = now; prevT = t;
  }
  h.ok(followed === steps, `the connector's drawn start follows the drag on every pointer move (${followed}/${steps})`);
  h.ok(labelFollowed === steps, `the label follows on every pointer move (${labelFollowed}/${steps})`);
  const midL = await model("L");
  h.ok(Math.abs(midL.x - L0.x) < 1e-9, "the model stays frozen during the drag (one commit at release)");
  await page.mouse.up(); await waitForFrame(page);
  const A1 = await model("A"), L1 = await model("L"), solved = await solveNow(), Ls = solved.find((e) => e.id === "L"), drawn = await drawnLine("L");
  h.ok(A1.x > 80 + 100 && ["x", "y", "x2", "y2"].every((k) => Math.abs(L1[k] - Ls[k]) < 1e-9), "at release A moved and the committed connector IS the solve");
  h.ok(drawn && Math.abs(drawn[0] - (L1.x + L1.x1)) < 1e-6 && Math.abs(drawn[2] - (L1.x + L1.x2)) < 1e-6, "...and the canvas draws exactly the committed connector (no leftover override)");
  h.ok(!!(await model("L")).attach?.start && !!(await model("T")).attach, "a driver's move keeps every attachment");

  h.section("a label dragged by hand frees itself");
  // (nothing selected first: a selected A's rotate handle sits just where its label is)
  await page.evaluate(() => window.__flux.fig.clearSelection()); await waitForFrame(page);
  const t0 = await model("T"), tp = await pt(t0.x + t0.width / 2, t0.y + t0.height / 2); // on its ink (a text is hit by its glyphs)
  await page.mouse.move(tp.x, tp.y); await page.mouse.down(); await page.mouse.move(tp.x + 60, tp.y - 40, { steps: 6 }); await page.mouse.up(); await waitForFrame(page);
  const t1 = await model("T");
  h.ok(!t1.attach && Math.abs(t1.x - (t0.x + 60)) < 1e-6 && Math.abs(t1.y - (t0.y - 40)) < 1e-6, "the label lands where it was dropped and no longer follows A");

  h.section("connector ends: free in empty space, stuck on a shape");
  await seed(); await page.evaluate(() => window.__flux.fig.selection.set(new Set(["L"]))); await waitForFrame(page);
  const L2 = await model("L"), end = await pt(L2.x + L2.x2, L2.y + L2.y2);
  await page.mouse.move(end.x, end.y); await page.mouse.down(); await page.mouse.move(end.x + 10, end.y + 200, { steps: 6 }); await page.mouse.up(); await waitForFrame(page);
  const L3 = await model("L");
  h.ok(!!L3.attach?.start && !L3.attach?.end, "an end dragged to empty space is free; the other end keeps its shape");
  const e3 = await pt(L3.x + L3.x2, L3.y + L3.y2), onB = await pt(670, 290);
  await page.mouse.move(e3.x, e3.y); await page.mouse.down(); await page.mouse.move(onB.x, onB.y, { steps: 6 }); await page.mouse.up(); await waitForFrame(page);
  h.eq((await model("L")).attach?.end?.to, "B", "dropped on B, the end sticks to B again");

  h.section("a line drawn from one shape to another is a connector");
  await seed();
  await page.evaluate(() => { const s = window.__flux.fig; s.commit((p) => { p.figures[0].elements = p.figures[0].elements.filter((e) => e.id === "A" || e.id === "B"); }); s.activeTool.set("line"); });
  const a = await pt(160, 250), b = await pt(670, 290);
  await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, { steps: 8 }); await page.mouse.up(); await waitForFrame(page);
  const drawnEl = await page.evaluate(() => { const F = window.__flux; return F.get(F.fig.project).figures[0].elements.find((e) => e.type === "line"); });
  h.ok(drawnEl?.attach?.start?.to === "A" && drawnEl?.attach?.end?.to === "B", "both ends stuck: start on A, end on B");
  h.section("R3 review: a label edited (typed in, bolded) stays stuck and re-centres");
  await seed();
  // an AUTO-size label (it hugs its text, so typing re-measures it wider: the reviewer's case)
  await page.evaluate(() => { const s = window.__flux.fig; s.commit((p) => { const t = p.figures[0].elements.find((e) => e.id === "T"); t.sizing = "auto"; t.align = "left"; }); s.clearSelection(); });
  await waitForFrame(page);
  const w0 = (await model("T")).width;
  const centredOnA = async () => { const t = await model("T"), A = await model("A"); return !!t.attach && Math.abs(t.x + t.width / 2 - (A.x + A.width / 2)) < 0.5; };
  const tl = await model("T"), tc = await pt(tl.x + 12, tl.y + tl.height * 0.6); // on the glyph ink of "la…" (left-aligned)
  await page.mouse.click(tc.x, tc.y, { count: 2 }); await waitFor(page, () => !!document.querySelector("textarea.text-edit"));
  await page.keyboard.press("End"); await page.keyboard.type(" text");
  await page.evaluate(() => document.querySelector("textarea.text-edit")?.blur()); await waitForFrame(page); // blur commits the edit
  await page.evaluate(() => window.__flux.fig.clearSelection()); await waitForFrame(page);
  const typed = await model("T");
  h.ok(typed.text === "label text" && Math.abs(typed.width - w0) > 10 && await centredOnA(), `typing into an auto-size label (its box re-measured ${w0.toFixed(1)} -> ${typed.width.toFixed(1)} wide) keeps it stuck to A, re-centred (attach ${!!typed.attach})`);
  await page.evaluate(() => window.__flux.fig.selection.set(new Set(["T"]))); await waitForFrame(page);
  await page.keyboard.down("Control"); await page.keyboard.press("b"); await page.keyboard.up("Control"); await waitForFrame(page);
  h.ok((await model("T")).fontWeight === 700 && await centredOnA(), "Ctrl+B on the selected label keeps it stuck, re-centred");
  const ax = (await model("A")).x; await page.evaluate(() => { const s = window.__flux.fig; s.commit((p) => { p.figures[0].elements.find((e) => e.id === "A").x += 60; }); });
  await waitForFrame(page);
  h.ok((await model("A")).x === ax + 60 && await centredOnA(), "...and it still follows A");

  h.section("R3 review: an arrow drawn into an image keeps the spot; Ctrl/⌘ keeps it on a shape");
  await seed();
  await page.evaluate(() => { const s = window.__flux.fig; s.commit((p) => { p.figures[0].elements = p.figures[0].elements.filter((e) => e.id === "A" || e.id === "B");
    p.figures[0].elements.push({ type: "image", id: "IMG", name: "Panel", x: 360, y: 60, width: 400, height: 260, rotation: 0, assetId: "missing" }); }); s.clearSelection(); s.activeTool.set("line"); });
  await waitForFrame(page);
  const onA = await pt(160, 250), into = await pt(520, 150);
  await page.mouse.move(onA.x, onA.y); await page.mouse.down(); await page.mouse.move(into.x, into.y, { steps: 8 }); await page.mouse.up(); await waitForFrame(page);
  const arrow = await page.evaluate(() => { const F = window.__flux; return F.get(F.fig.project).figures[0].elements.find((e) => e.type === "line"); });
  const tipX = arrow.x + arrow.x2, tipY = arrow.y + arrow.y2;
  h.ok(arrow?.attach?.end?.to === "IMG" && typeof arrow.attach.end.anchor === "object" && Math.hypot(tipX - 520, tipY - 150) < 1, `the end stays where it was drawn inside the image (${tipX.toFixed(1)}, ${tipY.toFixed(1)}) and is stuck to it`);
  h.ok(arrow?.attach?.start?.to === "A" && arrow.attach.start.anchor === "auto", "...its start, on a shape, connects to the outline");
  await page.evaluate(() => { const s = window.__flux.fig; s.commit((p) => { p.figures[0].elements.find((e) => e.id === "IMG").x += 40; }); });
  await waitForFrame(page);
  const moved = await page.evaluate(() => { const F = window.__flux; return F.get(F.fig.project).figures[0].elements.find((e) => e.type === "line"); });
  h.ok(Math.abs(moved.x + moved.x2 - 560) < 1e-6, "the spot follows the image");
  await page.evaluate(() => { const s = window.__flux.fig; s.commit((p) => { p.figures[0].elements = p.figures[0].elements.filter((e) => e.type !== "line"); }); s.activeTool.set("line"); });
  const inB = await pt(700, 300);
  await page.mouse.move(onA.x, onA.y); await page.mouse.down(); await page.mouse.move(inB.x - 30, inB.y - 30, { steps: 6 }); await page.keyboard.down("Control"); await page.mouse.move(inB.x, inB.y, { steps: 2 }); await page.mouse.up(); await page.keyboard.up("Control"); await waitForFrame(page);
  const exact = await page.evaluate(() => { const F = window.__flux; return F.get(F.fig.project).figures[0].elements.find((e) => e.type === "line"); });
  h.ok(exact?.attach?.end?.to === "B" && typeof exact.attach.end.anchor === "object" && Math.hypot(exact.x + exact.x2 - 700, exact.y + exact.y2 - 300) < 1, "with Ctrl held at release, an end on a shape keeps the exact spot too");
  const errors = await realErrors(page);
  h.eq(errors, [], "no page errors");
} catch (err) { h.fail(String(err?.stack ?? err)); }
finally { await browser.close(); }
await h.done();
void assert;
