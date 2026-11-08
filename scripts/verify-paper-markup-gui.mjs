// Paper markup — the 2026-11-08 batch, through the real UI.
//
// §A  The title pill's Save is BYTE-MINIMAL: a front matter with affiliations,
//     ORCID, flags and comments keeps every byte but the edited title (the old
//     Save re-dumped the block and deleted them). One Ctrl+Z restores it.
// §B  Superscript / subscript: typing `CO~2~` renders a real lowered span with
//     the markers hidden off-caret; `Ca^2+^` a raised one; markers show at the
//     caret; the line is exactly as tall as a plain line; `~~x~~` stays strike.
// §C  Ctrl+. / Ctrl+, wrap the selection (and unwrap it again); one undo each.
// §D  Spelling never flags a sup/sub word (real Harper).
// §E  The Preview renders <sup>/<sub>.
// §F  Export dialog → References: a shipped style copies its CSL into
//     references/styles/ and writes ONE `csl:` line; Default removes it again;
//     Load .csl file… copies a picked file and offers it by its title.
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

await page.evaluateOnNewDocument(() => {
  try {
    const values = JSON.parse(localStorage.getItem("flux.settings") || "{}");
    localStorage.setItem("flux.settings", JSON.stringify({ ...values, paperLocalCorrections: true }));
  } catch {
    /* the sandboxed Preview iframe has no storage */
  }
});
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

// ---------------------------------------------------------------- §B rendering
h.section("B · sup/sub render in the editor");
const lineInfo = () =>
  page.evaluate(() => {
    const lines = [...document.querySelectorAll(".cm-content .cm-line")];
    return lines.map((l) => ({ text: l.innerText, h: Math.round(l.getBoundingClientRect().height * 10) / 10 }));
  });
await setDoc("Plain line here.\n\nUptake of CO~2~ and Ca^2+^ rose, but ~~gone~~ stays struck.\n\nLast line.\n", 0);
await paints();
const supsub = await page.evaluate(() => ({
  sub: [...document.querySelectorAll(".cm-flux-sub")].map((e) => e.textContent),
  sup: [...document.querySelectorAll(".cm-flux-sup")].map((e) => e.textContent),
  subTop: (() => { const e = document.querySelector(".cm-flux-sub"); return e ? getComputedStyle(e).top : null; })(),
}));
h.eq(supsub.sub, ["2"], "CO~2~ content is a .cm-flux-sub span");
h.eq(supsub.sup, ["2+"], "Ca^2+^ content is a .cm-flux-sup span");
let li = await lineInfo();
h.eq(li[2].text, "Uptake of CO2 and Ca2+ rose, but gone stays struck.", "off-caret the single markers are hidden (strike markers too, as before)");
h.eq(li[2].h, li[0].h, "a line holding sup/sub is exactly as tall as a plain line");
// A replace decoration renders widget-buffer <img>s — line-break opportunities
// that wrapped `H~2~O` as `H` / `₂O`. The markers hide as display:none marks.
h.ok(await page.evaluate(() => {
  const subs = [...document.querySelectorAll(".cm-flux-sub, .cm-flux-sup")];
  return subs.length > 0 && subs.every((e) => !e.previousElementSibling?.matches?.("img.cm-widgetBuffer") && !e.nextElementSibling?.matches?.("img.cm-widgetBuffer"));
}), "no widget-buffer image (a break opportunity) sits beside a sup/sub span");
// One keypress per line through a line with hidden markers (goal column kept).
await page.evaluate(() => {
  const v = window.__fluxView;
  v.dispatch({ selection: { anchor: 12 } });
  v.focus();
});
const lineSeq = [];
for (let i = 0; i < 4; i++) {
  await page.keyboard.press("ArrowDown");
  lineSeq.push(await page.evaluate(() => { const v = window.__fluxView; return v.state.doc.lineAt(v.state.selection.main.head).number; }));
}
h.eq(lineSeq, [2, 3, 4, 5], "ArrowDown visits each line once across the sup/sub line");
await page.evaluate(() => {
  const v = window.__fluxView;
  v.dispatch({ selection: { anchor: v.state.doc.toString().indexOf("~2~") + 1 } });
});
await paints();
li = await lineInfo();
h.ok(li[2].text.includes("CO~2~"), "with the caret in the span its markers show for editing");
h.eq(li[2].h, li[0].h, "…and the line height does not move");
// Real typing: the construct appears as you close it.
await page.evaluate(() => {
  const v = window.__fluxView;
  v.dispatch({ selection: { anchor: v.state.doc.line(5).to } });
  v.focus();
});
await page.keyboard.type(" Then H~2~O");
await page.keyboard.press("Home");
await paints();
h.ok(await page.evaluate(() => [...document.querySelectorAll(".cm-flux-sub")].length === 2), "typed H~2~O renders a second subscript");

