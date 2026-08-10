// Typed re-export of the shared sync-conflict rules. The rules themselves live in
// electron/conflictRules.js — see that file for why they sit outside src/ (the Electron main
// process routes watcher events with the SAME module, so the watcher's exclusion, the scan,
// the resolver and listDocuments can never drift apart).
export {
  CONFLICT_RE,
  SYNC_TEMP_RE,
  isSyncTempPath,
  isConflictPath,
  conflictBaseFor,
  parseConflictPath,
  isMergeableConflict,
  mergeNdjson,
} from "../../../electron/conflictRules.js";

/** One unresolved conflict copy, as reported by the main-process scan. */
export interface SyncConflict {
  /** Project-relative path of the conflict COPY. */
  rel: string;
  /** Project-relative path of the file it conflicts with (may no longer exist). */
  base: string;
  /** Local timestamp the losing side was written, "YYYY-MM-DD HH:MM:SS". */
  when: string;
  /** First 7 chars of the device id that wrote the losing side. */
  device: string;
  /** True when the base file is still present (a deleted base means "restore or discard"). */
  baseExists: boolean;
  /** True when both sides are byte-identical — nothing was actually lost. */
  identical: boolean;
  /** Append-only ledger → offer Merge. */
  mergeable: boolean;
  size: number;
}
