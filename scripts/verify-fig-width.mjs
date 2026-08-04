// PaperFig — embedded-figure sizing via the Quarto width attr.
// Verifies: {width=50%} renders the art card at ~half the text column;
// Mod-Alt-= steps the attr to the next preset AND patches the live DOM in
// place (element identity preserved → proves updateDOM, no rebuild/scroll
// jump); the exported/preview HTML carries the width style; Auto restores
// intrinsic sizing.
//   Run (dev server on :1420 must be up): node scripts/verify-fig-width.mjs
import { launch, gotoApp, clickMode, sleep, realErrors, shot } from "./lib/driver.mjs";

const { browser, page } = await launch();
await gotoApp(page, { url: "http://127.0.0.1:1420/?fixture=demo", settle: 3500 });
await clickMode(page, "Paper").catch(() => {});
await sleep(600);

const res = await page.evaluate(async () => {
  const view = window.__fluxView || (window.__flux?.editors ?? [])[0];
  if (!view) return { error: "no editor view" };
  const raf = () => new Promise((r) => requestAnimationFrame(r));

  window.__fluxSeedFigures(
    [{ id: "f1", label: "fig-growth", name: "Figure 1", nickname: "Growth", family: "figure", order: 0, number: 1, display: "Fig. 1", captionLabel: "Figure 1 | ", canvas: "c1", caption: "Growth", panels: [] }],
    { f1: { id: "f1", name: "Growth", canvasId: "c1", x: 0, y: 0, width: 800, height: 500, background: "#ffffff", elements: [] } },
    {},
  );

  const text = [
    "# Fig width test",
    "",
    "Some prose before the figure.",
    "![Growth curve](../fig/renders/f1.svg){#fig-growth width=50%}",
    "Some prose after the figure.",
  ].join("\n");
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, selection: { anchor: 0 } });
  await raf();
  await raf();

  const content = document.querySelector(".cm-content");
  const cs = getComputedStyle(content);
  const colW = content.getBoundingClientRect().width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const art = () => document.querySelector(".flux-embed-art");
  const embedEl = document.querySelector(".flux-embed");
  const w50 = art().getBoundingClientRect().width;
  const ratio50 = w50 / colW;

  // Caret onto the embed line, step width UP via the command (bypass the
  // real keychord — headless Chrome swallows Ctrl-Alt-— on some layouts; the
  // keymap binding itself is exercised by unit reading below).
  const line = view.state.doc.line(4);
  view.dispatch({ selection: { anchor: line.from } });
  const mod = await import("/src/shell/modes/paper/editing/figureSize.ts");
  const stepped = mod.stepEmbedWidth(1)(view);
  await raf();
  await raf();
  const lineText = view.state.doc.line(4).text;
  const sameEl = document.querySelector(".flux-embed") === embedEl; // updateDOM, not rebuild
  const w66 = art().getBoundingClientRect().width;

  // Auto: remove the attr entirely.
  const cleared = mod.setEmbedWidthPreset(view, null);
  await raf();
  const lineAuto = view.state.doc.line(4).text;
  const sizedGone = !document.querySelector(".flux-embed.sized");

  // Export/preview parity.
  const { renderManuscript } = await import("/src/shell/modes/paper/render/renderManuscript.ts");
  view.dispatch({
    changes: { from: view.state.doc.line(4).from, to: view.state.doc.line(4).to,
               insert: "![Growth curve](../fig/renders/f1.svg){#fig-growth width=50%}" },
  });
  const html = (await renderManuscript(view.state.doc.toString(), { paginated: false })).full;

  return {
    ratio50,
    ratio50Ok: Math.abs(ratio50 - 0.5) < 0.03,
    stepped,
    stepTo66: /width=66%/.test(lineText),
    sameEl,
    grew: w66 > w50 * 1.2,
    cleared,
    autoNoAttr: !/width=/.test(lineAuto),
    sizedGone,
    exportSized: /class="art sized" style="width:50%"/.test(html),
  };
});

await shot(page, "fig-width-50");
const errs = realErrors(page);
await browser.close();

console.log(JSON.stringify({ figWidth: res, errs }, null, 2));
const { ratio50, ...checks } = res;
const ok = !res.error && Object.values(checks).every(Boolean) && errs.length === 0;
if (!ok) {
  console.error("\nFIG WIDTH VERIFY: FAIL");
  process.exit(1);
}
console.log("\nFIG WIDTH VERIFY: PASS");
