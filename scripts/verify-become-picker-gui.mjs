// 2026-10-02 — the Slide "Become picker" mode in the real editor (owner ask "A
// better 'Become' UI", Deck 3 slide 3). Real controls and canvas gestures on a
// seeded slide: a source rect, a grouped pair of ellipses, two loose ellipses
// and a cached 60-point scatter plot. Pins the mode accent (and that it rests),
// hover outline + lane-named readout, click toggles, Alt+click whole object,
// marquee = exactly the fully-inside points, `a` widening, `b` confirm, double-
// click fast path, Escape cancel (source selection restored), Add mode (drawn
// objects join the pick), X-ray rows toggling picks live, Appear from… on the
// same picker, Animate like… single-click, one Undo per commit, the hover
// path's structural budget, and a clean console.
import { readFileSync } from "node:fs";
import { launch, gotoApp, clickMode, APP_URL, waitFor, realErrors } from "./lib/driver.mjs";
import { harness } from "./lib/harness.mjs";

const h = harness("verify-become-picker-gui");
const { browser, page } = await launch({ width: 1500, height: 1040 });
const paint = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
const clickText = async (selector, text) => { await page.evaluate(({ selector, text }) => { const el = [...document.querySelectorAll(selector)].find((e) => e.textContent.trim().startsWith(text)); if (!el) throw new Error("Missing " + text); el.click(); }, { selector, text }); await paint(); };
const slideState = () => page.evaluate(() => { const f = window.__flux, d = f.slide.currentDeck(), id = f.get(f.fig.activeFigureId); return { slide: d.slides.find((s) => s.id === id), selected: [...f.get(f.fig.selection)] }; });
const tracks = async () => (await slideState()).slide.beats.flatMap((b) => b.tracks);
const units = () => page.$$eval("[data-pick-unit]", (els) => els.map((e) => e.getAttribute("data-pick-unit").replace("\u0000", "/")).sort());
const layer = () => page.$eval("[data-pick-layer]", (e) => e.getAttribute("data-pick-layer")).catch(() => null);
const barKind = () => page.$eval("[data-pick-bar]", (e) => e.getAttribute("data-pick-bar")).catch(() => null);
const center = (id) => page.$eval(`[data-editor-element-id="${id}"]`, (e) => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, r: { x: r.x, y: r.y, w: r.width, h: r.height } }; });
const mod = process.platform === "darwin" ? "Meta" : "Control";
const svg = readFileSync("scripts/fixtures/plots/mpl_scatter_FLUXPLOT.svg", "utf8");
const manifest = JSON.parse(readFileSync("scripts/fixtures/plots/mpl_scatter_FLUXPLOT.fluxplot.json", "utf8"));
const pointIds = manifest.series[0].points.map((p) => p.svgId);

