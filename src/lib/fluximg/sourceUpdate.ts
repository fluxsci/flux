/**
 * Keeping placed images in step with their source bundles (the fluximg twin of the plot hot-swap, `reimportPlot`).
 *
 * When a bundle under `plots/` that placed images follow changes on disk, it is imported again under a new asset id
 * (the file side copies and hashes it; nothing here reads pixels), and every element that follows it and is not
 * frozen moves to the new content in ONE commit (one undo step), keeping its view and crop where they still fit
 * (importCore.carryFluximgView; a toast says what had to change). The old asset's caches are dropped; the old asset
 * itself stays registered for undo and is collected with the other unused assets.
 *
 * No thrash while a script is still writing: the writer puts `fluximg.json` LAST, so a bundle is looked at only
 * after its events have been quiet for QUIET_MS and only once its manifest exists; work per bundle is serialized
 * (a change arriving meanwhile runs once more afterwards, never in parallel), and an import that saw files change
 * under it waits for the next quiet spell.
 */
import { get } from "svelte/store";
import { project, commit, embeddedProjectRoot, projectDir } from "../store";
import { storeTenant } from "../tenancy";
import { fileBridge, joinPath } from "../project/types";
import { pushToast, errMsg } from "../toast";
import type { Asset, Project } from "../types";
import type { FluximgElement } from "./element";
import { fluximgAsset, fluximgAssetId } from "./place";
import { fluximgManifests, forgetFluximg, fluximgBundle } from "./store";
import { applyFluximgSourceUpdate, findFluximgAsset, fluximgBundleRef, planFluximgSourceUpdate, followsBundle } from "./importCore";
import { fluximgBundleOf } from "../plotsRail/rules";

export type FluximgSourceState = "current" | "changed" | "missing" | "external";

/** How long a bundle's events must be quiet before it is read (the watcher already waits 250 ms per file + 200 ms). */
export const QUIET_MS = 400;

const rootNow = (): string => get(embeddedProjectRoot) ?? get(projectDir) ?? "";
const norm = (p: string): string => p.replace(/\\/g, "/").replace(/\/+$/, "");
const absOf = (root: string, bundlePath: string): string => (/^([A-Za-z]:)?[\\/]/.test(bundlePath) ? bundlePath : joinPath(root, bundlePath));

/** Bundles (as elements store them) the watcher has seen change since they were last brought up to date. */
const seenChanged = new Set<string>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const running = new Map<string, Promise<number>>();
const again = new Set<string>();
let unwatch: (() => void) | null = null;

function followed(bundlePath: string): FluximgElement[] {
  const out: FluximgElement[] = [];
  for (const f of get(project).figures) for (const e of f.elements) if (e.type === "fluximg" && followsBundle(e, bundlePath)) out.push(e);
  return out;
}

function schedule(bundlePath: string): void {
  seenChanged.add(bundlePath);
  const t = timers.get(bundlePath);
  if (t) clearTimeout(t);
  timers.set(bundlePath, setTimeout(() => { timers.delete(bundlePath); void run(bundlePath); }, QUIET_MS));
}

/** Watch `plots/` for changes to followed bundles (idempotent; one subscription per window). */
export function ensureFluximgSourceWatch(): void {
  if (unwatch) return;
  const fb = fileBridge();
  if (!fb?.onFsChangedBatch) return;
  unwatch = fb.onFsChangedBatch((info) => {
    if (info.subsystem !== "plots" || storeTenant() !== "figure") return;
    const root = rootNow();
    if (!root) return;
    if (info.rescan) {
      // Too many paths to name: look at every bundle a placed image follows.
      const all = new Set<string>();
      for (const f of get(project).figures) for (const e of f.elements) if (e.type === "fluximg" && e.source && !e.source.frozen && !e.source.external) all.add(norm(e.source.bundlePath));
      for (const b of all) schedule(b);
      return;
    }
    const bundles = new Set<string>();
    for (const p of info.paths) {
      const b = fluximgBundleOf(p);
      if (b) bundles.add(fluximgBundleRef(root, b).bundlePath);
    }
    for (const b of bundles) if (followed(b).length) schedule(b);
  }) ?? null;
}

/**
 * Catch up after the app was closed: for every bundle a placed image follows, ask whether it still is what was
 * placed (two small manifest reads per bundle, never the pixels) and bring the ones that changed up to date, the
 * same way a change seen by the watcher would. Called when a project's watch starts. Nothing is touched when
 * everything is current, and a missing source is left alone (the placed copy stays).
 */
