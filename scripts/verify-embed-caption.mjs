// Embed captions from the MODEL (owner review): the caption under the rendered
// figure comes from the figure model (empty alt), renders inline markdown
// (bold **a**, panel letters as <strong>, ≠ the accent <b> "Figure N." prefix),
// and its box tracks the ART width for sized figures (not the 60ch cap) — in
// the editor AND in the export HTML. Unresolved embeds fall back to alt text.
//   Run (dev server on :1420 must be up): node scripts/verify-embed-caption.mjs
import { launch, gotoApp, clickMode, sleep, realErrors, shot } from "./lib/driver.mjs";

const { browser, page } = await launch();
await gotoApp(page, { url: "http://127.0.0.1:1420/?fixture=demo", settle: 3500 });
await clickMode(page, "Paper").catch(() => {});
await sleep(600);

const res = await page.evaluate(async () => {
  const view = window.__fluxView || (window.__flux?.editors ?? [])[0];
  if (!view) return { error: "no editor view" };
  const raf = () => new Promise((r) => requestAnimationFrame(r));
  const CAPTION = "Growth under stress. **a**, Control. **b**, Treatment.";
  window.__fluxSeedFigures(
    [{ id: "f1", label: "fig-growth", name: "Figure 1", nickname: "Growth", family: "figure", order: 0, number: 1, display: "Fig. 1", captionLabel: "Figure 1 | ", canvas: "c1", caption: CAPTION, panels: ["a", "b"] }],
    { f1: { id: "f1", name: "Growth", canvasId: "c1", x: 0, y: 0, width: 800, height: 500, background: "#ffffff", elements: [] } },
    {},
  );

  const text = [
    "# Caption test",
    "",
    "![](../fig/renders/f1.svg){#fig-growth width=50%}",
    "",
    "![Fallback alt caption.](../fig/renders/zz.svg){#fig-zz}",
    "",
  ].join("\n");
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, selection: { anchor: 0 } });
  await raf();
  await raf();
  await new Promise((r) => setTimeout(r, 300));

  const caps = [...document.querySelectorAll(".flux-embed-cap")];
  const cap = caps[0];
  const art = document.querySelector(".flux-embed.sized .flux-embed-art");
  const capW = cap?.getBoundingClientRect().width ?? 0;
  const artW = art?.getBoundingClientRect().width ?? 1;

  // Export parity: model caption + sized figcaption in the standalone HTML.
  const { renderManuscript } = await import("/src/shell/modes/paper/render/renderManuscript.ts");
  const html = (await renderManuscript(view.state.doc.toString(), { paginated: false })).full;

  return {
    prefixOk: (cap?.querySelector("b")?.textContent ?? "") === "Figure 1 |",
    modelCaption: (cap?.textContent ?? "").includes("Growth under stress.") && (cap?.textContent ?? "").includes("a, Control."),
    boldPanels: (cap?.querySelectorAll("strong").length ?? 0) >= 2,
    singleAccentB: (cap?.querySelectorAll("b").length ?? 0) === 1,
    widthTracksArt: Math.abs(capW - artW) < 2,
    fallbackAlt: (caps[1]?.textContent ?? "").includes("Fallback alt caption."),
    exportSizedCap: /<figcaption class="cap sized" style="width:50%">/.test(html),
    exportModelCaption: html.includes("Growth under stress.") && html.includes("<strong>a</strong>, Control."),
    exportFallbackAlt: html.includes("Fallback alt caption."),
  };
});

await shot(page, "embed-caption");
const errs = realErrors(page);
await browser.close();

console.log(JSON.stringify({ embedCaption: res, errs }, null, 2));
const ok = !res.error && Object.values(res).every(Boolean) && errs.length === 0;
if (!ok) {
  console.error("\nEMBED CAPTION VERIFY: FAIL");
  process.exit(1);
}
console.log("\nEMBED CAPTION VERIFY: PASS");