// ---------------------------------------------------------------- §C chords
h.section("C · Ctrl+. / Ctrl+, wrap and unwrap");
const chord = async (key) => {
  await page.keyboard.down(MOD);
  await page.keyboard.press(key);
  await page.keyboard.up(MOD);
  await paints();
};
const select = (text, needle, from, len) =>
  page.evaluate(
    (t, n, f, l) => {
      const v = window.__fluxView;
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: t } });
      const at = v.state.doc.toString().indexOf(n) + f;
      v.dispatch({ selection: { anchor: at, head: at + l } });
      v.focus();
    },
    text,
    needle,
    from,
    len,
  );
await select("CO2 gas and Ca2+ ions.\n", "CO2", 2, 1);
await chord(",");
h.eq(await docText(), "CO~2~ gas and Ca2+ ions.\n", "Ctrl+, wraps the selection as a subscript");
await chord(",");
h.eq(await docText(), "CO2 gas and Ca2+ ions.\n", "Ctrl+, again unwraps it");
await page.evaluate(() => {
  const v = window.__fluxView;
  const at = v.state.doc.toString().indexOf("2+");
  v.dispatch({ selection: { anchor: at, head: at + 2 } });
});
await chord(".");
h.eq(await docText(), "CO2 gas and Ca^2+^ ions.\n", "Ctrl+. wraps the selection as a superscript");
await page.keyboard.down(MOD);
await page.keyboard.press("z");
await page.keyboard.up(MOD);
await paints();
h.eq(await docText(), "CO2 gas and Ca2+ ions.\n", "one Ctrl+Z undoes the wrap");
// The selection toolbar has the same two buttons.
await page.evaluate(() => {
  const v = window.__fluxView;
  const at = v.state.doc.toString().indexOf("CO2") + 2;
  v.dispatch({ selection: { anchor: at, head: at + 1 } });
});
const subBtn = await page.waitForSelector('.bubble button[title^="Subscript"]', { timeout: 3000 }).catch(() => null);
h.ok(!!subBtn && !!(await page.$('.bubble button[title^="Superscript"]')), "the selection toolbar offers Superscript and Subscript");
if (subBtn) {
  await page.$eval('.bubble button[title^="Subscript"]', (b) => b.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true })));
  h.eq(await docText(), "CO~2~ gas and Ca2+ ions.\n", "the toolbar's Subscript wraps the selection");
}

// ---------------------------------------------------------------- §D spelling
h.section("D · spelling skips sup/sub words");
await setDoc("Uptake of Ca^2+^ in H~2~O and CO~2~ rose within 10^-3^ s, said teh lab.\n\nReady.\n", 0);
await page.evaluate(() => {
  const v = window.__fluxView;
  v.dispatch({ selection: { anchor: v.state.doc.length } });
  v.focus();
});
await page.keyboard.type(" ");
const flagged = await waitFor(page, () => [...document.querySelectorAll(".cm-spelling-issue")].some((e) => e.textContent === "teh"), null, { timeout: 18000, label: "Harper flags teh" }).then(() => true, () => false);
h.ok(flagged, "real spelling ran on the paragraph (teh is flagged)");
const issues = await page.evaluate(() => [...document.querySelectorAll(".cm-spelling-issue")].map((e) => e.textContent));
h.ok(!issues.some((t) => /Ca|H|O|CO|2|s/.test(t) && t !== "teh"), `no sup/sub word is flagged (${JSON.stringify(issues)})`);

// ---------------------------------------------------------------- §E preview
h.section("E · Preview renders sup/sub");
await setDoc("# Results\n\nUptake of CO~2~ and Ca^2+^ rose.\n", 0);
await page.keyboard.down(MOD);
await page.keyboard.down("Shift");
await page.keyboard.press("e");
await page.keyboard.up("Shift");
await page.keyboard.up(MOD);
const previewHtml = await waitFor(
  page,
  () => document.querySelector('iframe[title="Manuscript preview"]')?.srcdoc?.includes("CO<sub>2</sub>") ?? false,
  null,
  { timeout: 10000, label: "preview <sub>" },
).then(() => true, () => false);
h.ok(previewHtml, "the Preview prints CO<sub>2</sub>");
h.ok(await page.$eval('iframe[title="Manuscript preview"]', (f) => f.srcdoc.includes("Ca<sup>2+</sup>")), "the Preview prints Ca<sup>2+</sup>");
await page.keyboard.press("Escape");