async function seed() {
  await page.evaluate(() => {
    const f = window.__flux, sid = f.get(f.fig.activeFigureId);
    f.get(f.fig.xrayOpen) && f.fig.xrayOpen.set(false);
    f.slide.setEditDestination({ kind: "design" }); f.slide.selTrackIds.set([]); f.fig.partSelection.set(null); f.fig.selection.set(new Set());
    f.fig.activeTool.set("select");
    f.slide.commitDeckLive((d) => {
      d.stage = { width: 640, height: 360 };
      const s = f.slideOps.slideById(d, sid);
      s.groups = { "pk-grp": { id: "pk-grp", name: "Pair" } };
      const el = (id, type, x, y, w, hh, fill, extra = {}) => ({ id, type, name: id === "pk-src" ? "Source" : undefined, x, y, width: w, height: hh, rotation: 0, fill, stroke: "none", strokeWidth: 0, ...(type === "rect" ? { cornerRadius: 0 } : {}), ...extra });
      s.elements = [
        el("pk-src", "rect", 30, 30, 90, 60, "#d95f02"),
        el("pk-g1", "ellipse", 30, 150, 50, 50, "#4385be", { groupId: "pk-grp" }),
        el("pk-g2", "ellipse", 90, 150, 50, 50, "#4385be", { groupId: "pk-grp" }),
        el("pk-e1", "ellipse", 30, 260, 50, 50, "#879a39"),
        el("pk-e2", "ellipse", 100, 260, 50, 50, "#879a39"),
        { id: "pk-plot", type: "plot", name: "Scatter", assetId: "pk-scatter", x: 250, y: 20, width: 370, height: 320, rotation: 0, overrides: {} },
      ];
      s.beats = [{ id: "pk-design", label: "Design", tracks: [] }, { id: "pk-step", label: "Landing", advance: "click", tracks: [
        { id: "pk-like-a", target: "pk-e1", preset: "fade", duration: 500, start: 0 },
        { id: "pk-like-b", target: "pk-e2", preset: "rise", duration: 700, start: 0 },
      ] }];
    });
    f.slide.activeBeat.set(1); f.fig.selectOnly("pk-src");
  });
  await paint();
  await clickText(".edit-statebar button", "Fit");
}
async function armBecome() {
  await clickText(".animator .actions button", "Transform ▾");
  await page.waitForSelector('.menu button[role="menuitem"]');
  await clickText('.menu button[role="menuitem"]', "Become");
  await waitFor(page, () => !!document.querySelector("[data-pick-layer]"), null, { label: "pick layer" });
}
const pointAt = (pid) => page.evaluate((pid) => {
  const w = document.querySelector('[data-editor-element-id="pk-plot"]');
  const n = [...w.querySelectorAll("[id]")].find((e) => e.id.endsWith("__" + pid));
  const r = n.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), r: { x: r.x, y: r.y, w: r.width, h: r.height } };
}, pid);
const drag = async (a, b, { alt = false } = {}) => {
  if (alt) await page.keyboard.down("Alt");
  await page.mouse.move(a.x, a.y); await page.mouse.down();
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 4 }); await page.mouse.move(b.x, b.y, { steps: 4 });
  await page.mouse.up(); if (alt) await page.keyboard.up("Alt"); await paint();
};
const undo = async () => { await page.click('[aria-label="Undo"]'); await paint(); };

