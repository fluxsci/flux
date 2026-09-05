// Panel references retain their stable element identity through relabels,
// unsaved Paper edits, GUI/CLI saves and interrupted two-phase persistence.
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Figure, Project } from "../src/lib/types";
import { applyReferenceReplacements, figureReferenceTokens, planFigureReferenceEdits, snapshotFigureReferences } from "../src/lib/project/figureReferenceEdits";
import { prepareFigureReferenceUpdate, commitFigureReferenceUpdate, recoverFigureReferenceUpdate, registerLiveFigureReferenceDocument, releaseFigureReferenceUpdate } from "../src/lib/project/figureReferenceSync";
import { executeFigSave, planFigSave } from "../src/lib/project/figfiles";
import { mutateFigModel } from "../flux-core/model";

let checks = 0;
function eq(actual: unknown, expected: unknown, label: string) { assert.deepEqual(actual, expected, label); checks++; }
async function rejects(fn: () => Promise<unknown>, pattern: RegExp, label: string) { await assert.rejects(fn, pattern, label); checks++; }
const root = await fs.mkdtemp(path.join(os.tmpdir(), "flux-panel-ref-gate-"));
const io = {
  readText: (p: string) => fs.readFile(p, "utf8"),
  writeText: async (p: string, s: string) => { await fs.mkdir(path.dirname(p), { recursive: true }); await fs.writeFile(p, s); },
  exists: async (p: string) => { try { await fs.access(p); return true; } catch { return false; } },
  remove: (p: string) => fs.rm(p, { force: true }),
  readdir: async (p: string) => (await fs.readdir(p, { withFileTypes: true })).map((d) => ({ name: d.name, dir: d.isDirectory() })),
};
const figure = (): Figure => ({ id: "experiment", referenceKey: "fig-study", name: "Figure 1", family: "figure", number: 1, canvasId: "c", x: 0, y: 0, width: 300, height: 200, background: "#fff", captions: {}, elements: ["a", "b", "c"].map((text, i) => ({ id: `panel-${i}`, type: "text", panelLabel: true, text, x: i * 40, y: 0, width: 20, height: 20, rotation: 0, fontSize: 12, fontFamily: "Arial", fontWeight: 400, fill: "#000", align: "left" } as any)) });
const initial: Project = { version: 2, name: "Panel gate", canvases: [{ id: "c", name: "Canvas" }], figures: [figure()], assets: [], palette: [] };
const changed = structuredClone(initial);
for (const [i, el] of changed.figures[0].elements.entries()) if (el.type === "text") el.text = ["b", "c", "a"][i];
const old = snapshotFigureReferences(initial.figures), next = snapshotFigureReferences(changed.figures);
const text = "See @fig-study-a and @fig-study-a-c, with @fig-study-b1.\n";
const expected = "See @fig-study-b and @fig-study-b,c,a, with @fig-study-b1.\n";
const save = async (project: Project) => executeFigSave(planFigSave(project, null), { read: (rel) => io.readText(`${root}/${rel}`).catch(() => null), write: (rel, text) => io.writeText(`${root}/${rel}`, text) });
const reset = async () => {
  await io.remove(`${root}/.meta/figure-reference-update.json`);
  await io.writeText(`${root}/project.json`, JSON.stringify({ schemaVersion: "0.1.0", title: "Gate", manuscript: { path: "manuscript/main.qmd" }, supplementary: [], figures: [], slides: [] }));
  await io.writeText(`${root}/manuscript/main.qmd`, text);
  await save(initial);
};
const prepare = async () => {
  const plan = planFigSave(changed, null);
  return prepareFigureReferenceUpdate(root, initial.figures, changed.figures, io, { figureFiles: [...plan.canvases, plan.index] });
};
try {
  eq(applyReferenceReplacements(text, planFigureReferenceEdits(text, old, next).changes), expected, "cyclic relabel follows panel IDs once, including expanded ranges");
  eq(planFigureReferenceEdits(text, old, next).conflicts, [], "unknown pre-existing panel remains unchanged");
  eq(figureReferenceTokens("@fig-study-a `@fig-code` ``literal ` @fig-double`` <!-- @fig-comment -->\n```qmd\n@fig-fence\n```\n\\@fig-escaped {#fig-study}").map((m) => m.token), ["fig-study-a", "fig-study"], "code, fenced examples, comments and escaped refs remain literal");
  eq(planFigureReferenceEdits("`@fig-study-a` and @fig-study", old, next).changes, [], "whole-figure refs and examples do not change on a panel relabel");
  const collision = { ...old[0], id: "whole", label: "fig-study-b", panels: [], panelIds: [] };
  eq(planFigureReferenceEdits("@fig-study-a", [...old, collision], [...next, collision]).conflicts.length, 1, "renamed panel cannot bind another figure's exact key");
  const removed = [{ ...next[0], panels: ["a", "c"], panelIds: ["panel-2", "panel-1"] }];
  eq(planFigureReferenceEdits("@fig-study-a", old, removed).conflicts.length, 1, "deleted referenced panel cannot silently bind a different panel");
  const repeated = [{ ...next[0], panels: ["b", "b", "a"] }];
  eq(planFigureReferenceEdits("@fig-study-a", old, repeated).conflicts.length, 1, "duplicate panel labels block ambiguous remap");
  eq(planFigureReferenceEdits("@fig-study-b", [...old, collision], [...next, collision]).changes, [], "exact whole reference wins over a prefix panel interpretation");

  await reset();
  const prepared = await prepare();
  eq(await io.readText(`${root}/manuscript/main.qmd`), text, "preflight leaves manuscript untouched");
  eq(await io.exists(`${root}/.meta/figure-reference-update.json`), true, "preflight durably records original text and proposed mapping");
  eq(await recoverFigureReferenceUpdate(root, io), 0, "watcher does not mistake active figure IO for a crashed save");
  eq(await io.exists(`${root}/.meta/figure-reference-update.json`), true, "active-save recovery probe retains its preflight journal");
  await save(changed);
  eq(await commitFigureReferenceUpdate(root, prepared, io), 1, "commit updates one dependent document");
  eq(await io.readText(`${root}/manuscript/main.qmd`), expected, "cold document follows saved figure labels");
  eq(await io.exists(`${root}/.meta/figure-reference-update.json`), false, "complete transaction removes recovery journal");

  await reset();
  let buffer = `${text}Unsaved introduction.\n`, transactions = 0;
  const unregister = registerLiveFigureReferenceDocument({ root, path: "manuscript/main.qmd", getText: () => buffer, applyReplacements: (changes) => { transactions++; buffer = applyReferenceReplacements(buffer, changes); }, flush: () => io.writeText(`${root}/manuscript/main.qmd`, buffer) });
  const livePlan = await prepare();
  await io.writeText(`${root}/manuscript/main.qmd`, buffer); // normal Paper autosave during figure IO
  buffer += "Typing during figure IO: @fig-study-c.\n";
  await save(changed);
  await commitFigureReferenceUpdate(root, livePlan, io);
  eq(transactions, 1, "unsaved Paper text receives one editor transaction");
  eq(buffer, `${expected}Unsaved introduction.\nTyping during figure IO: @fig-study-a.\n`, "edits made before and during save survive with correctly mapped references");
  eq(await io.readText(`${root}/manuscript/main.qmd`), buffer, "live document flush is durable before completion");
  unregister();

  await reset(); const interrupted = await prepare(); await save(changed); releaseFigureReferenceUpdate(root, interrupted);
  eq(await recoverFigureReferenceUpdate(root, io), 1, "reopen recovers crash after figure commit before manuscript rewrite");
  eq(await io.readText(`${root}/manuscript/main.qmd`), expected, "recovery preserves reference meaning");
  eq(await recoverFigureReferenceUpdate(root, io), 0, "recovery is idempotent");
  await reset(); const aborted = await prepare(); releaseFigureReferenceUpdate(root, aborted);
  eq(await recoverFigureReferenceUpdate(root, io), 0, "crash before figure write discards uncommitted plan");
  eq(await io.readText(`${root}/manuscript/main.qmd`), text, "aborted figure edit leaves text unchanged");
  await reset(); const conflicted = await prepare(); await save(changed); releaseFigureReferenceUpdate(root, conflicted);
  await io.writeText(`${root}/manuscript/main.qmd`, "External edit survives @fig-study-a");
  await rejects(() => recoverFigureReferenceUpdate(root, io), /conflicts with newer file edits/, "recovery refuses to overwrite independent manuscript edits");
  eq(await io.readText(`${root}/manuscript/main.qmd`), "External edit survives @fig-study-a", "conflicting recovery retains newer document bytes");
  eq(await io.exists(`${root}/.meta/figure-reference-update.json`), true, "conflicting recovery retains both versions for review");

  await reset();
  await io.writeText(`${root}/Context/Project/NOTEBOOK.md`, "Context cites @fig-study-c.\n");
  await mutateFigModel(root, "gate_relabel", ({ project }) => {
    for (const [i, e] of project.figures[0].elements.entries()) if (e.type === "text") e.text = ["b", "c", "a"][i];
  });
  eq(await io.readText(`${root}/manuscript/main.qmd`), expected, "actual CLI mutation uses shared reference coordinator");
  eq(await io.readText(`${root}/Context/Project/NOTEBOOK.md`), "Context cites @fig-study-a.\n", "all project documents including Context are covered");
  eq(JSON.parse(await io.readText(`${root}/fig/index.json`)).figures[0].number, 1, "manuscript reference order never renumbers a figure");
  console.log(`PASS figure-reference-sync (${checks} assertions)`);
} finally { await fs.rm(root, { recursive: true, force: true }); }
