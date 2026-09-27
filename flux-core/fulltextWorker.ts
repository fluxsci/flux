// Resident Node worker. The existing index's resident cache stays outside main.
import { parentPort, workerData } from "node:worker_threads";
import { searchFulltext } from "./fulltextSearch";
import { createFulltextRefreshState, loadFreshFulltextIndex, markFulltextDirty } from "./fulltextIndex";
if (!parentPort || typeof workerData?.root !== "string") throw new Error("Missing fulltext worker owner");
const refresh = createFulltextRefreshState();
let chain: Promise<void> = Promise.resolve(), pending = 0;
parentPort.on("message", ({ kind, id, query, opts, path }) => {
  if (kind === "dirty") { markFulltextDirty(refresh, typeof path === "string" ? path : null); return; }
  pending++;
  chain = chain.then(async () => {
    try {
      let sentAt = 0;
      const result = await searchFulltext(query, { ...opts, libPath: workerData.root, refresh, onProgress(progress) {
        if (Date.now() - sentAt >= 100 || progress.completed === progress.total) {
          sentAt = Date.now();
          parentPort!.postMessage({ kind: "progress", id, progress });
        }
      } });
      parentPort!.postMessage({ kind: "result", id, result: opts?.diagnostics ? {...result, diagnostics: process.memoryUsage(), refresh: {checked:refresh.lastChecked,items:refresh.dirs?.length ?? 0,integrityBatch:refresh.integrityBatch}} : result });
    } catch (error) {
      refresh.full = true;
      parentPort!.postMessage({ kind: "result", id, error: String(error instanceof Error ? error.message : error) });
    } finally { pending--; }
  });
});

// Repair missed filesystem events in bounded idle slices. On a 5,000-item
// library a complete rotation is 40 passes; foreground requests also advance
// it. No query waits for a full-tree stat sweep after initial discovery.
const integrity = setInterval(() => {
  if (pending || !refresh.dirs) return;
  pending++;
  chain = chain.then(async () => {
    try { await loadFreshFulltextIndex(workerData.root, { refresh }); }
    catch { refresh.full = true; }
    finally { pending--; }
  });
}, 2000);
integrity.unref();
