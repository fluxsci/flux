#!/usr/bin/env -S npx tsx
// Embed/caption model acceptance (owner review + moma friction log #10):
//   • composeCaption emits journal-style `**a**, text` (bold letter + comma)
//   • splitCaption distributes the documented `Lead. **a**, … **b**, …`
//     convention (and legacy "(a) …") into the per-panel map; back-references
//     mid-text are NOT markers; unknown letters stay in the lead
//   • flux-core setCaption: whole-string distributes; --panel writes one block
//   • normalizeEmbedAlts clears alts only for resolvable embeds; the
//     normalize-embeds verb walks manuscript + includes
//   Run: npx tsx scripts/verify-embed-normalize.ts
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as core from "../flux-core/index";
import * as ops from "../src/lib/ops";
import { composeCaption, splitCaption } from "../src/lib/captions";
import { normalizeEmbedAlts } from "../src/lib/exportQmd";
import type { Project, TextElement } from "../src/lib/types";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("  ok:", msg);
}

// --- composeCaption format + splitCaption round-trip -------------------------
const p: Project = { version: 2, name: "", canvases: [{ id: "c", name: "C", order: 1 }], figures: [], assets: [], palette: [] };
const fig = ops.createFigure(p, { canvasId: "c" });
for (const letter of ["a", "b", "c"]) {
  ops.addPanelLabel(p, fig.id, { text: letter, x: 0, y: 0, fontSize: 11 });
}
const ids = fig.elements.filter((e) => e.type === "text" && (e as TextElement).panelLabel).map((e) => e.id);
fig.captions = {
  __figure__: "Growth under stress.",
  [ids[0]]: "Control vs treatment.",
  [ids[1]]: "Dose response (see **a**).",
  [ids[2]]: "Summary.",
};
const composed = composeCaption(fig);
assert(
  composed === "Growth under stress. **a**, Control vs treatment. **b**, Dose response (see **a**). **c**, Summary.",
  `composeCaption uses bold-letter+comma style (got: ${composed})`,
);

const split = splitCaption(fig, composed)!;
assert(split.__figure__ === "Growth under stress.", "splitCaption: lead round-trips");
assert(split[ids[0]] === "Control vs treatment.", "splitCaption: panel a round-trips");
assert(split[ids[1]] === "Dose response (see **a**).", "splitCaption: a back-reference inside panel b is NOT a marker");
assert(split[ids[2]] === "Summary.", "splitCaption: panel c round-trips");

const legacy = splitCaption(fig, "Lead sentence. (a) First. (b) Second (cf. (a)). (c) Third.")!;
assert(
  legacy.__figure__ === "Lead sentence." && legacy[ids[0]] === "First." &&
    legacy[ids[1]] === "Second (cf. (a))." && legacy[ids[2]] === "Third.",
  "splitCaption: legacy (a)-style markers distribute too, back-refs ignored",
);
assert(splitCaption(fig, "No markers anywhere here.") === null, "splitCaption: no markers → null (caller keeps lead)");

// --- normalizeEmbedAlts pure planner -----------------------------------------
const doc = [
  "![Huge legacy caption text.](../fig/renders/f1.svg){#fig-one width=91%}",
  "![](../fig/renders/f2.svg){#fig-two}",
  "![Keep me — unresolved.](../fig/renders/gone.svg){#fig-gone}",
  "Prose with ![inline image](x.png) that is not an embed line.",
].join("\n");
const norm = normalizeEmbedAlts(doc, (l) => l === "fig-one" || l === "fig-two");
assert(norm.cleared === 1, "normalize clears exactly the resolvable non-empty alt");
assert(norm.text.includes("![](../fig/renders/f1.svg){#fig-one width=91%}"), "cleared line keeps path + attrs verbatim");
assert(norm.text.includes("![Keep me — unresolved.]"), "unresolved embeds keep their alt (only caption fallback)");
assert(norm.text.includes("![inline image](x.png)"), "non-embed image lines untouched");

// --- flux-core setCaption + normalize-embeds against a real project ----------
const root = await fs.mkdtemp(path.join(os.tmpdir(), "flux-embednorm-"));
try {
  await core.scaffold(root, { title: "EmbedNorm" });
  await fs.mkdir(path.join(root, "plots"), { recursive: true });
  const mk = (n: string) =>
    fs.writeFile(path.join(root, "plots", n),
      `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80" viewBox="0 0 120 80"><rect x="10" y="10" width="40" height="30" fill="#456"/></svg>`);
  await mk("p1.svg");
  await mk("p2.svg");
  const comp = await core.composeFigure(root, [path.join(root, "plots", "p1.svg"), path.join(root, "plots", "p2.svg")], { id: "growth", captionStub: false });
  assert(JSON.stringify(comp.panels) === JSON.stringify(["a", "b"]), "composed 2-panel figure lettered a,b");

  // Whole-string form distributes into the panel map…
  await core.setCaption(root, "growth", "Growth over time. **a**, Control. **b**, Treatment.");
  const cap1 = await fs.readFile(path.join(root, "fig", "captions", "growth.md"), "utf8");
  assert(cap1.trim() === "Growth over time. **a**, Control. **b**, Treatment.", "set-caption round-trips through composeCaption");
  const canvasFile = JSON.parse(await fs.readFile(path.join(root, "fig", "canvases", (JSON.parse(await fs.readFile(path.join(root, "fig", "index.json"), "utf8"))).figures[0].canvas + ".json"), "utf8"));
  const figModel = canvasFile.figures.find((f: { id: string }) => f.id === "growth");
  const capValues = Object.values(figModel.captions as Record<string, string>);
  assert(capValues.includes("Control.") && capValues.includes("Treatment.") && capValues.includes("Growth over time."),
    "whole-string set-caption DISTRIBUTED into lead + per-panel blocks");

  // …and --panel writes one block.
  await core.setCaption(root, "growth", "Control (revised).", { panel: "a" });
  const cap2 = await fs.readFile(path.join(root, "fig", "captions", "growth.md"), "utf8");
  assert(cap2.includes("**a**, Control (revised). **b**, Treatment."), "--panel a updates only that panel");
  let panelErr = "";
  try {
    await core.setCaption(root, "growth", "x", { panel: "z" });
  } catch (e) {
    panelErr = e instanceof Error ? e.message : String(e);
  }
  assert(/no panel "z".*panels: ab/.test(panelErr), "--panel with an unknown letter errors, listing real panels");

  // normalize-embeds clears legacy alts in the manuscript tree.
  const manifest = JSON.parse(await fs.readFile(path.join(root, "project.json"), "utf8"));
  const docPath = path.join(root, manifest.manuscript.path);
  await fs.writeFile(docPath, "# T\n\n![Legacy wall of caption text.](../fig/renders/growth.svg){#fig-growth}\n");
  const r = await core.normalizeEmbeds(root);
  assert(r.files.length === 1 && r.files[0].cleared === 1, "normalize-embeds clears the legacy alt");
  assert((await fs.readFile(docPath, "utf8")).includes("![](../fig/renders/growth.svg){#fig-growth}"), "embed line is canonical after normalize");
  const r2 = await core.normalizeEmbeds(root);
  assert(r2.files.length === 0, "second normalize is a clean no-op");

  console.log("\nEMBED NORMALIZE VERIFY: PASS");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
