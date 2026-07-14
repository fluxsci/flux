// slide-migration §7.2 item 6 — the on-demand Animator dock over the live
// stores: toggle it open (remembered per deck), add a beat, quick-animate an
// element (⊕ in on a PartsTree row), Preview plays via the ONE player and
// tears down cleanly (no continuous rAF loop survives — the E43 lesson), and
// deleting a track's target element shows the MISSING-target marker without
// crashing (tolerate + surface, never prune). Re-homes the animator half of
// verify-slide-animator-live.mjs on the new model.
// Run: node scripts/verify-slide-animator-gui.mjs
import { launch, gotoApp, clickMode, sleep, realErrors, APP_URL, waitFor } from "./lib/driver.mjs";

let fails = 0;
const ok = (c, msg, extra = "") => (c ? console.log("  ✓ " + msg) : (fails++, console.log("  ✗ " + msg + (extra ? ` — ${extra}` : ""))));

const { browser, page } = await launch();
try {
  await gotoApp(page, { url: APP_URL + "?fixture=demo", settle: 1800 });
  ok(await clickMode(page, "Slide", { settle: 2600 }), "entered Slide mode");
  await waitFor(page, () => !!window.__flux?.get(window.__flux.slide.deckOverlay), null, { timeout: 15000, label: "deck loaded" });

  // dock is OFF by default (on-demand)
  const dock0 = await page.evaluate(() => !!document.querySelector(".animator"));
  ok(!dock0, "the Animator dock is on-demand (closed by default)");
  await page.evaluate(() => {
    [...document.querySelectorAll(".deckbar button")].find((b) => /Animate/.test(b.textContent || ""))?.click();
  });
  await waitFor(page, () => !!document.querySelector(".animator"), null, { timeout: 5000, label: "dock open" });
  ok(true, "Animate toggle opens the dock");

  // a shape to animate
  await page.evaluate(() => {
    const f = window.__flux;
    const sid = f.get(f.fig.activeFigureId);
    f.fig.commit((p) => {
      const fig = p.figures.find((x) => x.id === sid);
      fig.elements.push({ type: "rect", id: "anim-rect", name: "Hero", x: 100, y: 100, width: 120, height: 80, rotation: 0, fill: "#4385be", stroke: "none", strokeWidth: 0, cornerRadius: 0 });
    });
  });
  await sleep(400);

  // + Beat, then ⊕ in on the rect's PartsTree row
  await page.evaluate(() => {
    [...document.querySelectorAll(".animator .bar button")].find((b) => /\+ Beat/.test(b.textContent || ""))?.click();
  });
  await sleep(300);
  const quick = await page.evaluate(() => {
    const row = [...document.querySelectorAll(".parts .row")].find((r) => /Hero/.test(r.textContent || ""));
    if (!row) return { row: false };
    const btn = [...row.querySelectorAll("button")].find((b) => /in/.test(b.textContent || ""));
    btn?.click();
    return { row: true, clicked: !!btn };
  });
  await sleep(400);
  const authored = await page.evaluate(() => {
    const f = window.__flux;
    const sid = f.get(f.fig.activeFigureId);
    const o = f.get(f.slide.deckOverlay);
    const s = o.slides.find((x) => x.id === sid);
    const tracks = s.beats.flatMap((b) => b.tracks);
    const chip = [...document.querySelectorAll(".timeline .trk")].length;
    return { beats: s.beats.length, tracks: tracks.map((t) => ({ target: t.target, preset: t.preset })), chips: chip };
  });
  ok(quick.row && quick.clicked, "PartsTree lists the element with quick actions");
  ok(authored.beats === 2 && authored.tracks.some((t) => t.target === "anim-rect" && t.preset === "popIn"),
    `⊕ in authored the per-kind default track (rect → popIn) on the build beat`);
  ok(authored.chips >= 1, "the track renders as a timeline chip");

  // Preview plays via the player, then tears down — and NO rAF loop survives
  await page.evaluate(() => {
    window.__rafCount = 0;
    const orig = window.requestAnimationFrame.bind(window);
    window.__origRaf = orig;
    window.requestAnimationFrame = (cb) => {
      window.__rafCount++;
      return orig(cb);
    };
  });
  await page.evaluate(() => {
    [...document.querySelectorAll(".animator .bar button")].find((b) => /Preview/.test(b.textContent || ""))?.click();
  });
  await waitFor(page, () => !!document.querySelector(".preview-overlay"), null, { timeout: 5000, label: "preview overlay" });
  ok(true, "Preview swaps the stage to the player (present-in-place)");
  await waitFor(page, () => !document.querySelector(".preview-overlay"), null, { timeout: 15000, label: "preview auto-stop" });
  ok(true, "…and returns to the static editor at rest when the build ends");
  const raf = await page.evaluate(async () => {
    window.__rafCount = 0;
    await new Promise((r) => setTimeout(r, 700));
    return window.__rafCount;
  });
  ok(raf <= 6, `no continuous main-thread rAF loop after preview teardown (${raf} calls in 700ms — E43)`);

  // delete the track's target element → the chip marks MISSING, nothing crashes
  await page.evaluate(() => {
    const f = window.__flux;
    f.fig.selectOnly("anim-rect");
  });
  await page.keyboard.press("Delete");
  await sleep(500);
  const missing = await page.evaluate(() => {
    const f = window.__flux;
    const sid = f.get(f.fig.activeFigureId);
    const o = f.get(f.slide.deckOverlay);
    const s = o.slides.find((x) => x.id === sid);
    return {
      trackKept: s.beats.flatMap((b) => b.tracks).some((t) => t.target === "anim-rect"),
      missChip: !!document.querySelector(".timeline .trk.missing"),
      elGone: !f.get(f.fig.project).figures.find((x) => x.id === sid).elements.some((e) => e.id === "anim-rect"),
    };
  });
  ok(missing.elGone, "the element deleted through the figure editor");
  ok(missing.trackKept, "…its track is KEPT (never auto-pruned — undo restores the pair)");
  ok(missing.missChip, "…and the timeline chip shows the missing-target marker");

  // undo restores the element — the track resolves again
  await page.keyboard.down("Control");
  await page.keyboard.press("KeyZ");
  await page.keyboard.up("Control");
  await sleep(400);
  const healed = await page.evaluate(() => {
    const f = window.__flux;
    const sid = f.get(f.fig.activeFigureId);
    return {
      back: f.get(f.fig.project).figures.find((x) => x.id === sid).elements.some((e) => e.id === "anim-rect"),
      missChip: !!document.querySelector(".timeline .trk.missing"),
    };
  });
  ok(healed.back && !healed.missChip, "undoing the deletion heals the track (marker gone) — the tolerate-don't-prune payoff");

  const errs = realErrors(page);
  ok(errs.length === 0, "console is clean", errs.slice(0, 3).join(" | "));
} finally {
  await browser.close();
}
console.log(fails ? `\nSLIDE ANIMATOR GUI: FAIL (${fails})` : "\nSLIDE ANIMATOR GUI: PASS");
process.exit(fails ? 1 : 0);
