// 2026-10-21 — the bounding-box grab (owner note fbmvihaearg0zo, Figma): to
// SELECT a path/line you still click on or near its stroke; but ONCE selected,
// a press anywhere inside the selection's box that hits nothing moves it — an
// open path's empty interior, a hollow ellipse's middle, a group's gaps. A
// click there keeps the selection; Shift keeps the marquee-add; Alt duplicates
// on drag; an unselected object inside the box still wins the click.
//   node scripts/verify-bbox-grab-gui.mjs        (dev server on FLUX_URL / :1420)
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

  // P: an open zigzag path (bbox 100..340 × 100..180); S: a small filled rect INSIDE P's box;
  // E: a hollow ellipse; G1/G2: two rects to group. Figure at 0,0; pan 60/120; zoom 1.
  const seed = () =>
    page.evaluate(() => {
      const F = window.__flux.fig;
      const out = {};
      F.commit((p) => {
        const g = p.figures.find((f) => f.id === "growth") || p.figures[0];
        g.x = 0; g.y = 0; g.width = 800; g.height = 500; g.elements = []; g.groups = {};
        out.B = F.newId("rect"); // BENEATH the path (pushed first): a plot-like block the path annotates
        g.elements.push({ type: "rect", id: out.B, x: 250, y: 100, width: 80, height: 50, rotation: 0, fill: "#f0e6d2", stroke: "none", strokeWidth: 0, cornerRadius: 0 });
        out.P = F.newId("path");
        g.elements.push({ type: "path", id: out.P, x: 100, y: 100, width: 240, height: 80, rotation: 0, d: "M 0 80 L 60 0 L 120 80 L 180 0 L 240 80", fill: "none", stroke: "#222222", strokeWidth: 3, closed: false });
        out.S = F.newId("rect");
        g.elements.push({ type: "rect", id: out.S, x: 150, y: 140, width: 30, height: 20, rotation: 0, fill: "#2ca02c", stroke: "none", strokeWidth: 0, cornerRadius: 0 });
        out.E = F.newId("ellipse");
        g.elements.push({ type: "ellipse", id: out.E, x: 500, y: 300, width: 160, height: 100, rotation: 0, fill: "none", stroke: "#222222", strokeWidth: 3 });
        out.G1 = F.newId("rect");
        g.elements.push({ type: "rect", id: out.G1, x: 100, y: 400, width: 60, height: 40, rotation: 0, fill: "#d62728", stroke: "none", strokeWidth: 0, cornerRadius: 0 });
        out.G2 = F.newId("rect");
        g.elements.push({ type: "rect", id: out.G2, x: 260, y: 440, width: 60, height: 40, rotation: 0, fill: "#1f77b4", stroke: "none", strokeWidth: 0, cornerRadius: 0 });
      });
      F.viewport.set({ panX: 60, panY: 120, zoom: 1 });
      F.selection.set(new Set());
      return out;
    });
  let ids = await seed();
  await sleep(250);
  const off = await page.evaluate(() => {
    const r = document.querySelector(".canvas-host").getBoundingClientRect();
    return { x: r.x, y: r.y };
  });
  const scr = (wx, wy) => ({ x: off.x + 60 + wx, y: off.y + 120 + wy });
  const pos = (id) => page.evaluate((id) => {
    const e = window.__flux.figures().flatMap((f) => f.elements).find((x) => x.id === id);
    return e ? { x: e.x, y: e.y } : null;
  }, id);
  const sel = () => page.evaluate(() => [...window.__flux.get(window.__flux.fig.selection)]);
  const count = () => page.evaluate(() => window.__flux.figures()[0].elements.length);
  const history = () => page.evaluate(() => window.__flux.fig.historyStats());
  const click = async (p) => { await page.mouse.move(p.x, p.y); await page.mouse.down(); await page.mouse.up(); await sleep(80); };
  const drag = async (from, dx, dy, { shift = false, alt = false, steps = 6 } = {}) => {
    if (shift) await page.keyboard.down("Shift");
    if (alt) await page.keyboard.down("Alt");
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    for (let i = 1; i <= steps; i++) await page.mouse.move(from.x + (dx * i) / steps, from.y + (dy * i) / steps);
    await page.mouse.up();
    if (alt) await page.keyboard.up("Alt");
    if (shift) await page.keyboard.up("Shift");
    await sleep(80);
  };
  const reseed = async () => { ids = await seed(); await sleep(200); };
  // (230,110): inside P's box, ~56 px above the stroke, clear of S
  const interior = scr(230, 110);
  const onStroke = scr(160, 100); // the path's second vertex

  // --- 1. nothing selected: the interior is still empty canvas ---------------------
  console.log("Before selection:");
  await click(interior);
  ok((await sel()).length === 0, "a click there selects nothing (an open path is selected by its stroke, not its box)");
  await drag(interior, 40, 0);
  let p = await pos(ids.P);
  ok(near(p.x, 100) && near(p.y, 100), "a drag in the path's empty interior with NOTHING selected does not move it");
  ok((await sel()).includes(ids.P), "…it is the marquee it always was (which selects by box intersection)");
  await page.evaluate(() => window.__flux.fig.selection.set(new Set()));
  await sleep(100);

  // --- 2. select by the stroke, then grab anywhere in the box ---------------------------
  console.log("After selection:");
  await click(onStroke);
  ok((await sel()).join() === ids.P, "clicking ON the stroke selects the path (unchanged)");
  const h0 = (await history()).past;
  await drag(interior, 40, 33); // deltas chosen clear of the smart-guide snaps to S / B / the frame
  p = await pos(ids.P);
  ok(near(p.x, 140) && near(p.y, 133), `a drag from the empty interior MOVES the selected path (${p.x},${p.y})`);
  ok((await history()).past === h0 + 1, "…as one undo entry");
  ok((await sel()).join() === ids.P, "…and it stays selected");
  await page.keyboard.down("Control"); await page.keyboard.press("z"); await page.keyboard.up("Control"); await sleep(120);
  p = await pos(ids.P);
  ok(near(p.x, 100) && near(p.y, 100), "Ctrl+Z puts it back");
  await click(interior);
  ok((await sel()).join() === ids.P, "a CLICK (no drag) inside the box keeps the selection (Figma)");
  await drag(interior, 40, 12, { shift: true });
  p = await pos(ids.P);
  ok(near(p.x, 140) && near(p.y, 100), `Shift+drag from the interior is the axis-locked move it is on the stroke (${p.x},${p.y}: x only)`);
  await page.keyboard.down("Control"); await page.keyboard.press("z"); await page.keyboard.up("Control"); await sleep(120);
  await page.keyboard.down("Shift"); await click(interior); await page.keyboard.up("Shift");
  ok((await sel()).join() === ids.P, "a Shift-click inside the box is a no-op (selection kept)");
  await page.evaluate((id) => window.__flux.fig.selection.set(new Set([id])), ids.P);
  await sleep(120);
  const sPos = scr(165, 150); // on S, which lies inside P's box and ABOVE the path
  await drag(sPos, 30, 0);
  ok((await sel()).join() === ids.S, "pressing an unselected object that lies ON TOP of the selection inside its box selects that object (it is visibly in front)");
  const s = await pos(ids.S);
  ok(near(s.x, 180) && near((await pos(ids.P)).x, 100), `…and the drag moved IT (${s.x}), not the path`);
  // …but an object BENEATH the selection does not steal the drag (Figma): the selection owns its box
  await reseed();
  await click(onStroke);
  const bPos = scr(320, 105); // on B, inside P's box, well clear of the stroke
  await drag(bPos, 40, 33);
  p = await pos(ids.P);
  ok(near(p.x, 140) && near(p.y, 133) && near((await pos(ids.B)).x, 250), `a drag over an object BENEATH the selected path moves the PATH (${p.x},${p.y}); the block stays`);
  ok((await sel()).join() === ids.P, "…and the path stays selected");
  await reseed();
  await click(onStroke);
  await click(bPos);
  ok((await sel()).join() === ids.B, "a CLICK (no drag) there selects the object beneath instead");
  // a shaky click: 1–2 px of wiggle inside the box neither moves nor records anything
  await reseed();
  await click(onStroke);
  const h1 = (await history()).past;
  await page.mouse.move(interior.x, interior.y); await page.mouse.down();
  await page.mouse.move(interior.x + 1, interior.y + 1); await page.mouse.move(interior.x + 2, interior.y + 1); await page.mouse.move(interior.x + 1, interior.y);
  await page.mouse.up(); await sleep(80);
  p = await pos(ids.P);
  ok(near(p.x, 100, 0) && near(p.y, 100, 0) && (await history()).past === h1 && (await sel()).join() === ids.P, "a click with a 2 px wiggle inside the box moves nothing, writes no history, keeps the selection (3 px drag threshold)");

  // --- 3. Alt duplicates from the box ------------------------------------------------------
  console.log("Alt from the box:");
  await reseed();
  await click(onStroke);
  const n0 = await count();
  await drag(interior, 50, 0, { alt: true });
  ok((await count()) === n0 + 1 && near((await pos(ids.P)).x, 100), "Alt-drag from the interior leaves the original and moves a copy");

  // --- 4. a hollow ellipse ------------------------------------------------------------------
  console.log("Hollow ellipse:");
  await reseed();
  const eCentre = scr(580, 350);
  await click(eCentre);
  ok((await sel()).length === 0, "clicking the hollow middle of an unselected ellipse selects nothing (stroke-only hit, unchanged)");
  await click(scr(500, 350)); // its left extreme, on the stroke
  ok((await sel()).join() === ids.E, "clicking its stroke selects it");
  await drag(eCentre, 30, 30);
  const e = await pos(ids.E);
  ok(near(e.x, 530) && near(e.y, 330), `then a drag from its hollow middle moves it (${e.x},${e.y})`);

  // --- 5. a group's gaps --------------------------------------------------------------------
  console.log("Group:");
  await reseed();
  await page.evaluate((a, b) => window.__flux.fig.selection.set(new Set([a, b])), ids.G1, ids.G2);
  await sleep(100);
  await page.keyboard.down("Control"); await page.keyboard.press("g"); await page.keyboard.up("Control"); await sleep(150);
  const gap = scr(200, 445); // inside the group's box, on neither member
  await drag(gap, 30, 10);
  const g1 = await pos(ids.G1), g2 = await pos(ids.G2);
  ok(near(g1.x, 130) && near(g1.y, 410) && near(g2.x, 290) && near(g2.y, 450), `a drag from the gap between grouped members moves the group (${g1.x},${g1.y} / ${g2.x},${g2.y})`);

  // --- 5b. a click on one member of a multi-selection reduces to it; double-click enters edit ----
  console.log("Multi-selection click, double-click:");
  await reseed();
  await page.evaluate((a, b) => window.__flux.fig.selection.set(new Set([a, b])), ids.G1, ids.G2);
  await sleep(100);
  await click(scr(130, 420)); // on G1
  ok((await sel()).join() === ids.G1, "a plain click on one member of a multi-selection selects just that member (Figma)");
  await page.evaluate((a, b) => window.__flux.fig.selection.set(new Set([a, b])), ids.G1, ids.G2);
  await sleep(100);
  await drag(scr(130, 420), 30, 0);
  ok((await sel()).length === 2 && near((await pos(ids.G2)).x, 290), "…while a drag on a member still moves the whole selection");
  await reseed();
  await click(onStroke);
  await page.mouse.move(interior.x, interior.y);
  await page.mouse.down({ clickCount: 1 }); await page.mouse.up({ clickCount: 1 });
  await page.mouse.down({ clickCount: 2 }); await page.mouse.up({ clickCount: 2 });
  await sleep(150);
  ok((await page.evaluate(() => window.__flux.get(window.__flux.fig.nodeEditId))) === ids.P, "a double-click inside the selected path's box enters node edit (the selection survived the first click)");
  await page.keyboard.press("Escape"); await sleep(80);

  // --- 6. Esc mid-drag still cancels --------------------------------------------------------
  console.log("Cancel:");
  await reseed();
  await click(onStroke);
  await page.mouse.move(interior.x, interior.y); await page.mouse.down();
  for (let i = 1; i <= 5; i++) await page.mouse.move(interior.x + i * 8, interior.y + i * 4);
  await page.keyboard.press("Escape");
  await page.mouse.up(); await sleep(100);
  p = await pos(ids.P);
  ok(near(p.x, 100) && near(p.y, 100), "Escape during a box-grab drag restores the position");

  const errs = realErrors(page);
  ok(errs.length === 0, `console clean (${errs.length})${errs.length ? ": " + errs.slice(0, 2).join(" | ") : ""}`);
} finally {
  await browser.close();
}
console.log(fails ? `VERIFY-BBOX-GRAB-GUI FAIL (${fails})` : "VERIFY-BBOX-GRAB-GUI PASS");
process.exit(fails ? 1 : 0);
