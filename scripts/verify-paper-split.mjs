// Dual-paper panes (2026-08-11): two Paper panes side-by-side must be genuinely
// independent — separate documents, separate editors, separate margin stacks,
// separate flush registrations — and the per-editor widget-handler registry
// must route a chip interaction into the pane that OWNS the element (the old
// module-global handlers were overwritten by every mount, so pane A's chips
// dispatched through pane B's closures). Also pins the B4 rule: two panes may
// never edit the SAME document — the request focuses the claiming pane.
//   Run (dev server on :1420 must be up): node scripts/verify-paper-split.mjs
import { launch, gotoApp, clickMode, realErrors, shot, waitFor } from "./lib/driver.mjs";
import { harness } from "./lib/harness.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const h = harness("verify-paper-split");
const { browser, page } = await launch();

try {
  await gotoApp(page, { url: "http://127.0.0.1:1420/?fixture=demo", settle: 3500 });
  await clickMode(page, "Paper").catch(() => {});
  await waitFor(page, () => (window.__flux?.editors ?? []).length === 1, null, {
    timeout: 15000,
    label: "single paper editor mounted",
  });

  h.section("split: Alt+click Paper opens a second, independent paper pane");
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button[aria-label="Paper"]')].at(-1);
    b.dispatchEvent(new MouseEvent("click", { bubbles: true, altKey: true }));
  });
  await waitFor(page, () => (window.__flux?.editors ?? []).length === 2, null, {
    timeout: 10000,
    label: "two live editors",
  });
  h.eq(await page.$$eval(".slot > .pane section.paper", (els) => els.length), 2, "two paper panes in the DOM");
  h.ok(
    (await page.$$eval(".twin-blocked", (els) => els.length)) === 0,
    "second pane found a free document (demo has main + supplement) — not blocked",
  );

  const docsOf = () =>
    page.evaluate(() => (window.__flux?.editors ?? []).map((v) => v.state.doc.toString()));
  let docs = await docsOf();
  h.ok(docs.length === 2 && docs[0] !== docs[1], "the two panes hold DIFFERENT documents");

  h.section("editing one pane never touches the other");
  const before = await docsOf();
  await page.evaluate(() => {
    const v = (window.__flux?.editors ?? [])[1];
    v.dispatch({ changes: { from: v.state.doc.length, insert: "\nSplit-pane probe line." }, userEvent: "input" });
  });
  await sleep(300);
  docs = await docsOf();
  h.ok(docs[1].endsWith("Split-pane probe line."), "typed text landed in pane B");
  h.eq(docs[0], before[0], "pane A's document is byte-identical after pane B's edit");

  h.section("flush registry: each pane holds its OWN paper entries (no eviction)");
  const flushIds = await page.evaluate(() => window.__fluxFlushables?.() ?? []);
  const paperIds = flushIds.filter((id) => /^paper-(?!comments)/.test(id));
  const commentIds = flushIds.filter((id) => /^paper-comments-/.test(id));
  h.ok(paperIds.length === 2 && paperIds[0] !== paperIds[1], `two distinct paper flushables (${paperIds.join(", ")})`);
  h.ok(commentIds.length === 2, `two comment flushables (${commentIds.join(", ")})`);

  h.section("margin stacks are per-pane: a summon opens in ONE margin only");
  // The focused pane is B (splitWith focuses the new pane) — __fluxMargin
  // follows focus, so this summons into B's margin.
  await page.evaluate(() => window.__fluxMargin.summon("stats"));
  await sleep(400);
  const stacks = await page.evaluate(() =>
    [...document.querySelectorAll(".slot > .pane")].map((p) => p.querySelectorAll("[data-pane-id]").length),
  );
  h.ok(stacks[1] > 0 && stacks[0] === 0, `summon landed only in the focused pane's margin (${stacks.join(" | ")})`);
  await page.evaluate(() => window.__fluxMargin.closeAll());

  h.section("chip handlers route per-editor: pane A's citation opens pane A's margin");
  // Pane B mounted LAST — under the old module-global handlers this dblclick
  // would dispatch through pane B's closures and summon B's margin (or throw).
  const chipClicked = await page.evaluate(() => {
    const paneA = document.querySelectorAll(".slot > .pane")[0];
    const chip = paneA.querySelector(".flux-chip.flux-cite");
    if (!chip) return false;
    chip.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    return true;
  });
  h.ok(chipClicked, "found a citation chip in pane A");
  await sleep(500);
  const groupPanes = await page.evaluate(() =>
    [...document.querySelectorAll(".slot > .pane")].map(
      (p) => p.querySelectorAll('[data-pane-id="citation-group"]').length,
    ),
  );
  h.ok(
    groupPanes[0] === 1 && groupPanes[1] === 0,
    `citation-group opened in pane A's margin, not pane B's (${groupPanes.join(" | ")})`,
  );

  h.section("B4: requesting the OTHER pane's document focuses that pane instead");
  // Pane B's document rail: click the row wearing the "main" badge — pane A's doc.
  const askedForMain = await page.evaluate(() => {
    const paneB = document.querySelectorAll(".slot > .pane")[1];
    const row = [...(paneB?.querySelectorAll(".dp-item") ?? [])].find((el) => el.querySelector(".dp-badge"));
    if (!row) return false;
    row.click();
    return true;
  });
  h.ok(askedForMain, "clicked the main document in pane B's rail");
  await sleep(500);
  docs = await docsOf();
  h.ok(docs[0] !== docs[1], "the two panes STILL hold different documents (request was refused)");

  h.section("closing the split returns to one pane, other editor intact");
  await page.evaluate(() => {
    const closes = [...document.querySelectorAll('.pbtn[title="Close pane"]')];
    closes.at(-1)?.click();
  });
  await waitFor(page, () => (window.__flux?.editors ?? []).length === 1, null, {
    timeout: 8000,
    label: "one editor after close",
  });
  const flushAfter = await page.evaluate(() => window.__fluxFlushables?.() ?? []);
  h.eq(
    flushAfter.filter((id) => /^paper-(?!comments)/.test(id)).length,
    1,
    "the closed pane's flushable was disposed",
  );

  await shot(page, "paper-split-final");
  const errs = realErrors(page);
  h.eq(errs.length, 0, `console clean (${errs.slice(0, 3).join(" | ")})`);
} finally {
  await browser.close();
}
await h.done();
