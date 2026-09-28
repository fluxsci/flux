import { mkdirSync, writeFileSync } from "node:fs";
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
  // Dismiss the preceding gate's intentional error toast before motion screenshots.
  for (const dismiss of await page.$$('.toasts button.t-x')) await dismiss.click();
  const shots = "notes/flux_animation_v2/workers/out/shots/M6";
  mkdirSync(shots, { recursive: true });
  const shot = name => page.screenshot({ path: `${shots}/${name}.png` });
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
  await shot("qa-01-each");
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
  await shot("qa-03-random-default-seed");
  await page.click('[aria-label="Reshuffle stagger"]'); await paint(page);
  t = await read(page, ids.wave);
  ok(Number.isInteger(t.stagger.seed) && JSON.stringify(await order()) !== JSON.stringify(priorOrder), "Random reshuffle changes the real compiled order");
  await shot("qa-04-reshuffled");
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
  await shot("qa-06-each-restored");

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

  // F2 library Apply must carry M6's saved HOW field through setTransform.
  // Saving alone is insufficient: the transform branch forwards fields explicitly.
  await page.click('.props .saveas');
  await page.type('.props .psave input', 'M6 Arc preset');
  await page.click('.props .psave button');
  await waitFor(page, () => JSON.parse(localStorage.getItem('flux.presets.animations') || '[]').some(p => p.payload.name === 'M6 Arc preset'), null, { label: 'Arc preset saved' });
  ok(await page.evaluate(() => JSON.parse(localStorage.getItem('flux.presets.animations')).find(p => p.payload.name === 'M6 Arc preset').payload.track.arc === .5), 'Save as preset retains the authored Arc value');
  const targetId = await page.evaluate(sid => {
    const f = window.__flux;
    let tid;
    f.slide.commitDeckLive(d => {
      const s = f.slideOps.slideById(d, sid);
      s.elements.push({ id: 'm6-preset-target', type: 'rect', x: 400, y: 250, width: 60, height: 60, rotation: 0, fill: '#4385be', stroke: 'none', strokeWidth: 0, cornerRadius: 0 });
      tid = f.slideOps.setTransform(d, sid, s.beats[1].id, 'm6-preset-target', { state: { x: 500 }, duration: 600, arc: -.25 }).id;
    });
    f.fig.selectOnly('m6-preset-target');
    return tid;
  }, ids.sid);
  await paint(page);
  const targetBefore = await read(page, targetId);
  await page.evaluate(() => [...document.querySelectorAll('.animator .bar button')].find(b => /Library/.test(b.textContent || '')).click());
  await waitFor(page, () => !!document.querySelector('.animlib .apply'), null, { label: 'Arc preset library' });
  await shot('qa-07-arc-preset-library');
  const buttons = await page.$$('.animlib .apply');
  for (const button of buttons) if (await button.evaluate(b => b.textContent.includes('M6 Arc preset'))) { await button.click(); break; }
  await paint(page);
  const applied = await read(page, targetId);
  ok(applied.arc === .5 && applied.duration === 1000 && applied.to.state.x === 500, 'library Apply copies Arc while preserving the destination geometry');
  await shot('qa-08-arc-preset-applied');
  await page.click('[aria-label="Undo"]'); await paint(page);
  ok(JSON.stringify(await read(page, targetId)) === JSON.stringify(targetBefore), 'one Undo restores the pre-preset Arc and timing');
  // Mixed selection: the new cascade fields target only their eligible lanes.
  const cascadeBefore = [await read(page, ids.wave), await read(page, ids.move)];
  const openCascade = async () => {
    await page.evaluate(ids => { document.activeElement?.blur(); window.__flux.slide.selTrackIds.set(ids); }, [ids.wave, ids.move]);
    await paint(page);
    await page.keyboard.down('Control'); await page.keyboard.down('Shift');
    await page.keyboard.press('KeyC');
    await page.keyboard.up('Shift'); await page.keyboard.up('Control');
    await waitFor(page, () => !!document.querySelector('.cascade-pop'), null, { label: 'M6 mixed track cascade' });
  };
  const delta = async value => {
    await page.$eval('.cascade-pop input.delta', (el, value) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, String(value));
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }, value);
    await paint(page);
  };
  await openCascade();
  await page.select('.cascade-pop select.prop', 'arc'); await delta(.1);
  ok(Math.abs((await read(page, ids.move)).arc - .6) < 1e-9 && JSON.stringify(await read(page, ids.wave)) === JSON.stringify(cascadeBefore[0]), 'real Arc cascade changes only the eligible transform');
  await shot('qa-09-cascade-arc');
  await page.keyboard.press('Escape'); await paint(page);
  ok(JSON.stringify(await read(page, ids.move)) === JSON.stringify(cascadeBefore[1]), 'Escape restores the exact pre-cascade Arc');
  await openCascade();
  await page.select('.cascade-pop select.prop', 'stagger.totalMs'); await delta(50);
  t = await read(page, ids.wave);
  ok(t.stagger.totalMs === 50 && !Object.hasOwn(t.stagger, 'perMs') && JSON.stringify(await read(page, ids.move)) === JSON.stringify(cascadeBefore[1]), 'real Total cascade writes Total only and preserves the ineligible transform');
  await shot('qa-10-cascade-total');
  await page.keyboard.press('Escape'); await paint(page);
  ok(JSON.stringify(await read(page, ids.wave)) === JSON.stringify(cascadeBefore[0]), 'Escape restores the exact pre-cascade Each stagger');

}
