// FIG-12 gate — Esc aborts an in-flight canvas gesture (V1 readiness 1.5). Drives REAL
// mouse gestures and asserts: a mid-drag Esc leaves the element at its pre-gesture
// position with the selection intact (first Esc = cancel, second = clear); a resize
// cancels to the original box; an alt-drag-copy cancel removes the minted duplicates;
// and a plain Esc with no gesture still clears the selection (pre-existing behavior).
//   Run (dev server on :1420): node scripts/verify-fig-esc.mjs
import { launch, gotoApp, clickMode, realErrors, waitFor, waitForFrame } from "./lib/driver.mjs";

let fails = 0;
const ok = (cond, msg) => (cond ? console.log("  ✓ " + msg) : (fails++, console.log("  ✗ " + msg)));
const near = (a, b, tol = 1.5) => Math.abs(a - b) <= tol;

// viewport fold settled + seeded rects painted (scr() math needs screen == logical coords)
const seededAndSettled = () => {
  const F = window.__flux;
  const g = document.querySelector(".scene-svg > g");
  const scene = document.querySelector(".scene");
  if (!F?.fig || !g || !scene) return false;
  if (!document.querySelector('.scene-svg rect[fill="#d62728"]')) return false;
  const zoom = F.get(F.fig.viewport).zoom;
  const gs = /scale\(([-\d.e]+)/.exec(g.getAttribute("transform") || "");
  const m = /matrix\(([-\d.e]+)/.exec(getComputedStyle(scene).transform);
  return (gs ? Number(gs[1]) : 1) === zoom && Math.abs((m ? Number(m[1]) : 1) - 1) < 1e-9;
};

const { browser, page } = await launch({ width: 1440, height: 900 });
try {
  await page.evaluateOnNewDocument(() => {
    window.__name = window.__name || ((f) => f);
  });
  await gotoApp(page, { url: "http://127.0.0.1:1420/?fixture=demo", settle: 3500 });
  await clickMode(page, "Figure");
  await waitFor(page, () => !!(window.__flux?.fig && window.__flux.figures().length && document.querySelector(".canvas-host")), null, {
    timeout: 15000,
    label: "figure mode ready (dev handle + demo figures + canvas)",
  });

  const ids = await page.evaluate(() => {
    const F = window.__flux.fig;
    const out = [];
    F.commit((p) => {
      const g = p.figures.find((f) => f.id === "growth") || p.figures[0];
      g.x = 0;
      g.y = 0;
      g.width = 800;
      g.height = 500;
      g.elements = [];
      const mk = (fill, x, y) => {
        const id = F.newId("rect");
        g.elements.push({ type: "rect", id, x, y, width: 160, height: 110, rotation: 0, fill, stroke: "#222", strokeWidth: 3, cornerRadius: 0 });
        out.push(id);
      };
      mk("#d62728", 120, 120);
      mk("#2ca02c", 420, 120);
      mk("#1f77b4", 120, 320);
    });
    F.viewport.set({ panX: 60, panY: 120, zoom: 1 });
    return out;
  });
  await waitFor(page, seededAndSettled, null, { label: "seeded scene painted + viewport folded" });

  const geom = (id) =>
    page.evaluate((id) => {
      const e = window.__flux.figures().flatMap((f) => f.elements).find((x) => x.id === id);
      return e ? { x: e.x, y: e.y, w: e.width, h: e.height } : null;
    }, id);
  const elCount = () => page.evaluate(() => window.__flux.figures().flatMap((f) => f.elements).length);
  const selCount = () => page.evaluate(() => window.__flux.get(window.__flux.fig.selection).size);
  const scr = (id, fx = 0.5, fy = 0.5) =>
    page.evaluate(
      ({ id, fx, fy }) => {
        const g = window.__flux.get(window.__flux.fig.project);
        const vp = window.__flux.get(window.__flux.fig.viewport);
        let fig, el;
        for (const f of g.figures) {
          const e = f.elements.find((x) => x.id === id);
          if (e) {
            fig = f;
            el = e;
            break;
          }
        }
        const host = document.querySelector(".canvas-host").getBoundingClientRect();
        const left = host.left + vp.panX + (fig.x + el.x) * vp.zoom;
        const top = host.top + vp.panY + (fig.y + el.y) * vp.zoom;
        return { x: left + el.width * vp.zoom * fx, y: top + el.height * vp.zoom * fy };
      },
      { id, fx, fy },
    );

  // in-page pred helpers: live screen-x of a rect by fill / selection size
  const rectScreenX = (fill) =>
    page.evaluate((f) => document.querySelector(`.scene-svg rect[fill="${f}"]`)?.getBoundingClientRect().x ?? null, fill);
  const waitRectMoved = (fill, x0, minDx, label) =>
    waitFor(
      page,
      ({ f, x0, minDx }) => {
        const el = document.querySelector(`.scene-svg rect[fill="${f}"]`);
        return !!el && Math.abs(el.getBoundingClientRect().x - x0) > minDx;
      },
      { f: fill, x0, minDx },
      { label },
    );
  const waitRectHome = (fill, x0, label) =>
    waitFor(
      page,
      ({ f, x0 }) => {
        const el = document.querySelector(`.scene-svg rect[fill="${f}"]`);
        return !!el && Math.abs(el.getBoundingClientRect().x - x0) < 2;
      },
      { f: fill, x0 },
      { label },
    );
  const waitSel = (n, label) =>
    waitFor(page, (n) => window.__flux.get(window.__flux.fig.selection).size === n, n, { label }).catch(() => {});

  // --- 1. move cancel: element snaps home, selection survives -------------------------
  console.log("Esc cancels a MOVE:");
  await page.evaluate((id) => window.__flux.fig.selectOnly(id), ids[0]);
  await waitSel(1, "element selected (move case)");
  let c = await scr(ids[0]);
  const homeX = await rectScreenX("#d62728");
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(c.x + i * 15, c.y + i * 9);
  await waitRectMoved("#d62728", homeX, 50, "transient move visible mid-drag");
  await page.keyboard.press("Escape");
  await waitRectHome("#d62728", homeX, "Esc snapped the element home");
  await page.mouse.up();
  await waitForFrame(page); // a (wrong) commit would land with this paint
  let g0 = await geom(ids[0]);
  ok(near(g0.x, 120) && near(g0.y, 120), `element back at its pre-drag position (${g0.x},${g0.y})`);
  ok((await selCount()) === 1, "selection survives the cancel (first Esc ≠ deselect)");

  // --- 2. second Esc (no gesture) clears the selection ---------------------------------
  await page.keyboard.press("Escape");
  await waitSel(0, "plain Esc cleared the selection");
  ok((await selCount()) === 0, "a plain Esc still clears the selection");

  // --- 3. resize cancel ------------------------------------------------------------------
  console.log("Esc cancels a RESIZE:");
  await page.evaluate((id) => window.__flux.fig.selectOnly(id), ids[1]);
  await waitFor(page, () => document.querySelectorAll(".overlay-svg .handle").length === 8, null, {
    label: "resize handles mounted",
  });
  c = await scr(ids[1], 1, 1); // SE corner handle sits at the box corner
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(c.x + i * 10, c.y + i * 8);
  // a resize FREEZES the original (style:visibility hidden, layout kept) and previews on
  // the overlay — the engaged gesture is observable as the original turning invisible
  await waitFor(
    page,
    () => {
      const el = document.querySelector('.scene-svg rect[fill="#2ca02c"]');
      return !!el && getComputedStyle(el).visibility === "hidden";
    },
    null,
    { label: "resize gesture engaged (original frozen invisible)" },
  );
  await page.keyboard.press("Escape");
  await waitFor(
    page,
    () => {
      const el = document.querySelector('.scene-svg rect[fill="#2ca02c"]');
      return !!el && getComputedStyle(el).visibility === "visible";
    },
    null,
    { label: "Esc unfroze the original" },
  );
  await page.mouse.up();
  await waitForFrame(page);
  const g1 = await geom(ids[1]);
  ok(near(g1.w, 160) && near(g1.h, 110), `size back to pre-drag (${g1.w}×${g1.h})`);

  // --- 4. alt-drag-copy cancel removes the minted duplicates ------------------------------
  console.log("Esc cancels an ALT-DRAG COPY:");
  await page.evaluate((id) => window.__flux.fig.selectOnly(id), ids[2]);
  await waitSel(1, "element selected (alt-copy case)");
  c = await scr(ids[2]);
  await page.keyboard.down("Alt");
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(c.x + i * 14, c.y);
  await waitFor(page, () => window.__flux.figures().flatMap((f) => f.elements).length === 4, null, {
    label: "duplicate minted mid-drag",
  }).catch(() => {});
  const midCount = await elCount();
  ok(midCount === 4, `duplicate exists mid-drag (${midCount} elements)`);
  await page.keyboard.press("Escape");
  await waitForFrame(page); // cancel may drop the copy on Esc or on release — assert after both
  await page.mouse.up();
  await page.keyboard.up("Alt");
  await waitFor(page, () => window.__flux.figures().flatMap((f) => f.elements).length === 3, null, {
    label: "cancel removed the copy",
  }).catch(() => {});
  const endCount = await elCount();
  const g2 = await geom(ids[2]);
  ok(endCount === 3, `cancel removed the copy (${endCount} elements)`);
  ok(near(g2.x, 120) && near(g2.y, 320), `original back at its position (${g2.x},${g2.y})`);

  // --- 5. a normal (uncancelled) drag still commits ----------------------------------------
  console.log("Normal drags still commit:");
  await page.evaluate((id) => window.__flux.fig.selectOnly(id), ids[0]);
  await waitSel(1, "element selected (normal-drag case)");
  c = await scr(ids[0]);
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(c.x + i * 10, c.y + i * 5);
  await page.mouse.up();
  await waitFor(
    page,
    (id) => window.__flux.figures().flatMap((f) => f.elements).find((e) => e.id === id)?.x !== 120,
    ids[0],
    { label: "uncancelled move committed" },
  ).catch(() => {});
  g0 = await geom(ids[0]);
  // Smart-guide snapping may adjust the landing by a few px — the assertion is that the
  // move COMMITTED (Esc-cancel plumbing didn't break normal drags), not exact pixels.
  ok(near(g0.x, 220, 8) && near(g0.y, 170, 8), `uncancelled move committed (${g0.x},${g0.y})`);

  const errs = realErrors(page);
  ok(errs.length === 0, errs.length ? `console errors: ${errs.join(" | ").slice(0, 200)}` : "zero console errors");
} finally {
  await browser.close();
}
console.log(fails ? `\nFIG-ESC VERIFY: FAIL — ${fails}` : "\nFIG-ESC VERIFY: PASS");
process.exit(fails ? 1 : 0);
