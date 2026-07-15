"use strict";
// Preferences + recents: one JSON file, debounced atomic writes. The dir is
// injected via initPrefs() (no Electron APIs at module scope).
const fss = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const DEFAULTS = { columns: 8, captions: true, recents: [] };
const MAX_RECENTS = 12;

let prefsPath = null;
let cur = { ...DEFAULTS };
let writeTimer = null;

function initPrefs(dir) {
  fss.mkdirSync(dir, { recursive: true });
  prefsPath = path.join(dir, "prefs.json");
  try {
    const j = JSON.parse(fss.readFileSync(prefsPath, "utf8"));
    cur = {
      columns: clampCols(j.columns) ?? DEFAULTS.columns,
      captions: typeof j.captions === "boolean" ? j.captions : DEFAULTS.captions,
      recents: Array.isArray(j.recents) ? j.recents.filter((r) => typeof r === "string").slice(0, MAX_RECENTS) : [],
    };
  } catch {
    cur = { ...DEFAULTS, recents: [] };
  }
}

function clampCols(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  return Math.min(24, Math.max(1, Math.round(n)));
}

function get() {
  return { columns: cur.columns, captions: cur.captions, recents: [...cur.recents] };
}

// Validated partial merge — IPC input is untrusted.
function set(patch) {
  if (!patch || typeof patch !== "object") return;
  const cols = clampCols(patch.columns);
  if (cols !== null) cur.columns = cols;
  if (typeof patch.captions === "boolean") cur.captions = patch.captions;
  scheduleWrite();
}

function pushRecent(p) {
  if (typeof p !== "string" || !p) return;
  cur.recents = [p, ...cur.recents.filter((x) => x !== p)].slice(0, MAX_RECENTS);
  scheduleWrite();
}

// Most-recent-first, silently dropping paths that no longer exist.
async function recents() {
  const out = [];
  for (const p of cur.recents) {
    try {
      const st = await fsp.stat(p);
      if (st.isDirectory()) out.push({ path: p, name: path.basename(p) });
    } catch {}
  }
  return out;
}

function scheduleWrite() {
  if (!prefsPath) return;
  clearTimeout(writeTimer);
  writeTimer = setTimeout(() => void writeNow().catch(() => {}), 300);
}

async function writeNow() {
  const tmp = prefsPath + ".tmp";
  await fsp.writeFile(tmp, JSON.stringify(cur, null, 2));
  await fsp.rename(tmp, prefsPath);
}

// Called on before-quit so a debounced write isn't lost.
function flushSync() {
  if (!prefsPath) return;
  clearTimeout(writeTimer);
  try {
    fss.writeFileSync(prefsPath + ".tmp", JSON.stringify(cur, null, 2));
    fss.renameSync(prefsPath + ".tmp", prefsPath);
  } catch {}
}

module.exports = { initPrefs, get, set, pushRecent, recents, flushSync };
