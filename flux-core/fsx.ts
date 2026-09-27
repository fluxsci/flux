// Durable writes for everything canonical (V1 review, W2). write-tmp + fsync +
// rename means a crash or power-loss mid-write can never truncate the target,
// and no reader (the app, another CLI, a watcher) ever observes a half-written
// file — the rename is atomic on POSIX.
//
// The tmp name is dot-prefixed + `.tmp-<pid>-<seq>` suffixed; the Electron
// watcher ignores this pattern (electron/main.cjs mirrors it for renderer
// writes) so atomic saves don't echo spurious "external change" events.

import { promises as fs } from "node:fs";
import { shareRetry } from "../electron/fsRetry.cjs";
import path from "node:path";

let seq = 0;

export function tmpPathFor(p: string): string {
  return path.join(path.dirname(p), `.${path.basename(p)}.tmp-${process.pid}-${++seq}`);
}

/** Matches in-flight atomic-write temp files (shared with the watcher's ignore list). */
export const TMP_WRITE_RE = /(^|[/\\])\.[^/\\]*\.tmp-\d+-\d+$/;

export async function atomicWrite(p: string, data: string | Uint8Array, createOnly = false, mode = 0o666): Promise<void> {
  await fs.mkdir(path.dirname(p), { recursive: true });
  const tmp = tmpPathFor(p);
  let fh: import("node:fs/promises").FileHandle | undefined;
  try {
    fh = await fs.open(tmp, "wx", mode);
    if (typeof data === "string") await fh.writeFile(data, "utf8");
    else await fh.writeFile(data);
    await fh.sync();
    await fh.close(); fh = undefined;
    // On Windows the destination may be held open for a moment by whatever
    // read the previous version (a scanner, an indexer), and the replace comes
    // back EPERM — a moment to wait out, not a refusal. Without this a save
    // failed outright and the user saw "Couldn't save figures" (2026-09-22).
    if (createOnly) { await shareRetry(() => fs.link(tmp, p)); await shareRetry(() => fs.unlink(tmp)); }
    else await shareRetry(() => fs.rename(tmp, p));
  } finally {
    await fh?.close().catch(() => {});
    await shareRetry(() => fs.rm(tmp, {force: true})).catch(() => {});
  }
}

/** WS-5.3: fsync a DIRECTORY after a rename-into-place batch — atomicWrite
 *  fsyncs the FILE, but on Linux/mac the rename's directory entry needs its
 *  own fsync to survive a crash. Unsupported filesystem operations are tolerated;
 *  I/O and missing-directory errors must reach the writer. No-op on win32. */
export async function fsyncDir(dir: string): Promise<void> {
  if (process.platform === "win32") return;
  let fh: import("node:fs/promises").FileHandle | undefined;
  try {
    fh = await fs.open(dir, "r");
    await fh.sync();
  } catch (error) {
    if (!["EINVAL", "ENOTSUP", "EOPNOTSUPP"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
  } finally {
    await fh?.close().catch(() => {});
  }
}

/** Quarantine an unparseable derived file as `<name>.corrupt-<ts>` instead of
 *  silently starting empty; returns the quarantine path (or null if it vanished). */
export async function quarantineCorrupt(p: string): Promise<string | null> {
  const dest = `${p}.corrupt-${Date.now()}`;
  try {
    await fs.rename(p, dest);
    return dest;
  } catch {
    return null;
  }
}
