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
const dense = process.env.FLUX_SLIDE_DENSE === "1";
const fixture = { slides: dense ? 12 : 30, points: dense ? 1200 : 60, tracks: dense ? 120 : 2 };
const p95 = (xs) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * 0.95))];

const { browser, page } = await launch();
try {
  await gotoApp(page, { url: APP_URL + "?fixture=demo", settle: 1800 });
  ok(await clickMode(page, "Slide", { settle: 2600 }), "entered Slide mode");
  await waitFor(page, () => !!window.__flux?.get(window.__flux.slide.deckOverlay), null, { timeout: 15000, label: "deck loaded" });

  // --- fixture: 30 slides, each with a semantic plot + text + shapes -------------
  await page.evaluate((fixture) => {
    const f = window.__flux;
    // one cached semantic plot shared by every slide (parts addressable)
    const pts = Array.from({ length: fixture.points }, (_, i) => `<circle id="s.point.${i}" cx="${5 + i * 90 / fixture.points}" cy="${40 + 30 * Math.sin(i / 5)}" r="1.5"/>`).join("");
    const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 80" width="100" height="80">
      <g id="axis.x"><path id="axis.x.spine" d="M5 75 H 95" stroke="#888" fill="none"/></g>
      <g id="series.s">${pts}</g></svg>`;
    const manifest = { spec:"fluxplot",schemaVersion:"0.2.0",plotType:"scatter",svg:"",size:{width:100,height:80,unit:"px"},axes:[{x:{scale:"linear",domain:[0,100],anchors:[{data:0,svg:0},{data:100,svg:100}]},y:{scale:"linear",domain:[0,80],anchors:[{data:0,svg:80},{data:80,svg:0}]}}],series:[{id:"s",points:Array.from({length:fixture.points},(_,i)=>({index:i,svgId:`s.point.${i}`,x:5+i*90/fixture.points,y:40-30*Math.sin(i/5)}))}]};
    f.plot.cachePlot("scale-plot", SVG, manifest);
    if(fixture.points>60){
      const target=structuredClone(manifest);target.series[0].points.forEach((p,i)=>p.y=40-25*Math.cos(i/9));
      const doc=new DOMParser().parseFromString(SVG,"image/svg+xml");
      target.series[0].points.forEach(p=>doc.getElementById(p.svgId).setAttribute("cy",String(80-p.y)));
      f.plot.cachePlot("scale-target",new XMLSerializer().serializeToString(doc.documentElement),target);
    }
    f.slide.commitDeckLive((d) => {
      for (let i = 0; i < fixture.slides; i++) {
        const s = f.slideOps.addSlide(d, { name: `S${i}`, layout: "blank" });
        f.slideOps.addSlideText(d, s.id, { text: `Slide ${i}\nwith a plot`, x: 30, y: 24, fontSize: 20 });
        f.slideOps.addPlotToSlide(d, s.id, { assetId: "scale-plot", x: 60, y: 90, width: 400, height: 220 });
        s.elements.push({ type: "rect", id: `r-${i}`, x: 500, y: 40, width: 90, height: 50, rotation: 0, fill: "#4385be", stroke: "none", strokeWidth: 0, cornerRadius: 4 });
      }
    });
  }, fixture);
  await sleep(1200); // let thumbnails settle
  const n = await page.evaluate(() => window.__flux.get(window.__flux.slide.deckOverlay).slides.length);
  ok(n === fixture.slides + 1, `fixture deck built (${n} slides, plot-bearing)`);

  // --- slide-switch p95 -----------------------------------------------------------
  const switches = await page.evaluate(async () => {
    const f = window.__flux;
    const ids = f.get(f.slide.deckOverlay).slides.slice(1).map((s) => s.id);
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
  const animEdits = await page.evaluate(async (fixture) => {
    const f = window.__flux;
    const sid = f.get(f.fig.activeFigureId);
    // an appearance + a transform to exercise both lane kinds
    f.slide.commitDeckLive((d) => {
      const s = f.slideOps.slideById(d, sid);
      if (s.beats.length <= 1) f.slideOps.addBeat(d, sid, { label: "B1" });
      const el = s.elements.find((e) => e.type === "rect") ?? s.elements[0];
      f.slideOps.setAnimation(d, sid, s.beats[1].id, { target: el.id, preset: "fade", duration: 300 });
      f.slideOps.setTransform(d, sid, s.beats[1].id, el.id, { state: { x: 200 } });
      const plot=s.elements.find(e=>e.type==="plot");
      for(let i=2;i<fixture.tracks;i++) s.beats[1].tracks.push({id:`dense-${i}`,target:plot.id,part:`s.point.${i}`,preset:"fade",duration:400,start:i*2});
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
  }, fixture);
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

  // --- TRANSFORM PLAYBACK frame budget (rework §16: 60fps => p95 ≤ 17ms) --------------
  // One beat, 4 concurrent transforms: 3 shapes + a plot frame resize.
  // The dense fixture also morphs 1,200 semantic points while 118 part
  // appearances run. Require visible motion; idle frame timing cannot pass.
  const profile = process.env.FLUX_SLIDE_PROFILE === "1";
  const idleFrames = profile ? await page.evaluate(async () => {
    const samples=[];let last=0;
    await new Promise(resolve=>{const tick=ts=>{if(last)samples.push(ts-last);last=ts;if(samples.length<120)requestAnimationFrame(tick);else resolve();};requestAnimationFrame(tick);});
    return samples;
  }) : [];
  if(profile)await page.tracing.start({path:`/tmp/flux-slide-${dense ? "dense" : "normal"}-trace.json`,categories:["devtools.timeline","disabled-by-default-v8.cpu_profiler","v8.execute","blink.user_timing"]});
  const playback = await page.evaluate(async (dense) => {
    const f = window.__flux;
    const sid = f.get(f.fig.activeFigureId);
    f.fig.commit((p) => {
      const fig = p.figures.find((x) => x.id === sid);
      for (let i = 0; i < 3; i++) {
        fig.elements.push({ type: "rect", id: `tp-r${i}`, x: 20 + i * 60, y: 250, width: 40, height: 30, rotation: 0, fill: "#4385be", stroke: "#222", strokeWidth: 1.5, cornerRadius: 0 });
      }
    });
    f.slide.commitDeckLive((d) => {
      const s = f.slideOps.slideById(d, sid);
      const beatId = s.beats[1].id;
      for (let i = 0; i < 3; i++) {
        f.slideOps.setTransform(d, sid, beatId, `tp-r${i}`, {
          state: { x: 320 + i * 70, width: 90, fill: "#d14d41", rotation: 20 }, duration: 1800,
        });
      }
      const plot = s.elements.find((e) => e.type === "plot");
      if (plot) f.slideOps.setTransform(d, sid, beatId, plot.id, { state: { width: plot.width * 1.3, contentScale: 1.1 }, ...(dense ? {toAssetId:"scale-target"}:{}), duration: 1800 });
    });
    // Require an actual playing preview and moving geometry. A missing UI
    // selector must fail, never turn this into a measurement of idle rAF.
    const button=document.querySelector(".animator .bar .play");
    if(!button)throw new Error("Play control missing");
    button.click();
    const deltas=[],positions=[];
    await new Promise((resolve,reject)=>{
      let last=0,n=0,waits=0;
      const tick=ts=>{
        const moving=document.querySelector('.preview-host [data-el-id="tp-r0"]');
        if(!moving){if(++waits>180)return reject(new Error("Preview never mounted"));requestAnimationFrame(tick);return;}
        if(last)deltas.push(ts-last);last=ts;
        positions.push(moving.getBoundingClientRect().left);
        if(++n<70)requestAnimationFrame(tick);else resolve();
      };
      requestAnimationFrame(tick);
    });
    const beforeScrub=JSON.stringify(f.slide.currentDeck());
    const scrubTimes=[],scrubPositions=[];
    for(let i=0;i<24;i++){
      const ruler=document.querySelector(".animator .ruler");
      if(!ruler)throw new Error("Timeline ruler missing");
      const rect=ruler.getBoundingClientRect();
      const t0=performance.now();
      ruler.dispatchEvent(new PointerEvent("pointerdown",{bubbles:true,button:0,clientX:rect.left+rect.width*(.1+(i*7%20)/25),clientY:rect.top+5}));
      window.dispatchEvent(new PointerEvent("pointerup",{bubbles:true,button:0}));
      await new Promise(r=>requestAnimationFrame(()=>r()));
      scrubTimes.push(performance.now()-t0);
      scrubPositions.push(document.querySelector('.preview-host [data-el-id="tp-r0"]').getBoundingClientRect().left);
    }
    const scrubKeptDocument=beforeScrub===JSON.stringify(f.slide.currentDeck());
    document.querySelector(".preview-stop")?.click();
    return {deltas,movingFrames:new Set(positions.map(x=>x.toFixed(2))).size,scrubTimes,scrubMovingFrames:new Set(scrubPositions.map(x=>x.toFixed(2))).size,scrubKeptDocument};
  }, dense);
  if(profile)await page.tracing.stop();
  const playFrames=playback.deltas;
  ok(playback.movingFrames>20, `real playback sampled ${playback.movingFrames} distinct moving frames`);
  await sleep(400);
  const playP95 = p95(playFrames);
  ok(playP95 <= 17, `transform playback p95 frame ${playP95.toFixed(1)}ms ≤ 17ms (3 shape transforms + 1 plot frame transform concurrent, ${playFrames.length} frames)`);
  const scrubP95=p95(playback.scrubTimes);
  ok(scrubP95<=100, `timeline scrubbing p95 ${scrubP95.toFixed(1)}ms ≤ 100ms`);
  ok(playback.scrubMovingFrames>10 && playback.scrubKeptDocument, "forward/reverse scrubbing changes the frame without changing the saved deck");
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
    dense ? "test-results/scale-slide-dense.json" : "test-results/scale-slide.json",
    JSON.stringify(
      {
        slides: n, fixture,
        environment: {browser:await browser.version(),headless:process.env.FLUX_HEADFUL!=="1",viewport:page.viewport()},
        ...(profile ? {idleFrameControl:{p95:p95(idleFrames),max:Math.max(...idleFrames),samples:idleFrames}} : {}),
        slideSwitchMs: { p95: swP95, max: Math.max(...switches), samples: switches.map((x) => +x.toFixed(1)) },
        staticEditMs: { p95: editP95, max: Math.max(...edits) },
        animatorEditMs: { p95: animP95, max: Math.max(...animEdits) },
        scrubMs: {p95:scrubP95,max:Math.max(...playback.scrubTimes),distinctFrames:playback.scrubMovingFrames},
        transformPlaybackFrameMs: { p95: playP95, max: Math.max(...playFrames), over25ms: playFrames.filter(x=>x>25).length, movingFrames: playback.movingFrames, samples: playFrames },
        rafIn800ms: raf,
        rafAnimatorOpenIn800ms: rafAnim,
        thumbRerendersPerEdit: thumbs.rerenders,
      },
      null,
      2,
    ),
  );
  console.log(`  … wrote test-results/scale-slide${dense ? "-dense" : ""}.json (switch p95 ${swP95.toFixed(1)}ms, edit p95 ${editP95.toFixed(1)}ms)`);

  const errs = realErrors(page);
  ok(errs.length === 0, "console is clean", errs.slice(0, 3).join(" | "));
} finally {
  await browser.close();
}
console.log(fails ? `\nSCALE SLIDE: FAIL (${fails})` : "\nSCALE SLIDE: PASS");
process.exit(fails ? 1 : 0);
