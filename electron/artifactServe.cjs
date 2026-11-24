"use strict";
// Artifacts, the Node side: find them in a folder and serve their files. One implementation for
// the desktop app (ipc/artifacts.cjs puts it behind the flux-artifact: protocol) and for the dev
// server's route (scripts/lib/artifactDevRoutes.mjs), so the dev fixture and the GUI gate read
// the same listings and bytes the app does. Every rule (what an artifact is, which paths may be
// served, the page policy, the bridge) lives in artifactRules.js; this file only does the IO.
const fs = require("node:fs");
const fsp = fs.promises;
const path = require("node:path");
const { createHash } = require("node:crypto");
const { pathToFileURL } = require("node:url");

let rulesPromise;
const loadRules = () => (rulesPromise ??= import(pathToFileURL(path.join(__dirname, "artifactRules.js")).href));

const contained = (root, absolute) => {
  const relative = path.relative(root, absolute);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
const toPosix = (p) => p.split(path.sep).join("/");
/** A root's id is its real folder, hashed: the same folder is the same origin in every session,
 *  so what a page keeps in its own storage is still there tomorrow. */
const rootIdOf = (realDir) => "r" + createHash("sha256").update(realDir).digest("hex").slice(0, 30);

async function readHead(file, bytes) {
  const handle = await fsp.open(file, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally { await handle.close(); }
}

/**
 * Every artifact below `dir`, in the order the rail shows them (folders' contents by name).
 * Never throws for an ordinary folder problem: a missing folder is `missing`, an unreadable one
 * is skipped, and a folder too large to read in full says `truncated`.
 */
async function listArtifacts(dir) {
  const rules = await loadRules();
  const { ARTIFACT_LIMITS: LIMITS } = rules;
  let real;
  try {
    real = await fsp.realpath(dir);
    if (!(await fsp.stat(real)).isDirectory()) return { artifacts: [], missing: true, truncated: false, dirs: 0 };
  } catch { return { artifacts: [], missing: true, truncated: false, dirs: 0 }; }
  const artifacts = [];
  let dirs = 0, truncated = false;
  const titleOf = async (file, fallbackName) => {
    try { return rules.htmlTitle((await readHead(file, LIMITS.head)).toString("utf8")) || rules.artifactNameTitle(fallbackName); }
    catch { return rules.artifactNameTitle(fallbackName); }
  };
  const newest = async (files) => {
    let ms = 0;
    for (const file of files.slice(0, 64)) { try { ms = Math.max(ms, (await fsp.stat(file)).mtimeMs); } catch { /* gone since the listing */ } }
    return ms;
  };
  async function walk(abs, rel, depth) {
    if (artifacts.length >= LIMITS.artifacts || dirs >= LIMITS.dirs) { truncated = true; return; }
    dirs++;
    let entries;
    try { entries = await fsp.readdir(abs, { withFileTypes: true }); } catch { return; }
    const names = [];
    for (const e of entries) {
      let dir = e.isDirectory();
      // A link is what it points at, when that is inside this root (the server refuses the rest).
      if (e.isSymbolicLink()) {
        try {
          const target = await fsp.realpath(path.join(abs, e.name));
          if (!contained(real, target)) continue;
          dir = (await fsp.stat(target)).isDirectory();
        } catch { continue; }
      } else if (!dir && !e.isFile()) continue;
      names.push({ name: e.name, dir });
    }
    const found = rules.classifyArtifactFolder(names);
    const group = rel;
    if (found.kind === "artifact") {
      const name = rel ? rel.slice(rel.lastIndexOf("/") + 1) : path.basename(real);
      artifacts.push({
        rel, kind: "folder", group: rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "",
        entry: rel ? `${rel}/${found.entry}` : found.entry,
        pages: found.pages.map((p) => (rel ? `${rel}/${p}` : p)),
        title: await titleOf(path.join(abs, found.entry), name),
        mtimeMs: await newest(names.filter((n) => !n.dir).map((n) => path.join(abs, n.name))),
        dir: abs,
      });
      return;
    }
    for (const file of found.files) {
      if (artifacts.length >= LIMITS.artifacts) { truncated = true; return; }
      const fileRel = rel ? `${rel}/${file}` : file;
      artifacts.push({
        rel: fileRel, kind: "file", group, entry: fileRel, pages: [fileRel],
        title: await titleOf(path.join(abs, file), file), mtimeMs: await newest([path.join(abs, file)]), dir: abs,
      });
    }
    if (depth >= LIMITS.depth) { if (found.dirs.length) truncated = true; return; }
    for (const name of found.dirs) await walk(path.join(abs, name), rel ? `${rel}/${name}` : name, depth + 1);
  }
  await walk(real, "", 0);
  return { artifacts, missing: false, truncated, dirs };
}

function byteRange(header, size) {
  if (!header) return { start: 0, end: Math.max(0, size - 1), partial: false };
  const m = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!m || (!m[1] && !m[2]) || size <= 0) return null;
  const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
  const end = m[1] && m[2] ? Math.min(size - 1, Number(m[2])) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= size) return null;
  return { start, end, partial: true };
}

