// Paper markup — the 2026-11-08 batch, through the real UI.
//
// §A  The title pill's Save is BYTE-MINIMAL: a front matter with affiliations,
//     ORCID, flags and comments keeps every byte but the edited title (the old
//     Save re-dumped the block and deleted them). One Ctrl+Z restores it.
//   FLUX_URL=http://127.0.0.1:1432/ node scripts/verify-paper-markup-gui.mjs
import { launch, gotoApp, clickMode, waitFor, APP_URL, realErrors, shot } from "./lib/driver.mjs";
import { harness } from "./lib/harness.mjs";

const h = harness("verify-paper-markup-gui");
const { browser, page } = await launch();
const MOD = await page.evaluate(() => (/Mac|iPhone|iPad/.test(navigator.platform) ? "Meta" : "Control"));
const paints = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
const docText = () => page.evaluate(() => window.__fluxView.state.doc.toString());
const setDoc = (text, anchor = 0) =>
  page.evaluate(
    (t, a) => {
      const v = window.__fluxView;
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: t }, selection: { anchor: a } });
      v.focus();
    },
    text,
    anchor,
  );

await gotoApp(page, { url: `${APP_URL}?fixture=demo`, settle: 900 });
await clickMode(page, "Paper");
await waitFor(page, () => !!window.__fluxView, null, { label: "paper editor" });

// ---------------------------------------------------------------- §A title pill
h.section("A · title pill save is byte-minimal");
const FM = `---
# Manuscript metadata: keep in sync with the cover letter
title: 'Sleep spindles gate CA1 replay'   # working title
author:
  - name: Ada Lovelace
    orcid: 0000-0002-1825-0097
    email: ada@example.org
    corresponding: true
    equal-contributor: true
    affiliations:
      - ref: ucl
  - name: Alan Turing
    lead-contact: true
    affiliations: [ucl]
affiliations:
  - id: ucl
    name: University College London   # campus
---

# Intro

Body prose.
`;
await setDoc(FM, FM.length);
await waitFor(page, () => document.querySelector(".titlepill-wrap")?.textContent?.includes("Sleep spindles"), null, { label: "pill shows the title" });
await page.focus(".titlepill-wrap .pill");
await page.keyboard.press("Enter");
await waitFor(page, () => !!document.querySelector(".te input"), null, { label: "title dialog" });
const seeded = await page.$$eval(".te input", (ns) => ns.map((n) => n.value));
h.eq(seeded, ["Sleep spindles gate CA1 replay", "Ada Lovelace, Alan Turing"], "dialog seeds the title and names the export reads");
await page.$eval(".te input", (n) => {
  n.select();
});
await page.keyboard.type("Spindles gate hippocampal replay");
await page.click(".te button.primary");
await waitFor(page, () => !document.querySelector(".te"), null, { label: "dialog closes on Save" });
await waitFor(page, () => window.__fluxView.state.doc.toString().includes("hippocampal"), null, { label: "title written" });
h.eq(await docText(), FM.replace("'Sleep spindles gate CA1 replay'", "'Spindles gate hippocampal replay'"),
  "Save changed ONLY the title scalar: affiliations, ORCID, flags, comments and quoting survive");
await page.keyboard.down(MOD);
await page.keyboard.press("z");
await page.keyboard.up(MOD);
await paints();
h.eq(await docText(), FM, "one Ctrl+Z restores the front matter exactly");

// Rename an author through the dialog: only that name changes.
await page.focus(".titlepill-wrap .pill");
await page.keyboard.press("Enter");
await waitFor(page, () => document.querySelectorAll(".te input").length === 2, null, { label: "title dialog again" });
await page.$$eval(".te input", (ns) => {
  const a = ns[1];
  a.value = "Ada Lovelace, Alan M. Turing";
  a.dispatchEvent(new Event("input", { bubbles: true }));
});
await page.click(".te button.primary");
await waitFor(page, () => window.__fluxView.state.doc.toString().includes("Alan M. Turing"), null, { label: "author renamed" });
h.eq(await docText(), FM.replace("  - name: Alan Turing", "  - name: Alan M. Turing"), "author rename keeps lead-contact + affiliations");

const errs = realErrors(page);
h.eq(errs, [], "console is clean");
if (h.failed) await shot(page, "paper-markup-gui-fail");
await browser.close();
await h.done();