try {
  await gotoApp(page, { url: APP_URL + "?fixture=demo", settle: 200 });
  await clickMode(page, "Slide", { settle: 200 });
  await waitFor(page, () => !!window.__flux?.get(window.__flux.slide.deckOverlay), null, { timeout: 15000, label: "deck load" });
  await page.evaluate((svg, manifest) => window.__flux.io.reimportPlot("pk-scatter", svg, manifest), svg, manifest);
  const setsSupported = await page.evaluate(async () => typeof (await import("/src/lib/slide/targets.ts")).normalizeRef === "function");
  await seed();
  await clickText(".deckbar button", "Animate ⏱");
  await clickText(".edit-statebar button", "Fit");

  h.section("entering the mode — the accent");
  await armBecome();
  const frame = await page.evaluate(() => {
    const f = document.querySelector("[data-pick-frame]"), bg = document.querySelector("rect.figure-bg.active") ?? document.querySelector("rect.figure-bg");
    const a = f.getBoundingClientRect(), b = bg.getBoundingClientRect();
    return { shadow: getComputedStyle(f).boxShadow, dx: Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + Math.abs(a.width - b.width) + Math.abs(a.height - b.height) };
  });
  h.ok(/rgb\(135, 154, 57\) 0px 0px 0px 1\.5px/.test(frame.shadow) && /0px 0px 22px/.test(frame.shadow), "the stage wears the --c-pick outline (1.5 px) and its 22 px halo");
  h.ok(frame.dx < 2, `the accent sits exactly on the slide frame (Δ ${frame.dx.toFixed(2)} px)`);
  h.ok(await layer() === "pick" && await barKind() === "pick", "the Become bar replaces the edit state bar");
  const armed = await slideState();
  h.ok(!armed.selected.length && !!(await page.$("[data-pick-source]")), "the canvas selection clears; the source wears the dashed pick outline");
  h.ok(await page.$eval(".become-msg", (e) => e.textContent.includes("Source") && e.textContent.includes("becomes")), "the bar names what is waiting (\"Source becomes…\")");
  await page.evaluate(() => new Promise((r) => setTimeout(r, 400))); // kept: lets the 220 ms entry finish
  h.ok(await page.evaluate(() => document.getAnimations().filter((a) => a.playState === "running" && a.effect?.target?.closest?.("[data-pick-layer], .become-bar")).length === 0), "after its one entry the mode RESTS (no running animation)");

  h.section("hover — outline + readout named like the lane");
  const p0 = await pointAt(pointIds[0]);
  await page.mouse.move(p0.x, p0.y); await paint();
  h.eq(await page.$eval("[data-pick-hover]", (e) => e.getAttribute("data-pick-hover").replace("\u0000", "/")), `p:pk-plot/${pointIds[0]}`, "hovering a point outlines exactly that point (the semantic leaf)");
  const readout = await page.$eval("[data-pick-readout]", (e) => e.innerText.replace(/\s+/g, " "));
  h.ok(/Scatter › /.test(readout) && /x\s*=/.test(readout), `the bar's readout names it as its lane would, with its data ("${readout.slice(0, 60)}")`);

  h.section("click toggles; Alt+click whole object");
  await page.mouse.click(p0.x, p0.y); await paint();
  h.eq(await units(), [`p:pk-plot/${pointIds[0]}`], "a plain click picks the point (no modifier)");
  h.ok(await page.$eval("[data-pick-count]", (e) => e.textContent.trim() === "1 picked"), "the bar counts the pick");
  await page.mouse.click(p0.x, p0.y); await paint();
  h.eq(await units(), [], "clicking it again unpicks it");
  await page.keyboard.down("Alt"); await page.mouse.click(p0.x, p0.y); await page.keyboard.up("Alt"); await paint();
  h.eq(await units(), ["e:pk-plot"], "Alt+click picks the whole plot");
  await page.mouse.click(p0.x, p0.y); await paint();
  h.eq(await units(), [`p:pk-plot/${pointIds[0]}`], "a plain click on its point refines the whole plot to that point");
  const g1 = await center("pk-g1");
  await page.mouse.click(g1.x, g1.y); await paint();
  h.ok((await units()).includes("e:pk-g1"), "a grouped ellipse picks as the member itself");
  await page.keyboard.down("Alt"); await page.mouse.click(g1.x, g1.y); await page.keyboard.up("Alt"); await paint();
  h.ok((await units()).includes("g:pk-grp") && !(await units()).includes("e:pk-g1"), "Alt+click on a member picks its whole group instead");
  await page.keyboard.press("Escape"); await paint();
  h.ok(!(await page.$("[data-pick-layer]")) && JSON.stringify((await slideState()).selected) === '["pk-src"]' && !(await tracks()).some((t) => t.to?.become), "Escape cancels: no transform, the source selection is back");

  h.section("marquee — exactly the fully-inside points");
  await armBecome();
  const pts = await Promise.all(pointIds.map(pointAt));
  const wrap = await page.$eval(".canvas-wrap", (e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
  const plotBox = (await center("pk-plot")).r;
  const box = { x0: plotBox.x + plotBox.w * 0.3, y0: plotBox.y + plotBox.h * 0.25, x1: plotBox.x + plotBox.w * 0.7, y1: plotBox.y + plotBox.h * 0.75 };
  // The law has a 0.5 stage-px tolerance: strictly-inside points must be picked,
  // points within the tolerance band may be, nothing else.
  const within = (r, t) => r.x >= box.x0 - t && r.y >= box.y0 - t && r.x + r.w <= box.x1 + t && r.y + r.h <= box.y1 + t;
  const inside = pointIds.filter((_, i) => within(pts[i].r, -0.25));
  const loose = new Set(pointIds.filter((_, i) => within(pts[i].r, 2)).map((p) => `p:pk-plot/${p}`));
  await drag({ x: box.x0, y: box.y0 }, { x: box.x1, y: box.y1 });
  const marqueed = await units();
  h.ok(inside.length >= 3, `the test box holds ${inside.length} whole points`);
  h.ok(inside.every((p) => marqueed.includes(`p:pk-plot/${p}`)) && marqueed.every((u) => loose.has(u)), `a marquee picks exactly the points fully inside it — no ticks, labels, scaffold or half-in points (${marqueed.length} picked, ${inside.length} strictly inside)`);
  h.ok(await page.$$eval("[data-pick-chip]", (els) => els.length === 1 && /points/.test(els[0].textContent)), `the picks collapse into one chip (\"${inside.length} points …\")`);
  const sub = inside.slice(0, 2).map((p) => pts[pointIds.indexOf(p)]);
  await drag({ x: Math.min(...sub.map((p) => p.r.x)) - 1, y: Math.min(...sub.map((p) => p.r.y)) - 1 }, { x: Math.max(...sub.map((p) => p.r.x + p.r.w)) + 1, y: Math.max(...sub.map((p) => p.r.y + p.r.h)) + 1 }, { alt: true });
  h.ok((await units()).length <= inside.length - 2 + 0 && !(await units()).includes(`p:pk-plot/${inside[0]}`), "Alt+drag removes what it encloses");
  // `a`: the last pick's siblings — the 60 points of its series.
  await page.keyboard.press("a"); await paint();
  h.eq((await units()).length, pointIds.length, "a widens the pick to its siblings (every point of the series)");
  h.eq(await page.$$eval("[data-pick-badge]", (e) => e.length), 0, "order badges switch off for a dense set (> 20 picks)");
  h.section("b confirms; one Undo");
  await page.keyboard.press("b"); await paint();
  let handoff = (await tracks()).find((t) => t.to?.become);
  h.ok(handoff?.target === "pk-src" && handoff.to.become.ref.element === "pk-plot" && handoff.to.become.ref.parts.length === pointIds.length && handoff.to.become.mode === "handoff", "b commits ONE hand-off into all sixty points");
  h.ok(!(await page.$("[data-pick-layer]")) && await page.evaluate(() => [...document.querySelectorAll(".toast")].some((t) => t.textContent.includes("hands off to"))), "the mode ends with the hand-off toast");
  await undo();
  h.ok(!(await tracks()).some((t) => t.to?.become), "one Undo removes the hand-off");

  h.section("double-click fast path");
  await seed(); await armBecome();
  const e1 = await center("pk-e1");
  await page.mouse.click(e1.x, e1.y, { count: 1 }); await page.mouse.click(e1.x, e1.y, { count: 2 }); await paint();
  let st = await slideState();
  const consumed = st.slide.beats[1].tracks.find((t) => t.target === "pk-src" && t.preset === "transform");
  h.ok(consumed?.to?.state?.type === "ellipse" && !st.slide.elements.some((e) => e.id === "pk-e1") && !(await page.$("[data-pick-layer]")), "double-clicking a loose ellipse picks it and confirms at once (consume)");
  await undo();
  h.ok((await slideState()).slide.elements.some((e) => e.id === "pk-e1") && !(await tracks()).some((t) => t.target === "pk-src" && t.preset === "transform"), "one Undo restores the ellipse and removes the transform");

  h.section("Add mode — drawn objects join the pick");
  await seed(); await armBecome();
  await page.keyboard.press("r"); await paint();
  h.ok(await layer() === "add" && await barKind() === "add", "a drawing tool key enters Add mode (inner hairline, \"Adding…\" bar)");
  const before = (await slideState()).slide.elements.map((e) => e.id);
  await drag({ x: wrap.x + wrap.w * 0.18, y: wrap.y + wrap.h * 0.08 }, { x: wrap.x + wrap.w * 0.24, y: wrap.y + wrap.h * 0.16 });
  const drawnId = (await slideState()).slide.elements.map((e) => e.id).find((id) => !before.includes(id));
  h.ok(!!drawnId && (await units()).includes(`e:${drawnId}`), "the drawn rect joins the pick automatically");
  h.ok(!(await tracks()).some((t) => t.target === "pk-src" && t.preset === "transform"), "drawing no longer confirms by itself");
  await page.keyboard.press("Enter"); await paint();
  h.ok(await layer() === "pick" && (await units()).includes(`e:${drawnId}`), "Enter returns to picking with the drawn rect picked");
  await page.keyboard.press("b"); await paint();
  st = await slideState();
  const drawnBecome = st.slide.beats[1].tracks.find((t) => t.target === "pk-src" && t.preset === "transform");
  h.ok(!!drawnBecome && !st.slide.elements.some((e) => e.id === drawnId), "b makes the source become the drawn rect (consumed, as a loose rect always is)");
  await undo();
  // A set mixing the drawn rect and a plot point needs W1's destination sets.
  await seed(); await armBecome();
  await page.mouse.click(p0.x, p0.y); await paint();
  await clickText(".become-bar button", "Add ▾"); await clickText('.menu button[role="menuitem"]', "Ellipse");
  h.ok(await layer() === "add", "the bar's Add ▾ menu enters Add mode too");
  const before2 = (await slideState()).slide.elements.map((e) => e.id);
  await drag({ x: wrap.x + wrap.w * 0.18, y: wrap.y + wrap.h * 0.08 }, { x: wrap.x + wrap.w * 0.24, y: wrap.y + wrap.h * 0.16 });
  const drawn2 = (await slideState()).slide.elements.map((e) => e.id).find((id) => !before2.includes(id));
  await page.keyboard.press("Escape"); await paint();
  h.ok(await layer() === "pick" && (await units()).length === 2, "Escape leaves Add mode first, keeping both picks");
  await page.keyboard.press("b"); await paint();
  const setTrack = (await tracks()).find((t) => t.target === "pk-src" && t.to?.become);
  if (setsSupported) h.ok(setTrack?.to.become.ref.members?.some((m) => m.element === drawn2) && setTrack.to.become.ref.members.some((m) => m.element === "pk-plot"), "b commits the mixed set (drawn ellipse + point) as one set destination");
  else h.ok(!setTrack && await layer() === "pick" && await page.evaluate(() => [...document.querySelectorAll(".toast")].some((t) => t.textContent.includes("Pick parts of one object, or one object"))), "without destination sets a mixed pick is refused clearly and the mode stays armed");
  await page.keyboard.press("Escape"); await paint();
  if (setsSupported && setTrack) await undo();
  h.ok(!(await page.$("[data-pick-layer]")), "a second Escape cancels the whole pick");

  h.section("X-ray parity — rows toggle picks live");
  await seed(); await armBecome();
  await page.mouse.click(p0.x, p0.y); await paint();
  const pc = await center("pk-plot");
  await page.mouse.move(pc.x, pc.y);
  await page.keyboard.down("Alt"); await page.keyboard.press("KeyR"); await page.keyboard.up("Alt");
  await waitFor(page, () => document.activeElement?.classList.contains("xray"), null, { label: "X-ray focus" });
  const spineRow = '.xray [data-rid="part:pk-plot__axis.x.spine"]';
  if (!(await page.$(spineRow))) await page.$eval('.xray [data-rid="part:pk-plot__axis.x"] .tw', (e) => e.click());
  await page.keyboard.down(mod); await page.click(spineRow); await page.keyboard.up(mod); await paint();
  h.eq(await units(), [`p:pk-plot/${pointIds[0]}`, "p:pk-plot/axis.x.spine"].sort(), "an X-ray row joins the pick live (the canvas outline follows), the canvas point stays");
  const ticksRow = '.xray [data-rid="part:pk-plot__axis.x.ticks"]';
  await page.keyboard.down(mod); await page.click(ticksRow); await page.keyboard.up(mod); await paint();
  h.eq(await units(), [`p:pk-plot/${pointIds[0]}`, "p:pk-plot/axis.x.spine", "p:pk-plot/axis.x.ticks"].sort(), "a second row joins too");
  await page.keyboard.down(mod); await page.click(ticksRow); await page.keyboard.up(mod); await paint();
  h.eq(await units(), [`p:pk-plot/${pointIds[0]}`, "p:pk-plot/axis.x.spine"].sort(), "toggling a row off unpicks it live");
  await page.keyboard.press("Escape"); await paint();
  h.ok(!(await page.$(".xray")) && await layer() === "pick" && (await units()).length === 2, "closing the X-ray keeps the picks and the mode");
  await page.mouse.move(pc.x, pc.y);
  await page.keyboard.down("Alt"); await page.keyboard.press("KeyR"); await page.keyboard.up("Alt");
  await waitFor(page, () => document.activeElement?.classList.contains("xray"), null, { label: "X-ray focus again" });
  await page.keyboard.press("b"); await paint();
  handoff = (await tracks()).find((t) => t.to?.become);
  h.ok(JSON.stringify(handoff?.to.become.ref) === JSON.stringify({ element: "pk-plot", parts: [pointIds[0], "axis.x.spine"] }), "b in the X-ray confirms the whole pick (canvas point + row)");
  await undo();

  h.section("Appear from… uses the same picker");
  await seed();
  await page.evaluate(() => window.__flux.fig.selectOnly("pk-e2")); await paint();
  await page.click('[aria-label="Appear options"]'); await clickText('.menu button[role="menuitem"]', "Appear from…");
  h.ok(await layer() === "pick" && await page.$eval(".become-msg", (e) => e.textContent.includes("appears from")), "Appear from… enters the picker (\"… appears from…\")");
  const src = await center("pk-src");
  await page.mouse.click(src.x, src.y); await paint();
  h.eq(await units(), ["e:pk-src"], "a click picks what it appears from");
  await page.keyboard.press("Enter"); await paint();
  const appear = (await tracks()).find((t) => t.to?.become?.ref?.element === "pk-e2");
  h.ok(appear?.target === "pk-src" && !(await page.$("[data-pick-layer]")), "Enter writes the shared source-owned record");
  await undo();

  h.section("Animate like… keeps single-click");
  await seed();
  // dispatched on the lane itself: a toast from the previous section may sit over the timeline
  await page.$eval('.lane-row[data-track-id="pk-like-a"]', (el) => { const r = el.getBoundingClientRect(); el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.x + 40, clientY: r.y + r.height / 2 })); }); await paint();
  await clickText('.menu button[role="menuitem"]', "Animate like…");
  h.ok(await layer() === "like" && await barKind() === "like", "Animate like… wears the same mode accent and bar");
  const e2 = await center("pk-e2");
  await page.mouse.move(e2.x, e2.y); await paint();
  h.ok(await page.$eval("[data-pick-readout]", (e) => /Rise|rise/.test(e.textContent)), "hovering names the effect that object has in this step");
  await page.mouse.click(e2.x, e2.y); await paint();
  let liked = await tracks();
  const a = liked.find((t) => t.id === "pk-like-a"), b = liked.find((t) => t.id === "pk-like-b");
  h.ok(!!a?.styleId && a.styleId === b?.styleId && !(await page.$("[data-pick-layer]")), "one click links both effects to one style and ends the mode");
  await undo();
  liked = await tracks();
  h.ok(!liked.find((t) => t.id === "pk-like-a")?.styleId, "one Undo unlinks it");

  h.section("hover stays in the instantaneous class");
  await seed(); await armBecome();
  const sweep = pts.slice(0, 20);
  const before3 = await page.evaluate(() => { const p = window.__flux.perf; window.__qsa = 0; const q = Element.prototype.querySelectorAll; window.__qsaOrig = q; Element.prototype.querySelectorAll = function (...a) { window.__qsa++; return q.apply(this, a); }; return { ...p }; });
  for (const p of sweep) { await page.mouse.move(p.x, p.y); }
  await paint();
  const after3 = await page.evaluate(() => { Element.prototype.querySelectorAll = window.__qsaOrig; return { ...window.__flux.perf, qsa: window.__qsa }; });
  const changes = after3.pickHoverChanges - before3.pickHoverChanges, moves = after3.pickHoverMoves - before3.pickHoverMoves;
  const mean = (after3.pickHoverMs - before3.pickHoverMs) / Math.max(1, moves);
  h.ok(changes >= 15, `a 20-point sweep re-resolves the hovered unit (${changes} changes over ${moves} moves)`);
  h.ok(after3.qsa === 0, `no querySelectorAll scans on the hover path (${after3.qsa})`);
  h.ok(mean <= 8 && after3.pickHoverWorstMs <= 50, `hover handling ${mean.toFixed(2)} ms mean, ${after3.pickHoverWorstMs.toFixed(1)} ms worst (dev build; ≤ 100 ms class)`);
  await page.keyboard.press("Escape"); await paint();

  h.ok(realErrors(page).length === 0, `no renderer errors${realErrors(page).length ? ": " + realErrors(page).join(" | ") : ""}`);
} catch (error) {
  console.error(error);
  h.fail(String(error?.message ?? error));
  await page.screenshot({ path: "test-results/become-picker-failure.png" }).catch(() => {});
}
await h.done(() => browser.close());
