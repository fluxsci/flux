// flux-core/check.ts — Manuscript Check over Node fs (`flux check`, MCP
// `check_manuscript`). IO only: every rule lives in the shared pure core
// src/lib/manuscript/checks/ (twin-engine rule); the Paper pane (Alt+K) runs
// the same `checkManuscript` over the live editor's inputs.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { checkManuscript, checkBibEntries, commentInputs, parsePacks, type CheckFigure, type CheckResult } from "../src/lib/manuscript/checks/index";
import { lightBibEntries } from "../src/lib/references/bibtex";
import { familyById, formatFamilyRef } from "../src/lib/figfamily";
import { composeCaption, panelLetters } from "../src/lib/captions";
import { ValidationError } from "./errors";
import { exists, loadFigModel, loadManifest, safeJoin } from "./model";
import { listComments } from "./comments";

/** The project's figures as the Paper editor knows them (scholar/figures.ts
 *  loadFigures): label = reference key, identity (family, number) from the
 *  healed model, display from the family template, caption composed. */
export async function checkFigures(root: string): Promise<CheckFigure[]> {
  let loaded;
  try {
    loaded = await loadFigModel(root);
  } catch {
    return []; // no figure model yet — nothing to resolve against
  }
  const { project, index } = loaded;
  const byId = new Map(project.figures.map((f) => [f.id, f]));
  return (index.figures ?? []).map((entry) => {
    const fig = byId.get(entry.id);
    const family = fig?.family ?? "figure";
    const number = fig?.number ?? entry.order;
    return {
      label: fig?.referenceKey ?? entry.label,
      family,
      number,
      display: formatFamilyRef(familyById(family, project.figureFamilies), number),
      caption: fig ? composeCaption(fig) : (entry.caption ?? ""),
      panels: fig ? panelLetters(fig) : [],
    };
  });
}

export async function checkManuscriptDoc(
  root: string,
  opts: { doc?: string; packs?: string | string[] } = {},
): Promise<CheckResult> {
  let packs;
  try {
    packs = parsePacks(opts.packs);
  } catch (e) {
    throw new ValidationError((e as Error).message);
  }
  const m = await loadManifest(root);
  const rel = opts.doc ?? m.manuscript.path;
  if (!rel) throw new ValidationError("This project has no default document. Create a document or specify --doc.");
  const abs = safeJoin(root, rel);
  if (!(await exists(abs))) throw new ValidationError(`No document at ${rel}.`);
  const text = await fs.readFile(abs, "utf8");
  const bibRel = (m as { references?: { library?: string } }).references?.library ?? "references/library.bib";
  const bibAbs = path.join(root, bibRel);
  const bibText = (await exists(bibAbs)) ? await fs.readFile(bibAbs, "utf8") : "";
  const threads = await listComments(root, rel);
  return checkManuscript({
    doc: rel,
    text,
    figures: await checkFigures(root),
    bib: checkBibEntries(lightBibEntries(bibText)),
    comments: commentInputs(threads, text),
    ...(packs ? { packs } : {}),
  });
}
