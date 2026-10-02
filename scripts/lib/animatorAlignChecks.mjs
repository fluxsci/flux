// Animator timeline checks (owner inbox, 2026-10-02): the time grid fills the
// whole visible axis; Alt+A / Alt+D align starts / ends; Ctrl+Alt-drag Inherit.
// Driven through the real dock: real keys, real wheel, real pointer drags.
import { mkdirSync } from "node:fs";
import { waitFor } from "./driver.mjs";

const paint = page => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
const SHOTS = process.env.FLUX_W4_SHOTS || "test-results/animator-align";

/** Seed the owner's FeatureFig scenario (Deck 3 slide 5): path drawOn 0–1000,
 *  rect fadeRise 1000–1952.69 (spring, bounce 0), four ellipses popIn 0–300. */
export async function seedFeatureFig(page) {
  return page.evaluate(async () => {
    const f = window.__flux;
    let sid, bid;
    const el = (type, id, x, y, extra = {}) => ({ type, id, name: id, x, y, width: 60, height: 60, rotation: 0, fill: "#da702c", stroke: "#222222", strokeWidth: 2, ...extra });
    f.slide.commitDeckLive(d => {
      const s = f.slideOps.addSlide(d, { layout: "blank", name: "Align and inherit" }); sid = s.id;
      s.elements = [
        el("rect", "ff-path", 40, 60, { cornerRadius: 0 }), el("rect", "ff-rect", 180, 60, { cornerRadius: 0 }),
        ...[0, 1, 2, 3].map(i => el("ellipse", `ff-ell-${i}`, 420, 30 + i * 70)),
      ];
      const b = f.slideOps.addBeat(d, sid, { label: "Step 1" }); bid = b.id;
      b.tracks = [
        { id: "ff-t-path", target: "ff-path", preset: "drawOn", duration: 1000, start: 0 },
        { id: "ff-t-rect", target: "ff-rect", preset: "fadeRise", duration: 952.6867379224138, start: 1000, curve: { kind: "spring", bounce: 0 } },
        ...[0, 1, 2, 3].map(i => ({ id: `ff-t-ell-${i}`, target: `ff-ell-${i}`, preset: "popIn", duration: 300, start: 0 })),
      ];
    });
    f.slide.selectSlide(sid); f.slide.activeBeat.set(1);
    const { timelinePxPerMs } = await import("/src/shell/modes/slide/animator/animatorState.ts");
    timelinePxPerMs.set(null);
    return { sid, bid };
  });
}

async function gridState(page) {
  return page.evaluate(() => {
    const layer = document.querySelector(".beatrail .grid-layer");
    const lines = [...layer.querySelectorAll(".gl")].map(e => parseFloat(e.style.left)).sort((a, b) => a - b);
    const gaps = lines.slice(1).map((x, i) => x - lines[i]).filter(g => g > .5);
    const sc = document.querySelector(".beatrail .timeline-scroll");
    const bars = [...document.querySelectorAll(".beatrail .lane-row[data-track-id] .trk")].map(b => b.getBoundingClientRect().right - layer.getBoundingClientRect().left);
    return {
      width: layer.getBoundingClientRect().width, last: lines.at(-1), minorPx: Math.min(...gaps), count: lines.length,
      labels: [...document.querySelectorAll(".beatrail .ruler .tick")].map(e => e.textContent),
      barsEnd: Math.max(...bars), overflow: sc.scrollWidth - sc.clientWidth,
    };
  });
}

