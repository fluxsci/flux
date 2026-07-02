#!/usr/bin/env node
// WS6 LIVE acceptance — drive the REAL animator GUI in headless Chrome against
// the dev server's ?fixture=demo harness, with the REAL regenerated fluxv1
// plots injected into the plot cache. Exercises the new direct-manipulation
// surface end to end:
//   Gantt geometry ∝ start/duration · chip drag retime (one undo step, snapped)
//   edge drag = duration · cross-column drag = move-to-beat · marquee select
//   beat header drag = reorder (beat 0 pinned) · insert-between · advance cycle
//   whole-slide parts tree (elements + parts + blocks) · ⊕in/⊖out quick actions
//   S/A/M paint sweep = one undo step · Alt+P slide X-ray styling via overrides
//   zoom-out below fit · animator dock beyond the old 640px cap
// Prereq: `npm run dev` serving 127.0.0.1:1420. Run: node scripts/verify-slide-animator-live.mjs
import puppeteer from "puppeteer-core";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as url from "node:url";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const SHOTS = path.join(here, "..", "test-results");
await fs.mkdir(SHOTS, { recursive: true });

let passed = 0;
function ok(cond, msg) {
  if (!cond) throw new Error("FAIL: " + msg);
  passed++;
  console.log("  ok:", msg);
}

const PLOTS_DIR = "/home/driessen2/fluxv1/plots/example_plots";
const readPlot = async (name) => ({
  id: `example_plots/${name}`,
  svg: await fs.readFile(path.join(PLOTS_DIR, `${name}.svg`), "utf8"),
  manifest: JSON.parse(await fs.readFile(path.join(PLOTS_DIR, `${name}.fluxplot.json`), "utf8")),
});
const scatter = await readPlot("06_scatter_regression");
const ecdf = await readPlot("08_ecdf");

