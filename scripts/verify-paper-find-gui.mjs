// Paper's find bar (Ctrl+F) — CodeMirror's stock search panel, made usable:
//
//   (A) nothing covers it: every control (Find / Replace fields, next /
//       previous / all, the case / regexp / word toggles, replace buttons,
//       close, the count) has a bounding box disjoint from the title pill, and
//       elementFromPoint at its centre hits the control itself;
//   (B) the "k of n" count: "n matches" after typing, "1 of n" after Enter,
//       next / previous / Shift+Enter move the selection to the right match
//       and the count follows, the regexp toggle re-counts, the cap reads
//       "1,000+ matches", an empty result reads "No matches";
//   (C) idle, never per keystroke: typing in the document with the bar open
//       runs ZERO match counts during the burst and one after the settle;
//   (D) Escape closes the bar; no page errors.
//   node scripts/run-verifies.mjs --tier ui --only verify-paper-find-gui
import { launch, gotoApp, clickMode, waitFor, APP_URL, realErrors, shot } from "./lib/driver.mjs";
import { harness } from "./lib/harness.mjs";

const h = harness("verify-paper-find-gui");
const { browser, page } = await launch({ width: 1440, height: 900 });

const paints = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
const countText = () => page.evaluate(() => document.querySelector(".cm-search [data-find-count]")?.textContent ?? null);
const waitCount = (want, label) =>
  waitFor(page, (w) => document.querySelector(".cm-search [data-find-count]")?.textContent === w, want, { timeout: 3000, label }).catch(() => null);
// Replace the Find field's text the way a user does (select all, type over it).
const setQuery = async (q) => {
  await page.$eval('.cm-search input[name="search"]', (el) => { el.focus(); el.select(); });
  await page.type('.cm-search input[name="search"]', q);
};
const selection = () => page.evaluate(() => { const s = window.__fluxView.state.selection.main; return [s.from, s.to]; });
const DOC = [
  "---",
  'title: "Find bar probe"',
  "---",
  "",
  "# The first heading",
  "",
  "The cat sat on the mat. Then the other cat theorised about the weather.",
  "",
  "Nothing to see here, other than the end.",
  "",
].join("\n");

