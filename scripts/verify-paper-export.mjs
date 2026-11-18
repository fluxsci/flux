// V1-readiness 0.4 gate — DOCX/Quarto export integrity + the Export surface.
//   A. REAL UI: the StatusBar's Export segment exists, opens the export DIALOG
//      (format × journal-style axes + an output path for every format), and a
//      backdrop-close returns focus to the editor (focus-return discipline).
//   B. IN-PAGE: materializeRenders() writes fig/renders/<id>.svg for the figures the doc
//      embeds — round-tripped through the fixture bridge — and reports unknown ids.
//   C. ARTIFACT: real Quarto compiles the chosen document to DOCX/HTML, verifies its
//      saved content and unchanged authoring source, and preserves the previous output
//      when a nominally successful compiler emits corrupt bytes. Section A also
//      verifies that the GUI reports a render failure without a false success toast.
// Run (dev server on :1420): node scripts/verify-paper-export.mjs
import { spawnSync } from "node:child_process";
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

console.log("A2 — quarto {ok:false} surfaces in the export receipt, with its reason and no success (behavioral, WS-7.5):");
const toastCase = await page.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // Stub the bridge's quarto entry points: available, but the render FAILS.
  // quartoAvail is sampled at PaperMode MOUNT (it gates the Word menu item),
  // so stub FIRST, then remount paper via the pane store.
  const fig = window.fig;
  const origAvail = fig.quartoAvailable;
  const origRender = fig.quartoRender;
  fig.quartoAvailable = async () => ({ installed: true });
  // A render that takes a moment, so the receipt's running stage is there to be seen.
  fig.quartoRender = async () => { await sleep(500); return { ok: false, log: "stub: pandoc exploded" }; };
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
    // The receipt (ExportReceipt.svelte) is the ONE account of an export: it runs, names its
    // stage, and becomes the result. The failure lands after flush + materialize + the stubbed render.
    const receipt = () => document.querySelector("[data-export-receipt]");
    const states = new Set(), stages = new Set();
    let toast = "";
    for (let i = 0; i < 60 && !toast; i++) {
      await sleep(100);
      const r = receipt();
      if (r) { states.add(r.dataset.state); const now = r.querySelector(".steps .now")?.textContent; if (now) stages.add(now); }
      if (r?.dataset.state === "failed") toast = (r.textContent || "").replace(/\s+/g, " ").trim();
    }
    const r = receipt();
    const reasonShown = /pandoc exploded/.test(r?.textContent || "");
    r && [...r.querySelectorAll("button")].find((b) => /details/i.test(b.textContent || ""))?.click();
    await sleep(80);
    const logShown = /stub: pandoc exploded/.test(receipt()?.querySelector(".detail")?.textContent || "");
    // Nothing else may claim a result: no shell toast, no "Exported" anywhere.
    const elsewhere = [...document.querySelectorAll(".toast, .doi-toast, .export-progress")].map((t) => t.textContent || "").join(" ");
    const falseSuccess = /exported/i.test(elsewhere) || /exported/i.test((receipt()?.querySelector(".head")?.textContent || ""));
    const sticky = await (async () => { await sleep(900); return receipt()?.dataset.state === "failed"; })();
    const busyCleared = ![...document.querySelectorAll(".statusbar .seg")].some((b) => /exporting/i.test(b.textContent || ""));
    receipt()?.querySelector('[aria-label="Dismiss"]')?.click();
    await sleep(120);
    return { toast: toast.slice(0, 120), falseSuccess, states: [...states], stages: [...stages], reasonShown, logShown, elsewhere: elsewhere.trim().slice(0, 80), sticky, busyCleared, dismissed: !receipt() };
  } finally {
    fig.quartoAvailable = origAvail;
    fig.quartoRender = origRender;
  }
});
ok(!toastCase.error && /word export failed/i.test(toastCase.toast ?? ""), `quarto {ok:false} → the receipt says so ("${(toastCase.toast ?? toastCase.error ?? "").slice(0, 60)}")`);
ok(toastCase.falseSuccess === false, "no false 'Exported' on failure");
ok((toastCase.states ?? []).includes("running") && (toastCase.stages ?? []).includes("Rendering"), `the receipt named the stage it was in before failing (${(toastCase.stages ?? []).join(" › ")})`);
ok(toastCase.reasonShown && toastCase.logShown, "the failure carries its reason, and Details opens the engine's log");
ok(!toastCase.elsewhere, `one notice only: no shell toast or second card repeats it ("${toastCase.elsewhere ?? ""}")`);
ok(toastCase.sticky && toastCase.busyCleared && toastCase.dismissed, "a failed receipt stays until dismissed, and Export is available again");