export async function scanFluximgSources(): Promise<number> {
  if (storeTenant() !== "figure") return 0;
  const first = new Map<string, FluximgElement>();
  for (const f of get(project).figures) for (const e of f.elements) {
    if (e.type !== "fluximg" || !e.source?.bundlePath || e.source.frozen || e.source.external) continue;
    const key = norm(e.source.bundlePath);
    if (!first.has(key)) first.set(key, e);
  }
  let changed = 0;
  for (const [bundlePath, el] of first) {
    let state: FluximgSourceState;
    try { state = await fluximgSourceState(el); } catch { continue; }
    if (state === "changed") { schedule(bundlePath); changed++; }
  }
  return changed;
}

// The catch-up runs once per opened project, as soon as its figures are in the store: the watch starts when the
// project root is known, which is BEFORE the figures are read (a scan at that moment found nothing to follow).
let scannedRoot: string | null = null;
let scanArmed = false;
function scanWhenLoaded(): void {
  const root = rootNow();
  if (!root || scannedRoot === root || storeTenant() !== "figure") return;
  let any = false;
  for (const f of get(project).figures) { for (const e of f.elements) if (e.type === "fluximg" && e.source?.bundlePath && !e.source.frozen && !e.source.external) { any = true; break; } if (any) break; }
  if (!any) return;
  scannedRoot = root;
  void scanFluximgSources().catch(() => {});
}
/** Arrange for the catch-up scan of the open project (idempotent; one cheap check per project change until it ran). */
export function armFluximgSourceScan(): void {
  if (!scanArmed) { scanArmed = true; project.subscribe(() => scanWhenLoaded()); }
  scanWhenLoaded();
}

/** Stop watching (tests; a window that closes takes its subscription with it). */
export function stopFluximgSourceWatch(): void {
  unwatch?.(); unwatch = null;
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
}

function run(bundlePath: string, also: ReadonlySet<string> = new Set(), explicit = false): Promise<number> {
  const busy = running.get(bundlePath);
  if (busy) { again.add(bundlePath); return busy; }
  const job = (async () => {
    let moved = 0;
    do {
      again.delete(bundlePath);
      moved += await updateBundle(bundlePath, also, explicit);
    } while (again.has(bundlePath));
    return moved;
  })().finally(() => running.delete(bundlePath));
  running.set(bundlePath, job);
  return job;
}

/** True when the import failed because the bundle was still being written (try again once it is quiet). */
const unfinished = (message: string): boolean => /fluximg\.json|changed while|not an image bundle|no longer|missing/i.test(message);

async function updateBundle(bundlePath: string, also: ReadonlySet<string>, explicit: boolean): Promise<number> {
  const fb = fileBridge();
  const root = rootNow();
  if (!fb?.importFluximg || !fb.discardFluximg || !root || storeTenant() !== "figure") return 0;
  const isCurrent = (): boolean => rootNow() === root && storeTenant() === "figure";
  const following = (): boolean => get(project).figures.some((f) => f.elements.some((e) => e.type === "fluximg" && (followsBundle(e, bundlePath) || also.has(e.id))));
  if (!following()) { seenChanged.delete(bundlePath); return 0; }
  const abs = absOf(root, bundlePath), outside = abs === bundlePath;
  // The manifest is written last: without it the bundle is not finished (or is gone) — wait for its next change.
  // (A bundle outside the project is only reached by an explicit update; the import itself says what is wrong.)
  if (!outside && !(await fb.exists(joinPath(abs, "fluximg.json")).catch(() => false))) {
    if (explicit) throw new Error(`${bundlePath} has no fluximg.json: the source is missing or still being written`);
    return 0;
  }
  const name = bundlePath.split("/").pop()!.replace(/\.fluximg$/i, "");
  const assetId = fluximgAssetId(name, `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`);
  let result;
  try { result = await fb.importFluximg({ root, sourcePath: bundlePath, assetId }); }
  catch (error) {
    const message = errMsg(error);
    if (!explicit && unfinished(message)) { if (isCurrent()) schedule(bundlePath); return 0; }
    throw error;
  }
  let ownCopy = true;
  const discard = async (): Promise<void> => { if (ownCopy) { ownCopy = false; await fb.discardFluximg!({ root, assetId }).catch(() => {}); } };
  try {
    if (!isCurrent() || !following()) { await discard(); return 0; }
    const existing = findFluximgAsset(get(project).assets, result.sha256);
    let next: Asset;
    if (existing) { await discard(); next = existing; }
    else next = fluximgAsset(assetId, result, bundlePath);
    // Plan against the model as it is NOW; the commit re-checks each element (it may have moved on meanwhile).
    const plan = planFluximgSourceUpdate(get(project), bundlePath, next, result.manifest);
    if (also.size) {
      const extra = planFluximgSourceUpdate(withUnfrozen(get(project), also), bundlePath, next, result.manifest);
      for (const m of extra.moves) if (!plan.moves.some((x) => x.elementId === m.elementId)) plan.moves.push(m);
      for (const id of extra.oldAssetIds) if (!plan.oldAssetIds.includes(id)) plan.oldAssetIds.push(id);
    }
    if (!plan.moves.length) { await discard(); seenChanged.delete(bundlePath); return 0; }
    let moved = 0;
    commit((p) => { moved = applyFluximgSourceUpdate(p, plan, next); });
    if (!moved) { await discard(); return 0; }
    ownCopy = false; // registered: the new asset folder belongs to the project now
    if (next.id === assetId) fluximgManifests.update((m) => ({ ...m, [next.id]: result.manifest }));
    for (const id of plan.oldAssetIds) {
      const old = get(project).assets.find((a) => a.id === id);
      if (old) forgetFluximg(old);
    }
    seenChanged.delete(bundlePath);
    const changed = [...new Set(plan.moves.flatMap((m) => m.changed))];
    if (changed.length) {
      pushToast("info", `${name} changed shape: ${changed.length === 1 ? changed[0] : `${changed.slice(0, -1).join(", ")} and ${changed[changed.length - 1]}`} ${changed.length === 1 ? "was" : "were"} adjusted to fit`, {
        detail: `${moved === 1 ? "The placed image" : `${moved} placed images`} now ${moved === 1 ? "shows" : "show"} the new version. Undo (Ctrl+Z) brings back the previous one.`,
      });
    }
    return moved;
  } catch (error) {
    await discard();
    throw error;
  }
}

