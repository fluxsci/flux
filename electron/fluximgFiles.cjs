"use strict";
// The file side of fluximg (docs: notes/fluximg_master_plan): copy a `.fluximg` bundle into a project
// as an immutable asset directory, read small ranges of its files, and remove an unplaced one.
//
// No Electron here (electron/ipc/fluximg.cjs adds the per-window project checks), so the pure gate
// verify-fluximg-files drives it directly. Every request string is renderer-supplied and hostile:
// validation is fluximgRules.js, shared with the in-memory dev bridge so both refuse the same things
// with the same words.
//
// Pixels never go through IPC whole: a reader asks for a shard's index (its last bytes) and then one
// compressed chunk at a time, each at most FLUXIMG_READ_LIMIT.
const fs = require("node:fs");
const fsp = fs.promises;
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { shareRetry } = require("./fsRetry.cjs");

/** @type {Promise<typeof import("./fluximgRules.js")> | undefined} */
let rulesLoad;
// A literal specifier, so a bundler (the packaged CLI is one esbuild file) follows it; a path built from __dirname
// would point at a file that does not exist beside the bundle.
const loadRules = () => rulesLoad ??= import("./fluximgRules.js");

const O_READ = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0);
// Copies run a few files at a time: enough to overlap one file's fsync with the next one's reads.
const COPY_CONCURRENCY = 4;
const COPY_BUFFER = 1 << 20;

