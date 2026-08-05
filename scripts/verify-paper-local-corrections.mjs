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
  localStorage.removeItem("flux.paper.localLanguage.v2");
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
const pressLocalChord = async (targetPage, key, { shift = false } = {}) => {
  await targetPage.keyboard.down("Alt");
  if (shift) await targetPage.keyboard.down("Shift");
  await targetPage.keyboard.press(key);
  if (shift) await targetPage.keyboard.up("Shift");
  await targetPage.keyboard.up("Alt");
};

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
  localStorage.removeItem("flux.paper.localLanguage.v2");
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

h.section("word tools and instantaneous aliases");
await page.evaluate(() => {
  localStorage.removeItem("flux.paper.localCorrections.v1");
  localStorage.removeItem("flux.paper.localLanguage.v2");
  window.dispatchEvent(new Event("flux:local-corrections-reset"));
});
await replaceDoc("iGluSnFR4f");
await page.evaluate(() => {
  const view = window.__fluxView;
  view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
  view.focus();
});
await waitFor(page, () => !!document.querySelector('.bubble [title^="Word tools"]'), null, { label: "word tools selection button" });
const wordToolsTitle = await page.$eval('.bubble [title^="Word tools"]', (button) => button.getAttribute("title"));
h.eq(wordToolsTitle, "Word tools  Shift+Alt+W", "Word tools hover shows the native Linux shortcut, not macOS symbols");
await page.click('.bubble [title^="Word tools"]');
await waitFor(page, () => !!document.querySelector(".cm-local-word-tools"), null, { label: "word tools popover" });
const initialTools = await page.evaluate(() => ({
  text: document.querySelector(".cm-local-word-tools")?.textContent ?? "",
  project: document.querySelector('[data-word-scope="project"]')?.getAttribute("aria-pressed"),
  personal: document.querySelector('[data-word-scope="personal"]')?.getAttribute("aria-pressed"),
}));
h.ok(initialTools.text.includes("iGluSnFR4f") && initialTools.project === "false" && initialTools.personal === "false", "selection toolbar opens scoped Word tools for the exact scientific term");
await shot(page, "paper-local-word-tools-empty");

await page.click('[data-word-scope="project"]');
await waitFor(page, () => document.querySelector('[data-word-scope="project"]')?.getAttribute("aria-pressed") === "true", null, { label: "project dictionary active" });
await page.type('.cm-local-alias-form input', "igf");
await page.click('.cm-local-alias-form button');
await waitFor(page, () => document.querySelector(".cm-local-alias-row strong")?.textContent === "igf", null, { label: "project alias saved" });
const configuredTools = await page.evaluate(() => document.querySelector(".cm-local-word-tools")?.textContent ?? "");
h.ok(configuredTools.includes("igf") && configuredTools.includes("Project"), "the popover adds and exposes a removable project alias");
await shot(page, "paper-local-word-tools-configured");
await page.click('.cm-local-word-tools-header button[aria-label="Close word tools"]');

await replaceDoc();
const protectedAliases = "`igf in code` and $igf in math$ and @igf citation ";
await page.keyboard.type(protectedAliases, { delay: 1 });
await new Promise((resolve) => setTimeout(resolve, 120));
h.eq(await doc(), protectedAliases, "aliases do not expand inside code, math, or citation syntax while it is still being typed");

await replaceDoc();
await page.keyboard.type("igf", { delay: 2 });
const aliasStartedAt = Date.now();
await page.keyboard.type(" ");
await waitFor(page, () => window.__fluxView.state.doc.toString() === "iGluSnFR4f ", null, { timeout: 1500, label: "instant alias expansion" });
const aliasElapsedMs = Date.now() - aliasStartedAt;
const aliasVisual = await page.evaluate(() => ({
  text: window.__fluxView.state.doc.toString(),
  mark: document.querySelector(".cm-local-correction")?.textContent ?? "",
  caret: window.__fluxView.state.selection.main.head,
}));
h.ok(aliasElapsedMs < 100, `alias expansion stays in the instantaneous class (${aliasElapsedMs} ms)`);
h.eq(aliasVisual, { text: "iGluSnFR4f ", mark: "iGluSnFR4f", caret: 11 }, "alias morphs in place with the same zero-layout visual and an unmoved caret");

await page.keyboard.down("Control");
await page.keyboard.press("KeyZ");
await page.keyboard.up("Control");
await waitFor(page, () => window.__fluxView.state.doc.toString() === "igf", null, { label: "alias transaction undo" });
h.eq(await doc(), "igf", "one Undo restores the typed alias exactly");
await page.keyboard.type(" ");
await waitFor(page, () => window.__fluxView.state.doc.toString() === "iGluSnFR4f ", null, { label: "alias re-expansion" });
await page.evaluate(() => {
  document.querySelector(".cm-local-correction")?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
});
await waitFor(page, () => !!document.querySelector(".cm-local-correction-menu"), null, { label: "alias correction menu" });
const aliasMenu = await page.evaluate(() => document.querySelector(".cm-local-correction-menu")?.textContent ?? "");
h.ok(aliasMenu.includes("Expanded alias") && aliasMenu.includes("igf → iGluSnFR4f") && aliasMenu.includes("Remove alias"), "the pulse menu identifies alias expansion and offers direct removal");
await page.evaluate(() => {
  const button = [...document.querySelectorAll(".cm-local-correction-menu button")]
    .find((candidate) => candidate.textContent === "Remove alias");
  button?.click();
});
await waitFor(page, () => window.__fluxView.state.doc.toString() === "igf ", null, { label: "remove alias and restore trigger" });
await replaceDoc();
await page.keyboard.type("igf ", { delay: 2 });
await new Promise((resolve) => setTimeout(resolve, 120));
h.eq(await doc(), "igf ", "Remove alias stops expansion immediately");

