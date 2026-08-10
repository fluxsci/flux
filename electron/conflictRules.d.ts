// Type surface of electron/conflictRules.js. Keep in sync with its exports.

/** Matches `.sync-conflict-YYYYMMDD-HHMMSS-XXXXXXX` immediately before the extension. */
export const CONFLICT_RE: RegExp;
/** Matches a sync tool's in-flight transfer temp file (`.syncthing.<name>.tmp`). */
export const SYNC_TEMP_RE: RegExp;

/** True for an in-flight transfer temp file — noise, never surfaced to the user. */
export function isSyncTempPath(p: string): boolean;
/** True for a sync-conflict copy. Checked on the FILENAME, so it holds at any depth. */
export function isConflictPath(p: string): boolean;
/** A conflict copy → the path of the file it is a copy OF (same dir); "" if not one. */
export function conflictBaseFor(p: string): string;
/** Full detail for a conflict copy, or null when `p` is not one. */
export function parseConflictPath(
  p: string,
): { base: string; when: string; device: string } | null;
/** True when the conflicting file is an append-only NDJSON ledger — the one shape with
 *  a correct automatic answer (union the lines). */
export function isMergeableConflict(p: string): boolean;
/** Union two NDJSON sides, preserving first-seen order, deduplicated by exact line. */
export function mergeNdjson(mineText: string, theirsText: string): string;
