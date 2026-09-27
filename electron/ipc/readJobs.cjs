"use strict";
const fs=require("node:fs"),path=require("node:path");
/** Native read broker owns only its worker; roots/config remain dynamic getters. */
function createReadJobs({app,appRoot,fluxLibDir,resourcesPath=()=>process.resourcesPath,createService=require("../fulltextService.cjs").createFulltextService}) {
function fluxCliArgs() {
  const bundled = app.isPackaged
    ? path.join(resourcesPath(), "app.asar.unpacked", "dist", "flux-cli.mjs")
    : path.join(appRoot, "dist", "flux-cli.mjs");
  if (fs.existsSync(bundled)) return { appRoot, argv: [bundled] };
  return { appRoot, argv: ["--import", "tsx", "flux-cli.ts"] }; // dev, unbuilt
}

// Full-text search shares the CLI/MCP exact engine in a resident worker so index
// parsing and disk scans never touch the renderer or Electron main event loop.
// Read-only; no fsGuard needed (the child only reads FluxLib). Returns the parsed
// FulltextResult, or { error } — never throws into the renderer.
let fulltextService = null, registered=false, disposed=false;
let fulltextServiceRoot = "";
let paused = 0, drain = Promise.resolve();
const requests = new Map();
const ownerFor = (e, opts) => `${e.sender.id}:${typeof opts.ownerId === "string" && opts.ownerId.length <= 128 ? opts.ownerId : "default"}`;
function registerHandlers(ipc) { if(registered)throw new Error("Read handlers already registered");registered=true;ipc.handle("fulltext:search", async (e, { query, opts = {} }) => {
  if(disposed)throw new Error("Read jobs disposed");
  if(paused)return {error:"Library location is changing; retry shortly",cancelled:true};
  const q = String(query ?? "").trim();
  const owner = ownerFor(e, opts), requestId = typeof opts.requestId === "string" && opts.requestId.length <= 128 ? opts.requestId : "";
  if (!q) { fulltextService?.cancelOwner(owner); requests.delete(owner); return { hits: [], scanned: 0, missingText: [], truncated: false, elapsedMs: 0 }; }
  const root = fs.realpathSync(fluxLibDir());
  if (!fulltextService || fulltextServiceRoot !== root) {
    fulltextService?.dispose();
    const workerFile = path.join(appRoot, "dist", "flux-fulltext-worker.mjs").replace(/app\.asar([/\\])/, "app.asar.unpacked$1");
    fulltextService = createService({ workerFile, root });
    fulltextServiceRoot = root;
  }
  const service = fulltextService;
  const request = {requestId};
  requests.set(owner, request);
  const close = () => { if (requests.get(owner) === request) { service.cancelOwner(owner, "Search window closed"); requests.delete(owner); } };
  e.sender.once("destroyed", close);
  try { return await service.search(owner, q, {keys:opts.keys,limit:opts.limit,diagnostics:opts.diagnostics === true}, progress => {
    if (requests.get(owner) !== request || e.sender.isDestroyed?.()) return;
    try { e.sender.send("fulltext:progress", {requestId,ownerId:opts.ownerId, ...progress}); } catch { /* closing window */ }
  }); }
  finally { e.sender.removeListener("destroyed", close); if (requests.get(owner) === request) requests.delete(owner); }
});
ipc.handle("fulltext:cancel", (e, {requestId, ownerId} = {}) => {
  const owner = ownerFor(e, {ownerId});
  if (requests.get(owner)?.requestId !== requestId || typeof requestId !== "string") return false;
  requests.delete(owner); fulltextService?.cancelOwner(owner, "Search cancelled"); return true;
});
}

  return {fluxCliArgs,registerHandlers,async suspend(){
    paused++;
    const old=fulltextService;fulltextService=null;fulltextServiceRoot="";requests.clear();
    drain=drain.then(()=>old?.dispose());
    await drain;
    let released=false;
    return ()=>{if(!released){released=true;paused--;}};
  },libraryChanged(root,absolutePath){
    if (!fulltextService) return;
    let canonical; try { canonical=fs.realpathSync(root); } catch { return; }
    if (canonical !== fulltextServiceRoot) return;
    const relative=absolutePath == null ? null : path.relative(root,absolutePath);
    if(relative && (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))) return;
    fulltextService.markDirty(relative);
  },dispose(){disposed=true;fulltextService?.dispose();fulltextService=null;fulltextServiceRoot="";requests.clear();}};
}
module.exports={createReadJobs};
