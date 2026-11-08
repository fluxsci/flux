// Journal export in the REAL Paper UI (dev server, ?fixture=demo):
//   A. The export dialog offers the four venues, enables Word + PDF for each
//      (HTML disabled), and shows the submission-stage axis only for journals.
//   B. Nature → PDF: the app prepares the venue's manuscript (the text handed to
//      Quarto is captured at render time) — title page, superscript citations,
//      Nature references, front-matter render settings — rasterizes the embedded
//      figure to a 300-dpi PNG beside the document for the render and removes it
//      afterwards, writes <name>.submission.md, and opens the summary panel.
//   C. Science → Word, revision stage: the prepared manuscript is Science's
//      (italic numbered citations, "Fig. 1, A and B", legends only), the .docx is
//      post-processed (real pandoc bytes, figures raster-only) and saved.
//   D. TWIN-ENGINE PARITY: flux-core `compile` prepares the SAME project into
//      the SAME manuscript text the Paper UI handed Quarto (Nature, initial).
// Quarto itself is stubbed in the page (the browser cannot spawn it); the real
// renders are pinned by verify-journal-render.ts.
// Run (dev server): node scripts/verify-journal-export-gui.mjs   (FLUX_URL for a worktree)
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { launch, gotoApp, clickMode, sleep, realErrors, APP_URL } from "./lib/driver.mjs";

const fails = [];
const ok = (cond, msg) => (cond ? console.log("  ✓ " + msg) : (fails.push(msg), console.log("  ✗ " + msg)));

// A genuine .docx (pandoc's own bytes) for the stubbed Quarto to "produce", so
// the app's real post-processing runs on a real package. Through QUARTO's bundled
// pandoc (`quarto pandoc`), resolved the way the app resolves Quarto: a machine
// with Quarto has no standalone `pandoc` on PATH (the GitHub runner, 2026-11-08 —
// this gate read "invalid zip data" there from an empty stand-in .docx).
const work = mkdtempSync(path.join(tmpdir(), "flux-journal-gui-"));
writeFileSync(path.join(work, "a.md"), "Text.\n");
const { quartoCommandSync } = createRequire(import.meta.url)("../electron/managedTools.cjs");
const pandoc = spawnSync(quartoCommandSync(), ["pandoc", path.join(work, "a.md"), "-o", path.join(work, "a.docx")]);
const docxB64 = pandoc.status === 0 ? readFileSync(path.join(work, "a.docx")).toString("base64") : "";
ok(!!docxB64, "pandoc produced a reference .docx for the stubbed render");

const { browser, page } = await launch();
await gotoApp(page, { url: `${APP_URL.replace(/\/$/, "")}/?fixture=demo`, settle: 3500 });
await clickMode(page, "Paper").catch(() => {});
await sleep(600);

// Quarto availability is sampled at Paper mount: stub, then remount.
await page.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  window.fig.quartoAvailable = async () => ({ installed: true });
  window.__flux.panes.resetPanes("figure");
  await sleep(300);
  window.__flux.panes.resetPanes("paper");
  await sleep(1200);
});

console.log("A — the dialog offers the four venues, Word + PDF, and the stage axis:");
const dlg = await page.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  [...document.querySelectorAll(".statusbar .seg")].find((b) => /export/i.test(b.textContent || ""))?.click();
  await sleep(300);
  const d = document.querySelector(".export-dialog");
  if (!d) return { error: "export dialog did not open" };
  const select = d.querySelector("select");
  const styles = [...select.options].map((o) => o.value);
  const pick = async (id) => {
    select.value = id;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await sleep(150);
    const segs = [...d.querySelectorAll('[aria-label="File format"] .seg')];
    return {
      enabled: segs.filter((s) => !s.disabled).map((s) => s.textContent.trim()),
      stage: !!d.querySelector('[aria-label="Submission stage"]'),
    };
  };
  const out = { styles };
  for (const id of ["nature", "science", "cell", "biorxiv", "flux"]) out[id] = await pick(id);
  document.querySelector(".export-backdrop")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  for (let i = 0; i < 12 && document.querySelector(".export-dialog"); i++) await sleep(100);
  return out;
});
ok(!dlg.error, dlg.error || "export dialog opened");
ok(["nature", "science", "cell", "biorxiv"].every((s) => dlg.styles?.includes(s)), `style axis lists Nature, Science, Cell, bioRxiv (${dlg.styles?.join(", ")})`);
for (const id of ["nature", "science", "cell", "biorxiv"]) {
  ok(dlg[id]?.enabled.includes("PDF") && dlg[id]?.enabled.includes("Word") && !dlg[id]?.enabled.includes("HTML"), `${id}: Word and PDF enabled, HTML disabled (${dlg[id]?.enabled.join("/")})`);
  ok(dlg[id]?.stage === true, `${id}: the submission-stage axis is shown`);
}
ok(dlg.flux?.stage === false && dlg.flux?.enabled.includes("HTML"), "the house style keeps HTML and shows no stage axis");