const contained = (dir, file) => {
  const rel = path.relative(dir, file);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
};
const containedOrSame = (dir, file) => path.relative(dir, file) === "" || contained(dir, file);
const identity = (s) => `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}`;
const absoluteRoot = (root, R) => {
  if (typeof root !== "string" || !root || root.length > 32768 || root.includes("\0") || !path.isAbsolute(root)) throw new Error(R.fluximgErrors.root());
  return path.resolve(root);
};
async function realOrNull(p) {
  try { return await fsp.realpath(p); } catch (error) { if (error.code === "ENOENT" || error.code === "ENOTDIR") return null; throw error; }
}
async function syncDirectory(dir) {
  // Windows cannot open a directory for fsync; NTFS journals the rename itself.
  if (process.platform === "win32") return;
  const handle = await fsp.open(dir, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

/** The project's real root and its real `fig/assets`, created if needed, never outside the project. */
async function assetsLocation(root, R, { create }) {
  const realRoot = await fsp.realpath(absoluteRoot(root, R)).catch(() => { throw new Error(R.fluximgErrors.root()); });
  const project = await fsp.lstat(path.join(realRoot, "project.json")).catch(() => null);
  if (!project || !project.isFile()) throw new Error(R.fluximgErrors.root());
  // A `fig` or `fig/assets` symlink may stay inside the project, never leave it (model3dImport's rule).
  for (const rel of ["fig", "fig/assets"]) {
    const real = await realOrNull(path.join(realRoot, ...rel.split("/")));
    if (real && !contained(realRoot, real)) throw new Error(`${rel} points outside the project`);
  }
  const assets = path.join(realRoot, "fig", "assets");
  if (create) await fsp.mkdir(assets, { recursive: true });
  const realAssets = await realOrNull(assets);
  if (realAssets && !contained(realRoot, realAssets)) throw new Error("fig/assets points outside the project");
  return { realRoot, realAssets };
}

/** A small file read whole, refusing anything that is not a regular file or is larger than `limit`. */
async function readSmall(file, limit, onTooLarge, onNotFile) {
  const handle = await fsp.open(file, O_READ);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error(onNotFile());
    if (stat.size > limit) throw new Error(onTooLarge());
    const bytes = Buffer.alloc(stat.size);
    for (let at = 0; at < bytes.length; ) {
      const { bytesRead } = await handle.read(bytes, at, bytes.length - at, at);
      if (!bytesRead) break;
      at += bytesRead;
    }
    return bytes;
  } finally { await handle.close(); }
}

async function readManifest(dir, label, R) {
  let bytes;
  try {
    bytes = await readSmall(path.join(dir, "fluximg.json"), R.FLUXIMG_MANIFEST_MAX_BYTES, () => R.fluximgErrors.manifestTooLarge(), () => R.fluximgErrors.notBundle(label));
  } catch (error) {
    // ELOOP: fluximg.json is a link (O_NOFOLLOW) — not a manifest this import will follow.
    if (error.code === "ENOENT" || error.code === "ELOOP") throw new Error(R.fluximgErrors.notBundle(label));
    throw error;
  }
  return R.parseFluximgManifest(bytes.toString("utf8"));
}

/** Every regular file and folder under `real`, refusing links and special files before anything is copied. */
async function walkBundle(real, R, limits) {
  const files = [], dirs = [];
  let bytes = 0;
  const visit = async (dir, rel, depth) => {
    if (depth > limits.maxDepth) throw new Error(R.fluximgErrors.tooDeep(limits.maxDepth));
    const names = (await fsp.readdir(dir)).sort(R.compareCodePoints);
    for (const name of names) {
      if (R.isFluximgJunkName(name)) continue;
      const childRel = rel ? `${rel}/${name}` : name;
      // A backslash is a separator on Windows: the same bundle could not round-trip there.
      if (name.includes("\\")) throw new Error(R.fluximgErrors.nonPortableName(childRel));
      const abs = path.join(dir, name);
      if (!contained(real, abs)) throw new Error(R.fluximgErrors.pathEscapes(childRel));
      const stat = await fsp.lstat(abs);
      if (stat.isSymbolicLink()) throw new Error(R.fluximgErrors.symlink(childRel));
      if (stat.isDirectory()) {
        if (dirs.push(childRel) > limits.maxDirs) throw new Error(R.fluximgErrors.tooManyDirs(limits.maxDirs));
        await visit(abs, childRel, depth + 1);
      } else if (stat.isFile()) {
        if (files.push({ rel: childRel, abs, size: stat.size, identity: identity(stat) }) > limits.maxFiles) throw new Error(R.fluximgErrors.tooManyFiles(limits.maxFiles));
        bytes += stat.size;
        if (bytes > limits.maxBytes) throw new Error(R.fluximgErrors.tooLarge(bytes, limits.maxBytes));
      } else throw new Error(R.fluximgErrors.special(childRel));
    }
  };
  await visit(real, "", 0);
  return { files, dirs, bytes };
}

/** Stream `src` into a new `dest`, hashing the bytes written; the source must be the file the walk saw. */
async function copyStreaming(file, dest, R) {
  const source = await fsp.open(file.abs, O_READ);
  try {
    const before = await source.stat();
    if (!before.isFile() || identity(before) !== file.identity) throw new Error(R.fluximgErrors.changed(file.rel));
    const target = await fsp.open(dest, "wx");
    try {
      const hash = createHash("sha256"), buffer = Buffer.allocUnsafe(Math.min(COPY_BUFFER, Math.max(file.size, 1)));
      let total = 0;
      for (let read; (read = (await source.read(buffer, 0, buffer.length, total)).bytesRead) > 0; total += read) {
        hash.update(buffer.subarray(0, read));
        for (let at = 0; at < read; ) at += (await target.write(buffer, at, read - at)).bytesWritten;
      }
      if (total !== file.size || identity(await source.stat()) !== file.identity) throw new Error(R.fluximgErrors.changed(file.rel));
      await target.sync();
      return hash.digest("hex");
    } finally { await target.close(); }
  } finally { await source.close(); }
}

/** Hash (and fsync) a clone just made, then confirm the source is still the file the walk saw: a clone
 *  is taken by path, so this is what catches a file replaced between the walk and the clone. */
async function hashClone(file, dest, R) {
  const handle = await fsp.open(dest, "r+");
  try {
    const hash = createHash("sha256"), buffer = Buffer.allocUnsafe(Math.min(COPY_BUFFER, Math.max(file.size, 1)));
    let total = 0;
    for (let read; (read = (await handle.read(buffer, 0, buffer.length, total)).bytesRead) > 0; total += read) hash.update(buffer.subarray(0, read));
    const after = await fsp.lstat(file.abs);
    if (total !== file.size || after.isSymbolicLink() || identity(after) !== file.identity) throw new Error(R.fluximgErrors.changed(file.rel));
    await handle.sync();
    return hash.digest("hex");
  } finally { await handle.close(); }
}

/**
 * Copy the bundle directory `sourcePath` (absolute, or relative to `root`) to `<root>/fig/assets/<assetId>.fluximg/`.
 * Staged in a hidden sibling and published by one rename, so the asset path holds either nothing or the
 * whole bundle. Each file is a copy-on-write clone where the filesystem can, else a plain copy; never a
 * hard link (an in-place edit of the source would silently change an "immutable" asset).
 *
 * `checkCurrent` (throws when the requesting window's project changed) and `readGuard` (the per-window
 * read capability for `sourcePath`) come from the IPC layer. `limits` and `tryClone` are for the gate.
 * @returns {Promise<import("../src/lib/fluximg/bridge").FluximgImportResult>}
 */
async function importBundle({ root, sourcePath, assetId, checkCurrent = () => {}, readGuard = () => {}, limits = {}, tryClone = true }) {
  const R = await loadRules();
  const id = R.fluximgAssetId(assetId);
  const bounds = { maxFiles: R.FLUXIMG_IMPORT_MAX_FILES, maxDirs: R.FLUXIMG_IMPORT_MAX_DIRS, maxDepth: R.FLUXIMG_IMPORT_MAX_DEPTH, maxBytes: R.FLUXIMG_IMPORT_MAX_BYTES, ...limits };
  const lexicalRoot = absoluteRoot(root, R);
  if (typeof sourcePath !== "string" || !sourcePath || sourcePath.length > 32768 || sourcePath.includes("\0")) throw new Error(R.fluximgErrors.sourcePath());
  await checkCurrent();
  const { realRoot, realAssets } = await assetsLocation(lexicalRoot, R, { create: true });
  const name = `${id}${R.FLUXIMG_EXT}`, destination = path.join(realAssets, name);
  if (await fsp.lstat(destination).then(() => true, () => false)) throw new Error(R.fluximgErrors.exists(id));

  // The source: a relative path stays inside the project; an in-project path keeps the project's real
  // containment even through links; an outside path needs the window's read capability (readGuard).
  const relative = !path.isAbsolute(sourcePath);
  const source = path.resolve(lexicalRoot, sourcePath);
  const lexicallyInside = containedOrSame(lexicalRoot, source);
  if (relative && !lexicallyInside) throw new Error(R.fluximgErrors.sourceEscapes());
  const label = path.basename(source);
  await readGuard(source);
  const realSource = await fsp.realpath(source).catch((error) => { throw error.code === "ENOENT" ? new Error(`ENOENT: ${sourcePath} does not exist`) : error; });
  if (lexicallyInside && !containedOrSame(realRoot, realSource)) throw new Error(R.fluximgErrors.sourceSymlinkEscapes());
  await readGuard(realSource);
  if (!(await fsp.stat(realSource)).isDirectory()) throw new Error(R.fluximgErrors.notDirectory(label));
  // A source that holds fig/assets would copy its own staging folder into itself.
  if (containedOrSame(realSource, realAssets)) throw new Error(R.fluximgErrors.destinationInsideSource());
  await readManifest(realSource, label, R);
  const walk = await walkBundle(realSource, R, bounds);
  await checkCurrent();

  const staging = path.join(realAssets, `.${name}.tmp-${randomUUID()}`);
  await fsp.mkdir(staging);
  try {
    for (const dir of walk.dirs) await fsp.mkdir(path.join(staging, ...dir.split("/")));
    let cloning = tryClone, cloned = 0, next = 0, failed = null;
    const entries = new Array(walk.files.length);
    const worker = async () => {
      while (failed === null && next < walk.files.length) {
        const i = next++, file = walk.files[i], dest = path.join(staging, ...file.rel.split("/"));
        try {
          await checkCurrent();
          let sha256 = null;
          if (cloning) {
            try {
              await fsp.copyFile(file.abs, dest, fs.constants.COPYFILE_FICLONE_FORCE | fs.constants.COPYFILE_EXCL);
              sha256 = await hashClone(file, dest, R);
              cloned++;
            } catch (error) {
              // This filesystem cannot clone (Windows, ext4, a cross-device copy...): copy from here on.
              // A clone that worked but whose source then changed is not a clone failure.
              if (error instanceof Error && error.message === R.fluximgErrors.changed(file.rel)) throw error;
              cloning = false;
              await fsp.rm(dest, { force: true });
            }
          }
          entries[i] = { path: file.rel, sha256: sha256 ?? await copyStreaming(file, dest, R) };
        } catch (error) { failed ??= error; }
      }
    };
    await Promise.all(Array.from({ length: Math.min(COPY_CONCURRENCY, walk.files.length) }, worker));
    if (failed) throw failed;
    // The manifest returned is the one that was copied (the source may have been rewritten mid-import).
    const manifest = await readManifest(staging, label, R);
    const sha256 = createHash("sha256").update(R.fluximgContentIdText(entries), "utf8").digest("hex");
    await checkCurrent();
    if (await fsp.lstat(destination).then(() => true, () => false)) throw new Error(R.fluximgErrors.exists(id));
    // POSIX rename replaces an EMPTY directory that appeared since the check above (nothing is lost) and
    // fails on a non-empty one; Windows fails on any. Both failures are "already exists".
    await shareRetry(() => fsp.rename(staging, destination)).catch((error) => {
      throw ["EEXIST", "ENOTEMPTY", "EPERM", "EACCES"].includes(error.code) && fs.existsSync(destination) ? new Error(R.fluximgErrors.exists(id)) : error;
    });
    await syncDirectory(realAssets);
    return {
      path: R.fluximgAssetPath(id), sha256, bytes: walk.bytes, files: walk.files.length, manifest,
      method: walk.files.length > 0 && cloned === walk.files.length ? "clone" : "copy",
    };
  } catch (error) {
    await shareRetry(() => fsp.rm(staging, { recursive: true, force: true })).catch(() => {});
    if (error && error.code === "ENOSPC") throw new Error(R.fluximgErrors.noSpace());
    throw error;
  }
}

/**
 * Bytes `[offset, offset + length)` of `path` inside the bundle `bundle` (project-relative,
 * `fig/assets/<id>.fluximg` or under `plots/`). Negative `offset` counts from the end; `length` -1 reads
 * to the end; at most FLUXIMG_READ_LIMIT. The bundle and the file are resolved through every link and
 * must stay inside fig/assets (or plots) and the bundle. A missing file's message starts "ENOENT:", so
 * a reader's `exists(p)` is `readRange(p, 0, 0)`.
 * @returns {Promise<Buffer>}
 */
async function readRange({ root, bundle, path: inner, offset, length, readGuard = () => {} }) {
  const R = await loadRules();
  const lexicalRoot = absoluteRoot(root, R);
  const where = R.fluximgBundleRel(bundle), parts = R.fluximgInnerPath(inner);
  R.fluximgCheckRange(offset, length);
  const realRoot = await fsp.realpath(lexicalRoot).catch(() => { throw new Error(R.fluximgErrors.root()); });
  const realArea = await realOrNull(path.join(realRoot, ...where.area.split("/")));
  if (!realArea) throw new Error(R.fluximgErrors.bundleMissing(where.rel));
  if (!contained(realRoot, realArea)) throw new Error(R.fluximgErrors.bundleEscapes(where.rel));
  const realBundle = await realOrNull(path.join(realRoot, ...where.parts));
  if (!realBundle) throw new Error(R.fluximgErrors.bundleMissing(where.rel));
  if (!contained(realArea, realBundle) || !realBundle.endsWith(R.FLUXIMG_EXT)) throw new Error(R.fluximgErrors.bundleEscapes(where.rel));
  const rel = parts.join("/");
  const realFile = await realOrNull(path.join(realBundle, ...parts));
  if (!realFile) throw new Error(R.fluximgErrors.missing(where.rel, rel));
  if (!contained(realBundle, realFile)) throw new Error(R.fluximgErrors.pathEscapes(rel));
  await readGuard(realFile);
  // realFile has no links left, so O_NOFOLLOW only refuses one swapped in since the realpath.
  const handle = await fsp.open(realFile, O_READ).catch((error) => {
    throw error.code === "ENOENT" ? new Error(R.fluximgErrors.missing(where.rel, rel)) : error.code === "ELOOP" ? new Error(R.fluximgErrors.pathEscapes(rel)) : error;
  });
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error(R.fluximgErrors.notFile(rel));
    const range = R.fluximgRange(rel, stat.size, offset, length);
    // Buffer.alloc (never the shared pool): the IPC layer can hand its ArrayBuffer over as is.
    const bytes = Buffer.alloc(range.length);
    for (let at = 0; at < bytes.length; ) {
      const { bytesRead } = await handle.read(bytes, at, bytes.length - at, range.start + at);
      if (!bytesRead) throw new Error(R.fluximgErrors.shortRead(rel, range.start, range.length, range.start + at));
      at += bytesRead;
    }
    return bytes;
  } finally { await handle.close(); }
}

