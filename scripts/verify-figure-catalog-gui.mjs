import assert from "node:assert/strict";
import { launch, gotoApp, clickMode, realErrors } from "./lib/driver.mjs";
const { browser, page } = await launch();
let checks = 0;
const eq = (a, b, label) => { assert.deepEqual(a, b, label); checks++; };
try {
  await gotoApp(page, { url: "http://127.0.0.1:1420/?fixture=demo" });
  await clickMode(page, "Figure");
  const identity = await page.evaluate(() => {
    const F = window.__flux, p = F.get(F.fig.project);
    return { id: p.figures[0].id, key: p.figures[0].referenceKey, number: p.figures[0].number };
  });
  await page.click('button[title="All project figures, references, sources and usages"]');
  await page.waitForSelector('.catalog .usage');
  eq(await page.$$eval('.catalog .usage', (rows) => rows.length), 1, "Used in groups multiple panel/whole references by document");
  eq(await page.$eval('.catalog .reference code', (el) => el.textContent), `@${identity.key}`, "catalog exposes permanent reference");
  await page.click('.catalog .title-field input');
  // Headless Chromium on macOS does not synthesize native select-all for
  // inputs. Select the field's text, then drive ordinary typing and blur.
  await page.$eval('.catalog .title-field input', (el) => el.select());
  await page.keyboard.type("Recognizable experiment title");
  await page.keyboard.press("Tab");
  await page.waitForFunction(() => document.querySelector('.catalog h3')?.textContent === "Recognizable experiment title");
  eq(await page.evaluate(() => window.__flux.get(window.__flux.fig.project).figures[0].referenceKey), identity.key, "editing human title preserves key");
  await page.evaluate(() => window.__flux.lifecycle.flushAll());
  await page.click('.catalog .usage');
  await page.waitForSelector('.paper .cm-editor');
  await page.waitForFunction(() => window.__flux.get(window.__flux.panes.focusedMode) === "paper");
  eq(await page.evaluate(() => window.__flux.get(window.__flux.fig.project).figures[0].number), identity.number, "opening a usage does not renumber Figure");
  // Change document order through the real editor; the fixture has references
  // to a whole figure and both panels. Export and Figure keep the same identity.
  await page.evaluate(() => {
    const view = window.__fluxView, doc = view.state.doc.toString();
    view.dispatch({ changes: { from: 0, to: doc.length, insert: doc.split('\n').reverse().join('\n') } });
  });
  await page.evaluate(() => window.__flux.lifecycle.flushAll());
  await clickMode(page, "Figure");
  eq(await page.evaluate(() => {
    const f = window.__flux.get(window.__flux.fig.project).figures[0];
    return { id: f.id, key: f.referenceKey, number: f.number, title: f.nickname };
  }), { ...identity, title: "Recognizable experiment title" }, "Paper order and mode roundtrip preserve figure identity and title");
  await page.click('button[title="Delete figure"]');
  await page.waitForFunction(() => document.querySelector('[aria-label="Delete figures"]')?.textContent.includes('These documents'));
  eq(await page.evaluate(() => window.__flux.get(window.__flux.fig.project).figures.some((f) => f.nickname === "Recognizable experiment title")), true, "referenced deletion waits for visible usage review");
  eq(await page.evaluate(() => document.activeElement?.textContent), "Cancel", "deletion focuses safe Cancel");
  await page.keyboard.down("Shift"); await page.keyboard.press("Tab"); await page.keyboard.up("Shift");
  eq(await page.evaluate(() => document.activeElement?.textContent), "Delete figure", "backward tab wraps within review dialog");
  await page.keyboard.press("Tab");
  eq(await page.evaluate(() => document.activeElement?.textContent), "Cancel", "forward tab wraps within review dialog");
  await page.keyboard.press("Delete");
  eq(await page.evaluate(() => !!document.querySelector('[aria-label="Delete figures"]')), true, "Delete key cannot leak to Figure canvas");
  const frozenGeometry=await page.evaluate(()=>JSON.stringify(window.__flux.get(window.__flux.fig.project).figures));
  await page.keyboard.press("ArrowRight");
  eq(await page.evaluate(()=>JSON.stringify(window.__flux.get(window.__flux.fig.project).figures)),frozenGeometry,"arrow keys cannot move Figure content behind the modal");
  await page.keyboard.press("Escape");
  await page.waitForSelector('[aria-label="Delete figures"]', { hidden: true });
  eq(await page.evaluate(() => document.activeElement?.getAttribute("title")), "Delete figure", "cancel restores focus to the invoking control");
  eq(realErrors(page), [], "no console errors across naming, navigation, manuscript editing and deletion cancel");
  console.log(`FIGURE CATALOG GUI: PASS (${checks} assertions)`);
} catch (e) {
  console.error(await page.evaluate(() => ({ text: document.body.innerText.slice(-3000), title: window.__flux?.get(window.__flux.fig.project).figures[0]?.nickname })));
  throw e;
} finally { await browser.close(); }
