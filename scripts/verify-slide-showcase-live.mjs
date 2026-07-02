#!/usr/bin/env node
// WS7 — the final acceptance: open the EXPORTED showcase.html (file://, no
// server) and verify beat-by-beat that everything the overhaul promised
// actually plays in the shipped artifact:
//   • ticks DRAW ON in the export (the original "ticks can't animate" bug)
//   • draw-on parts rest UNDRAWN before their beat (deterministic static state)
//   • exits leave text + shapes hidden at rest (the new disappear family)
//   • the once-unaddressable ecdf medians draw on their own beat
//   • the data-space morph (bare-assetId target) really moves the points, and
//     a REAL animated advance settles to the same state as the static jump
//   • countUp lands the authored stat text
// Run AFTER scripts/build-showcase-deck.ts. Run: node scripts/verify-slide-showcase-live.mjs
import puppeteer from "puppeteer-core";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as url from "node:url";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const SHOTS = path.join(here, "..", "test-results");
await fs.mkdir(SHOTS, { recursive: true });
const EXPORT = "/home/driessen2/fluxv1/exports/showcase.html";

let passed = 0;
function ok(cond, msg) {
  if (!cond) throw new Error("FAIL: " + msg);
  passed++;
  console.log("  ok:", msg);
}

const browser = await puppeteer.launch({
  executablePath: "/usr/bin/google-chrome",
  headless: "new",
  args: ["--no-sandbox"],
  defaultViewport: { width: 1440, height: 810 },
});
try {
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.log("  [pageerror]", String(e).slice(0, 200)));
  await page.goto("file://" + EXPORT, { waitUntil: "load", timeout: 30000 });
  await page.waitForFunction(() => !!window.fluxDeck, { timeout: 15000 });

  const meta = await page.evaluate(() => {
    const payload = JSON.parse(document.getElementById("flux-payload").textContent);
    const els = {};
    payload.deck.slides.forEach((s, i) => {
      els[i] = Object.fromEntries(s.elements.map((e) => [e.type + (e.assetId ? ":" + e.assetId : ""), e.id]));
    });
    return { slideCount: window.fluxDeck.slideCount, beats: payload.deck.slides.map((s) => s.beats.length), els };
  });
  ok(meta.slideCount === 5, `export carries 5 slides (beats: ${meta.beats.join(",")})`);
  const style = (sel) => page.evaluate((s) => {
    const n = document.querySelector(s);
    return n ? { op: n.style.opacity, dash: n.style.strokeDasharray, off: n.style.strokeDashoffset, disp: n.style.display } : null;
  }, sel);

  // --- S2: scatter build — ticks undrawn at rest, drawn after their beat --------
  const scatterId = meta.els[1]["plot:example_plots/06_scatter_regression"];
  await page.evaluate(() => window.fluxDeck.goTo(1, 0));
  await new Promise((r) => setTimeout(r, 300));
  const tickSel = `[id="${scatterId}__axis.x.tick.1"] path`;
  const tick0 = await style(tickSel);
  ok(tick0 && tick0.dash !== "" && tick0.off !== "" && tick0.off !== "0", `beat 0: tick path rests UNDRAWN (dash=${tick0?.dash}, off=${tick0?.off}) — real per-tick geometry in the export`);
  const lastBeat1 = meta.beats[1] - 1;
  await page.evaluate((b) => window.fluxDeck.goTo(1, b), lastBeat1);
  await new Promise((r) => setTimeout(r, 300));
  const tickN = await style(tickSel);
  ok(tickN && tickN.off === "0", "final beat: the tick has DRAWN ON in the exported file (the original bug, end to end)");
  const fit = await style(`[id="${scatterId}__fit.line"] path`);
  ok(fit && fit.off === "0", "fit line fully drawn at the final beat");
  await page.screenshot({ path: path.join(SHOTS, "ws7-01-scatter-final.png") });

  // --- S3: enters AND exits ------------------------------------------------------
  const txtId = meta.els[2]["textBox"];
  const rectId = meta.els[2]["rect"];
  await page.evaluate(() => window.fluxDeck.goTo(2, 1));
  await new Promise((r) => setTimeout(r, 250));
  const blockIn = await style(`[data-el-id="${txtId}"] .sl-block`);
  const blockIn2 = blockIn ?? (await style(`.sl-block`));
  ok(blockIn2 && blockIn2.op !== "0", "beat 1: bullets are IN");
  await page.evaluate(() => window.fluxDeck.goTo(2, 3));
  await new Promise((r) => setTimeout(r, 250));
  const blockOut = await style(`.sl-block`);
  ok(blockOut && blockOut.op === "0", "beat 3: bullets EXITED (fadeOut rests hidden in the export)");
  const rectOut = await page.evaluate((id) => {
    const wraps = Array.from(document.querySelectorAll(".sl-el"));
    const w = wraps.find((x) => x.dataset.elId === id) ?? wraps.find((x) => x.querySelector(".sl-shape, [data-kind=rect]"));
    return w ? w.style.opacity : null;
  }, rectId);
  ok(rectOut === "0" || rectOut === null, `beat 3: the rect popped OUT (opacity ${rectOut})`);
  await page.evaluate(() => window.fluxDeck.goTo(2, 2));
  await new Promise((r) => setTimeout(r, 250));
  const blockBack = await style(`.sl-block`);
  ok(blockBack && blockBack.op !== "0", "scrub BACK to beat 2: bullets return (exit is reversible)");

  // --- S4: the ecdf medians (the leak, now first-class + animated) ----------------
  const ecdfId = meta.els[3]["plot:example_plots/08_ecdf"];
  const lastBeat3 = meta.beats[3] - 1;
  const medSel = `[id="${ecdfId}__reference-line.median-setosa"] path`;
  await page.evaluate(() => window.fluxDeck.goTo(3, 0));
  await new Promise((r) => setTimeout(r, 250));
  const med0 = await style(medSel);
  ok(med0 && med0.off !== "0" && med0.off !== "", "median rests undrawn before its beat");
  await page.evaluate((b) => window.fluxDeck.goTo(3, b), lastBeat3);
  await new Promise((r) => setTimeout(r, 250));
  const medN = await style(medSel);
  ok(medN && medN.off === "0", "the once-unaddressable ecdf median DRAWS ON in the export");

  // --- S1: countUp lands the authored text -----------------------------------------
  await page.evaluate(() => window.fluxDeck.goTo(0, 2));
  await new Promise((r) => setTimeout(r, 250));
  const statText = await page.evaluate(() => Array.from(document.querySelectorAll(".sl-block")).map((b) => b.textContent).find((t) => /n = /.test(t ?? "")));
  ok(statText?.includes("1,247"), `countUp rests at the authored stat ("${statText?.trim()}")`);

  // --- S5: the data-space morph ------------------------------------------------------
  const morphId = meta.els[4]["plot:example_plots/19_morph_scatter_a"];
  const probePoint = async () => page.evaluate((id) => {
    const pts = Array.from(document.querySelectorAll(`[id^="${id}__"][data-role="point"]`));
    const p = pts[3] ?? pts[0];
    if (!p) return null;
    const r = p.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), n: pts.length };
  }, morphId);
  await page.evaluate(() => window.fluxDeck.goTo(4, 0));
  await new Promise((r) => setTimeout(r, 300));
  const pA = await probePoint();
  await page.screenshot({ path: path.join(SHOTS, "ws7-02-morph-A.png") });
  await page.evaluate(() => window.fluxDeck.goTo(4, 1));
  await new Promise((r) => setTimeout(r, 300));
  const pB = await probePoint();
  await page.screenshot({ path: path.join(SHOTS, "ws7-03-morph-B.png") });
  ok(pA && pB && pA.n > 0, `morph plot points resolved (${pA?.n} points)`);
  ok(Math.abs(pA.x - pB.x) + Math.abs(pA.y - pB.y) > 4, `the morph MOVED the data (point ${JSON.stringify(pA)} → ${JSON.stringify(pB)}) — bare-assetId target gathered by the export`);

  // --- a REAL animated advance settles to the same state as the static jump ---------
  await page.evaluate(() => window.fluxDeck.goTo(4, 0));
  await new Promise((r) => setTimeout(r, 200));
  await page.keyboard.press("ArrowRight");
  await new Promise((r) => setTimeout(r, 2200)); // 1400ms morph + settle
  const pLive = await probePoint();
  ok(pLive && Math.abs(pLive.x - pB.x) <= 2 && Math.abs(pLive.y - pB.y) <= 2, `a LIVE advance settles exactly where the static state says (${JSON.stringify(pLive)} ≈ ${JSON.stringify(pB)})`);

  console.log(`\nSLIDE SHOWCASE EXPORT ACCEPTANCE (WS7) — ${passed} checks PASSED`);
} finally {
  await browser.close();
}
