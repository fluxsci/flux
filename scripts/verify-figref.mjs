// FigRef — the `@@` figure-reference flow + live figure↔paper sync end-to-end.
// Verifies: typing `@@` opens the FigRefPicker without leaving any `@@` (or the
// first `@`) in the document; the citation autocomplete on a plain `@` offers
// NO figure options while `@fig` does; picking a figure with panels enters the
// panel stage where letter keys toggle pills and Enter inserts the collapsed
// panel spec (`@fig-x-a-c`, `@fig-x-a,c`); Enter with nothing picked inserts
// the whole-figure ref; chips render the panel suffix ("Fig 1a,c"); re-seeding
// figures with a different order renumbers every chip and embed live AND
// clears legacy embed alt text (canonical embeds are ![](…){#fig-id} — the
// figure MODEL owns captions, and the widget caption follows it live);
// Escape walks back panel→figure→closed with focus returned.
//   Run (dev server on :1420 must be up): node scripts/verify-figref.mjs
import { launch, gotoApp, clickMode, sleep, realErrors, shot } from "./lib/driver.mjs";

const { browser, page } = await launch();
await gotoApp(page, { url: "http://127.0.0.1:1420/?fixture=demo", settle: 3500 });
await clickMode(page, "Paper").catch(() => {});
await sleep(600);

// Figure families (2026-08): refs carry structured identity — numeric `number`
// within the family plus the precomputed family-formatted `display` ("Fig. 1")
// and `captionLabel` ("Figure 1 | ") that loadFigures derives from figfamily
// templates. Seeds mirror that shape.
const FIGS = (swap) => {
  const growth = {
    id: "f1",
    label: "fig-growth",
    name: swap ? "Figure 2" : "Figure 1",
    nickname: "Growth",
    family: "figure",
    order: swap ? 1 : 0,
    number: swap ? 2 : 1,
    display: swap ? "Fig. 2" : "Fig. 1",
    captionLabel: swap ? "Figure 2 | " : "Figure 1 | ",
    canvas: "c1",
    caption: swap ? "Growth over 48 h." : "Growth over 24 h.",
    panels: ["a", "b", "c", "d", "e"],
  };
  const dose = {
    id: "f2",
    label: "fig-dose",
    name: swap ? "Figure 1" : "Figure 2",
    nickname: "Dose",
    family: "figure",
    order: swap ? 0 : 1,
    number: swap ? 1 : 2,
    display: swap ? "Fig. 1" : "Fig. 2",
    captionLabel: swap ? "Figure 1 | " : "Figure 2 | ",
    canvas: "c1",
    caption: "Dose response.",
    panels: [],
  };
  return swap ? [dose, growth] : [growth, dose];
};
const CANVASES = {
  f1: { id: "f1", name: "Growth", canvasId: "c1", x: 0, y: 0, width: 800, height: 500, background: "#ffffff", elements: [] },
  f2: { id: "f2", name: "Dose", canvasId: "c1", x: 0, y: 0, width: 800, height: 500, background: "#ffffff", elements: [] },
};

const setup = await page.evaluate(
  async (figs, canvases) => {
    const view = window.__fluxView || (window.__flux?.editors ?? [])[0];
    if (!view) return { error: "no editor view" };
    window.__fluxSeedBib([{ key: "figueroa2019", title: "A study", authors: ["Figueroa"], year: "2019" }]);
    window.__fluxSeedFigures(figs, canvases, {});
    const text = [
      "# Intro",
      "",
      "See @fig-growth-a for detail.",
      "",
      "![Growth over 24 h.](../fig/renders/f1.svg){#fig-growth}",
      "",
      "Trailing prose line.",
      "",
    ].join("\n");
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, selection: { anchor: 0 } });
    await new Promise((r) => requestAnimationFrame(r));
    view.focus();
    return { ok: true };
  },
  FIGS(false),
  CANVASES,
);
if (setup.error) {
  console.error(JSON.stringify(setup));
  process.exit(1);
}
const poll = async (fn, tries = 20, ms = 150) => {
  for (let i = 0; i < tries; i++) {
    if (await page.evaluate(fn)) return true;
    await sleep(ms);
  }
  return false;
};
const docText = () => page.evaluate(() => window.__fluxView.state.doc.toString());
const focusInEditor = () => page.evaluate(() => !!document.activeElement?.closest(".cm-content"));

// --- plain @ completes citations only; @fig completes crossrefs ----------------
await page.evaluate(() => {
  const view = window.__fluxView;
  const line = view.state.doc.line(7); // "Trailing prose line."
  view.dispatch({ selection: { anchor: line.to }, scrollIntoView: true });
  view.focus();
});
await page.keyboard.type(" @");
await poll(() => !!document.querySelector(".cm-tooltip-autocomplete"));
await sleep(250);
const atOptions = await page.evaluate(() =>
  [...document.querySelectorAll(".cm-tooltip-autocomplete li")].map((l) => l.textContent ?? ""),
);
const atCiteOnly =
  atOptions.some((o) => o.includes("figueroa2019")) && !atOptions.some((o) => o.includes("@fig-growth"));
await page.keyboard.type("fig");
await sleep(400);
const figOptions = await page.evaluate(() =>
  [...document.querySelectorAll(".cm-tooltip-autocomplete li")].map((l) => l.textContent ?? ""),
);
const atFigHasCrossrefs = figOptions.some((o) => o.includes("@fig-growth"));
// clean up the typed " @fig"
await page.keyboard.press("Escape");
await page.evaluate(() => {
  const view = window.__fluxView;
  const line = view.state.doc.line(7);
  const idx = line.text.indexOf(" @fig");
  view.dispatch({ changes: { from: line.from + idx, to: line.to } });
});