const browser = await puppeteer.launch({
  executablePath: "/usr/bin/google-chrome",
  headless: "new",
  args: ["--no-sandbox", "--window-size=1720,1080"],
  defaultViewport: { width: 1720, height: 1080 },
});
try {
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.log("  [pageerror]", String(e).slice(0, 200)));
  await page.goto("http://127.0.0.1:1420/?fixture=demo", { waitUntil: "networkidle2", timeout: 30000 });
  await page.waitForFunction(() => !!window.__flux?.slideOps, { timeout: 15000 });

  // enter slide mode via the activity rail
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll("button, [role=button]"));
    const b = btns.find((x) => /slide/i.test(x.getAttribute("title") ?? "") || /slide/i.test(x.getAttribute("aria-label") ?? ""));
    if (b) b.click();
  });
  await new Promise((r) => setTimeout(r, 800));

  // seed the REAL plots + author a deck through the live ops
  await page.evaluate(({ scatter, ecdf }) => {
    const F = window.__flux;
    F.plot.cachePlot(scatter.id, scatter.svg, scatter.manifest);
    F.plot.cachePlot(ecdf.id, ecdf.svg, ecdf.manifest);
    const ops = F.slideOps;
    const deck = ops.createDeck({ id: "ws6", title: "WS6 acceptance" });
    const s1 = ops.addSlide(deck, { name: "Anim" }).id;
    ops.addPlotToSlide(deck, s1, { assetId: scatter.id, x: 60, y: 60, width: 720, height: 480 });
    const txt = ops.addTextBox(deck, s1, { text: "Point one", x: 820, y: 80, width: 380, height: 220, fontSize: 30 });
    const el = ops.findElement(deck, txt).el;
    el.blocks = [
      { id: "b1", text: "Point one", marker: "bullet" },
      { id: "b2", text: "Point two", marker: "bullet" },
      { id: "b3", text: "Point three", marker: "bullet" },
    ];
    ops.addRect(deck, s1, { x: 840, y: 340, width: 160, height: 90 });
    ops.addLine(deck, s1, { x: 840, y: 470, width: 240 });
    const b1 = ops.addBeat(deck, s1, { label: "one" });
    const b2 = ops.addBeat(deck, s1, { label: "two" });
    ops.setAnimation(deck, s1, b1.id, { id: "tA", target: txt, selector: { blocks: "all" }, preset: "fadeRise", start: 0, duration: 200, stagger: { perMs: 100, by: "blocks" } });
    ops.setAnimation(deck, s1, b1.id, { id: "tB", target: "@camera", preset: "camera", to: { zoom: 1.4, x: 400, y: 300 }, start: 200, duration: 400 });
    ops.setAnimation(deck, s1, b2.id, { id: "tC", target: txt, preset: "fadeOut", start: 0, duration: 300 });
    F.slide.loadDeckModel(deck);
    F.slide.activeSlideId.set(s1);
    window.__ws6 = { s1, txt };
  }, { scatter, ecdf });
  await new Promise((r) => setTimeout(r, 900));
  await page.screenshot({ path: path.join(SHOTS, "ws6-01-animator.png") });

  const S = (sel) => page.$(sel);
  ok(await S(".animator"), "animator dock rendered");
  ok(await S(".parts .row"), "parts tree rendered");

  // --- whole-slide tree: element rows for plot + text + rect + line ------------
  const treeInfo = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll(".parts .row"));
    return {
      n: rows.length,
      labels: rows.filter((r) => r.classList.contains("elrow")).map((r) => r.textContent?.trim().slice(0, 30)),
    };
  });
  ok(treeInfo.labels.length === 4, `4 element rows in the tree (${treeInfo.labels.join(" | ")})`);
  ok(treeInfo.labels.some((l) => /plot · line|plot/.test(l ?? "")), "plot element row present");
  ok(treeInfo.labels.some((l) => /Point one/.test(l ?? "")), "text box row labeled by its first line");

  // text box block sub-rows (expanded by default)
  const blockRows = await page.evaluate(() => document.querySelectorAll('.parts .row[data-rowkey*="#"]').length);
  ok(blockRows === 3, "text box shows its 3 block rows");

  // --- Gantt geometry ∝ time -----------------------------------------------------
  const geom = await page.evaluate(() => {
    const chips = Array.from(document.querySelectorAll("[data-track-id]")).map((el) => ({
      id: el.dataset.trackId, left: el.offsetLeft, width: el.offsetWidth,
    }));
    return chips;
  });
  const cA = geom.find((c) => c.id === "tA"), cB = geom.find((c) => c.id === "tB"), cC = geom.find((c) => c.id === "tC");
  ok(cA && cB && cC, "all three chips rendered");
  ok(cB.left > cA.left + 10, "a t=200ms chip sits right of a t=0 chip (x ∝ start)");
  const ratio = cB.width / Math.max(1, cA.width);
  ok(ratio > 1.6 && ratio < 2.6, `400ms chip ≈ 2× the 200ms chip (${ratio.toFixed(2)}×)`);
  const tail = await page.evaluate(() => !!document.querySelector('[data-track-id="tA"] .tail'));
  ok(tail, "stagger fan-out tail rendered on the staggered chip");

  // --- chip drag = retime start, ONE undo step, deckEditGen clean mid-drag -------
  const box = await (await S('[data-track-id="tA"]')).boundingBox();
  const gen0 = await page.evaluate(() => window.__flux.slide.deckEditGen.n);
  await page.mouse.move(box.x + 6, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 46, box.y + box.height / 2, { steps: 6 });
  const genMid = await page.evaluate(() => window.__flux.slide.deckEditGen.n);
  await page.mouse.move(box.x + 66, box.y + box.height / 2, { steps: 4 });
  await page.mouse.up();
  await new Promise((r) => setTimeout(r, 250));
  const afterDrag = await page.evaluate(() => {
    const F = window.__flux;
    const d = F.get(F.slide.deck);
    const t = d.slides.find((s) => s.id === window.__ws6.s1).beats.flatMap((b) => b.tracks).find((x) => x.id === "tA");
    return { start: t.start, gen: F.slide.deckEditGen.n };
  });
  ok(genMid === gen0, "deckEditGen unchanged MID-drag (preview is transient)");
  ok(afterDrag.gen === gen0 + 1, "exactly one commit on release");
  ok(afterDrag.start > 0 && afterDrag.start % 10 === 0, `start retimed + snapped (${afterDrag.start}ms)`);

  // --- edge drag = duration --------------------------------------------------------
  const boxB = await (await S('[data-track-id="tB"]')).boundingBox();
  await page.mouse.move(boxB.x + boxB.width - 2, boxB.y + boxB.height / 2);
  await page.mouse.down();
  await page.mouse.move(boxB.x + boxB.width + 60, boxB.y + boxB.height / 2, { steps: 6 });
  await page.mouse.up();
  await new Promise((r) => setTimeout(r, 250));
  const durB = await page.evaluate(() => {
    const F = window.__flux;
    return F.get(F.slide.deck).slides.find((s) => s.id === window.__ws6.s1).beats.flatMap((b) => b.tracks).find((x) => x.id === "tB").duration;
  });
  ok(durB > 400 && durB % 10 === 0, `right-edge drag grew the duration (${durB}ms, snapped)`);

  // --- cross-column drag = move to another beat -------------------------------------
  const boxA2 = await (await S('[data-track-id="tA"]')).boundingBox();
  const col2 = await page.evaluate(() => {
    const el = document.querySelector('[data-beat-index="2"]');
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.move(boxA2.x + 8, boxA2.y + 6);
  await page.mouse.down();
  await page.mouse.move(col2.x, col2.y, { steps: 10 });
  await page.mouse.up();
  await new Promise((r) => setTimeout(r, 250));
  const moved = await page.evaluate(() => {
    const F = window.__flux;
    const d = F.get(F.slide.deck);
    return d.slides.find((s) => s.id === window.__ws6.s1).beats.map((b) => b.tracks.map((t) => t.id).join(","));
  });
  ok(moved[2].includes("tA"), `chip dragged across columns landed on beat 2 (beats: ${moved.join(" | ")})`);

  // --- marquee select over beat 2's chips -------------------------------------------
  const lanes2 = await page.evaluate(() => {
    const el = document.querySelector('[data-beat-index="2"] .lanes');
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  await page.mouse.move(lanes2.x + lanes2.w - 4, lanes2.y + lanes2.h - 2);
  await page.mouse.down();
  await page.mouse.move(lanes2.x + 2, lanes2.y + 2, { steps: 6 });
  await page.mouse.up();
  const marqueeSel = await page.evaluate(() => window.__flux.get(window.__flux.slide.selTrackIds));
  ok(marqueeSel.includes("tA") && marqueeSel.includes("tC") && marqueeSel.length >= 2, `marquee selected beat 2's chips (${marqueeSel.join(",")})`);

  // --- insert-between + advance cycle ------------------------------------------------
  const beatsBefore = await page.evaluate(() => window.__flux.get(window.__flux.slide.deck).slides.find((s) => s.id === window.__ws6.s1).beats.length);
  await page.evaluate(() => {
    document.querySelectorAll(".timeline .between")[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await new Promise((r) => setTimeout(r, 200));
  const beatsAfter = await page.evaluate(() => window.__flux.get(window.__flux.slide.deck).slides.find((s) => s.id === window.__ws6.s1).beats.length);
  ok(beatsAfter === beatsBefore + 1, "insert-between added a beat at the hovered gap");
  await page.evaluate(() => document.querySelector('[data-beat-index="1"] .adv')?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  await new Promise((r) => setTimeout(r, 150));
  const adv = await page.evaluate(() => window.__flux.get(window.__flux.slide.deck).slides.find((s) => s.id === window.__ws6.s1).beats[1].advance);
  ok(adv === "with-prev", "advance-mode button cycled click → with-prev");

  // --- beat header drag = reorder (beat 0 pinned) -------------------------------------
  const order0 = await page.evaluate(() => window.__flux.get(window.__flux.slide.deck).slides.find((s) => s.id === window.__ws6.s1).beats.map((b) => b.label ?? "·").join(","));
  const head3 = await page.evaluate(() => {
    const el = document.querySelector('[data-beat-index="3"] .head');
    const r = el.getBoundingClientRect();
    return { x: r.x + 20, y: r.y + r.height / 2 };
  });
  const head1 = await page.evaluate(() => {
    const el = document.querySelector('[data-beat-index="1"] .head');
    const r = el.getBoundingClientRect();
    return { x: r.x + 20, y: r.y + r.height / 2 };
  });
  await page.mouse.move(head3.x, head3.y);
  await page.mouse.down();
  await page.mouse.move(head1.x, head1.y, { steps: 8 });
  await page.mouse.up();
  await new Promise((r) => setTimeout(r, 250));
  const order1 = await page.evaluate(() => window.__flux.get(window.__flux.slide.deck).slides.find((s) => s.id === window.__ws6.s1).beats.map((b) => b.label ?? "·").join(","));
  ok(order0 !== order1 && order1.split(",")[0] === order0.split(",")[0], `beat header drag reordered (${order0} → ${order1}), beat 0 pinned`);

  // --- ⊕ in quick action on the rect element row ---------------------------------------
  const rectKey = await page.evaluate(() => {
    const F = window.__flux;
    return F.get(F.slide.deck).slides.find((s) => s.id === window.__ws6.s1).elements.find((e) => e.type === "rect").id;
  });
  await page.hover(`.parts .row[data-rowkey="${rectKey}"]`);
  await page.click(`.parts .row[data-rowkey="${rectKey}"] .qa button`);
  await new Promise((r) => setTimeout(r, 200));
  const rectTrack = await page.evaluate((k) => {
    const F = window.__flux;
    return F.get(F.slide.deck).slides.find((s) => s.id === window.__ws6.s1).beats.flatMap((b) => b.tracks).find((t) => t.target === k);
  }, rectKey);
  ok(rectTrack && rectTrack.preset === "popIn", `⊕ in gave the rect its per-kind enter (${rectTrack?.preset})`);

  // --- S/A/M paint sweep across plot parts = ONE undo step ------------------------------
  await page.evaluate(() => {
    // ensure the plot element row is expanded so part rows are visible
    const F = window.__flux;
    const plot = F.get(F.slide.deck).slides.find((s) => s.id === window.__ws6.s1).elements.find((e) => e.type === "plot");
    const tw = document.querySelector(`.parts .row[data-rowkey="${plot.id}"] .tw`);
    if (tw?.textContent?.includes("▸")) tw.click();
    window.__ws6.plotId = plot.id;
  });
  await new Promise((r) => setTimeout(r, 300));
  const partRows = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('.parts .row[data-rowkey*="|"]')).slice(0, 4);
    rows[0]?.scrollIntoView({ block: "start" }); // an earlier hover may have scrolled the tree
    return rows.map((r) => {
      const b = r.querySelectorAll(".tri button")[2]; // M
      const rr = b?.getBoundingClientRect();
      return rr ? { key: r.dataset.rowkey, x: rr.x + rr.width / 2, y: rr.y + rr.height / 2 } : null;
    }).filter(Boolean);
  });
  ok(partRows.length >= 3, `part rows visible for painting (${partRows.length})`);
  const undoable0 = await page.evaluate(() => window.__flux.get(window.__flux.slide.deck).slides.find((s) => s.id === window.__ws6.s1).elements.find((e) => e.type === "plot").overrides ?? {});
  await page.mouse.move(partRows[0].x, partRows[0].y);
  await page.mouse.down();
  for (const pr of partRows.slice(1)) await page.mouse.move(pr.x, pr.y, { steps: 3 });
  await page.mouse.up();
  await new Promise((r) => setTimeout(r, 250));
  const painted = await page.evaluate(() => Object.keys(window.__flux.get(window.__flux.slide.deck).slides.find((s) => s.id === window.__ws6.s1).elements.find((e) => e.type === "plot").overrides ?? {}));
  ok(painted.length >= 3, `paint sweep masked ${painted.length} parts in one gesture`);
  await page.evaluate(() => window.__flux.slide.undoDeck());
  await new Promise((r) => setTimeout(r, 200));
  const afterUndo = await page.evaluate(() => Object.keys(window.__flux.get(window.__flux.slide.deck).slides.find((s) => s.id === window.__ws6.s1).elements.find((e) => e.type === "plot").overrides ?? {}));
  ok(afterUndo.length === Object.keys(undoable0).length, "ONE undo reverts the whole paint sweep");

  // --- Alt+P slide X-ray: style a part, see it in overrides + the live SVG ---------------
  await page.evaluate(() => {
    const F = window.__flux;
    F.slide.selection.set([window.__ws6.plotId]);
  });
  await page.click(".stage-viewport", { offset: { x: 20, y: 20 } }).catch(() => {});
  await page.keyboard.down("Alt");
  await page.keyboard.press("KeyP");
  await page.keyboard.up("Alt");
  await new Promise((r) => setTimeout(r, 400));
  ok(await S(".panel .tree"), "Alt+P opened the slide X-ray");
  await page.screenshot({ path: path.join(SHOTS, "ws6-02-xray.png") });
  // pick the fit.line row, then a red swatch
  const styled = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll(".panel .tree .row"));
    const fit = rows.find((r) => /fit|line/i.test(r.textContent ?? "")) ?? rows[3];
    fit?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    return fit?.textContent?.trim();
  });
  await new Promise((r) => setTimeout(r, 200));
  await page.evaluate(() => {
    const sw = Array.from(document.querySelectorAll(".panel .sw")).find((b) => b.title === "#d14d41");
    sw?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await new Promise((r) => setTimeout(r, 300));
  const xrayResult = await page.evaluate(() => {
    const F = window.__flux;
    const plot = F.get(F.slide.deck).slides.find((s) => s.id === window.__ws6.s1).elements.find((e) => e.type === "plot");
    const ov = plot.overrides ?? {};
    const styledKey = Object.keys(ov).find((k) => ov[k].stroke === "#d14d41" || ov[k].fill === "#d14d41");
    let domHit = false;
    if (styledKey) {
      const node = document.querySelector(`.stage-viewport [id="${plot.id}__${styledKey}"]`) ??
        document.querySelector(`[id="${plot.id}__${styledKey}"]`);
      const st = node?.style;
      domHit = !!st && (st.stroke === "rgb(209, 77, 65)" || st.stroke === "#d14d41" || st.fill === "rgb(209, 77, 65)" || st.fill === "#d14d41");
    }
    return { styledKey, domHit };
  });
  ok(!!xrayResult.styledKey, `swatch click landed in overrides (${styled} → ${xrayResult.styledKey})`);
  ok(xrayResult.domHit, "…and the LIVE stage SVG node carries the style");
  await page.keyboard.press("Escape");

  // --- zoom OUT below fit + dock beyond the old 640px cap ---------------------------------
  const zoomOut = await page.evaluate(async () => {
    const minus = Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.trim() === "−" || b.textContent?.trim() === "-");
    for (let i = 0; i < 6; i++) minus?.click();
    await new Promise((r) => setTimeout(r, 200));
    const chip = Array.from(document.querySelectorAll("button, span")).map((x) => x.textContent?.trim() ?? "").find((t) => /^\d+%$/.test(t));
    return chip ?? "";
  });
  ok(parseInt(zoomOut) < 100 && parseInt(zoomOut) >= 25, `zoom-out below fit works (${zoomOut})`);

  const gutter = await (await S(".dock-gutter")).boundingBox();
  await page.mouse.move(gutter.x + gutter.width / 2, gutter.y + 3);
  await page.mouse.down();
  await page.mouse.move(gutter.x + gutter.width / 2, 140, { steps: 8 });
  await page.mouse.up();
  await new Promise((r) => setTimeout(r, 200));
  const dockH = await page.evaluate(() => document.querySelector(".animator").getBoundingClientRect().height);
  ok(dockH > 640, `animator dock resizes past the old 640px cap (${Math.round(dockH)}px)`);
  await page.screenshot({ path: path.join(SHOTS, "ws6-03-bigdock.png") });

  console.log(`\nSLIDE ANIMATOR LIVE (WS6) — ${passed} checks PASSED`);
} finally {
  await browser.close();
}