// Insert a figure embed through the live editor (the demo manuscript only refers to it).
await page.evaluate(async () => {
  const v = window.__fluxView;
  const end = v.state.doc.length;
  v.dispatch({ changes: { from: end, insert: "\n![](../fig/renders/growth.svg){#fig-growth width=60%}\n" } });
  await new Promise((r) => setTimeout(r, 1500)); // autosave debounce; export also flushes
});

async function runExport({ style, format, stage }) {
  return page.evaluate(async ({ style, format, stage, docxB64 }) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const fig = window.fig;
    const captured = { prepared: "", to: "", rasters: [], rasterPng: false };
    const orig = fig.quartoRender;
    fig.quartoRender = async (root, to, docPath, opts) => {
      captured.to = to;
      const docAbs = `${root}/${docPath}`;
      captured.prepared = await fig.readText(docAbs);
      const dir = docAbs.slice(0, docAbs.lastIndexOf("/"));
      for (const m of captured.prepared.matchAll(/\]\((\.flux-journal-figures-[^)\s]+\.png)\)/g)) {
        captured.rasters.push(`${dir}/${m[1]}`);
        try {
          const b = new Uint8Array(await fig.readFile(`${dir}/${m[1]}`));
          captured.rasterPng = captured.rasterPng || (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e);
        } catch {}
      }
      const bytes = to === "pdf"
        ? new TextEncoder().encode("%PDF-1.4\n%stub\n")
        : Uint8Array.from(atob(docxB64), (c) => c.charCodeAt(0));
      await fig.writeFile(opts.outPath, bytes);
      return { ok: true, code: 0, log: "Output created", outPath: opts.outPath };
    };
    try {
      [...document.querySelectorAll(".statusbar .seg")].find((b) => /export/i.test(b.textContent || ""))?.click();
      await sleep(300);
      const d = document.querySelector(".export-dialog");
      if (!d) return { error: "dialog did not open" };
      const select = d.querySelector("select");
      select.value = style;
      select.dispatchEvent(new Event("change", { bubbles: true }));
      await sleep(150);
      [...d.querySelectorAll('[aria-label="File format"] .seg')].find((b) => (format === "pdf" ? /pdf/i : /word/i).test(b.textContent))?.click();
      await sleep(120);
      d.querySelector(`[data-stage="${stage}"]`)?.click();
      await sleep(120);
      const outPath = (d.querySelector(".path-text")?.textContent || "").trim();
      const go = [...d.querySelectorAll("button")].find((b) => /^export$/i.test((b.textContent || "").trim()));
      if (!go || go.disabled) return { error: "Export disabled" };
      go.click();
      let panel = null;
      for (let i = 0; i < 80 && !panel; i++) {
        await sleep(150);
        panel = document.querySelector("[data-export-summary]");
      }
      const toasts = [...document.querySelectorAll(".toast, [class*=toast]")].map((t) => t.textContent || "").join(" | ");
      const title = panel?.querySelector(".title")?.textContent || "";
      const sections = panel ? [...panel.querySelectorAll("details > summary")].map((s) => s.textContent.trim()) : [];
      let notes = "";
      try { notes = await fig.readText(outPath.replace(/\.[^./]+$/, "") + ".submission.md"); } catch {}
      let saved = null;
      try { saved = new Uint8Array(await fig.readFile(outPath)); } catch {}
      const rastersLeft = [];
      for (const r of captured.rasters) if (await fig.exists(r)) rastersLeft.push(r);
      panel?.querySelector("button.primary")?.click();
      await sleep(300);
      return { ...captured, outPath, title, sections, notes: notes.slice(0, 4000), toasts, savedLen: saved?.length ?? 0, savedHead: saved ? [...saved.slice(0, 4)] : [], rastersLeft, panelGone: !document.querySelector("[data-export-summary]") };
    } finally {
      fig.quartoRender = orig;
    }
  }, { style, format, stage, docxB64 });
}