/** 3.1 — the grid and ruler fill the drawn extent at fit and after ctrl+wheel. */
export async function verifyTimelineGrid(page, ok) {
  mkdirSync(SHOTS, { recursive: true });
  const viewport = page.viewport();
  await page.setViewport({ width: 1900, height: 1000 });
  try {
    await page.evaluate(async () => {
      const f = window.__flux;
      let sid;
      f.slide.commitDeckLive(d => {
        const s = f.slideOps.addSlide(d, { layout: "blank", name: "Grid" }); sid = s.id;
        s.elements = [0, 1].map(i => ({ type: "rect", id: `grid-r${i}`, x: 60 + 200 * i, y: 80, width: 120, height: 80, rotation: 0, fill: "#4385be", stroke: "none", strokeWidth: 0, cornerRadius: 0 }));
        const b = f.slideOps.addBeat(d, sid, { label: "Beat 1" });
        b.tracks = [0, 1].map(i => ({ id: `grid-t${i}`, target: `grid-r${i}`, preset: "fade", duration: 1500, start: 0 }));
      });
      f.slide.selectSlide(sid); f.slide.activeBeat.set(1);
      const { timelinePxPerMs } = await import("/src/shell/modes/slide/animator/animatorState.ts");
      timelinePxPerMs.set(null);
    });
    await waitFor(page, () => document.querySelectorAll(".beatrail .lane-row[data-track-id]").length === 2, null, { timeout: 5000, label: "grid lanes" });
    await paint(page);
    const scroller = await page.$(".beatrail .timeline-scroll"), box = await scroller.boundingBox();
    const at = { x: box.x + box.width / 2, y: box.y + Math.min(box.height - 10, 60) };
    await page.mouse.move(at.x, at.y);
    const hit = await page.evaluate(({ x, y }) => !!document.elementFromPoint(x, y)?.closest(".beatrail .timeline-scroll"), at);
    ok(hit, "the zoom probe's pointer is over the timeline", JSON.stringify({ box, at }));
    const states = [["fit", await gridState(page)]];
    await page.screenshot({ path: `${SHOTS}/grid-fit.png` });
    for (const [name, dy] of [["in 1", -100], ["in 2", -100], ["back 1", 100], ["back 2", 100], ["out 1", 100], ["out 2", 100]]) {
      await page.keyboard.down("Control"); await page.mouse.wheel({ deltaY: dy }); await page.keyboard.up("Control");
      await paint(page);
      states.push([name, await gridState(page)]);
      if (name === "in 1") ok(states.at(-1)[1].minorPx !== states[0][1].minorPx, "Ctrl+wheel zooms the time axis", JSON.stringify(states.map(([, s]) => s.minorPx)));
    }
    for (const [name, s] of states)
      ok(s.last >= s.width - s.minorPx - 1, `grid lines reach the right edge of the time axis (${name}: last line ${s.last.toFixed(0)} px of ${s.width.toFixed(0)}, minor ${s.minorPx.toFixed(1)} px)`, JSON.stringify(s));
    const fit = states[0][1];
    ok(fit.last > fit.barsEnd + 100 && fit.labels.some(l => parseFloat(l) > 1.5), "at fit the ruler keeps labelling past the 1.5 s bars", JSON.stringify(fit));
    ok(states.every(([, s]) => s.count <= 401), "grid node count stays bounded", JSON.stringify(states.map(([, s]) => s.count)));
    ok(fit.overflow === 0 && states.at(-1)[1].overflow === 0, "the extended ruler never widens the scroller at fit or zoomed out", JSON.stringify(states.map(([, s]) => s.overflow)));
    await page.screenshot({ path: `${SHOTS}/grid-zoomed-out.png` });
    await page.evaluate(async () => { const { timelinePxPerMs } = await import("/src/shell/modes/slide/animator/animatorState.ts"); timelinePxPerMs.set(null); });
  } finally {
    await page.setViewport(viewport);
    await paint(page);
  }
}

