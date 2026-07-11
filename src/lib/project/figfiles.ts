// ---------------------------------------------------------------------------
// figfiles — the ONE figure-persistence core (WS-5.6, fortify plan).
//
// The `fig/` file shapes used to be declared and implemented TWICE — here in
// the renderer (figbridge.ts) and again in flux-core — and had already drifted
// (label derivation, index caption freshness, canvas-order semantics, asset
// projection). Both engines now build their reads and writes from this pure
// module; each executes through its own fs adapter (renderer FileBridge vs
// Node fs), and engine-only concerns stay put: dirty tracking / conflict
// banner / baselines in figbridge, locking / journal / manifest-reindex in
// flux-core.
//
// COMMIT-POINT INVARIANT (WS-5.3, machine-checked by verify-figsave-txn.ts):
// a fig/ save writes canvas files first, fsyncs the directory entry, and
// writes `fig/index.json` LAST — so the index, which is what every reader
// trusts, never references a canvas file that doesn't exist. `index.json.bak`
// keeps the previous commit point (one generation). This ordering is the
// project's alternative to a staged multi-file transaction system — do not
// reorder the steps in executeFigSave.
// ---------------------------------------------------------------------------

import type { Project, Figure, Asset, TextStyle } from "../types";
import { slugify } from "./types";
import { FIG_INDEX_SCHEMA_VERSION, CANVAS_SCHEMA_VERSION } from "./types";
import { composeCaption } from "../captions";

export { FIG_INDEX_SCHEMA_VERSION, CANVAS_SCHEMA_VERSION };

// --------------------------------------------------------------------------
// on-disk shapes (project format §3.2, §7)
// --------------------------------------------------------------------------
export interface FigIndexCanvas {
  id: string;
  name: string;
  order: number;
}
export interface FigIndexFigure {
  id: string;
  name: string;
  label: string;
  order: number;
  kind: string; // "main" | "supplementary" (writes validate; reads tolerate)
  canvas: string;
  caption: string;
}
export interface FigIndexAsset {
  id: string;
  kind: "png" | "svg";
  path: string;
  name: string;
  naturalWidth: number;
  naturalHeight: number;
  // Physical resolution a PNG declared (pHYs), captured at import. Physical
  // size in canvas px = natural × 96/dpi — dropping this on load silently
  // resized re-saved rasters (the Asset.dpi round-trip bug).
  dpi?: number;
}
export interface FigIndexFile {
  schemaVersion: string;
  canvases: FigIndexCanvas[];
  figures: FigIndexFigure[];
  // Optional on read (legacy indexes); always written.
  assets?: Partial<FigIndexAsset>[];
  palette?: string[];
  colorGroups?: unknown[];
  // Named text styles (project-level; the machine-global library lives in
  // <userData>/textstyles.json). Loaded into Project.textStyles and written
  // back EXPLICITLY on save — omitting either side silently wipes them.
  textStyles?: TextStyle[];
}
export interface CanvasFile {
  schemaVersion: string;
  id: string;
  name: string;
  figures: Figure[];
}

// --------------------------------------------------------------------------
// load-side normalization (shared by both engines' readers)
// --------------------------------------------------------------------------

/** Canvas metas in their canonical order. Loads must NOT trust array position:
 *  a hand-edited index can store them out of order, and the two engines used
 *  to disagree (figbridge sorted, flux-core didn't). */
export function sortedCanvasMeta(index: FigIndexFile | null): FigIndexCanvas[] {
  return [...(index?.canvases ?? [])].sort((a, b) => a.order - b.order);
}

/** Index assets → model assets, with the canonical fallbacks (name = id,
 *  path = "", sizes = 0, dpi kept only when present). Both engines load
 *  through this so the same tree yields the same in-memory model. */
export function normalizeIndexAssets(index: FigIndexFile | null): Asset[] {
  return (index?.assets ?? []).map((a) => ({
    id: a.id ?? "",
    name: a.name ?? a.id ?? "",
    kind: a.kind === "png" ? "png" : "svg",
    path: a.path ?? "",
    naturalWidth: a.naturalWidth ?? 0,
    naturalHeight: a.naturalHeight ?? 0,
    ...(a.dpi != null ? { dpi: a.dpi } : {}),
  }));
}

// --------------------------------------------------------------------------
// label derivation
// --------------------------------------------------------------------------