// --- @@ opens the picker and leaves no @ in the doc -----------------------------
await page.evaluate(() => {
  const view = window.__fluxView;
  const line = view.state.doc.line(7);
  view.dispatch({ selection: { anchor: line.to }, scrollIntoView: true });
  view.focus();
});
await page.keyboard.type(" @@");
const pickerOpened = await poll(() => !!document.querySelector(".picker"));
const line7AfterTrigger = await page.evaluate(
  () => window.__fluxView.state.doc.line(7).text,
);
const noAtResidue = !line7AfterTrigger.includes("@");

// --- stage 1 → stage 2: filter, Enter, panel pills present ----------------------
await page.keyboard.type("gro"); // search box has focus
await sleep(200);
await page.keyboard.press("Enter"); // Growth has panels → panel stage
const panelStage = await poll(() => document.querySelectorAll(".picker .pill").length === 5);

// --- letters toggle; Enter inserts the collapsed spec ---------------------------
await page.keyboard.press("a");
await page.keyboard.press("b");
await page.keyboard.press("c");
await page.keyboard.press("e");
await sleep(150);
const pillState = await page.evaluate(() =>
  [...document.querySelectorAll(".picker .pill")].map((p) => p.classList.contains("on")),
);
const willText = await page.evaluate(
  () => document.querySelector(".foot .will")?.textContent ?? "",
);
await page.keyboard.press("Enter");
await sleep(300);
const afterPanels = await docText();
const specOk =
  afterPanels.includes("@fig-growth-a-c,e") &&
  JSON.stringify(pillState) === JSON.stringify([true, true, true, false, true]) &&
  willText.includes("1a–c,e") &&
  (await focusInEditor());

// --- chip renders the panel suffix ----------------------------------------------
await page.evaluate(() => {
  const view = window.__fluxView;
  view.dispatch({ selection: { anchor: 0 }, scrollIntoView: true }); // move caret off the chip line
});
await sleep(300);
const chipTexts = await page.evaluate(() =>
  [...document.querySelectorAll(".flux-figref")].map((c) => c.textContent ?? ""),
);
const chipPanelOk = chipTexts.some((t) => t === "Fig. 1a–c,e") && chipTexts.some((t) => t === "Fig. 1a");

// --- whole-figure path: @@ → Dose (no panels) → immediate insert ---------------
await page.evaluate(() => {
  const view = window.__fluxView;
  const line = view.state.doc.line(7);
  view.dispatch({ selection: { anchor: line.to }, scrollIntoView: true });
  view.focus();
});
await page.keyboard.type(" @@");
await poll(() => !!document.querySelector(".picker"));
await page.keyboard.type("dose");
await sleep(200);
await page.keyboard.press("Enter"); // no panels → inserts immediately
await sleep(300);
const wholeOk = (await docText()).includes("@fig-dose") && (await focusInEditor());

// --- Escape walk-back: panels → figures → closed --------------------------------
await page.keyboard.type(" @@");
await poll(() => !!document.querySelector(".picker"));
await page.keyboard.type("gro");
await sleep(200);
await page.keyboard.press("Enter");
await poll(() => document.querySelectorAll(".picker .pill").length === 5);
await page.keyboard.press("Escape"); // back to figure grid
await sleep(200);
const backAtGrid = await page.evaluate(
  () => !!document.querySelector(".picker .search") && !document.querySelector(".picker .pill"),
);
await page.keyboard.press("Escape"); // close
// The scrim/picker animate out (Svelte out-transition) — poll for removal.
const pickerGone = await poll(() => !document.querySelector(".picker"));
const closedFocus = await focusInEditor();
const closedOk = backAtGrid && pickerGone && closedFocus;

// --- live renumber + model-caption sync ------------------------------------------
// Swap figure order (Growth 1→2) and change its caption; every chip and the
// embed's rendered number/caption must follow from the MODEL, and the legacy
// alt text in the doc is cleared (never rewritten — the model owns captions).
await page.evaluate(
  (figs, canvases) => window.__fluxSeedFigures(figs, canvases, {}),
  FIGS(true),
  CANVASES,
);
await sleep(500);
const afterSwapDoc = await docText();
const chipsAfterSwap = await page.evaluate(() =>
  [...document.querySelectorAll(".flux-figref")].map((c) => c.textContent ?? ""),
);
const embedCapAfterSwap = await page.evaluate(
  () => document.querySelector(".flux-embed-cap")?.textContent ?? "",
);
const renumberOk =
  chipsAfterSwap.some((t) => t === "Fig. 2a–c,e") &&
  chipsAfterSwap.some((t) => t === "Fig. 2a") &&
  chipsAfterSwap.some((t) => t === "Fig. 1") && // @fig-dose
  embedCapAfterSwap.startsWith("Figure 2 |");
const captionSyncOk =
  afterSwapDoc.includes("![](../fig/renders/f1.svg){#fig-growth}") &&
  !afterSwapDoc.includes("Growth over 24 h.") &&
  embedCapAfterSwap.includes("Growth over 48 h.");

await shot(page, "figref-final");
const errs = realErrors(page);
await browser.close();

const res = {
  atCiteOnly,
  atFigHasCrossrefs,
  pickerOpened,
  noAtResidue,
  panelStage,
  specOk,
  chipPanelOk,
  wholeOk,
  closedOk,
  renumberOk,
  captionSyncOk,
};
console.log(JSON.stringify({ figref: res, closedParts: { backAtGrid, pickerGone, closedFocus }, errs }, null, 2));
const ok = Object.values(res).every(Boolean) && errs.length === 0;
if (!ok) {
  console.error("\nFIGREF VERIFY: FAIL");
  process.exit(1);
}
console.log("\nFIGREF VERIFY: PASS");
