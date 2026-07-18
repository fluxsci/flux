#!/usr/bin/env node
// Animation rework — BEAT-FAITHFUL CANVAS (owner directive 2026-07-18): the
// slide canvas always shows the slide AS IT EXISTS AT THE ACTIVE BEAT, and
// plain edits route into the state you are looking at.
//   • beat 0 (or any beat before an element's first transform) = the BASE;
//   • the transform's beat and every later beat = the composed t2;
//   • chains compose progressively (middle beats show the partial fold);
//   • an edit at beat k routes into the GOVERNING transform's to.state
//     ("you edit what you see"); an edit at beat 0 edits the base;
//   • autosave mid-display writes BASE elements (the fold guard);
//   • disabling/deleting the governing track reverts the view live;
//   • undo restores canvas + track together; slide switches restore the
//     outgoing slide's bases and re-derive the incoming one;
//   • coalesced typing runs stay ONE undo entry (no-op refreshes must not
//     burn editGen);
//   • filmstrip thumbnails paint the slide's OWN background (no black
//     placeholder in light themes).
// Run: node scripts/verify-beat-display-gui.mjs
import { launch, gotoApp, clickMode, sleep, realErrors, APP_URL, waitFor } from "./lib/driver.mjs";

let fails = 0;
const ok = (c, msg, extra = "") => (c ? console.log("  ✓ " + msg) : (fails++, console.log("  ✗ " + msg + (extra ? ` — ${extra}` : ""))));

