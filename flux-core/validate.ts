// flux-core/validate.ts — WS2 JSON-schema validation + project lint + the
// FluxPlot output contract check (split out of index.ts; WS-6.2).

// WS-5.1: the load-gate validators are part of the PROJECT FORMAT, one source
// in src/lib/project/validate.ts (repo convention: flux-core → src/lib, never
// the reverse — schemas.ts precedent). This re-export keeps flux-core
// consumers on the same compiled validators as the GUI load seams; the
// `validate` VERB below (WS-6.2 extraction) shares the module.
export * from "../src/lib/project/validate";

import { textLayoutWarnings } from "./render";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import Ajv from "ajv";
import { collectEmbedLabels } from "../src/lib/exportQmd";
import { buildPartIndex } from "../src/lib/plot/parse";
import { resolveTargets } from "../src/lib/plot/tree";
import type { FluxPlotManifest } from "../src/lib/plot/types";
import * as ops from "../src/lib/ops";
import { atomicWrite } from "./fsx";
import { SCHEMAS, SCHEMA_FILENAMES, schemaForFile } from "./schemas";
import { j } from "./journal";
import { safeJoin, exists, loadManifest, readFigIndex, loadFigModel } from "./model";
import { scanAbsurdPathCoords, manifestHasLogAxis } from "./coordscan";
import { readExpandedQmd } from "./manuscript";

// --------------------------------------------------------------------------
// WS2: JSON schemas + validation. The bundled schemas (schemas.ts) are the
// machine contract; `writeSchemas` ships them in-project (.meta/schema/) and
// `validate` checks an agent's writes against them.
// --------------------------------------------------------------------------
export async function writeSchemas(root: string): Promise<void> {
  const dir = j(root, ".meta", "schema");
  for (const [key, schema] of Object.entries(SCHEMAS)) {
    await atomicWrite(
      j(dir, SCHEMA_FILENAMES[key as keyof typeof SCHEMAS]),
      JSON.stringify(schema, null, 2) + "\n",
    );
  }
}

export interface ValidateResult {
  ok: boolean;
  checked: number;
  errors: string[];
  /** non-fatal project lint (empty/unembedded figures, overlapping frames). */
  warnings?: string[];
}

/** Validate the whole project (or one file) against the bundled JSON Schemas. */
export async function validate(root: string, file?: string): Promise<ValidateResult> {
  const ajv = new Ajv({ allErrors: true, strict: false });
  const errors: string[] = [];
  let checked = 0;
  const check = (key: keyof typeof SCHEMAS, rel: string, data: unknown) => {
    checked++;
    const v = ajv.compile(SCHEMAS[key]);
    if (!v(data)) for (const e of v.errors ?? []) errors.push(`${rel}: ${e.instancePath || "(root)"} ${e.message ?? "invalid"}`);
  };
  const readRel = async (rel: string) => JSON.parse(await fs.readFile(safeJoin(root, rel), "utf8"));

  if (file) {
    const key = schemaForFile(file);
    if (!key) throw new Error(`no schema known for ${file}`);
    check(key, file, await readRel(file));
    return { ok: errors.length === 0, checked, errors };
  }

  if (await exists(j(root, "project.json"))) check("project", "project.json", await readRel("project.json"));
  const idx = await readFigIndex(root);
  if (idx) {
    check("figIndex", "fig/index.json", idx);
    for (const cm of idx.canvases ?? []) {
      const rel = `fig/canvases/${cm.id}.json`;
      if (await exists(safeJoin(root, rel))) check("canvas", rel, await readRel(rel));
    }
  }
  // Decks (slides/<id>/deck.json) — validate every deck registered in the manifest.
  try {
    const m = await loadManifest(root);
    for (const s of m.slides ?? []) {
      const rel = s.path ?? `slides/${s.id}/deck.json`;
      if (await exists(safeJoin(root, rel))) check("deck", rel, await readRel(rel));
    }
  } catch {
    /* no manifest — skip deck validation */
  }

  // Project lint (moma feedback #13) — non-fatal, but exactly the problems a
  // whole-canvas render exposes late: an empty leftover figure silently shifts
  // every figure number; a figure embedded in no document never compiles; two
  // frames overlapping on the canvas render on top of each other.
  const warnings: string[] = [];
  try {
    const m = await loadManifest(root);
    const { project, index } = await loadFigModel(root);
    const embedded = new Set<string>();
    const docPaths = [m.manuscript?.path, ...(m.supplementary ?? []).map((s) => s.path)].filter(
      (p): p is string => typeof p === "string",
    );
    const seen = new Set<string>();
    for (const dp of docPaths) {
      const { expanded } = await readExpandedQmd(path.resolve(root, dp), seen);
      for (const l of collectEmbedLabels(expanded)) embedded.add(l);
    }
    for (const f of index.figures ?? []) {
      const fig = ops.figById(project, f.id);
      if (!fig) continue;
      if (fig.elements.length === 0)
        warnings.push(`figure ${f.id} is EMPTY (0 elements) — delete it or fill it; it still occupies order ${f.order} and shifts figure numbers`);
      else if (docPaths.length && !embedded.has(f.label))
        warnings.push(`figure ${f.id} (${f.label}) is not embedded in any document — it won't appear in the compiled manuscript`);
    }
    // Overlapping frames per canvas (render-canvas shows them stacked).
    const byCanvas = new Map<string, { id: string; x: number; y: number; w: number; h: number }[]>();
    for (const f of index.figures ?? []) {
      const fig = ops.figById(project, f.id);
      if (!fig) continue;
      const arr = byCanvas.get(f.canvas ?? "") ?? [];
      arr.push({ id: f.id, x: fig.x ?? 0, y: fig.y ?? 0, w: fig.width, h: fig.height });
      byCanvas.set(f.canvas ?? "", arr);
    }
    for (const [cid, figs] of byCanvas) {
      for (let i = 0; i < figs.length; i++)
        for (let k = i + 1; k < figs.length; k++) {
          const a = figs[i], b = figs[k];
          const overlapX = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
          const overlapY = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
          if (overlapX > 1 && overlapY > 1)
            warnings.push(`figures ${a.id} and ${b.id} OVERLAP on canvas ${cid} (${Math.round(overlapX)}×${Math.round(overlapY)}) — check render-canvas`);
        }
    }
    // WS-12: headless-edited text still awaiting a GUI re-wrap renders
    // differently here than in the app — name it.
    warnings.push(...textLayoutWarnings(project.figures));
  } catch {
    /* lint is best-effort — schema validation is the contract */
  }
  return { ok: errors.length === 0, checked, errors, warnings };
}

