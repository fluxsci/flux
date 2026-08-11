// V1-readiness 0.4 gate — DOCX/Quarto export integrity + the Export surface.
//   A. REAL UI: the StatusBar's Export segment exists, opens the export DIALOG
//      (format × journal-style axes + an output path for every format), and a
//      backdrop-close returns focus to the editor (focus-return discipline).
//   B. IN-PAGE: materializeRenders() writes fig/renders/<id>.svg for the figures the doc
//      embeds — round-tripped through the fixture bridge — and reports unknown ids.
//   C. SOURCE: the docx flow flushes BEFORE quarto, materializes BEFORE quarto, propagates
//      {ok:false,log} to an error toast (no false "Exported ✓"), threads the ACTIVE doc,
//      offers Reveal; main.cjs contains docPath + verifies the artifact + fsGuards the
//      reveal; flux-core compile() materializes renders for bare-quarto/agent parity.
// Run (dev server on :1420): node scripts/verify-paper-export.mjs
import { readFileSync } from "node:fs";
import { launch, gotoApp, clickMode, sleep, realErrors, APP_URL } from "./lib/driver.mjs";

const fails = [];
const ok = (cond, msg) => (cond ? console.log("  ✓ " + msg) : (fails.push(msg), console.log("  ✗ " + msg)));

// --- A + B: live fixture ------------------------------------------------------------
const { browser, page } = await launch();
// Honour FLUX_URL (driver.mjs) so this gate can run against a worktree's own
// dev server instead of assuming :1420 — parallel sessions each own a port.
await gotoApp(page, { url: `${APP_URL.replace(/\/$/, "")}/?fixture=demo`, settle: 3500 });
await clickMode(page, "Paper").catch(() => {});
await sleep(600);

