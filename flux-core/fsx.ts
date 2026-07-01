// Durable writes for everything canonical (V1 review, W2). write-tmp + fsync +
// rename means a crash or power-loss mid-write can never truncate the target,
// and no reader (the app, another CLI, a watcher) ever observes a half-written
// file — the rename is atomic on POSIX.
//
// The tmp name is dot-prefixed + `.tmp-<pid>-<seq>` suffixed; the Electron
// watcher ignores this pattern (electron/main.cjs mirrors it for renderer
// writes) so atomic saves don't echo spurious "external change" events.

import { promises as fs } from "node:fs";
import path from "node:path";

let seq = 0;

export function tmpPathFor(p: string): string {
  return path.join(path.dirname(p), `.${path.basename(p)}.tmp-${process.pid}-${++seq}`);
}

/** Matches in-flight atomic-write temp files (shared with the watcher's ignore list). */
export const TMP_WRITE_RE = /(^|[/\\])\.[^/\\]*\.tmp-\d+-\d+$/;

export async function atomicWrite(p: string, data: string | Uint8Array): Promise<void> {
  await fs.mkdir(path.dirname(p), { recursive: true });
  const tmp = tmpPathFor(p);
  const fh = await fs.open(tmp, "w");
  try {
    if (typeof data === "string") await fh.writeFile(data, "utf8");
    else await fh.writeFile(data);
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await fs.rename(tmp, p);
  } catch (e) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw e;
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
