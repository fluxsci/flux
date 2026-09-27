// The pack cache: where a flux-connect pack lives on disk, how long packs are
// kept, and where to go when the primary location is not writable (the Codex
// sandbox blocks writes outside the workspace). Layout:
//
//   <userDataDir>/connect/<slug(title)>-<hash8(realpath(root))>/<packId>/
//   <userDataDir>/connect/global/<packId>/
//       brief.md · bundle.md · images/*.png · pack.json · src/<sha>.txt
//   <userDataDir>/connect/sessions/<session-key>.json   (CLI cursors, §8.8)
//
// Fallback: os.tmpdir()/flux-connect-<uid>/…, then stdout-only (no pack dir).

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { createHash, randomBytes } from "node:crypto";
import * as fluxPaths from "../../electron/fluxPaths.cjs";
import { slugify } from "../../src/lib/project/types";
import type { SourceRecord } from "./collect";
import type { BundleSection } from "./bundle";
import type { ConnectDepth, ConnectMode } from "./facts";
import type { StatSnapshot } from "./refresh";

/** Packs kept per root; older ones are removed when a new one is written. */
export const PACKS_KEPT = 5;

export interface PackImageRecord {
  path: string;
  label: string;
}

/** pack.json: everything needed to re-read, check and diff a pack later. */
export interface PackManifest {
  v: 1;
  packId: string;
  mode: ConnectMode;
  root: string | null;
  title: string;
  createdAt: string;
  depth: ConnectDepth;
  build: { version: string; commit: string };
  identity: { product: string | null; surface: string | null; client: string; sessionId: string | null };
  sessionName: string | null;
  sources: SourceRecord[];
  bundle: { sections: BundleSection[]; tokens: number; lines: number };
  images: PackImageRecord[];
  counts: { docs: number; figures: number; canvases: number; decks: number; annotations: number; comments: number; logEntries: number };
  /** What a later delta compares against without re-reading the old pack's files. */
  state: PackState;
  snapshot: StatSnapshot;
}

export interface PackState {
  logTitles: string[];
  /** figure id → display name + sha of its canvas-file JSON. */
  figures: Record<string, { name: string; sha: string }>;
  /** Open review item id → status. */
  items: Record<string, string>;
  /** Document path → sha (text kept in src/<sha>.txt for line diffs). */
  docs: Record<string, string>;
}

export function newPackId(now = Date.now()): string {
  return now.toString(36) + randomBytes(2).toString("hex");
}

const hash8 = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 8);

/** The directory holding one root's packs, under a given cache base. */
export function rootDirName(mode: ConnectMode, root: string | null, title: string): string {
  return mode === "global" || !root ? "global" : `${slugify(title)}-${hash8(root)}`;
}

/** FLUX_CONNECT_CACHE / FLUX_CONNECT_FALLBACK override the two bases (tests, unusual machines). */
export function primaryBase(): string {
  return process.env.FLUX_CONNECT_CACHE || path.join(fluxPaths.userDataDir(), "connect");
}

export function fallbackBase(): string {
  if (process.env.FLUX_CONNECT_FALLBACK) return process.env.FLUX_CONNECT_FALLBACK;
  const uid = typeof process.getuid === "function" ? String(process.getuid()) : os.userInfo().username;
  return path.join(os.tmpdir(), `flux-connect-${uid}`);
}

