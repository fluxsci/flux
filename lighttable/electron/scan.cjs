"use strict";
// Collection scanner: fs only, no Electron — verify-node.mjs runs this against
// real temp fixtures. Scans metadata only (names; no stats, no decodes) so a
// 500-image collection opens in well under a second.
const fsp = require("node:fs/promises");
const path = require("node:path");
const { isImage, naturalCompare, alignByKeys } = require("./lib/pure.cjs");

// Reserved id for the loose-images set ("All") — a folder cannot be named ".".
const LOOSE_SET_ID = ".";

// Scan a collection folder -> { root, name, sets, keys, bySet, index } or null
// if the path doesn't resolve to a directory. Degenerate cases (§1 of the
// plan): loose images only -> single "All" set; loose + subfolders -> "All"
// alongside the subfolder sets; imageless subfolder -> omitted; no images
// anywhere -> empty manifest (renderer shows the empty state, not an error).
// Dropping a FILE opens its containing folder.
async function scanCollection(rootPath) {
  if (!rootPath || typeof rootPath !== "string") return null;
  let root;
  try {
    root = await fsp.realpath(rootPath);
  } catch {
    return null;
  }
  let st;
  try {
    st = await fsp.stat(root);
  } catch {
    return null;
  }
  if (st.isFile()) root = path.dirname(root);
  else if (!st.isDirectory()) return null;

  let entries;
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return null;
  }

  const loose = [];
  const subdirNames = [];
  for (const e of entries) {
    if (e.name.startsWith(".")) continue; // hidden files/dirs ignored
    let isDir = e.isDirectory();
    let isFile = e.isFile();
    if (e.isSymbolicLink()) {
      try {
        const s = await fsp.stat(path.join(root, e.name));
        isDir = s.isDirectory();
        isFile = s.isFile();
      } catch {
        continue; // broken link
      }
    }
    if (isFile && isImage(e.name)) loose.push(e.name);
    else if (isDir) subdirNames.push(e.name);
  }

  const setsFiles = {}; // setId -> [filenames]
  const setDirs = {}; // setId -> absolute dir
  for (const d of subdirNames) {
    let files;
    try {
      files = await fsp.readdir(path.join(root, d), { withFileTypes: true });
    } catch {
      continue;
    }
    // One level only (flat sets) — no recursion below the set folder in v1.
    const imgs = files
      .filter((f) => (f.isFile() || f.isSymbolicLink()) && !f.name.startsWith(".") && isImage(f.name))
      .map((f) => f.name);
    if (imgs.length === 0) continue;
    setsFiles[d] = imgs;
    setDirs[d] = path.join(root, d);
  }
  if (loose.length > 0) {
    setsFiles[LOOSE_SET_ID] = loose;
    setDirs[LOOSE_SET_ID] = root;
  }

  const { keys, bySet } = alignByKeys(setsFiles);

  const setIds = Object.keys(setsFiles).sort((a, b) => {
    if (a === LOOSE_SET_ID) return -1; // "All" first, then natural order
    if (b === LOOSE_SET_ID) return 1;
    return naturalCompare(a, b);
  });
  const sets = setIds.map((id) => ({
    id,
    name: id === LOOSE_SET_ID ? "All" : id,
    count: bySet[id].reduce((n, c) => n + (c.present ? 1 : 0), 0),
  }));

  // fs index (main-process only; stripped from the renderer manifest):
  // setId -> Map(key -> absolute path)
  const index = new Map();
  for (const id of setIds) {
    const m = new Map();
    for (const cell of bySet[id]) if (cell.present) m.set(cell.key, path.join(setDirs[id], cell.file));
    index.set(id, m);
  }

  return { root, name: path.basename(root), sets, keys, bySet, index };
}

// The renderer-facing shape (§3.5) — everything except the fs index.
function toManifest(scan) {
  return { root: scan.root, name: scan.name, sets: scan.sets, keys: scan.keys, bySet: scan.bySet };
}

module.exports = { scanCollection, toManifest, LOOSE_SET_ID };
