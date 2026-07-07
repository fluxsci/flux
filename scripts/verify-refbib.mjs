// 2.2 gate (browser) — submittable references end-to-end: the export's References
// list carries initials + volume(issue) + pages via the ONE formatter; the
// citation-style toggle mechanism (setFrontMatterKey) flips chips + reordering
// live with a single-line front-matter dispatch (feel invariant 9).
//   Run (dev server on :1420): node scripts/verify-refbib.mjs
import { launch, gotoApp, clickNew, sleep, realErrors } from "./lib/driver.mjs";

let fails = 0;
const ok = (cond, msg) => (cond ? console.log("  ✓ " + msg) : (fails++, console.log("  ✗ " + msg)));

const { browser, page } = await launch();
await gotoApp(page);
await clickNew(page);
await sleep(1200);
await page.waitForFunction(() => window.__fluxView && window.__fluxSeedBib, { timeout: 15000 });

const r = await page.evaluate(async () => {
  window.__fluxSeedBib([
    {
      key: "watson1953",
      title: "Molecular structure of nucleic acids",
      authors: ["Watson", "Crick"],
      authorsFull: [
        { family: "Watson", given: "James Dewey" },
        { family: "Crick", given: "Francis Harry Compton" },
      ],
      year: "1953",
      container: "Nature",
      volume: "171",
      issue: "4356",
      pages: "737-738",
      doi: "10.1038/171737a0",
    },
    { key: "zuse1936", title: "Rechenmaschinen", authors: ["Zuse"], year: "1936", container: "Z. Dinge" },
  ]);
  const v = window.__fluxView;
  const doc = ["---", 'title: "Refs"', "---", "", "First [@zuse1936] then [@watson1953]."].join("\n");
  v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: doc }, selection: { anchor: 0 } });
  await new Promise((s) => setTimeout(s, 400));

  const { renderManuscript } = await import("/src/shell/modes/paper/render/renderManuscript.ts");
  const ay = (await renderManuscript(v.state.doc.toString(), {})).full;

  // Flip to numeric via the SAME mechanism the toggle/⌘K use.
  const { setFrontMatterKey } = await import("/src/shell/modes/paper/scholar/frontMatter.ts");
  setFrontMatterKey(v, "citation-style", "numeric");
  await new Promise((s) => setTimeout(s, 500));
  const srcAfter = v.state.doc.toString();
  // NOTE: importing citeNumbering here can yield a SECOND module instance in dev —
  // the chips (which read the app's store) are the honest probe of the store flip.
  const { citationStyleOf } = await import("/src/shell/modes/paper/scholar/citeNumbering.ts");
  const styleNow = citationStyleOf(srcAfter);
  const chipTexts = [...document.querySelectorAll(".flux-chip")].map((e) => e.textContent || "");
  const num = (await renderManuscript(srcAfter, {})).full;

  // And back (idempotent single-line replace, no duplicate keys).
  setFrontMatterKey(v, "citation-style", "author-year");
  await new Promise((s) => setTimeout(s, 300));
  const backSrc = v.state.doc.toString();

  return {
    ayRef: /Watson, J\. D\., &amp; Crick, F\. H\. C\. \(1953\)/.test(ay) || /Watson, J\. D\., & Crick, F\. H\. C\. \(1953\)/.test(ay),
    ayLocator: ay.includes("171(4356), 737–738."),
    fmLine: /citation-style: numeric/.test(srcAfter),
    styleNow,
    chipNumeric: chipTexts.some((t) => /^\[\d/.test(t)),
    numOrdered: num.indexOf("Zuse") < num.indexOf("Watson JD"),
    numShape: num.includes("Watson JD, Crick FHC.") && num.includes("1953;171(4356):737–738"),
    backOnce: (backSrc.match(/citation-style:/g) || []).length === 1 && /citation-style: author-year/.test(backSrc),
  };
});

ok(r.ayRef, "author-year References: initials + ampersand + (year)");
ok(r.ayLocator, "author-year References: volume(issue), en-dash pages");
ok(r.fmLine, "toggle wrote `citation-style: numeric` into the front matter");
ok(r.styleNow === "numeric", `citationStyle store flipped (${r.styleNow})`);
ok(r.chipNumeric, "chips re-labelled to [n] live");
ok(r.numOrdered, "numeric References ordered by first appearance");
ok(r.numShape, "numeric References: Vancouver shape with locator");
ok(r.backOnce, "toggling back replaces the SAME line (no duplicates)");

const errs = realErrors(page);
ok(errs.length === 0, errs.length ? `console errors: ${errs.join(" | ").slice(0, 250)}` : "zero console errors");
await browser.close();
console.log(fails ? `\nREFBIB VERIFY: FAIL — ${fails}` : "\nREFBIB VERIFY: PASS");
process.exit(fails ? 1 : 0);
