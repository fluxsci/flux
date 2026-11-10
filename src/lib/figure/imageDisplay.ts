// Residency and IO for raster display tiers (policy and rationale: figure/imageTiers.ts).
//
// `assetDisplay[id]` is what an image ELEMENT paints in the figure editor: a bounded tier (a small PNG
// data URL — it must survive scene serialization, which a blob: URL does not) and, at deep zoom, a
// detail of the visible part (a blob URL; never serialized). `pending` marks a large image whose first
// tier is on its way, so the 27 MB original is never put in the DOM just to be replaced. Everything
// here is display only: exports, saves and pictures keep reading the original bytes.
//
// Sources of a tier, in order: memory → the project's machine-local cache (.meta/cache/display, keyed
// by the source file's size + mtime) → the worker, which decodes the original ONCE, makes the whole
// ladder and fills the cache. Nothing in this module decodes or resamples on the main thread.
import { get, writable } from "svelte/store";
import type { Asset, Id } from "../types";
import type { FileBridge } from "../project/types";
import { assetData, assetDirtyGeneration, bytesToDataUrl, dataUrlToBytes, getAssetData, isAssetDirty } from "../assets";
import { storedAssetPath } from "../project/assetPath";
import { storeTenantState } from "../tenancy";
import {
  needsTiers, levelFor, ladder, tierSize, tierIsSoft, detailPlan, detailServes, detailBeatsTier, cacheMetaValid,
  displayCacheDir, displayCacheMeta, displayCacheTier, DISPLAY_CACHE_VERSION,
  type DetailPlan, type DisplayCacheMeta, type SourceRect,
} from "./imageTiers";

export interface DisplayTier { href: string; level: number; width: number; height: number }
export interface DisplayDetail extends DetailPlan { href: string }
export interface AssetDisplay { natural: { width: number; height: number }; pending?: true; tier?: DisplayTier; detail?: DisplayDetail }
export const assetDisplay = writable<Record<Id, AssetDisplay>>({});
/** Advances when a TIER changes (never for a detail): part of the scene snapshot key. */
export const displayRevision = writable(0);
export const imageDisplayStats = { decodes: 0, cacheHits: 0, cacheWrites: 0, tierSwaps: 0, details: 0, failures: 0, workerMs: 0 };
/** Dev/gate switch (never set by product code): with tiers off, images paint their own bytes as before. */
export const imageDisplayDev = { enabled: true, /** gates only: hold every tier load this long, to widen the pending window */ delayMs: 0 };

export interface DisplayScope { root: string; embedded: boolean; bridge: FileBridge | null; assets: readonly Asset[] }
/** Who named the current project: the figure LOADER knows the real root (`beginImageDisplay`), and then
 *  a canvas or atlas report only refreshes the asset list; without a loader (a standalone project) the
 *  canvas's own root stands, and a different root is a different project. */
let scopeFromLoad = false;
export interface DisplayNeed { density: number; inView: boolean; visible?: SourceRect }

interface Entry {
  asset: Asset; generation: number;
  levels: Map<number, DisplayTier>;          // resident tiers
  cached: Set<number> | null;                 // levels the disk cache holds (null = not probed)
  chain: Promise<void>;                        // one load at a time per image (a second must not decode again)
  asked: Set<number>;                          // levels with a show-request in flight
  wantDetail: DetailPlan | null; detailBusy: boolean;
  failed: boolean;
}
let scope: DisplayScope | null = null, scopeSerial = 0;
const entries = new Map<Id, Entry>();

