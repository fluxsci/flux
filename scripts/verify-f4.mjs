// F4 multi-document: the left rail lists all .qmd docs; selecting one swaps the
// editor (content/outline follow); edits autosave to the active doc's file (main
// untouched); switching back restores; "+ New" creates+opens+registers a doc.
import { launch, gotoApp, clickMode, shot, sleep, errors } from "./lib/driver.mjs";

const ROOT = "/demo/myc-growth-paper";
const { browser, page } = await launch();
await gotoApp(page, { url: "http://127.0.0.1:1420/?fixture=demo", settle: 3500 });
await clickMode(page, "Paper");
await sleep(1400);

const list = await page.evaluate(() => {
  const items = [...document.querySelectorAll(".docpicker .dp-item")];
  return {
    count: items.length,
    titles: items.map((b) => b.querySelector(".dp-title")?.textContent),
    activeTitle: document.querySelector(".docpicker .dp-item.active .dp-title")?.textContent,
    hasMainBadge: !!document.querySelector(".docpicker .dp-item .dp-badge"),
  };
});
const docMainInitial = await page.evaluate(() =>
  window.__fluxView.state.doc.toString().includes("Mycelial extension increased"),
);

// Switch to the Supplementary document.
await page.evaluate(() => {
  [...document.querySelectorAll(".docpicker .dp-item")]
    .find((b) => b.textContent.includes("Supplementary"))
    .click();
});
await sleep(600);
const afterSwap = await page.evaluate(() => ({
  docHasSupp: window.__fluxView.state.doc.toString().includes("Extended methods"),
  active: document.querySelector(".docpicker .dp-item.active .dp-title")?.textContent,
}));
await shot(page, "f4-supp-doc");

// Edit the supplementary doc → autosaves to supp.qmd; main.qmd is untouched.
await page.evaluate(() => {
  const v = window.__fluxView;
  v.focus();
  const end = v.state.doc.length;
  v.dispatch({ changes: { from: end, insert: "\n\nNEW SUPP LINE.\n" } });
});
await sleep(900);
const persisted = await page.evaluate(async () => {
  const supp = await window.fig.readText("/demo/myc-growth-paper/manuscript/supp.qmd");
  const main = await window.fig.readText("/demo/myc-growth-paper/manuscript/main.qmd");
  return { suppHasEdit: supp.includes("NEW SUPP LINE."), mainUntouched: !main.includes("NEW SUPP LINE.") };
});

// Switch back to the main manuscript → its content is restored.
await page.evaluate(() => {
  [...document.querySelectorAll(".docpicker .dp-item")].find((b) => b.querySelector(".dp-badge")).click();
});
await sleep(600);
const backToMain = await page.evaluate(() => ({
  docMain: window.__fluxView.state.doc.toString().includes("Mycelial extension increased"),
  active: document.querySelector(".docpicker .dp-item.active .dp-title")?.textContent,
}));

// "+ New document" (override the prompt so no blocking dialog).
await page.evaluate(() => {
  window.prompt = () => "My New Doc";
});
await page.evaluate(() => document.querySelector(".docpicker .dp-new").click());
await sleep(800);
const created = await page.evaluate(async () => {
  const exists = await window.fig.exists("/demo/myc-growth-paper/manuscript/my-new-doc.qmd");
  const manifest = JSON.parse(await window.fig.readText("/demo/myc-growth-paper/project.json"));
  const inManifest = (manifest.supplementary || []).some((s) => s.path === "manuscript/my-new-doc.qmd");
  const doc = window.__fluxView.state.doc.toString();
  return {
    exists,
    inManifest,
    activeIsNew: (document.querySelector(".docpicker .dp-item.active .dp-title")?.textContent || "").includes("My New Doc"),
    docIsStub: doc.includes("My New Doc") && !doc.includes("Mycelial extension"),
  };
});

console.log(JSON.stringify({ list, docMainInitial, afterSwap, persisted, backToMain, created, errs: errors(page) }, null, 2));
await browser.close();