console.log("A3 — the destination follows the FORMAT axis (a Word export never lands on a .pdf name):");
const pathCase = await page.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const exportBtn = [...document.querySelectorAll(".statusbar .seg")].find((b) => /export/i.test(b.textContent || ""));
  if (!exportBtn) return { error: "no Export segment in the StatusBar" };
  exportBtn.click();
  await sleep(300);
  const pathOf = () => (document.querySelector(".export-dialog .path-text")?.textContent || "").trim();
  const onSeg = () => ((document.querySelector(".export-dialog .seg.on") || {}).textContent || "").trim();
  const seg = (re) => [...document.querySelectorAll(".export-dialog .seg")].find((b) => re.test(b.textContent || ""));
  if (!document.querySelector(".export-dialog")) return { error: "dialog did not open" };
  const opened = { format: onSeg(), path: pathOf() };
  const hop = async (re) => {
    seg(re)?.click();
    await sleep(150);
    return pathOf();
  };
  const word = await hop(/word/i);
  const html = await hop(/html/i);
  const pdf = await hop(/pdf/i);
  // A destination the USER picked must survive the next format switch — the
  // caller can only tell it apart from its own default by being told about it.
  const fig = window.fig;
  const origSave = fig.save;
  fig.save = async () => "/demo/exports/my-own-name.pdf";
  let picked = "";
  let afterPick = "";
  try {
    const change = [...document.querySelectorAll(".export-dialog button")].find((b) => /change/i.test(b.textContent || ""));
    change?.click();
    await sleep(300);
    picked = pathOf();
    afterPick = await hop(/word/i);
  } finally {
    fig.save = origSave;
  }
  document.querySelector(".export-backdrop")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  for (let i = 0; i < 12 && document.querySelector(".export-dialog"); i++) await sleep(100);
  return { opened, word, html, pdf, picked, afterPick };
});
ok(!pathCase.error, pathCase.error || "export dialog reopened for the path checks");
const extFor = (label) => (/word/i.test(label) ? ".docx" : /html/i.test(label) ? ".html" : ".pdf");
ok(
  !!pathCase.opened && pathCase.opened.path.endsWith(extFor(pathCase.opened.format)),
  `the path it opens on matches the format it opens on (${pathCase.opened?.format} → ${pathCase.opened?.path})`,
);
ok(pathCase.word?.endsWith(".docx"), `Word → .docx name (${pathCase.word})`);
ok(pathCase.html?.endsWith(".html"), `HTML → .html name (${pathCase.html})`);
ok(pathCase.pdf?.endsWith(".pdf"), `back to PDF → .pdf name (${pathCase.pdf})`);
ok(pathCase.picked === "/demo/exports/my-own-name.pdf", `"Change…" shows the path the user chose (${pathCase.picked})`);
ok(pathCase.afterPick === pathCase.picked, `…and a format switch leaves it alone (${pathCase.afterPick})`);