// --- worker pool -------------------------------------------------------------------------------------
type Reply = { id: number; ok: boolean; error?: string; natural?: { width: number; height: number }; tiers?: { level: number; width: number; height: number; bytes: ArrayBuffer }[]; bytes?: ArrayBuffer };
interface PoolWorker { worker: Worker; busy: number }
const POOL = 2;
let pool: PoolWorker[] = [], rid = 0;
const waiting = new Map<number, (reply: Reply) => void>();
function spawn(): PoolWorker | null {
  if (typeof Worker === "undefined") return null;
  try {
    const worker = new Worker(new URL("./imageTiers.worker.ts", import.meta.url), { type: "module" });
    const slot: PoolWorker = { worker, busy: 0 };
    worker.onmessage = (event: MessageEvent<Reply>) => { const done = waiting.get(event.data.id); if (done) { waiting.delete(event.data.id); slot.busy--; done(event.data); } };
    worker.onerror = () => { // a dead worker fails its requests; the next request respawns
      pool = pool.filter(p => p !== slot);
      for (const [id, done] of waiting) { waiting.delete(id); done({ id, ok: false, error: "display worker failed" }); }
    };
    return slot;
  } catch { return null; }
}
/** One image always goes to the same worker (its decoded source is cached there). */
function workerFor(key: string): PoolWorker | null {
  while (pool.length < POOL) { const slot = spawn(); if (!slot) break; pool.push(slot); }
  if (!pool.length) return null;
  let h = 0; for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  return pool[Math.abs(h) % pool.length];
}
function ask(key: string, message: Record<string, unknown>, transfer: Transferable[] = []): Promise<Reply> {
  const slot = workerFor(key);
  if (!slot) return Promise.resolve({ id: 0, ok: false, error: "no display worker" });
  const id = ++rid, started = performance.now();
  return new Promise<Reply>(resolve => {
    waiting.set(id, reply => { imageDisplayStats.workerMs += performance.now() - started; resolve(reply); });
    slot.busy++;
    slot.worker.postMessage({ ...message, id, key }, transfer);
  });
}

// --- scope ---------------------------------------------------------------------------------------------
const keyOf = (entry: Entry) => `${scopeSerial}:${entry.asset.id}:${entry.generation}`;
function publish(id: Id, patch: (current: AssetDisplay | undefined) => AssetDisplay | undefined) {
  assetDisplay.update(all => {
    const next = patch(all[id]);
    if (next === all[id]) return all;
    const copy = { ...all };
    if (next) copy[id] = next; else delete copy[id];
    return copy;
  });
}
function dropDetail(id: Id) {
  publish(id, current => {
    if (!current?.detail) return current;
    URL.revokeObjectURL(current.detail.href);
    const { detail: _gone, ...rest } = current;
    return rest;
  });
}
/** Forget everything (project switch, tenant change). */
export function resetImageDisplay(): void {
  scopeSerial++; scope = null; scopeFromLoad = false; entries.clear();
  for (const display of Object.values(get(assetDisplay))) if (display.detail) URL.revokeObjectURL(display.detail.href);
  if (Object.keys(get(assetDisplay)).length) assetDisplay.set({});
  for (const slot of pool) slot.worker.postMessage({ id: ++rid, kind: "forget" });
}
// Slide mode loads decks into the same stores; tiers belong to the figure editor's canvas only.
storeTenantState.subscribe(tenant => { if (tenant !== "figure" && scope) resetImageDisplay(); });

const tiered = (asset: Asset) => asset.kind === "png" && needsTiers(asset.naturalWidth, asset.naturalHeight);
/** A project's figures were loaded: large images start PENDING (their originals stay out of the DOM)
 *  and the cheapest tier each one has is fetched at once from the cache, in the background. */
export function beginImageDisplay(next: DisplayScope): void {
  resetImageDisplay();
  if (get(storeTenantState) !== "figure" || !imageDisplayDev.enabled) return;
  scope = next; scopeFromLoad = true;
  const pending: Record<Id, AssetDisplay> = {};
  for (const asset of next.assets) if (tiered(asset)) pending[asset.id] = { natural: { width: asset.naturalWidth, height: asset.naturalHeight }, pending: true };
  assetDisplay.set(pending);
}
/** The entry for an asset's CURRENT bytes. `replaced` = its bytes (or recorded size) changed since the
 *  last report: every tier and detail of the old bytes is stale and must leave the screen. */