console.log("B — Nature → PDF (initial submission):");
const nat = await runExport({ style: "nature", format: "pdf", stage: "initial" });
ok(!nat.error, nat.error || "export ran");
ok(nat.to === "pdf", `Quarto asked for PDF (got ${nat.to})`);
ok(nat.prepared.includes('::: {custom-style="Title"}\nMycelial growth under nutrient stress\n:::') && nat.prepared.includes("Kort Driessen"), "prepared manuscript opens with the Nature title page");
ok(/reports\^1\^\./.test(nat.prepared), "citation printed as a superscript BEFORE the stop ('reports¹.')");
ok(nat.prepared.includes("Smith, J. & Doe, J. Nutrient stress responses in filamentous fungi. *J. Mycol.* **12**, 45–67 (2021)."), "Nature reference entry");
ok(/^citeproc: false$/m.test(nat.prepared) && /reference-doc: \.\.\/styles\/journal\/nature\/reference\.docx/.test(nat.prepared) && /pdf-engine: lualatex/.test(nat.prepared), "front matter carries the venue's render settings");
ok(nat.rasters.length === 1 && nat.rasterPng, `the embedded figure is placed as a 300-dpi PNG written beside the document (${nat.rasters.length})`);
ok(nat.rastersLeft.length === 0, "…and removed after the render");
ok(nat.title === "Nature export" && nat.sections.some((x) => x.startsWith("Needs attention")) && nat.sections.some((x) => x.startsWith("Still to do outside Flux")), `summary panel opens (${nat.title}: ${nat.sections.join(" · ")})`);
ok(/No abstract/.test(nat.notes) && /Reporting Summary/.test(nat.notes), "<name>.submission.md is written with the findings and the outside-Flux list");
ok(nat.savedLen > 0 && String.fromCharCode(...nat.savedHead) === "%PDF", "the PDF is saved to the chosen path");
ok(nat.panelGone, "Done closes the summary panel");