/** A clean cross-ref label for a FRESH figure: `fig-<slug>`.
 *
 *  The adopted rule (previously flux-core's): an explicitly slug-like id
 *  (lowercase-ish alnum/dash, no underscore — i.e. authored by an agent as a
 *  join key) passes through as-is; otherwise the name is slugified. Generated
 *  ids (`fig_<base36>_<n>`, ops.ts newId) contain underscores, so every
 *  GUI-created figure still labels from its NAME — identical to the old
 *  figbridge behavior. (slugify's own "project" fallback means no name can
 *  mint an empty label; the `|| f.id` below is a pure safety net.)
 *  Existing labels are never re-derived (they anchor @fig-… references) —
 *  callers preserve prev.label first. */
export function deriveLabel(f: { id: string; name: string }): string {
  const slugLike = /^[a-z0-9][a-z0-9-]*$/i.test(f.id) && !f.id.includes("_");
  const base = slugLike ? f.id : slugify(f.name || f.id);
  return `fig-${base || f.id}`;
}

// --------------------------------------------------------------------------
// save-side: the writer plan
// --------------------------------------------------------------------------

export interface FigSavePlanEntry {
  id: string;
  path: string; // project-relative, POSIX ("fig/…")
  text: string;
}
export interface FigSavePlan {
  canvases: FigSavePlanEntry[];
  captions: FigSavePlanEntry[];
  index: { path: string; text: string };
}

const json = (v: unknown) => JSON.stringify(v, null, 2) + "\n";

/** Canvas metas a SAVE will persist: the model's canvases in model order,
 *  UNIONED with any canvas a figure references but the model never registered
 *  (names from the previous index when known). Without the union, a verb that
 *  places a figure on an unregistered canvasId would leave the index pointing
 *  at a canvas file that was never written — the old flux-core writer had the
 *  dual bug (file written but never indexed ⇒ the figure vanished on the next
 *  load). An entirely empty model still gets the default canvas so the
 *  project stays openable. */
function canvasesForSave(
  model: Project,
  prev: FigIndexFile | null,
): { id: string; name: string }[] {
  const prevName = new Map((prev?.canvases ?? []).map((c) => [c.id, c.name] as const));
  const out: { id: string; name: string }[] = (model.canvases ?? []).map((c) => ({ id: c.id, name: c.name }));
  const seen = new Set(out.map((c) => c.id));
  for (const f of model.figures) {
    if (seen.has(f.canvasId)) continue;
    seen.add(f.canvasId);
    out.push({ id: f.canvasId, name: prevName.get(f.canvasId) ?? (f.canvasId === "canvas-1" ? "Canvas 1" : f.canvasId) });
  }
  if (!out.length) out.push({ id: "canvas-1", name: "Canvas 1" });
  return out;
}

/** Build the complete, deterministic write set for a fig/ save — the SAME
 *  bytes from both engines for the same model (verify-figfiles-parity.ts).
 *  `prev` is the index the engine believes is on disk: labels and kinds are
 *  PRESERVED from it (labels anchor @fig-… references in manuscripts; kind is
 *  agent-settable and the GUI must not revert it), captions/order/names are
 *  derived fresh from the model. */
