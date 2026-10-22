// The Plots rail's thumbnail client — one per app (every rail instance shares it). Tiles ask for
// (file version, bucket); the client serves memory hits at once, otherwise asks the bridge
// (electron/ipc/plotThumbs.cjs: a disk-cache hit in main, else a render in the worker), at most
// MAX_IN_FLIGHT at a time, most urgent first. A tile that scrolls away releases its request: a
// queued one is dropped, a sent one is cancelled in the worker's queue.
//
// Fallback (no bridge method, the worker unavailable, a format the worker cannot decode): the
// renderer draws the tile itself (browserThumb.ts), one at a time, with the SAME ink analysis —
// the backdrop law holds on every path. 3D models use the existing gallery preview, videos their
// poster frame (Slide's rail lists them).
//
// PRE-WARM: after a listing settles the rail hands over every listed plot; the worker renders
// them into the DISK cache one at a time (no bytes cross IPC), only while no visible request is
// queued or in flight, and never during a canvas pointer gesture (+300 ms) — the next scroll or
// project open is then served from disk. It never touches a file over WARM_MAX_BYTES (a render
// that long would hold up the visible tiles queued behind it in the one worker), and it stops
// for the session at the first file that kills or hangs the worker (quarantined): every such
// death counts against the worker's respawn budget, which pre-warm must never spend.

import { fileBridge, type PlotThumbResult } from "../project/types";
import { bucketFor, type InkStats } from "./rules";
import { renderThumbInBrowser, FALLBACK_SVG_MAX, FALLBACK_RASTER_MAX } from "./browserThumb";

export interface ThumbState {
  /** Object URL of the raster ("" while pending or on error). */
  url: string;
  width: number;
  height: number;
  stats: InkStats | null;
  paper: string | null;
  pending: boolean;
  /** Why there is no picture ("" when there is one or it is still coming). */
  error: string;
}

type Listener = (s: ThumbState) => void;
interface Entry {
  key: string;
  path: string;
  stamp: string;
  bucket: number;
  priority: number;
  state: ThumbState;
  users: Set<Listener>;
  bytes: number;
  phase: "queued" | "sent" | "done";
  rid: string;
}

const MAX_IN_FLIGHT = 6;
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_ENTRIES = 400;
const PENDING: ThumbState = { url: "", width: 0, height: 0, stats: null, paper: null, pending: true, error: "" };

const entries = new Map<string, Entry>(); // insertion order = LRU among done entries
const queue: Entry[] = [];
const statsMemo = new Map<string, { stats: InkStats | null; paper: string | null }>(); // path|stamp
let inFlight = 0;
let fallbackBusy = false;
const fallbackQueue: Entry[] = [];
let ridSeq = 0;
let forceFallback = false;

/** Dev/test: draw every tile in the renderer, as if the worker were unavailable. */
export function setThumbFallback(on: boolean): void { forceFallback = on; }

function publish(e: Entry, state: ThumbState) {
  e.state = state;
  for (const cb of e.users) cb(state);
}

function trim() {
  let bytes = 0;
  for (const e of entries.values()) bytes += e.bytes;
  for (const [key, e] of entries) {
    if (entries.size <= MAX_ENTRIES && bytes <= MAX_BYTES) break;
    if (e.users.size || e.phase !== "done") continue;
    if (e.state.url.startsWith("blob:")) URL.revokeObjectURL(e.state.url);
    bytes -= e.bytes;
    entries.delete(key);
  }
}

function pump() {
  queue.sort((a, b) => a.priority - b.priority);
  while (inFlight < MAX_IN_FLIGHT && queue.length) {
    const e = queue.shift()!;
    if (!e.users.size) { entries.delete(e.key); continue; }
    e.phase = "sent";
    inFlight++;
    void request(e).finally(() => { inFlight--; pump(); });
  }
  if (!inFlight && !queue.length && warmQueue.length) scheduleWarm(100);
}

function finish(e: Entry, bytes: Uint8Array | null, r: { width?: number; height?: number; stats?: InkStats | null; paper?: string | null; error?: string }) {
  e.phase = "done";
  const memoKey = `${e.path}|${e.stamp}`;
  if (r.stats) statsMemo.set(memoKey, { stats: r.stats, paper: r.paper ?? null });
  if (statsMemo.size > 4000) statsMemo.delete(statsMemo.keys().next().value!);
  if (!e.users.size && !bytes) { entries.delete(e.key); return; }
  const url = bytes ? URL.createObjectURL(new Blob([bytes as BlobPart], { type: "image/png" })) : "";
  e.bytes = bytes?.byteLength ?? 0;
  publish(e, { url, width: r.width ?? 0, height: r.height ?? 0, stats: r.stats ?? null, paper: r.paper ?? null, pending: false, error: bytes ? "" : (r.error || "Preview unavailable") });
  trim();
}