try {
  await gotoApp(page, { url: `${APP_URL}?fixture=demo`, settle: 900 });
  await clickMode(page, "Paper");
  await waitFor(page, () => !!window.__fluxView, null, { timeout: 15000, label: "paper editor mounted" });
  await waitFor(page, () => !!document.querySelector(".titlepill-wrap > *"), null, { timeout: 5000, label: "title pill" });
  await page.evaluate((t) => {
    const v = window.__fluxView;
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: t }, selection: { anchor: 0 } });
    v.focus();
  }, DOC);
  await paints();
  await page.keyboard.down("Control");
  await page.keyboard.press("KeyF");
  await page.keyboard.up("Control");
  await waitFor(page, () => !!document.querySelector(".cm-panels-top .cm-search [data-find-count]"), null, { timeout: 3000, label: "find bar open with its count" });
  await paints();

  // ---------------------------------------------------------------- (A)
  h.section("no overlap with the title pill");
  const geo = await page.evaluate(() => {
    const box = (el) => { const r = el.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom }; };
    const pill = document.querySelector(".titlepill-wrap > *");
    const ctrls = [...document.querySelectorAll(".cm-search input, .cm-search button, .cm-search label, .cm-search [data-find-count]")]
      .filter((el) => el.getBoundingClientRect().width > 0)
      .map((el) => {
        const b = box(el);
        const hit = document.elementFromPoint((b.l + b.r) / 2, (b.t + b.b) / 2);
        return { name: el.getAttribute("name") || el.textContent?.trim() || el.className, b, hitsSelf: !!hit && (el === hit || el.contains(hit) || hit.contains(el)) };
      });
    return { pill: pill ? box(pill) : null, ctrls };
  });
  h.ok(!!geo.pill, "title pill present");
  h.ok(geo.ctrls.length >= 13, `find bar controls measured (${geo.ctrls.length})`);
  const overlaps = geo.ctrls.filter((c) => geo.pill && c.b.l < geo.pill.r && c.b.r > geo.pill.l && c.b.t < geo.pill.b && c.b.b > geo.pill.t).map((c) => c.name);
  h.eq(overlaps, [], "no find-bar control's box intersects the title pill");
  h.eq(geo.ctrls.filter((c) => !c.hitsSelf).map((c) => c.name), [], "every control is the topmost element at its centre (nothing covers it)");
  for (const name of ["case", "re", "word"]) h.ok(geo.ctrls.some((c) => c.name === name), `toggle "${name}" visible`);
  await shot(page, "paper-find-open");

  // ---------------------------------------------------------------- (B)
  h.section("the k of n count");
  const expected = (re) => page.evaluate((src) => (window.__fluxView.state.doc.toString().match(new RegExp(src, "gi")) ?? []).length, re);
  const nThe = await expected("the");
  await page.type('.cm-search input[name="search"]', "the");
  h.eq(await countText(), "", "typing the query does not count synchronously (count still empty)");
  h.ok(!!(await waitCount(`${nThe} matches`, "count after typing")), `"${nThe} matches" after the settle (case-insensitive, like the search)`);
  const matchAt = (k) =>
    page.evaluate((k) => {
      const src = window.__fluxView.state.doc.toString();
      const re = /the/gi;
      let m;
      let i = 0;
      while ((m = re.exec(src))) if (++i === k) return [m.index, m.index + m[0].length];
      return null;
    }, k);
  await page.keyboard.press("Enter");
  h.ok(!!(await waitCount(`1 of ${nThe}`, "1 of n")), `Enter: "1 of ${nThe}"`);
  h.eq(await selection(), await matchAt(1), "Enter selects the first match");
  await page.click('.cm-search button[name="next"]');
  h.ok(!!(await waitCount(`2 of ${nThe}`, "2 of n")), `next: "2 of ${nThe}"`);
  h.eq(await selection(), await matchAt(2), "next moves the selection to the second match");
  await page.click('.cm-search button[name="prev"]');
  h.ok(!!(await waitCount(`1 of ${nThe}`, "back to 1 of n")), `previous: "1 of ${nThe}"`);
  h.eq(await selection(), await matchAt(1), "previous moves the selection back");
  await page.focus('.cm-search input[name="search"]');
  await page.keyboard.down("Shift");
  await page.keyboard.press("Enter");
  await page.keyboard.up("Shift");
  h.ok(!!(await waitCount(`${nThe} of ${nThe}`, "wrap to last")), `Shift+Enter wraps to the last match ("${nThe} of ${nThe}")`);
  h.eq(await selection(), await matchAt(nThe), "Shift+Enter selects the last match");

  // Regexp toggle: whole-word "the" only.
  await page.click('.cm-search input[name="re"]');
  await setQuery("\\bthe\\b");
  const nWord = await expected("\\bthe\\b");
  h.ok(nWord < nThe, `fixture sanity: whole-word matches (${nWord}) < substring matches (${nThe})`);
  // The selection still sits on the last "the" (a whole word too), so the
  // count says where it is among the new matches.
  h.ok(!!(await waitCount(`${nWord} of ${nWord}`, "regexp count")), `regexp \\bthe\\b re-counts: "${nWord} of ${nWord}"`);
  await setQuery("zzqx");
  h.ok(!!(await waitCount("No matches", "no matches")), '"No matches" for an absent query');
  await page.click('.cm-search input[name="re"]');

  // The cap: 1,500 one-letter hits.
  await page.evaluate(() => {
    const v = window.__fluxView;
    v.dispatch({ changes: { from: v.state.doc.length, insert: "\n\n" + "q ".repeat(1500) + "\n" } });
  });
  await setQuery("q");
  h.ok(!!(await waitCount("1,000+ matches", "capped")), `a 1,500-hit query reads "1,000+ matches" (capped)`);

  // ---------------------------------------------------------------- (C)
  h.section("idle, never per keystroke");
  const burst = await page.evaluate(async () => {
    const v = window.__fluxView;
    const perf = window.__flux.paperPerf;
    const raf2 = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    await new Promise((r) => setTimeout(r, 300));
    const before = perf.findCounts;
    let caret = v.state.doc.toString().indexOf("Nothing");
    for (let i = 0; i < 12; i++) {
      v.dispatch({ changes: { from: caret, insert: "q" }, selection: { anchor: caret + 1 }, userEvent: "input.type" });
      caret++;
      await raf2();
    }
    const during = perf.findCounts - before;
    await new Promise((r) => setTimeout(r, 450));
    return { during, after: perf.findCounts - before };
  });
  h.eq(burst.during, 0, "a 12-key typing burst with the bar open runs ZERO match counts");
  h.eq(burst.after, 1, "one count lands on the settle after the burst");

  // ---------------------------------------------------------------- (D)
  await page.focus('.cm-search input[name="search"]');
  await page.keyboard.press("Escape");
  await waitFor(page, () => !document.querySelector(".cm-search"), null, { timeout: 2000, label: "Escape closes" }).catch(() => {});
  h.ok(!(await page.evaluate(() => !!document.querySelector(".cm-search"))), "Escape closes the find bar");
  const errs = realErrors(page);
  h.ok(errs.length === 0, errs.length ? `page errors: ${errs[0]}` : "no page errors");
} catch (e) {
  h.fail(`run threw: ${String((e && e.stack) || e)}`);
  await shot(page, "paper-find-EXCEPTION").catch(() => {});
}

await h.done(() => browser.close());