export function planFigSave(model: Project, prev: FigIndexFile | null): FigSavePlan {
  const canvases = canvasesForSave(model, prev);

  const canvasPlans: FigSavePlanEntry[] = canvases.map((c) => ({
    id: c.id,
    path: `fig/canvases/${c.id}.json`,
    text: json({
      schemaVersion: CANVAS_SCHEMA_VERSION,
      id: c.id,
      name: c.name,
      figures: model.figures.filter((f) => f.canvasId === c.id),
    } satisfies CanvasFile),
  }));

  // Captions: composed from each figure's panel blocks (Figure.captions is the
  // single source of truth — F7/AGT-2). The .md files are derived output; the
  // index caches the composed text for tools that read only index.json.
  const captionById = new Map<string, string>();
  for (const f of model.figures) captionById.set(f.id, composeCaption(f));
  const captionPlans: FigSavePlanEntry[] = model.figures.map((f) => {
    const cap = captionById.get(f.id) ?? "";
    return { id: f.id, path: `fig/captions/${f.id}.md`, text: cap ? cap + "\n" : "" };
  });

  const prevFig = new Map((prev?.figures ?? []).map((f) => [f.id, f] as const));
  const index: FigIndexFile = {
    schemaVersion: FIG_INDEX_SCHEMA_VERSION,
    canvases: canvases.map((c, i) => ({ id: c.id, name: c.name, order: i + 1 })),
    figures: model.figures.map((f, i) => {
      const p = prevFig.get(f.id);
      return {
        id: f.id,
        name: f.name,
        // Preserve existing labels across saves (F7 label stability — renaming
        // a figure must not break its @fig-… references); derive only for new.
        label: p?.label || deriveLabel(f),
        order: i + 1,
        // An agent can mark a figure supplementary — the GUI save must not
        // silently revert it to "main". Anything unrecognized normalizes.
        kind: p?.kind === "supplementary" ? "supplementary" : "main",
        canvas: f.canvasId,
        caption: captionById.get(f.id) ?? "",
      };
    }),
    assets: model.assets.map((a) => ({
      id: a.id,
      kind: a.kind,
      path: a.path,
      name: a.name,
      naturalWidth: a.naturalWidth,
      naturalHeight: a.naturalHeight,
      ...(a.dpi != null ? { dpi: a.dpi } : {}),
    })),
    palette: model.palette ?? [],
    colorGroups: model.colorGroups ?? [],
    textStyles: model.textStyles ?? [], // explicit writeback (silent-wipe guard)
  };

  return { canvases: canvasPlans, captions: captionPlans, index: { path: "fig/index.json", text: json(index) } };
}

// --------------------------------------------------------------------------
// save-side: the shared executor (ordering = the commit-point invariant)
// --------------------------------------------------------------------------

/** The minimal IO surface an engine lends the executor. Paths are the plan's
 *  project-relative POSIX paths — the adapter resolves them. */
export interface FigSaveIO {
  /** Previous text of the file, or null when missing/unreadable. */
  read(path: string): Promise<string | null>;
  write(path: string, text: string): Promise<void>;
  /** Directory-entry durability (rename fsync); optional (win32/mem bridges). */
  fsyncDir?(dir: string): Promise<void>;
}

export interface FigSaveExecOpts {
  /** Engine fast-path: return true to skip a canvas write as byte-identical
   *  WITHOUT an IO read (figbridge's baseline map). Return undefined to fall
   *  through to the executor's read-compare. */
  skipCanvas?: (id: string, text: string) => boolean | undefined;
  /** Called after every actual write (baseline adoption). */
  onWrite?: (path: string, text: string) => void;
  /** Called when a read-compare found the file already identical (baseline
   *  adoption without a write — avoids re-reading it on every future save). */
  onSkip?: (path: string, text: string) => void;
}

/** Execute a FigSavePlan: canvases → dir fsync → captions → index (+.bak) →
 *  dir fsync. Byte-identical files are never rewritten (watcher churn + disk
 *  wear + mtime stability). Returns what actually changed. */
export async function executeFigSave(
  plan: FigSavePlan,
  io: FigSaveIO,
  opts: FigSaveExecOpts = {},
): Promise<{ wroteCanvases: boolean; wroteIndex: boolean }> {
  let wroteCanvases = false;
  for (const c of plan.canvases) {
    const fast = opts.skipCanvas?.(c.id, c.text);
    if (fast === true) continue;
    if (fast === undefined && (await io.read(c.path)) === c.text) {
      opts.onSkip?.(c.path, c.text);
      continue;
    }
    await io.write(c.path, c.text);
    opts.onWrite?.(c.path, c.text);
    wroteCanvases = true;
  }
  // WS-5.3: the renames themselves must be durable before the index that
  // references them is written (file fsync ≠ dir entry fsync).
  if (wroteCanvases) await io.fsyncDir?.("fig/canvases");

  for (const cap of plan.captions) {
    if ((await io.read(cap.path)) === cap.text) continue;
    await io.write(cap.path, cap.text);
    opts.onWrite?.(cap.path, cap.text);
  }

  // Index LAST — the commit point. One-generation .bak of the previous commit.
  let wroteIndex = false;
  const prevIndexText = await io.read(plan.index.path);
  if (prevIndexText !== plan.index.text) {
    if (prevIndexText != null && prevIndexText !== "") await io.write(plan.index.path + ".bak", prevIndexText);
    await io.write(plan.index.path, plan.index.text);
    opts.onWrite?.(plan.index.path, plan.index.text);
    await io.fsyncDir?.("fig");
    wroteIndex = true;
  }
  return { wroteCanvases, wroteIndex };
}
