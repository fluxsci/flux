"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { Readable } = require("node:stream");
const { randomBytes } = require("node:crypto");
const media = require("../videoMedia.cjs");

function createVideoMediaCore({ app, protocol, rootFor, fsReadGuard, noteWrite }) {
  const tokens = new Map(), owners = new Map(), jobs = new Map(), previewCache = new Map(), preparedAssets = new Map();
  const encoder = () => app.isPackaged ? path.join(process.resourcesPath, "video-encoder", process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg") : media.encoderPath();
  async function discardIfUnsaved(item) {
    try {
      const raw = JSON.parse(await fs.promises.readFile(path.join(item.root, "slides", item.deckId, "deck.json"), "utf8"));
      if (raw.assets?.some(a => a.id === item.prepared.asset.id)) return false;
      await media.cleanupPrepared(item.root, item.deckId, item.prepared); return true;
    } catch { return false; } // Unreadable saved state must never license deletion.
  }
  function owner(e) {
    let current = owners.get(e.sender.id);
    if (!current) {
      current = { sender: e.sender, root: () => rootFor(e), previews: new Set() }; owners.set(e.sender.id, current);
      e.sender.once("destroyed", () => {
        for (const [token, item] of tokens) if (item.owner === current) tokens.delete(token);
        for (const job of jobs.values()) if (job.owner === current) job.controller.abort();
        for (const controller of current.previews) controller.abort();
        owners.delete(e.sender.id);
        for (const [id, item] of preparedAssets) if (item.owner === current) { void discardIfUnsaved(item); preparedAssets.delete(id); }
      });
    }
    const root = rootFor(e);
    for (const [token, item] of tokens) if (item.owner === current && item.root !== root) tokens.delete(token);
    for (const [id, item] of preparedAssets) if (item.owner === current && item.root !== root) { void discardIfUnsaved(item); preparedAssets.delete(id); }
    return current;
  }
  async function localUrl(e, root, relative) {
    if (!root || rootFor(e) !== root || !/^slides\/[a-zA-Z0-9_-][a-zA-Z0-9_.-]*\/assets\/[^/]+\.mp4$/i.test(relative)) throw new Error("Invalid project video asset");
    fsReadGuard(path.join(root, relative), e.sender.id);
    const absolute = await media.projectFile(root, relative);
    const current = owner(e);
    for (const [token, item] of tokens) if (item.owner === current && item.root === root && item.absolute === absolute) return `flux-media://video/${token}`;
    const token = randomBytes(24).toString("hex"); tokens.set(token, { owner: current, root, relative, absolute });
    return `flux-media://video/${token}`;
  }
  async function galleryUrl(e, root, absolutePath) {
    if (!root || rootFor(e) !== root || typeof absolutePath !== "string" || !/\.(mp4|mov)$/i.test(absolutePath) || !media.contained(path.join(root, "plots"), absolutePath)) throw new Error("Choose a video inside this project's plots folder");
    fsReadGuard(absolutePath, e.sender.id);
    const relative = path.relative(root, absolutePath).split(path.sep).join("/");
    const absolute = await media.projectFile(root, relative);
    // Every opened preview owns one disposable capability. Releasing one preview
    // can never revoke the same source in another live preview or a saved slide.
    const current = owner(e), token = randomBytes(24).toString("hex");
    if (current.root() !== root) throw new Error("The project changed while opening the video");
    tokens.set(token, { owner: current, root, relative, absolute, gallery: true, mime: /\.mov$/i.test(absolutePath) ? "video/quicktime" : "video/mp4" });
    return `flux-media://video/${token}`;
  }
  app.whenReady().then(() => protocol.handle("flux-media", async request => {
    try {
      const url = new URL(request.url), item = tokens.get(url.pathname.slice(1));
      if (url.hostname !== "video" || url.search || !item || item.owner.sender.isDestroyed() || item.owner.root() !== item.root) return new Response("Unavailable video", { status: 403 });
      if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405 });
      // Check realpath again: replacing an accepted asset with an outside symlink
      // must not expand an existing capability into arbitrary filesystem access.
      const absolute = await media.projectFile(item.root, item.relative);
      if (absolute !== item.absolute) return new Response(null, { status: 403 });
      const stat = await fs.promises.stat(absolute);
      if (!stat.isFile()) return new Response(null, { status: 404 });
      const range = media.byteRange(request.headers.get("range"), stat.size);
      const headers = { "Content-Type": item.mime || "video/mp4", "Access-Control-Allow-Origin": "*", "Accept-Ranges": "bytes", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
      if (!range) return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${stat.size}` } });
      headers["Content-Length"] = String(range.end - range.start + 1);
      if (range.partial) headers["Content-Range"] = `bytes ${range.start}-${range.end}/${stat.size}`;
      const body = request.method === "HEAD" ? null : Readable.toWeb(fs.createReadStream(absolute, { start: range.start, end: range.end }));
      return new Response(body, { status: range.partial ? 206 : 200, headers });
    } catch { return new Response("Unavailable video", { status: 404 }); }
  }));
  function registerHandlers(ipcMain) {
    ipcMain.handle("slides:copyVideoAssets", async (e, request) => {
      const root = rootFor(e);
      const checkCurrent = () => { if (!root || request?.root !== root || e.sender.isDestroyed() || rootFor(e) !== root) throw new Error("The project changed while copying video assets"); };
      checkCurrent();
      // Both ends are constrained by the shared copier to deck-owned files
      // within this requesting window's current project.
      await media.copyVideoAssets({ root, sourceDeckId: request?.sourceDeckId, deckId: request?.deckId, paths: request?.paths, checkCurrent });
      for (const relative of request.paths) noteWrite(path.join(root, "slides", request.deckId, relative));
    });
    ipcMain.handle("slides:videoMediaUrl", (e, request) => localUrl(e, request?.root, request?.path));
    ipcMain.handle("gallery:videoUrl", (e, request) => galleryUrl(e, request?.root, request?.path));
    ipcMain.handle("gallery:releaseVideoUrl", (e, url) => {
      if (typeof url !== "string" || !/^flux-media:\/\/video\/[a-f0-9]{48}$/.test(url)) return;
      const token = url.slice(url.lastIndexOf("/") + 1), item = tokens.get(token);
      if (item?.gallery && item.owner === owner(e)) tokens.delete(token);
    });
    ipcMain.handle("slides:videoPreview", async (e, absolute) => {
      const root = rootFor(e);
      if (!root || typeof absolute !== "string" || !media.contained(path.join(root, "plots"), absolute)) throw new Error("Choose a video inside this project's plots folder");
      fsReadGuard(absolute, e.sender.id);
      const relative = path.relative(root, absolute).split(path.sep).join("/"), source = await media.projectFile(root, relative);
      const stat = await fs.promises.stat(source), key = `${source}\0${stat.size}\0${stat.mtimeMs}`;
      const cached = previewCache.get(key); if (cached) return cached;
      const current = owner(e), controller = new AbortController(); current.previews.add(controller);
      try {
        const result = await media.videoPreview(source, { encoder: encoder(), signal: controller.signal });
        if (rootFor(e) !== root) throw new Error("The project changed while reading the video");
        previewCache.set(key, result); while (previewCache.size > 64) previewCache.delete(previewCache.keys().next().value);
        return result;
      } finally { current.previews.delete(controller); }
    });
    ipcMain.handle("slides:cancelVideoImport", (e, id) => { const job = jobs.get(e.sender.id); if (job?.id === id) job.controller.abort(); });
    ipcMain.handle("slides:discardVideoImport", async (e, request) => {
      const item = preparedAssets.get(request?.assetId);
      if (!item || item.owner !== owner(e) || item.root !== request?.root || item.deckId !== request?.deckId) throw new Error("Unknown prepared video import");
      // Once referenced by a saved deck, the file belongs to that document and
      // an old UI callback can no longer discard it.
      const raw = JSON.parse(await fs.promises.readFile(path.join(item.root, "slides", item.deckId, "deck.json"), "utf8"));
      if (raw.assets?.some(a => a.id === request.assetId)) throw new Error("This video is already saved in the deck");
      await media.cleanupPrepared(item.root, item.deckId, item.prepared); preparedAssets.delete(request.assetId);
    });
    ipcMain.handle("slides:prepareVideo", async (e, request) => {
      const root = rootFor(e);
      if (!root || request?.root !== root || !media.safeId(request?.deckId) || !media.safeId(request?.jobId) || typeof request?.path !== "string" || !media.contained(path.join(root, "plots"), request.path)) throw new Error("Invalid video import request");
      if (jobs.has(e.sender.id)) throw new Error("A video is already being imported in this window");
      const current = owner(e), job = { id: request.jobId, owner: current, controller: new AbortController() }; jobs.set(e.sender.id, job);
      const notify = progress => {
        if (rootFor(e) !== root || e.sender.isDestroyed()) job.controller.abort();
        if (!e.sender.isDestroyed()) e.sender.send("slides:videoImportProgress", { jobId: job.id, ...progress });
      };
      try {
        notify({ phase: "preparing", percent: 0 });
        const sourcePath = path.relative(root, request.path).split(path.sep).join("/"); fsReadGuard(request.path, e.sender.id);
        const prepared = await media.prepareVideo({ root, deckId: request.deckId, sourcePath, encoder: encoder(), signal: job.controller.signal, onProgress: notify });
        for (const a of [prepared.asset, prepared.posterAsset]) noteWrite(path.join(root, "slides", request.deckId, a.path));
        try {
          const url = await localUrl(e, root, `slides/${request.deckId}/${prepared.asset.path}`);
          if (job.controller.signal.aborted || rootFor(e) !== root) throw new Error("Video import cancelled");
          // Cleanup needs metadata only; retaining every full poster here would
          // make repeated imports grow main-process memory for the whole session.
          preparedAssets.set(prepared.asset.id, { owner: current, root, deckId: request.deckId, prepared: { asset: prepared.asset, posterAsset: prepared.posterAsset } });
          return { ...prepared, url };
        } catch (error) { await media.cleanupPrepared(root, request.deckId, prepared); throw error; }
      } finally { jobs.delete(e.sender.id); }
    });
  }
  return { registerHandlers, cancelAll: () => { for (const job of jobs.values()) job.controller.abort(); for (const current of owners.values()) for (const c of current.previews) c.abort(); } };
}
module.exports = { createVideoMediaCore };
