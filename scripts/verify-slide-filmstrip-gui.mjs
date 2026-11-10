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

  // plot generations are keyed too: (re)caching a plot re-renders only the thumbnails
  // whose slide names it. 2026-10-23: any cachePlot re-rendered the whole filmstrip
  // back to back on timers — 100+ ms with no frame, landing on a just-started hand-off.
  const svg = (fill) => `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="80" viewBox="0 0 100 80"><rect id="r" width="50" height="40" fill="${fill}"/></svg>`;
  const thumbRenders = () => page.evaluate(() => [...document.querySelectorAll(".filmstrip .thumb")].map((t) => Number(t.querySelector(".thumb-stage")?.dataset.renders ?? 0)));
  await page.evaluate((a) => {
    const f = window.__flux;
    f.plot.cachePlot("filmstrip-used", a);
    f.slide.commitDeckLive((d) => {
      f.slideOps.addElement(d, d.slides[2].id, { id: "filmstrip-plot", type: "plot", assetId: "filmstrip-used", x: 200, y: 200, width: 200, height: 160, rotation: 0 });
    });
  }, svg("#4385be"));
  await sleep(700);
  const t2 = await thumbRenders();
  await page.evaluate((a) => window.__flux.plot.cachePlot("filmstrip-unused", a), svg("#d14d41"));
  await sleep(700);
  const t3 = await thumbRenders();
  ok(JSON.stringify(t3) === JSON.stringify(t2), `caching a plot no slide uses re-rendered no thumbnail (${t2.join(",")} → ${t3.join(",")})`);
  await page.evaluate((a) => window.__flux.plot.cachePlot("filmstrip-used", a), svg("#879a39"));
  await sleep(700);
  const t4 = await thumbRenders();
  ok(t4[2] === t3[2] + 1 && t4[0] === t3[0] && t4[1] === t3[1], `re-caching slide C's plot re-rendered only C (${t3.join(",")} → ${t4.join(",")})`);

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

  // Rename a deck where its name is listed: double-click, type, Enter (the Figure sidebar's canvas rename).
  const deckRow = (i) => page.evaluate((i) => { const b = [...document.querySelectorAll(".deckpicker li")][i]?.querySelector(".dp-item"); if (!b) return null; const r = b.querySelector(".dp-title").getBoundingClientRect(); return { x: r.left + Math.min(20, r.width / 2), y: r.top + r.height / 2 }; }, i);
  const deckState = () => page.evaluate(() => { const f = window.__flux, o = f.get(f.slide.deckOverlay); return { id: o?.id, title: o?.title, rows: [...document.querySelectorAll(".deckpicker li")].map((li) => li.querySelector(".dp-title")?.textContent ?? "(editing)"), field: document.querySelector(".deckbar input.title")?.value, input: document.activeElement?.classList.contains("dp-rename") ? document.activeElement.value : null }; });
  const before = await deckState();
  let at = await deckRow(0);
  await page.mouse.click(at.x, at.y, { count: 2 });
  await waitFor(page, () => document.activeElement?.classList.contains("dp-rename"), null, { timeout: 5000, label: "rename field" });
  ok((await deckState()).input === before.title, "double-clicking a deck's name edits it in place, the name selected", JSON.stringify(await deckState()));
  await page.keyboard.type("Renamed A");
  await page.keyboard.press("Escape");
  ok((await deckState()).title === before.title && !(await page.$(".dp-rename")), "Esc leaves the name as it was");
  await page.mouse.click(at.x, at.y, { count: 2 });
  await waitFor(page, () => document.activeElement?.classList.contains("dp-rename"), null, { timeout: 5000, label: "rename field again" });
  await page.keyboard.type("Renamed A");
  await page.keyboard.press("Enter");
  await waitFor(page, () => { const f = window.__flux; return f.get(f.slide.deckOverlay)?.title === "Renamed A"; }, null, { timeout: 5000, label: "deck renamed" });
  let st = await deckState();
  ok(st.rows[0] === "Renamed A" && st.field === "Renamed A" && st.id === before.id, "Enter renames the open deck: its row and the title field say so at once", JSON.stringify(st));
  // a deck that is NOT open: the double-click opens it (as a click does) and renames it
  at = await deckRow(1);
  await page.mouse.click(at.x, at.y, { count: 2 });
  await waitFor(page, () => document.activeElement?.classList.contains("dp-rename"), null, { timeout: 5000, label: "rename field, other deck" });
  await page.keyboard.type("Renamed B");
  await page.keyboard.press("Enter");
  await waitFor(page, (id) => { const f = window.__flux, o = f.get(f.slide.deckOverlay); return o?.id !== id && o?.title === "Renamed B"; }, before.id, { timeout: 10000, label: "other deck renamed" });
  await waitFor(page, () => { const rows = [...document.querySelectorAll(".deckpicker .dp-title")].map((n) => n.textContent); return rows[0] === "Renamed A" && rows[1] === "Renamed B"; }, null, { timeout: 10000, label: "both names listed" });
  st = await deckState();
  ok(st.title === "Renamed B" && st.id !== before.id, "double-clicking another deck's name opens that deck and renames it", JSON.stringify(st));
  ok(st.rows[0] === "Renamed A", "the first deck kept its new name on disk (the list is read back after the save)");
  // ... and it is one undoable edit of the deck
  await page.evaluate(() => window.__flux.fig.undo());
  await waitFor(page, () => { const f = window.__flux; return f.get(f.slide.deckOverlay)?.title !== "Renamed B"; }, null, { timeout: 5000, label: "undo" });
  ok(true, "Ctrl+Z takes the rename back");

  const errs = realErrors(page);
  ok(errs.length === 0, "console is clean", errs.slice(0, 3).join(" | "));
} finally {
  await browser.close();
}
console.log(fails ? `\nSLIDE FILMSTRIP GUI: FAIL (${fails})` : "\nSLIDE FILMSTRIP GUI: PASS");
process.exit(fails ? 1 : 0);