/** Can we create and write in this directory? */
async function writable(dir: string): Promise<boolean> {
  try {
    await fs.mkdir(dir, { recursive: true });
    const probe = path.join(dir, `.probe-${process.pid}-${randomBytes(3).toString("hex")}`);
    await fs.writeFile(probe, "");
    await fs.rm(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

export interface PackLocation {
  /** null = stdout-only: nothing could be written. */
  dir: string | null;
  base: string | null;
  fallback: boolean;
}

/** Choose where a new pack goes: primary, else the tmp fallback, else stdout-only. */
export async function allocatePack(mode: ConnectMode, root: string | null, title: string, packId: string): Promise<PackLocation> {
  const name = rootDirName(mode, root, title);
  for (const [base, fallback] of [[primaryBase(), false], [fallbackBase(), true]] as const) {
    const dir = path.join(base, name, packId);
    if (await writable(dir)) return { dir, base, fallback };
  }
  return { dir: null, base: null, fallback: true };
}

/** The writable folder holding one root's packs (for files beside them, like the ask pack). */
export async function allocateRootDir(mode: ConnectMode, root: string | null, title: string): Promise<string | null> {
  const name = rootDirName(mode, root, title);
  for (const base of [primaryBase(), fallbackBase()]) {
    const dir = path.join(base, name);
    if (await writable(dir)) return dir;
  }
  return null;
}

/** Write a file atomically inside a pack dir. */
export async function writePackFile(dir: string, rel: string, data: string | Uint8Array): Promise<string> {
  const abs = path.join(dir, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.tmp-${process.pid}`;
  await fs.writeFile(tmp, data);
  await fs.rename(tmp, abs);
  return abs;
}

/** Keep the newest PACKS_KEPT packs of this root (pack ids sort by time). */
export async function prunePacks(packDir: string, keep = PACKS_KEPT): Promise<string[]> {
  const rootDir = path.dirname(packDir);
  let names: string[] = [];
  try {
    names = (await fs.readdir(rootDir, { withFileTypes: true })).filter((e) => e.isDirectory() && /^[0-9a-z]+$/.test(e.name)).map((e) => e.name);
  } catch {
    return [];
  }
  const doomed = names.sort(comparePackIds).slice(0, Math.max(0, names.length - keep));
  for (const n of doomed) await fs.rm(path.join(rootDir, n), { recursive: true, force: true });
  return doomed;
}

/** Order pack ids oldest first: base36 time (variable length) then the random tail. */
export function comparePackIds(a: string, b: string): number {
  const t = (id: string) => parseInt(id.slice(0, -4), 36);
  return t(a) - t(b) || a.localeCompare(b);
}

/** Every cache base that may hold packs. */
function bases(): string[] {
  return [primaryBase(), fallbackBase()];
}

/** Find a pack by id in any cache base. */
export async function findPack(packId: string): Promise<{ dir: string; manifest: PackManifest } | null> {
  if (!/^[0-9a-z]{6,}$/.test(packId)) return null;
  for (const base of bases()) {
    let roots: string[] = [];
    try {
      roots = (await fs.readdir(base, { withFileTypes: true })).filter((e) => e.isDirectory() && e.name !== "sessions" && !e.name.startsWith("_")).map((e) => e.name);
    } catch {
      continue;
    }
    for (const r of roots) {
      const dir = path.join(base, r, packId);
      try {
        const manifest = JSON.parse(await fs.readFile(path.join(dir, "pack.json"), "utf8")) as PackManifest;
        if (manifest.packId === packId) return { dir, manifest };
      } catch {
        /* not here */
      }
    }
  }
  return null;
}

/** The newest pack for a root (for "changed since last pack"), in any base. */
export async function latestPack(mode: ConnectMode, root: string | null, title: string): Promise<{ dir: string; manifest: PackManifest } | null> {
  const name = rootDirName(mode, root, title);
  let best: { dir: string; manifest: PackManifest } | null = null;
  for (const base of bases()) {
    let ids: string[] = [];
    try {
      ids = (await fs.readdir(path.join(base, name), { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      continue;
    }
    for (const id of ids.sort(comparePackIds).reverse()) {
      try {
        const dir = path.join(base, name, id);
        const manifest = JSON.parse(await fs.readFile(path.join(dir, "pack.json"), "utf8")) as PackManifest;
        if (!best || comparePackIds(best.manifest.packId, manifest.packId) < 0) best = { dir, manifest };
        break;
      } catch {
        /* incomplete pack: try the next older one */
      }
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// CLI session cursors (the Claude Code hook reads these; §8.8 Delivery 2)
// ---------------------------------------------------------------------------

export interface SessionCursor {
  v: 2;
  key: string;
  root: string;
  title: string;
  packId: string;
  packDir: string;
  /** When the session last looked (connect, or its last --refresh). */
  since: string;
  /** What the session has seen (its own writes are folded in as they happen). */
  state: PackState;
  snapshot: StatSnapshot;
  /** The stat snapshot last reported to this session (the hook's no-change check). */
  notified: StatSnapshot;
}

/** Session keys are vendor ids (uuids, thread ids); anything else is refused. */
export function sessionKeyOk(key: string): boolean {
  return /^[A-Za-z0-9._-]{8,128}$/.test(key);
}

export function sessionsDir(): string {
  return path.join(process.env.FLUX_CONNECT_CACHE || path.join(fluxPaths.userDataDir(), "connect"), "sessions");
}

export function cursorPath(key: string): string {
  return path.join(sessionsDir(), `${key}.json`);
}

export async function readCursor(key: string): Promise<SessionCursor | null> {
  if (!sessionKeyOk(key)) return null;
  try {
    const c = JSON.parse(await fs.readFile(cursorPath(key), "utf8")) as SessionCursor;
    return c.v === 2 ? c : null;
  } catch {
    return null;
  }
}

export async function writeCursor(c: SessionCursor): Promise<void> {
  if (!sessionKeyOk(c.key)) return;
  await fs.mkdir(sessionsDir(), { recursive: true });
  const file = cursorPath(c.key);
  const tmp = `${file}.tmp-${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(c) + "\n");
  await fs.rename(tmp, file);
}
