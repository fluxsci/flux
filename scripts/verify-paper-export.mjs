// V1-readiness 0.4 gate — DOCX/Quarto export integrity + the (previously dead) Export menu.
//   A. REAL UI: the StatusBar's Export segment exists, opens the export menu, and a
//      scrim-close returns focus to the editor (EDITING-FEEL invariant 7).
//   B. IN-PAGE: materializeRenders() writes fig/renders/<id>.svg for the figures the doc
//      embeds — round-tripped through the fixture bridge — and reports unknown ids.
//   C. SOURCE: the docx flow flushes BEFORE quarto, materializes BEFORE quarto, propagates
//      {ok:false,log} to an error toast (no false "Exported ✓"), threads the ACTIVE doc,
//      offers Reveal; main.cjs contains docPath + verifies the artifact + fsGuards the
//      reveal; flux-core compile() materializes renders for bare-quarto/agent parity.
// Run (dev server on :1420): node scripts/verify-paper-export.mjs
import { readFileSync } from "node:fs";
import { launch, gotoApp, clickMode, sleep, realErrors } from "./lib/driver.mjs";

const fails = [];
const ok = (cond, msg) => (cond ? console.log("  ✓ " + msg) : (fails.push(msg), console.log("  ✗ " + msg)));

// --- A + B: live fixture ------------------------------------------------------------
const { browser, page } = await launch();
await gotoApp(page, { url: "http://127.0.0.1:1420/?fixture=demo", settle: 3500 });
await clickMode(page, "Paper").catch(() => {});
await sleep(600);

console.log("A — Export menu is reachable from the StatusBar:");
const ui = await page.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const exportBtn = [...document.querySelectorAll(".statusbar .seg")].find((b) => /export/i.test(b.textContent || ""));
  if (!exportBtn) return { error: "no Export segment in the StatusBar" };
  exportBtn.click();
  await sleep(250);
  const menu = document.querySelector(".export-menu");
  const items = menu ? [...menu.querySelectorAll("button")].map((b) => (b.textContent || "").trim()) : [];
  const scrim = document.querySelector(".menu-scrim");
  scrim?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  // The menu leaves through a Svelte outro transition — poll for real removal.
  let menuGone = false;
  for (let i = 0; i < 12 && !menuGone; i++) {
    await sleep(100);
    menuGone = !document.querySelector(".export-menu");
  }
  const focusInEditor = !!document.activeElement?.closest(".cm-editor");
  return { items, menuGone, focusInEditor };
});
ok(!ui.error, ui.error || "StatusBar has an Export segment");
ok((ui.items ?? []).some((t) => /pdf/i.test(t)) && (ui.items ?? []).some((t) => /word/i.test(t)), `menu offers PDF/HTML/Word (${(ui.items ?? []).join(" · ")})`);
ok(ui.menuGone === true, "scrim click closes the menu");
ok(ui.focusInEditor === true, "focus returns to the editor after close (feel invariant 7)");

console.log("A2 — quarto {ok:false} surfaces as an error toast (behavioral, WS-7.5):");
const toastCase = await page.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // Stub the bridge's quarto entry points: available, but the render FAILS.
  // quartoAvail is sampled at PaperMode MOUNT (it gates the Word menu item),
  // so stub FIRST, then remount paper via the pane store.
  const fig = window.fig;
  const origAvail = fig.quartoAvailable;
  const origRender = fig.quartoRender;
  fig.quartoAvailable = async () => ({ installed: true });
  fig.quartoRender = async () => ({ ok: false, log: "stub: pandoc exploded" });
  try {
    window.__flux.panes.resetPanes("figure");
    await sleep(300);
    window.__flux.panes.resetPanes("paper");
    await sleep(900);
    const exportBtn = [...document.querySelectorAll(".statusbar .seg")].find((b) => /export/i.test(b.textContent || ""));
    exportBtn?.click();
    await sleep(250);
    const word = [...document.querySelectorAll(".export-menu button")].find((b) => /word/i.test(b.textContent || ""));
    if (!word) return { error: "no Word item in the export menu" };
    word.click();
    // The failure toast lands after flush + materialize + the stubbed render.
    let toast = "";
    for (let i = 0; i < 40 && !toast; i++) {
      await sleep(150);
      toast = [...document.querySelectorAll(".toast, [class*=toast]")].map((t) => t.textContent || "").join(" ");
      if (!/word export failed|failed/i.test(toast)) toast = "";
    }
    const falseSuccess = [...document.querySelectorAll(".toast, [class*=toast]")].some((t) => /exported ✓|exported/i.test((t.textContent || "").toLowerCase()) && !/failed/i.test(t.textContent || ""));
    return { toast: toast.slice(0, 120), falseSuccess };
  } finally {
    fig.quartoAvailable = origAvail;
    fig.quartoRender = origRender;
  }
});
ok(!toastCase.error && /failed/i.test(toastCase.toast ?? ""), `quarto {ok:false} → error toast ("${(toastCase.toast ?? toastCase.error ?? "").slice(0, 60)}")`);
ok(toastCase.falseSuccess === false, "no false 'Exported ✓' on failure");

