"use strict";
// Shared desktop/CLI import IO. Binary bytes never enter project JSON or journals.
const fs = require("node:fs");
const fsp = fs.promises;
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { pathToFileURL } = require("node:url");
const { shareRetry } = require("./fsRetry.cjs");
const MAX_BYTES = 200 * 1024 * 1024;
const MAX_METADATA_BYTES = 4 * 1024 * 1024;
const contained = (root, file) => {
  const rel = path.relative(root, file);
  return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
};
let pure;
function importPolicy() {
  return pure ??= import(pathToFileURL(path.join(__dirname, "../src/lib/model3d/importData.native.gen.mjs")).href);
}

async function readBounded(file, limit, label) {
  if (!(await fsp.lstat(file)).isFile()) throw new Error(`${label} must be a regular file`);
  // O_NONBLOCK keeps a concurrently substituted FIFO from stalling native IPC.
  const handle = await fsp.open(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0) | (fs.constants.O_NOFOLLOW || 0));
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error(`${label} must be a regular file`);
    if (before.size > limit) throw new Error(`${label} exceeds ${limit / 1024 / 1024} MiB. Use fp.mesh3d(..., max_faces=…) to reduce the mesh.`);
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) throw new Error(`${label} changed while reading`);
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error(`${label} changed while reading`);
    return bytes;
  } finally { await handle.close(); }
}

