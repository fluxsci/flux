// Phase 4 — Paper bug sweep. The two render-fidelity fixes (PAP-6 caption index, PAP-13
// inline-code skip) are tested for REAL against the shipping renderer. renderManuscript isn't
// tsx-importable (it uses Vite-only import.meta.env), so we run it in the browser under the dev
// server — where import.meta.env is defined — via a dynamic import of the exact module the
// Preview pane uses (PreviewPane sets its <iframe srcdoc> to `(await renderManuscript(src)).full`,
// so this asserts on byte-identical output). The comment-anchoring fixes (PAP-4/8/9) and the
// citation-completion fix (PAP-5) are DOM/CM-bound; they're asserted present here and covered by
// svelte-check + the paper regressions.
//
//  PAP-6  (tested): a callout BEFORE a figure/table caption used to shift the caption index
//         (placeholders were keyed by blocks.length, which callouts inflate) → empty/wrong
//         captions in Preview AND every export. Now keyed by the caption counter.
//  PAP-13 (tested): @cite/@fig inside inline code stayed literal in the editor but got rewritten
//         in Preview/export. Now the renderer skips code spans, matching the editor.
//  PAP-4  (presence): applyDiskText re-anchors comment marks to the reloaded text (agent edit →
//         human review no longer detaches every thread).
//  PAP-5  (presence): citation completion is bracket-aware (no more `[[@key]` inside a group).
//  PAP-8  (presence): CommentsView buckets by resolved-status, so resolved threads are reopenable.
//  PAP-9  (presence): resolveComment snapshots the live range into the anchor before dropping
//         the mark (reopen re-anchors correctly).
//   Run (dev server on :1420 must be up): node scripts/verify-p4-paper.mjs
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { launch, gotoApp, clickMode, sleep, realErrors } from "./lib/driver.mjs";

function assert(cond, msg) {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("  ok:", msg);
}

// A callout, then a figure caption, then a table caption, then a prose+code citation line.
// The callout is the non-caption block that inflates blocks.length (the PAP-6 trigger); the
// figure caption "Growth over time" is stashed at caption-index 0 — under the old bug the
// figure placeholder pointed at index 1, so this text NEVER appeared. The inline-code cite is
// identical to the prose cite so the ONLY difference is code-vs-prose handling (PAP-13).
const bt = "`";
const DOC = [
  "::: {.callout-note}",
  "Callout body text.",
  ":::",
  "",
  "![Growth over time](../fig/renders/growth.svg){#fig-growth}",
  "",
  ": My data table {#tbl-data}",
  "",
  `Prose [@smith2020] and code ${bt}[@smith2020]${bt} here.`,
  "",
].join("\n");

const { browser, page } = await launch();
await gotoApp(page, { url: "http://127.0.0.1:1420/?fixture=demo", settle: 3500 });
await clickMode(page, "Paper").catch(() => {}); // warm the paper module graph
await sleep(400);

const res = await page.evaluate(async (doc) => {
  try {
    // The exact module PreviewPane renders through; in the browser import.meta.env.DEV is set.
    const mod = await import("/src/shell/modes/paper/render/renderManuscript.ts");
    const r = await mod.renderManuscript(doc, {});
    return { srcdoc: r.full };
  } catch (e) {
    return { error: String((e && e.message) || e) };
  }
}, DOC);

const errs = realErrors(page); // drops the pre-existing demo-asset 404
await browser.close();

if (res.error) {
  console.error("\nP4 PAPER VERIFY: FAIL —", res.error);
  process.exit(1);
}
const html = res.srcdoc;

console.log("PAP-6 — figure/table captions survive a preceding callout:");
// Decisive: under the old blocks.length index, capStash[0]="Growth over time" was never
// referenced (placeholders were CAP1/CAP2), so this string could not appear at all.
assert(html.includes("Growth over time"), "PAP-6: figure caption text is rendered");
assert(
  /<figure[^>]*id="fig-growth"[\s\S]*?Growth over time[\s\S]*?<\/figure>/.test(html),
  "PAP-6: the caption lands inside the fig-growth <figcaption> (not shifted onto another block)",
);
assert(html.includes("My data table"), "PAP-6: the table caption text is rendered too");

console.log("PAP-13 — inline code is left literal; prose citations still linkify:");
assert(
  html.includes("<code>[@smith2020]</code>"),
  "PAP-13: [@smith2020] inside inline code is emitted verbatim (not rewritten to a link)",
);
assert(
  html.includes('href="#ref-smith2020"'),
  "PAP-13: the prose [@smith2020] is still transformed into a citation link",
);

console.log("presence of the CM/DOM-bound fixes:");
const read = (p) => fs.readFile(path.join(import.meta.dirname, "..", p), "utf8");
const [paperMode, completions, commentsView] = await Promise.all([
  read("src/shell/modes/paper/PaperMode.svelte"),
  read("src/shell/modes/paper/scholar/completions.ts"),
  read("src/shell/modes/paper/margin/views/CommentsView.svelte"),
]);
assert(
  (paperMode.match(/reanchorComments\(\)/g) || []).length >= 2 &&
    /reanchorComments\(\);\s*\/\/\s*PAP-4/.test(paperMode),
  "PAP-4: applyDiskText re-anchors comments after an external reload",
);
assert(
  /function applyCite/.test(completions) && /apply:\s*applyCite\(/.test(completions),
  "PAP-5: citation completion applies bracket-aware (applyCite)",
);
assert(
  /t\.draft \|\| t\.resolved \|\| c\.ranges\.has\(t\.id\)/.test(commentsView),
  "PAP-8: CommentsView buckets by resolved-status (resolved threads reopenable)",
);
assert(
  /live \? makeAnchor\(doc, live\.from, live\.to\)/.test(paperMode),
  "PAP-9: resolveComment snapshots the live range into the anchor before removing the mark",
);

if (errs.length) {
  console.error("\nP4 PAPER VERIFY: FAIL — console errors:", JSON.stringify(errs, null, 2));
  process.exit(1);
}
console.log("\nP4 PAPER VERIFY: PASS");
