// F4 multi-document: the left rail lists all .qmd docs; selecting one swaps the
// editor (content/outline follow); edits autosave to the active doc's file (main
// untouched); switching back restores; "+ New document" creates+opens+registers a doc.
// (Reordering that list is verify-doc-order-gui.mjs.)
// Run (dev server on :1420): node scripts/verify-f4.mjs
import { launch, gotoApp, clickMode, shot, sleep, realErrors, waitFor, APP_URL } from "./lib/driver.mjs";
import { harness } from "./lib/harness.mjs";

const h = harness("verify-f4");
const ROOT = "/demo/myc-growth-paper";

const { browser, page } = await launch();
await gotoApp(page, { url: `${APP_URL.replace(/\/$/, "")}/?fixture=demo`, settle: 3500 });
await clickMode(page, "Paper");
await waitFor(page, () => document.querySelectorAll(".docpicker .dp-item").length >= 2, null, {
  timeout: 10000,
  label: "the Documents list is populated",
});

const list = await page.evaluate(() => {
  const items = [...document.querySelectorAll(".docpicker .dp-item")];
  return {
    count: items.length,
    titles: items.map((b) => b.querySelector(".dp-title")?.textContent),
    activeTitle: document.querySelector(".docpicker .dp-item.active .dp-title")?.textContent,
    hasMainBadge: !!document.querySelector(".docpicker .dp-item .dp-badge"),
  };
});
h.ok(list.titles.includes("Supplementary Material"), `the rail lists the project's documents (${list.titles.join(" · ")})`);
h.ok(list.hasMainBadge, "the main manuscript wears the main badge");
h.ok(
  await page.evaluate(() => window.__fluxView.state.doc.toString().includes("Mycelial extension increased")),
  "the main manuscript is what the editor opened on",
);

// Switch to the Supplementary document.
h.section("switching document");
await page.evaluate(() => {
  [...document.querySelectorAll(".docpicker .dp-item")]
    .find((b) => b.textContent.includes("Supplementary"))
    .click();
});
await waitFor(page, () => window.__fluxView.state.doc.toString().includes("Extended methods"), null, {
  timeout: 8000,
  label: "the supplementary document loads",
});
h.eq(
  await page.evaluate(() => document.querySelector(".docpicker .dp-item.active .dp-title")?.textContent),
  "Supplementary Material",
  "the rail marks it active",
);
await shot(page, "f4-supp-doc");

// Edit the supplementary doc → autosaves to supp.qmd; main.qmd is untouched.
h.section("edits land in the active document's file");
await page.evaluate(() => {
  const v = window.__fluxView;
  v.focus();
  const end = v.state.doc.length;
  v.dispatch({ changes: { from: end, insert: "\n\nNEW SUPP LINE.\n" } });
});
await waitFor(
  page,
  async (root) => (await window.fig.readText(`${root}/manuscript/supp.qmd`)).includes("NEW SUPP LINE."),
  ROOT,
  { timeout: 8000, label: "the edit autosaves to supp.qmd" },
);
h.ok(
  await page.evaluate(
    async (root) => !(await window.fig.readText(`${root}/manuscript/main.qmd`)).includes("NEW SUPP LINE."),
    ROOT,
  ),
  "…and main.qmd is untouched",
);

// Switch back to the main manuscript → its content is restored.
h.section("switching back");
await page.evaluate(() => {
  [...document.querySelectorAll(".docpicker .dp-item")].find((b) => b.querySelector(".dp-badge")).click();
});
await waitFor(page, () => window.__fluxView.state.doc.toString().includes("Mycelial extension increased"), null, {
  timeout: 8000,
  label: "the main manuscript is restored",
});
h.eq(
  await page.evaluate(() => document.querySelector(".docpicker .dp-item.active .dp-title")?.textContent),
  "Mycelial growth under nutrient stress",
  "the rail marks the main manuscript active again",
);

// "+ New document" — the rail's own prompt (an in-app dialog, not window.prompt).
h.section("+ New document");
await page.evaluate(() => document.querySelector(".docpicker .dp-new").click());
await waitFor(page, () => !!document.querySelector("#new-doc-input"), null, {
  timeout: 5000,
  label: "the new-document prompt",
});
await page.type("#new-doc-input", "My New Doc");
await page.keyboard.press("Enter");
await waitFor(
  page,
  () => [...document.querySelectorAll(".docpicker .dp-title")].some((e) => e.textContent === "My New Doc"),
  null,
  { timeout: 8000, label: "the new document is listed" },
);
const created = await page.evaluate(async (root) => {
  const manifest = JSON.parse(await window.fig.readText(`${root}/project.json`));
  return {
    exists: await window.fig.exists(`${root}/manuscript/my-new-doc.qmd`),
    inManifest: (manifest.supplementary || []).some((s) => s.path === "manuscript/my-new-doc.qmd"),
    activeIsNew: (document.querySelector(".docpicker .dp-item.active .dp-title")?.textContent || "").includes("My New Doc"),
    docIsStub:
      window.__fluxView.state.doc.toString().includes("My New Doc") &&
      !window.__fluxView.state.doc.toString().includes("Mycelial extension"),
  };
}, ROOT);
h.ok(created.exists, "the file is created under manuscript/");
h.ok(created.inManifest, "…registered in project.json so it survives a reload");
h.ok(created.activeIsNew, "…and opened");
h.ok(created.docIsStub, "…with its seeded front matter, not the previous document's text");

const errs = realErrors(page);
h.ok(errs.length === 0, errs.length ? `console errors: ${errs.join(" | ")}` : "zero console errors");
await h.done(() => browser.close());