async function request(e: Entry): Promise<void> {
  const fb = fileBridge();
  if (/\.glb$/i.test(e.path)) return model3d(e);
  if (/\.(mp4|mov)$/i.test(e.path)) return video(e);
  if (forceFallback || !fb?.plotThumb) { fallback(e); return; }
  let r: PlotThumbResult;
  try { r = await fb.plotThumb({ path: e.path, bucket: e.bucket, priority: e.priority, rid: e.rid }); }
  catch (err) { r = { error: err instanceof Error ? err.message : String(err) }; }
  if (r.cancelled) { if (e.users.size) { e.phase = "queued"; queue.push(e); } else entries.delete(e.key); return; }
  if (r.unavailable || r.unsupported) { fallback(e); return; }
  if (!r.bytes || r.error) {
    finish(e, null, { error: r.quarantined ? "This plot's preview failed; it will be retried when the file changes" : r.tooLarge ? "Too large to preview" : r.error || "Preview unavailable" });
    return;
  }
  finish(e, r.bytes, r);
}

async function model3d(e: Entry) {
  try {
    const { model3dGalleryPreview } = await import("../model3d/galleryPreview");
    const p = await model3dGalleryPreview(e.path, Math.min(512, e.bucket), new AbortController().signal);
    e.phase = "done";
    publish(e, { url: p.url, width: 0, height: 0, stats: null, paper: null, pending: false, error: "" });
  } catch (err) {
    finish(e, null, { error: err instanceof Error ? err.message : "No 3D preview" });
  }
}

async function video(e: Entry) {
  try {
    const fb = fileBridge();
    if (!fb?.videoPreview) throw new Error("Video previews need the desktop app");
    const p = await fb.videoPreview(e.path);
    e.phase = "done";
    e.bytes = p.poster.length;
    publish(e, { url: p.poster, width: p.width, height: p.height, stats: null, paper: null, pending: false, error: "" });
    trim();
  } catch (err) {
    finish(e, null, { error: err instanceof Error ? err.message : "No video preview" });
  }
}

function fallback(e: Entry) {
  fallbackQueue.push(e);
  void drainFallback();
}

async function drainFallback() {
  if (fallbackBusy) return;
  fallbackBusy = true;
  try {
    while (fallbackQueue.length) {
      fallbackQueue.sort((a, b) => a.priority - b.priority);
      const e = fallbackQueue.shift()!;
      if (!e.users.size) { entries.delete(e.key); continue; }
      try {
        const fb = fileBridge();
        const st = await fb?.stat?.(e.path).catch(() => null);
        const cap = /\.svg$/i.test(e.path) ? FALLBACK_SVG_MAX : FALLBACK_RASTER_MAX;
        if (st && st.size > cap) { finish(e, null, { error: "Too large to preview here" }); continue; }
        const bytes = new Uint8Array(await fb!.readFile(e.path));
        const t = await renderThumbInBrowser(bytes, e.path, e.bucket);
        finish(e, t.png, { width: t.width, height: t.height, stats: t.stats, paper: null });
      } catch (err) {
        finish(e, null, { error: err instanceof Error ? err.message : "Preview unavailable" });
      }
      // One main-thread draw per task: input and paint get their turn in between (a
      // setTimeout slice — requestIdleCallback starves on real displays, guide §9).
      await new Promise((r) => setTimeout(r, 0));
    }
  } finally { fallbackBusy = false; }
}

/**
 * Subscribe a tile. `stamp` identifies the file version (size:mtime — a regenerated plot gets a
 * fresh thumbnail); `cssWidth` × `dpr` picks the bucket; lower `priority` is served first.
 * Returns the release function.
 */
export function acquireThumb(path: string, stamp: string, cssWidth: number, dpr: number, priority: number, cb: Listener): () => void {
  const bucket = bucketFor(cssWidth, dpr);
  const key = `${path}|${stamp}|${bucket}`;
  let e = entries.get(key);
  if (!e) {
    e = { key, path, stamp, bucket, priority, state: PENDING, users: new Set(), bytes: 0, phase: "queued", rid: `t${++ridSeq}` };
    entries.set(key, e);
    // A smaller/larger bucket of the same version may already know the backdrop.
    const memo = statsMemo.get(`${path}|${stamp}`);
    if (memo) e.state = { ...PENDING, stats: memo.stats, paper: memo.paper };
    queue.push(e);
  } else {
    entries.delete(key); entries.set(key, e); // recency
    if (e.phase === "queued") e.priority = Math.min(e.priority, priority);
  }
  e.users.add(cb);
  cb(e.state);
  pump();
  const entry = e;
  return () => {
    entry.users.delete(cb);
    if (entry.users.size) return;
    if (entry.phase === "queued") {
      const i = queue.indexOf(entry);
      if (i >= 0) queue.splice(i, 1);
      const j = fallbackQueue.indexOf(entry);
      if (j >= 0) fallbackQueue.splice(j, 1);
      entries.delete(entry.key);
    } else if (entry.phase === "sent") {
      void fileBridge()?.plotThumbCancel?.([entry.rid]).catch(() => {});
    } else trim();
  };
}

