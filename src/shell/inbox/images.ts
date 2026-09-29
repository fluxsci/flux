import { fileBridge, joinPath } from "../../lib/project/types";

/** Only mounted rows request images, with four concurrent reads and owned URLs. */
export function inboxImages(root: string) {
  const cache = new Map<string, { refs: number; promise: Promise<string>; url?: string }>();
  const queue: (() => void)[] = [];
  let active = 0, disposed = false;
  function drain() { while (!disposed && active < 4 && queue.length) queue.shift()!(); }
  function acquire(rel: string) {
    if (!/^\.meta\/feedback\/[^/\\]+\.png$/.test(rel) || rel.includes("..")) return Promise.reject<string>(new Error("Invalid annotation image path"));
    let entry = cache.get(rel);
    if (!entry) {
      const promise = new Promise<string>((resolve, reject) => {
        queue.push(() => {
          active++;
          void (async () => {
            try {
              const bytes = await fileBridge()?.readFile(joinPath(root, rel));
              if (disposed || !bytes) throw new Error("Image unavailable");
              const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: "image/png" }));
              const current = cache.get(rel);
              if (current) current.url = url;
              resolve(url);
            } catch (e) { reject(e); }
            finally { active--; drain(); }
          })();
        });
      });
      entry = { refs: 0, promise }; cache.set(rel, entry); drain();
    }
    entry.refs++;
    return entry.promise;
  }
  function release(rel: string) {
    const entry = cache.get(rel);
    if (!entry || --entry.refs > 0) return;
    void entry.promise.then(url => {
      if (!entry.refs) { URL.revokeObjectURL(url); if (cache.get(rel) === entry) cache.delete(rel); }
    }).catch(() => { if (cache.get(rel) === entry) cache.delete(rel); });
  }
  return {
    bind(node: HTMLImageElement, rel: string) {
      let live = true;
      void acquire(rel).then(url => { if (live) node.src = url; }).catch(() => { if (live) node.alt = "Picture unavailable"; });
      return { destroy() { live = false; release(rel); } };
    },
    dispose() { disposed = true; for (const entry of cache.values()) if (entry.url) URL.revokeObjectURL(entry.url); cache.clear(); queue.length = 0; },
  };
}
