#!/usr/bin/env -S npx tsx
// Feature 8 — math expressions + label scrubbing in numeric fields.
//  (a) unit-test the pure evaluator (evalExpr);
//  (b) drive the app: type "816/2" into X (→408), reject "abc", scrub W (GIF),
//      confirm a scrub is ONE undo entry.
import { evalExpr, fmtNum } from "../src/lib/num";
// @ts-expect-error mjs helper, no types
import { launch, gotoApp, clickMode, shot, realErrors, sleep } from "./lib/driver.mjs";
// @ts-expect-error mjs helper, no types
import { recordGif } from "./lib/gif.mjs";

let fails = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log("  ok:", msg);
  else {
    fails++;
    console.error("  FAIL:", msg);
  }
}
const near = (a: number, b: number, tol = 0.5) => Math.abs(a - b) <= tol;

// ---- (a) evalExpr unit tests -------------------------------------------------
console.log("evalExpr unit tests:");
assert(evalExpr("100+20") === 120, "100+20 → 120");
assert(evalExpr("(240*3)+48") === 768, "(240*3)+48 → 768");
assert(evalExpr("2^3") === 8, "2^3 → 8");
assert(evalExpr("816/2") === 408, "816/2 → 408");
assert(evalExpr("45*2") === 90, "45*2 → 90");
assert(evalExpr("-5") === -5, "unary minus -5");
assert(evalExpr("2 + 3 * 4") === 14, "precedence 2+3*4 → 14");
assert(evalExpr("2^3^2") === 512, "right-assoc 2^3^2 → 512");
assert(evalExpr("abc") === null, "abc → null");
assert(evalExpr("1/0") === null, "1/0 → null (guard)");
assert(evalExpr("") === null, "empty → null");
assert(evalExpr("1.2.3") === null, "1.2.3 → null");
assert(evalExpr("1+") === null, "trailing op → null");
assert(evalExpr("(1+2") === null, "unbalanced paren → null");
assert(evalExpr("2;rm -rf") === null, "injection chars → null");
assert(fmtNum(408, 1) === "408", "fmtNum integer");
assert(fmtNum(0.85, 0.05) === "0.85", "fmtNum fractional step");

// ---- (b) browser: fields accept math + scrub --------------------------------
const { browser, page } = await launch({ width: 1440, height: 900 });
try {
  await gotoApp(page, { url: "http://127.0.0.1:1420/?fixture=demo", settle: 3500 });
  await clickMode(page, "Figure");
  await sleep(700);

  // Seed a known rect and select it.
  const rid = await page.evaluate(() => {
    const F = (window as any).__flux.fig;
    let id = "";
    F.commit((p: any) => {
      const g = p.figures.find((f: any) => f.id === "growth") || p.figures[0];
      id = F.newId("rect");
      g.elements.push({ type: "rect", id, x: 100, y: 100, width: 200, height: 120, rotation: 0, fill: "#d95f02", stroke: "#222222", strokeWidth: 4, cornerRadius: 0 });
      (window as any).__rid = id;
    });
    F.selectOnly(id);
    F.viewport.set({ panX: 200, panY: 160, zoom: 1 });
    return id;
  });
  await sleep(300);
  const readEl = () =>
    page.evaluate((id: string) => {
      const e = (window as any).__flux.figures().flatMap((f: any) => f.elements).find((x: any) => x.id === id);
      return { x: e.x, y: e.y, width: e.width, height: e.height };
    }, rid);

  await shot(page, "f8-01-inspector");

  // Type a math expression into X → 408.
  const setField = (label: string, expr: string) =>
    page.evaluate(
      (lbl: string, val: string) => {
        const nfs = [...document.querySelectorAll(".inspector .nf")];
        const nf = nfs.find((n) => n.querySelector(".lb")?.textContent?.trim() === lbl) as HTMLElement | undefined;
        if (!nf) return false;
        const inp = nf.querySelector("input") as HTMLInputElement;
        inp.value = val;
        inp.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      },
      label,
      expr,
    );

  const okX = await setField("X", "816/2");
  await sleep(200);
  assert(okX, "found X field");
  let el = await readEl();
  assert(near(el.x, 408), `X "816/2" → x=${el.x} (expect 408)`);

  // Invalid expression leaves the value unchanged.
  await setField("X", "abc");
  await sleep(150);
  el = await readEl();
  assert(near(el.x, 408), `X "abc" rejected → x still ${el.x}`);

  await setField("H", "(60*2)+30");
  await sleep(150);
  el = await readEl();
  assert(near(el.height, 150), `H "(60*2)+30" → height=${el.height} (expect 150)`);
  await shot(page, "f8-02-expr-applied");

  // Scrub the W label (drag right → width increases), captured as a GIF.
  const wbox = await page.evaluate(() => {
    const nfs = [...document.querySelectorAll(".inspector .nf")];
    const nf = nfs.find((n) => n.querySelector(".lb")?.textContent?.trim() === "W") as HTMLElement | undefined;
    const sp = nf?.querySelector(".lb") as HTMLElement;
    const r = sp.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  const beforeScrub = (await readEl()).width;
  await recordGif(page, "f8-scrub-width", async (frame: () => Promise<void>) => {
    await page.mouse.move(wbox.x, wbox.y);
    await page.mouse.down();
    await frame();
    for (let i = 1; i <= 40; i++) {
      await page.mouse.move(wbox.x + i * 3, wbox.y);
      if (i % 2 === 0) await frame();
    }
    await sleep(60);
    await frame();
    await page.mouse.up();
    await frame();
  });
  const afterScrub = (await readEl()).width;
  assert(afterScrub > beforeScrub + 50, `scrub W: ${beforeScrub} → ${afterScrub} (increased)`);
  await shot(page, "f8-03-after-scrub");

  // One scrub gesture = ONE undo entry.
  await page.evaluate(() => (window as any).__flux.fig.undo());
  await sleep(150);
  const afterUndo = (await readEl()).width;
  assert(near(afterUndo, beforeScrub, 1), `undo restores W in one step: ${afterUndo} (expect ${beforeScrub})`);

  const errs = realErrors(page);
  assert(errs.length === 0, `no console errors (${errs.length})`);
  if (errs.length) console.error(errs.slice(0, 5));

  console.log(fails === 0 ? "\nF8 ALL PASS" : `\nF8 ${fails} FAILURE(S)`);
} finally {
  await browser.close();
}
process.exit(fails === 0 ? 0 : 1);
