// Outline refresh: every heading must reach the structure summary WITHOUT the
// user typing. CodeMirror parses lazily — init covers only the first ~3k chars,
// edits parse only to the viewport, and the background worker (which stops
// ~100k past the viewport) commits progress via NON-doc-change transactions —
// so a bare-tree walk refreshed only on docChanged dropped every heading past
// the parsed prefix until the next keystroke (owner-reported 2026-08-04).
// Pins the fix: getOutline's forced whole-document parse, PaperMode's
// parse-progress listener, and refreshIdleNow's self-reschedule to doc end.
//   Run (dev server on :1420 must be up): node scripts/verify-outline-refresh.mjs
import { launch, gotoApp, clickMode, realErrors, setDoc, shot, waitFor } from "./lib/driver.mjs";
import { harness } from "./lib/harness.mjs";

const h = harness("verify-outline-refresh");
const { browser, page } = await launch();

try {
  await gotoApp(page, { url: "http://127.0.0.1:1420/?fixture=demo", settle: 3500 });
  await clickMode(page, "Paper").catch(() => {});
  await waitFor(page, () => !!(window.__fluxView || (window.__flux?.editors ?? [])[0]), null, {
    timeout: 15000,
    label: "paper editor mounted",
  });
  await waitFor(page, () => !!document.querySelector("aside.outline"), null, {
    timeout: 5000,
    label: "outline pane visible",
  });

  // ~950k-char doc: far beyond the ~3k init parse AND beyond the worker's
  // viewport+100k ceiling, so pre-fix the tail headings never arrived at all.
  const SECTIONS = 96;
  const filler =
    "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do\n" +
    "eiusmod tempor incididunt ut labore et dolore magna aliqua tellus.\n";
  const parts = ["# Top\n\n"];
  for (let i = 1; i <= SECTIONS; i++) {
    parts.push(`## Section ${i}\n\n`);
    for (let j = 0; j < 75; j++) parts.push(filler);
    parts.push("\n");
  }
  parts.push("# Bottom Anchor\n\nThe very last line.\n");
  const bigDoc = parts.join("");
  const wantRows = SECTIONS + 2;

  await setDoc(page, bigDoc);
  const len = await page.evaluate(() => {
    const view = window.__fluxView || (window.__flux?.editors ?? [])[0];
    return view.state.doc.length;
  });
  h.eq(len, bigDoc.length, `big doc installed (${bigDoc.length} chars)`);

  // The core assertion: NO further input of any kind — the outline must fill
  // in on its own as the tree completes.
  const rows = await waitFor(
    page,
    (want) => {
      const items = [...document.querySelectorAll("aside.outline .oitem")].map((el) =>
        (el.textContent || "").trim(),
      );
      return items.length === want && items[items.length - 1] === "Bottom Anchor" ? items : false;
    },
    wantRows,
    { timeout: 20000, label: `all ${wantRows} headings in the outline without typing` },
  ).catch(() => null);
  h.ok(!!rows, `outline reached all ${wantRows} headings with zero keystrokes`);
  if (rows) {
    h.eq(rows[0], "Top", "first heading present");
    h.eq(rows[40], "Section 40", "mid-document heading present (past the init-parse prefix)");
  }
  await shot(page, "outline-refresh-full");

  // Swap to a small doc: the outline must shrink to exactly the new headings
  // (no stale rows from the previous tree).
  await setDoc(page, "# One\n\nalpha\n\n## Two\n\nbeta\n\n# Three\n\ngamma\n");
  const small = await waitFor(
    page,
    () => {
      const items = [...document.querySelectorAll("aside.outline .oitem")].map((el) =>
        (el.textContent || "").trim(),
      );
      return items.length === 3 ? items : false;
    },
    null,
    { timeout: 5000, label: "outline shrinks to the new doc's 3 headings" },
  ).catch(() => null);
  h.eq(small, ["One", "Two", "Three"], "small-doc outline exact (no stale rows)");

  const errs = realErrors(page);
  h.ok(errs.length === 0, errs.length ? `page errors: ${errs[0]}` : "no page errors");
} catch (e) {
  h.fail(`run threw: ${String((e && e.message) || e)}`);
  await shot(page, "outline-refresh-EXCEPTION").catch(() => {});
}

await h.done(() => browser.close());
