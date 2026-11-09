// One bundle/update policy for Figure, Paper and headless commands. IO is
// injected; publication identity and manuscript order are never consulted.
import { validateIncomingPlot } from "./contract";
import type { Project, SemanticPlotElement } from "../types";
import { unionRect, elementBBox } from "../geometry";
import { plotSourceCandidates, plotSidecarCandidates, linkedSourceFiles, type LinkedSourceFiles } from "./source";
import { svgIntrinsicSize, scanAbsurdPathCoords } from "./svgGeometry";
import { buildPartIndex } from "./parse";
import type { FluxPlotManifest } from "./types";

export interface PlotBundle { svgText: string; manifestText: string | null; recipeText: string | null }
export interface SourceIO {
  readText(path: string): Promise<string>;
  exists(path: string): Promise<boolean>;
  validateSvg?(text: string): boolean;
  watchSourceFiles?(root: string, scope: string, sources: LinkedSourceFiles[]): Promise<unknown>;
  /** A file's identity without its content; null when absent. With `proofs` this is
   *  what lets an unchanged source cost no read at all. */
  stat?(path: string): Promise<{ size: number; mtimeMs: number } | null>;
}
/** Per linked asset: the identity (path, size, mtime) of its source files and of its
 *  saved copy the last time the two bundles were PROVEN equal by content. While that
 *  identity still holds the asset is current and nothing is read.
 *
 *  Why: the check used to read every linked source twice plus its saved copy and
 *  round-trip every manifest through JSON on the calling thread — at project open
 *  and again on EVERY change under plots/. On the owner's scratch project (120
 *  linked plots, 34 MB manifests) that was 1.8 GB across the bridge and seconds of
 *  frozen frames each time one plot was regenerated (2026-11-09). */
export interface SourceProofs {
  get(key: string): string | undefined;
  set(key: string, proof: string): void;
  delete(key: string): void;
}
/** On a filesystem with whole-second timestamps (FAT, HFS+, some network mounts) a
 *  file rewritten within the same tick keeps its mtime, so a recent whole-second
 *  mtime is not yet proof; the next check compares by content again. Sub-millisecond
 *  timestamps (ext4, APFS, NTFS) cannot repeat and are proof at once. */
export const SOURCE_PROOF_SETTLE_MS = 3000;
interface SourceProofTarget { key: string; bundleKey: string; resolved: string; manifestCandidates: string[]; recipeCandidates: string[]; saved: string[] }
async function sourceIdentity(io: SourceIO, target: SourceProofTarget, now: () => number): Promise<{ source: string; proof: string; settled: boolean }> {
  let settled = true;
  const one = async (path: string) => { const st = await io.stat!(path); if (st && st.mtimeMs % 1000 === 0 && now() - st.mtimeMs < SOURCE_PROOF_SETTLE_MS) settled = false; return st ? [path, st.size, st.mtimeMs] : null; };
  const first = async (candidates: string[]) => { for (const path of candidates) { const st = await one(path); if (st) return st; } return null; };
  const source = [await one(target.resolved), await first(target.manifestCandidates), await first(target.recipeCandidates)];
  const saved = [await one(target.saved[0]), await one(target.saved[1]), await one(target.saved[2])];
  return { source: JSON.stringify(source), proof: JSON.stringify([target.bundleKey, ...source, ...saved]), settled };
}
/** After updates COMMIT: the saved copy now holds exactly the bundle that was read, so
 *  each update whose source files still have the identity they had when read is proven
 *  current now — the next check (and the next open) reads nothing for it. */
export async function proveSourceUpdates(updates: readonly SourceUpdate[], io: SourceIO, proofs: SourceProofs | undefined, now: () => number = Date.now): Promise<void> {
  if (!proofs || !io.stat) return;
  for (const update of updates) {
    if (!update.proof) continue;
    try {
      const seen = await sourceIdentity(io, update.proof, now);
      if (seen.source === update.proof.source && seen.settled) proofs.set(update.proof.key, seen.proof);
    } catch { /* advisory: the next check compares by content */ }
  }
}
export interface SourceSize { assetId:string; width:number; height:number; layoutSupported?:boolean }
export interface SourceUpdate extends SourceSize { from: string; resolved: string; bundle: PlotBundle; previous: PlotBundle;
  /** The source files' identity when this bundle was read (see SourceProofs): lets the
   *  update be proven current as soon as it commits, without a second read. */
  proof?: SourceProofTarget & { source: string } }