console.log("A4 — a successful export ends in ONE receipt that names the file:");
const okCase = await page.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  [...document.querySelectorAll(".statusbar .seg")].find((b) => /export/i.test(b.textContent || ""))?.click();
  await sleep(300);
  const d = document.querySelector(".export-dialog");
  if (!d) return { error: "dialog did not open" };
  const sel = d.querySelector("select");
  sel.value = "flux";
  sel.dispatchEvent(new Event("change", { bubbles: true }));
  [...d.querySelectorAll('[aria-label="File format"] .seg')].find((b) => /html/i.test(b.textContent || ""))?.click();
  await sleep(150);
  const out = (d.querySelector(".path-text")?.textContent || "").trim();
  [...d.querySelectorAll("button")].find((b) => /^export$/i.test((b.textContent || "").trim()))?.click();
  const seen = [];
  let state = "";
  for (let i = 0; i < 100 && state !== "done" && state !== "failed"; i++) {
    await sleep(80);
    const r = document.querySelector("[data-export-receipt]");
    if (r) { state = r.dataset.state; if (!seen.includes(state)) seen.push(state); }
  }
  const r = document.querySelector("[data-export-receipt]");
  const text = (r?.textContent || "").replace(/\s+/g, " ").trim();
  let written = "";
  try { written = await window.fig.readText(out); } catch {}
  const elsewhere = [...document.querySelectorAll(".toast, .doi-toast, .export-progress")].map((t) => t.textContent || "").join(" ").trim();
  const box = r?.getBoundingClientRect(), col = document.querySelector(".editor-col")?.getBoundingClientRect(), margin = document.querySelector(".dm-wrap")?.getBoundingClientRect();
  const insideColumn = !!box && !!col && box.left >= col.left && box.right <= col.right + 0.5 && (!margin || box.right <= margin.left + 0.5);
  const exportBack = [...document.querySelectorAll(".statusbar .seg")].some((b) => /^export$/i.test((b.textContent || "").trim()) && !b.disabled);
  r?.querySelector('[aria-label="Dismiss"]')?.click();
  await sleep(150);
  return { state, seen, text: text.slice(0, 140), out, bytes: written.length, elsewhere: elsewhere.slice(0, 80), insideColumn, exportBack, gone: !document.querySelector("[data-export-receipt]") };
});
ok(!okCase.error && okCase.state === "done", okCase.error || `the receipt ends done (${(okCase.seen ?? []).join(" → ")})`);
ok(/^Exported /.test(okCase.text ?? "") && (okCase.text ?? "").includes((okCase.out ?? "?").replace(/^.*\//, "")), `it names the file it wrote ("${okCase.text}")`);
ok((okCase.bytes ?? 0) > 100, `and the file is on disk (${okCase.bytes} bytes at ${okCase.out})`);
ok(!okCase.elsewhere, `no second notice repeats it ("${okCase.elsewhere ?? ""}")`);
ok(okCase.insideColumn, "the receipt sits inside the editor column, never on the dynamic margin");
ok(okCase.exportBack && okCase.gone, "Export is available again and the receipt dismisses");

console.log("B — materializeRenders writes embedded figures to fig/renders/:");
const mat = await page.evaluate(async () => {
  const figures = await import("/src/shell/modes/paper/scholar/figures.ts");
  // Export now refreshes linked sources and reloads accepted figures from disk.
  // Seed the canonical files, so this verifies the real persistence boundary.
  const { buildScaffoldTree } = await import("/src/lib/project/scaffoldTree.ts");
  const { createDeck } = await import("/src/lib/slide/ops.ts");
  const { planFigSave, executeFigSave } = await import("/src/lib/project/figfiles.ts");
  const fb = window.fig, root = "/demo-export";
  const write = (rel, text) => fb.writeText(`${root}/${rel}`, text);
  for (const [rel, text] of buildScaffoldTree({ title: "Export gate" }, createDeck({ id: "export-deck", title: "Export gate" })).files) await write(rel, text);
  const shape = (id, key, number) => ({ id, referenceKey: key, name: `Figure ${number}`, family: "figure", number, canvasId: "c1", x: 0, y: 0, width: 400, height: 300, background: "#ffffff", elements: [] });
  const model = { version: 2, name: "Export gate", canvases: [{ id: "c1", name: "Canvas 1" }], assets: [], palette: [], figures: [shape("f1", "fig-one", 1), shape("f2", "fig-two", 2)] };
  await executeFigSave(planFigSave(model, null), { read: async rel => await fb.exists(`${root}/${rel}`) ? fb.readText(`${root}/${rel}`) : null, write });
  const doc = [
    "![First](../fig/renders/f1.svg){#fig-one width=60%}",
    "",
    "prose",
    "",
    "![Ghost](../fig/renders/ghost.svg){#fig-ghost}", // unknown id → failed
  ].join("\n");
  const r = await figures.materializeRenders("/demo-export", doc);
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

// --- C: real compiler artifacts and fault preservation -------------------------------
console.log("C — chosen-document artifact bytes and failed-publication preservation:");
const artifact = spawnSync(process.execPath, ["--import", "tsx", "scripts/verify-v020-docx-publication.ts"], { cwd: process.cwd(), encoding: "utf8" });
process.stdout.write(artifact.stdout ?? "");
if (artifact.status !== 0) process.stderr.write(artifact.stderr ?? "");
ok(artifact.status === 0, "real Quarto chosen-document DOCX/HTML, XML relationships, recovery and previous-output preservation");

console.log(fails.length ? `\nPAPER-EXPORT VERIFY: FAIL — ${fails.length}` : "\nPAPER-EXPORT VERIFY: PASS");
process.exit(fails.length ? 1 : 0);