const timing = page => page.evaluate(() => {
  const f = window.__flux, s = f.slide.currentDeck().slides.find(s => s.id === f.get(f.fig.activeFigureId));
  return Object.fromEntries(s.beats[1].tracks.map(t => [t.id, { start: Math.round((t.start ?? 0) * 100) / 100, duration: Math.round(t.duration * 100) / 100, preset: t.preset, curve: t.curve, anchor: t.anchor }]));
});
const ELL = [0, 1, 2, 3].map(i => `ff-t-ell-${i}`);
const ends = t => ELL.map(id => Math.round((t[id].start + t[id].duration) * 100) / 100);
const starts = t => ELL.map(id => t[id].start);
const all = (xs, v) => xs.every(x => Math.abs(x - v) < .01);
async function chord(page, code, { shift = false } = {}) {
  await page.keyboard.down("Alt"); if (shift) await page.keyboard.down("Shift");
  await page.keyboard.press(code);
  if (shift) await page.keyboard.up("Shift"); await page.keyboard.up("Alt");
  await paint(page);
}
async function undo(page) { await page.keyboard.down("Control"); await page.keyboard.press("KeyZ"); await page.keyboard.up("Control"); await paint(page); }
/** Select the four ellipse lanes the way a user does: click, then Shift-click. */
async function selectEllipses(page) {
  await page.click(`.lane-row[data-track-id="${ELL[0]}"] .track-label`);
  await page.keyboard.down("Shift");
  for (const id of ELL.slice(1)) await page.click(`.lane-row[data-track-id="${id}"] .track-label`);
  await page.keyboard.up("Shift");
  await paint(page);
  return page.evaluate(() => window.__flux.get(window.__flux.slide.selTrackIds));
}