h.section("dictionary hotkeys and scientific typo matching");
await replaceDoc("iGluSnFR4f");
await page.evaluate(() => {
  const view = window.__fluxView;
  view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
  view.focus();
});
await pressLocalChord(page, "KeyD", { shift: true }); // existing project entry toggles OUT
await pressLocalChord(page, "KeyD"); // personal entry toggles IN
await pressLocalChord(page, "KeyW", { shift: true });
await waitFor(page, () => !!document.querySelector(".cm-local-word-tools"), null, { label: "word tools from hotkey" });
await waitFor(page, () => document.activeElement?.matches(".cm-local-alias-form input") ?? false, null, { label: "alias input focus" });
const hotkeyScopes = await page.evaluate(() => ({
  project: document.querySelector('[data-word-scope="project"]')?.getAttribute("aria-pressed"),
  personal: document.querySelector('[data-word-scope="personal"]')?.getAttribute("aria-pressed"),
  aliasFocused: document.activeElement?.matches(".cm-local-alias-form input") ?? false,
}));
h.eq(hotkeyScopes, { project: "false", personal: "true", aliasFocused: true }, "scope hotkeys toggle independently and the alias hotkey focuses its input");
await page.keyboard.press("Escape");
await pressLocalChord(page, "KeyD"); // personal OUT
await pressLocalChord(page, "KeyD", { shift: true }); // project IN

await replaceDoc();
await page.keyboard.type("We measured IgluSnrf4. ", { delay: 2 });
await waitFor(page, () => window.__fluxView.state.doc.toString() === "We measured iGluSnFR4f. ", null, { timeout: 8000, label: "explicit scientific dictionary correction" });
h.eq(await doc(), "We measured iGluSnFR4f. ", "project dictionary corrects the requested mixed-case scientific near miss");
await replaceDoc();
await page.keyboard.type("We measured iGluSnFR4f and SLAP3. ", { delay: 2 });
await new Promise((resolve) => setTimeout(resolve, 500));
h.eq(await doc(), "We measured iGluSnFR4f and SLAP3. ", "canonical terms and meaningful version-like identifiers remain byte-identical");

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

h.section("Vim visual selection parity");
const vimPage = await browser.newPage();
await vimPage.evaluateOnNewDocument(() => {
  localStorage.removeItem("flux.paper.localCorrections.v1");
  localStorage.removeItem("flux.paper.localLanguage.v2");
  localStorage.setItem("flux.paper.vimFlavor", "vim");
  const current = JSON.parse(localStorage.getItem("flux.settings") || "{}");
  localStorage.setItem("flux.settings", JSON.stringify({ ...current, paperLocalCorrections: true }));
});
await gotoApp(vimPage, { url: `${APP_URL}?fixture=demo`, settle: 500 });
await clickMode(vimPage, "Paper", { settle: 250 });
await waitFor(vimPage, () => !!window.__fluxView && !!document.querySelector(".cm-vim-panel"), null, { timeout: 10000, label: "Vim Paper editor" });
await vimPage.evaluate(() => {
  const view = window.__fluxView;
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "jRGECO1a" }, selection: { anchor: 0 } });
  view.focus();
});
await vimPage.keyboard.press("Escape");
await vimPage.keyboard.press("0");
await vimPage.keyboard.press("v");
await vimPage.keyboard.press("$");
const visualSelection = await vimPage.evaluate(() => {
  const view = window.__fluxView;
  const range = view.state.selection.main;
  return view.state.sliceDoc(range.from, range.to);
});
h.eq(visualSelection, "jRGECO1a", "Vim visual mode produces the same selected word contract");
await pressLocalChord(vimPage, "KeyD", { shift: true });
await pressLocalChord(vimPage, "KeyW", { shift: true });
await waitFor(vimPage, () => !!document.querySelector(".cm-local-word-tools"), null, { label: "Vim visual Word tools" });
const vimTools = await vimPage.evaluate(() => ({
  term: document.querySelector(".cm-local-word-tools-header strong")?.textContent,
  project: document.querySelector('[data-word-scope="project"]')?.getAttribute("aria-pressed"),
}));
h.eq(vimTools, { term: "jRGECO1a", project: "true" }, "dictionary and Word tools hotkeys work without leaving Vim visual mode");
h.eq(realErrors(vimPage), [], "Vim parity path has a clean browser console");
await vimPage.close();
await h.done(async () => browser.close());