export interface SourceStatus {
  assetId: string;
  path: string;
  status: "current" | "updating" | "missing" | "error" | "frozen";
  detail?: string;
  figureIds: string[];
}
export interface SourceSyncPlan { updates: SourceUpdate[]; statuses: SourceStatus[]; checked: number }
const nullableRead = async (io: SourceIO, path: string): Promise<string | null> => {
  if (!(await io.exists(path))) return null;
  return io.readText(path);
};
function jsonText(text: string | null, kind: string): string | null {
  if (text == null) return null;
  const value = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${kind} must be a JSON object`);
  return JSON.stringify(value, null, 2);
}
/** Structural XML check used in both runtimes. Browser DOMParser adds its
 * native validation too; this catches truncation/mismatched tags headlessly
 * (HTML-tolerant DOM libraries would otherwise silently repair them). */
export function hasCompleteSvgStructure(text: string): boolean {
  const tags = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE(?:[^>"']|"[^"]*"|'[^']*')*>|<\/?([A-Za-z_][\w:.-]*)\b(?:[^>"']|"[^"]*"|'[^']*')*>/g;
  const stack: string[] = [];
  let end = 0, roots = 0;
  for (const m of text.matchAll(tags)) {
    const gap = text.slice(end, m.index);
    if (gap.includes("<") || (!stack.length && gap.trim())) return false;
    end = m.index! + m[0].length;
    if (!m[1]) continue;
    if (m[0].startsWith("</")) { if (stack.pop() !== m[1]) return false; }
    else {
      if (!stack.length) { if (++roots !== 1 || m[1] !== "svg") return false; }
      if (!/\/\s*>$/.test(m[0])) stack.push(m[1]);
    }
  }
  return roots === 1 && !stack.length && !text.slice(end).trim();
}
async function normalizeBundle(bundle: PlotBundle, io: SourceIO): Promise<PlotBundle> {
  await validateIncomingPlot(bundle.svgText, bundle.manifestText);
  if (!hasCompleteSvgStructure(bundle.svgText)) throw new Error("SVG is incomplete or malformed");
  if (io.validateSvg && !io.validateSvg(bundle.svgText)) throw new Error("SVG is malformed");
  const clean = scanAbsurdPathCoords(bundle.svgText, { clamp: true }).svg;
  return { svgText: clean, manifestText: jsonText(bundle.manifestText, "Manifest"), recipeText: jsonText(bundle.recipeText, "Recipe") };
}
export function samePlotBundle(a: PlotBundle, b: PlotBundle): boolean {
  return a.svgText === b.svgText && a.manifestText === b.manifestText && a.recipeText === b.recipeText;
}

export async function planSourceUpdates(root: string, project: Project, io: SourceIO, opts: { figureId?: string; assetBase?: string; watchProject?: Project; proofs?: SourceProofs; now?: () => number } = {}): Promise<SourceSyncPlan> {
  const assetBase = opts.assetBase ?? "fig";
  const out: SourceSyncPlan = { updates: [], statuses: [], checked: 0 };
  const proofs = io.stat ? opts.proofs : undefined, now = opts.now ?? Date.now;
  const sources = new Map<string, { el: SemanticPlotElement; figureIds: string[]; conflict: boolean }>();
  let watchError: unknown;
  try { await io.watchSourceFiles?.(root, assetBase, linkedSourceFiles(root, opts.watchProject ?? project)); }
  catch (error) { watchError = error; }
  for (const f of project.figures) for (const e of f.elements) {
    if (e.type !== "plot" || !e.source?.svgPath || (opts.figureId && f.id !== opts.figureId)) continue;
    const prev = sources.get(e.assetId);
    if (prev) {
      prev.figureIds.push(f.id);
      if (["svgPath", "manifestPath", "recipePath"].some((key) => prev.el.source?.[key as keyof typeof e.source] !== e.source?.[key as keyof typeof e.source]) || !!prev.el.source?.frozen !== !!e.source.frozen || !!prev.el.source?.external !== !!e.source.external) prev.conflict = true;
    }
    else sources.set(e.assetId, { el: e, figureIds: [f.id], conflict: false });
  }
  // Cache a complete validated bundle per source, so repeated imports do not
  // multiply disk reads or parsing. Separate asset copies still keep their IDs.
  const freshByPath = new Map<string, PlotBundle>();
  const validated = new Set<string>();
  for (const [assetId, { el, figureIds, conflict }] of sources) {
    const source = el.source!;
    const status: SourceStatus = { assetId, path: source.svgPath, status: "current", figureIds: [...new Set(figureIds)] };
    out.statuses.push(status);
    if (conflict) { status.status = "error"; status.detail = "This shared asset has conflicting source links. Relink or freeze the selected placement independently."; continue; }
    if (source.frozen) { status.status = "frozen"; continue; }
    const asset = project.assets.find((a) => a.id === assetId);
    if (!asset?.path) { status.status = "error"; status.detail = "The imported asset has no stored path"; continue; }
    out.checked++;
    try {
      if (watchError) throw new Error(`Linked-source read/watch registration failed: ${String((watchError as Error)?.message ?? watchError)}`);
      let resolved = "";
      for (const path of plotSourceCandidates(root, source.svgPath, source)) if (await io.exists(path)) { resolved = path; break; }
      if (!resolved) { status.status = "missing"; status.detail = "Source is missing; the last saved version is retained"; continue; }
      const manifestCandidates = plotSidecarCandidates(root, source, resolved, "manifest");
      const recipeCandidates = plotSidecarCandidates(root, source, resolved, "recipe");
      const readSidecar = async (candidates: string[]) => {
        for (const path of candidates) if (await io.exists(path)) return io.readText(path);
        return null;
      };
      const bundleKey = JSON.stringify([resolved, manifestCandidates, recipeCandidates]);
      // The fast path: source files and saved copy are the very files last proven equal.
      const target: SourceProofTarget = { key: `${assetBase}:${assetId}`, bundleKey, resolved, manifestCandidates, recipeCandidates,
        saved: [`${root}/${assetBase}/${asset.path}`, `${root}/${assetBase}/assets/${assetId}.fluxplot.json`, `${root}/${assetBase}/assets/${assetId}.recipe.json`] };
      const saved = target.saved;
      const seen = proofs ? await sourceIdentity(io, target, now) : null;
      if (seen && proofs!.get(target.key) === seen.proof) continue;
      proofs?.delete(target.key);
      const readFresh = async (): Promise<PlotBundle> => ({
        svgText: await io.readText(resolved),
        // Pair the sidecars with the SVG that ACTUALLY resolved, avoiding an
        // old-machine manifest accidentally paired with relocated SVG bytes.
        manifestText: await readSidecar(manifestCandidates),
        recipeText: await readSidecar(recipeCandidates),
      });
      let fresh = freshByPath.get(bundleKey);
      if (!fresh) {
        const first = await readFresh(), second = await readFresh();
        if (!samePlotBundle(first, second)) throw new Error("Source files changed while reading; the last saved version is retained. Reload after generation completes.");
        fresh = await normalizeBundle(second, { ...io, validateSvg: undefined });
        freshByPath.set(bundleKey, fresh);
      }
      const previous: PlotBundle = {
        svgText: await nullableRead(io, saved[0]) ?? "",
        manifestText: jsonText(await nullableRead(io, saved[1]), "Saved manifest"),
        recipeText: jsonText(await nullableRead(io, saved[2]), "Saved recipe"),
      };
      if (samePlotBundle(fresh, previous)) {
        // Proof only when nothing moved while it was being read, and nothing is still settling.
        if (seen) { const after = await sourceIdentity(io, target, now); if (after.proof === seen.proof && seen.settled && after.settled) proofs!.set(target.key, seen.proof); }
        continue;
      }
      if (!validated.has(resolved)) {
        if (io.validateSvg && !io.validateSvg(fresh.svgText)) throw new Error("SVG is malformed");
        validated.add(resolved);
      }
      if (fresh.manifestText) {
        const known = new Set(Object.keys(buildPartIndex(JSON.parse(fresh.manifestText) as FluxPlotManifest)));
        for (const m of fresh.svgText.matchAll(/\bid=["']([^"']+)["']/g)) known.add(m[1]);
        const lost = new Set<string>();
        for (const f of project.figures) for (const e of f.elements) if (e.type === "plot" && e.assetId === assetId) {
          for (const key of Object.keys(e.overrides ?? {})) if (!known.has(key)) lost.add(key);
        }
        if (lost.size) status.detail = `Preserved overrides for parts missing from the new source: ${[...lost].join(", ")}`;
      }
      const size = svgIntrinsicSize(fresh.svgText);
      const layoutSupported = [fresh.manifestText,previous.manifestText].some(text=>text&&JSON.parse(text).layout?.supported===true);
      out.updates.push({ assetId, from: source.svgPath, resolved, bundle: fresh, previous, width: size.w, height: size.h, layoutSupported, ...(seen ? { proof: { ...target, source: seen.source } } : {}) });
      status.status = "updating";
    } catch (e) { status.status = "error"; status.detail = String((e as Error)?.message ?? e); }
  }
  return out;
}

/** Apply metadata and physical sizing to the latest model (not the snapshot
 * read before async IO). User placement scales, IDs, captions and overrides
 * survive. Each touched frame expands only when required to contain content. */
export function applySourceUpdates(project: Project, updates: readonly SourceSize[]): { resized: { assetId: string; elementIds: string[]; from: { w: number; h: number }; to: { w: number; h: number } }[]; framed: { figId: string; from: { width: number; height: number }; to: { width: number; height: number } }[] } {
  const before = new Map(project.figures.map((f) => [f.id, unionRect(f.elements.map(elementBBox))]));
  const resized = [], framed = [];
  const affected = new Set<string>();
  for (const u of updates) {
    const asset = project.assets.find((a) => a.id === u.assetId);
    if (!asset) continue;
    const prev = { w: asset.naturalWidth || u.width, h: asset.naturalHeight || u.height };
    asset.naturalWidth = u.width; asset.naturalHeight = u.height;
    if (Math.abs(prev.w - u.width) < 0.01 && Math.abs(prev.h - u.height) < 0.01) continue;
    const elementIds = [];
    for (const f of project.figures) for (const e of f.elements) if (e.type === "plot" && e.assetId === u.assetId) {
      const cs=e.contentScale??1;
      if(u.layoutSupported&&e.layoutMode!=="stretch"&&(Math.abs(e.width/cs-prev.w)*.75>.5||Math.abs(e.height/cs-prev.h)*.75>.5))continue;
      e.width *= u.width / prev.w; e.height *= u.height / prev.h;
      elementIds.push(e.id); affected.add(f.id);
    }
    resized.push({ assetId: u.assetId, elementIds, from: prev, to: { w: u.width, h: u.height } });
  }
  for (const f of project.figures) {
    if (!affected.has(f.id)) continue;
    const old = before.get(f.id), after = unionRect(f.elements.map(elementBBox));
    if (!old || !after) continue;
    const width = Math.max(f.width, Math.ceil(after.x + after.w + Math.min(48, Math.max(0, f.width - old.x - old.w))));
    const height = Math.max(f.height, Math.ceil(after.y + after.h + Math.min(48, Math.max(0, f.height - old.y - old.h))));
    if (width !== f.width || height !== f.height) { framed.push({ figId: f.id, from: { width: f.width, height: f.height }, to: { width, height } }); f.width = width; f.height = height; }
  }
  return { resized, framed };
}

export async function writeSourceUpdates(root: string, updates: readonly SourceUpdate[], io: { writeText(path: string, text: string): Promise<void>; remove?(path: string): Promise<void> }, project: Project, opts: { assetBase?: string } = {}): Promise<void> {
  const assetBase = opts.assetBase ?? "fig";
  for (const u of updates) {
    const asset = project.assets.find((a) => a.id === u.assetId);
    if (!asset?.path) continue;
    await io.writeText(`${root}/${assetBase}/${asset.path}`, u.bundle.svgText);
    for (const [ext, text] of [["fluxplot.json", u.bundle.manifestText], ["recipe.json", u.bundle.recipeText]] as const) {
      const path = `${root}/${assetBase}/assets/${u.assetId}.${ext}`;
      if (text == null) await io.remove?.(path); else await io.writeText(path, text);
    }
  }
}
