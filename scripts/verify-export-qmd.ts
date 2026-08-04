#!/usr/bin/env -S npx tsx
// Feedback-sweep acceptance (moma friction log #6/#7/#8) + figure families:
// the bare-Quarto export transform + not-a-project diagnosis + full cite
// metadata echo.
//   • transformQmdForExport injects the FAMILY caption lead + composed caption
//     into EMPTY embed alts, DEMOTES embed crossref ids ({#fig-x} → {#x-fig-x})
//     so Quarto adds no numbering/label of its own, and literalizes ALL
//     `@fig-…` refs with family templates ("Fig. S2a–c") — numbers are the
//     editor's family identity, never embed-appearance order
//   • compile applies it in place and RESTORES sources byte-identical
//     (integration leg runs only when quarto is on PATH)
//   • wrong roots fail with "<dir> is not a Flux project", suggesting the
//     nearest real root — not "figure not found" / raw ENOENT
//   • bibtexSummary surfaces author/title/year in full
//   Run: npx tsx scripts/verify-export-qmd.ts
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import * as core from "../flux-core/index";
import { collectEmbedLabels, transformQmdForExport, readQmdTree, resolveInclude } from "../src/lib/exportQmd";
import { BUILTIN_FAMILIES } from "../src/lib/figfamily";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("  ok:", msg);
}

// --- pure transform ---------------------------------------------------------
const doc = [
  "# Results",
  "",
  "See @fig-growth-a and @fig-dose-a-c (also @fig-dose-a,c and @fig-growth).",
  "A ref to @fig-my-fig-x stays (unknown spec base) and @fig-nowhere-a too.",
  "Watch @fig-clip too.",
  "",
  "![](../fig/renders/growth.svg){#fig-growth width=91%}",
  "",
  "![Existing alt stays.](../fig/renders/dose.svg){#fig-dose}",
  "",
  "![](../fig/renders/myfig.svg){#fig-my-fig}",
].join("\n");

const labels = collectEmbedLabels(doc);
assert(JSON.stringify(labels) === JSON.stringify(["fig-growth", "fig-dose", "fig-my-fig"]),
  "collectEmbedLabels: order of appearance, deduped");
const [FIG, SUP, ED] = BUILTIN_FAMILIES;
const MOVIE = { id: "movie", displayName: "Movie", refTemplate: "Mov. {num}{panel}", captionTemplate: "Movie {num} | " };
const ctx = {
  captions: new Map([
    ["fig-growth", "Growth [subset] over time. **a**, Control."],
    ["fig-dose", "Dose response."],
  ]),
  // Family identity is the EDITOR's — deliberately decoupled from embed order
  // (dose embeds 2nd but is Supplementary 2; my-fig embeds 3rd but is ED 3;
  // clip is a custom-family figure with no embed at all).
  figures: new Map([
    ["fig-growth", { family: FIG, number: 1 }],
    ["fig-dose", { family: SUP, number: 2 }],
    ["fig-my-fig", { family: ED, number: 3 }],
    ["fig-clip", { family: MOVIE, number: 4 }],
  ]),
};
const out = transformQmdForExport(doc, ctx);
assert(out.includes("![**Figure 1 |** Growth \\[subset\\] over time. **a**, Control.](../fig/renders/growth.svg){#x-fig-growth width=91%}"),
  "empty alt gets the family caption lead + composed caption, escaped; id demoted");
assert(out.includes("![Existing alt stays.](../fig/renders/dose.svg){#x-fig-dose}"),
  "a non-empty alt is left verbatim (id still demoted)");
assert(out.includes("See Fig. 1a and Fig. S2a–c (also Fig. S2a,c and Fig. 1)."),
  "ALL fig refs literalize with family templates (range → en-dash; whole-figure too)");
assert(out.includes("Watch Mov. 4 too."), "custom-family refs use their template");
assert(out.includes("@fig-nowhere-a"), "refs to unknown labels pass through untouched");
assert(out.includes("@fig-my-fig-x") === false && out.includes("Extended Data Fig. 3x"),
  "hyphenated labels split by longest known label (fig-my-fig + panel x)");

// --- the shared include walker ----------------------------------------------
// ONE walker serves both engines (flux-core injects node:fs + node:path; the
// renderer injects its file bridge). These pins are what stop the two from
// drifting apart again.
{
  assert(resolveInclude("/p/manuscript/main.qmd", "sections/intro.qmd") === "/p/manuscript/sections/intro.qmd",
    "resolveInclude: relative to the INCLUDING file's directory");
  assert(resolveInclude("/p/manuscript/main.qmd", "../shared/boiler.qmd") === "/p/shared/boiler.qmd",
    "resolveInclude: `..` climbs out of the including directory");
  assert(resolveInclude("/p/manuscript/main.qmd", "./a/./b.qmd") === "/p/manuscript/a/b.qmd",
    "resolveInclude: `.` segments fold away");
  assert(resolveInclude("C:\\p\\m\\main.qmd", "sections\\intro.qmd") === "C:\\p\\m\\sections\\intro.qmd",
    "resolveInclude: win32 paths keep their separator");
  assert(resolveInclude("/a.qmd", "../../../b.qmd") === "/b.qmd",
    "resolveInclude: a runaway `..` chain cannot escape past the root");

  const tree = new Map<string, string>([
    ["/p/main.qmd", "TOP\n{{< include sections/one.qmd >}}\nMID\n{{< include sections/two.qmd >}}\nEND"],
    ["/p/sections/one.qmd", "ONE{{< include ../deep/three.qmd >}}"],
    ["/p/deep/three.qmd", "THREE"],
    ["/p/sections/two.qmd", "TWO"],
  ]);
  const io = { readText: async (a: string) => tree.get(a) ?? null };
  const walked = await readQmdTree("/p/main.qmd", io);
  assert(walked.expanded === "TOP\nONETHREE\nMID\nTWO\nEND",
    `includes splice in place, depth-first (got: ${JSON.stringify(walked.expanded)})`);
  assert(JSON.stringify(walked.files) ===
      JSON.stringify(["/p/main.qmd", "/p/sections/one.qmd", "/p/deep/three.qmd", "/p/sections/two.qmd"]),
    "files come back in traversal order");
  assert(walked.texts.get("/p/deep/three.qmd") === "THREE",
    "texts map carries every file's source, keyed by the path it was read from");

  // A missing include must not throw — it contributes empty text, exactly as
  // the pre-unification engines behaved.
  const missing = await readQmdTree("/p/gone.qmd", io);
  assert(missing.expanded === "" && missing.files.length === 1,
    "an unreadable file yields empty text rather than throwing");

  // Shared `seen` across entry documents: normalizeEmbeds walks main AND every
  // supplementary doc, and a file already visited must not be listed twice.
  const seen = new Set<string>();
  await readQmdTree("/p/main.qmd", io, seen);
  const second = await readQmdTree("/p/sections/one.qmd", io, seen);
  assert(second.files.length === 0 && second.expanded === "",
    "a file already walked under a shared `seen` set contributes nothing again");
}

