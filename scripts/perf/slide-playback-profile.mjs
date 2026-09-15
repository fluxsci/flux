// CPU-profile the editor's step preview during a dense transform playback
// (the verify-scale-slide-dense scenario) and aggregate self time by function.
// Run: FLUX_CHROME=… node scripts/perf/slide-playback-profile.mjs [dense|normal|densemove]
import { launch, gotoApp, clickMode, APP_URL, waitFor, sleep } from "../lib/driver.mjs";
const mode = process.argv[2] ?? "dense"; // dense | normal | densemove (a heavy plot that only MOVES)
const dense = mode !== "normal";
const fixture = { slides: 3, points: dense ? 1200 : 60, tracks: dense ? 120 : 2, move: mode === "densemove" };
const { browser, page } = await launch();
try {
  await gotoApp(page, { url: APP_URL + "?fixture=demo", settle: 1200 });
  await clickMode(page, "Slide", { settle: 1500 });
  await waitFor(page, () => !!window.__flux?.get(window.__flux.slide.deckOverlay), null, { timeout: 15000, label: "deck loaded" });
  await page.evaluate((fixture) => {
    const f = window.__flux;
    const pts = Array.from({ length: fixture.points }, (_, i) => `<circle id="s.point.${i}" cx="${5 + i * 90 / fixture.points}" cy="${40 + 30 * Math.sin(i / 5)}" r="1.5"/>`).join("");
    const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 80" width="100" height="80"><g id="axis.x"><path id="axis.x.spine" d="M5 75 H 95" stroke="#888" fill="none"/></g><g id="series.s">${pts}</g></svg>`;
    const manifest = { spec:"fluxplot",schemaVersion:"0.2.0",plotType:"scatter",svg:"",size:{width:100,height:80,unit:"px"},axes:[{x:{scale:"linear",domain:[0,100],anchors:[{data:0,svg:0},{data:100,svg:100}]},y:{scale:"linear",domain:[0,80],anchors:[{data:0,svg:80},{data:80,svg:0}]}}],series:[{id:"s",points:Array.from({length:fixture.points},(_,i)=>({index:i,svgId:`s.point.${i}`,x:5+i*90/fixture.points,y:40-30*Math.sin(i/5)}))}]};
    f.plot.cachePlot("scale-plot", SVG, manifest);
    const target=structuredClone(manifest);target.series[0].points.forEach((p,i)=>p.y=40-25*Math.cos(i/9));
    const doc=new DOMParser().parseFromString(SVG,"image/svg+xml");
    target.series[0].points.forEach(p=>doc.getElementById(p.svgId).setAttribute("cy",String(80-p.y)));
    f.plot.cachePlot("scale-target",new XMLSerializer().serializeToString(doc.documentElement),target);
    f.slide.commitDeckLive((d) => {
      for (let i = 0; i < fixture.slides; i++) {
        const s = f.slideOps.addSlide(d, { name: `S${i}`, layout: "blank" });
        f.slideOps.addSlideText(d, s.id, { text: `Slide ${i}\nwith a plot`, x: 30, y: 24, fontSize: 20 });
        f.slideOps.addPlotToSlide(d, s.id, { assetId: "scale-plot", x: 60, y: 90, width: 400, height: 220 });
        s.elements.push({ type: "rect", id: `r-${i}`, x: 500, y: 40, width: 90, height: 50, rotation: 0, fill: "#4385be", stroke: "none", strokeWidth: 0, cornerRadius: 4 });
      }
    });
  }, fixture);
  await sleep(800);
  await page.evaluate(() => { const f = window.__flux; const ids = f.get(f.slide.deckOverlay).slides.map((s) => s.id); f.slide.selectSlide(ids[1]); });
  await page.evaluate(() => [...document.querySelectorAll(".deckbar button")].find((b) => /Animate/.test(b.textContent || ""))?.click());
  await waitFor(page, () => !!document.querySelector(".animator"), null, { timeout: 6000, label: "animator open" });
  await page.evaluate((fixture) => {
    const f = window.__flux, sid = f.get(f.fig.activeFigureId);
    f.fig.commit((p) => { const fig = p.figures.find((x) => x.id === sid); for (let i = 0; i < 3; i++) fig.elements.push({ type: "rect", id: `tp-r${i}`, x: 20 + i * 60, y: 250, width: 40, height: 30, rotation: 0, fill: "#4385be", stroke: "#222", strokeWidth: 1.5, cornerRadius: 0 }); });
    f.slide.commitDeckLive((d) => {
      const s = f.slideOps.slideById(d, sid);
      if (s.beats.length <= 1) f.slideOps.addBeat(d, sid, { label: "B1" });
      const beatId = s.beats[1].id;
      const el = s.elements.find((e) => e.type === "rect");
      f.slideOps.setAnimation(d, sid, beatId, { target: el.id, preset: "fade", duration: 300 });
      f.slideOps.setTransform(d, sid, beatId, el.id, { state: { x: 200 } });
      const plot = s.elements.find((e) => e.type === "plot");
      for (let i = 2; i < fixture.tracks; i++) s.beats[1].tracks.push({ id: `dense-${i}`, target: plot.id, part: `s.point.${i}`, preset: "fade", duration: 400, start: i * 2 });
      for (let i = 0; i < 3; i++) f.slideOps.setTransform(d, sid, beatId, `tp-r${i}`, { state: { x: 320 + i * 70, width: 90, fill: "#d14d41", rotation: 20 }, duration: 1800 });
      if (fixture.move) f.slideOps.setTransform(d, sid, beatId, plot.id, { state: { x: plot.x + 120, y: plot.y - 30 }, duration: 1800 });
      else f.slideOps.setTransform(d, sid, beatId, plot.id, { state: { width: plot.width * 1.3, contentScale: 1.1 }, ...(fixture.points > 60 ? { toAssetId: "scale-target" } : {}), duration: 1800 });
    });
    f.slide.activeBeat.set(1);
  }, fixture);
  await sleep(300);
  const client = await page.createCDPSession();
  await client.send("Profiler.enable");
  await client.send("Profiler.setSamplingInterval", { interval: 200 });
  await client.send("Profiler.start");
  const frames = await page.evaluate(async () => {
    document.querySelector(".animator .bar .play").click();
    const deltas = [];
    await new Promise((resolve, reject) => {
      let last = 0, n = 0, waits = 0;
      const tick = (ts) => {
        const moving = document.querySelector('.preview-host [data-el-id="tp-r0"]');
        if (!moving) { if (++waits > 180) return reject(new Error("no preview")); requestAnimationFrame(tick); return; }
        if (last) deltas.push(ts - last); last = ts;
        if (++n < 90) requestAnimationFrame(tick); else resolve();
      };
      requestAnimationFrame(tick);
    });
    document.querySelector(".preview-stop")?.click();
    return deltas;
  });
  const { profile } = await client.send("Profiler.stop");
  const p95 = (xs) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * 0.95))];
  console.log(`frames: ${frames.length}, p50 ${[...frames].sort((a, b) => a - b)[Math.floor(frames.length / 2)].toFixed(1)}ms, p95 ${p95(frames).toFixed(1)}ms, max ${Math.max(...frames).toFixed(1)}ms, long frames at ${frames.map((f, i) => f > 20 ? `#${i}:${f.toFixed(0)}` : null).filter(Boolean).join(" ") || "none"}`);
  // aggregate self time
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const self = new Map();
  const total = profile.timeDeltas.reduce((a, b) => a + b, 0);
  for (let i = 0; i < profile.samples.length; i++) {
    const node = byId.get(profile.samples[i]); const dt = profile.timeDeltas[i] ?? 0;
    const cf = node.callFrame; const key = `${cf.functionName || "(anon)"} ${cf.url.split("/").slice(-2).join("/")}:${cf.lineNumber}`;
    self.set(key, (self.get(key) ?? 0) + dt);
  }
  // inclusive time per function (walk parents)
  const parent = new Map(); for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const incl = new Map();
  for (let i = 0; i < profile.samples.length; i++) {
    const dt = profile.timeDeltas[i] ?? 0; const seen = new Set(); let id = profile.samples[i];
    while (id != null) { const n = byId.get(id); const cf = n.callFrame; const key = `${cf.functionName || "(anon)"} ${cf.url.split("/").slice(-2).join("/")}:${cf.lineNumber}`; if (!seen.has(key)) { seen.add(key); incl.set(key, (incl.get(key) ?? 0) + dt); } id = parent.get(id); }
  }
  const fmt = (m, n) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `  ${(v / 1000).toFixed(1).padStart(7)}ms ${(100 * v / total).toFixed(1).padStart(5)}%  ${k}`).join("\n");
  console.log(`total sampled ${(total / 1000).toFixed(0)}ms\n--- self time ---\n${fmt(self, 28)}\n--- inclusive ---\n${fmt(incl, 30)}`);
} finally { await browser.close(); }
