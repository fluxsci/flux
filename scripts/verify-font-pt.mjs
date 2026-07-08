// Font-size-in-points gate: the UI edits font sizes in POINTS (the unit journal
// specs use; 1 pt = 1/72 in) while storage stays canvas px (1/96 in): px = pt × 4/3.
// Typing 7 in the Inspector must yield true 7 pt in print (stored 9.33 px), an old
// document's 24 px must display as 18 pt unchanged, and the text-tool default must
// be journal-spec 7 pt.
import { launch, gotoApp, clickNew, clickMode, sleep, realErrors } from "./lib/driver.mjs";

const { browser, page } = await launch();
await gotoApp(page);
await clickNew(page);
await clickMode(page, "Figure");
await sleep(400);

// Inject a legacy-style text element (24 px = 18 pt) and select it.
const id = await page.evaluate(() => {
  const F = window.__flux;
  let tid = "";
  F.fig.commit((p) => {
    tid = "t_pt_gate";
    p.figures[0].elements.push({
      type: "text", id: tid, x: 40, y: 40, width: 200, height: 34, rotation: 0,
      text: "pt gate", fontFamily: "Arial", fontSize: 24, fontWeight: 400,
      fontStyle: "normal", align: "left", color: "#111111", autoWidth: false,
    });
  });
  F.fig.selection.set(new Set([tid]));
  return tid;
});
await sleep(400);

const readField = () =>
  page.evaluate(() => {
    const nf = [...document.querySelectorAll(".inspector .nf")].find(
      (n) => n.querySelector(".lb")?.textContent?.trim() === "Size (pt)",
    );
    return nf ? nf.querySelector("input")?.value : null;
  });
const setField = (val) =>
  page.evaluate((v) => {
    const nf = [...document.querySelectorAll(".inspector .nf")].find(
      (n) => n.querySelector(".lb")?.textContent?.trim() === "Size (pt)",
    );
    if (!nf) return false;
    const inp = nf.querySelector("input");
    inp.value = v;
    inp.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }, val);
const storedPx = () =>
  page.evaluate(
    (tid) => window.__flux.figures().flatMap((f) => f.elements).find((e) => e.id === tid)?.fontSize,
    id,
  );

const legacyShown = await readField(); // 24 px must display as 18 pt
const fieldFound = legacyShown !== null;
await setField("7");
await sleep(250);
const afterPx = await storedPx(); // 7 pt → 28/3 px
const afterShown = await readField();
const defaultPt = await page.evaluate(() => window.__flux.get(window.__flux.fig.drawStyle).fontSize * 0.75);

const near = (v, t, tol = 0.01) => Math.abs(v - t) <= tol;
const checks = {
  fieldFound,
  legacyPxShowsAsPt: legacyShown === "18",
  typing7StoresFourThirds: near(afterPx, 28 / 3),
  displayReads7: afterShown === "7",
  textToolDefaultIs7pt: near(defaultPt, 7),
  errs: realErrors(page),
};
const pass = Object.entries(checks).every(([k, v]) => (k === "errs" ? v.length === 0 : v === true));
console.log(JSON.stringify({ legacyShown, afterPx, afterShown, defaultPt, ...checks, pass }, null, 2));
await browser.close();
process.exit(pass ? 0 : 1);
