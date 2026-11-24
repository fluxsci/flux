// Paper's artifacts in the GUI (dev server, the demo fixture): the Artifacts part of the Files
// rail, an artifact in the centre card in place of the document, its strip and page tabs, the
// rail's Outline reading the page's headings, the page staying where the reader is across a
// reload, the app's chords from inside a page, a comment made on a page (Annotate) naming the
// page, its view, its heading and the selected words, the palette, and the last artifact coming
// back with the project.
//
// The pages come from the dev server's artifact route (scripts/lib/artifactDevRoutes.mjs), which
// runs the app's own lister and file server over scripts/fixtures/artifacts. What only the real
// app can show (the flux-artifact: origin and process, the page policy, the watcher) is
// verify-artifacts-electron.cjs.
import { launch, gotoApp, clickMode, waitFor, APP_URL, realErrors, shot, sleep } from "./lib/driver.mjs";
import { harness } from "./lib/harness.mjs";
import { perfBudget } from "./lib/perfBudget.mjs";
import { openAnnotation, fillNote, ledger } from "./lib/annotationFixture.mjs";

const h = harness("verify-paper-artifacts-gui");
const { browser, page } = await launch({ width: 1500, height: 950 });
const view = () => page.evaluate(() => { const v = document.querySelector(".aview"); return v ? { ...v.dataset } : null; });
const ready = (pageRel) => waitFor(page, (rel) => { const v = document.querySelector(".aview"); return v?.dataset.artifactReady === "true" && (!rel || v.dataset.artifactPage === rel); }, pageRel ?? null, { label: `artifact page ${pageRel ?? ""} ready`, timeout: 15000 });
const frame = () => page.frames().find((f) => f.url().includes("/__flux-dev/artifacts/serve/"));
const row = (title) => page.evaluate((t) => { const el = [...document.querySelectorAll("[data-artifact-row]")].find((e) => e.querySelector(".a-title")?.textContent === t); if (!el) throw new Error(`no artifact row "${t}"`); el.click(); }, title);
const outline = () => page.$$eval(".outline .oitem", (els) => els.map((e) => `${e.classList.contains("active") ? "*" : ""}${e.textContent.trim()}`));
const emit = (info) => page.evaluate((i) => window.__fluxEmitArtifactsChanged(i), info);

