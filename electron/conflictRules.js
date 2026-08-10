// Sync-conflict rules — the contract between everything that touches a sync tool's
// leftovers: the project watcher (which must NEVER route one into a normal subsystem),
// the conflict scan, the resolver UI, and listDocuments (which must not offer one as a
// document). ONE definition, because a second copy is exactly how the supplement filter
// rotted — two regexes, silent drift, nothing to catch it.
//
// Dependency-free ESM under electron/, because the Electron main process runs unbundled
// and `src/` is excluded from the packaged app, so main can only load from here — and it
// must be ESM rather than .cjs since the renderer imports it too (Vite serves a source
// .cjs verbatim, so `module.exports` never runs in a browser). Renderer/flux-core import
// through the typed wrapper `src/lib/project/conflictRules.ts`.
//
// Syncthing names a losing copy `<base>.sync-conflict-YYYYMMDD-HHMMSS-XXXXXXX<.ext>`
// (XXXXXXX = the first 7 chars of the originating device id) and writes in-flight
// transfers as `.syncthing.<name>.tmp`. The two are treated very differently:
//   TEMP     invisible — an in-flight transfer is not an event, it is noise.
//   CONFLICT surfaced — it means two machines diverged, and the user must decide.
// A conflict copy is never silently deleted and never silently ignored: unresolved ones
// keep a banner up, because a stale conflict file is a second copy of your work that
// slowly stops matching either side.

/** `<base>.sync-conflict-<date>-<time>-<device7>` immediately before the extension (or end). */
const CONFLICT_RE = /\.sync-conflict-(\d{8})-(\d{6})-([A-Z0-9]{7})(?=\.|$)/;

/** Syncthing's in-flight transfer temp file: `.syncthing.<name>.tmp`. */
const SYNC_TEMP_RE = /(^|[/\\])\.syncthing\..*\.tmp$/;

/** Forward-slash normalize + trim trailing slashes. */
function norm(p) {
  return String(p || "")
    .replace(/\\/g, "/")
    .replace(/\/+$/, "");
}

function baseName(p) {
  const n = norm(p);
  const i = n.lastIndexOf("/");
  return i >= 0 ? n.slice(i + 1) : n;
}

/** True if this path is a sync tool's in-flight temp file — pure noise, never surfaced. */
export function isSyncTempPath(p) {
  return SYNC_TEMP_RE.test(norm(p));
}

/** True if this path is a sync-conflict copy (checked on the FILENAME, any depth). */
export function isConflictPath(p) {
  return CONFLICT_RE.test(baseName(p));
}

/** A conflict copy → the path of the file it is a copy OF (same directory).
 *  Returns "" for a path that is not a conflict copy. */
export function conflictBaseFor(p) {
  const s = norm(p);
  const name = baseName(s);
  if (!CONFLICT_RE.test(name)) return "";
  const base = name.replace(CONFLICT_RE, "");
  const i = s.lastIndexOf("/");
  return i >= 0 ? `${s.slice(0, i)}/${base}` : base;
}

/** Full detail for a conflict copy: the file it conflicts with, when the losing side was
 *  written, and which device wrote it. Null when `p` is not a conflict copy. */
export function parseConflictPath(p) {
  const name = baseName(p);
  const m = CONFLICT_RE.exec(name);
  if (!m) return null;
  const [, d, t] = m;
  return {
    base: conflictBaseFor(p),
    // YYYYMMDD-HHMMSS → an ISO-ish local stamp the UI can print without a date lib.
    when: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)} ${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4, 6)}`,
    device: m[3],
  };
}

/** Append-only NDJSON ledgers (journal, feedback) are the ONE conflict shape with a
 *  correct automatic answer: union the lines. Everything else needs a human choice. */
export function isMergeableConflict(p) {
  return /\.ndjson$/i.test(conflictBaseFor(p) || norm(p));
}

/** Union two NDJSON sides, preserving first-seen order: every line either side has, once.
 *  Order within an append-only ledger carries no meaning beyond "already recorded". */
export function mergeNdjson(mineText, theirsText) {
  const seen = new Set();
  const out = [];
  for (const chunk of [String(mineText || ""), String(theirsText || "")]) {
    for (const line of chunk.split("\n")) {
      const t = line.trim();
      if (!t || seen.has(t)) continue;
      seen.add(t);
      out.push(t);
    }
  }
  return out.length ? out.join("\n") + "\n" : "";
}

export { CONFLICT_RE, SYNC_TEMP_RE };
