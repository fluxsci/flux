// flux-core/model.ts — the Flux project/figure model over Node fs (split out
// of index.ts; WS-6.2): fs helpers + project-root path safety, project.json
// and fig/ index/canvas-file IO, and the W3 load→mutate→save chokepoint
// (mutateFigModel) every mutating fig verb goes through.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { panelLetters } from "../src/lib/captions";
import { withLock } from "./locks";
import { CLIENT, j, stamp, journal } from "./journal";
import { atomicWrite, fsyncDir } from "./fsx";
import type { Figure, Project, Asset, Canvas } from "../src/lib/types";
import { familyHintsFrom, migrateFigureFamilies, migrateProject } from "../src/lib/migrate";
import { kindForFamily } from "../src/lib/figfamily";
import type { ProjectManifest, FigureEntry } from "../src/lib/project/types";
import { isNewerSchema, newerSchemaMessage, FIG_INDEX_SCHEMA_VERSION, CANVAS_SCHEMA_VERSION } from "../src/lib/project/types";
import {
  planFigSave,
  executeFigSave,
  sortedCanvasMeta,
  normalizeIndexAssets,
  type FigIndexFile,
  type CanvasFile,
} from "../src/lib/project/figfiles";
export type { FigIndexFile };

// --------------------------------------------------------------------------
// fs helpers + project-root path safety (M9: never escape the project root)
// --------------------------------------------------------------------------

/** Resolve `rel` under `root`, throwing if it would escape the project root. */
export function safeJoin(root: string, rel: string): string {
  const abs = path.resolve(root, rel);
  const base = path.resolve(root);
  if (abs !== base && !abs.startsWith(base + path.sep)) {
    throw new Error(`path escapes project root: ${rel}`);
  }
  return abs;
}

/** AGT-5: validate an id that becomes a path segment (figure/canvas ids from CLI/MCP
 *  flags like `--id` / `--canvas`). Rejects path separators, null bytes, and a leading
 *  dot so a crafted `--id ../../x` can't write outside the project tree — with a clear
 *  message, before safeJoin's generic "escapes root" backstop would fire. */
export function safeId(kind: string, id: string): string {
  if (!id || /[\\/\x00]/.test(id) || id.startsWith(".")) {
    throw new Error(`unsafe ${kind} id ${JSON.stringify(id)}: no path separators or leading dot`);
  }
  return id;
}

export async function readJSON<T>(p: string): Promise<T> {
  return JSON.parse(await fs.readFile(p, "utf8")) as T;
}
export async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
export async function writeText(p: string, t: string): Promise<void> {
  await atomicWrite(p, t); // W2: durable tmp+fsync+rename for every canonical write
}

// --------------------------------------------------------------------------
// on-disk shapes + writer plan: the ONE persistence core shared with the GUI
// (src/lib/project/figfiles.ts, WS-5.6) — this engine keeps only its own
// concerns: Node fs, locks, journal, manifest reindex.
// --------------------------------------------------------------------------

/** Fail fast with a DIAGNOSIS when root isn't a Flux project. Verbs used to
 *  fail on whatever file they touched first ("figure not found", raw ENOENT on
 *  project.json) — all true, none pointing at the actual mistake (wrong dir,
 *  usually a stale $FLUX_PROJECT). Suggests the nearest real project root. */
export async function requireProject(root: string): Promise<void> {
  if (await exists(j(root, "project.json"))) return;
  const near = await findProjectRoot(root);
  throw new Error(
    `${root} is not a Flux project (no project.json)` +
      (near ? ` — did you mean ${near}?` : " — check --root / $FLUX_PROJECT / cwd"),
  );
}

