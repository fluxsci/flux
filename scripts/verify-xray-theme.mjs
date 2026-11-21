// figure-v1 P8 gate (browser) — the X-ray SURFACE, asserted on computed styles.
//
// 2026-11-20: the owner redesigned the look in a click-to-try viewer and picked
//   "X-ray pick: A Light box · glow=soft · keys=one · skeleton lines=on · part icons=on · row=22"
// ("the x-ray I think we can push even further to look like an x-ray … your redesign here looks absolutely
// amazing"). That SUPERSEDES two lines of the 2026-09-15 flat contract this gate used to pin: "no glow" (the
// lead marker, the one bright key and the picked row's rail now glow softly) and the 2 px / 3 px radii (the X-ray is a plate with cards,
// like the image board and the property menu). The part icons of that pick were built three ways, measured,
// and left out (each cost paint or style time at every open; the owner: "icons are not really critical"); the
// eye and the twisty stay the text glyphs they always were. Everything else of the 2026-09-15 contract still
// holds and is still asserted here:
//   · NO backdrop-filter, NO filter, NO gradient field on the panel, NO ::after scanline/vignette layer
//   · mono type on the tree rows; the head's lead marker is uppercase and letterspaced
//   · selection = translucent phosphor tint (never a solid fill); the primary row of a pick carries an inset
//     2px rail and glows softly FROM it, inside the row (blur ≤ 12 px); no row's name is text-shadowed
//   · rows are 22 px; skeleton lines tie a row to its parent as BACKGROUNDS of the row, from one static rule
//     (no element, no image, nothing computed per row); a row with nothing to open carries no empty twisty
//   · the readout is two lines of fixed height; one key is bright (properties), the others glass
//   · one hint line; the key at its end shows and hides the whole legend
//   · nothing animates at rest (document.getAnimations() empty ≥ 200ms after open) and
//     prefers-reduced-motion opens with no entrance animation at all
//   · it opens beside the selection: the panel never covers the selection box
//   · R opens it (the chord moved to the left hand)
//   Run (dev server on :1420): node scripts/verify-xray-theme.mjs
import { readFileSync } from "node:fs";
import { launch, gotoApp, clickMode, shot, sleep, realErrors } from "./lib/driver.mjs";

let fails = 0;
const ok = (cond, msg) => (cond ? console.log("  ✓ " + msg) : (fails++, console.log("  ✗ " + msg)));

const SVG = readFileSync("scripts/fixtures/pre-regen/06_scatter_regression.svg", "utf8");
const MANIFEST = JSON.parse(readFileSync("scripts/fixtures/pre-regen/06_scatter_regression.fluxplot.json", "utf8"));

