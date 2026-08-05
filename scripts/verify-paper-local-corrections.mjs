// Behavioral gate for Paper's local correction fabric. Exercises the real
// Vite module worker + Harper WASM, the exact product example, one-step undo,
// continued typing, protected syntax, toggling, and correction details UI.
import {
  APP_URL,
  clickMode,
  gotoApp,
  launch,
  realErrors,
  shot,
  waitFor,
} from "./lib/driver.mjs";
import { harness } from "./lib/harness.mjs";

const h = harness("verify-paper-local-corrections");
const { browser, page } = await launch({ width: 1440, height: 900 });
await page.evaluateOnNewDocument(() => {
  localStorage.removeItem("flux.paper.localCorrections.v1");
  const current = JSON.parse(localStorage.getItem("flux.settings") || "{}");
  localStorage.setItem("flux.settings", JSON.stringify({ ...current, paperLocalCorrections: true }));
});
await gotoApp(page, { url: `${APP_URL}?fixture=demo`, settle: 1000 });
await clickMode(page, "Paper", { settle: 350 });
await waitFor(page, () => !!window.__fluxView, null, { timeout: 15000, label: "Paper editor" });
await waitFor(
  page,
  () => document.querySelector("[data-correction-status]")?.getAttribute("data-correction-status") === "ready",
  null,
  { timeout: 20000, label: "local worker ready" },
);

const replaceDoc = async (text = "") => {
  await page.evaluate((next) => {
    const view = window.__fluxView;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: next }, selection: { anchor: next.length } });
    view.focus();
  }, text);
};
const doc = () => page.evaluate(() => window.__fluxView.state.doc.toString());

h.section("exact product interaction");
await replaceDoc();
await page.keyboard.type("The chemical structure is a very compelx o bject.", { delay: 3 });
const correctionStartedAt = Date.now();
await page.keyboard.type(" ");
await waitFor(
  page,
  () => window.__fluxView.state.doc.toString() === "The chemical structure is a very complex object. ",
  null,
  { timeout: 8000, label: "complex object correction" },
);
const correctionElapsedMs = Date.now() - correctionStartedAt;
const exact = await page.evaluate(() => ({
  text: window.__fluxView.state.doc.toString(),
  marks: [...document.querySelectorAll(".cm-local-correction")].map((el) => el.textContent),
  caret: window.__fluxView.state.selection.main.head,
}));
h.eq(exact.text, "The chemical structure is a very complex object. ", "exact example corrects locally");
h.ok(correctionElapsedMs < 900, `warm correction settles promptly (${correctionElapsedMs} ms)`);
h.eq(exact.marks, ["complex", "object"], "both changes carry transient blue-pulse marks");
h.eq(exact.caret, exact.text.length, "caret remains at the end of the user's text");
await shot(page, "paper-local-correction-pulse");

await page.evaluate(() => {
  document.querySelector(".cm-local-correction")?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
});
await waitFor(page, () => !!document.querySelector(".cm-local-correction-menu"), null, { label: "correction menu" });
const menuText = await page.evaluate(() => document.querySelector(".cm-local-correction-menu")?.textContent ?? "");
h.ok(menuText.includes("compelx → complex") && menuText.includes("Undo") && menuText.includes("Add to dictionary"), "click reveals concise correction, undo, and dictionary actions");
await shot(page, "paper-local-correction-menu");
await page.keyboard.press("Escape");

await page.keyboard.down("Control");
await page.keyboard.press("KeyZ");
await page.keyboard.up("Control");
await waitFor(
  page,
  () => window.__fluxView.state.doc.toString() === "The chemical structure is a very compelx o bject. ",
  null,
  { timeout: 4000, label: "one-step correction undo" },
);
h.eq(await doc(), "The chemical structure is a very compelx o bject. ", "one Undo restores the entire original sentence exactly");

h.section("learning and uninterrupted typing");
await replaceDoc();
await page.keyboard.type("The chemical structure is a very compelx o bject. ", { delay: 2 });
await new Promise((resolve) => setTimeout(resolve, 700));
h.eq(await doc(), "The chemical structure is a very compelx o bject. ", "immediate Undo taught this project not to repeat either correction");