const { browser, page } = await launch();
try {
  await gotoApp(page, { url: APP_URL + "?fixture=demo", settle: 1800 });
  ok(await clickMode(page, "Slide", { settle: 2600 }), "entered Slide mode");
  await waitFor(page, () => !!window.__flux?.get(window.__flux.slide.deckOverlay), null, { timeout: 15000, label: "deck loaded" });

  const readEl = (id = "bd-rect") =>
    page.evaluate((eid) => {
      const f = window.__flux;
      const sid = f.get(f.fig.activeFigureId);
      const el = f.get(f.fig.project).figures.find((x) => x.id === sid).elements.find((e) => e.id === eid);
      return el ? { x: el.x, y: el.y, width: el.width, fill: el.fill } : null;
    }, id);
  const setBeat = async (k) => {
    await page.evaluate((b) => window.__flux.slide.activeBeat.set(b), k);
    await sleep(150);
  };

  // --- fixture: a rect + transform on beat 1, a second transform on beat 2 ------
  await page.evaluate(() => {
    const f = window.__flux;
    const sid = f.get(f.fig.activeFigureId);
    f.fig.commit((p) => {
      p.figures.find((x) => x.id === sid).elements.push({ type: "rect", id: "bd-rect", x: 40, y: 60, width: 120, height: 80, rotation: 0, fill: "#d95f02", stroke: "none", strokeWidth: 0, cornerRadius: 0 });
    });
    f.slide.commitDeckLive((d) => {
      const b1 = f.slideOps.addBeat(d, sid, { label: "move" });
      f.slideOps.setTransform(d, sid, b1.id, "bd-rect", { state: { x: 300, fill: "#4385be" }, duration: 500 });
      const b2 = f.slideOps.addBeat(d, sid, { label: "drop" });
      f.slideOps.setTransform(d, sid, b2.id, "bd-rect", { state: { y: 220 } }, );
    });
  });
  await sleep(250);

  // --- THE CORE ASK: scrubbing beats shows the state at that point ---------------
  await setBeat(0);
  let el = await readEl();
  ok(el.x === 40 && el.y === 60 && el.fill === "#d95f02", `beat 0 → the BASE (t1) state (${el.x},${el.y},${el.fill})`);
  await setBeat(1);
  el = await readEl();
  ok(el.x === 300 && el.fill === "#4385be" && el.y === 60, `the transform's beat → its t2 (${el.x},${el.fill})`);
  await setBeat(2);
  el = await readEl();
  ok(el.x === 300 && el.y === 220, `a LATER beat → the chain composed (${el.x},${el.y})`);
  await setBeat(1);
  el = await readEl();
  ok(el.y === 60 && el.x === 300, "back to the middle beat → the partial fold (second transform not yet applied)");
  await setBeat(0);
  el = await readEl();
  ok(el.x === 40 && el.fill === "#d95f02", "…and back to beat 0 → the base again (round-trip clean)");

  // --- editing routes into the state you're looking at ---------------------------
  await setBeat(1);
  await page.evaluate(() => {
    const f = window.__flux;
    const sid = f.get(f.fig.activeFigureId);
    f.fig.commit((p) => {
      p.figures.find((x) => x.id === sid).elements.find((e) => e.id === "bd-rect").width = 222;
    });
  });
  await sleep(200);
  const routed = await page.evaluate(() => {
    const f = window.__flux;
    const sid = f.get(f.fig.activeFigureId);
    const s = f.get(f.slide.deckOverlay).slides.find((x) => x.id === sid);
    return { s1: s.beats[1].tracks[0]?.to?.state, s2: s.beats[2].tracks[0]?.to?.state };
  });
  ok(routed.s1?.width === 222 && routed.s1?.x === 300, `a plain edit at beat 1 routed into the GOVERNING transform's t2 (${JSON.stringify(routed.s1)})`);
  ok(!("width" in (routed.s2 ?? { width: 1 })) || routed.s2?.width === undefined, "…and the later transform's own patch is untouched");
  await setBeat(0);
  el = await readEl();
  ok(el.width === 120, "the base width is untouched (the edit lived at t2)");

  // --- editing at beat 0 edits the BASE ------------------------------------------
  await page.evaluate(() => {
    const f = window.__flux;
    const sid = f.get(f.fig.activeFigureId);
    f.fig.commit((p) => {
      p.figures.find((x) => x.id === sid).elements.find((e) => e.id === "bd-rect").x = 60;
    });
  });
  await sleep(200);
  const baseEdit = await page.evaluate(() => {
    const f = window.__flux;
    const sid = f.get(f.fig.activeFigureId);
    const s = f.get(f.slide.deckOverlay).slides.find((x) => x.id === sid);
    return { s1x: s.beats[1].tracks[0]?.to?.state?.x };
  });
  ok(baseEdit.s1x === 300, "an edit at beat 0 is a plain BASE edit (no track state touched)");
  await setBeat(1);
  el = await readEl();
  ok(el.x === 300, "…and t2's absolute x still wins at its beat");

  // --- the fold guard holds for the AMBIENT display ------------------------------
  await setBeat(2);
  await page.evaluate(() => window.__flux.lifecycle.flushById("slide"));
  await sleep(400);
  const onDisk = await page.evaluate(async () => {
    const f = window.__flux;
    const root = f.get(f.shell.projectModel).root;
    const id = f.get(f.slide.deckOverlay).id;
    const deck = JSON.parse(await window.fig.readText(`${root}/slides/${id}/deck.json`).catch(() => "{}"));
    const slide = (deck.slides ?? []).find((s) => (s.elements ?? []).some((e) => e.id === "bd-rect"));
    const dEl = slide?.elements.find((e) => e.id === "bd-rect");
    return { x: dEl?.x, y: dEl?.y, width: dEl?.width };
  });
  ok(onDisk.x === 60 && onDisk.y === 60 && onDisk.width === 120, `autosave during ambient display writes the BASE (${JSON.stringify(onDisk)})`);

  // --- disabling / deleting the governing track reverts the view live ------------
  const t1id = await page.evaluate(() => {
    const f = window.__flux;
    const sid = f.get(f.fig.activeFigureId);
    return f.get(f.slide.deckOverlay).slides.find((x) => x.id === sid).beats[1].tracks[0].id;
  });
  await page.evaluate((tid) => {
    const f = window.__flux;
    const sid = f.get(f.fig.activeFigureId);
    f.slide.commitDeckLive((d) => f.slideOps.setTrackEnabled(d, sid, tid, false));
  }, t1id);
  await sleep(200);
  el = await readEl();
  ok(el.x === 60 && el.y === 220 && el.width === 120, `disabling the first transform drops ITS fold live (x/width base, y from the second: ${el.x},${el.y},${el.width})`);
  await page.evaluate((tid) => {
    const f = window.__flux;
    const sid = f.get(f.fig.activeFigureId);
    f.slide.commitDeckLive((d) => f.slideOps.setTrackEnabled(d, sid, tid, true));
  }, t1id);
  await sleep(200);
  el = await readEl();
  ok(el.x === 300 && el.width === 222, "re-enabling restores the composed view");

  // --- undo restores canvas + track together -------------------------------------
  await page.evaluate(() => window.__flux.fig.undo()); // undo the re-enable
  await page.evaluate(() => window.__flux.fig.undo()); // undo the disable
  await page.evaluate(() => window.__flux.fig.undo()); // undo the base x=60 edit
  await sleep(250);
  const postUndo = await page.evaluate(() => {
    const f = window.__flux;
    const sid = f.get(f.fig.activeFigureId);
    const s = f.get(f.slide.deckOverlay).slides.find((x) => x.id === sid);
    const el2 = f.get(f.fig.project).figures.find((x) => x.id === sid).elements.find((e) => e.id === "bd-rect");
    return { s1x: s.beats[1].tracks[0]?.to?.state?.x, elX: el2.x, elY: el2.y, beat: f.get(f.slide.activeBeat) };
  });
  ok(postUndo.s1x === 300 && postUndo.elX === 300 && postUndo.elY === 220,
    `undo walks back cleanly with the display re-derived per the restored model (beat ${postUndo.beat}: ${postUndo.elX},${postUndo.elY})`);
  await setBeat(0);
  el = await readEl();
  ok(el.x === 40, "…and beat 0 shows the restored base (x back to 40)");

  // --- slide switch restores the outgoing slide's bases --------------------------
  await page.evaluate(() => {
    const f = window.__flux;
    f.slide.commitDeckLive((d) => f.slideOps.addSlide(d, { name: "S2", layout: "blank" }));
  });
  await setBeat(2); // display composed on slide 1
  const s1id = await page.evaluate(() => window.__flux.get(window.__flux.fig.activeFigureId));
  await page.evaluate(() => {
    const f = window.__flux;
    const o = f.get(f.slide.deckOverlay);
    f.slide.selectSlide(o.slides[o.slides.length - 1].id);
  });
  await sleep(250);
  const s1AtRest = await page.evaluate((sid) => {
    const el2 = window.__flux.get(window.__flux.fig.project).figures.find((x) => x.id === sid).elements.find((e) => e.id === "bd-rect");
    return { x: el2.x, y: el2.y };
  }, s1id);
  ok(s1AtRest.x === 40 && s1AtRest.y === 60, `switching AWAY restored the outgoing slide's store elements to BASE (${s1AtRest.x},${s1AtRest.y})`);
  await page.evaluate((sid) => window.__flux.slide.selectSlide(sid), s1id);
  await sleep(250);
  const s1Back = await page.evaluate(() => {
    const f = window.__flux;
    const sid = f.get(f.fig.activeFigureId);
    const el2 = f.get(f.fig.project).figures.find((x) => x.id === sid).elements.find((e) => e.id === "bd-rect");
    return { x: el2.x, y: el2.y, beat: f.get(f.slide.activeBeat) };
  });
  ok(s1Back.x === 300 && s1Back.y === 220, `switching BACK lands fully-built (last beat ${s1Back.beat}: ${s1Back.x},${s1Back.y})`);

  // --- coalesced typing stays ONE undo entry (no-op refreshes are free) ----------
  const coalesced = await page.evaluate(() => {
    const f = window.__flux;
    const sid = f.get(f.fig.activeFigureId);
    const o = f.get(f.slide.deckOverlay);
    const s = o.slides.find((x) => x.id === sid);
    const bid = s.beats[1].id;
    const before = f.fig.historyStats().past;
    f.slide.commitDeckLive((d) => f.slideOps.setBeat(d, sid, bid, { label: "t" }), { coalesce: "bd-label" });
    f.slide.commitDeckLive((d) => f.slideOps.setBeat(d, sid, bid, { label: "ty" }), { coalesce: "bd-label" });
    f.slide.commitDeckLive((d) => f.slideOps.setBeat(d, sid, bid, { label: "typ" }), { coalesce: "bd-label" });
    f.slide.sealHistory();
    return { added: f.fig.historyStats().past - before };
  });
  ok(coalesced.added === 1, `a coalesced label-typing run stayed ONE undo entry (${coalesced.added})`);

  // --- thumbnails paint the slide's own background (light theme) -----------------
  await page.evaluate(() => {
    const f = window.__flux;
    f.slide.commitDeckLive((d) => f.slideOps.setTheme(d, "flux-light"));
  });
  await sleep(900); // theme swap + thumb debounce
  const thumbBg = await page.evaluate(() => {
    const wraps = [...document.querySelectorAll(".filmstrip .thumb-wrap")];
    const bgs = wraps.map((w) => getComputedStyle(w).backgroundColor);
    const themeBg = (() => {
      const probe = document.createElement("div");
      probe.style.color = "#fffcf0"; // flux-light background (Flexoki paper)
      return probe.style.color;
    })();
    return { bgs, themeBg, n: wraps.length };
  });
  ok(thumbBg.n > 0, `filmstrip thumbnails present (${thumbBg.n})`);
  ok(!thumbBg.bgs.some((b) => b === "rgb(0, 0, 0)"), `no thumbnail paints the old hardcoded BLACK behind a light slide (${thumbBg.bgs[0]})`);
  ok(thumbBg.bgs.every((b) => b === thumbBg.bgs[0]) && thumbBg.bgs[0] === thumbBg.themeBg,
    `thumb backgrounds match the slide's own resting background (${thumbBg.bgs[0]})`);

  const errs = realErrors(page);
  ok(errs.length === 0, "console is clean", errs.slice(0, 3).join(" | "));
} finally {
  await browser.close();
}
console.log(fails ? `\nBEAT DISPLAY GUI: FAIL (${fails})` : "\nBEAT DISPLAY GUI: PASS");
process.exit(fails ? 1 : 0);
