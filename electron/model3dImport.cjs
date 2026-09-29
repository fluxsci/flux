"use strict";
// Shared desktop/CLI import IO. Binary bytes never enter project JSON or journals.
const fs = require("node:fs");
const fsp = fs.promises;
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { pathToFileURL } = require("node:url");
const { shareRetry } = require("./fsRetry.cjs");
// GLB_LIMITS.maxBytes (glbCore.mjs). This CommonJS boundary cannot import the ESM
// core synchronously; verify-model3d-import pins the two values equal.
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

const fileIdentity = stat => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
async function readBounded(file, limit, label, { validate = async () => {}, checkCurrent = () => {} } = {}) {
  await checkCurrent(); await validate();
  const expected = await fsp.lstat(file);
  if (!expected.isFile()) throw new Error(`${label} must be a regular file`);
  await validate();
  // O_NONBLOCK keeps a concurrently substituted FIFO from stalling native IPC.
  const handle = await fsp.open(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0) | (fs.constants.O_NOFOLLOW || 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || fileIdentity(before) !== fileIdentity(expected)) throw new Error(`${label} changed before reading`);
    if (before.size > limit) throw new Error(`${label} exceeds ${limit / 1024 / 1024} MiB. Use fp.mesh3d(..., max_faces=…) to reduce the mesh.`);
    await checkCurrent();
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      await checkCurrent();
      const { bytesRead } = await handle.read(bytes, offset, Math.min(1048576, bytes.length - offset), offset);
      if (!bytesRead) throw new Error(`${label} changed while reading`);
      offset += bytesRead;
    }
    await validate(); await checkCurrent();
    if (fileIdentity(before) !== fileIdentity(await handle.stat()) || fileIdentity(before) !== fileIdentity(await fsp.lstat(file))) throw new Error(`${label} changed while reading`);
    return bytes;
  } finally { await handle.close(); }
}

async function importLocation(root, target) {
  if (typeof root !== "string" || !path.isAbsolute(root) || !root || root.includes("\0")) throw new Error("Save the project before importing a 3D model");
  const slide = target?.kind === "slide";
  if ((!slide && target?.kind !== "figure") || Object.keys(target).some(k => k !== "kind" && !(slide && k === "deckId"))) throw new Error("3D import requires a Figure or slide target");
  if (slide && (typeof target.deckId !== "string" || !/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,180}$/.test(target.deckId) || ["__proto__", "constructor", "prototype"].includes(target.deckId))) throw new Error("Unsafe model deck id");
  const realRoot = await fsp.realpath(root);
  const projectFile = path.join(realRoot, "project.json");
  const projectReal = await fsp.realpath(projectFile);
  if (!contained(realRoot, projectReal)) throw new Error("Project metadata escapes its root");
  const project = JSON.parse((await readBounded(projectReal, 16 * 1024 * 1024, "Project metadata")).toString("utf8"));
  let prefix = typeof project.schemaVersion === "string" ? "fig" : project.version === 2 && Array.isArray(project.figures) ? "" : null;
  if (prefix === null) throw new Error("Unrecognized Figure project format");
  let document = path.join(realRoot, prefix ? "fig/index.json" : "project.json");
  if (slide) {
    const relative = `slides/${target.deckId}/deck.json`;
    if (typeof project.schemaVersion !== "string" || !project.slides?.some(d => d.id === target.deckId && d.path === relative)) throw new Error("The model destination deck is not registered in this project");
    document = await fsp.realpath(path.join(realRoot, relative));
    if (!contained(realRoot, document)) throw new Error("Model destination deck escapes the project");
    const deck = JSON.parse((await readBounded(document, 16 * 1024 * 1024, "Deck metadata")).toString("utf8"));
    if (deck.id !== target.deckId || !/^0\.[23456]\./.test(deck.schemaVersion) || !Array.isArray(deck.slides)) throw new Error("The model destination deck cannot be edited by this Flux version");
    prefix = `slides/${target.deckId}`;
  }
  const assetDir = path.join(realRoot, prefix, "assets");
  // Validate every existing ancestor before creating directories. An assets or
  // fig symlink may stay inside this project, but cannot escape it.
  const ancestors = prefix ? prefix.split('/').map((_, i, parts) => parts.slice(0, i + 1).join('/')) : [];
  for (const relative of [...ancestors, prefix ? `${prefix}/assets` : "assets"]) {
    const candidate = path.join(realRoot, relative);
    try { if (!contained(realRoot, await fsp.realpath(candidate))) throw new Error("Model asset directory escapes the project"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return { root: path.resolve(root), realRoot, prefix, assetDir, document, target: { ...target } };
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
async function prepareModel3d({ root, target, sourcePath, manifestPath, recipePath, checkCurrent = () => {}, readGuard = () => {} }) {
  await checkCurrent();
  if (typeof sourcePath !== "string" || !path.isAbsolute(sourcePath) || !/\.glb$/i.test(sourcePath) || sourcePath.includes("\0")) throw new Error("Choose a binary .glb model file");
  const location = await importLocation(root, target);
  const checkDestination = async () => {
    await checkCurrent();
    if (target.kind === 'slide') {
      const now = await importLocation(root, target);
      if (now.realRoot !== location.realRoot || now.document !== location.document) throw new Error('The model destination deck changed');
    }
  };
  await readGuard(sourcePath);
  const sourceReal = await fsp.realpath(sourcePath);
  // In-project sources keep the same real containment guarantee as all project
  // media. Explicitly picked external files are authorized by the caller.
  if (contained(path.resolve(root), path.resolve(sourcePath)) && !contained(location.realRoot, sourceReal)) throw new Error("Model source symlink escapes the project");
  // Revalidate the authorized alias and its resolved target around the bounded
  // open/read. Explicit sidecars use this same boundary with their own grant.
  const validateRead = (file, real, directory) => async () => {
    await checkCurrent(); await readGuard(file); await readGuard(real);
    if (await fsp.realpath(file) !== real) throw new Error('Model source path changed while reading');
    if (contained(path.resolve(root), path.resolve(file)) && !contained(location.realRoot, real)) throw new Error('Model source symlink escapes the project');
    if (directory && !contained(directory, real)) throw new Error('Sidecar symlink escapes the model source directory');
  };
  const bytes = await readBounded(sourceReal, MAX_BYTES, "GLB", { validate: validateRead(sourcePath, sourceReal), checkCurrent });
  await checkCurrent();
  const warnings = [], source = { glbPath: path.resolve(sourcePath) };
  async function sidecar(suffix, key) {
    const explicit = key === "manifestPath" ? manifestPath : recipePath;
    if (explicit !== undefined && (typeof explicit !== "string" || !path.isAbsolute(explicit) || !/\.json$/i.test(explicit) || explicit.includes("\0"))) throw new Error("Invalid 3D sidecar path");
    const file = explicit ?? sourcePath.replace(/\.glb$/i, suffix);
    try {
      await readGuard(file);
      const real = await fsp.realpath(file);
      if (!explicit && !contained(path.dirname(sourceReal), real)) throw new Error("Sidecar symlink escapes the model source directory");
      const text = (await readBounded(real, MAX_METADATA_BYTES, `${key} metadata`, { validate: validateRead(file, real, explicit ? undefined : path.dirname(sourceReal)), checkCurrent })).toString("utf8");
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
    for (const [name, data] of entries) owned.files.push(await publishExclusive(location, name, data, checkDestination));
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
