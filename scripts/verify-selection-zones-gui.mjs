// 2026-10-21 — the Figma selection chrome (owner note fbmvih2bhvfocd): FOUR
// corner handles, every EDGE grabbable along its whole length for a one-axis
// resize, the L outside each corner rotates, Alt resizes about the centre,
// Shift keeps the aspect from an edge too, a live W × H tip while resizing,
// and the cursor family on every zone and on the HOST during the gesture
// (owner note fbmvignyzogt73: a resize drag keeps the resize arrows instead of
// snapping to the pressed cross). A 6 px element is still movable from its
// centre. Pure law: interact/handles.ts selectionHitZones (verify-interact-core).
//   node scripts/verify-selection-zones-gui.mjs        (dev server on FLUX_URL / :1420)
import { launch, gotoApp, clickMode, sleep, realErrors, waitFor, APP_URL } from "./lib/driver.mjs";

let fails = 0;
const ok = (cond, msg) => (cond ? console.log("  ✓ " + msg) : (fails++, console.log("  ✗ " + msg)));
const near = (a, b, tol = 1) => Math.abs(a - b) <= tol;

const { browser, page } = await launch({ width: 1440, height: 900 });
try {
  await page.evaluateOnNewDocument(() => {
    window.__name = window.__name || ((f) => f);
  });
  await gotoApp(page, { url: APP_URL + "?fixture=demo", settle: 3500 });
  await clickMode(page, "Figure");
  await waitFor(page, () => !!(window.__flux?.fig && window.__flux.figures().length && document.querySelector(".canvas-host")), null, {
    timeout: 15000,
    label: "figure mode ready",
  });

  // R: 160 × 110 at (120,120); T: a 6 × 6 speck at (600,400). Figure at 0,0, pan 60/120, zoom 1.
  const seed = () =>
    page.evaluate(() => {
      const F = window.__flux.fig;
      const out = {};
      F.commit((p) => {
        const g = p.figures.find((f) => f.id === "growth") || p.figures[0];
        g.x = 0; g.y = 0; g.width = 800; g.height = 500; g.elements = [];
        out.R = F.newId("rect");
        g.elements.push({ type: "rect", id: out.R, x: 120, y: 120, width: 160, height: 110, rotation: 0, fill: "#d9601a", stroke: "#222", strokeWidth: 3, cornerRadius: 0 });
        out.T = F.newId("rect");
        g.elements.push({ type: "rect", id: out.T, x: 600, y: 400, width: 6, height: 6, rotation: 0, fill: "#4385be", stroke: "none", strokeWidth: 0, cornerRadius: 0 });
        out.BAR = F.newId("rect"); // a 2 px scale bar
        g.elements.push({ type: "rect", id: out.BAR, x: 400, y: 450, width: 200, height: 2, rotation: 0, fill: "#222", stroke: "none", strokeWidth: 0, cornerRadius: 0 });
        out.LBL = F.newId("rect"); // a 10 px label-sized box
        g.elements.push({ type: "rect", id: out.LBL, x: 400, y: 300, width: 120, height: 10, rotation: 0, fill: "#2ca02c", stroke: "none", strokeWidth: 0, cornerRadius: 0 });
        out.L1 = F.newId("line"); // two collinear lines: a zero-height selection
        g.elements.push({ type: "line", id: out.L1, x: 400, y: 380, width: 0, height: 0, rotation: 0, x1: 0, y1: 0, x2: 80, y2: 0, stroke: "#222", strokeWidth: 3 });
        out.L2 = F.newId("line");
        g.elements.push({ type: "line", id: out.L2, x: 520, y: 380, width: 0, height: 0, rotation: 0, x1: 0, y1: 0, x2: 80, y2: 0, stroke: "#222", strokeWidth: 3 });
        out.N = F.newId("rect"); // a neighbour whose left edge (x = 320) is a snap target 40 px right of R's right edge
        g.elements.push({ type: "rect", id: out.N, x: 320, y: 300, width: 60, height: 60, rotation: 0, fill: "#999", stroke: "none", strokeWidth: 0, cornerRadius: 0 });
      });
      F.viewport.set({ panX: 60, panY: 120, zoom: 1 });
      F.selection.set(new Set([out.R]));
      return out;
    });
  let ids = await seed();
  await sleep(250);
  const off = await page.evaluate(() => {
    const r = document.querySelector(".canvas-host").getBoundingClientRect();
    return { x: r.x, y: r.y };
  });
  const scr = (wx, wy) => ({ x: off.x + 60 + wx, y: off.y + 120 + wy });
  const model = (id) => page.evaluate((id) => {
    const e = window.__flux.figures().flatMap((f) => f.elements).find((x) => x.id === id);
    return e ? { x: e.x, y: e.y, w: e.width, h: e.height, rot: e.rotation ?? 0 } : null;
  }, id);
  const hostCursor = () => page.$eval(".canvas-host", (el) => getComputedStyle(el).cursor);
  const drag = async (from, dx, dy, { shift = false, alt = false, steps = 6, mid = null } = {}) => {
    if (shift) await page.keyboard.down("Shift");
    if (alt) await page.keyboard.down("Alt");
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    for (let i = 1; i <= steps; i++) await page.mouse.move(from.x + (dx * i) / steps, from.y + (dy * i) / steps);
    const sample = mid ? await mid() : null;
    await page.mouse.up();
    if (alt) await page.keyboard.up("Alt");
    if (shift) await page.keyboard.up("Shift");
    await sleep(60);
    return sample;
  };
  const reseed = async () => { ids = await seed(); await sleep(200); };

  // --- 1. the chrome ----------------------------------------------------------
  console.log("Chrome:");
  const chrome = await page.evaluate(() => {
    const q = (s) => document.querySelectorAll(".overlay-svg " + s);
    const cur = (s) => getComputedStyle(document.querySelector(".overlay-svg " + s)).cursor;
    return {
      handles: q(".handle").length, edges: q(".zone.edge").length, corners: q(".zone.corner").length, rot: q(".zone.rotate").length, knob: q(".rot-handle").length,
      handleInline: [...q(".handle")].some((h) => (h.getAttribute("style") || "").includes("cursor")),
      e: cur('.zone.edge[data-h="e"]'), n: cur('.zone.edge[data-h="n"]'), se: cur('.zone.corner[data-h="se"]'), ne: cur('.zone.corner[data-h="ne"]'), rse: cur('.zone.rotate[data-zone="se"]'), knobCur: cur(".rot-handle"),
    };
  });
  ok(chrome.handles === 4, `four drawn corner handles, no mid-edge knobs (${chrome.handles})`);
  ok(chrome.edges === 4 && chrome.corners === 4 && chrome.rot === 12 && chrome.knob === 1, `4 edge bands, 4 corner zones, 12 rotate rects, 1 rotate knob (${chrome.edges}/${chrome.corners}/${chrome.rot}/${chrome.knob})`);
  ok(!chrome.handleInline, "the drawn handles carry no OS cursor (the zones do)");
  const fam = (c, fb) => /data:image\/svg\+xml/.test(c) && new RegExp(`, ${fb}$`).test(c);
  ok(fam(chrome.e, "ew-resize") && fam(chrome.n, "ns-resize"), "edge bands show the family's ew / ns resize cursors (svg + OS fallback)");
  ok(fam(chrome.se, "nwse-resize") && fam(chrome.ne, "nesw-resize"), "corner zones show the diagonal family cursors");
  ok(fam(chrome.rse, "grab") && fam(chrome.knobCur, "grab"), "rotate zones and the knob show the rotate arc (grab fallback)");

  // --- 2. the whole edge is the handle -------------------------------------------
  console.log("Edge grab:");
  for (const f of [0.1, 0.5, 0.9]) {
    await reseed();
    await drag(scr(280, 120 + 110 * f), 40, 0);
    const m = await model(ids.R);
    ok(m && near(m.w, 200) && near(m.x, 120) && near(m.y, 120) && near(m.h, 110), `right edge at ${Math.round(f * 100)} % of its length: width 160 → ${m?.w}, nothing else moved`);
  }
  await reseed();
  await drag(scr(277, 175), 40, 0);
  let m = await model(ids.R);
  ok(near(m.w, 200) && near(m.x, 120), `3 px INSIDE the right edge still resizes (w ${m.w}) — and the edge moves by the drag, not to the pointer`);
  await reseed();
  await drag(scr(274, 175), 40, 0);
  m = await model(ids.R);
  ok(near(m.x, 160) && near(m.w, 160), `6 px inside the edge is the body: it MOVES (x ${m.x}, w ${m.w})`);
  await reseed();
  await drag(scr(285, 175), 40, 0);
  m = await model(ids.R);
  ok(near(m.w, 200) && near(m.x, 120), `5 px OUTSIDE the right edge still resizes (w ${m.w})`);
  await reseed();
  await drag(scr(200, 230), 0, 30);
  m = await model(ids.R);
  ok(near(m.h, 140) && near(m.w, 160) && near(m.y, 120), `bottom edge: height 110 → ${m.h}, width kept`);
  await reseed();
  await drag(scr(120, 175), -20, 0);
  m = await model(ids.R);
  ok(near(m.x, 100) && near(m.w, 180) && near(m.h, 110), `left edge: x 120 → ${m.x}, width → ${m.w}`);
  await reseed();
  await drag(scr(200, 120), 0, -25);
  m = await model(ids.R);
  ok(near(m.y, 95) && near(m.h, 135), `top edge: y → ${m.y}, height → ${m.h}`);
  await reseed();
  await drag(scr(280, 230), 40, 30);
  m = await model(ids.R);
  ok(near(m.w, 200) && near(m.h, 140) && near(m.x, 120) && near(m.y, 120), `the se corner still resizes both axes (${m.w} × ${m.h})`);
  await reseed();
  await drag(scr(200, 175), 40, 30);
  m = await model(ids.R);
  ok(near(m.x, 160) && near(m.y, 150) && near(m.w, 160), `the interior (beyond the band's inner reach) MOVES (${m.x},${m.y})`);

  // --- 3. modifiers: Shift aspect from an edge, Alt from the centre ---------------
  console.log("Modifiers:");
  await reseed();
  await drag(scr(280, 175), 40, 0, { shift: true });
  m = await model(ids.R);
  ok(near(m.w, 200) && near(m.h, 137.5) && near(m.x, 120) && near(m.y + m.h / 2, 175), `Shift from the right edge keeps the aspect about the LEFT edge's midpoint (${m.w} × ${m.h}, y ${m.y})`);
  await reseed();
  await drag(scr(280, 175), 40, 0, { alt: true });
  m = await model(ids.R);
  ok(near(m.x, 80) && near(m.w, 240) && near(m.y, 120) && near(m.h, 110), `Alt from the right edge grows both sides about the centre (x ${m.x}, w ${m.w})`);
  await reseed();
  await drag(scr(280, 230), 40, 30, { alt: true, shift: true });
  m = await model(ids.R);
  ok(near(m.x + m.w / 2, 200) && near(m.y + m.h / 2, 175) && near(m.w / m.h, 160 / 110, 0.01), `Shift+Alt from a corner keeps centre and aspect (${m.w.toFixed(1)} × ${m.h.toFixed(1)} about ${(m.x + m.w / 2).toFixed(1)},${(m.y + m.h / 2).toFixed(1)})`);

  // --- 4. rotate outside the corner -------------------------------------------------
  console.log("Rotate zones:");
  await reseed();
  // start just outside the se corner (in its L), swing clockwise about the centre (200,175)
  const c = { x: 200, y: 175 };
  const start = scr(292, 242);
  const a0 = Math.atan2(242 - c.y, 292 - c.x);
  const a1 = a0 + (30 * Math.PI) / 180;
  const r = Math.hypot(292 - c.x, 242 - c.y);
  const end = scr(c.x + r * Math.cos(a1), c.y + r * Math.sin(a1));
  const rotMid = await drag(start, end.x - start.x, end.y - start.y, { steps: 8, mid: hostCursor });
  m = await model(ids.R);
  ok(near(m.rot, 30, 2) && near(m.x, 120) && near(m.w, 160), `dragging in the L outside the se corner rotates (${m.rot.toFixed(1)}°), no resize`);
  ok(fam(rotMid, "grab"), "…and the HOST shows the rotate arc while dragging");
  await reseed();
  await drag(start, end.x - start.x, end.y - start.y, { steps: 8, shift: true });
  m = await model(ids.R);
  ok(near(m.rot % 15, 0, 0.01) && m.rot !== 0, `Shift snaps the zone rotation to 15° (${m.rot}°)`);

  // --- 5. the cursor during the gesture + the size tip --------------------------------
  console.log("Host cursor by gesture, size tip:");
  await reseed();
  const during = await drag(scr(280, 175), 40, 0, {
    mid: async () => ({ cur: await hostCursor(), tip: await page.$eval(".overlay-svg .size-tip", (t) => t.textContent).catch(() => null) }),
  });
  ok(fam(during.cur, "ew-resize"), `mid-resize the host cursor IS the resize arrows (not the pressed cross): ${during.cur.slice(-24)}`);
  ok(during.tip && /^\d+(\.\d)? × \d+(\.\d)?$/.test(during.tip) && during.tip.startsWith("200"), `the live W × H tip reads ${during.tip}`);
  ok(/crosshair$/.test(await hostCursor()) && !/y1='4'/.test(await hostCursor()), "released: back to the plain crosshair");
  ok((await page.$(".overlay-svg .size-tip")) === null, "the size tip is gone at rest");
  await reseed();
  const moveCur = await drag(scr(200, 175), 30, 20, { mid: hostCursor });
  ok(fam(moveCur, "move"), "mid-move the host shows the four-headed move cross");
  await reseed();
  const copyCur = await drag(scr(200, 175), 30, 20, { alt: true, mid: hostCursor });
  ok(fam(copyCur, "copy"), "Alt-duplicate in flight shows the move-copy cross");
  ok((await page.evaluate(() => window.__flux.figures()[0].elements.length)) === 8, "…and left a moved copy behind");

  // --- 5b. resizes snap like moves; live modifiers mid-drag -----------------------------
  console.log("Resize snapping, live modifiers:");
  await reseed();
  await drag(scr(280, 175), 36, 0); // the right edge lands 4 px short of N's left edge (x 320) → snaps to it
  m = await model(ids.R);
  ok(near(m.w, 200) && near(m.x, 120), `the dragged right edge snaps to a neighbour's edge 4 px away (w ${m.w}, right edge at ${m.x + m.w})`);
  await reseed();
  await drag(scr(280, 175), 36, 0, { alt: true });
  m = await model(ids.R);
  ok(near(m.w, 232) && near(m.x, 84), `…but not in centre mode (Alt): w ${m.w}, x ${m.x}`);
  await reseed();
  // press, move 40 right with no modifier, THEN press Alt without moving: the box must re-centre at once
  const p0 = scr(280, 175);
  await page.mouse.move(p0.x, p0.y); await page.mouse.down();
  for (let i = 1; i <= 5; i++) await page.mouse.move(p0.x + 8 * i, p0.y);
  const beforeAlt = await page.evaluate(() => { const b = document.querySelector(".overlay-svg .sel-box"); return { x: +b.getAttribute("x"), w: +b.getAttribute("width") }; });
  await page.keyboard.down("Alt");
  await sleep(60);
  const afterAlt = await page.evaluate(() => { const b = document.querySelector(".overlay-svg .sel-box"); return { x: +b.getAttribute("x"), w: +b.getAttribute("width") }; });
  await page.keyboard.up("Alt");
  await page.mouse.up(); await sleep(60);
  ok(near(beforeAlt.w, 200, 2) && near(afterAlt.w, 240, 2) && afterAlt.x < beforeAlt.x - 30, `pressing Alt mid-drag re-centres the live box without a pointer move (w ${beforeAlt.w} → ${afterAlt.w})`);

  // --- 6. a tiny element stays movable ----------------------------------------------
  console.log("Tiny selection:");
  await reseed();
  await page.evaluate((id) => window.__flux.fig.selection.set(new Set([id])), ids.T);
  await sleep(200);
  const tinyZones = await page.evaluate(() => document.querySelectorAll(".overlay-svg .zone.edge").length);
  ok(tinyZones === 0, "a 6 px selection has no edge bands");
  await drag(scr(603, 403), 50, 0);
  m = await model(ids.T);
  ok(near(m.x, 650) && near(m.w, 6) && near(m.h, 6), `pressing its centre MOVES it (x ${m.x}, still ${m.w} × ${m.h})`);
  await reseed();
  await page.evaluate((id) => window.__flux.fig.selection.set(new Set([id])), ids.T);
  await sleep(200);
  await drag(scr(609, 409), 20, 20);
  m = await model(ids.T);
  ok(near(m.w, 26) && near(m.h, 26) && near(m.x, 600), `its se corner, grabbed from outside, still resizes (${m.w} × ${m.h})`);
  // a 2 px scale bar: grabbable along its whole length, no n/s bands over its body
  await reseed();
  await page.evaluate((id) => window.__flux.fig.selection.set(new Set([id])), ids.BAR);
  await sleep(200);
  ok((await page.evaluate(() => [...document.querySelectorAll(".overlay-svg .zone.edge")].map((z) => z.dataset.h).sort().join())) === "e,w", "a 2 px scale bar has no n/s bands (nothing across its 2 px) — only e/w at its ends");
  await drag(scr(500, 451), 0, 40);
  m = await model(ids.BAR);
  ok(near(m.y, 490) && near(m.h, 2) && near(m.w, 200), `pressing the bar's middle MOVES it (y ${m.y}, still ${m.w} × ${m.h})`);
  // a 10 px label: no bands at all, its body moves
  await reseed();
  await page.evaluate((id) => window.__flux.fig.selection.set(new Set([id])), ids.LBL);
  await sleep(200);
  ok((await page.evaluate(() => [...document.querySelectorAll(".overlay-svg .zone.edge")].map((z) => z.dataset.h).sort().join())) === "e,w", "a 10 px label has only e/w bands (no accidental height resize; width still wraps it)");
  await drag(scr(460, 305), 30, 30);
  m = await model(ids.LBL);
  ok(near(m.x, 430) && near(m.y, 330) && near(m.h, 10), `its body moves (${m.x},${m.y}, height still ${m.h})`);
  // a zero-height selection (two collinear lines) still moves by its stroke
  await reseed();
  await page.evaluate((a, b) => window.__flux.fig.selection.set(new Set([a, b])), ids.L1, ids.L2);
  await sleep(200);
  ok((await page.evaluate(() => document.querySelectorAll(".overlay-svg .zone.edge").length)) === 0, "a zero-height selection has no bands over its stroke");
  await drag(scr(440, 380), 0, 50); // 50, clear of T's edges (406) and the bar (450) as snap targets
  const l1 = await model(ids.L1), l2 = await model(ids.L2);
  ok(near(l1.y, 430) && near(l2.y, 430), `pressing one of the lines moves both (y ${l1.y} / ${l2.y})`);

  const errs = realErrors(page);
  ok(errs.length === 0, `console clean (${errs.length})${errs.length ? ": " + errs.slice(0, 2).join(" | ") : ""}`);
} finally {
  await browser.close();
}
console.log(fails ? `VERIFY-SELECTION-ZONES-GUI FAIL (${fails})` : "VERIFY-SELECTION-ZONES-GUI PASS");
process.exit(fails ? 1 : 0);