/**
 * A set of registered roots and the one function that answers a request for a file in them.
 * `respond` returns { status, headers, body } where body is null, a Buffer, or
 * { file, start, end } for the caller to stream (Electron and Node's http stream differently).
 */
function createArtifactServer() {
  const roots = new Map(); // id -> { dir, real, network }
  async function register(dir, { network = false } = {}) {
    let real;
    try {
      real = await fsp.realpath(path.resolve(dir));
      if (!(await fsp.stat(real)).isDirectory()) return null;
    } catch { return null; }
    const id = rootIdOf(real);
    roots.set(id, { dir: path.resolve(dir), real, network: !!network });
    return { id, real };
  }
  const rootOf = (id) => roots.get(id) ?? null;
  /** The file a served path names, or null: for callers that reveal or open what a page shows. */
  async function fileFor(id, rel) {
    const root = roots.get(id);
    if (!root || typeof rel !== "string") return null;
    const { artifactRequestRel, artifactUrlPath } = await loadRules();
    const safe = artifactRequestRel(artifactUrlPath(rel));
    if (!safe) return null;
    try {
      const real = await fsp.realpath(path.join(root.real, ...safe.split("/")));
      return contained(root.real, real) ? real : null;
    } catch { return null; }
  }
  async function respond({ id, pathname, method = "GET", range = null }) {
    const rules = await loadRules();
    const root = roots.get(id);
    const base = { "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };
    const text = (status, message) => ({ status, headers: { ...base, "Content-Type": "text/plain; charset=utf-8" }, body: Buffer.from(message) });
    if (!root) return text(403, "This artifact folder is not open in Flux.");
    if (method !== "GET" && method !== "HEAD") return { status: 405, headers: base, body: null };
    if (pathname === rules.ARTIFACT_BRIDGE_PATH) {
      const body = Buffer.from(rules.artifactBridgeSource());
      return { status: 200, headers: { ...base, "Content-Type": "text/javascript; charset=utf-8", "Content-Length": String(body.length) }, body: method === "HEAD" ? null : body };
    }
    const rel = rules.artifactRequestRel(pathname);
    if (!rel) return text(403, "This path cannot be served.");
    let real, stat;
    try {
      // The real path, every time: a file swapped for a link that leaves the folder is refused.
      real = await fsp.realpath(path.join(root.real, ...rel.split("/")));
      if (!contained(root.real, real)) return text(403, "This file is outside the artifact folder.");
      stat = await fsp.stat(real);
      if (stat.isDirectory()) {
        real = path.join(real, "index.html");
        stat = await fsp.stat(real);
      }
      if (!stat.isFile()) return text(404, "Not found.");
    } catch { return text(404, "Not found."); }
    const type = rules.artifactMime(toPosix(real));
    const headers = { ...base, "Content-Type": type, "Accept-Ranges": "bytes" };
    if (type.startsWith("text/html")) {
      // The page gets its policy and, as its first script, the bridge. Only the head of the file
      // is read to place it: the rest (a page can carry megabytes of data) is streamed as it is.
      headers["Content-Security-Policy"] = rules.artifactCsp({ network: root.network });
      delete headers["Accept-Ranges"];
      const head = await readHead(real, Math.min(stat.size, rules.ARTIFACT_LIMITS.head));
      const at = rules.bridgeInsertIndex(head.toString("latin1"));
      const prefix = Buffer.concat([head.subarray(0, at), Buffer.from(rules.ARTIFACT_BRIDGE_TAG), head.subarray(at)]);
      headers["Content-Length"] = String(prefix.length + stat.size - head.length);
      if (method === "HEAD") return { status: 200, headers, body: null, file: real };
      return { status: 200, headers, file: real, body: stat.size > head.length ? { prefix, file: real, start: head.length, end: stat.size - 1 } : prefix };
    }
    if (stat.size === 0) return { status: 200, headers: { ...headers, "Content-Length": "0" }, body: null, file: real };
    const r = byteRange(range, stat.size);
    if (!r) return { status: 416, headers: { ...headers, "Content-Range": `bytes */${stat.size}` }, body: null };
    headers["Content-Length"] = String(r.end - r.start + 1);
    if (r.partial) headers["Content-Range"] = `bytes ${r.start}-${r.end}/${stat.size}`;
    return { status: r.partial ? 206 : 200, headers, file: real, body: method === "HEAD" ? null : { file: real, start: r.start, end: r.end } };
  }
  return { register, rootOf, fileFor, respond, roots };
}

/**
 * One artifact folder as the renderer sees it: registered with the server, its artifacts listed
 * with the URL of every page. null for a project's own artifacts/ folder that does not exist
 * (nothing to say); a LINKED folder that is gone is still returned, as `missing`.
 * @param {{ dir: string, linked: boolean, projectRoot: string, urlBase: (id: string) => string, networkFor?: (real: string) => boolean, watchDirCap?: number }} options
 */
async function describeRoot(server, { dir, linked, projectRoot, urlBase, networkFor = () => false, watchDirCap = Infinity }) {
  const { artifactUrlPath } = await loadRules();
  const found = await listArtifacts(dir);
  if (found.missing && !linked) return null;
  const registered = found.missing ? null : await server.register(dir);
  const real = registered?.real ?? path.resolve(dir);
  const network = !!registered && !!networkFor(real);
  if (registered) server.rootOf(registered.id).network = network;
  const base = registered ? urlBase(registered.id) : "";
  const root = path.resolve(projectRoot);
  return {
    id: registered?.id ?? "", dir: real, linked, label: linked ? path.basename(real) : "Project",
    missing: found.missing, truncated: found.truncated, network, watching: !!registered && found.dirs <= watchDirCap,
    artifacts: found.artifacts.map((a) => {
      const file = path.join(real, ...a.entry.split("/"));
      return {
        id: `${registered.id}:${a.rel}`, rootId: registered.id, rel: a.rel, kind: a.kind, group: a.group, title: a.title, mtimeMs: a.mtimeMs,
        dir: a.dir, entry: a.entry, pages: a.pages.map((rel) => ({ rel, name: rel.slice(rel.lastIndexOf("/") + 1), url: base + artifactUrlPath(rel), path: path.join(real, ...rel.split("/")) })),
        // What an agent is told: a project path when the page is in the project, else where it is on disk.
        ref: file.startsWith(root + path.sep) ? toPosix(path.relative(root, file)) : file,
      };
    }),
  };
}

/** A response body as one Node stream (the dev route pipes it; Electron wraps it for the web). */
function bodyStream(body) {
  const { Readable } = require("node:stream");
  if (!body) return null;
  if (Buffer.isBuffer(body)) return Readable.from([body]);
  const file = fs.createReadStream(body.file, { start: body.start, end: body.end });
  if (!body.prefix) return file;
  return Readable.from((async function* () { yield body.prefix; for await (const chunk of file) yield chunk; })());
}

module.exports = { createArtifactServer, listArtifacts, describeRoot, bodyStream, rootIdOf, loadRules };
