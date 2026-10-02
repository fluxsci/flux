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