function entryFor(asset: Asset): { entry: Entry; replaced: boolean } {
  const generation = assetDirtyGeneration(asset.id);
  let entry = entries.get(asset.id), replaced = false;
  if (entry && (entry.generation !== generation || entry.asset.naturalWidth !== asset.naturalWidth || entry.asset.naturalHeight !== asset.naturalHeight)) {
    entries.delete(asset.id); entry = undefined; replaced = true;
    for (const slot of pool) slot.worker.postMessage({ id: ++rid, kind: "forget" });
  }
  if (!entry) { entry = { asset, generation, levels: new Map(), cached: null, chain: Promise.resolve(), asked: new Set(), wantDetail: null, detailBusy: false, failed: false }; entries.set(asset.id, entry); }
  entry.asset = asset;
  return { entry, replaced };
}

// --- IO ----------------------------------------------------------------------------------------------
async function sourcePath(asset: Asset, s: DisplayScope): Promise<string | null> {
  if (!asset.path || !s.bridge) return null;
  const relative = storedAssetPath(`${s.embedded ? "fig/" : ""}${asset.path}`);
  return s.bridge.projectAssetPath ? await s.bridge.projectAssetPath(s.root, relative) : `${s.root.replace(/[\\/]+$/, "")}/${relative}`;
}
/** The original's bytes for the worker: straight from the file when the stored file IS the asset
 *  (no base64 round trip on this thread), else from the resident bytes of an unsaved/edited asset. */
async function sourceBytes(asset: Asset, s: DisplayScope): Promise<ArrayBuffer | null> {
  if (!isAssetDirty(asset.id)) {
    const path = await sourcePath(asset, s);
    if (path && s.bridge) { try { const bytes = await s.bridge.readFile(path); return bytes instanceof ArrayBuffer ? bytes : new Uint8Array(bytes as ArrayBufferLike).slice().buffer; } catch { /* fall through */ } }
  }
  const url = getAssetData(asset.id);
  return url ? dataUrlToBytes(url).buffer as ArrayBuffer : null;
}
const canCache = (asset: Asset, s: DisplayScope) => s.embedded && !!s.bridge?.stat && !!asset.path && !isAssetDirty(asset.id);
async function probeCache(entry: Entry, s: DisplayScope): Promise<void> {
  entry.cached = new Set();
  if (!canCache(entry.asset, s)) return;
  try {
    const bridge = s.bridge!, meta = displayCacheMeta(s.root, entry.asset.id), path = await sourcePath(entry.asset, s);
    if (!path || !await bridge.exists(meta)) return;
    const st = await bridge.stat!(path), parsed = JSON.parse(await bridge.readText(meta)) as unknown;
    if (cacheMetaValid(parsed, st ? { size: st.size, mtimeMs: st.mtimeMs } : null)
      && parsed.natural.width === entry.asset.naturalWidth && parsed.natural.height === entry.asset.naturalHeight) entry.cached = new Set(parsed.levels);
  } catch { /* advisory */ }
}
async function readCached(entry: Entry, level: number, s: DisplayScope): Promise<DisplayTier | null> {
  try {
    const bytes = new Uint8Array(await s.bridge!.readFile(displayCacheTier(s.root, entry.asset.id, level)));
    if (bytes.length < 16) return null;
    imageDisplayStats.cacheHits++;
    return { href: bytesToDataUrl(bytes, "image/png"), ...tierSize(entry.asset.naturalWidth, entry.asset.naturalHeight, level) };
  } catch { return null; }
}
// At most POOL originals are in flight: each is tens of MB read just in time, never queued in bulk.
let generating = 0;
const generateQueue: (() => void)[] = [];
async function generateSlot(): Promise<() => void> {
  if (generating >= POOL) await new Promise<void>(resolve => generateQueue.push(resolve));
  generating++;
  return () => { generating--; generateQueue.shift()?.(); };
}
async function generate(entry: Entry, s: DisplayScope, serial: number): Promise<boolean> {
  const { asset } = entry, levels = ladder(asset.naturalWidth, asset.naturalHeight);
  const release = await generateSlot();
  let reply: Reply;
  try {
    if (serial !== scopeSerial) return false;
    const bytes = await sourceBytes(asset, s);
    if (!bytes || serial !== scopeSerial) return false;
    imageDisplayStats.decodes++;
    reply = await ask(keyOf(entry), { kind: "tiers", bytes, mime: "image/png", levels }, [bytes]);
  } finally { release(); }
  if (serial !== scopeSerial || entries.get(asset.id) !== entry) return false;
  if (!reply.ok || !reply.tiers?.length) return false;
  // The asset's recorded natural size is what placements are laid out against; a file that decodes to
  // another size would map details wrongly, so it keeps its original on screen instead.
  if (reply.natural && (reply.natural.width !== asset.naturalWidth || reply.natural.height !== asset.naturalHeight)) return false;
  for (const tier of reply.tiers) entry.levels.set(tier.level, { href: bytesToDataUrl(new Uint8Array(tier.bytes), "image/png"), level: tier.level, width: tier.width, height: tier.height });
  if (canCache(asset, s)) void (async () => {
    try {
      const bridge = s.bridge!, path = await sourcePath(asset, s), st = path ? await bridge.stat!(path) : null;
      if (!st || serial !== scopeSerial) return;
      await bridge.mkdir(displayCacheDir(s.root));
      for (const tier of reply.tiers!) await bridge.writeFile(displayCacheTier(s.root, asset.id, tier.level), new Uint8Array(tier.bytes));
      const meta: DisplayCacheMeta = { version: DISPLAY_CACHE_VERSION, source: { size: st.size, mtimeMs: st.mtimeMs }, natural: { width: asset.naturalWidth, height: asset.naturalHeight }, levels: reply.tiers!.map(t => t.level) };
      await bridge.writeText(displayCacheMeta(s.root, asset.id), JSON.stringify(meta));
      entry.cached = new Set(meta.levels);
      imageDisplayStats.cacheWrites++;
    } catch { /* the cache is advisory */ }
  })();
  return true;
}
/** Make `level` resident for this image (memory → cache → the worker) and return it; null when the
 *  image cannot be tiered (it then paints its own bytes) or the project changed meanwhile. */
