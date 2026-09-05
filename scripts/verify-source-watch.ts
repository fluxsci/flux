// Native exact-file linked-source read/watch contract, without renderer or
// real user directories. Real Electron regeneration is separately gated.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const require = createRequire(import.meta.url);
const { createFileCore } = require("../electron/ipc/files.cjs");
const { createSourceWatchCore, normalizeSourceWatchRequest } = require("../electron/ipc/sourceWatch.cjs");
let checks = 0;
const ok = (value: unknown, message: string) => { assert.ok(value, message); checks++; };
const root = await fs.mkdtemp(path.join(os.tmpdir(), "flux-source-watch-"));
const project = path.join(root, "project"), other = path.join(root, "other"), svg = path.join(root, "external", "chart.svg"), meta = path.join(root, "external", "custom.json");
await fs.mkdir(path.dirname(svg), { recursive: true }); await fs.writeFile(svg, "<svg/>"); await fs.writeFile(meta, "{}");
const sessions = new Map<number, any>(), pending = new Map<number, string>(), events: unknown[] = [], notices: unknown[] = [];
const win = { isDestroyed: () => false, webContents: { send: (...args: unknown[]) => events.push(args) } };
sessions.set(1, { root: project, win }); sessions.set(2, { root: other, win });
const fileCore = createFileCore({ app: { getPath: (name: string) => path.join(root, "app", name) }, roots: () => [project, other], setPendingRoot() {}, dialog: {} });
const handlers = new Map<string, Function>();
fileCore.registerHandlers({ handle: (name: string, callback: Function) => handlers.set(name, callback) });
const call = (name: string, id: number, ...args: unknown[]) => handlers.get(name)!({ sender: { id } }, ...args);
class Watcher extends EventEmitter {
  files = new Set<string>(); closed = false;
  add(files: string[]) { for (const p of files) this.files.add(p); }
  async unwatch(files: string[]) { for (const p of files) this.files.delete(p); }
  async close() { this.closed = true; }
}
const watchers: Watcher[] = [];
let unavailable = false;
const source = createSourceWatchCore({ sessionFor: (e: any) => sessions.get(e.sender.id), pendingRootFor: (id: number) => pending.get(id), fileCore,
  loadChokidar: async () => unavailable ? null : { watch: () => { const w = new Watcher(); watchers.push(w); return w; } },
  notify: (...args: unknown[]) => notices.push(args),
});
source.registerHandlers({ handle: (name: string, callback: Function) => handlers.set(name, callback) });
const request = { root: project, scope: "fig", sources: [{ svgPath: svg, manifestPath: meta }] };
try {
  await assert.rejects(call("fs:readText", 1, svg), /outside/); checks++;
  await assert.rejects(call("fs:exists", 1, svg), /outside/); checks++;
  const normalized = normalizeSourceWatchRequest(request);
  ok(normalized.files.includes(svg.replace(".svg", ".fluxplot.json")) && normalized.files.includes(svg.replace(".svg", ".recipe.json")) && normalized.files.includes(meta), "authored and adjacent sidecars are exact files even before they exist");
  await call("watch:setSourceFiles", 1, request);
  ok(await call("fs:readText", 1, svg) === "<svg/>", "registered source read succeeds");
  ok(await call("fs:readText", 1, meta) === "{}", "authored metadata read succeeds");
  ok(await call("fs:exists", 1, svg.replace(".svg", ".recipe.json")) === false, "absent adjacent sidecar can be probed");
  for (const [name, args] of [["fs:writeText", [svg, "bad"]], ["fs:remove", [svg]], ["fs:readdir", [path.dirname(svg)]], ["fs:readText", [path.join(path.dirname(svg), "unrelated.svg")]], ["fs:exists", [path.join(path.dirname(svg), "unrelated.svg")]]] as const) {
    await assert.rejects(call(name, 1, ...args), /outside/); checks++;
  }
  await assert.rejects(call("fs:readText", 2, svg), /outside/); checks++;
  await assert.rejects(call("fs:exists", 2, svg), /outside/); checks++;
  await assert.rejects(call("watch:setSourceFiles", 2, request), /does not belong/); checks++;
  for (const value of [{ ...request, root: "relative" }, { ...request, scope: "../fig" }, { ...request, sources: [{ svgPath: svg + ".txt" }] }, { ...request, sources: [{ svgPath: svg, manifestPath: meta + ".txt" }] }]) {
    await assert.rejects(call("watch:setSourceFiles", 1, value), /Invalid/); checks++;
  }
  watchers[0].emit("all", "change", path.join(path.dirname(svg), "unrelated.svg"));
  watchers[0].emit("all", "change", svg);
  await new Promise((r) => setTimeout(r, 230));
  ok(events.length === 1 && JSON.stringify(events[0]).includes('"subsystem":"plots"'), "only a registered exact file routes to the normal source refresh event");
  fileCore.noteWrite(svg); watchers[0].emit("all", "change", svg);
  await new Promise((r) => setTimeout(r, 230));
  ok(events.length === 1, "app self-writes do not cause source refresh loops");
  await call("watch:setSourceFiles", 1, { ...request, scope: "slides/deck-a" });
  await call("watch:setSourceFiles", 1, { ...request, sources: [] });
  ok(await call("fs:readText", 1, svg) === "<svg/>" && watchers[0].files.has(svg), "removing Figure scope retains the active deck's source capability");
  await call("watch:setSourceFiles", 1, { ...request, scope: "slides/deck-a", sources: [] });
  await assert.rejects(call("fs:readText", 1, svg), /outside/); checks++;
  await assert.rejects(call("fs:exists", 1, svg), /outside/); checks++;
  ok(!watchers[0].files.has(svg), "last scoped link removes watch");
  pending.set(1, other);
  await call("watch:setSourceFiles", 1, { ...request, root: other });
  fileCore.clearApprovals(1); sessions.get(1).root = other; pending.delete(1); await source.setRoot(1, other);
  ok(await call("fs:readText", 1, svg) === "<svg/>", "pending project links survive same-project watchRoot promotion");
  await source.setRoot(1, null);
  await assert.rejects(call("fs:readText", 1, svg), /outside/); checks++;
  ok(watchers.every((w) => w.closed), "project exit closes all outgoing watchers");
  unavailable = true;
  await assert.rejects(call("watch:setSourceFiles", 1, { ...request, root: other }), /unavailable/); checks++;
  unavailable = false;
  await call("watch:setSourceFiles", 1, { ...request, root: other });
  ok(watchers.at(-1)!.files.has(svg), "watch creation retries all files after unavailable native watcher");
  console.log(`SOURCE WATCH: PASS (${checks} meaningful assertions)`);
} finally { await source.clearAll(); await fs.rm(root, { recursive: true, force: true }); }