await page.evaluate(() => {
  localStorage.removeItem("flux.paper.localCorrections.v1");
  window.dispatchEvent(new Event("flux:local-corrections-reset"));
});
await replaceDoc();
await page.keyboard.type("The chemical structure is a very compelx o bject. ", { delay: 2 });
await waitFor(
  page,
  () => window.__fluxView.state.doc.toString() === "The chemical structure is a very complex object. ",
  null,
  { timeout: 8000, label: "live learning reset" },
);
h.ok(true, "reset learning immediately clears active project vetoes");

// Use different, unblocked typos and continue typing before the worker returns.
await replaceDoc();
await page.keyboard.type("This experiemnt occured. The next idea keeps moving.", { delay: 1 });
await waitFor(
  page,
  () => window.__fluxView.state.doc.toString() === "This experiment occurred. The next idea keeps moving.",
  null,
  { timeout: 8000, label: "continued typing correction" },
);
const continued = await page.evaluate(() => ({
  text: window.__fluxView.state.doc.toString(),
  caret: window.__fluxView.state.selection.main.head,
}));
h.eq(continued.caret, continued.text.length, "late local results map behind continued typing without moving the caret");

await replaceDoc();
await page.keyboard.type("The signal was recoreded. ", { delay: 2 });
await waitFor(
  page,
  () => window.__fluxView.state.doc.toString() === "The signal was recorded. ",
  null,
  { timeout: 8000, label: "dictionary candidate correction" },
);
await page.evaluate(() => {
  document.querySelector(".cm-local-correction")?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
});
await waitFor(page, () => !!document.querySelector(".cm-local-correction-menu"), null, { label: "dictionary menu" });
await page.evaluate(() => {
  const button = [...document.querySelectorAll(".cm-local-correction-menu button")]
    .find((candidate) => candidate.textContent === "Add to dictionary");
  button?.click();
});
await waitFor(
  page,
  () => window.__fluxView.state.doc.toString() === "The signal was recoreded. ",
  null,
  { label: "dictionary restores original" },
);
await replaceDoc();
await page.keyboard.type("The signal was recoreded. ", { delay: 2 });
await new Promise((resolve) => setTimeout(resolve, 700));
h.eq(await doc(), "The signal was recoreded. ", "Add to dictionary restores and learns a project-specific term");

h.section("protected syntax and preference");
await replaceDoc();
const protectedSource = "The `experiemnt` code, $occured$ value, @experiemnt citation, and 5 Hz remain. ";
await page.keyboard.type(protectedSource, { delay: 1 });
await new Promise((resolve) => setTimeout(resolve, 800));
h.eq(await doc(), protectedSource, "code, math, citation keys, and scientific numbers remain byte-identical");

await replaceDoc();
const scientificSource = "The somata and glia produced a data set at one timepoint in the brainstem wildtype cohort. ";
await page.keyboard.type(scientificSource, { delay: 1 });
await new Promise((resolve) => setTimeout(resolve, 700));
h.eq(await doc(), scientificSource, "unfamiliar scientific words and valid open compounds are left alone");

await page.click("[data-correction-status]");
await waitFor(
  page,
  () => document.querySelector("[data-correction-status]")?.getAttribute("data-correction-status") === "off",
  null,
  { label: "corrections disabled" },
);
await replaceDoc();
await page.keyboard.type("This experiemnt occured. ", { delay: 2 });
await new Promise((resolve) => setTimeout(resolve, 600));
h.eq(await doc(), "This experiemnt occured. ", "status-pill toggle disables all automatic changes");
await page.click("[data-correction-status]");
await waitFor(
  page,
  () => document.querySelector("[data-correction-status]")?.getAttribute("data-correction-status") === "ready",
  null,
  { timeout: 4000, label: "warm worker re-enabled" },
);
h.ok(true, "re-enabling reuses the warm local worker");

h.section("runtime hygiene");
h.eq(realErrors(page), [], "no browser, worker, WASM, or CSP errors");
await h.done(async () => browser.close());
