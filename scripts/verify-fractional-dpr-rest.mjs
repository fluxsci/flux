// At a REAL fractional device scale, nothing resizes itself at rest.
//
// Owner, 2026-11-19 (their display runs at 1.25): the Figure-Meta preview "is vibrating very fast
// which makes it appear very blurry" when fitted or zoomed out. A fitted stage was sized from
// `clientWidth`, which ROUNDS the viewport's fractional size; rounded up, the stage overflowed
// its own viewport by a fraction of a device pixel, scrollbars appeared, the fit shrank, they
// went, and round again once per frame. Device-metrics EMULATION does not reproduce it (layout
// stays in CSS pixels there), which is why no gate saw it: this one launches Chrome with a
// real --force-device-scale-factor.
//
// Two parts: the preview itself, across many fractional sizes; and every other resting surface,
// watched for a ResizeObserver that keeps firing (the signature of any such loop).
//   Run (dev server must be up): node scripts/verify-fractional-dpr-rest.mjs
import puppeteer from "puppeteer-core";
import { CHROME, APP_URL, sleep, waitFor } from "./lib/driver.mjs";
import { harness } from "./lib/harness.mjs";

const h = harness("verify-fractional-dpr-rest");
const DSF = 1.25;
// Scrollbars must be REAL: the loop is a scrollbar taking room, the fit shrinking, and the
// scrollbar leaving. The driver hides them by default in headless runs, which hides the bug.
const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", defaultViewport: null, ignoreDefaultArgs: ["--hide-scrollbars"], args: ["--no-sandbox", "--window-size=1500,1000", `--force-device-scale-factor=${DSF}`] });
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e.message)));
try {
  // Count every ResizeObserver delivery in the app, by what was observed.
  await page.evaluateOnNewDocument(() => {
    const Native = window.ResizeObserver, log = (window.__ro = { n: 0, by: new Map() });
    window.ResizeObserver = class extends Native {
      constructor(cb) { super((entries, self) => { log.n += 1; for (const e of entries) { const k = (e.target.className?.baseVal ?? e.target.className ?? e.target.tagName).toString().split(" ")[0] || e.target.tagName; log.by.set(k, (log.by.get(k) ?? 0) + 1); } cb(entries, self); }); }
    };
  });
  await page.goto(`${APP_URL}?fixture=demo`, { waitUntil: "domcontentloaded" });
  await waitFor(page, () => !!document.querySelector(".titlebar .modestrip"), null, { timeout: 20000, label: "app" });
  await sleep(1500);
  h.eq(await page.evaluate(() => devicePixelRatio), DSF, "the page really runs at a 1.25 device scale (not emulated)");
  h.ok(await page.evaluate(() => { const d = document.createElement("div"); d.style.cssText = "position:fixed;left:-999px;width:100px;height:100px;overflow:scroll"; document.body.append(d); const w = d.offsetWidth - d.clientWidth; d.remove(); return w > 0; }), "scrollbars take room here, as they do in the app");
  const chord = async (mods, code) => { for (const m of mods) await page.keyboard.down(m); await page.keyboard.press(code); for (const m of [...mods].reverse()) await page.keyboard.up(m); };
  /** Resize deliveries over `ms` of doing nothing, with the busiest target. */
  const atRest = async (ms = 1000) => { await page.mouse.move(8, 8); await sleep(350); await page.evaluate(() => { window.__ro.n = 0; window.__ro.by.clear(); }); await sleep(ms); return page.evaluate(() => ({ n: window.__ro.n, top: [...window.__ro.by].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k, v]) => `${k}×${v}`).join(", ") })); };

  h.section("the Figure-Meta preview, fitted and zoomed out, at many fractional sizes");
  await page.click('.titlebar .modestrip button[aria-label="Figure"]'); await sleep(700);
  await chord(["Alt"], "KeyM");
  await waitFor(page, () => !!document.querySelector(".figure-meta .preview-viewport img"), null, { timeout: 15000, label: "figure preview" });
  await sleep(600);
  const sample = (ms = 220) => page.evaluate((ms) => new Promise((done) => {
    const vp = document.querySelector(".preview-viewport"), sheet = vp.querySelector(".preview-sheet"), seen = new Set(), t0 = performance.now();
    const step = () => {
      const r = sheet.getBoundingClientRect();
      seen.add([vp.dataset.scale, vp.clientWidth, vp.clientHeight, vp.offsetWidth - vp.clientWidth, vp.offsetHeight - vp.clientHeight, r.left.toFixed(3), r.top.toFixed(3), r.width.toFixed(3)].join("|"));
      if (performance.now() - t0 < ms) requestAnimationFrame(step);
      else { const b = vp.getBoundingClientRect(), dpr = devicePixelRatio; done({ states: [...seen], box: [b.width, b.height], bars: [vp.offsetWidth - vp.clientWidth, vp.offsetHeight - vp.clientHeight], overflow: [vp.scrollWidth - vp.clientWidth, vp.scrollHeight - vp.clientHeight], onGrid: [r.left, r.top, r.width].map((v) => Math.abs(v * dpr - Math.round(v * dpr)) < 0.02), fit: vp.dataset.fit, scrolls: vp.classList.contains("scrolls") }); }
    };
    requestAnimationFrame(step);
  }), ms);
  let worst = { states: [] }, fractional = 0, bars = 0, offGrid = 0, n = 0;
  for (let share = 30; share <= 72; share += 1.37) {
    await page.evaluate((share) => document.querySelector(".figure-meta .detail").style.setProperty("--preview-share", `${share}%`), share);
    await sleep(70);
    for (const zoomedOut of [false, true]) {
      if (zoomedOut) { await page.click('button[aria-label="Zoom out preview"]'); await sleep(60); }
      const s = await sample(); n++;
      if (s.states.length > worst.states.length) worst = { ...s, share, zoomedOut };
      if (s.box.some((v) => Math.abs(v - Math.round(v)) > 0.01)) fractional++;
      if (s.bars[0] || s.bars[1] || s.overflow[0] > 0 || s.overflow[1] > 0) bars++;
      if (!zoomedOut && !s.onGrid.every(Boolean)) offGrid++;
      if (zoomedOut) { await page.click('button[aria-label="Fit figure and caption"]'); await sleep(40); }
    }
  }
  h.ok(fractional > n / 2, `the sizes tried really are fractional (${fractional} of ${n}): the case that used to vibrate`);
  h.eq(worst.states.length, 1, `the preview is the same in every frame at every size (worst: ${JSON.stringify({ share: worst.share, zoomedOut: worst.zoomedOut, states: worst.states.slice(0, 3) })})`);
  h.eq(bars, 0, "a proof that fits never has a scrollbar and never overflows its viewport");
  h.eq(offGrid, 0, "a fitted proof sits on whole device pixels (edges are not smeared)");
  // Zoomed in, it still scrolls, steadily.
  await page.evaluate(() => document.querySelector(".figure-meta .detail").style.removeProperty("--preview-share"));
  await page.click('button[aria-label="Zoom in preview"]'); await page.click('button[aria-label="Zoom in preview"]'); await page.click('button[aria-label="Zoom in preview"]'); await sleep(200);
  let zoomed = await sample(300);
  h.ok(zoomed.scrolls && (zoomed.overflow[0] > 0 || zoomed.overflow[1] > 0) && zoomed.states.length === 1, `zoomed in past the viewport it scrolls, and is just as steady (${JSON.stringify({ scrolls: zoomed.scrolls, bars: zoomed.bars, overflow: zoomed.overflow, states: zoomed.states.length })})`);
  await page.click('button[aria-label="Fit figure and caption"]'); await sleep(200);
  zoomed = await sample(200);
  h.ok(!zoomed.scrolls && zoomed.fit === "true" && zoomed.states.length === 1, "back to Fit: no scrollbars, steady");
  let rest = await atRest();
  h.ok(rest.n <= 2, `Figure-Meta at rest: no resize loop (${rest.n} deliveries in a second: ${rest.top})`);
  await page.keyboard.press("Escape"); await waitFor(page, () => !document.querySelector(".figure-meta"), null, { timeout: 5000, label: "meta closed" });

  h.section("every other resting surface: nothing keeps resizing itself");
  const surfaces = [
    ["Figure", async () => {}],
    ["Figure, plots rail", async () => { await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Plots")?.click()); }],
    ["Slide", async () => { await page.click('.titlebar .modestrip button[aria-label="Slide"]'); }],
    ["Paper", async () => { await page.click('.titlebar .modestrip button[aria-label="Paper"]'); }],
    ["Paper, Figures card", async () => { await chord(["Alt"], "KeyF"); }],
    ["Paper, Comments pane", async () => { await chord(["Alt"], "KeyA"); }],
    ["Library", async () => { await page.click('.titlebar .modestrip button[aria-label="Library"]'); }],
    ["Reader", async () => { await page.click('.titlebar .modestrip button[aria-label="Reader"]'); }],
    ["Inbox", async () => { await page.click('.titlebar .modestrip button[aria-label="Figure"]'); await sleep(300); await chord(["Alt"], "KeyQ"); }],
    ["Settings", async () => { await page.keyboard.press("Escape"); await sleep(200); await page.evaluate(() => document.querySelector('.titlebar button[aria-label="Settings"]')?.click()); }],
  ];
  for (const [name, go] of surfaces) {
    await go(); await sleep(900);
    rest = await atRest();
    h.ok(rest.n <= 2, `${name}: at rest (${rest.n} resize deliveries in a second${rest.top ? `: ${rest.top}` : ""})`);
  }
  h.eq(errors, [], "no page errors");
} catch (e) {
  h.fail(`threw: ${e?.stack || e}`);
}
await h.done(() => browser.close());
