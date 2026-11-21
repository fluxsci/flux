// Cascade popover (Ctrl+Shift+C) — GUI wiring over ops.cascadeElements:
//  - the chord opens the popover on a ≥2-unit selection; the owner's sketch
//    example (rotation +25, first NOT fixed) live-previews 25/50/75/100;
//  - the whole tuning session is ONE undo entry (Enter keeps it, one undo
//    reverts everything);
//  - Esc rolls the session back and leaves NO history entry;
//  - the Order dropdown re-ranks (Left→right) and First-stays-fixed pins
//    rank 0;
//  - a color ramp on fill steps hue per rank;
//  - the "n of m apply" header reflects per-type applicability (width on a
//    selection containing a path);
//  - clicking outside the popover applies (Enter semantics), never abandons.
//
// THE LOOK (2026-11-20; the owner: "redesign it so it fits the same style of all of the other flux components
// we've been redesigning"): the property menu's sibling, asserted here on computed styles. Its plate and card,
// one line per thing, paper keys for what is on or off, one lit key (Apply), one hint line, and the ladder
// that writes out what each unit gets. Nothing blurs, nothing animates (it does not even fade in), and it
// stands where it stood. It is built from as few elements as the pop-up it replaced: a first version with a
// wrapper per control, the Flux mark and a fade cost a quarter more per open (production bundles, old and new
// alternating), so an element count is pinned here too.
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
  await clickMode(page, "Figure");
  await waitFor(page, () => !!(window.__flux?.fig && window.__flux.figures().length && document.querySelector(".canvas-host")), null, {
    timeout: 15000,
    label: "figure mode ready",
  });

  // Seed: 4 rects whose SELECTION order (r1..r4) differs from x order
  // (r2,r4,r1,r3), plus one path (width-ineligible) left unselected for now.
  await page.evaluate(() => {
    const F = window.__flux.fig;
    const rect = (id, x) => ({
      type: "rect", id, x, y: 120, width: 40, height: 160, rotation: 0,
      fill: "#ff0000", stroke: "#334455", strokeWidth: 2, cornerRadius: 0,
    });
    F.commit((p) => {
      const g = p.figures[0];
      g.x = 0; g.y = 0; g.width = 900; g.height = 700;
      g.elements = [
        rect("r1", 200), rect("r2", 100), rect("r3", 250), rect("r4", 150),
        { type: "path", id: "pth", x: 400, y: 120, width: 80, height: 80, rotation: 0,
          d: "M 0 0 L 80 80", fill: "none", stroke: "#000000", strokeWidth: 2, closed: false },
      ];
    });
    F.selection.set(new Set(["r1", "r2", "r3", "r4"]));
    F.viewport.set({ panX: 40, panY: 40, zoom: 0.9 });
  });
  const past = () => page.evaluate(() => window.__flux.fig.historyStats().past);
  const rots = () => page.evaluate(() => ["r1", "r2", "r3", "r4"].map((id) => window.__flux.figures()[0].elements.find((e) => e.id === id).rotation));
  const xs = () => page.evaluate(() => ["r1", "r2", "r3", "r4"].map((id) => window.__flux.figures()[0].elements.find((e) => e.id === id).x));
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
  const popOpen = () => page.evaluate(() => !!document.querySelector(".cascade-pop"));
  const rungs = () => page.evaluate(() => document.querySelector(".cascade-pop .ladder").textContent.trim().replace(/\s+/g, " "));
  const look = () => page.evaluate(() => {
    const q = (s) => document.querySelector(".cascade-pop " + s), cs = (n, pseudo) => getComputedStyle(n, pseudo), box = (n) => { const r = n.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, r: r.right, b: r.bottom }; };
    const said = (n, pseudo) => cs(n, pseudo).content.replace(/^"|"$/g, "");
    const pop = document.querySelector(".cascade-pop"), host = pop.offsetParent ?? document.body, p = cs(pop);
    const all = [pop, ...pop.querySelectorAll("*")];
    return {
      pop: box(pop), host: box(host), bg: p.backgroundColor, radius: p.borderTopLeftRadius, nodes: all.length - pop.querySelectorAll("option").length,
      filters: all.filter((n) => cs(n).backdropFilter !== "none" || cs(n).filter !== "none").length, images: pop.querySelectorAll("img, svg").length,
      card: { bg: cs(q(".card")).backgroundColor, radius: cs(q(".card")).borderTopLeftRadius },
      rows: [...pop.querySelectorAll(".row, .ladder")].map((r) => Math.round(box(r).h)),
      labels: [...[...pop.querySelectorAll(".row > .lb")].map((l) => l.textContent.trim()), said(q(".ladder"), "::before")], labelFont: cs(q(".row > .lb")).fontFamily,
      num: { font: cs(q("input.delta")).fontFamily, align: cs(q("input.delta")).textAlign, border: cs(q("input.delta")).borderTopWidth, h: Math.round(box(q("input.delta")).h), lead: said(q("input.delta").parentElement, "::before") },
      unit: q("input.delta").parentElement.dataset.unit ? said(q("input.delta").parentElement, "::after") : null,
      sel: { appearance: cs(q("select.prop")).appearance, border: cs(q("select.prop")).borderTopWidth, h: Math.round(box(q("select.prop")).h), arrow: cs(q("select.prop")).backgroundImage.includes("linear-gradient") },
      modeOn: [...pop.querySelectorAll(".mode button")].map((b) => [b.classList.contains("on"), cs(b).backgroundColor]),
      keys: [...pop.querySelectorAll("label.chk input")].map((k) => ({ says: said(k, "::after"), on: k.checked, bg: cs(k).backgroundColor, h: Math.round(box(k).h), appearance: cs(k).appearance, name: k.getAttribute("aria-label") })),
      prime: { bg: cs(q(".prime")).backgroundColor, says: q(".prime").textContent.replace(/\s+/g, " ").trim() }, ghost: { bg: cs(q(".ghost")).backgroundColor, says: q(".ghost").textContent.replace(/\s+/g, " ").trim() },
      hint: said(q(".ftr"), "::before"), hintRoom: box(q(".ghost")).x - box(q(".ftr")).x,
      n: { says: q(".n").textContent.replace(/\s+/g, " ").trim(), color: cs(q(".n")).color, font: cs(q(".n")).fontFamily },
      title: q(".ttl").textContent.trim(), titleFont: cs(q(".ttl")).fontFamily,
      overflowing: all.filter((n) => n.scrollWidth > n.clientWidth + 1 && !n.matches("select, input")).map((n) => n.className).join(","),
      anims: document.getAnimations().filter((a) => pop.contains(a.effect?.target)).length,
    };
  });
  const lum = (rgb) => { const m = rgb.match(/[\d.]+/g).map(Number); return (0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]) / 255; };
  const isBlue = (rgb) => { const m = rgb.match(/[\d.]+/g).map(Number); return m[2] > m[0] + 40 && m[2] > m[1]; };

  // ---- 1. the owner's sketch: rotation +25, first NOT fixed --------------------
  const past0 = await past();
  await chord();
  await waitFor(page, () => !!document.querySelector(".cascade-pop"), null, { label: "chord opens the popover" });
  await page.select(".cascade-pop select.prop", "rotation");
  assert((await rungs()) === "0 0 0 0", `before a step is set the ladder is still (${await rungs()})`);
  await setNum(".cascade-pop input.delta", 25);
  await waitFor(page, () => window.__flux.figures()[0].elements.find((e) => e.id === "r4")?.rotation === 100, null, {
    label: "live preview applied",
  });
  assert(JSON.stringify(await rots()) === JSON.stringify([25, 50, 75, 100]), `rotation +25 live-previews 25/50/75/100 (got ${await rots()})`);
  assert((await past()) === past0 + 1, "the tuning session is ONE history entry");
  await shot(page, "cascade-preview");

  // ---- 1b. the look: the property menu's sibling -------------------------------
  await new Promise((r) => setTimeout(r, 260));
  {
    const L = await look();
    assert(lum(L.bg) < 0.08 && L.radius === "12px" && lum(L.card.bg) < 0.16 && lum(L.card.bg) > lum(L.bg) && L.card.radius === "8px", `a dark plate with a card set into it (${L.bg} / ${L.card.bg}, ${L.radius} / ${L.card.radius})`);
    assert(L.filters === 0 && L.anims === 0 && L.images === 0, `nothing blurs or filters, nothing animates, and it holds no image (${L.filters} filters, ${L.anims} animations, ${L.images} images)`);
    assert(L.nodes <= 31, `it is built from as few elements as the pop-up it replaced (${L.nodes} besides the lists' options; the old one had 30)`);
    assert(Math.abs(L.pop.y - L.host.y - 16) <= 1 && Math.abs(L.pop.x + L.pop.w / 2 - (L.host.x + L.host.w / 2)) <= 1 && L.pop.w === 348, `it stands where it stood: 16 px under the top of its pane, centred (${L.pop.w} px wide)`);
    assert(L.rows.length === 4 && L.rows.every((h) => h >= 24 && h <= 28) && L.labels.join("|") === "property|each step|order|gives", `one line per thing: ${L.labels.join(", ")} (${L.rows.join("/")} px)`);
    assert(/serif|Georgia|Newsreader|Source Serif|Literata/i.test(L.labelFont + L.titleFont) && L.title === "Cascade", "the tool's name and its words in the menu's serif");
    assert(/mono/i.test(L.num.font) && L.num.align === "right" && L.num.border === "0px" && L.num.h <= 20 && L.num.lead === "Δ", `a number is mono, right-aligned, without a border, led by what it is (${L.num.lead}, ${L.num.h} px)`);
    assert(L.unit === "°", `the value wears its property's unit (${L.unit})`);
    assert(L.sel.appearance === "none" && L.sel.border === "0px" && L.sel.h === 20 && L.sel.arrow, "a choice wears the menu's face, with a drawn arrow (the list stays the system's)");
    assert(L.modeOn.length === 2 && L.modeOn[0][0] && !L.modeOn[1][0] && isBlue(L.modeOn[0][1]) && lum(L.modeOn[1][1]) > 0.85, "add | multiply are two keys of one switch: the one in force is lit, the other is paper");
    assert(L.keys.length === 2 && L.keys.map((k) => k.says).join("|") === "reverse|first stays" && L.keys.map((k) => k.name).join("|") === "Reverse|First stays fixed" && L.keys.every((k) => !k.on && lum(k.bg) > 0.85 && k.h === 20 && k.appearance === "none"), "reverse and first stays are paper keys: each IS its checkbox, drawn as a key and named for a reader");
    assert(isBlue(L.prime.bg) && /^Apply/.test(L.prime.says) && /^Cancel/.test(L.ghost.says) && L.ghost.bg === "rgba(0, 0, 0, 0)", "ONE lit key (Apply); Cancel is quiet");
    assert((await rungs()) === "+25 +50 +75 +100" && L.hint === "live · one undo step" && L.hintRoom >= 150, `the ladder writes out what each unit gets (${await rungs()}); the hint line has its room (${Math.round(L.hintRoom)} px)`);
    assert(L.n.says === "4 units" && /mono/i.test(L.n.font) && L.overflowing === "", `the head counts what it works on; nothing is cut (${L.overflowing || "none"})`);
  }
  await page.keyboard.press("Enter");
  await waitFor(page, () => !document.querySelector(".cascade-pop"), null, { label: "Enter closes the popover" });
  assert(JSON.stringify(await rots()) === JSON.stringify([25, 50, 75, 100]), "Enter keeps the cascaded values");
  assert((await past()) === past0 + 1, "…still exactly one entry after apply");
  await page.evaluate(() => window.__flux.fig.undo());
  assert(JSON.stringify(await rots()) === JSON.stringify([0, 0, 0, 0]), "ONE undo reverts the whole cascade");

  // ---- 2. Esc rolls back and burns no entry -------------------------------------
  const past1 = await past();
  await chord();
  await waitFor(page, () => !!document.querySelector(".cascade-pop"), null, { label: "reopened for the Esc path" });
  await page.select(".cascade-pop select.prop", "rotation");
  await setNum(".cascade-pop input.delta", 25);
  await waitFor(page, () => window.__flux.figures()[0].elements.find((e) => e.id === "r1")?.rotation === 25, null, {
    label: "Esc-path preview applied",
  });
  await page.keyboard.press("Escape");
  await waitFor(page, () => !document.querySelector(".cascade-pop"), null, { label: "Esc closes the popover" });
  assert(JSON.stringify(await rots()) === JSON.stringify([0, 0, 0, 0]), "Esc reverts the preview");
  assert((await past()) === past1, "Esc leaves NO history entry");

  // ---- 3. order override (Left→right) + first stays fixed ------------------------
  await chord();
  await waitFor(page, () => !!document.querySelector(".cascade-pop"), null, { label: "reopened for the order test" });
  await page.select(".cascade-pop select.prop", "x"); // the popover retains the last-used property
  await page.click(".cascade-pop label.ff input");
  await page.select(".cascade-pop select.ord", "x");
  await setNum(".cascade-pop input.delta", 30);
  await waitFor(page, () => window.__flux.figures()[0].elements.find((e) => e.id === "r3")?.x === 340, null, {
    label: "x-order preview applied",
  });
  assert(JSON.stringify(await xs()) === JSON.stringify([260, 100, 340, 180]), `Left→right + first-fixed ranks by position (got ${await xs()})`);
  {
    // (The pointer is still on the key it pressed, and a hovered key's colour is a mix reported in oklab: read it at rest.)
    await page.mouse.move(6, 6);
    await new Promise((r) => setTimeout(r, 160));
    const L = await look();
    assert(L.keys[1].on && isBlue(L.keys[1].bg) && !L.keys[0].on && (await rungs()) === "0 +30 +60 +90", `first stays: its key is lit and the ladder's first rung is 0 (${await rungs()}; ${L.keys[1].bg})`);
    assert(L.unit === null, "a position has no unit to wear");
  }
  await page.keyboard.press("Escape");

  // ---- 4. color ramp on fill -------------------------------------------------------
  await chord();
  await waitFor(page, () => !!document.querySelector(".cascade-pop"), null, { label: "reopened for the color test" });
  await page.select(".cascade-pop select.prop", "fill");
  await waitFor(page, () => !!document.querySelector(".cascade-pop input.dh"), null, { label: "color deltas shown for a color prop" });
  await setNum(".cascade-pop input.dh", 40);
  await waitFor(page, () => window.__flux.figures()[0].elements.find((e) => e.id === "r1")?.fill !== "#ff0000", null, {
    label: "hue ramp previewed",
  });
  const fills = await page.evaluate(() => ["r1", "r2", "r3", "r4"].map((id) => window.__flux.figures()[0].elements.find((e) => e.id === id).fill));
  assert(new Set(fills).size === 4, `each rank gets a distinct hue (${fills.join(" ")})`);
  {
    const c = await page.evaluate(() => ({ leads: [...document.querySelectorAll(".cascade-pop .fld")].map((l) => getComputedStyle(l, "::before").content.replace(/"/g, "")).join(" "), mode: !!document.querySelector(".cascade-pop .mode"), rows: [...document.querySelectorAll(".cascade-pop .row")].map((r) => Math.round(r.getBoundingClientRect().height)), wide: document.querySelector(".cascade-pop").getBoundingClientRect().width }));
    assert(c.leads === "L C H°" && !c.mode && c.rows.every((h) => h <= 28) && c.wide === 348 && (await rungs()) === "+40° +80° +120° +160°", `a colour steps in L, C and H° on the same one line (${await rungs()})`);
  }
  await page.keyboard.press("Escape");

  // ---- 5. "n of m apply" with a width-ineligible path ---------------------------------
  await page.evaluate(() => window.__flux.fig.selection.set(new Set(["r1", "r2", "r3", "r4", "pth"])));
  await chord();
  await waitFor(page, () => !!document.querySelector(".cascade-pop"), null, { label: "reopened with the path selected" });
  await page.select(".cascade-pop select.prop", "width");
  const hdr = await page.evaluate(() => document.querySelector(".cascade-pop .n")?.textContent?.replace(/\s+/g, " ").trim());
  assert(/5 units\s*· 4 apply/.test(hdr ?? ""), `header shows the reduced applicability (got "${hdr}")`);
  {
    const L = await look();
    assert(isBlue(L.n.color) && (await rungs()).split(" ").length === 4, "…in the menu's blue, and the ladder has a rung for each unit that takes the property");
  }
  await page.keyboard.press("Escape");
  await page.evaluate(() => window.__flux.fig.selection.set(new Set(["r1", "r2", "r3", "r4"])));

  // ---- 6. outside click = apply-and-close ----------------------------------------------
  const past2 = await past();
  await chord();
  await waitFor(page, () => !!document.querySelector(".cascade-pop"), null, { label: "reopened for the outside-click test" });
  await page.select(".cascade-pop select.prop", "rotation");
  await setNum(".cascade-pop input.delta", 10);
  await waitFor(page, () => window.__flux.figures()[0].elements.find((e) => e.id === "r4")?.rotation === 40, null, {
    label: "outside-click-path preview applied",
  });
  await page.mouse.click(300, 780); // canvas, well below the popover
  await waitFor(page, () => !document.querySelector(".cascade-pop"), null, { label: "outside click closes the popover" });
  assert(JSON.stringify(await rots()) === JSON.stringify([10, 20, 30, 40]), "outside click APPLIES the preview (Enter semantics)");
  assert((await past()) === past2 + 1, "…as one history entry");
  await page.evaluate(() => window.__flux.fig.undo());

  assert(!(await popOpen()), "popover closed at the end");
  const errs = realErrors(page);
  assert(errs.length === 0, `no console errors (${errs.length})`);
  if (errs.length) console.error(errs.slice(0, 5));
  console.log(fails === 0 ? "\nVERIFY-CASCADE-GUI ALL PASS" : `\nVERIFY-CASCADE-GUI ${fails} FAILURE(S)`);
} finally {
  await browser.close();
}
process.exit(fails === 0 ? 0 : 1);
