// slide-migration §7.3 — the slide-mode responsiveness budgets (Nielsen §6),
// at fixture scale: a 30-slide deck with a plot-bearing slide layout.
//   • slide-switch (activeFigureId swap) p95 ≤ 100ms — the instantaneous class
//     (dev-mode numbers are the worst case; the swap must stay an in-memory
//     store write, never a reload)
//   • static editing commit on a slide stays instantaneous at fixture scale
//   • NO continuous main-thread rAF loop during static editing (E43)
//   • thumbnail invalidation is bounded: ONE edit re-renders ONE thumbnail
// Writes test-results/scale-slide.json. Run: node scripts/verify-scale-slide.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { launch, gotoApp, clickMode, sleep, realErrors, APP_URL, waitFor } from "./lib/driver.mjs";

let fails = 0;
const ok = (c, msg, extra = "") => (c ? console.log("  ✓ " + msg) : (fails++, console.log("  ✗ " + msg + (extra ? ` — ${extra}` : ""))));
const p95 = (xs) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * 0.95))];

const { browser, page } = await launch();
try {
  await gotoApp(page, { url: APP_URL + "?fixture=demo", settle: 1800 });
  ok(await clickMode(page, "Slide", { settle: 2600 }), "entered Slide mode");
  await waitFor(page, () => !!window.__flux?.get(window.__flux.slide.deckOverlay), null, { timeout: 15000, label: "deck loaded" });

  // --- fixture: 30 slides, each with a semantic plot + text + shapes -------------
  await page.evaluate(() => {
    const f = window.__flux;
    // one cached semantic plot shared by every slide (parts addressable)
    const pts = Array.from({ length: 60 }, (_, i) => `<circle id="s.point.${i}" cx="${5 + i * 1.5}" cy="${40 + 30 * Math.sin(i / 5)}" r="1.5"/>`).join("");
    const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 80" width="100" height="80">
      <g id="axis.x"><path id="axis.x.spine" d="M5 75 H 95" stroke="#888" fill="none"/></g>
      <g id="series.s">${pts}</g></svg>`;
    f.plot.cachePlot("scale-plot", SVG);
    f.slide.commitDeckLive((d) => {
      for (let i = 0; i < 30; i++) {
        const s = f.slideOps.addSlide(d, { name: `S${i}`, layout: "blank" });
        f.slideOps.addSlideText(d, s.id, { text: `Slide ${i}\nwith a plot`, x: 30, y: 24, fontSize: 20 });
        f.slideOps.addPlotToSlide(d, s.id, { assetId: "scale-plot", x: 60, y: 90, width: 400, height: 220 });
        s.elements.push({ type: "rect", id: `r-${i}`, x: 500, y: 40, width: 90, height: 50, rotation: 0, fill: "#4385be", stroke: "none", strokeWidth: 0, cornerRadius: 4 });
      }
    });
  });
  await sleep(1200); // let thumbnails settle
  const n = await page.evaluate(() => window.__flux.get(window.__flux.slide.deckOverlay).slides.length);
  ok(n >= 30, `fixture deck built (${n} slides, plot-bearing)`);

  // --- slide-switch p95 -----------------------------------------------------------
  const switches = await page.evaluate(async () => {
    const f = window.__flux;
    const ids = f.get(f.slide.deckOverlay).slides.map((s) => s.id);
    const paint = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const times = [];
    for (let i = 0; i < 40; i++) {
      const id = ids[(i * 7) % ids.length];
      const t0 = performance.now();
      f.slide.selectSlide(id);
      await paint();
      times.push(performance.now() - t0);
      await new Promise((r) => setTimeout(r, 30));
    }
    return times;
  });
  const swP95 = p95(switches);
  ok(swP95 <= 100, `slide-switch p95 ${swP95.toFixed(1)}ms ≤ 100ms over ${switches.length} switches (instantaneous class)`);

  // --- static edit commit latency on a plot-bearing slide ---------------------------
  const edits = await page.evaluate(async () => {
    const f = window.__flux;
    const sid = f.get(f.fig.activeFigureId);
    const paint = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const times = [];
    for (let i = 0; i < 30; i++) {
      const t0 = performance.now();
      f.fig.commit((p) => {
        const fig = p.figures.find((x) => x.id === sid);
        const r = fig.elements.find((e) => e.type === "rect");
        r.x = 500 + (i % 10);
      });
      await paint();
      times.push(performance.now() - t0);
    }
    return times;
  });
  const editP95 = p95(edits);
  ok(editP95 <= 100, `static-edit commit p95 ${editP95.toFixed(1)}ms ≤ 100ms (same budget as figure editing)`);

  // --- rAF quiescence during static editing (E43) ------------------------------------
  const raf = await page.evaluate(async () => {
    let count = 0;
    const orig = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (cb) => {
      count++;
      return orig(cb);
    };
    await new Promise((r) => setTimeout(r, 800));
    window.requestAnimationFrame = orig;
    return count;
  });
  ok(raf <= 6, `no continuous rAF loop at static rest (${raf} calls in 800ms — E43)`);

  // --- ANIMATOR-OPEN budgets (animation rework §12/§16) --------------------------------
  // With the dock open on the fixture deck: track ops stay in the
  // instantaneous class, and the pane adds ZERO ambient rAF at rest.
  await page.evaluate(() => {
    [...document.querySelectorAll(".deckbar button")].find((b) => /Animate/.test(b.textContent || ""))?.click();
  });
  await waitFor(page, () => !!document.querySelector(".animator"), null, { timeout: 6000, label: "animator open" });
  const animEdits = await page.evaluate(async () => {
    const f = window.__flux;
    const sid = f.get(f.fig.activeFigureId);
    // an appearance + a transform to exercise both lane kinds
    f.slide.commitDeckLive((d) => {
      const s = f.slideOps.slideById(d, sid);
      if (s.beats.length <= 1) f.slideOps.addBeat(d, sid, { label: "B1" });
      const el = s.elements.find((e) => e.type === "rect") ?? s.elements[0];
      f.slideOps.setAnimation(d, sid, s.beats[1].id, { target: el.id, preset: "fade", duration: 300 });
      f.slideOps.setTransform(d, sid, s.beats[1].id, el.id, { state: { x: 200 } });
    });
    f.slide.activeBeat.set(1);
    await new Promise((r) => setTimeout(r, 120));
    const times = [];
    const o = f.get(f.slide.deckOverlay);
    const s = o.slides.find((x) => x.id === sid);
    const tid = s.beats[1].tracks[0]?.id;
    for (let i = 0; i < 24; i++) {
      const t0 = performance.now();
      f.slide.selTrackIds.set(i % 2 ? [tid] : []);
      f.slide.commitDeckLive((d) => {
        const b = f.slideOps.slideById(d, sid).beats[1];
        const t = b.tracks.find((x) => x.id === tid);
        if (t) t.start = (t.start ?? 0) + (i % 2 ? 10 : -10);
      }, { coalesce: "scale-probe" });
      await new Promise((r) => requestAnimationFrame(() => r()));
      times.push(performance.now() - t0);
    }
    f.slide.sealHistory();
    return times;
  });
  const animP95 = p95(animEdits);
  ok(animP95 <= 100, `animator-open track edit p95 ${animP95.toFixed(1)}ms ≤ 100ms (select + retime + paint)`);
  const rafAnim = await page.evaluate(async () => {
    let count = 0;
    const orig = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (cb) => {
      count++;
      return orig(cb);
    };
    await new Promise((r) => setTimeout(r, 800));
    window.requestAnimationFrame = orig;
    return count;
  });
  ok(rafAnim <= 6, `zero ambient rAF at rest WITH the animator open (${rafAnim} calls in 800ms)`);
  await page.evaluate(() => {
    [...document.querySelectorAll(".deckbar button")].find((b) => /Animate/.test(b.textContent || ""))?.click();
  });
  await sleep(200);

  // --- bounded thumbnail invalidation --------------------------------------------------
  await sleep(800); // let any pending thumb debounce settle
  const thumbs = await page.evaluate(async () => {
    const read = () => [...document.querySelectorAll(".filmstrip .thumb .thumb-stage")].map((t) => Number(t.dataset.renders ?? 0));
    const before = read();
    const f = window.__flux;
    const sid = f.get(f.fig.activeFigureId);
    f.fig.commit((p) => {
      const fig = p.figures.find((x) => x.id === sid);
      fig.elements.find((e) => e.type === "rect").x += 3;
    });
    await new Promise((r) => setTimeout(r, 700)); // debounce + render
    const after = read();
    let rerenders = 0;
    for (let i = 0; i < after.length; i++) if (after[i] !== before[i]) rerenders++;
    return { rerenders, n: after.length };
  });
  ok(thumbs.rerenders === 1, `ONE edit re-rendered exactly 1 of ${thumbs.n} thumbnails (figureRev keying, no N-slide re-render)`);

  mkdirSync("test-results", { recursive: true });
  writeFileSync(
    "test-results/scale-slide.json",
    JSON.stringify(
      {
        slides: n,
        slideSwitchMs: { p95: swP95, samples: switches.map((x) => +x.toFixed(1)) },
        staticEditMs: { p95: editP95 },
        animatorEditMs: { p95: animP95 },
        rafIn800ms: raf,
        rafAnimatorOpenIn800ms: rafAnim,
        thumbRerendersPerEdit: thumbs.rerenders,
      },
      null,
      2,
    ),
  );
  console.log(`  … wrote test-results/scale-slide.json (switch p95 ${swP95.toFixed(1)}ms, edit p95 ${editP95.toFixed(1)}ms)`);

  const errs = realErrors(page);
  ok(errs.length === 0, "console is clean", errs.slice(0, 3).join(" | "));
} finally {
  await browser.close();
}
console.log(fails ? `\nSCALE SLIDE: FAIL (${fails})` : "\nSCALE SLIDE: PASS");
process.exit(fails ? 1 : 0);
