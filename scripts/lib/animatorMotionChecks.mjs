import { mkdirSync } from "node:fs";
import { waitFor } from "./driver.mjs";

const paint = page => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
const read = (page, id) => page.evaluate(id => {
  const f = window.__flux;
  return f.slide.currentDeck().slides.flatMap(s => s.beats.flatMap(b => b.tracks)).find(t => t.id === id);
}, id);
const change = async (page, selector, value) => {
  await page.$eval(selector, (el, value) => { el.value = value; el.dispatchEvent(new Event("change", { bubbles: true })); }, value);
  await paint(page);
};

export async function verifyMotion(page, ok) {
  const ids = await page.evaluate(async () => {
    const f = window.__flux;
    const parts = Array.from({ length: 7 }, (_, i) => ({ id: `m6-point-${i}`, role: "point" }));
    f.plot.cachePlot("m6-asset", `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 100">${parts.map((p,i) => `<circle id="${p.id}" cx="${30+i*50}" cy="50" r="12" fill="#4385be"/>`).join("")}</svg>`,
      { spec: "fluxplot", schemaVersion: "0.2.0", axes: [], series: [], parts: { id: "figure", role: "figure", children: parts } });
    let sid, wave, move;
    f.slide.commitDeckLive(d => {
      const s = f.slideOps.addSlide(d, { layout: "blank", name: "M6 Motion" }); sid = s.id;
      s.elements = [
        { id: "m6-plot", type: "plot", assetId: "m6-asset", x: 100, y: 100, width: 400, height: 100, rotation: 0 },
        { id: "m6-box", type: "rect", x: 100, y: 250, width: 60, height: 60, rotation: 0, fill: "#d0a215", stroke: "none", strokeWidth: 0, cornerRadius: 0 },
      ];
      const b = f.slideOps.addBeat(d, sid, { label: "Wave and arc" });
      wave = f.slideOps.appendAnimation(d, sid, b.id, { target: "m6-plot", parts: parts.map(p => p.id), preset: "fade", duration: 200, stagger: { perMs: 40 } }).id;
      move = f.slideOps.setTransform(d, sid, b.id, "m6-box", { state: { x: 300 }, duration: 1000, easing: "linear" }).id;
    });
    f.slide.selectSlide(sid); f.slide.activeBeat.set(1);
    const { timelinePxPerMs } = await import("/src/shell/modes/slide/animator/animatorState.ts");
    timelinePxPerMs.set(.5);
    return { sid, wave, move };
  });
  await paint(page);
  await page.click(`.lane-row[data-track-id="${ids.wave}"] .track-label`);
  await waitFor(page, () => !!document.querySelector('[aria-label="Stagger mode"]'), null, { timeout: 3000, label: "stagger mode" });
  await page.click('[aria-label="Stagger mode"] button:last-child'); await paint(page);
  let t = await read(page, ids.wave);
  ok(t.stagger.totalMs === 240 && !Object.hasOwn(t.stagger, "perMs"), "Total preserves the existing span and clears Each");
  await change(page, '[aria-label="Stagger milliseconds"]', "800");
  const beforeDistribution = await read(page, ids.wave);
  await page.click('[aria-label="Stagger distribution"]');
  await waitFor(page, () => !!document.querySelector('[aria-label="Stagger distribution curve editor"]'), null, { timeout: 3000, label: "distribution CurveField" });
  ok(!await page.$('.curve-popover .keep'), "distribution CurveField does not retime the effect duration");
  await page.click('.curve-popover [data-curve="bouncy"]'); await paint(page);
  t = await read(page, ids.wave);
  ok(t.stagger.curve?.kind === "spring" && t.stagger.curve.bounce === .35 && t.duration === beforeDistribution.duration && t.curve === beforeDistribution.curve, "distribution CurveField writes stagger.curve without changing the track timing curve");
  await page.keyboard.press("Escape"); await paint(page);
  ok(JSON.stringify(await read(page, ids.wave)) === JSON.stringify(beforeDistribution), "Escape cancels the distribution preview exactly");
  await page.click('[aria-label="Stagger distribution"]');
  await page.click('.curve-popover [data-curve="enter"]');
  await page.click('[aria-label="Commit stagger distribution"]'); await paint(page);
  await page.select('[aria-label="Stagger from"]', "random"); await paint(page);
  const before = await read(page, ids.wave);
  const order = () => page.evaluate(async id => {
    const f = window.__flux, d = f.slide.currentDeck(), s = d.slides.find(s => s.id === f.get(f.fig.activeFigureId));
    const { compileSlide } = await import("/src/lib/slide/compile.ts");
    return compileSlide(s, d.stage, { plotManifest: asset => f.get(f.plot.plotManifests)[asset] }).cues[1].tracks.find(t => t.track.id === id).ranks;
  }, ids.wave);
  const priorOrder = await order();
  await page.click('[aria-label="Reshuffle stagger"]'); await paint(page);
  t = await read(page, ids.wave);
  ok(Number.isInteger(t.stagger.seed) && JSON.stringify(await order()) !== JSON.stringify(priorOrder), "Random reshuffle changes the real compiled order");
  await page.click('[aria-label="Undo"]'); await paint(page);
  ok(JSON.stringify(await read(page, ids.wave)) === JSON.stringify(before) && JSON.stringify(await order()) === JSON.stringify(priorOrder), "one Undo restores the exact Random order and implicit seed");
  await change(page, '[aria-label="Stagger seed"]', "4294967295");
  ok((await read(page, ids.wave)).stagger.seed === 4294967295, "maximum uint32 seed writes through the inspector");
  ok(await page.$eval('[aria-label="Stagger seed"]', el => {
    const style = getComputedStyle(el), ctx = document.createElement("canvas").getContext("2d");
    ctx.font = style.font;
    return el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - 18 >= ctx.measureText(el.value).width;
  }), "the seed field fits all ten digits plus the number spinner");
  mkdirSync("notes/flux_animation_v2/workers/out/shots/M6", { recursive: true });
  await page.screenshot({ path: "notes/flux_animation_v2/workers/out/shots/M6/stagger.png", captureBeyondViewport: false });
  await page.click('[aria-label="Stagger mode"] button:first-child'); await paint(page);
  t = await read(page, ids.wave);
  ok(Math.abs(t.stagger.perMs - 800 / 6) < 1e-9 && !Object.hasOwn(t.stagger, "totalMs") && t.stagger.curve === "enter", "Each derives delay, clears Total, and retains distribution");

  await page.click(`.lane-row[data-track-id="${ids.move}"] .track-label`); await paint(page);
  const oldPath = await page.$eval('.arc-preview path', p => p.getAttribute("d"));
  await page.focus('[aria-label="Transform arc"]');
  for (let i = 0; i < 10; i++) await page.keyboard.press("ArrowRight");
  await paint(page);
  ok((await read(page, ids.move)).arc === .5 && await page.$eval('.arc-preview path', (p, old) => p.getAttribute("d") !== old, oldPath), "Arc slider writes the transform and updates its path preview");
  const ruler = await page.$('.beatrail .ruler'), box = await ruler.boundingBox();
  await page.mouse.click(box.x + 250, box.y + box.height / 2);
  await waitFor(page, () => !!document.querySelector('.preview-host [data-el-id="m6-box"]'), null, { timeout: 5000, label: "arc lane preview" });
  ok(await page.$eval('.preview-host [data-el-id="m6-box"]', el => {
    const transform = new DOMMatrix(el.style.transform);
    return Math.abs(transform.m41 - 100) < 1 && Math.abs(transform.m42 - 25) < 1;
  }), "scrubbing the lane to 500ms displays the real player's arc apex");
  await page.screenshot({ path: "notes/flux_animation_v2/workers/out/shots/M6/arc-inspector.png" });
  await page.click('.preview-stop'); await paint(page);
}
