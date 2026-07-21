// Cascade — the TRACK flavor (slide animator) + the slide-mode element seams:
//  - ⌃⇧C with ≥2 selected tracks (animator open) opens the popover in track
//    flavor; a start cascade live-previews 0/200/400 in the overlay;
//  - the tuning burst coalesces into ONE undo entry (Enter seals it; one undo
//    reverts every start together);
//  - Esc rolls the run back and burns no entry;
//  - with <2 tracks selected the same chord falls through to the ELEMENT
//    cascade on the slide canvas;
//  - beat-faithful law: an element cascade at beat 1 routes a GOVERNED
//    element's delta into its transform's to.state (base untouched) while an
//    ungoverned element's base moves — the display-sync interplay the design
//    leaned on.
import { launch, gotoApp, clickMode, realErrors, shot, waitFor } from "./lib/driver.mjs";

let fails = 0;
function assert(cond, msg) {
  if (cond) console.log("  ok:", msg);
  else {
    fails++;
    console.error("  FAIL:", msg);
  }
}

const { browser, page } = await launch({ width: 1440, height: 900 });
try {
  await gotoApp(page, { url: "http://127.0.0.1:1420/?fixture=demo", settle: 3500 });
  assert(await clickMode(page, "Slide", { settle: 2600 }), "entered Slide mode");
  await waitFor(page, () => !!window.__flux?.get(window.__flux.slide.deckOverlay), null, { timeout: 15000, label: "deck loaded" });

  // Seed three rects on the active slide, then author one build beat with
  // three fade tracks (explicit ids — the cascade's ordering handles).
  await page.evaluate(() => {
    const f = window.__flux;
    const sid = f.get(f.fig.activeFigureId);
    const rect = (id, x) => ({
      type: "rect", id, x, y: 80, width: 60, height: 60, rotation: 0,
      fill: "#4385be", stroke: "none", strokeWidth: 0, cornerRadius: 0,
    });
    f.fig.commit((p) => {
      const fig = p.figures.find((x) => x.id === sid);
      fig.elements.push(rect("cr1", 100), rect("cr2", 300), rect("cr3", 500));
    });
    f.slide.commitDeckLive((d) => {
      const s = d.slides.find((x) => x.id === sid);
      s.beats.push({
        id: "cbeat",
        tracks: [
          { id: "tA", target: "cr1", preset: "fade" },
          { id: "tB", target: "cr2", preset: "fade" },
          { id: "tC", target: "cr3", preset: "fade" },
        ],
      });
    });
  });
  await page.evaluate(() => {
    [...document.querySelectorAll(".deckbar button")].find((b) => /Animate/.test(b.textContent || ""))?.click();
  });
  await waitFor(page, () => !!document.querySelector(".animator"), null, { timeout: 5000, label: "animator dock open" });

  const past = () => page.evaluate(() => window.__flux.fig.historyStats().past);
  const tracks = () =>
    page.evaluate(() => {
      const f = window.__flux;
      const sid = f.get(f.fig.activeFigureId);
      const o = f.get(f.slide.deckOverlay);
      const all = o.slides.find((x) => x.id === sid).beats.flatMap((b) => b.tracks);
      return Object.fromEntries(["tA", "tB", "tC"].map((id) => {
        const t = all.find((x) => x.id === id);
        return [id, { start: t?.start ?? 0, duration: t?.duration ?? 400 }];
      }));
    });
  const chord = async () => {
    await page.keyboard.down("Control");
    await page.keyboard.down("Shift");
    await page.keyboard.press("KeyC");
    await page.keyboard.up("Shift");
    await page.keyboard.up("Control");
  };
  const setNum = (sel, v) =>
    page.evaluate(
      ([sel, v]) => {
        const el = document.querySelector(sel);
        const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
        desc.set.call(el, String(v));
        el.dispatchEvent(new Event("input", { bubbles: true }));
      },
      [sel, v],
    );

  // ---- 1. start stagger: ⌃⇧C on 3 selected tracks --------------------------------
  await page.evaluate(() => window.__flux.slide.selTrackIds.set(["tA", "tB", "tC"]));
  const past0 = await past();
  await chord();
  await waitFor(page, () => !!document.querySelector(".cascade-pop"), null, { label: "track-flavor popover open" });
  await page.click(".cascade-pop label.ff input"); // classic stagger: first at its own time
  await setNum(".cascade-pop input.delta", 200); // track flavor defaults to Start (ms)
  await waitFor(
    page,
    () => {
      const f = window.__flux;
      const sid = f.get(f.fig.activeFigureId);
      const o = f.get(f.slide.deckOverlay);
      return o.slides.find((x) => x.id === sid).beats.flatMap((b) => b.tracks).find((t) => t.id === "tC")?.start === 400;
    },
    null,
    { label: "start stagger previewed" },
  );
  const t1 = await tracks();
  assert(t1.tA.start === 0 && t1.tB.start === 200 && t1.tC.start === 400, `start +200 first-fixed → 0/200/400 (got ${t1.tA.start}/${t1.tB.start}/${t1.tC.start})`);
  assert((await past()) === past0 + 1, "the coalesced tuning run is ONE history entry");
  await shot(page, "cascade-tracks-preview");
  await page.keyboard.press("Enter");
  await waitFor(page, () => !document.querySelector(".cascade-pop"), null, { label: "Enter closes the popover" });
  assert((await past()) === past0 + 1, "…and stays one entry after apply");
  await page.evaluate(() => window.__flux.fig.undo());
  const t2 = await tracks();
  assert(t2.tA.start === 0 && t2.tB.start === 0 && t2.tC.start === 0, "ONE undo reverts every start together (overlay companion)");

  // ---- 2. Esc rolls the run back, no entry ------------------------------------------
  const past1 = await past();
  await page.evaluate(() => window.__flux.slide.selTrackIds.set(["tA", "tB", "tC"]));
  await chord();
  await waitFor(page, () => !!document.querySelector(".cascade-pop"), null, { label: "reopened for the Esc path" });
  await page.select(".cascade-pop select.prop", "duration");
  await setNum(".cascade-pop input.delta", 100);
  await waitFor(
    page,
    () => {
      const f = window.__flux;
      const sid = f.get(f.fig.activeFigureId);
      const o = f.get(f.slide.deckOverlay);
      return o.slides.find((x) => x.id === sid).beats.flatMap((b) => b.tracks).find((t) => t.id === "tC")?.duration === 700;
    },
    null,
    { label: "duration ramp previewed (500/600/700)" },
  );
  await page.keyboard.press("Escape");
  await waitFor(page, () => !document.querySelector(".cascade-pop"), null, { label: "Esc closes the popover" });
  const t3 = await tracks();
  assert(t3.tA.duration === 400 && t3.tC.duration === 400, "Esc reverts the duration ramp");
  assert((await past()) === past1, "Esc leaves NO history entry");

  // ---- 3. <2 tracks selected: the chord falls through to the ELEMENT cascade --------
  await page.evaluate(() => {
    const f = window.__flux;
    f.slide.selTrackIds.set([]);
    f.fig.selection.set(new Set(["cr2", "cr3"]));
  });
  await chord();
  await waitFor(page, () => !!document.querySelector(".cascade-pop"), null, { label: "element-flavor popover open on the slide canvas" });
  await setNum(".cascade-pop input.delta", 15); // element flavor defaults to X
  await waitFor(page, () => window.__flux.figures().find((f) => f.elements.some((e) => e.id === "cr2"))?.elements.find((e) => e.id === "cr2")?.x === 315, null, {
    label: "element preview applied on the slide canvas",
  });
  await page.keyboard.press("Escape");

  // ---- 4. beat-faithful routing: element cascade at beat 1 writes a GOVERNED
  //         element's delta into its transform's to.state, not its base ---------------
  await page.evaluate(() => {
    const f = window.__flux;
    const sid = f.get(f.fig.activeFigureId);
    f.slide.commitDeckLive((d) => {
      const s = d.slides.find((x) => x.id === sid);
      s.beats[1].tracks.push({ id: "tX", target: "cr1", preset: "transform", duration: 600, easing: "smooth", to: { state: {} } });
    });
    f.slide.activeBeat.set(1);
  });
  await waitFor(page, () => window.__flux.get(window.__flux.slide.activeBeat) === 1, null, { label: "beat 1 active" });
  await page.evaluate(() => window.__flux.fig.selection.set(new Set(["cr1", "cr2"])));
  await chord();
  await waitFor(page, () => !!document.querySelector(".cascade-pop"), null, { label: "element popover open at beat 1" });
  await setNum(".cascade-pop input.delta", 30);
  await waitFor(page, () => window.__flux.figures().find((f) => f.elements.some((e) => e.id === "cr1"))?.elements.find((e) => e.id === "cr1")?.x === 130, null, {
    label: "governed element displays the cascaded x",
  });
  await page.keyboard.press("Enter");
  await waitFor(page, () => !document.querySelector(".cascade-pop"), null, { label: "applied at beat 1" });
  const routed = await page.evaluate(() => {
    const f = window.__flux;
    const sid = f.get(f.fig.activeFigureId);
    const d = f.slide.currentDeck();
    const s = d.slides.find((x) => x.id === sid);
    const tX = s.beats.flatMap((b) => b.tracks).find((t) => t.id === "tX");
    return {
      baseX1: s.elements.find((e) => e.id === "cr1")?.x,
      baseX2: s.elements.find((e) => e.id === "cr2")?.x,
      stateX: tX?.to?.state?.x,
    };
  });
  assert(routed.baseX1 === 100, `governed element's BASE stays put (got ${routed.baseX1})`);
  assert(routed.stateX === 130, `…its delta routed into the transform's to.state (got ${routed.stateX})`);
  assert(routed.baseX2 === 360, `ungoverned element's base moves by its rank (got ${routed.baseX2})`);
  await page.evaluate(() => window.__flux.fig.undo());

  const errs = realErrors(page);
  assert(errs.length === 0, `no console errors (${errs.length})`);
  if (errs.length) console.error(errs.slice(0, 5));
  console.log(fails === 0 ? "\nVERIFY-CASCADE-TRACKS-GUI ALL PASS" : `\nVERIFY-CASCADE-TRACKS-GUI ${fails} FAILURE(S)`);
} finally {
  await browser.close();
}
process.exit(fails === 0 ? 0 : 1);