try {
  await gotoApp(page, { url: `${APP_URL}?fixture=demo`, settle: 1000 });
  await clickMode(page, "Paper");
  await waitFor(page, () => !!document.querySelector("[data-artifact-row]"), null, { label: "artifact rows", timeout: 15000 });

  h.section("the rail");
  const rail = await page.evaluate(() => {
    const scroll = document.querySelector(".dp-scroll");
    const heads = [...scroll.querySelectorAll(".dp-head .folder-label, .a-head .a-label")].map((e) => e.textContent.trim());
    const head = scroll.querySelector('[data-artifact-root="project"]');
    const list = head.nextElementSibling;
    return { heads, rows: [...list.querySelectorAll(".a-title, .a-name")].map((e) => e.textContent), pages: list.querySelector("[data-artifact-row] .a-pages")?.textContent,
      age: !!list.querySelector("[data-artifact-row] .a-age")?.textContent, ref: list.querySelector("[data-artifact-row]").title };
  });
  h.eq(rail.heads.slice(0, 3), ["Documents", "Context", "Artifacts"], "Artifacts is the third part of the Files rail, under Documents and Context");
  h.eq(rail.rows, ["Growth explorer", "reports", "Summary of the & first run"], "it lists the project's artifacts: an explorer, and a page inside a folder");
  h.ok(rail.pages === "2" && rail.age && rail.ref.split("\n")[0] === "scripts/fixtures/artifacts/explorer/index.html" && /^changed /.test(rail.ref.split("\n")[1]), "a row says how many pages, how fresh, and (as its tooltip) where the page is and when it changed");
  const listing = await page.evaluate(() => window.fig.artifactsList());
  const explorer = listing.roots[0].artifacts.find((a) => a.rel === "explorer");

  // The rail is one list to the keyboard: the walk goes on from Context into Artifacts, and a group folds on ←.
  await page.evaluate(() => [...document.querySelectorAll(".dp-scroll .dp-item:not([data-artifact-row])")].at(-1).focus());
  const walked = [];
  for (let i = 0; i < 4; i++) { await page.keyboard.press("ArrowDown"); walked.push(await page.evaluate(() => (document.activeElement.querySelector(".a-eyebrow, .a-name, .a-title")?.textContent ?? document.activeElement.textContent).trim())); }
  h.eq(walked, ["Artifacts", "Growth explorer", "reports", "Summary of the & first run"], "↓ walks from the last document into Artifacts, row by row");
  await page.keyboard.press("ArrowLeft");
  h.eq(await page.evaluate(() => document.activeElement.querySelector(".a-name")?.textContent), "reports", "← on a page steps out to its group");
  await page.keyboard.press("ArrowLeft");
  h.eq(await page.$$eval("[data-artifact-row] .a-title", (els) => els.map((e) => e.textContent)), ["Growth explorer"], "← on the group folds it");
  await page.keyboard.press("ArrowRight");
  h.eq(await page.$$eval("[data-artifact-row] .a-title", (els) => els.length), 2, "→ opens it again");

  h.section("an artifact in place of the document");
  h.ok(await page.evaluate(() => !document.querySelector(".aview") && !!document.querySelector(".dp-item.active:not([data-artifact-row])")), "Paper starts on the document");
  const t0 = Date.now();
  await row("Growth explorer");
  await ready("explorer/index.html");
  const opened = Date.now() - t0;
  const budget = perfBudget(1000);
  h.ok(opened < budget.ms, `opening an artifact is a navigation: ${opened} ms (< ${budget.text} ms)`);
  const shown = await page.evaluate(() => ({
    editor: getComputedStyle(document.querySelector(".editor-col")).display, cm: !!document.querySelector(".editor-col .cm-editor"), margin: !!document.querySelector(".dm-wrap"),
    active: [...document.querySelectorAll(".dp-item.active")].map((e) => e.dataset.artifactRow ? "artifact" : "document"),
    title: document.querySelector(".aview .title").textContent, tabs: [...document.querySelectorAll(".aview .page")].map((e) => `${e.classList.contains("on") ? "*" : ""}${e.textContent}`),
    sandbox: document.querySelector(".aview iframe").getAttribute("sandbox"), src: document.querySelector(".aview iframe").getAttribute("src"),
    card: (() => { const a = document.querySelector(".artifact-col").getBoundingClientRect(), w = document.querySelector(".work").getBoundingClientRect(), r = document.querySelector(".leftrail").getBoundingClientRect(); return { fills: w.right - a.right < 40, besideRail: a.left - r.right < 40 }; })(),
  }));
  h.ok(shown.editor === "none" && shown.cm, "the document's editor is hidden, still mounted");
  h.ok(!shown.margin && shown.card.fills && shown.card.besideRail, "the page takes the document's card and the margin's room");
  h.eq(shown.active, ["artifact"], "the rail marks the artifact, not the document");
  h.eq([shown.title, shown.tabs], ["Growth explorer", ["*index", "methods"]], "the strip names the page and offers the artifact's pages");
  h.ok(!/allow-same-origin|allow-top-navigation|allow-popups/.test(shown.sandbox) && /allow-scripts/.test(shown.sandbox), `on the dev server the page shares the app's site, so the frame is sandboxed into an origin of its own (${shown.sandbox})`);
  h.eq(shown.src, explorer.pages[0].url, "the frame loads the page's own address");
  h.eq(await frame().evaluate(() => [document.body.dataset.series, typeof window.fig, typeof window.__fluxArtifactBridge]), ["control", "undefined", "boolean"], "the page's scripts ran; it has the bridge and nothing of the app's");
  h.eq(await outline(), ["Growth under nutrient stress", "Curve", "Table", "Notes", "End"].map((t, i) => (i === 0 ? "*" : "") + t), "the rail's Outline reads the page's headings, the one in view marked");
  h.eq(await page.$eval(".outline .ohead", (e) => e.textContent), "Growth explorer", "under the page's title");
  await shot(page, "paper-artifact-open");

  h.section("where the reader is");
  await frame().select("#series", "stressed");
  await waitFor(page, () => document.querySelector(".aview")?.dataset.artifactView === "#s=stressed", null, { label: "the view reaches the strip" });
  h.eq(await page.$eval(".aview .viewchip", (e) => e.textContent), "#s=stressed", "the strip shows the page's own address: where in it the reader is");
  await page.evaluate(() => [...document.querySelectorAll(".outline .oitem")].find((e) => e.textContent.trim() === "End").click());
  await waitFor(page, () => document.querySelector(".outline .oitem.active")?.textContent.trim() === "End", null, { label: "the outline follows the page" });
  const scrolled = await frame().evaluate(() => Math.round(scrollY));
  h.ok(scrolled > 800, `a heading in the Outline scrolls the page to it (${scrolled} px), and the Outline follows`);

  h.section("following the files");
  await frame().evaluate(() => { window.__mark = 1; });
  await emit({ paths: [explorer.dir.replace(/explorer$/, "reports") + "/summary.html"], structure: false });
  await sleep(900); // a reload would come 500 ms after the change: its absence is the claim
  h.eq(await frame().evaluate(() => window.__mark), 1, "another artifact's files changing reloads nothing here");
  const loadKey = () => page.$eval(".aview", (e) => e.dataset.artifactLoad);
  const swapped = (before) => waitFor(page, (b) => { const v = document.querySelector(".aview"); return !!v && v.dataset.artifactLoad !== b && v.querySelectorAll("iframe").length === 1; }, before, { label: "the reloaded page takes the place of the one on screen", timeout: 8000 });
  let before = await loadKey();
  await emit({ paths: [explorer.dir + "/data.js"], structure: false });
  await waitFor(page, () => !!document.querySelector(".aview .key.pulse"), null, { label: "the follow key lights as the page reloads" });
  // The new page loads UNDER the one on screen: until it has answered and scrolled, the reader keeps the old one.
  await waitFor(page, () => document.querySelectorAll(".aview iframe").length === 2 || document.querySelector(".aview")?.dataset.artifactLoad !== "1", null, { label: "the reload is under way" });
  await swapped(before);
  const landed = await frame().evaluate(() => [typeof window.__mark, document.body.dataset.series, Math.round(scrollY)]);
  h.eq(landed.slice(0, 2), ["undefined", "stressed"], "a file of this artifact changing reloads the page: a fresh page, on the same view");
  h.ok(Math.abs(landed[2] - scrolled) <= 4, `it takes the old page's place already scrolled to where the reader was (${landed[2]} vs ${scrolled} px): no blink, no jump`);
  h.eq([(await view()).artifactView, (await outline()).find((t) => t.startsWith("*"))], ["#s=stressed", "*End"], "the strip and the Outline still say where the reader is");
  // Held still: the change is noted, the page stays.
  await page.click('.aview .key[aria-label="Follow changes on disk"]');
  await frame().evaluate(() => { window.__mark = 2; });
  await emit({ paths: [explorer.dir + "/app.js"], structure: false });
  await waitFor(page, () => !!document.querySelector(".aview .key.due"), null, { label: "the reload key says the files changed" });
  h.eq(await frame().evaluate(() => window.__mark), 2, "held still, the page does not reload; the reload key says the files changed");
  before = await loadKey();
  await page.click('.aview .key[aria-label="Reload the page"]');
  await swapped(before);
  h.ok(await page.evaluate(() => !document.querySelector(".aview .key.due")), "after a reload by hand the key is quiet again");
  h.eq(await frame().evaluate(() => typeof window.__mark), "undefined", "the reload key reads the page again");
  await page.click('.aview .key[aria-label="Follow changes on disk"]');

  h.section("pages, links and keys");
  await frame().click("#to-methods");
  await ready("explorer/methods.html");
  h.eq([await page.$$eval(".aview .page", (els) => els.map((e) => `${e.classList.contains("on") ? "*" : ""}${e.textContent}`)), await outline()], [["index", "*methods"], ["*Methods", "Measurement"]], "a link inside the artifact moves the page tab and the Outline");
  await page.evaluate(() => [...document.querySelectorAll(".aview .page")].find((e) => e.textContent === "index").click());
  await ready("explorer/index.html");
  h.ok((await outline()).includes("Curve"), "a page tab opens that page");
  await frame().click("h1");
  await page.keyboard.down("Alt"); await page.keyboard.press("KeyO"); await page.keyboard.up("Alt");
  await waitFor(page, () => !document.querySelector(".leftrail"), null, { label: "Alt+O from inside the page folds the rail" });
  await page.keyboard.down("Alt"); await page.keyboard.press("KeyO"); await page.keyboard.up("Alt");
  await waitFor(page, () => !!document.querySelector(".leftrail"), null, { label: "Alt+O again opens it" });
  h.ok(true, "with the keyboard in the page, Paper's chord (Alt+O) still folds and opens the rail");
  await page.keyboard.down("Alt"); await page.keyboard.press("KeyE"); await page.keyboard.up("Alt");
  await sleep(300); // an export dialog would open within a frame or two: its absence is the claim
  h.ok(await page.evaluate(() => !document.querySelector('[role="dialog"]')), "a chord that acts on the document (Export, Alt+E) does nothing while a page is showing");

  h.section("a comment on a page");
  await frame().select("#series", "stressed");
  await frame().evaluate(() => { const p = document.getElementById("lede"), r = document.createRange(); r.selectNodeContents(p); const s = getSelection(); s.removeAllRanges(); s.addRange(r); });
  await sleep(350); // the page reports a selection 150 ms after it settles
  await openAnnotation(page);
  const chips = await page.$eval(".target-chips", (e) => e.textContent);
  h.ok(chips.includes("Pick a series") && chips.includes("Growth explorer"), `Annotate, opened over a page, is about the selected words in that page (${chips.trim().slice(0, 90)})`);
  await fillNote(page, "Is the plateau real?");
  await page.$eval("[data-annotation-surface] button.primary", (b) => b.click());
  await waitFor(page, () => !document.querySelector("[data-annotation-surface]"), null, { label: "the note is saved" });
  const note = (await ledger(page)).filter((e) => e.kind === "note").at(-1);
  const target = note?.context?.targets?.[0];
  h.eq([target?.kind, target?.path, target?.view, target?.title, target?.quote?.slice(0, 13)], ["artifact", "scripts/fixtures/artifacts/explorer/index.html", "#s=stressed", "Growth explorer", "Pick a series"], "the saved note names the page, the view, and the words");
  h.eq([note?.context?.surface, note?.context?.artifact?.path, note?.context?.doc ?? null], ["paper", "scripts/fixtures/artifacts/explorer/index.html", null], "and its stamp is the artifact, not the hidden document");

  h.section("the palette, the filter, and back");
  await page.keyboard.down("Control"); await page.keyboard.press("KeyK"); await page.keyboard.up("Control");
  await page.waitForSelector(".cp input");
  await page.type(".cp input", "artifact: summary");
  await waitFor(page, () => document.querySelector(".cp li.sel .ct")?.textContent === "Open artifact: Summary of the & first run", null, { label: "the palette offers the artifact" });
  await page.keyboard.press("Enter");
  await ready("reports/summary.html");
  h.eq([await page.$eval(".aview .title", (e) => e.textContent), await page.$$eval(".aview .page", (els) => els.length), await frame().evaluate(() => document.getElementById("inline").dataset.ran)],
    ["Summary of the & first run", 0, "yes"], "the palette opens an artifact; a page in one file (inline style and script) runs, and has no page tabs");
  await page.focus('[aria-label="Filter documents"]');
  await page.keyboard.type("explorer");
  await waitFor(page, () => !!document.querySelector(".a-head.flat"), null, { label: "the filter reaches artifacts" });
  h.eq(await page.$$eval("[data-artifact-row] .a-title", (els) => els.map((e) => e.textContent)), ["Growth explorer"], "the rail's filter finds artifacts by title or folder");
  await page.keyboard.press("Escape");
  await waitFor(page, () => !document.querySelector(".a-head.flat"), null, { label: "the filter is cleared" });
  await page.click(".aview .key.close");
  await waitFor(page, () => !document.querySelector(".aview") && getComputedStyle(document.querySelector(".editor-col")).display !== "none", null, { label: "back on the document" });
  h.ok(await page.evaluate(() => document.activeElement?.closest(".cm-editor") !== null && !!document.querySelector(".dm-wrap") && !!document.querySelector(".dp-item.active:not([data-artifact-row])")), "the close key returns to the document: editor focused, margin back, the document marked in the rail");
  h.ok(await page.evaluate(() => window.__fluxView.state.doc.toString().includes("Mycelial extension increased")), "the document is as it was: never reloaded");
  // Alt+H: the document and the artifact last shown, either way round, from the editor and from inside the page.
  await page.keyboard.down("Alt"); await page.keyboard.press("KeyH"); await page.keyboard.up("Alt");
  await ready("reports/summary.html");
  h.ok(true, "Alt+H in the document shows the artifact last open");
  await frame().click("h1");
  await page.keyboard.down("Alt"); await page.keyboard.press("KeyH"); await page.keyboard.up("Alt");
  await waitFor(page, () => !document.querySelector(".aview") && document.activeElement?.closest(".cm-editor") !== null, null, { label: "Alt+H from inside the page returns to the document" });
  h.ok(true, "Alt+H pressed in the page goes back to the document");
  await row("Growth explorer");
  await ready("explorer/index.html");
  await page.evaluate(() => [...document.querySelectorAll(".dp-item:not([data-artifact-row])")].find((e) => e.textContent.includes("Supplementary")).click());
  await waitFor(page, () => !document.querySelector(".aview") && document.querySelector(".dp-item.active")?.textContent.includes("Supplementary"), null, { label: "a document row leaves the artifact" });
  h.ok(true, "choosing a document in the rail leaves the artifact for that document");
  await row("Growth explorer");
  await ready("explorer/index.html");
  await frame().select("#series", "stressed");
  await waitFor(page, () => document.querySelector(".aview")?.dataset.artifactView === "#s=stressed", null, { label: "a view to come back to" });
  await page.click(".aview .key.close");
  await waitFor(page, () => !document.querySelector(".aview"), null, { label: "closed" });
  await row("Growth explorer");
  await ready("explorer/index.html");
  h.eq([(await view()).artifactView, await frame().evaluate(() => document.body.dataset.series)], ["#s=stressed", "stressed"], "reopening the artifact last shown from the rail comes back to the view it was on");

  h.section("the last artifact comes back with the project");
  await row("Growth explorer");
  await ready("explorer/index.html");
  await frame().select("#series", "stressed");
  await waitFor(page, () => document.querySelector(".aview")?.dataset.artifactView === "#s=stressed", null, { label: "view before leaving" });
  await gotoApp(page, { url: `${APP_URL}?fixture=demo`, settle: 1000 });
  await clickMode(page, "Paper");
  await ready("explorer/index.html");
  h.eq([(await view()).artifactView, await frame().evaluate(() => document.body.dataset.series)], ["#s=stressed", "stressed"], "reopening the project shows the artifact that was open, on the view it was on");
  await page.click(".aview .key.close");
  await waitFor(page, () => !document.querySelector(".aview"), null, { label: "closed" });
  await gotoApp(page, { url: `${APP_URL}?fixture=demo`, settle: 1000 });
  await clickMode(page, "Paper");
  await waitFor(page, () => !!document.querySelector("[data-artifact-row]"), null, { label: "artifact rows again", timeout: 15000 });
  await sleep(400); // a restore would mount the view right after the rows: its absence is the claim
  h.ok(await page.evaluate(() => !document.querySelector(".aview")), "a project left on its document reopens on its document");

  h.ok(realErrors(page).length === 0, `clean browser console: ${realErrors(page).join(" | ")}`);
} catch (e) {
  h.fail(`${e?.stack || e}`);
  await shot(page, "paper-artifacts-failure").catch(() => {});
}
await h.done(() => browser.close());
