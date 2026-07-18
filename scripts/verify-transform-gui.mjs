#!/usr/bin/env node
// Animation rework §4.4/§8 — the ENDPOINT CHECKOUT in the real GUI:
//   • Ctrl+Shift+T (animator open) creates the transform track in a build
//     beat and checks out t2 immediately (the add-then-sculpt flow);
//   • an ordinary canvas/store commit while checked out mirrors a sparse
//     diff into the track's to.state — and the canvas SHOWS the t2 state;
//   • AUTOSAVE MID-CHECKOUT writes the BASE element into deck.json (the
//     fold guard — deck.json never contains a composed endpoint state);
//   • t1 on an unchained transform = plain document editing (base shown);
//   • Esc exits the checkout and restores the base on canvas;
//   • undo folds the canvas edit + track state into ONE step;
//   • chained transforms: the later track's t1 handle edits the UPSTREAM
//     track's state;
//   • the chords are INERT with the animator closed (and Ctrl+Shift+A/D
//     never fall through to select-all/duplicate — the !shiftKey guards).
// Run: node scripts/verify-transform-gui.mjs
import { launch, gotoApp, clickMode, sleep, realErrors, APP_URL, waitFor } from "./lib/driver.mjs";

let fails = 0;
const ok = (c, msg, extra = "") => (c ? console.log("  ✓ " + msg) : (fails++, console.log("  ✗ " + msg + (extra ? ` — ${extra}` : ""))));