/** 3.2 — Alt+A / Alt+D walk the candidate law, flash the reference line, coalesce into one Undo. */
export async function verifyAlign(page, ok) {
  mkdirSync(SHOTS, { recursive: true });
  for (const dismiss of await page.$$('.toasts button.t-x')) await dismiss.click();
  await seedFeatureFig(page);
  await waitFor(page, () => document.querySelectorAll(".beatrail .lane-row[data-track-id]").length === 6, null, { timeout: 5000, label: "FeatureFig lanes" });
  const picked = await selectEllipses(page);
  ok(picked.length === 4 && picked.every(id => id.startsWith("ff-t-ell-")), "click + Shift-click selects the four ellipse lanes", JSON.stringify(picked));
  const before = await timing(page);
  await chord(page, "KeyD");
  let t = await timing(page);
  ok(all(ends(t), 1000) && all(starts(t), 700) && ELL.every(id => t[id].duration === 300), "Alt+D aligns the ends to path 1's end (starts 700, durations 300)", JSON.stringify(ELL.map(id => t[id])));
  const flash = await page.evaluate(() => ({ line: !!document.querySelector(".beatrail .guide-layer .guide.align-flash"), label: document.querySelector(".beatrail .ruler .align-label")?.textContent ?? "" }));
  ok(flash.line && /‹ff-path› end · 1\.00 s/.test(flash.label), "…the reference line lights with a ruler label naming it", JSON.stringify(flash));
  await page.screenshot({ path: `${SHOTS}/align-end-1.png` });
  await chord(page, "KeyD");
  t = await timing(page);
  ok(all(ends(t), 1952.69), "Alt+D again aligns them to rect 2's end (1.95 s)", JSON.stringify(ends(t)));
  await page.screenshot({ path: `${SHOTS}/align-end-2.png` });
  await chord(page, "KeyD");
  t = await timing(page);
  ok(all(ends(t), 300) && all(starts(t), 0), "a third Alt+D returns to the original ends (a full cycle)", JSON.stringify(ends(t)));
  await chord(page, "KeyD");
  ok(all(ends(await timing(page)), 1000), "…and the cycle starts over");
  await chord(page, "KeyD");
  await undo(page);
  t = await timing(page);
  ok(JSON.stringify(t) === JSON.stringify(before), "one Undo restores the original timing: consecutive presses coalesce into one entry", JSON.stringify(starts(t)));
  await chord(page, "KeyA");
  t = await timing(page);
  ok(all(starts(t), 1000) && ELL.every(id => t[id].duration === 300), "Alt+A (starts already at path 1's 0) aligns the starts to rect 2's start", JSON.stringify(starts(t)));
  await undo(page);
  await chord(page, "KeyD", { shift: true });
  t = await timing(page);
  ok(all(starts(t), 0) && ELL.every(id => t[id].duration === 1000), "Alt+Shift+D resizes: starts stay, the ends land on 1.00 s", JSON.stringify(ELL.map(id => t[id])));
  await undo(page);
  ok(JSON.stringify(await timing(page)) === JSON.stringify(before), "…one Undo restores it");
  await waitFor(page, () => !document.querySelector(".beatrail .align-flash, .beatrail .align-label"), null, { timeout: 3000, label: "flash fades" });
  ok(true, "the flash fades: nothing lit at rest");
  // Two tracks: within the selection first (the owner's second example).
  await page.click('.lane-row[data-track-id="ff-t-path"] .track-label');
  await page.keyboard.down("Shift"); await page.click('.lane-row[data-track-id="ff-t-rect"] .track-label'); await page.keyboard.up("Shift");
  await chord(page, "KeyA");
  t = await timing(page);
  ok(t["ff-t-rect"].start === 0 && t["ff-t-path"].start === 0, "path + rect selected: Alt+A aligns rect 2's start to path 1's", JSON.stringify([t["ff-t-path"], t["ff-t-rect"]]));
  await undo(page);
  await chord(page, "KeyD");
  t = await timing(page);
  ok(Math.abs(t["ff-t-path"].start + t["ff-t-path"].duration - 1952.69) < .01 && t["ff-t-path"].duration === 1000, "…and Alt+D aligns path 1's end to rect 2's end", JSON.stringify(t["ff-t-path"]));
  await undo(page);
  // Nothing to align to: a toast, no edit.
  await page.click('.lane-row[data-track-id="ff-t-path"] .track-label');
  const solo = await timing(page);
  await chord(page, "KeyD");
  ok(JSON.stringify(await timing(page)) === JSON.stringify(solo) && await page.evaluate(() => /Nothing above/.test(document.querySelector(".toasts")?.textContent ?? "")), "the top lane alone: an info toast and no edit");
  // The X-ray owns Alt+A while open.
  await selectEllipses(page);
  await page.evaluate(() => window.__flux.fig.xrayOpen.set(true));
  await paint(page);
  // Opening/closing the X-ray re-syncs the canvas selection; pin the tracks again.
  const pin = () => page.evaluate(ids => { window.__flux.slide.selTrackIds.set(ids); document.querySelector(".animator")?.focus(); }, ELL);
  await pin();
  const xrayed = await page.evaluate(() => ({ sel: window.__flux.get(window.__flux.slide.selTrackIds).length, xray: window.__flux.get(window.__flux.fig.xrayOpen) }));
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyA", key: "a", altKey: true, bubbles: true })));
  await paint(page);
  ok(xrayed.sel === 4 && xrayed.xray && JSON.stringify(await timing(page)) === JSON.stringify(before), "with the X-ray open, Alt+A is the X-ray's (no timeline edit)", JSON.stringify(xrayed));
  await page.evaluate(() => window.__flux.fig.xrayOpen.set(false));
  await paint(page);
  await pin();
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyA", key: "a", altKey: true, bubbles: true })));
  await paint(page);
  const dbg = await page.evaluate(() => ({ sel: window.__flux.get(window.__flux.slide.selTrackIds), active: document.activeElement?.className, xray: window.__flux.get(window.__flux.fig.xrayOpen), toasts: document.querySelector(".toasts")?.textContent }));
  ok(all(starts(await timing(page)), 1000), "control: the same window-dispatched Alt+A with the X-ray closed aligns (the dock owns it)", JSON.stringify(dbg));
  await undo(page);
  // The bar menu offers both.
  await selectEllipses(page);
  const bar = await page.$(`.lane-row[data-track-id="${ELL[1]}"] .trk`), bb = await bar.boundingBox();
  await page.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2, { button: "right" });
  await waitFor(page, () => !!document.querySelector(".menu[role=menu]"), null, { timeout: 3000, label: "bar menu" });
  const items = await page.evaluate(() => [...document.querySelectorAll(".menu[role=menu] button")].map(b => b.textContent));
  ok(items.some(i => /^Align starts.*Alt\+A/.test(i)) && items.some(i => /^Align ends.*Alt\+D/.test(i)), "the bar menu offers Align starts / Align ends with their chords", JSON.stringify(items));
  await page.evaluate(() => [...document.querySelectorAll(".menu[role=menu] button")].find(b => /^Align ends/.test(b.textContent))?.click());
  await paint(page);
  ok(all(ends(await timing(page)), 1000), "the menu's Align ends applies the same first candidate");
  await undo(page);
}