console.log("A — Export dialog is reachable from the StatusBar (format × style axes):");
const ui = await page.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const exportBtn = [...document.querySelectorAll(".statusbar .seg")].find((b) => /export/i.test(b.textContent || ""));
  if (!exportBtn) return { error: "no Export segment in the StatusBar" };
  exportBtn.click();
  await sleep(250);
  const dlg = document.querySelector(".export-dialog");
  const formats = dlg ? [...dlg.querySelectorAll(".seg")].map((b) => (b.textContent || "").trim()) : [];
  const styles = dlg ? [...dlg.querySelectorAll("select option")].map((o) => (o.textContent || "").trim()) : [];
  const hasPath = !!dlg?.querySelector(".path-text")?.textContent?.trim();
  const backdrop = document.querySelector(".export-backdrop");
  backdrop?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  // The dialog leaves through a Svelte outro transition — poll for real removal.
  let gone = false;
  for (let i = 0; i < 12 && !gone; i++) {
    await sleep(100);
    gone = !document.querySelector(".export-dialog");
  }
  const focusInEditor = !!document.activeElement?.closest(".cm-editor");
  return { formats, styles, hasPath, gone, focusInEditor };
});
ok(!ui.error, ui.error || "StatusBar has an Export segment");
ok(
  (ui.formats ?? []).some((t) => /pdf/i.test(t)) &&
    (ui.formats ?? []).some((t) => /word/i.test(t)) &&
    (ui.formats ?? []).some((t) => /html/i.test(t)),
  `format axis offers PDF/Word/HTML (${(ui.formats ?? []).join(" · ")})`,
);
ok((ui.styles ?? []).length >= 1, `style axis is populated (${(ui.styles ?? []).join(" · ")})`);
// Word used to land beside the .qmd with no say; every format now has a destination.
ok(ui.hasPath === true, "dialog shows an output path for the selected format");
ok(ui.gone === true, "backdrop click closes the dialog");
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
    // Pick the Word format on the axis, then commit with Export.
    const word = [...document.querySelectorAll(".export-dialog .seg")].find((b) => /word/i.test(b.textContent || ""));
    if (!word) return { error: "no Word segment in the export dialog" };
    word.click();
    await sleep(120);
    const go = [...document.querySelectorAll(".export-dialog button")].find((b) => /^export$/i.test((b.textContent || "").trim()));
    if (!go) return { error: "no Export button in the dialog" };
    if (go.disabled) return { error: "Export button disabled though quarto is stubbed available" };
    go.click();
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
  const fig = (id, label, name, order) => ({ id, label, name, family: "figure", order, number: order + 1, display: `Fig. ${order + 1}`, captionLabel: `Figure ${order + 1} | `, canvas: "c1", caption: "", panels: [] });
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
const docxBlock = pm.slice(pm.indexOf('if (plan.format === "docx")'), pm.indexOf("// In-app engines"));
ok(docxBlock.length > 0, "docx branch is locatable in doExport(plan)");
ok(/await autosave\.flush\(\)/.test(docxBlock), "docx flow flushes the autosave before quarto (disk freshness)");
ok(
  docxBlock.indexOf("autosave.flush()") < docxBlock.indexOf("materializeRenders") &&
    docxBlock.indexOf("materializeRenders") < docxBlock.indexOf("transformDocsForQuarto") &&
    docxBlock.indexOf("transformDocsForQuarto") < docxBlock.indexOf("fb.quartoRender(pm.root"),
  "order: flush → materialize renders → prepare (transform) → quarto",
);
ok(/quartoRender\(pm\.root, "docx", activeDocPath, \{/.test(docxBlock), "renders the ACTIVE document, not always main");
// The dialog collects a destination for EVERY format now; docx no longer lands
// beside the .qmd by default.
ok(/outPath: plan\.outPath/.test(docxBlock), "the chosen output path is passed through to the render");
ok(/token/.test(docxBlock) && /onQuartoLog/.test(docxBlock), "render is tokened + subscribes to the live log (progress card)");
ok(/r\?\.cancelled/.test(docxBlock) && /Export cancelled/.test(docxBlock), "a cancelled render reports as cancelled, not as a failure");
ok(/if \(!r\?\.ok\)/.test(docxBlock) && /Word export failed/.test(docxBlock), "quarto {ok:false} → error toast (false 'Exported ✓' killed)");
ok(/ConflictError/.test(docxBlock), "flush ConflictError aborts with the diverged-banner hint");
ok(/label: "Reveal"/.test(docxBlock) && /revealPath/.test(docxBlock), "success toast offers Reveal");
ok(/restoreDocs\(\)/.test(docxBlock) && /finally/.test(docxBlock), "sources are restored in a finally, whatever the render does");
ok(/onExport=\{openExportDialog\}/.test(pm), "StatusBar wired to open the export dialog");
ok(/async function cancelExport/.test(pm) && /quartoCancel/.test(pm), "cancel path invokes quartoCancel");

const main = readFileSync("electron/main.cjs", "utf8");
// Assert the FIELDS the handler destructures, not their exact order or the
// full list — a later field addition should not fail a gate about docPath.
const renderSig = (/quarto:render",\s*async\s*\(e,\s*\{([^}]*)\}\)/.exec(main) ?? [, ""])[1];
for (const field of ["root", "to", "docPath", "profile", "outPath", "token"]) {
  ok(new RegExp(`\\b${field}\\b`).test(renderSig), `quarto:render accepts ${field}`);
}
ok(/\^\[a-z0-9-\]\{1,32\}\$/.test(main), "profile name is slug-validated before it reaches the command line");
// Multi-window 2026-08-11: fsGuard carries the sender id (per-window dialog approvals).
ok(/fsGuard\(destAbs, e\.sender\.id\)/.test(main), "the requested output path clears fsGuard before anything is written");
ok(/quarto:cancel/.test(main) && /SIGTERM/.test(main) && /SIGKILL/.test(main), "cancel kills the render (escalating if it ignores SIGTERM)");
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
