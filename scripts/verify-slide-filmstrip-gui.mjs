// slide-migration §7.2 item 5 + deck management — the filmstrip over the LIVE
// stores: thumbnails render each slide's resting static state and are
// figureRev-KEYED (editing slide A re-renders only A's thumbnail — asserted
// via the data-renders probe), drag-reorder changes the DECK order (playback
// truth), and the DeckPicker's new/duplicate/switch flows work (re-homes
// verify-slide-deckmgmt-live.mjs's coverage on the new model).
// Run: node scripts/verify-slide-filmstrip-gui.mjs
import { launch, gotoApp, clickMode, sleep, realErrors, APP_URL, waitFor } from "./lib/driver.mjs";

let fails = 0;
const ok = (c, msg, extra = "") => (c ? console.log("  ✓ " + msg) : (fails++, console.log("  ✗ " + msg + (extra ? ` — ${extra}` : ""))));

const { browser, page } = await launch();
try {
  await gotoApp(page, { url: APP_URL + "?fixture=demo", settle: 1800 });
  ok(await clickMode(page, "Slide", { settle: 2600 }), "entered Slide mode");
  await waitFor(page, () => !!window.__flux?.get(window.__flux.slide.deckOverlay), null, { timeout: 15000, label: "deck loaded" });

  // three slides with distinct text
  await page.evaluate(() => {
    const f = window.__flux;
    f.slide.commitDeckLive((d) => {
      const s2 = f.slideOps.addSlide(d, { name: "B", layout: "blank" });
      f.slideOps.addSlideText(d, s2.id, { text: "SLIDE B", x: 40, y: 40, fontSize: 30 });
      const s3 = f.slideOps.addSlide(d, { name: "C", layout: "blank" });
      f.slideOps.addSlideText(d, s3.id, { text: "SLIDE C", x: 40, y: 40, fontSize: 30 });
    });
  });
  // thumbnails render on a 120ms trailing debounce
  await waitFor(page, () => document.querySelectorAll(".filmstrip .thumb").length === 3, null, { timeout: 8000, label: "3 thumbs" });
  await sleep(600);
  const t0 = await page.evaluate(() => {
    const thumbs = [...document.querySelectorAll(".filmstrip .thumb")];
    return {
      n: thumbs.length,
      renders: thumbs.map((t) => Number(t.querySelector(".thumb-stage")?.dataset.renders ?? 0)),
      texts: thumbs.map((t) => (t.querySelector(".thumb-stage")?.textContent ?? "").slice(0, 40)),
    };
  });
  ok(t0.n === 3, `filmstrip shows 3 thumbnails`);
  ok(t0.renders.every((r) => r >= 1), `every thumbnail rendered (${t0.renders.join(",")})`);
  ok(t0.texts[1].includes("SLIDE B") && t0.texts[2].includes("SLIDE C"), "thumbnails render the LIVE slide content (one renderer)");

  // edit slide B only → only B's thumbnail re-renders (figureRev keying)
  await page.evaluate(() => {
    const f = window.__flux;
    const o = f.get(f.slide.deckOverlay);
    const bId = o.slides[1].id;
    f.fig.commit((p) => {
      const fig = p.figures.find((x) => x.id === bId);
      const t = fig.elements.find((e) => e.type === "text");
      t.text = "SLIDE B EDITED";
    });
  });
  await sleep(700); // debounce + render
  const t1 = await page.evaluate(() => {
    const thumbs = [...document.querySelectorAll(".filmstrip .thumb")];
    return {
      renders: thumbs.map((t) => Number(t.querySelector(".thumb-stage")?.dataset.renders ?? 0)),
      textB: (thumbs[1].querySelector(".thumb-stage")?.textContent ?? "").slice(0, 60),
    };
  });
  ok(t1.textB.includes("SLIDE B EDITED"), "the edited slide's thumbnail refreshed with the live content");
  ok(t1.renders[1] === t0.renders[1] + 1, `slide B re-rendered exactly once (${t0.renders[1]}→${t1.renders[1]})`);
  ok(t1.renders[0] === t0.renders[0] && t1.renders[2] === t0.renders[2],
    `slides A + C did NOT re-render (${t0.renders[0]}→${t1.renders[0]}, ${t0.renders[2]}→${t1.renders[2]}) — figureRev keying`);

  // drag-reorder: move thumb C (index 2) before thumb B (index 1)
  await page.evaluate(() => {
    const thumbs = [...document.querySelectorAll(".filmstrip .thumb")];
    const from = thumbs[2];
    const to = thumbs[1];
    const dt = new DataTransfer();
    from.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: dt }));
    to.dispatchEvent(new DragEvent("dragover", { bubbles: true, dataTransfer: dt, cancelable: true }));
    to.dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer: dt, cancelable: true }));
    from.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer: dt }));
  });
  await sleep(500);
  const order = await page.evaluate(() => {
    const f = window.__flux;
    const o = f.get(f.slide.deckOverlay);
    const deck = f.slide.currentDeck();
    return {
      overlay: o.slides.map((s) => s.name),
      composed: deck.slides.map((s) => s.name),
      ui: [...document.querySelectorAll(".filmstrip .thumb .nm")].map((n) => n.textContent),
    };
  });
  ok(JSON.stringify(order.overlay.slice(1)) === JSON.stringify(["C", "B"]), `drag-reorder changed the DECK order (${order.overlay.join("→")})`);
  ok(JSON.stringify(order.overlay) === JSON.stringify(order.composed), "…and the composed deck (playback truth) agrees");

  // deck management: new deck → switch back (save-before-switch keeps edits)
  const beforeDecks = await page.evaluate(() => document.querySelectorAll(".deckpicker .dp-item").length);
  await page.evaluate(() => {
    [...document.querySelectorAll(".deckpicker button")].find((b) => /New deck/.test(b.textContent || ""))?.click();
  });
  await waitFor(page, (n) => document.querySelectorAll(".deckpicker .dp-item").length === n + 1, beforeDecks, { timeout: 10000, label: "new deck row" });
  const deckSwap = await page.evaluate(() => {
    const f = window.__flux;
    return { thumbs: document.querySelectorAll(".filmstrip .thumb").length, id: f.get(f.slide.deckOverlay)?.id };
  });
  ok(deckSwap.thumbs === 1, "new deck created + loaded (1 title slide)");
  await page.evaluate(() => {
    [...document.querySelectorAll(".deckpicker .dp-item")][0]?.click();
  });
  await waitFor(page, () => document.querySelectorAll(".filmstrip .thumb").length === 3, null, { timeout: 10000, label: "back to deck 1" });
  const back = await page.evaluate(() => {
    const f = window.__flux;
    const o = f.get(f.slide.deckOverlay);
    return { names: o.slides.map((s) => s.name), edited: f.slide.currentDeck().slides.some((s) => s.elements.some((e) => e.text === "SLIDE B EDITED")) };
  });
  ok(JSON.stringify(back.names.slice(1)) === JSON.stringify(["C", "B"]), "switching back reloads the first deck (order intact from disk)");
  ok(back.edited, "the edit survived the deck switch (save-before-switch)");

  const errs = realErrors(page);
  ok(errs.length === 0, "console is clean", errs.slice(0, 3).join(" | "));
} finally {
  await browser.close();
}
console.log(fails ? `\nSLIDE FILMSTRIP GUI: FAIL (${fails})` : "\nSLIDE FILMSTRIP GUI: PASS");
process.exit(fails ? 1 : 0);
