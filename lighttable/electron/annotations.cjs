"use strict";
// Annotation classes: per-collection mark/notes layers living in a hidden
// `.lt-annotations/` folder inside the collection root (dot-name, so the
// scanner never sees it as a set). One JSON file per class:
//   { version: 1, class: "validated_by_eye", updated: <iso>, items:
//     { "<itemKey>": { mark: "valid"|"exclude", notes: "…" } } }
// Items are keyed by ITEM KEY (basename sans extension), never by set — a
// mark belongs to the plot name across every set. fs only, no Electron —
// verify-node.mjs tests this module against real temp fixtures. Write
// discipline mirrors prefs.cjs: debounced atomic writes + flushSync.
const fss = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { naturalCompare } = require("./lib/pure.cjs");

const ANNOT_DIR = ".lt-annotations";
const MARKS = new Set(["valid", "exclude"]);

let cur = null; // { root, name, items, timer, dirty }

const dirFor = (root) => path.join(root, ANNOT_DIR);
const fileFor = (root, name) => path.join(dirFor(root), `${name}.json`);

// Class names become filenames: keep a safe alphabet, no leading dots, and
// require at least one alphanumeric so "…" can't name a file.
function cleanName(name) {
  if (typeof name !== "string") return null;
  const n = name
    .trim()
    .replace(/[^\w .()\-]+/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 64)
    .trim();
  return n && /[A-Za-z0-9]/.test(n) ? n : null;
}

async function listClasses(root) {
  let entries;
  try {
    entries = await fsp.readdir(dirFor(root), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".json") && !e.name.startsWith("."))
    .map((e) => e.name.slice(0, -5))
    .sort(naturalCompare);
}

// The class that auto-opens with a collection: most recently written.
async function latestClass(root) {
  let best = null;
  for (const name of await listClasses(root)) {
    try {
      const st = await fsp.stat(fileFor(root, name));
      if (!best || st.mtimeMs > best.mtimeMs) best = { name, mtimeMs: st.mtimeMs };
    } catch {}
  }
  return best ? best.name : null;
}

// Disk contents are untrusted (hand-edited files sync between machines).
function sanitizeItems(j) {
  const items = {};
  if (j && typeof j === "object" && j.items && typeof j.items === "object") {
    for (const [k, v] of Object.entries(j.items)) {
      if (!v || typeof v !== "object") continue;
      const it = {};
      if (MARKS.has(v.mark)) it.mark = v.mark;
      if (typeof v.notes === "string" && v.notes.trim()) it.notes = v.notes;
      if (it.mark || it.notes) items[k] = it;
    }
  }
  return items;
}

// Open an existing class (flushes whichever was open). Missing file -> null;
// a corrupt file opens EMPTY but is not rewritten until the first change.
async function openClass(root, name) {
  const n = cleanName(name);
  if (!root || !n) return null;
  flushSync();
  let raw;
  try {
    raw = await fsp.readFile(fileFor(root, n), "utf8");
  } catch {
    return null;
  }
  let j = null;
  try {
    j = JSON.parse(raw);
  } catch {}
  cur = { root, name: n, items: sanitizeItems(j), timer: null, dirty: false };
  return toData();
}

// Create + open. An existing class of the same name is opened, not clobbered.
// The file is written immediately — creating a class means a real file exists.
async function createClass(root, name) {
  const n = cleanName(name);
  if (!root || !n) return null;
  const existing = await openClass(root, n);
  if (existing) return existing;
  flushSync();
  cur = { root, name: n, items: {}, timer: null, dirty: true };
  await writeNow().catch(() => {});
  return toData();
}

function closeClass() {
  flushSync();
  cur = null;
}

// Merge a patch for one item: mark null/absent-from-MARKS clears the mark,
// blank notes clear the notes, and fully-empty entries are pruned.
function setItem(key, patch) {
  if (!cur || typeof key !== "string" || !key || !patch || typeof patch !== "object") return;
  const it = { ...(cur.items[key] ?? {}) };
  if ("mark" in patch) {
    if (MARKS.has(patch.mark)) it.mark = patch.mark;
    else delete it.mark;
  }
  if ("notes" in patch) {
    if (typeof patch.notes === "string" && patch.notes.trim()) it.notes = patch.notes;
    else delete it.notes;
  }
  if (it.mark || it.notes) cur.items[key] = it;
  else delete cur.items[key];
  cur.dirty = true;
  scheduleWrite();
}

const toData = () => (cur ? { name: cur.name, items: { ...cur.items } } : null);

function serialize() {
  return JSON.stringify(
    { version: 1, class: cur.name, updated: new Date().toISOString(), items: cur.items },
    null,
    2
  );
}

function scheduleWrite() {
  if (!cur) return;
  clearTimeout(cur.timer);
  cur.timer = setTimeout(() => void writeNow().catch(() => {}), 300);
}

async function writeNow() {
  if (!cur || !cur.dirty) return;
  const file = fileFor(cur.root, cur.name);
  await fsp.mkdir(dirFor(cur.root), { recursive: true });
  await fsp.writeFile(file + ".tmp", serialize());
  await fsp.rename(file + ".tmp", file);
  cur.dirty = false;
}

// Called on class switch, collection switch, and before-quit — a debounced
// write of hand-triage marks must never be lost.
function flushSync() {
  if (!cur) return;
  clearTimeout(cur.timer);
  cur.timer = null;
  if (!cur.dirty) return;
  try {
    const file = fileFor(cur.root, cur.name);
    fss.mkdirSync(dirFor(cur.root), { recursive: true });
    fss.writeFileSync(file + ".tmp", serialize());
    fss.renameSync(file + ".tmp", file);
    cur.dirty = false;
  } catch {}
}

module.exports = { listClasses, latestClass, openClass, createClass, closeClass, setItem, flushSync, ANNOT_DIR };