export async function loadManifest(root: string): Promise<ProjectManifest> {
  await requireProject(root);
  return readJSON<ProjectManifest>(j(root, "project.json"));
}
export async function saveManifest(root: string, m: ProjectManifest): Promise<void> {
  m.modified = stamp();
  await writeText(j(root, "project.json"), JSON.stringify(m, null, 2) + "\n");
}
export async function readFigIndex(root: string): Promise<FigIndexFile | null> {
  const p = j(root, "fig", "index.json");
  const idx = (await exists(p)) ? await readJSON<FigIndexFile>(p) : null;
  // WS-5.2 forward-version guard: never migrate a NEWER fig format down.
  if (idx && isNewerSchema(idx.schemaVersion, FIG_INDEX_SCHEMA_VERSION))
    throw new Error(newerSchemaMessage("fig/index.json", idx.schemaVersion, FIG_INDEX_SCHEMA_VERSION));
  return idx;
}
export async function readCanvasFiles(
  root: string,
  idx: FigIndexFile,
): Promise<{ byId: Record<string, Figure>; canvasOf: Record<string, string> }> {
  const byId: Record<string, Figure> = {};
  const canvasOf: Record<string, string> = {};
  // WS-5.6: canonical canvas order (the GUI sorts; this engine used to trust
  // array position — a hand-edited index gave the two different models).
  for (const cm of sortedCanvasMeta(idx)) {
    const p = safeJoin(root, `fig/canvases/${cm.id}.json`);
    if (await exists(p)) {
      const cf = await readJSON<CanvasFile>(p);
      // WS-5.2 forward-version guard (see readFigIndex).
      if (isNewerSchema(cf.schemaVersion, CANVAS_SCHEMA_VERSION))
        throw new Error(newerSchemaMessage(`fig/canvases/${cm.id}.json`, cf.schemaVersion, CANVAS_SCHEMA_VERSION));
      for (const f of cf.figures ?? []) {
        (f as Figure).canvasId = cm.id;
        byId[f.id] = f;
        canvasOf[f.id] = cm.id;
      }
    }
  }
  return { byId, canvasOf };
}

// --------------------------------------------------------------------------
// the figure model as a Project (so flux-core mutates via the shared pure ops
// core, exactly like the GUI). loadFigModel reads index + canvas files into a
// Project; saveFigModel writes the canvas files + index rollup + reindexes.
// --------------------------------------------------------------------------
const emptyIndex = (): FigIndexFile => ({
  schemaVersion: "0.1.0",
  canvases: [],
  figures: [],
  assets: [],
  palette: [],
  colorGroups: [],
});

export async function loadFigModel(root: string): Promise<{ project: Project; index: FigIndexFile }> {
  // A missing fig/index.json is fine (fresh project) — but a missing
  // project.json means this isn't a Flux project at all: without the guard a
  // mutate verb sees an empty model and reports "figure not found" instead.
  await requireProject(root);
  const index = (await readFigIndex(root)) ?? emptyIndex();
  const { byId } = await readCanvasFiles(root, index);
  const canvases: Canvas[] = sortedCanvasMeta(index).map((c) => ({ id: c.id, name: c.name }));
  const figures: Figure[] = Object.values(byId); // canvas-then-file insertion order
  const assets: Asset[] = normalizeIndexAssets(index); // WS-5.6: shared fallbacks
  const project: Project = {
    version: 2,
    name: "",
    canvases,
    figures,
    assets,
    palette: index.palette ?? [],
    colorGroups: (index.colorGroups as Project["colorGroups"]) ?? [],
    // undefined when the index predates styles → migrate seeds the defaults;
    // an explicit list (even []) from disk is the user's truth.
    ...(index.textStyles !== undefined ? { textStyles: index.textStyles } : {}),
    ...(index.families !== undefined ? { figureFamilies: index.families } : {}),
  };
  // Same migration the GUI runs in normalizeProject (text autoWidth → sizing,
  // seed default text styles) — flux-core previously did NO element
  // normalization, so v1 docs mutated headless kept legacy fields forever.
  migrateProject(project);
  // Figure families (fig-subsystem-only): same seeding + healing as the GUI's
  // loadFigInto, so both engines agree on identity before any mutation runs.
  migrateFigureFamilies(project, familyHintsFrom(index.figures));
  return { project, index };
}

export async function saveFigModel(
  root: string,
  project: Project,
  index: FigIndexFile,
  action = "save_fig",
): Promise<void> {
  // WS6: an agent file-write defers (throws) rather than clobbering an in-flight
  // human edit (the GUI holds the "project" lock while actively editing). Then journal.
  await withLock(root, "project", CLIENT, () => saveFigModelUnlocked(root, project, index));
  await journal(root, { action, figures: project.figures.map((f) => f.id) });
}