/**
 * Remove exactly `<root>/fig/assets/<assetId>.fluximg` (an import whose placement was cancelled or whose
 * bundle failed validation). Missing is fine. Refused when fig/index.json lists the asset (it is in use)
 * or cannot be read. Renamed aside first, so a failure part-way never leaves a half bundle at the asset path.
 */
async function discardBundle({ root, assetId, checkCurrent = () => {} }) {
  const R = await loadRules();
  const id = R.fluximgAssetId(assetId);
  await checkCurrent();
  const { realRoot, realAssets } = await assetsLocation(root, R, { create: false });
  if (!realAssets) return;
  const name = `${id}${R.FLUXIMG_EXT}`, target = path.join(realAssets, name);
  const stat = await fsp.lstat(target).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
  if (!stat) return;
  if (!stat.isDirectory()) throw new Error(R.fluximgErrors.discardNotDirectory(id));
  let saved;
  try {
    saved = JSON.parse((await readSmall(path.join(realRoot, "fig", "index.json"), 256 * 1024 * 1024, () => R.fluximgErrors.savedUnreadable(), () => R.fluximgErrors.savedUnreadable())).toString("utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw new Error(R.fluximgErrors.savedUnreadable());
  }
  if (Array.isArray(saved?.assets) && saved.assets.some((a) => a && a.id === id)) throw new Error(R.fluximgErrors.saved(id));
  await checkCurrent();
  const aside = path.join(realAssets, `.${name}.tmp-discard-${randomUUID()}`);
  await shareRetry(() => fsp.rename(target, aside));
  await syncDirectory(realAssets);
  // fs.rm never follows a link inside the tree: it removes the link itself.
  await shareRetry(() => fsp.rm(aside, { recursive: true, force: true }));
}

/** One file's SHA-256, read in place; the file must still be the one the walk saw when the read ends. */
async function hashInPlace(file, R) {
  const handle = await fsp.open(file.abs, O_READ);
  try {
    const before = await handle.stat();
    if (!before.isFile() || identity(before) !== file.identity) throw new Error(R.fluximgErrors.changed(file.rel));
    const hash = createHash("sha256"), buffer = Buffer.allocUnsafe(Math.min(COPY_BUFFER, Math.max(file.size, 1)));
    let total = 0;
    for (let read; (read = (await handle.read(buffer, 0, buffer.length, total)).bytesRead) > 0; total += read) hash.update(buffer.subarray(0, read));
    if (total !== file.size || identity(await handle.stat()) !== file.identity) throw new Error(R.fluximgErrors.changed(file.rel));
    return hash.digest("hex");
  } finally { await handle.close(); }
}

/**
 * What an import would record of the asset bundle already at `<root>/fig/assets/<assetId>.fluximg/`: its content id,
 * byte count and file count, measured where it is (nothing is written). An image placed on slides only has no record
 * in fig/index.json; a figure that takes it over needs exactly these (project/convert.ts). Same walk, same limits and
 * same content id as importBundle.
 * @returns {Promise<{ path: string; sha256: string; bytes: number; files: number }>}
 */
async function measureBundle({ root, assetId, checkCurrent = () => {}, limits = {} }) {
  const R = await loadRules();
  const id = R.fluximgAssetId(assetId);
  const bounds = { maxFiles: R.FLUXIMG_IMPORT_MAX_FILES, maxDirs: R.FLUXIMG_IMPORT_MAX_DIRS, maxDepth: R.FLUXIMG_IMPORT_MAX_DEPTH, maxBytes: R.FLUXIMG_IMPORT_MAX_BYTES, ...limits };
  await checkCurrent();
  const { realAssets } = await assetsLocation(root, R, { create: false });
  const name = `${id}${R.FLUXIMG_EXT}`, target = realAssets ? path.join(realAssets, name) : null;
  const stat = target ? await fsp.lstat(target).catch((error) => { if (error.code === "ENOENT") return null; throw error; }) : null;
  if (!stat) throw new Error(`ENOENT: ${R.fluximgAssetPath(id)} does not exist`);
  // The asset folder itself is never a link (an import publishes a real directory by rename).
  if (!stat.isDirectory()) throw new Error(R.fluximgErrors.notDirectory(name));
  await readManifest(target, name, R);
  const walk = await walkBundle(target, R, bounds);
  const entries = new Array(walk.files.length);
  let next = 0, failed = null;
  const worker = async () => {
    while (failed === null && next < walk.files.length) {
      const i = next++, file = walk.files[i];
      try { await checkCurrent(); entries[i] = { path: file.rel, sha256: await hashInPlace(file, R) }; } catch (error) { failed ??= error; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(COPY_CONCURRENCY, walk.files.length) }, worker));
  if (failed) throw failed;
  await checkCurrent();
  return { path: R.fluximgAssetPath(id), sha256: createHash("sha256").update(R.fluximgContentIdText(entries), "utf8").digest("hex"), bytes: walk.bytes, files: walk.files.length };
}

module.exports = { importBundle, readRange, discardBundle, measureBundle, loadRules, assetsLocation, syncDirectory };
