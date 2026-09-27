// Machine-local project history shared by Electron and headless connect.
// Paths belong in userData, never in the movable/synced FluxConfig folder.
"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { userDataDir } = require("./fluxPaths.cjs");
const leases = require("./operationLease.cjs");
const { shareRetry } = require("./fsRetry.cjs");

/** @typedef {{root: string, title: string, lastOpened?: string, lastConnected?: string}} KnownProject */
const LIMIT = 100;

/** @param {unknown} value */
function timestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : undefined;
}
/** @param {KnownProject} entry */
function recency(entry) {
  return Math.max(Date.parse(entry.lastOpened || "") || 0, Date.parse(entry.lastConnected || "") || 0);
}
/** @param {string} file @returns {Promise<KnownProject[]>} */
async function readRegistry(file) {
  let data;
  try { data = JSON.parse(await fs.readFile(file, "utf8")); }
  catch (error) {
    if (error instanceof SyntaxError || error.code === "ENOENT") return [];
    throw error;
  }
  if (data?.v !== 1 || !Array.isArray(data.projects)) return [];
  const seen = new Set();
  return data.projects.filter(entry => entry && typeof entry.root === "string" &&
    path.isAbsolute(entry.root) && !entry.root.includes("\0") && typeof entry.title === "string")
    .map(entry => ({ root: path.resolve(entry.root), title: entry.title,
      ...(timestamp(entry.lastOpened) ? { lastOpened: entry.lastOpened } : {}),
      ...(timestamp(entry.lastConnected) ? { lastConnected: entry.lastConnected } : {}) }))
    .sort((a, b) => recency(b) - recency(a))
    .filter(entry => { if (seen.has(entry.root)) return false; seen.add(entry.root); return true; });
}

/** Serialize read/modify/write across windows AND separate CLI/MCP processes.
 * @template T
 * @param {(file: string, lease: import('./operationLease.cjs').OperationLease) => Promise<T>} fn
 */
async function withRegistry(fn) {
  const dir = userDataDir(), file = path.join(dir, "projects.json");
  return leases.queued(path.join(dir, "locks"), "projects", async canonical => {
    const deadline = Date.now() + 10000;
    for (;;) {
      const got = await leases.acquire(canonical, "projects", "project-history");
      if (got.ok) {
        try { return await fn(file, got.lease); }
        finally { await leases.release(got.lease); }
      }
      if (Date.now() >= deadline) throw new Error("Project history is busy in another Flux process");
      await new Promise(resolve => setTimeout(resolve, 20 + Math.floor(Math.random() * 20)));
    }
  });
}

/** @param {string} file @param {KnownProject[]} projects
 * @param {import('./operationLease.cjs').OperationLease} lease */
async function writeRegistry(file, projects, lease) {
  const tmp = `${file}.tmp-${randomUUID()}`;
  let handle;
  try {
    handle = await fs.open(tmp, "wx", 0o600);
    await handle.writeFile(JSON.stringify({ v: 1, projects }, null, 2) + "\n", "utf8");
    await handle.sync();
    await handle.close(); handle = undefined;
    await leases.assertOwned(lease);
    await shareRetry(() => fs.rename(tmp, file));
    if (process.platform !== "win32") {
      handle = await fs.open(path.dirname(file), "r");
      try { await handle.sync(); }
      catch (error) { if (!["EINVAL", "ENOTSUP", "EOPNOTSUPP"].includes(error.code)) throw error; }
    }
  } finally {
    await handle?.close().catch(() => {});
    await shareRetry(() => fs.rm(tmp, { force: true })).catch(() => {});
  }
}

/** @param {string} root @param {string} title @param {'lastOpened'|'lastConnected'} field */
async function record(root, title, field) {
  if (typeof root !== "string" || !root.trim() || root.includes("\0")) throw new Error("A project root is required");
  const absolute = await fs.realpath(path.resolve(root));
  if (!(await fs.stat(absolute)).isDirectory()) throw new Error("A project root must be a directory");
  await withRegistry(async (file, lease) => {
    const projects = await readRegistry(file), previous = projects.find(entry => entry.root === absolute);
    const entry = { ...previous, root: absolute,
      title: typeof title === "string" && title.trim() ? title.trim() : previous?.title || path.basename(absolute),
      [field]: new Date().toISOString() };
    const next = [entry, ...projects.filter(item => item.root !== absolute)]
      .sort((a, b) => recency(b) - recency(a)).slice(0, LIMIT);
    await writeRegistry(file, next, lease);
  });
}

/** @param {string} root @param {string} title */
async function recordProjectOpened(root, title) { await record(root, title, "lastOpened"); }
/** @param {string} root @param {string} title */
async function recordProjectConnected(root, title) { await record(root, title, "lastConnected"); }

/** Missing directories are pruned on demand; a temporary permission failure
 * must not erase a remembered project. @returns {Promise<KnownProject[]>} */
async function listKnownProjects() {
  return withRegistry(async (file, lease) => {
    const projects = await readRegistry(file);
    const present = await Promise.all(projects.map(async entry => {
      try { return (await fs.stat(entry.root)).isDirectory(); }
      catch (error) { if (["ENOENT", "ENOTDIR"].includes(error.code)) return false; throw error; }
    }));
    const next = projects.filter((_entry, index) => present[index]).slice(0, LIMIT);
    if (next.length !== projects.length) await writeRegistry(file, next, lease);
    return next;
  });
}

module.exports = { recordProjectOpened, recordProjectConnected, listKnownProjects };