console.log("B — materializeRenders writes embedded figures to fig/renders/:");
const mat = await page.evaluate(async () => {
  const figures = await import("/src/shell/modes/paper/scholar/figures.ts");
  const fig = (id, label, name, order) => ({ id, label, name, order, number: String(order + 1), canvas: "c1", caption: "", panels: [] });
  const shape = (id, name) => ({ id, name, canvasId: "c1", x: 0, y: 0, width: 400, height: 300, background: "#ffffff", elements: [] });
  window.__fluxSeedFigures([fig("f1", "fig-one", "Figure 1", 0), fig("f2", "fig-two", "Figure 2", 1)], { f1: shape("f1", "One"), f2: shape("f2", "Two") }, {});
  const doc = [
    "![First](../fig/renders/f1.svg){#fig-one width=60%}",
    "",
    "prose",
    "",
    "![Ghost](../fig/renders/ghost.svg){#fig-ghost}", // unknown id → failed
  ].join("\n");
  const r = await figures.materializeRenders("/demo-export", doc);
  const fb = window.fig;
  let written = "";
  try {
    written = await fb.readText("/demo-export/fig/renders/f1.svg");
  } catch {
    written = "";
  }
  return { wrote: r.wrote, failed: r.failed, svgOk: written.startsWith("<svg") || written.includes("<svg") };
});
ok(mat.wrote === 1, `wrote exactly the known embedded figure (wrote=${mat.wrote})`);
ok(Array.isArray(mat.failed) && mat.failed.includes("ghost"), `unknown figure reported as failed (${JSON.stringify(mat.failed)})`);
ok(mat.svgOk === true, "written render is real SVG (round-tripped through the bridge)");

const errs = realErrors(page);
ok(errs.length === 0, errs.length ? `console errors: ${errs.join(" | ")}` : "zero console errors");
await browser.close();

// --- C: source wiring ----------------------------------------------------------------
console.log("C — export-flow source wiring:");
const pm = readFileSync("src/shell/modes/paper/PaperMode.svelte", "utf8");
const docxBlock = pm.slice(pm.indexOf('if (kind === "docx")'), pm.indexOf('const { full, title }'));
ok(/await autosave\.flush\(\)/.test(docxBlock), "docx flow flushes the autosave before quarto (disk freshness)");
ok(
  docxBlock.indexOf("autosave.flush()") < docxBlock.indexOf("materializeRenders") &&
    docxBlock.indexOf("materializeRenders") < docxBlock.indexOf("fb.quartoRender(pm.root"),
  "order: flush → materialize renders → quarto",
);
ok(/quartoRender\(pm\.root, "docx", activeDocPath\)/.test(docxBlock), "renders the ACTIVE document, not always main");
ok(/if \(!r\?\.ok\)/.test(docxBlock) && /Word export failed/.test(docxBlock), "quarto {ok:false} → error toast (false 'Exported ✓' killed)");
ok(/ConflictError/.test(docxBlock), "flush ConflictError aborts with the diverged-banner hint");
ok(/label: "Reveal"/.test(docxBlock) && /revealPath/.test(docxBlock), "success toast offers Reveal");
ok(/onExport=\{\(\) => \(exportOpen = true\)\}/.test(pm), "StatusBar wired to open the export menu");

const main = readFileSync("electron/main.cjs", "utf8");
ok(/quarto:render", async \(e, \{ root, to, docPath \}\)/.test(main), "quarto:render accepts docPath");
ok(/underDir\(docAbs, rootAbs\)/.test(main) && /\\\.qmd\$/.test(main), "docPath contained under root + .qmd-only");
ok(/no output file found/.test(main) && /outPath/.test(main), "artifact existence verified, outPath returned");
ok(/shell:showItemInFolder/.test(main) && main.slice(main.indexOf("shell:showItemInFolder")).slice(0, 300).includes("fsGuard"), "showItemInFolder exists and is fsGuard'd");

// WS-6.2: compile/materializeRenders live in the manuscript + render modules.
const core = readFileSync("flux-core/manuscript.ts", "utf8") + readFileSync("flux-core/render.ts", "utf8");
ok(/export async function materializeRenders/.test(core) && /materializeRenders\(root, m\.manuscript\.path\)/.test(core), "flux-core compile() materializes renders (bare-quarto/agent parity)");
const cli = readFileSync("flux-cli.ts", "utf8");
ok(/case "render-figures"/.test(cli), "CLI exposes render-figures");

console.log(fails.length ? `\nPAPER-EXPORT VERIFY: FAIL — ${fails.length}` : "\nPAPER-EXPORT VERIFY: PASS");
process.exit(fails.length ? 1 : 0);