function loadTier(entry: Entry, level: number): Promise<DisplayTier | null> {
  const s = scope, serial = scopeSerial;
  const live = () => !!s && serial === scopeSerial && entries.get(entry.asset.id) === entry;
  const run = async (): Promise<DisplayTier | null> => {
    if (!s || !live() || entry.failed) return null;
    let tier = entry.levels.get(level) ?? null;
    if (!tier) {
      if (imageDisplayDev.delayMs > 0) await new Promise(resolve => setTimeout(resolve, imageDisplayDev.delayMs));
      if (entry.cached === null) await probeCache(entry, s);
      if (entry.cached!.has(level)) tier = await readCached(entry, level, s);
      if (tier) entry.levels.set(level, tier);
      else if (await generate(entry, s, serial)) tier = entry.levels.get(level) ?? null;
    }
    if (!live()) return null;
    if (!tier) { // cannot be tiered: show the original, as before tiers existed
      entry.failed = true; imageDisplayStats.failures++;
      publish(entry.asset.id, () => undefined);
      displayRevision.update(n => n + 1);
    }
    return tier;
  };
  const next = entry.chain.then(run, run);
  entry.chain = next.then(() => undefined, () => { if (live()) { entry.failed = true; imageDisplayStats.failures++; publish(entry.asset.id, () => undefined); displayRevision.update(n => n + 1); } });
  return next.catch(() => null);
}
/** Put a resident tier on screen unless one at least as sharp is already showing. */
function show(entry: Entry, tier: DisplayTier): void {
  if (entries.get(entry.asset.id) !== entry) return;
  const shown = get(assetDisplay)[entry.asset.id]?.tier;
  if (shown && shown.level <= tier.level) return;
  publish(entry.asset.id, current => ({ natural: { width: entry.asset.naturalWidth, height: entry.asset.naturalHeight }, ...(current?.detail ? { detail: current.detail } : {}), tier }));
  imageDisplayStats.tierSwaps++;
  displayRevision.update(n => n + 1);
}
/** Make `level` resident for this image and show it, unless a sharper tier is already showing. */
function ensureTier(entry: Entry, level: number): void {
  if (entry.asked.has(level)) return; // the canvas reports often; one load per level in flight
  entry.asked.add(level);
  void loadTier(entry, level).then(tier => { if (tier) show(entry, tier); }).finally(() => entry.asked.delete(level));
}
function ensureDetail(entry: Entry, plan: DetailPlan): void {
  entry.wantDetail = plan;
  if (entry.detailBusy || entry.failed) return;
  const s = scope, serial = scopeSerial;
  if (!s) return;
  entry.detailBusy = true;
  void (async () => {
    try {
      while (entry.wantDetail && serial === scopeSerial && entries.get(entry.asset.id) === entry) {
        const want = entry.wantDetail; entry.wantDetail = null;
        const message = { kind: "detail", mime: "image/png", source: want.source, width: want.width, height: want.height };
        let reply = await ask(keyOf(entry), message);
        if (!reply.ok && reply.error === "source-needed") {
          const bytes = await sourceBytes(entry.asset, s);
          if (!bytes || serial !== scopeSerial) return;
          imageDisplayStats.decodes++;
          reply = await ask(keyOf(entry), { ...message, bytes }, [bytes]);
        }
        if (serial !== scopeSerial || entries.get(entry.asset.id) !== entry || !reply.ok || !reply.bytes) return;
        if (entry.wantDetail) continue; // a newer view is waiting: do not show a superseded one
        const href = URL.createObjectURL(new Blob([reply.bytes], { type: "image/png" }));
        publish(entry.asset.id, current => {
          if (!current) { URL.revokeObjectURL(href); return current; }
          if (current.detail) URL.revokeObjectURL(current.detail.href);
          return { ...current, detail: { ...want, href } };
        });
        imageDisplayStats.details++;
      }
    } finally { entry.detailBusy = false; }
  })();
}