// ---------------------------------------------------------------- §F CSL picker
h.section("F · reference style picker writes csl:");
const ROOT = "/demo/myc-growth-paper";
const CSL_DOC = "---\ntitle: \"Spindles\"   # working\nauthor:\n  - name: Ada Lovelace\n    orcid: 0000-0002-1825-0097\n---\n\nText.\n";
await setDoc(CSL_DOC, CSL_DOC.length);
await paints();
await page.keyboard.down("Alt");
await page.keyboard.press("e");
await page.keyboard.up("Alt");
await waitFor(page, () => (document.querySelector('select[aria-label="Reference style"]')?.options.length ?? 0) >= 5, null, { timeout: 5000, label: "reference style options" });
const optionLabels = await page.$$eval('select[aria-label="Reference style"] option', (os) => os.map((o) => o.textContent.trim()));
h.ok(["Nature", "Science", "Cell"].every((t) => optionLabels.includes(t)) && optionLabels.at(-1) === "Load .csl file…", `the picker lists the shipped styles + Load (${optionLabels.join(" | ")})`);
await page.select('select[aria-label="Reference style"]', "shipped:nature");
await waitFor(page, () => /\ncsl: /.test(window.__fluxView.state.doc.toString()), null, { timeout: 5000, label: "csl written" });
const cslLine = await page.evaluate(() => /\ncsl: (.*)\n/.exec(window.__fluxView.state.doc.toString())?.[1]);
h.ok(/^(\.\.\/)*references\/styles\/nature\.csl$/.test(cslLine ?? ""), `csl: points at the project copy (${cslLine})`);
h.eq(await docText(), CSL_DOC.replace("---\n\nText.", `csl: ${cslLine}\n---\n\nText.`), "only the csl: line was added (ORCID, comment, quoting intact)");
h.ok(await page.evaluate(async (root) => (await window.fig.readText(`${root}/references/styles/nature.csl`)).includes("<title>Nature</title>"), ROOT), "the shipped Nature CSL was copied into references/styles/");
await page.select('select[aria-label="Reference style"]', "");
await waitFor(page, () => !/\ncsl: /.test(window.__fluxView.state.doc.toString()), null, { timeout: 5000, label: "csl removed" });
h.eq(await docText(), CSL_DOC, "Pandoc default removes the line, restoring the exact text");
await page.evaluate(async () => {
  const csl = '<?xml version="1.0" encoding="utf-8"?>\n<style xmlns="http://purl.org/net/xbiblio/csl" class="in-text" version="1.0"><info><title>Journal of Testing</title><id>http://www.zotero.org/styles/journal-of-testing</id><category citation-format="author-date"/></info><citation><layout><text variable="title"/></layout></citation></style>\n';
  await window.fig.writeText("/demo/downloads/Journal of Testing.csl", csl);
  window.__fluxDemoOpenFiles = ["/demo/downloads/Journal of Testing.csl"];
});
await page.select('select[aria-label="Reference style"]', "__load__");
await waitFor(page, () => /\ncsl: .*journal-of-testing\.csl\n/.test(window.__fluxView.state.doc.toString()), null, { timeout: 5000, label: "loaded csl written" });
h.ok(await page.evaluate(async (root) => (await window.fig.readText(`${root}/references/styles/journal-of-testing.csl`)).includes("Journal of Testing"), ROOT), "Load .csl file… copies the picked style into the project");
h.ok(await page.$eval('select[aria-label="Reference style"]', (s) => s.selectedOptions[0]?.textContent.trim() === "Journal of Testing"), "…and the picker now shows it by its title");
await page.evaluate(() => { window.__fluxDemoOpenFiles = undefined; });
await page.keyboard.press("Escape");
await waitFor(page, () => !document.querySelector(".export-dialog"), null, { timeout: 3000, label: "export dialog closes" });

const errs = realErrors(page);
h.eq(errs, [], "console is clean");
if (h.failed) await shot(page, "paper-markup-gui-fail");
await browser.close();
await h.done();