/** Validate a FluxPlot output (the WS7 contract): the manifest is schema-valid AND
 *  every svg id the manifest can ADDRESS actually exists in the .svg — i.e. the plot
 *  is genuinely part-addressable. Addressability is what resolveTargets fans an
 *  override key to: a group/container key resolves to its leaf members, so the
 *  DOM-expected set is the union of resolved leaves — NOT every indexed node id
 *  (group nodes like "axis.x.tick-labels", series wrappers like "setosa", and
 *  "legend.entry.N" are manifest-only organizational constructs by design; the
 *  whole-tree buildPartIndex would flag them as false positives). */
export async function validatePlot(svgPath: string): Promise<ValidateResult & { references: number; matched: number }> {
  const abs = path.resolve(svgPath);
  const manifestPath = abs.replace(/\.svg$/i, ".fluxplot.json");
  const errors: string[] = [];
  if (!(await exists(manifestPath))) {
    return { ok: false, checked: 0, references: 0, matched: 0, errors: [`missing manifest sidecar ${path.basename(manifestPath)}`] };
  }
  const svg = await fs.readFile(abs, "utf8");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as FluxPlotManifest;
  const ajv = new Ajv({ allErrors: true, strict: false });
  const v = ajv.compile(SCHEMAS.manifest);
  if (!v(manifest)) for (const e of v.errors ?? []) errors.push(`manifest: ${e.instancePath || "(root)"} ${e.message ?? "invalid"}`);

  const indexed = Object.keys(buildPartIndex(manifest));
  const domExpected = [...new Set(indexed.flatMap((id) => resolveTargets(manifest, id)))];
  let matched = 0;
  for (const id of domExpected) {
    if (svg.includes(`id="${id}"`)) matched++;
    else errors.push(`manifest references id "${id}" but the SVG has no element with that id`);
  }

  // Renderer-aware geometry check (moma feedback #7): coordinates absurdly far
  // outside the plot's own canvas (the log-axis zero-anchored bar) pass every
  // id check yet can PANIC resvg once the plot is composed and rasterized.
  // Reject them here — at generation time, where the fix belongs — with the
  // exact ids and values; import/sync will still clamp legacy files to keep
  // old projects rendering.
  const scan = scanAbsurdPathCoords(svg, { clamp: false });
  if (scan.clamped) {
    const hasLog = manifestHasLogAxis(await fs.readFile(manifestPath, "utf8").catch(() => null));
    const worst = scan.values
      .slice(0, 3)
      .map((v) => (Number.isNaN(v) ? "non-finite" : Math.round(v).toLocaleString("en-US")))
      .join(", ");
    const where = scan.ids.length ? ` near id(s) ${scan.ids.slice(0, 3).map((i) => `"${i}"`).join(", ")}` : "";
    const hint =
      hasLog === true
        ? "a mark anchored at data 0 on this plot's log axis serializes that way — anchor at a positive value (barh: left=1, bar: bottom=1) and regenerate"
        : "check the plot script for huge/non-finite values";
    errors.push(
      `${scan.clamped} path coordinate(s) beyond ±${Math.round(scan.threshold).toLocaleString("en-US")} (worst: ${worst})${where} — ` +
        `this renders standalone but can crash the compose/render pipeline; ${hint}`,
    );
  }
  return { ok: errors.length === 0, checked: 1, references: domExpected.length, matched, errors };
}