/** The entry for an asset's current bytes; bytes that were replaced leave the screen here: the image's
 *  own (new) bytes show at once and a tier of them follows. */
function currentEntry(asset: Asset): Entry {
  const { entry, replaced } = entryFor(asset), current = get(assetDisplay)[asset.id];
  if (replaced || (current && (current.natural.width !== asset.naturalWidth || current.natural.height !== asset.naturalHeight))) {
    if (current?.detail) URL.revokeObjectURL(current.detail.href);
    publish(asset.id, () => undefined);
    displayRevision.update(n => n + 1);
  }
  return entry;
}
function adopt(next: DisplayScope): void {
  if (scope && scopeFromLoad) { scope = { ...scope, assets: next.assets }; return; }
  if (!scope || scope.root !== next.root || scope.embedded !== next.embedded) resetImageDisplay();
  scope = next;
}

/** The canvas reports, WHILE QUIET, what each image asset on the live canvas needs. Upgrades are
 *  requested for images in view; an image with no tier yet gets one wherever it is. Never downgrades. */
export function syncImageDisplay(next: DisplayScope, needs: ReadonlyMap<Id, DisplayNeed>): void {
  if (get(storeTenantState) !== "figure" || !imageDisplayDev.enabled) return;
  adopt(next);
  for (const [id, need] of needs) {
    const asset = next.assets.find(a => a.id === id);
    if (!asset || !tiered(asset)) continue;
    const entry = currentEntry(asset);
    if (entry.failed) continue;
    const current: AssetDisplay | undefined = get(assetDisplay)[id];
    const level = levelFor(asset.naturalWidth, asset.naturalHeight, need.density);
    if (!current?.tier) ensureTier(entry, level);
    else if (need.inView && level < current.tier.level) ensureTier(entry, level);
    const soft = need.inView && !!need.visible && tierIsSoft(asset.naturalWidth, asset.naturalHeight, need.density);
    const plan = soft ? detailPlan(asset.naturalWidth, asset.naturalHeight, need.visible!, need.density) : null;
    if (plan && detailBeatsTier(asset.naturalWidth, asset.naturalHeight, plan)) {
      if (!(current?.detail && detailServes(asset.naturalWidth, asset.naturalHeight, current.detail, need.visible!, need.density))) ensureDetail(entry, plan);
    } else if (current?.detail) { entry.wantDetail = null; dropDetail(id); }
  }
}
/** Device pixels per source pixel that a placement needs when its figure is drawn at `S` image px per
 *  world unit (a crop shows part of the image in the same box). */
