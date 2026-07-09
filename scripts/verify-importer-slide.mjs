// figure-v1 P0b gate (browser) — the Alt+I Plot Importer's multi-select in SLIDE
// mode: the same toggle/insert mechanism as figure mode, handed to SlideMode's
// onPickPlot(picks[]) — which places ALL picks in ONE commitDeck (a single undo
// step), staggered +24px per pick from the 360/150 base, assetId = rel minus
// .svg, manifestPath only for semantic picks, then selects all new elements
// (slide selection is an ARRAY) after ONE asset refresh.
//   Run (dev server on :1420 must be up): node scripts/verify-importer-slide.mjs
import { launch, gotoApp, clickMode, sleep, realErrors } from "./lib/driver.mjs";

let fails = 0;
const ok = (cond, msg, extra = "") =>
  cond ? console.log("  ✓ " + msg) : (fails++, console.log("  ✗ " + msg + (extra ? ` — ${extra}` : "")));

const ROOT = "/demo/myc-growth-paper";
const { browser, page } = await launch();
await gotoApp(page, { url: "http://127.0.0.1:1420/?fixture=demo", settle: 3200 });
await clickMode(page, "Slide");
await sleep(1200);

// A deck must be live (the demo project ships a starter deck; SlideMode creates
// one otherwise). Ensure an active slide and remember its pre-existing plots.
await page.waitForFunction(() => !!window.__flux?.slide && !!window.__flux.get(window.__flux.slide.deck), { timeout: 15000 });
const before = await page.evaluate(() => {
  const F = window.__flux;
  let sid = F.get(F.slide.activeSlideId);
  const d = F.get(F.slide.deck);
  if (!sid || !d.slides.some((s) => s.id === sid)) {
    F.slide.commitDeck((dd) => {
      if (!dd.slides.length) F.slideOps.addSlide(dd, { layout: "blank" });
    });
    sid = F.get(F.slide.deck).slides[0].id;
    F.slide.activeSlideId.set(sid);
  }
  const s = F.get(F.slide.deck).slides.find((x) => x.id === sid);
  return { sid, plotCount: s.elements.filter((e) => e.type === "plot").length };
});

// ---- seed plots/ (one semantic at the root, one vanilla in a subfolder) --------
await page.evaluate(async (root) => {
  const svg = (fill) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="72pt" height="72pt" viewBox="0 0 72 72"><rect width="72" height="72" fill="${fill}"/></svg>`;
  await window.fig.writeText(`${root}/plots/sl_one.svg`, svg("#d95f02"));
  await window.fig.writeText(
    `${root}/plots/sl_one.fluxplot.json`,
    JSON.stringify({ schemaVersion: "0.1.0", axes: [], series: [], guides: [], overlays: [] }),
  );
  await window.fig.writeText(`${root}/plots/sub2/sl_two.svg`, svg("#7570b3"));
}, ROOT);

// ---- Alt+I → pick 2 (browse + search) → Ctrl+Enter ------------------------------
await page.keyboard.down("Alt");
await page.keyboard.press("KeyI");
await page.keyboard.up("Alt");
await sleep(500);
ok(await page.evaluate(() => !!document.querySelector(".importer")), "Alt+I opens the importer in Slide mode");

await page.keyboard.press("ArrowDown"); // rows: [sub2/, sl_one] → highlight sl_one
await page.keyboard.press("Enter"); // toggle
await page.keyboard.type("sl_two"); // search mode
await sleep(250);
await page.keyboard.press("Enter"); // toggle the hit
const pill = await page.evaluate(() => document.querySelector(".pickpill")?.textContent?.trim() ?? "");
ok(pill === "2 selected", `picked one browse row + one search row (${pill || "no pill"})`);

await page.keyboard.down("Control");
await page.keyboard.press("Enter");
await page.keyboard.up("Control");
await sleep(700);

const res = await page.evaluate(
  ({ sid, plotCount }) => {
    const F = window.__flux;
    const s = F.get(F.slide.deck).slides.find((x) => x.id === sid);
    const plots = s.elements.filter((e) => e.type === "plot").slice(plotCount);
    return {
      open: !!document.querySelector(".importer"),
      plots: plots.map((p) => ({
        id: p.id,
        assetId: p.assetId,
        x: p.x,
        y: p.y,
        w: p.width,
        h: p.height,
        svgPath: p.source?.svgPath ?? null,
        manifestPath: p.source?.manifestPath ?? null,
      })),
      selection: F.get(F.slide.selection),
    };
  },
  before,
);

ok(!res.open, "importer closed after Ctrl+Enter");
ok(res.plots.length === 2, `active slide gained 2 plot elements (got ${res.plots.length})`);
const [p1, p2] = res.plots;
ok(p1?.assetId === "sl_one" && p2?.assetId === "sub2/sl_two", "assetId = plots/-relative path minus .svg", `${p1?.assetId}, ${p2?.assetId}`);
ok(p1?.svgPath === "plots/sl_one.svg" && p2?.svgPath === "plots/sub2/sl_two.svg", "source.svgPath points under plots/", `${p1?.svgPath}, ${p2?.svgPath}`);
ok(
  p1?.manifestPath === "plots/sl_one.fluxplot.json" && p2?.manifestPath === null,
  "manifestPath present ONLY for the semantic pick",
  `${p1?.manifestPath}, ${p2?.manifestPath}`,
);
ok(p1?.x === 360 && p1?.y === 150 && p2?.x === 384 && p2?.y === 174, "picks staggered +24px from the 360/150 base", res.plots.map((p) => `(${p.x},${p.y})`).join(" "));
ok(
  Array.isArray(res.selection) && res.selection.length === 2 && res.plots.every((p) => res.selection.includes(p.id)),
  `both new elements selected (slide selection array = ${res.selection.length})`,
);

// ---- ONE commitDeck = ONE undo step ---------------------------------------------
const undo = await page.evaluate(
  ({ sid, plotCount }) => {
    const F = window.__flux;
    const count = () => F.get(F.slide.deck).slides.find((x) => x.id === sid).elements.filter((e) => e.type === "plot").length;
    F.slide.undoDeck();
    const afterUndo = count();
    F.slide.redoDeck();
    const afterRedo = count();
    return { afterUndo: afterUndo - plotCount, afterRedo: afterRedo - plotCount };
  },
  before,
);
ok(undo.afterUndo === 0, `single undo removes the whole batch (ONE commitDeck) — ${undo.afterUndo} left`);
ok(undo.afterRedo === 2, `redo restores both (${undo.afterRedo})`);

const errs = realErrors(page);
ok(errs.length === 0, "no console/page errors", errs.join(" | "));

await browser.close();
console.log(fails ? `\n${fails} FAILED` : "\nall green");
process.exit(fails ? 1 : 0);