console.log("C — Science → Word (revision files):");
const sci = await runExport({ style: "science", format: "docx", stage: "final" });
ok(!sci.error, sci.error || "export ran");
ok(sci.to === "docx", `Quarto asked for Word (got ${sci.to})`);
ok(/reports \(\*1\*\)\./.test(sci.prepared), "Science citation '(*1*)' before the stop");
ok(/\(Fig\. \d+A\)/.test(sci.prepared) && /Panel Fig\. \d+B shows/.test(sci.prepared), "Science figure grammar ('Fig. 1A')");
ok(!sci.prepared.includes("growth.svg") && /# Figure captions/.test(sci.prepared), "revision stage: no figure images, legends under 'Figure captions'");
ok(sci.rasters.length === 0, "no PDF rasters for a Word render");
ok(sci.savedHead[0] === 0x50 && sci.savedHead[1] === 0x4b, "the post-processed .docx is saved (a zip package)");
ok(sci.title === "Science export", `Science summary panel (${sci.title})`);

const errs = realErrors(page);
ok(errs.length === 0, errs.length ? `console errors: ${errs.join(" | ")}` : "zero console errors");

// --- D: twin-engine parity — flux-core prepares the same manuscript ----------------
console.log("D — flux-core prepares the identical Nature manuscript:");
const dump = await page.evaluate(async () => {
  const fb = window.fig;
  const root = "/demo/myc-growth-paper";
  const out = {};
  const walk = async (dir) => {
    for (const e of await fb.readdir(dir)) {
      const p = `${dir}/${e.name}`;
      if (e.isDir || e.dir) await walk(p);
      else if (/\.(qmd|bib|json|md|yml|svg)$/.test(e.name) && !p.includes("/exports/")) out[p.slice(root.length + 1)] = await fb.readText(p);
    }
  };
  try { await walk(root); } catch (e) { return { error: String(e) }; }
  return out;
});
await browser.close();
if (dump.error || !Object.keys(dump).length) {
  ok(false, `could not read the fixture project back (${dump.error ?? "empty"})`);
} else {
  const proj = path.join(work, "proj");
  for (const [rel, text] of Object.entries(dump)) {
    const abs = path.join(proj, rel);
    spawnSync("mkdir", ["-p", path.dirname(abs)]);
    writeFileSync(abs, text);
  }
  writeFileSync(path.join(work, "parity.mts"), `
    import { readFileSync } from "node:fs";
    process.env.HOME = ${JSON.stringify(work)};
    const { prepareExport } = await import(${JSON.stringify(path.resolve("src/lib/exportPrep.ts"))});
    const { resolveJournalStyle, styledFamilyDef } = await import(${JSON.stringify(path.resolve("src/lib/style/journalStyle.ts"))});
    const { BUILTIN_JOURNAL_STYLES } = await import(${JSON.stringify(path.resolve("src/lib/style/journalPresets.ts"))});
    const { familyById } = await import(${JSON.stringify(path.resolve("src/lib/figfamily.ts"))});
    const { composeCaption, panelLetters } = await import(${JSON.stringify(path.resolve("src/lib/captions.ts"))});
    const ops = await import(${JSON.stringify(path.resolve("src/lib/ops.ts"))});
    const { loadFigModel } = await import(${JSON.stringify(path.resolve("flux-core/model.ts"))});
    const { getCite } = await import(${JSON.stringify(path.resolve("src/lib/references/bibtex.ts"))});
    const root = ${JSON.stringify(proj)};
    const style = resolveJournalStyle("nature", BUILTIN_JOURNAL_STYLES);
    const captions = new Map(), figures = new Map();
    const { project, index } = await loadFigModel(root);
    for (const f of index.figures ?? []) {
      const fig = ops.figById(project, f.id);
      if (fig?.family && fig.number != null) figures.set(f.label, { family: styledFamilyDef(style, familyById(fig.family, project.figureFamilies)), number: fig.number, panels: panelLetters(fig) });
      const cap = fig ? composeCaption(fig) : ""; if (cap.trim()) captions.set(f.label, cap);
    }
    const Cite = await getCite(); const records = {};
    for (const r of new Cite(readFileSync(root + "/references/library.bib", "utf8")).data) records[r.id] = r;
    const io = { readText: async (p) => { try { return readFileSync(p, "utf8"); } catch { return null; } }, writeText: async () => {} };
    let prepared = "";
    io.writeText = async (_p, t) => { prepared = t; };
    await prepareExport(io, { entry: root + "/manuscript/main.qmd", ctx: { captions, figures, panels: style.figures.panels }, journal: { style, stage: "initial", records, supplementaryFigures: [...figures.values()].filter(f => f.family.id === "supplementary").length, docDir: "manuscript" } });
    process.stdout.write(prepared);
  `);
  const r = spawnSync(process.execPath, ["--import", "tsx", path.join(work, "parity.mts")], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) process.stderr.write(r.stderr.slice(-2000));
  // The GUI swapped the SVG for its per-render PNG; normalise that one path.
  const norm = (t) => t.replace(/\.flux-journal-figures-[^)\s]+\.png/g, "../fig/renders/growth.svg");
  ok(r.status === 0 && norm(nat.prepared) === r.stdout, r.status === 0 && norm(nat.prepared) !== r.stdout
    ? `GUI and flux-core prepared texts differ:\n--- gui\n${norm(nat.prepared).slice(0, 1500)}\n--- core\n${r.stdout.slice(0, 1500)}`
    : "Paper UI and flux-core hand Quarto byte-identical Nature manuscripts");
}
rmSync(work, { recursive: true, force: true });

console.log(fails.length ? `\nJOURNAL-EXPORT-GUI VERIFY: FAIL — ${fails.length}` : "\nJOURNAL-EXPORT-GUI VERIFY: PASS");
process.exit(fails.length ? 1 : 0);