/** Re-rank a QUEUED request (scrolling changes which tiles are nearest); never touches one
 *  already sent — re-acquiring would cancel and resend it through IPC on every scroll step. */
export function setThumbPriority(path: string, stamp: string, cssWidth: number, dpr: number, priority: number): void {
  const e = entries.get(`${path}|${stamp}|${bucketFor(cssWidth, dpr)}`);
  if (e && e.phase === "queued") e.priority = priority;
}

/** The analysis known for a file version, if any tile of it has loaded. */
export function knownStats(path: string, stamp: string): { stats: InkStats | null; paper: string | null } | null {
  return statsMemo.get(`${path}|${stamp}`) ?? null;
}

/** Drop every cached URL (project change). */
export function clearThumbs(): void {
  for (const e of entries.values()) if (e.state.url.startsWith("blob:") && !e.users.size) URL.revokeObjectURL(e.state.url);
  for (const [key, e] of entries) if (!e.users.size) entries.delete(key);
  statsMemo.clear();
  warmQueue.length = 0;
  warmed.clear();
}

// ---------------------------------------------------------------------------------------------
// Pre-warm.
// ---------------------------------------------------------------------------------------------

export interface WarmJob { path: string; stamp: string; cssWidth: number; size: number }
/** Pre-warm leaves bigger files to the moment their tile is on screen. */
export const WARM_MAX_BYTES = 2 * 1024 * 1024;
const warmQueue: (WarmJob & { bucket: number })[] = [];
/** path|stamp|bucket already in the disk cache (or failed) this session. */
const warmed = new Set<string>();
let warmOwner: object | null = null;
let warmBusy = false;
let warmHeld = false;
let warmHoldUntil = 0;
let warmTimer: ReturnType<typeof setTimeout> | null = null;
let warmDisabled = false;
let warmDone = 0;

/** Hand the pre-warm queue to `owner` (replacing any other owner's): these files, in order. */
export function setPrewarm(owner: object, jobs: WarmJob[], dpr: number): void {
  warmOwner = owner;
  warmQueue.length = 0;
  for (const j of jobs) {
    if (!/\.(svg|png)$/i.test(j.path) || !(j.size <= WARM_MAX_BYTES)) continue;
    const bucket = bucketFor(j.cssWidth, dpr);
    const key = `${j.path}|${j.stamp}|${bucket}`;
    if (warmed.has(key) || entries.get(key)?.phase === "done") continue;
    warmQueue.push({ ...j, bucket });
  }
  scheduleWarm(0);
}
/** Stop pre-warming for `owner` (rail hidden, project changed, unmounted). */
export function clearPrewarm(owner: object): void {
  if (warmOwner !== owner) return;
  warmOwner = null;
  warmQueue.length = 0;
}
/** Hold pre-warm during a canvas pointer gesture; release resumes it after 300 ms. */
export function holdPrewarm(on: boolean): void {
  warmHeld = on;
  if (!on) { warmHoldUntil = Date.now() + 300; scheduleWarm(300); }
}
/** Dev/test: what pre-warm is doing. */
export function prewarmState(): { queued: number; done: number; busy: boolean; held: boolean; disabled: boolean } {
  return { queued: warmQueue.length, done: warmDone, busy: warmBusy, held: warmHeld || Date.now() < warmHoldUntil, disabled: warmDisabled };
}

function scheduleWarm(ms: number) {
  if (warmTimer) return;
  warmTimer = setTimeout(() => { warmTimer = null; pumpWarm(); }, ms);
}

function pumpWarm() {
  if (warmBusy || warmDisabled || !warmQueue.length || forceFallback) return;
  const fb = fileBridge();
  if (!fb?.plotThumb) return;
  // Visible work first, always; then wait out a gesture.
  if (inFlight || queue.length || fallbackQueue.length || fallbackBusy) { scheduleWarm(250); return; }
  if (warmHeld || Date.now() < warmHoldUntil) { scheduleWarm(Math.max(50, warmHoldUntil - Date.now())); return; }
  const job = warmQueue.shift()!;
  const key = `${job.path}|${job.stamp}|${job.bucket}`;
  if (warmed.has(key) || entries.get(key)?.phase === "done") { scheduleWarm(0); return; }
  warmBusy = true;
  void fb.plotThumb({ path: job.path, bucket: job.bucket, priority: 1e9, rid: `w${++ridSeq}`, warm: true })
    .then((r) => {
      // The worker is gone, or this file crashed / hung it: never risk another death.
      if (r.unavailable || r.quarantined) { warmDisabled = true; warmQueue.length = 0; warmed.add(key); return; }
      if (r.cancelled) return;
      warmed.add(key);
      warmDone++;
      if (r.stats) statsMemo.set(`${job.path}|${job.stamp}`, { stats: r.stats, paper: r.paper ?? null });
    })
    .catch(() => { warmed.add(key); })
    .finally(() => { warmBusy = false; scheduleWarm(0); });
}