const { browser, page } = await launch();
try {
  await gotoApp(page, { url: APP_URL + "?fixture=demo", settle: 1800 });
  ok(await clickMode(page, "Slide", { settle: 2600 }), "entered Slide mode");
  await waitFor(page, () => !!window.__flux?.get(window.__flux.slide.deckOverlay), null, { timeout: 15000, label: "deck loaded" });

  // --- a rect to transform ------------------------------------------------------
  await page.evaluate(() => {
    const f = window.__flux;
    const sid = f.get(f.fig.activeFigureId);
    f.fig.commit((p) => {
      const fig = p.figures.find((x) => x.id === sid);
      fig.elements.push({ type: "rect", id: "tr-rect", x: 40, y: 60, width: 120, height: 80, rotation: 0, fill: "#d95f02", stroke: "#222222", strokeWidth: 2, cornerRadius: 0 });
    });
    f.fig.selectOnly("tr-rect");
  });

  // --- chord inert with the animator CLOSED ------------------------------------
  await page.keyboard.down("Control");
  await page.keyboard.down("Shift");
  await page.keyboard.press("KeyT");
  await page.keyboard.up("Shift");
  await page.keyboard.up("Control");
  await sleep(150);
  const closedState = await page.evaluate(() => {
    const f = window.__flux;
    const sid = f.get(f.fig.activeFigureId);
    const o = f.get(f.slide.deckOverlay);
    const s = o.slides.find((x) => x.id === sid);
    return { beats: s.beats.length, checkout: !!f.get(f.slide.endpointEdit) };
  });
  ok(closedState.beats === 1 && !closedState.checkout, "Ctrl+Shift+T is INERT while the animator is closed");

  // Ctrl+Shift+A must NOT select-all (the !shiftKey guard)
  await page.keyboard.down("Control");
  await page.keyboard.down("Shift");
  await page.keyboard.press("KeyA");
  await page.keyboard.up("Shift");
  await page.keyboard.up("Control");
  await sleep(120);
  const selAfterChord = await page.evaluate(() => window.__flux.get(window.__flux.fig.selection).size);
  ok(selAfterChord === 1, `Ctrl+Shift+A no longer falls through to select-all (selection stayed 1, got ${selAfterChord})`);

  // --- open the animator, chord again -------------------------------------------
  await page.evaluate(() => {
    [...document.querySelectorAll("button")].find((b) => /Animate ⏱/.test(b.textContent || ""))?.click();
  });
  await waitFor(page, () => !!document.querySelector(".animator"), null, { timeout: 6000, label: "animator open" });
  await page.evaluate(() => window.__flux.fig.selectOnly("tr-rect"));
  await page.keyboard.down("Control");
  await page.keyboard.down("Shift");
  await page.keyboard.press("KeyT");
  await page.keyboard.up("Shift");
  await page.keyboard.up("Control");
  await sleep(250);

  const created = await page.evaluate(() => {
    const f = window.__flux;
    const sid = f.get(f.fig.activeFigureId);
    const o = f.get(f.slide.deckOverlay);
    const s = o.slides.find((x) => x.id === sid);
    const tracks = s.beats.flatMap((b, bi) => b.tracks.map((t) => ({ bi, id: t.id, preset: t.preset, target: t.target, state: t.to?.state })));
    const ee = f.get(f.slide.endpointEdit);
    return { beats: s.beats.length, tracks, checkout: ee, sel: f.get(f.slide.selTrackIds) };
  });
  const trTrack = created.tracks.find((t) => t.preset === "transform" && t.target === "tr-rect");
  ok(!!trTrack && created.beats === 2 && trTrack.bi === 1, "Ctrl+Shift+T created the transform track in a build beat (beat 1 auto-created)");
  ok(created.checkout?.end === "t2" && created.checkout.entries.some((e) => e.trackId === trTrack?.id), "…and entered the t2 checkout immediately");
  ok(created.sel.includes(trTrack?.id), "…with the new track selected");

  // --- sculpt t2 through an ordinary store commit --------------------------------
  await page.evaluate(() => {
    const f = window.__flux;
    const sid = f.get(f.fig.activeFigureId);
    f.fig.commit((p) => {
      const el = p.figures.find((x) => x.id === sid).elements.find((e) => e.id === "tr-rect");
      el.x = 300;
      el.fill = "#4385be";
    });
  });
  await sleep(150);
  const afterEdit = await page.evaluate(() => {
    const f = window.__flux;
    const sid = f.get(f.fig.activeFigureId);
    const o = f.get(f.slide.deckOverlay);
    const s = o.slides.find((x) => x.id === sid);
    const t = s.beats.flatMap((b) => b.tracks).find((tk) => tk.preset === "transform");
    const el = f.get(f.fig.project).figures.find((x) => x.id === sid).elements.find((e) => e.id === "tr-rect");
    return { state: t?.to?.state, elX: el.x, elFill: el.fill };
  });
  ok(afterEdit.state?.x === 300 && afterEdit.state?.fill === "#4385be", `the canvas edit mirrored into to.state as a SPARSE diff (got ${JSON.stringify(afterEdit.state)})`);
  ok(afterEdit.elX === 300 && afterEdit.elFill === "#4385be", "…while the canvas shows the t2 state");

  // --- THE FOLD GUARD: autosave mid-checkout writes the BASE --------------------
  await page.evaluate(() => window.__flux.lifecycle.flushById("slide"));
  await sleep(400);
  const onDisk = await page.evaluate(async () => {
    const f = window.__flux;
    const root = f.get(f.shell.projectModel).root;
    const id = f.get(f.slide.deckOverlay).id;
    const deck = JSON.parse(await window.fig.readText(`${root}/slides/${id}/deck.json`).catch(() => "{}"));
    const slide = (deck.slides ?? []).find((s) => (s.elements ?? []).some((e) => e.id === "tr-rect"));
    const el = slide?.elements.find((e) => e.id === "tr-rect");
    const t = slide?.beats.flatMap((b) => b.tracks).find((tk) => tk.preset === "transform");
    const stillCheckedOut = !!f.get(f.slide.endpointEdit);
    return { el: { x: el?.x, fill: el?.fill }, state: t?.to?.state, stillCheckedOut };
  });
  ok(onDisk.stillCheckedOut, "the checkout survived the autosave");
  ok(onDisk.el.x === 40 && onDisk.el.fill === "#d95f02", `deck.json holds the BASE element mid-checkout (x=${onDisk.el.x}, fill=${onDisk.el.fill}) — never a composed state`);
  ok(onDisk.state?.x === 300, "…and the track carries the t2 patch");

  // --- t1 on an unchained transform = a BASE-editing override --------------------
  await page.click(".trk .ep.t1");
  await sleep(200);
  const t1State = await page.evaluate(() => {
    const f = window.__flux;
    const sid = f.get(f.fig.activeFigureId);
    const ee = f.get(f.slide.endpointEdit);
    const el = f.get(f.fig.project).figures.find((x) => x.id === sid).elements.find((e) => e.id === "tr-rect");
    return { end: ee?.end, route: ee?.entries?.[0]?.trackId, elX: el.x };
  });
  ok(t1State.end === "t1" && t1State.route === null && t1State.elX === 40,
    "t1 with no upstream = a lit BASE override (canvas shows/edits the document state)");

  // --- t2 handle re-enters -------------------------------------------------------
  await page.click(".trk .ep.t2");
  await sleep(200);
  const t2Again = await page.evaluate(() => {
    const f = window.__flux;
    const sid = f.get(f.fig.activeFigureId);
    const el = f.get(f.fig.project).figures.find((x) => x.id === sid).elements.find((e) => e.id === "tr-rect");
    return { end: f.get(f.slide.endpointEdit)?.end, elX: el.x };
  });
  ok(t2Again.end === "t2" && t2Again.elX === 300, "the t₂ handle re-enters the checkout (canvas back at t2)");

  // --- undo folds canvas + track as ONE step -------------------------------------
  await page.evaluate(() => {
    const f = window.__flux;
    const sid = f.get(f.fig.activeFigureId);
    f.fig.commit((p) => {
      const el = p.figures.find((x) => x.id === sid).elements.find((e) => e.id === "tr-rect");
      el.x = 380;
    });
  });
  await sleep(150);
  const preUndo = await page.evaluate(() => {
    const f = window.__flux;
    const o = f.get(f.slide.deckOverlay);
    const t = o.slides.flatMap((s) => s.beats).flatMap((b) => b.tracks).find((tk) => tk.preset === "transform");
    return t?.to?.state?.x;
  });
  ok(preUndo === 380, "a second sculpt updated the patch (x=380)");
  await page.evaluate(() => window.__flux.fig.undo());
  await sleep(200);
  const postUndo = await page.evaluate(() => {
    const f = window.__flux;
    const sid = f.get(f.fig.activeFigureId);
    const o = f.get(f.slide.deckOverlay);
    const t = o.slides.flatMap((s) => s.beats).flatMap((b) => b.tracks).find((tk) => tk.preset === "transform");
    const el = f.get(f.fig.project).figures.find((x) => x.id === sid).elements.find((e) => e.id === "tr-rect");
    return { stateX: t?.to?.state?.x, elX: el.x, checkout: !!f.get(f.slide.endpointEdit) };
  });
  ok(postUndo.stateX === 300 && postUndo.elX === 300, `ONE undo reverted canvas + track together (el x=${postUndo.elX}, state x=${postUndo.stateX})`);
  ok(postUndo.checkout, "…with the checkout still active (its state rides the same history)");

  // --- Esc drops the explicit endpoint; the canvas stays BEAT-FAITHFUL -----------
  await page.keyboard.press("Escape");
  await sleep(200);
  const postEsc = await page.evaluate(() => {
    const f = window.__flux;
    const sid = f.get(f.fig.activeFigureId);
    const el = f.get(f.fig.project).figures.find((x) => x.id === sid).elements.find((e) => e.id === "tr-rect");
    return { checkout: !!f.get(f.slide.endpointEdit), beat: f.get(f.slide.activeBeat), elX: el.x };
  });
  ok(!postEsc.checkout && postEsc.beat === 1 && postEsc.elX === 300,
    "Esc drops the endpoint selection; the canvas stays faithful to the active beat (composed t2)");
  await page.evaluate(() => window.__flux.slide.activeBeat.set(0));
  await sleep(200);
  const atBase = await page.evaluate(() => {
    const f = window.__flux;
    const sid = f.get(f.fig.activeFigureId);
    const el = f.get(f.fig.project).figures.find((x) => x.id === sid).elements.find((e) => e.id === "tr-rect");
    return { elX: el.x, elFill: el.fill };
  });
  ok(atBase.elX === 40 && atBase.elFill === "#d95f02", "…and beat 0 shows the base (the t1 view is one beat-click away)");
  await page.evaluate(() => window.__flux.slide.activeBeat.set(1));
  await sleep(200);

  // --- chained: the later track's t1 edits the UPSTREAM track --------------------
  const chained = await page.evaluate(() => {
    const f = window.__flux;
    const sid = f.get(f.fig.activeFigureId);
    let secondId = "";
    f.slide.commitDeckLive((d) => {
      const b = f.slideOps.addBeat(d, sid, { label: "chain" });
      const t = f.slideOps.setTransform(d, sid, b.id, "tr-rect", { state: { y: 220 } });
      secondId = t?.id ?? "";
    });
    const first = f.get(f.slide.deckOverlay).slides.find((s) => s.id === sid).beats.flatMap((b) => b.tracks).find((tk) => tk.preset === "transform");
    return { secondId, firstId: first?.id };
  });
  await page.evaluate((secondId) => {
    window.__flux.slide.enterEndpointEdit([secondId], "t1");
  }, chained.secondId);
  await sleep(200);
  const t1Chain = await page.evaluate(() => {
    const f = window.__flux;
    const ee = f.get(f.slide.endpointEdit);
    const sid = f.get(f.fig.activeFigureId);
    const el = f.get(f.fig.project).figures.find((x) => x.id === sid).elements.find((e) => e.id === "tr-rect");
    return { entryTrack: ee?.entries?.[0]?.trackId, end: ee?.end, elX: el.x };
  });
  ok(t1Chain.entryTrack === chained.firstId, "a chained track's t1 handle checks out the UPSTREAM track");
  ok(t1Chain.elX === 300, "…showing the upstream end state (t1 of the chain = end of beat 1)");
  await page.evaluate(() => {
    const f = window.__flux;
    const sid = f.get(f.fig.activeFigureId);
    f.fig.commit((p) => {
      const el = p.figures.find((x) => x.id === sid).elements.find((e) => e.id === "tr-rect");
      el.x = 260;
    });
  });
  await sleep(150);
  const upstream = await page.evaluate(() => {
    const f = window.__flux;
    const sid = f.get(f.fig.activeFigureId);
    const o = f.get(f.slide.deckOverlay);
    const s = o.slides.find((x) => x.id === sid);
    const all = s.beats.flatMap((b, bi) => b.tracks.map((t) => ({ bi, id: t.id, state: t.to?.state })));
    return all.filter((t) => t.state);
  });
  const firstAfter = upstream.find((t) => t.id === chained.firstId);
  const secondAfter = upstream.find((t) => t.id === chained.secondId);
  ok(firstAfter?.state?.x === 260, `the t1 edit routed into the UPSTREAM track's state (x=${firstAfter?.state?.x})`);
  ok(secondAfter?.state?.x === undefined && secondAfter?.state?.y === 220, "…and the downstream track's own patch is untouched");
  await page.keyboard.press("Escape");

  // --- PRESENT on a transform deck (the $state.raw regression lock) --------------
  // The deckbar Present button hands the composed deck to the overlay; a deep
  // $state proxy there kills createPlayer inside the transform pre-state fold
  // (structuredClone(proxy) → DataCloneError) and Present freezes with every
  // key/click dead. This section presents THIS transform deck for real:
  // player alive, keyboard advance lands t2 with true mid-flight frames,
  // chain composes, click-prev works, and launching mid-checkout exits it.
  await page.evaluate(() => {
    const f = window.__flux;
    const o = f.get(f.slide.deckOverlay);
    const sid = f.get(f.fig.activeFigureId);
    const t = o.slides.find((x) => x.id === sid).beats.flatMap((b) => b.tracks).find((tk) => tk.preset === "transform");
    f.slide.enterEndpointEdit([t.id], "t2"); // present must exit this cleanly
  });
  await sleep(200);
  await page.evaluate(() => {
    [...document.querySelectorAll(".deckbar button")].find((b) => /Present/.test(b.textContent || ""))?.click();
  });
  await waitFor(page, () => !!document.querySelector(".present .mount [data-el-id]"), null, { timeout: 8000, label: "present mounted" });
  const pr0 = await page.evaluate(() => {
    const f = window.__flux;
    const wrap = document.querySelector('.present .mount [data-el-id="tr-rect"]');
    return { checkout: !!f.get(f.slide.endpointEdit), left: wrap?.style.left ?? null };
  });
  ok(!pr0.checkout, "launching Present exits an active endpoint checkout");
  ok(pr0.left === "40px", `the present stage rests at the BASE state (left ${pr0.left})`);
  // collect mid-flight frames, then advance the transform beat with a REAL key
  // mid-flight the layout box is FROZEN and motion rides the composite
  // transform (the glide fix) — effective x = left + translate-x
  await page.evaluate(`(() => {
    window.__plefts = [];
    var w = document.querySelector('.present .mount [data-el-id="tr-rect"]');
    var collect = function () {
      var m = w ? /translate\\(([-0-9.]+)px/.exec(w.style.transform || "") : null;
      window.__plefts.push(w ? (parseFloat(w.style.left) || 0) + (m ? parseFloat(m[1]) : 0) : NaN);
      if (window.__plefts.length < 80) requestAnimationFrame(collect);
    };
    requestAnimationFrame(collect);
  })()`);
  await page.keyboard.press("ArrowRight");
  await page.waitForFunction("window.__plefts && window.__plefts.length >= 70", { timeout: 8000 });
  const pr1 = await page.evaluate(() => {
    const w = document.querySelector('.present .mount [data-el-id="tr-rect"]');
    const mids = window.__plefts.filter((v) => Number.isFinite(v) && v > 45 && v < 255);
    const dots = [...document.querySelectorAll(".present .hud .dot")].filter((d) => d.className.includes("on")).length;
    return { left: w?.style.left, mids: mids.length, dots };
  });
  // beat 1's t2 is x=260 — the chained-t1 section above rewrote the upstream patch
  ok(pr1.left === "260px", `keyboard advance PLAYED the transform to t2 (left ${pr1.left})`);
  ok(pr1.mids >= 5, `…through real mid-flight frames (${pr1.mids} samples strictly between the endpoints)`);
  ok(pr1.dots === 2, `…and the HUD advanced (${pr1.dots} dots lit)`);
  await page.keyboard.press("ArrowRight"); // the chained beat (y → 220)
  await sleep(900);
  const pr2 = await page.evaluate(() => document.querySelector('.present .mount [data-el-id="tr-rect"]')?.style.top);
  ok(pr2 === "220px", `the chained transform composed on advance (top ${pr2})`);
  // click-prev (left quarter) steps back a beat
  await page.evaluate(() => {
    const el = document.querySelector(".present");
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: r.left + 8, clientY: r.top + r.height / 2 }));
  });
  await sleep(500);
  const pr3 = await page.evaluate(() => {
    const w = document.querySelector('.present .mount [data-el-id="tr-rect"]');
    return { left: w?.style.left, top: w?.style.top };
  });
  ok(pr3.left === "260px" && pr3.top === "60px", `click-prev rests at the earlier beat's composed state (${pr3.left}/${pr3.top})`);
  await page.keyboard.press("Escape");
  await waitFor(page, () => !document.querySelector(".present"), null, { timeout: 5000, label: "present closed" });
  ok(true, "Esc exits Present back to the editor");

  // --- console clean --------------------------------------------------------------
  const errs = await realErrors(page);
  ok(errs.length === 0, "console is clean", errs.join(" | "));
} finally {
  await browser.close();
}

if (fails) {
  console.log(`\nTRANSFORM GUI: FAIL (${fails})`);
  process.exit(1);
}
console.log("\nTRANSFORM GUI: PASS");