async function importLocation(root, target) {
  if (typeof root !== "string" || !path.isAbsolute(root) || !root || root.includes("\0")) throw new Error("Save the project before importing a 3D model");
  if (target?.kind !== "figure" || Object.keys(target).some(k => k !== "kind")) throw new Error("3D import requires a Figure target; deck support is not available yet");
  const realRoot = await fsp.realpath(root);
  const projectFile = path.join(realRoot, "project.json");
  const projectReal = await fsp.realpath(projectFile);
  if (!contained(realRoot, projectReal)) throw new Error("Project metadata escapes its root");
  const project = JSON.parse((await readBounded(projectReal, 16 * 1024 * 1024, "Project metadata")).toString("utf8"));
  const prefix = typeof project.schemaVersion === "string" ? "fig" : project.version === 2 && Array.isArray(project.figures) ? "" : null;
  if (prefix === null) throw new Error("Unrecognized Figure project format");
  const assetDir = path.join(realRoot, prefix, "assets");
  // Validate every existing ancestor before creating directories. An assets or
  // fig symlink may stay inside this project, but cannot escape it.
  for (const relative of prefix ? [prefix, `${prefix}/assets`] : ["assets"]) {
    const candidate = path.join(realRoot, relative);
    try { if (!contained(realRoot, await fsp.realpath(candidate))) throw new Error("Model asset directory escapes the project"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return { root: path.resolve(root), realRoot, prefix, assetDir, document: path.join(realRoot, prefix ? "fig/index.json" : "project.json") };
}

async function assertDirectory(location) {
  const real = await fsp.realpath(location.assetDir);
  if (!contained(location.realRoot, real)) throw new Error("Model asset directory escapes the project");
  return real;
}
async function syncDirectory(directory) {
  if (process.platform === "win32") return;
  const handle = await fsp.open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}
async function publishExclusive(location, file, bytes, checkCurrent) {
  await checkCurrent();
  await fsp.mkdir(location.assetDir, { recursive: true });
  const realDir = await assertDirectory(location);
  const destination = path.join(realDir, path.basename(file));
  const temporary = path.join(realDir, `.${path.basename(file)}.tmp-${randomUUID()}`);
  let handle, published = false;
  try {
    handle = await fsp.open(temporary, "wx");
    await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = null;
    await shareRetry(async () => {
      await checkCurrent();
      if (await assertDirectory(location) !== realDir) throw new Error("Model asset directory changed");
      await fsp.link(temporary, destination);
      published = true;
    });
    await syncDirectory(realDir);
    return destination;
  } catch (error) {
    if (published) await shareRetry(() => fsp.rm(destination, { force: true })).catch(() => {});
    throw error;
  } finally {
    await handle?.close().catch(() => {});
    await shareRetry(() => fsp.rm(temporary, { force: true }));
  }
}

/** Prepare outside document locks, then publish owned, immutable native files.
 * The caller retains this receipt until its document mutation succeeds. */
async function prepareModel3d({ root, target, sourcePath, checkCurrent = () => {}, readGuard = () => {} }) {
  await checkCurrent();
  if (typeof sourcePath !== "string" || !path.isAbsolute(sourcePath) || !/\.glb$/i.test(sourcePath) || sourcePath.includes("\0")) throw new Error("Choose a binary .glb model file");
  const location = await importLocation(root, target);
  await readGuard(sourcePath);
  const sourceReal = await fsp.realpath(sourcePath);
  // In-project sources keep the same real containment guarantee as all project
  // media. Explicitly picked external files are authorized by the caller.
  if (contained(path.resolve(root), path.resolve(sourcePath)) && !contained(location.realRoot, sourceReal)) throw new Error("Model source symlink escapes the project");
  const bytes = await readBounded(sourceReal, MAX_BYTES, "GLB");
  await checkCurrent();
  const warnings = [], source = { glbPath: path.resolve(sourcePath) };
  async function sidecar(suffix, key) {
    const file = sourcePath.replace(/\.glb$/i, suffix);
    try {
      await readGuard(file);
      const real = await fsp.realpath(file);
      if (!contained(path.dirname(sourceReal), real)) throw new Error("Sidecar symlink escapes the model source directory");
      const text = (await readBounded(real, MAX_METADATA_BYTES, `${key} metadata`)).toString("utf8");
      source[key] = path.resolve(file);
      return text;
    } catch (error) {
      if (error.code !== "ENOENT") warnings.push(`${path.basename(file)} could not be read: ${error.message}; importing the mesh without this metadata`);
    }
  }
  const manifestText = await sidecar(".fluxplot.json", "manifestPath");
  const recipeText = await sidecar(".recipe.json", "recipePath");
  const { prepareModel3dImport } = await importPolicy();
  const prepared = await prepareModel3dImport({ bytes, assetId: `model-${randomUUID()}`, name: path.basename(sourcePath), manifestText, recipeText });
  const result = { ...prepared.data, warnings: [...prepared.data.warnings, ...warnings], source, receipt: randomUUID(), assetPrefix: location.prefix };
  const owned = { location, result, files: [] };
  try {
    const entries = [[`${result.asset.id}.glb`, prepared.bytes]];
    if (result.raw?.manifest !== undefined) entries.push([`${result.asset.id}.fluxplot.json`, result.raw.manifest]);
    if (result.raw?.recipe !== undefined) entries.push([`${result.asset.id}.recipe.json`, result.raw.recipe]);
    for (const [name, data] of entries) owned.files.push(await publishExclusive(location, name, data, checkCurrent));
    await checkCurrent();
    return owned;
  } catch (error) {
    await cleanupPreparedModel3d(owned, { checkSaved: false }).catch(() => {});
    throw error;
  }
}

async function cleanupPreparedModel3d(owned, { checkSaved = true } = {}) {
  if (checkSaved) {
    let saved;
    try { saved = JSON.parse(await fsp.readFile(owned.location.document, "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw new Error("Cannot discard a model while its saved ownership is unreadable"); }
    if (saved?.assets?.some(a => a.id === owned.result.asset.id)) throw new Error("This model is already saved in the project");
  }
  const realDir = await assertDirectory(owned.location).catch(error => { if (error.code !== "ENOENT") throw error; return null; });
  for (const file of owned.files) {
    if (!realDir || path.dirname(file) !== realDir) throw new Error("Model import directory changed before discard");
    await shareRetry(() => fsp.rm(file, { force: true }));
  }
  if (realDir) await syncDirectory(realDir);
}

module.exports = { prepareModel3d, cleanupPreparedModel3d, importLocation, readBounded, MAX_BYTES };
