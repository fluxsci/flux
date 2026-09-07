import { fileBridge } from "../project/types";

type Entry = { users: Set<(url: string) => void>; url: string; bytes: number; pending: boolean };
/** View-local, bounded thumbnail IO. Images render as <img>, never inline SVG
 * DOM. Offscreen work is skipped; cached blobs are released on eviction/close. */
export function createGalleryPreviews() {
  const entries = new Map<string, Entry>();
  const queue: { path: string; entry: Entry }[] = [];
  let active = 0, disposed = false;
  function trim() {
    let bytes = [...entries.values()].reduce((n, e) => n + e.bytes, 0);
    for (const [path, e] of entries) {
      if (entries.size <= 80 && bytes <= 32 * 1024 * 1024) break;
      if (e.users.size || e.pending) continue;
      URL.revokeObjectURL(e.url); bytes -= e.bytes; entries.delete(path);
    }
  }
  function pump() {
    while (!disposed && active < 4 && queue.length) {
      const { path, entry } = queue.shift()!;
      if (!entry.users.size) { entries.delete(path); continue; }
      active++;
      void (async () => {
        try {
          const fb = fileBridge();
          if (!fb) throw new Error("No file bridge");
          const stat = await fb.stat?.(path);
          if (stat && stat.size > 24 * 1024 * 1024) throw new Error("Preview too large");
          const bytes = await fb.readFile(path);
          if (disposed) return;
          entry.bytes = bytes.byteLength;
          entry.url = URL.createObjectURL(new Blob([bytes], { type: /\.svg$/i.test(path) ? "image/svg+xml" : "image/png" }));
        } catch { /* A broken/oversized preview is explicit; the file stays insertable. */ }
        finally {
          entry.pending = false; active--;
          if (!disposed) { for (const cb of entry.users) cb(entry.url); trim(); pump(); }
        }
      })();
    }
  }
  return {
    acquire(path: string, cb: (url: string) => void) {
      let e = entries.get(path);
      if (!e) {
        e = { users: new Set(), url: "", bytes: 0, pending: true };
        entries.set(path, e); queue.push({ path, entry: e });
      } else { entries.delete(path); entries.set(path, e); }
      e.users.add(cb);
      if (!e.pending) cb(e.url);
      pump();
      return () => { e!.users.delete(cb); trim(); };
    },
    dispose() {
      disposed = true; queue.length = 0;
      for (const e of entries.values()) URL.revokeObjectURL(e.url);
      entries.clear();
    },
  };
}