const { browser, page } = await launch({ width: 1500, height: 950 });
try {
  await gotoApp(page, { url: "http://127.0.0.1:1420/?fixture=demo", settle: 3500 });
  await clickMode(page, "Figure");
  await sleep(700);

  // Seed one real fluxplot, left of centre so the panel has room on its right.
  await page.evaluate(
    (svg, manifest) => {
      const F = window.__flux.fig;
      window.__flux.io.reimportPlot("theme-asset", svg, manifest);
      F.commit((p) => {
        const g = p.figures[0];
        g.x = 0;
        g.y = 0;
        g.width = 900;
        g.height = 620;
        g.elements = [
          {
            type: "plot", id: "plot1", x: 40, y: 40, width: 504, height: 360, rotation: 0,
            assetId: "theme-asset", overrides: {},
            source: { svgPath: "plots/scatter_regression.svg" },
          },
        ];
        window.__figId = g.id;
        F.activeFigureId.set(g.id);
      });
      F.selectOnly("plot1");
      F.viewport.set({ panX: 60, panY: 140, zoom: 0.85 });
    },
    SVG,
    MANIFEST,
  );
  await sleep(400);
  await page.mouse.move(300, 300);

  // --- open with the left-hand chord -------------------------------------------
  await page.keyboard.press("KeyR");
  await sleep(300);
  ok(await page.evaluate(() => !!document.querySelector(".xray")), "R opens the X-ray");
  const rest = await page.evaluate(() => document.getAnimations().length);
  ok(rest === 0, `document.getAnimations().length === 0 after open (${rest}) — nothing animates at rest`);

  // --- computed-style contract -----------------------------------------------
  const styles = await page.evaluate(() => {
    const panel = document.querySelector(".xray");
    const nodes = [panel, document.querySelector(".xbackdrop"), ...panel.querySelectorAll("*")];
    const has = (prop) => nodes.filter((n) => { const v = getComputedStyle(n)[prop]; return v && v !== "none"; }).length;
    const after = getComputedStyle(panel, "::after");
    const row = document.querySelector(".xray .row");
    const ttl = document.querySelector(".xray .ttl");
    const sel = document.querySelector(".canvas-host .sel-box")?.getBoundingClientRect();
    const pr = panel.getBoundingClientRect();
    const pcs = getComputedStyle(panel), tcs = ttl ? getComputedStyle(ttl) : null;
    return {
      backdropFiltered: has("backdropFilter"), filtered: has("filter"),
      afterContent: after.content,
      panelBgImage: pcs.backgroundImage, panelBg: pcs.backgroundColor, panelRadius: pcs.borderTopLeftRadius, cards: panel.querySelectorAll(".card").length,
      panelFont: pcs.fontFamily,
      rowFont: row ? getComputedStyle(row).fontFamily : "",
      rowHeights: [...new Set([...panel.querySelectorAll(".row")].map((r) => r.getBoundingClientRect().height))],
      rowShadow: row ? getComputedStyle(row).textShadow : "",
      glowing: [...panel.querySelectorAll(".row:not(.sel) .rlabel")].filter((l) => getComputedStyle(l).textShadow !== "none").length,
      ttl: tcs ? { transform: tcs.textTransform, spacing: parseFloat(tcs.letterSpacing), glow: tcs.textShadow, face: tcs.backgroundColor, ink: tcs.color, halo: tcs.boxShadow } : null,
      overlaps: sel ? !(pr.right <= sel.left || pr.left >= sel.right || pr.bottom <= sel.top || pr.top >= sel.bottom) : null,
      inViewport: pr.left >= 0 && pr.top >= 0 && pr.right <= innerWidth && pr.bottom <= innerHeight,
    };
  });
  ok(styles.backdropFiltered === 0 && styles.filtered === 0, `NO backdrop-filter and NO filter anywhere in the panel (${styles.backdropFiltered}, ${styles.filtered})`);
  ok(styles.afterContent === "none" || styles.afterContent === "" || styles.afterContent === "normal", `no ::after CRT layer (content: ${styles.afterContent})`);
  ok(styles.panelBgImage === "none", `flat panel field — no gradient (${styles.panelBgImage})`);
  ok(styles.panelRadius === "12px" && styles.cards >= 3, `a plate with cards set into it (radius ${styles.panelRadius}, ${styles.cards} cards)`);
  ok(/mono/i.test(styles.rowFont), `mono type on tree rows (${styles.rowFont.split(",")[0]})`);
  ok(styles.rowHeights.length === 1 && styles.rowHeights[0] === 22, `rows are 22 px (${styles.rowHeights.join(", ")})`);
  ok(styles.rowShadow === "none" && styles.glowing === 0, "no text glow on rows that are not picked");
  ok(styles.ttl && styles.ttl.transform === "uppercase" && styles.ttl.spacing > 1 && styles.ttl.glow === "none",
    `the lead marker: mono, uppercase, letterspaced, its letters not glowing (${styles.ttl?.transform}, ${styles.ttl?.spacing}px)`);
  ok(styles.ttl && styles.ttl.face === "rgb(226, 245, 240)" && styles.ttl.ink === "rgb(7, 58, 57)" && styles.ttl.halo !== "none", `…bright as a light box, with a soft halo (${styles.ttl?.face})`);
  ok(styles.overlaps === false, "the panel opens BESIDE the selection (never covers the selection box)");
  ok(styles.inViewport, "…and inside the viewport");

  // Selection = phosphor tint + inset rail on the primary row — NOT a solid accent fill.
  await page.evaluate(() => {
    [...document.querySelectorAll(".xray .row")]
      .find((r) => (r.querySelector(".rlabel")?.textContent ?? "").trim() === "X axis")
      ?.querySelector("button.tw")?.click();
  });
  await sleep(200);
  await page.evaluate(() => {
    [...document.querySelectorAll(".xray .row")]
      .find((r) => (r.querySelector(".rlabel")?.textContent ?? "").trim() === "Tick labels")
      ?.click();
  });
  await sleep(250);
  const sel = await page.evaluate(() => {
    const r = document.querySelector(".xray .row.sel");
    if (!r) return null;
    const cs = getComputedStyle(r);
    return { bg: cs.backgroundColor, shadow: cs.boxShadow, glow: getComputedStyle(r.querySelector(".rlabel")).textShadow, primary: r.classList.contains("primary") };
  });
  ok(!!sel, "a selected row exists");
  // The tint is laid OVER the row (an inset shadow without blur: the row's own background is its skeleton's
  // cover), so its alpha is read from the shadow that spreads across the row. A computed shadow reads
  // "<colour> <x> <y> <blur> <spread> inset"; colours carry their alpha as "rgba(…, a)" or "… / a)".
  const shadows = sel ? sel.shadow.split(/,(?![^(]*\))/).map((t) => { const m = t.trim().match(/^(.*?)\s+(-?[\d.]+)px\s+(-?[\d.]+)px\s+([\d.]+)px\s+(-?[\d.]+)px\s+inset$/); if (!m) return null; const a = m[1].match(/\/\s*([\d.]+)\s*\)$/) || m[1].match(/rgba\([^)]+,\s*([\d.]+)\)$/); return { x: +m[2], blur: +m[4], spread: +m[5], alpha: a ? parseFloat(a[1]) : 1 }; }).filter(Boolean) : [];
  const tint = shadows.find((x) => x.spread > 20), rail = shadows.find((x) => x.x === 2 && x.blur === 0 && x.spread === 0), halo = shadows.find((x) => x.blur > 0);
  ok(sel && !!tint && tint.blur === 0 && tint.alpha > 0 && tint.alpha < 0.5, `.sel = translucent phosphor tint over the row, not a solid fill (alpha ${tint?.alpha}; ${sel?.shadow})`);
  ok(sel && sel.primary && !!rail && rail.alpha === 1, "…the primary row carries the inset 2px rail");
  // The pick glows FROM ITS RAIL, inside the row: an inset shadow costs no layout. Its name carries no text-shadow
  // (a text glow grows the row's ink overflow and is laid out again at every row the arrow keys cross).
  ok(sel && !!halo && halo.blur <= 12 && sel.glow === "none", `…and what is picked glows softly from its rail, inside the row (blur ${halo?.blur}px; no text-shadow on its name)`);
  ok((await page.evaluate(() => [...document.querySelectorAll(".xray .row .rlabel")].filter((l) => getComputedStyle(l).textShadow !== "none").length)) === 0, "…no row's name is text-shadowed");

  // --- the skeleton: drawn, never built -----------------------------------------------
  const tree = await page.evaluate(() => [...document.querySelectorAll(".xray .row")].map((r) => { const cs = getComputedStyle(r), eye = r.querySelector(".eye"), tw = r.querySelector(".tw");
    return { label: r.querySelector(".rlabel")?.textContent.trim(), depth: (parseFloat(r.style.paddingLeft) - 6) / 14, image: cs.backgroundImage, layers: cs.backgroundImage === "none" ? 0 : (cs.backgroundImage.match(/linear-gradient/g) ?? []).length, clip: cs.backgroundClip,
      kids: [...r.children].map((c) => c.classList[0]).join(" "), open: tw?.getAttribute("aria-expanded") ?? null, twSays: tw?.textContent.trim() ?? null, twTag: tw?.tagName ?? null,
      eye: { says: eye.textContent.trim(), size: getComputedStyle(eye).fontSize, left: Math.round(eye.getBoundingClientRect().left - r.getBoundingClientRect().left - parseFloat(r.style.paddingLeft)) } }; }));
  const byLabel = (l) => tree.find((r) => r.label === l);
  ok(tree[0].depth === 0 && tree[0].layers === 0, `the root row has no skeleton line (${tree[0].image})`);
  ok(tree.slice(1).every((r) => r.depth >= 1 && r.layers === 3 && /repeating-linear-gradient/.test(r.image) && r.clip === "content-box, padding-box, padding-box"), `every other row is tied to its parent by three background layers: a cover over its content, a rib, the lines of its indent (${tree[1].layers})`);
  ok(new Set(tree.slice(1).map((r) => r.image)).size === 1, "…the same three for every row: one static rule, nothing computed per row");
  ok(tree.every((r) => r.kids.split(" ").every((c) => ["tw", "eye", "rmain", "rprev", "tag", "count"].includes(c))), `a row holds no element for its lines (${tree[1].kids})`);
  const xAxis = byLabel("X axis"), spine = byLabel("Spine");
  ok(xAxis?.twTag === "BUTTON" && xAxis.open === "true" && xAxis.twSays === "▾" && byLabel("Y axis")?.open === "false" && byLabel("Y axis")?.twSays === "▸", "an open branch says so (▾, aria-expanded), a closed one too (▸)");
  ok(!!spine && spine.twTag === null && spine.kids.startsWith("eye") && spine.eye.left === 19 && xAxis.eye.left === 19, `a row with nothing to open carries no empty twisty, and its eye stands where the others' do (${spine?.eye.left}px / ${xAxis?.eye.left}px)`);
  ok(tree.every((r) => r.eye.says === "◉" && r.eye.size === "12px"), "the eye is the glyph it always was (◉ drawn)");

  // --- the readout, the keys, the hint line -----------------------------------------
  const chrome = await page.evaluate(() => { const q = (s) => document.querySelector(".xray " + s), r = (s) => q(s)?.getBoundingClientRect(), cs = (s) => (q(s) ? getComputedStyle(q(s)) : null);
    const hints = q(".foot .hints");
    return { readoutH: r(".xdetail")?.height, sameLine: Math.abs(r(".xdetail .dpath").top - r(".xdetail .dval").top) < 4, metaBelow: r(".xdetail .dmeta").top > r(".xdetail .dpath").bottom - 2,
      lead: cs(".showprops.lead")?.backgroundColor, leadText: q(".showprops.lead")?.textContent.replace(/\s+/g, " ").trim(), anim: cs(".animbtn")?.backgroundColor, animOff: q(".animbtn")?.disabled,
      hintCut: hints.scrollWidth > hints.clientWidth + 1, hintLines: Math.round(r(".foot").height), legend: !!q(".legend"), src: r(".srcline")?.height ?? 0, srcInHead: !!q(".xhead .srcline") }; });
  ok(chrome.readoutH === 44 && chrome.sameLine && chrome.metaBelow, `the readout is two lines of fixed height: where and what, then its facts (${chrome.readoutH}px)`);
  ok(chrome.lead === "rgb(226, 245, 240)" && /Properties/.test(chrome.leadText) && chrome.anim !== chrome.lead, `one key is bright (${chrome.leadText}); the others are glass`);
  ok(chrome.animOff === true, "Animate is off in Figure mode");
  ok(!chrome.hintCut && chrome.hintLines === 22 && !chrome.legend, "one hint line, whole; no legend until asked");
  ok(chrome.srcInHead && chrome.src >= 12, "the source path is the head's second line");
  // (The ? KEY stays the app's keyboard reference, which lists these keys too; the legend is this key's.)
  await page.click(".xray .foot .keys");
  await sleep(150);
  const legend = await page.evaluate(() => ({ n: document.querySelectorAll(".xray .legend > span").length, on: document.querySelector(".xray .foot .keys")?.getAttribute("aria-pressed"), inView: document.querySelector(".xray").getBoundingClientRect().bottom <= innerHeight }));
  ok(legend.n === 13 && legend.on === "true" && legend.inView, `the key at the hint line's end shows every X-ray key (${legend.n} entries)`);
  await page.click(".xray .foot .keys");
  await sleep(150);
  ok(await page.evaluate(() => !document.querySelector(".xray .legend")), "…and its key hides them again");

  // Dim a row's eye for the screenshot (shows the off state) + evidence shot.
  await page.evaluate(() => {
    [...document.querySelectorAll(".xray .row")]
      .find((r) => (r.querySelector(".rlabel")?.textContent ?? "").trim() === "Gridlines")
      ?.querySelector("button.eye")?.click();
  });
  await sleep(300);
  await shot(page, "xray-theme-full");

  // --- reduced motion: no entrance animation at all --------------------------
  await page.keyboard.press("Escape");
  await sleep(300);
  await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
  await page.keyboard.press("KeyR");
  await sleep(60);
  const reduced = await page.evaluate(() => ({
    anim: getComputedStyle(document.querySelector(".xray")).animationName,
    running: document.getAnimations().length,
  }));
  ok(reduced.anim === "none" && reduced.running === 0, `prefers-reduced-motion opens with no animation (animation: ${reduced.anim})`);

  const { verifyCurveSurface } = await import("./lib/animatorCurveChecks.mjs");
  await verifyCurveSurface(page, ok);

  const errs = realErrors(page);
  ok(errs.length === 0, `no console errors (${errs.length})`);
  if (errs.length) console.error(errs.slice(0, 5));
  console.log(fails === 0 ? "\nVERIFY-XRAY-THEME ALL PASS" : `\nVERIFY-XRAY-THEME ${fails} FAILURE(S)`);
} finally {
  await browser.close();
}
process.exit(fails === 0 ? 0 : 1);
