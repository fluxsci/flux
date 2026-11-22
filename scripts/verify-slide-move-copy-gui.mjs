// Slides moved or copied to another deck from the filmstrip (owner, 2026-11-22), in the browser over the live stores:
//   * selecting several slides: Shift+click a range from the active slide, Ctrl+click one more or one less, neither
//     changing what the stage shows; a plain click is a selection of one again;
//   * right-click: "Move … to deck… / Copy … to deck…", then the project's other decks; a right-click outside the
//     selection selects that slide first; a whole deck cannot be moved out (a deck keeps one slide);
//   * Copy: the slides arrive in the other deck's file (in order, fresh ids, their text and their deck-owned picture's
//     file), this deck and what the stage shows are untouched, and the deck list's count follows;
//   * Move: the same, and the slides leave this deck as ONE undoable edit.
// The pure half (ids, styles, assets, the native media copier) is verify-slide-copy-between-decks.ts.
// Run (dev server up; FLUX_URL for another port): node scripts/verify-slide-move-copy-gui.mjs
import { launch, gotoApp, clickMode, sleep, realErrors, APP_URL, waitFor } from "./lib/driver.mjs";
import { harness } from "./lib/harness.mjs";

const h = harness("verify-slide-move-copy-gui");
const ROOT = "/demo/myc-growth-paper";
// a 1×1 PNG: a deck-owned picture whose FILE has to be copied with its slide
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const { browser, page } = await launch({ width: 1500, height: 960 });
const errs = realErrors(page);
try {
  await gotoApp(page, { url: APP_URL + "?fixture=demo", settle: 1800 });
  h.ok(await clickMode(page, "Slide", { settle: 2600 }), "entered Slide mode");
  await waitFor(page, () => !!window.__flux?.get(window.__flux.slide.deckOverlay), null, { timeout: 15000, label: "deck loaded" });

  const thumbs = () => page.evaluate(() => [...document.querySelectorAll(".filmstrip .thumb")].map((t) => ({
    name: t.querySelector(".nm")?.textContent ?? "", active: t.classList.contains("active"), sel: t.classList.contains("sel"),
  })));
  const selected = async () => (await thumbs()).filter((t) => t.active || t.sel).map((t) => t.name).join(",");
  const activeName = async () => (await thumbs()).find((t) => t.active)?.name ?? "";
  const thumbPoint = (name) => page.evaluate((name) => {
    const t = [...document.querySelectorAll(".filmstrip .thumb")].find((x) => x.querySelector(".nm")?.textContent === name);
    t.scrollIntoView({ block: "nearest" });
    const r = t.querySelector(".mini").getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, name);
  const click = async (name, mods = []) => {
    const p = await thumbPoint(name);
    for (const m of mods) await page.keyboard.down(m);
    await page.mouse.click(p.x, p.y);
    for (const m of mods) await page.keyboard.up(m);
    await sleep(120);
  };
  const rightClick = async (name) => { const p = await thumbPoint(name); await page.mouse.click(p.x, p.y, { button: "right" }); await sleep(150); };
  const menu = () => page.evaluate(() => [...document.querySelectorAll('.menu[role="menu"] button')].map((b) => ({
    label: b.childNodes[0]?.textContent?.trim() ?? "", hint: b.querySelector("small")?.textContent ?? "", disabled: b.disabled,
  })));
  const pick = async (startsWith) => {
    await page.evaluate((startsWith) => [...document.querySelectorAll('.menu[role="menu"] button')].find((b) => !b.disabled && b.textContent.trim().startsWith(startsWith)).click(), startsWith);
    await sleep(200);
  };
  const deckFile = (id) => page.evaluate(async (root, id) => JSON.parse(await window.fig.readText(`${root}/slides/${id}/deck.json`)), ROOT, id);
  const deckRows = () => page.evaluate(() => [...document.querySelectorAll(".deckpicker .dp-item")].map((b) => ({
    title: b.querySelector(".dp-title")?.textContent ?? "", count: Number(b.querySelector(".dp-count")?.textContent ?? -1), active: b.classList.contains("active"),
  })));
  const toastSaid = (text) => waitFor(page, (text) => window.__flux.get(window.__flux.toast.toasts).some((t) => t.msg.includes(text)), text, { timeout: 15000, label: `toast "${text}"` });
  const errorToasts = () => page.evaluate(() => window.__flux.get(window.__flux.toast.toasts).filter((t) => t.level === "error").map((t) => `${t.msg} ${t.detail ?? ""}`));

  // --- this deck: A (as it came), B (text + a deck-owned picture + an effect), C, D -------------------------------
  const homeId = await page.evaluate(() => window.__flux.get(window.__flux.slide.deckOverlay).id);
  const firstName = (await thumbs())[0].name;
  await page.evaluate(() => {
    const f = window.__flux;
    f.slide.commitDeckLive((d) => {
      for (const name of ["B", "C", "D"]) {
        const s = f.slideOps.addSlide(d, { name, layout: "blank" });
        f.slideOps.addSlideText(d, s.id, { text: `SLIDE ${name}`, x: 40, y: 40, fontSize: 30 });
      }
      const b = d.slides.find((s) => s.name === "B");
      const beat = f.slideOps.addBeat(d, b.id, { label: "build" });
      f.slideOps.setAnimation(d, b.id, beat.id, { target: b.elements[0].id, preset: "fade" });
    });
  });
  await waitFor(page, () => document.querySelectorAll(".filmstrip .thumb").length >= 4, null, { timeout: 8000, label: "the new slides' thumbnails" });
  await click("B");
  const bId = await page.evaluate(() => window.__flux.get(window.__flux.fig.activeFigureId));
  await page.evaluate(async (b64, slideId) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    await window.__flux.io.importDroppedFiles([new File([bytes], "dot.png", { type: "image/png" })], slideId, { x: 300, y: 120 });
  }, PNG, bId);
  await waitFor(page, () => window.__flux.slide.currentDeck()?.assets.some((a) => a.kind === "png"), null, { timeout: 8000, label: "the picture is a deck asset" });
  const picture = await page.evaluate(() => window.__flux.slide.currentDeck().assets.find((a) => a.kind === "png"));

  // a second deck to send slides to ("+ New deck" opens it; come back)
  await page.evaluate(() => document.querySelector(".deckpicker .dp-new").click());
  await waitFor(page, (homeId) => { const o = window.__flux.get(window.__flux.slide.deckOverlay); return !!o && o.id !== homeId; }, homeId, { timeout: 15000, label: "the new deck opens" });
  const otherId = await page.evaluate(() => window.__flux.get(window.__flux.slide.deckOverlay).id);
  const otherTitle = (await deckRows()).find((d) => d.active).title;
  await page.evaluate(() => [...document.querySelectorAll(".deckpicker .dp-item")].find((b) => !b.classList.contains("active")).click());
  await waitFor(page, (homeId) => window.__flux.get(window.__flux.slide.deckOverlay)?.id === homeId && document.querySelectorAll(".filmstrip .thumb").length >= 4, homeId, { timeout: 15000, label: "back in the first deck" });
  const otherBefore = (await deckFile(otherId)).slides.length;
  const homeCount = (await thumbs()).length;

  h.section("selecting several slides");
  await click("B");
  h.eq(await selected(), "B", "a plain click selects one slide");
  await click("D", ["Shift"]);
  h.eq(await selected(), "B,C,D", "Shift+click selects the range from the active slide");
  h.eq(await activeName(), "B", "and the stage still shows the slide it showed");
  await click("C", ["Control"]);
  h.eq(await selected(), "B,D", "Ctrl+click takes one slide out");
  await click("C", ["Control"]);
  h.eq(await selected(), "B,C,D", "and puts it back");
  await click(firstName, ["Shift"]);
  h.eq(await selected(), `${firstName},B`, "Shift+click the other way selects that range instead");
  await click("D", ["Shift"]);

  h.section("right-click: Move to / Copy to, then a deck");
  await rightClick("C");
  let items = await menu();
  h.eq(items.map((i) => i.label).join(" | "), "Move 3 slides to deck… | Copy 3 slides to deck…", "a right-click inside the selection offers both for all of it");
  h.ok(items.every((i) => !i.disabled), "both are available (there is another deck, and one slide stays)");
  h.eq(await selected(), "B,C,D", "the selection is unchanged by the right-click");
  await pick("Copy");
  items = await menu();
  h.eq(items[0]?.label, "Copy 3 slides to", "choosing one shows where to: the deck list");
  const homeTitle = (await deckRows()).find((d) => d.active)?.title ?? "";
  h.ok(items.some((i) => i.label === otherTitle && /slide/.test(i.hint)) && !items.some((i) => i.label === homeTitle), "it lists the other deck with its slide count, and not this one");
  await pick(otherTitle);
  await toastSaid(`Copied 3 slides to “${otherTitle}”`);
  h.eq((await errorToasts()).join(" / "), "", "no error was reported");

  h.section("Copy: the slides are in the other deck's file");
  const copied = await deckFile(otherId);
  h.eq(copied.slides.length, otherBefore + 3, "three slides were added");
  const arrived = copied.slides.slice(-3);
  h.eq(arrived.map((s) => s.name).join(","), "B,C,D", "at the end, in this deck's order");
  h.eq(arrived.map((s) => s.elements.find((e) => e.type === "text")?.text).join(","), "SLIDE B,SLIDE C,SLIDE D", "with their content");
  const home = await page.evaluate(() => window.__flux.slide.currentDeck());
  h.ok(arrived.every((s) => !home.slides.some((x) => x.id === s.id)), "under fresh slide ids");
  const cb = arrived[0], track = cb.beats[1]?.tracks[0];
  h.ok(!!track && cb.elements.some((e) => e.id === track.target) && !home.slides.some((s) => s.elements.some((e) => e.id === track.target)), "the effect travelled and targets the COPY's element");
  h.ok(copied.assets.some((a) => a.id === picture.id && a.path === picture.path), "the deck-owned picture is registered in the other deck");
  h.ok(await page.evaluate(async (root, id, p) => (await window.fig.exists(`${root}/slides/${id}/${p}`)) && (await window.fig.readFile(`${root}/slides/${id}/${p}`)).byteLength > 0, ROOT, otherId, picture.path), "and its file was copied there");
  h.eq((await thumbs()).length, homeCount, "this deck keeps all its slides");
  h.eq(await activeName(), "B", "and the stage is still on the same slide");
  h.eq((await deckRows()).find((d) => d.title === otherTitle)?.count, otherBefore + 3, "the deck list shows the other deck's new count");

  h.section("right-click outside the selection");
  await rightClick(firstName);
  h.eq(await selected(), firstName, "selects that slide alone");
  h.eq((await menu())[0]?.label, "Move slide to deck…", "and the menu is about that one slide");
  await page.keyboard.press("Escape");
  await sleep(150);
  h.eq((await menu()).length, 0, "Escape closes the menu");
  h.eq((await thumbs()).length, homeCount, "and nothing happened");

  h.section("Move");
  await click("B");
  await click("C", ["Shift"]);
  await rightClick("B");
  await pick("Move");
  h.eq((await menu())[0]?.label, "Move 2 slides to", "Move asks where to as well");
  await pick(otherTitle);
  await toastSaid(`Moved 2 slides to “${otherTitle}”`);
  h.eq((await errorToasts()).join(" / "), "", "no error was reported");
  h.eq((await thumbs()).map((t) => t.name).join(","), `${firstName},D`, "the two slides left this deck");
  h.ok((await thumbs()).filter((t) => t.active).length === 1, "one of the slides that stayed is on the stage");
  const moved = await deckFile(otherId);
  h.eq(moved.slides.slice(-2).map((s) => s.name).join(","), "B_a,C_a", "and are in the other deck (names already used there get the next suffix)");
  h.eq(moved.assets.filter((a) => a.id === picture.id).length, 1, "the picture it already held is not registered twice");
  await page.keyboard.down("Control"); await page.keyboard.press("KeyZ"); await page.keyboard.up("Control");
  await waitFor(page, (n) => document.querySelectorAll(".filmstrip .thumb").length === n, homeCount, { timeout: 8000, label: "undo brings the slides back" });
  h.eq((await thumbs()).map((t) => t.name).join(","), `${firstName},B,C,D`, "one Undo puts both slides back in this deck, in place");

  h.section("a whole deck cannot be moved out");
  await click(firstName);
  await click("D", ["Shift"]);
  await rightClick("C");
  items = await menu();
  h.ok(items[0].disabled && /at least one slide/.test(items[0].hint), "Move is unavailable and says why");
  h.ok(!items[1].disabled, "Copy still is");
  await page.keyboard.press("Escape");

  h.section("the other deck opens with them");
  await page.evaluate((title) => [...document.querySelectorAll(".deckpicker .dp-item")].find((b) => b.querySelector(".dp-title").textContent === title).click(), otherTitle);
  await waitFor(page, (id) => window.__flux.get(window.__flux.slide.deckOverlay)?.id === id, otherId, { timeout: 15000, label: "the other deck opens" });
  await waitFor(page, (n) => document.querySelectorAll(".filmstrip .thumb").length === n, otherBefore + 5, { timeout: 8000, label: "its thumbnails" });
  await sleep(700);
  const texts = await page.evaluate(() => [...document.querySelectorAll(".filmstrip .thumb .thumb-stage")].map((t) => (t.textContent ?? "").trim().slice(0, 12)));
  h.ok(texts.filter((t) => t.startsWith("SLIDE B")).length === 2 && texts.some((t) => t.startsWith("SLIDE D")), `its filmstrip draws the slides that arrived (${texts.join(" · ")})`);
  h.eq(await selected(), (await thumbs()).find((t) => t.active)?.name ?? "", "the selection did not follow into the other deck");

  h.eq(errs.length, 0, `console stays clean${errs.length ? `: ${errs.slice(0, 3).join(" | ")}` : ""}`);
} finally {
  await browser.close();
}
await h.done();