/** A copy of the project where the named elements count as following their bundle even when frozen. */
function withUnfrozen(p: Project, ids: ReadonlySet<string>): Project {
  return {
    ...p,
    figures: p.figures.map((f) => ({ ...f, elements: f.elements.map((e) => (e.type === "fluximg" && ids.has(e.id) && e.source?.frozen ? { ...e, source: { ...e.source, frozen: false } } : e)) })),
  };
}

function elementById(id: string): FluximgElement | null {
  for (const f of get(project).figures) for (const e of f.elements) if (e.id === id && e.type === "fluximg") return e;
  return null;
}

/**
 * Where a placed image stands against its source: `external` (no source, or one outside the project that Flux does
 * not watch), `missing` (the bundle or its manifest is gone), `changed` (the source differs from what is placed),
 * `current`. Cheap: it compares the two manifests' bytes, never pixels; a change the watcher has seen
 * counts as `changed` until it is brought in.
 */
export async function fluximgSourceState(el: Pick<FluximgElement, "assetId" | "source">): Promise<FluximgSourceState> {
  const s = el.source;
  if (!s?.bundlePath || s.external) return "external";
  const root = rootNow(), fb = fileBridge();
  if (!root || !fb) return "missing";
  const bundlePath = norm(s.bundlePath);
  if (!(await fb.exists(joinPath(absOf(root, bundlePath), "fluximg.json")).catch(() => false))) return "missing";
  if (seenChanged.has(bundlePath)) return "changed";
  const asset = get(project).assets.find((a) => a.id === el.assetId);
  if (!asset) return "changed";
  if (s.sha256 && asset.sha256 && s.sha256 !== asset.sha256) return "changed";
  if (!fb.readFluximg) return "missing";
  try {
    // Two small manifests, compared as bytes (nothing parsed, no pixels): the writer rewrites the manifest last on
    // every write, so a source whose manifest equals the placed copy's has not changed.
    const read = (bundle: string): Promise<ArrayBuffer> => fb.readFluximg!({ root, bundle, path: "fluximg.json", offset: 0, length: -1 });
    const [mine, theirs] = await Promise.all([read(fluximgBundle(asset)), read(bundlePath)]);
    if (mine.byteLength !== theirs.byteLength) return "changed";
    const a = new Uint8Array(mine), b = new Uint8Array(theirs);
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return "changed";
    return "current";
  } catch { return "missing"; }
}

/**
 * Bring the source's current content in now (the Inspector / F-menu action). Every element that follows the same
 * bundle moves with it; this element moves even when it is frozen (asking is the deliberate act). Resolves to the
 * number of elements moved (0 when the source was already current); rejects with the file side's message.
 */
export async function updateFluximgFromSource(elementId: string): Promise<number> {
  const el = elementById(elementId);
  if (!el) throw new Error("That image is no longer on the figure");
  if (!el.source?.bundlePath) throw new Error("This image does not remember where it came from");
  ensureFluximgSourceWatch();
  const bundlePath = el.source.external ? el.source.bundlePath : norm(el.source.bundlePath);
  const t = timers.get(bundlePath);
  if (t) { clearTimeout(t); timers.delete(bundlePath); }
  return run(bundlePath, new Set([elementId]), true);
}

/** Dev/test: bundles waiting for a quiet spell or being updated. */
export function fluximgSourceActivity(): { waiting: string[]; running: string[]; changed: string[] } {
  return { waiting: [...timers.keys()], running: [...running.keys()], changed: [...seenChanged] };
}