// --- wrong-root diagnosis ----------------------------------------------------
const junk = await fs.mkdtemp(path.join(os.tmpdir(), "flux-notaproject-"));
const proj = await fs.mkdtemp(path.join(os.tmpdir(), "flux-exportqmd-"));
try {
  let msg = "";
  try {
    await core.listProject(junk);
  } catch (e) {
    msg = e instanceof Error ? e.message : String(e);
  }
  assert(/is not a Flux project \(no project\.json\)/.test(msg),
    `wrong root says WHY (got: ${msg.slice(0, 80)})`);

  await core.scaffold(proj, { title: "ExportQmd" });
  const sub = path.join(proj, "plots");
  await fs.mkdir(sub, { recursive: true });
  let msg2 = "";
  try {
    await core.listProject(sub);
  } catch (e) {
    msg2 = e instanceof Error ? e.message : String(e);
  }
  assert(msg2.includes("did you mean") && msg2.includes(proj),
    "a subdir of a real project suggests the actual root");

  // --- bibtexSummary ----------------------------------------------------------
  const summary = core.bibtexSummary(
    `@misc{robot_2026,\n  author = {Robot, Open Data},\n  title = {MoMA Collection - Automatic Update},\n  year = {2026},\n}\n`,
  );
  assert(summary === "Robot, Open Data (2026). MoMA Collection - Automatic Update",
    `bibtexSummary shows the junk metadata in full (got: ${summary})`);

  // --- compile integration (only when quarto is installed) --------------------
  const hasQuarto = spawnSync("quarto", ["--version"], { stdio: "ignore" }).status === 0;
  if (!hasQuarto) {
    console.log("  (skip) quarto not on PATH — compile integration leg skipped");
  } else {
    const plot = path.join(proj, "plots", "p.svg");
    await fs.writeFile(plot,
      `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="60" viewBox="0 0 100 60"><rect x="10" y="10" width="60" height="30" fill="#345"/></svg>`);
    const comp = await core.composeFigure(proj, [plot], { id: "growth", captionStub: false });
    await core.setCaption(proj, comp.figureId, "Growth over time.");
    const manifest = JSON.parse(await fs.readFile(path.join(proj, "project.json"), "utf8"));
    const docPath = path.join(proj, manifest.manuscript.path);
    const secDir = path.join(path.dirname(docPath), "sections");
    await fs.mkdir(secDir, { recursive: true });
    await fs.writeFile(path.join(secDir, "res.qmd"),
      "## Res\n\nPanel @fig-growth-a shows it.\n\n![](../fig/renders/growth.svg){#fig-growth}\n");
    const main = "# T\n\n{{< include sections/res.qmd >}}\n";
    await fs.writeFile(docPath, main);
    const r = await core.compile(proj, "html");
    assert(r.code === 0, `quarto compile exits 0 (log tail: ${r.log.trimEnd().split("\n").slice(-3).join(" · ")})`);
    const html = await fs.readFile(docPath.replace(/\.qmd$/, ".html"), "utf8");
    // The scaffold's blank "Figure 1" counts in the family, so the composed
    // figure is number 2 — same number the figure editor shows (that
    // consistency, not embed order, is the family-numbering contract).
    assert(html.includes("Fig. 2a"), "compiled HTML shows the family-formatted panel ref");
    assert(html.includes("Growth over time."), "compiled HTML figcaption carries the model caption");
    assert(html.includes("Figure 2 |"), "compiled HTML figcaption carries the family caption lead");
    assert(!/Figure&nbsp;\d:|>Figure \d:/.test(html), "Quarto adds no numbering label of its own (demoted id)");
    assert(!/\?@fig-/.test(html), "no broken ?@fig- refs in the compiled HTML");
    assert((await fs.readFile(docPath, "utf8")) === main, "main qmd restored byte-identical");
    assert((await fs.readFile(path.join(secDir, "res.qmd"), "utf8")).includes("Panel @fig-growth-a"),
      "included section restored byte-identical");
  }

  console.log("\nEXPORT-QMD VERIFY: PASS");
} finally {
  await fs.rm(junk, { recursive: true, force: true });
  await fs.rm(proj, { recursive: true, force: true });
}