/** W3: run a read→mutate→write cycle atomically under the "project" lock, so two
 *  agents (or an agent racing the GUI's save) can never interleave a lost update —
 *  the load happens INSIDE the lock. All mutating fig verbs go through this. */
export async function mutateFigModel<T>(
  root: string,
  action: string,
  fn: (m: { project: Project; index: FigIndexFile }) => T | Promise<T>,
): Promise<T> {
  let out!: T;
  let figIds: string[] = [];
  await withLock(root, "project", CLIENT, async () => {
    const m = await loadFigModel(root);
    out = await fn(m);
    figIds = m.project.figures.map((f) => f.id);
    await saveFigModelUnlocked(root, m.project, m.index);
  });
  await journal(root, { action, figures: figIds });
  return out;
}

async function saveFigModelUnlocked(
  root: string,
  project: Project,
  index: FigIndexFile,
): Promise<void> {
  // WS-5.6: the write set (canvases + captions + index) comes from the ONE
  // persistence core shared with the GUI. `index` (the loaded, possibly
  // verb-mutated rollup) is the prev: labels/kinds persist through it. The
  // executor owns the WS-5.3 ordering (canvases → dir fsync → captions →
  // index LAST + .bak → dir fsync) and skips byte-identical rewrites.
  const plan = planFigSave(project, index);
  await executeFigSave(plan, {
    read: async (rel) => {
      const p = safeJoin(root, rel);
      return (await exists(p)) ? await fs.readFile(p, "utf8") : null;
    },
    write: (rel, text) => writeText(safeJoin(root, rel), text),
    fsyncDir: (rel) => fsyncDir(safeJoin(root, rel)),
  });
  await reindex(root);
}

// --------------------------------------------------------------------------
// verbs
// --------------------------------------------------------------------------

/** reindex: rebuild project.json.figures[] from fig/index.json (spec §7). */
export async function reindex(root: string): Promise<{ figures: number }> {
  const manifest = await loadManifest(root);
  const index = await readFigIndex(root);
  const figures: FigureEntry[] = (index?.figures ?? []).map((f) => ({
    id: f.id,
    name: f.name,
    label: f.label,
    order: f.order,
    kind: f.family ? kindForFamily(f.family) : f.kind === "supplementary" ? "supplementary" : "main",
    ...(f.family ? { family: f.family } : {}),
    ...(f.number != null ? { number: f.number } : {}),
    ...(f.nickname ? { nickname: f.nickname } : {}),
    canvas: f.canvas,
    caption: `fig/captions/${f.id}.md`,
  }));
  manifest.figures = figures;
  manifest.figureFamilies = index?.families ?? [];
  await saveManifest(root, manifest);
  return { figures: figures.length };
}

/** list_project: a compact overview of documents, figures, references.
 *  `elements` makes empty/placeholder figures visible at a glance — a 0-element
 *  figure sitting at order 1 silently shifts every other figure's number. */
export async function listProject(root: string): Promise<{
  title: string;
  documents: string[];
  figures: {
    id: string;
    label: string;
    name: string;
    order: number;
    family?: string;
    number?: number;
    nickname?: string;
    panels: string[];
    elements: number;
  }[];
  references: string | null;
}> {
  const manifest = await loadManifest(root);
  const index = await readFigIndex(root);
  const { byId } = index ? await readCanvasFiles(root, index) : { byId: {} as Record<string, Figure> };
  return {
    title: manifest.title,
    documents: [
      manifest.manuscript.path,
      ...(manifest.supplementary ?? []).map((s) => s.path),
    ],
    figures: (index?.figures ?? []).map((f) => ({
      id: f.id,
      label: f.label,
      name: f.name,
      order: f.order,
      ...(f.family ? { family: f.family } : {}),
      ...(f.number != null ? { number: f.number } : {}),
      ...(f.nickname ? { nickname: f.nickname } : {}),
      panels: byId[f.id] ? panelLetters(byId[f.id]) : [],
      elements: byId[f.id]?.elements.length ?? 0,
    })),
    references: manifest.references?.library ?? null,
  };
}

export async function findProjectRoot(start: string): Promise<string | null> {
  let dir = path.resolve(start);
  for (let i = 0; i < 8; i++) {
    if (await exists(path.join(dir, "project.json"))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}