export function placementDensity(element: { width: number; height: number; crop?: { width: number; height: number } }, asset: Asset, S: number): number {
  const k = asset.dpi && asset.dpi > 0 ? 96 / asset.dpi : 1, crop = element.crop;
  const ux = crop ? (element.width / crop.width) * k : element.width / asset.naturalWidth, uy = crop ? (element.height / crop.height) * k : element.height / asset.naturalHeight;
  return Math.max(ux, uy) * S;
}
/** Tiers for a CAPTURE of one figure at `S` image px per world unit — an atlas picture, a figure detail.
 *  Every tiered image the figure places gets a tier at least that sharp (within the ladder); the result
 *  maps asset id → the tier's data URL, complete when the promise resolves. An image that cannot be
 *  tiered is absent (it paints its own bytes). `show` also puts those tiers on the live canvas, for a
 *  capture that photographs the DOM: a picture must never hold a placeholder or an original
 *  (2026-11-09: the raster service refuses a figure whose originals exceed 64 MiB, the fallback
 *  photographed the live figure while its images were still pending, and the owner's Figure 22 was
 *  pictured as nine grey boxes). */
export async function captureTiers(next: DisplayScope, fig: { elements: readonly { type: string; assetId?: Id; width: number; height: number; crop?: { width: number; height: number } }[] }, S: number, opts: { show?: boolean } = {}): Promise<Record<Id, string>> {
  const out: Record<Id, string> = {};
  if (get(storeTenantState) !== "figure" || !imageDisplayDev.enabled) return out;
  adopt(next);
  const serial = scopeSerial, density = new Map<Id, number>();
  for (const element of fig.elements) {
    if (element.type !== "image" || !element.assetId) continue;
    const asset = next.assets.find(a => a.id === element.assetId);
    if (asset && tiered(asset)) density.set(asset.id, Math.max(density.get(asset.id) ?? 0, placementDensity(element, asset, S)));
  }
  await Promise.all([...density].map(async ([id, d]) => {
    const asset = next.assets.find(a => a.id === id)!, entry = currentEntry(asset);
    const tier = await loadTier(entry, levelFor(asset.naturalWidth, asset.naturalHeight, d));
    if (!tier || serial !== scopeSerial) return;
    out[id] = tier.href;
    if (opts.show) show(entry, tier);
  }));
  return out;
}
/** Does this figure place an image whose first tier has not arrived (it shows nothing yet)? */
export function figureImagesPending(fig: { elements: readonly { type: string; assetId?: Id }[] }): boolean {
  const all = get(assetDisplay);
  return fig.elements.some(element => { if (element.type !== "image" || !element.assetId) return false; const display = all[element.assetId]; return !!display?.pending && !display.tier; });
}
/** What a scene capture may embed per asset: its display tier when one is showing, else its own bytes;
 *  nothing while a tier is pending. A capture must never carry an original the canvas does not paint. */
export function displayAssetData(): Record<Id, string> {
  const out = { ...get(assetData) };
  for (const [id, display] of Object.entries(get(assetDisplay))) { if (display.tier) out[id] = display.tier.href; else if (display.pending) delete out[id]; }
  return out;
}
