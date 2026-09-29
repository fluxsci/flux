import { fileBridge } from "../project/types";

type Entry = { users: Set<(url: string) => void>; url: string; bytes: number; pending: boolean; cancel: AbortController };
/** View-local, bounded thumbnail IO. Images render as <img>, never inline SVG
 * DOM. Offscreen work is skipped; cached blobs are released on eviction/close. */
export function createGalleryPreviews() {
  const entries = new Map<string, Entry>();
  const metadata = new Map<string, { users: Set<(semantic: boolean) => void>; value?: boolean; final?: boolean }>();
  function publishMetadata(path: string, semantic: boolean) {
    const entry = metadata.get(path) ?? { users: new Set<(semantic: boolean) => void>() };
    entry.value = semantic; entry.final = semantic; metadata.set(path, entry);
    for (const cb of entry.users) cb(semantic);
  }
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
      if (!entry.users.size) { if (entries.get(path) === entry) entries.delete(path); continue; }
      active++;
      void (async () => {
        try {
          const fb = fileBridge();
          if (!fb) throw new Error("No file bridge");
          if (/\.glb$/i.test(path)) {
            const { model3dGalleryPreview } = await import('../model3d/galleryPreview');
            const preview = await model3dGalleryPreview(path, 256, entry.cancel.signal);
            if (disposed) return;
            entry.url = preview.url; entry.bytes = preview.url.length; publishMetadata(path, preview.semantic); return;
          }
          if (/\.(mp4|mov)$/i.test(path)) {
            if (!fb.videoPreview) throw new Error("Video previews require the desktop app");
            const preview = await fb.videoPreview(path);
            if (disposed) return;
            entry.url = preview.poster;
            entry.bytes = preview.poster.length;
            return;
          }
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
    acquireMetadata(path: string, cb: (semantic: boolean) => void) {
      let entry = metadata.get(path);
      if (!entry) {
        entry = { users: new Set() }; metadata.set(path, entry);
        const current = entry;
        void (async () => {
          let semantic = false;
          try {
            const fb = fileBridge(), sibling = path.replace(/\.glb$/i, '.fluxplot.json');
            if (fb && await fb.exists(sibling)) {
              const limit = 4 * 1024 * 1024, stat = await fb.stat?.(sibling);
              if (!stat || stat.size <= limit) {
                const bounded = await fb.readTextBounded?.(sibling, limit + 1);
                const text = bounded ? bounded.text : await fb.readText(sibling);
                const { parseScene3d } = await import('../model3d/scene3d');
                semantic = text.length <= limit && !('issue' in parseScene3d(text));
              }
            }
          } catch { /* Plain-mesh styling also covers unreadable metadata. */ }
          if (disposed || metadata.get(path) !== current) return;
          current.value = current.final ?? semantic;
          for (const user of current.users) user(current.value);
        })();
      }
      entry.users.add(cb); if (entry.value !== undefined) cb(entry.value);
      return () => { entry!.users.delete(cb); if (metadata.size > 80 && !entry!.users.size) metadata.delete(path); };
    },
    acquire(path: string, cb: (url: string) => void) {
      let e = entries.get(path);
      if (!e || e.cancel.signal.aborted) {
        e = { users: new Set(), url: "", bytes: 0, pending: true, cancel: new AbortController() };
        entries.set(path, e); queue.push({ path, entry: e });
      } else { entries.delete(path); entries.set(path, e); }
      e.users.add(cb);
      if (!e.pending) cb(e.url);
      pump();
      return () => { e!.users.delete(cb); if (/\.glb$/i.test(path) && !e!.users.size && e!.pending) e!.cancel.abort(); trim(); };
    },
    dispose() {
      disposed = true; queue.length = 0;
      for (const e of entries.values()) { e.cancel.abort(); URL.revokeObjectURL(e.url); }
      entries.clear(); metadata.clear();
    },
  };
}
