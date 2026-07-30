// Zotero sync settings + report summary — the shared PURE core of the Zotero
// integration (twin-engine rule, guide §2). Both engines read/write the SAME
// `zotero` object in machine preferences.json (renderer via prefs:get/set IPC,
// flux-core via getPreferences/setPreferences), and both render sync results
// through summarizeZoteroSync so the GUI toast and the CLI line can never drift.
//
// The scheme: the user exports their Zotero library ONCE with Better BibTeX's
// "Keep updated" auto-export; BBT rewrites that .bib on every Zotero change;
// Flux re-imports it (idempotent — planAdds dedupes by DOI, then signature) on
// startup / on demand / when the watcher sees the file change. Additive one-way:
// Zotero edits/deletions never mutate existing FluxLib entries, and nothing is
// written back to Zotero.

export interface ZoteroSettings {
  bibPath: string; // absolute path of the BBT auto-export .bib
  dataDir?: string; // Zotero data folder (its storage/ holds the PDFs); optional
  attach: "copy" | "link"; // copy PDFs into FluxLib (self-contained) or link to Zotero's copies
  auto: boolean; // sync on startup + live while the app is open
  // Link mode only: skip reading the PDF at sync time (no byte read, no upfront
  // full-text extraction — the pointer is written from a stat alone). Text backfills
  // lazily: the reader extracts on first open, and agents hit getOrExtractFulltext.
  // The default for HUGE exports (see isBigBib), where reading every linked file
  // once — e.g. through a cloud-mounted Zotero folder — would make the first sync
  // an hours-long streaming job.
  deferFulltext: boolean;
}

/** Validate the raw `zotero` preferences value. null = not configured (or malformed —
 *  treated identically so a hand-edited prefs file can never crash the sync path). */
export function parseZoteroSettings(raw: unknown): ZoteroSettings | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.bibPath !== "string" || !o.bibPath.trim()) return null;
  return {
    bibPath: o.bibPath,
    dataDir: typeof o.dataDir === "string" && o.dataDir.trim() ? o.dataDir : undefined,
    attach: o.attach === "link" ? "link" : "copy",
    auto: o.auto !== false,
    deferFulltext: o.deferFulltext === true,
  };
}

/** A "big" export — above this the connect dialog suggests link mode + deferred
 *  full-text. ~5MB ≈ 3–4k entries of typical BBT output (abstracts included). */
export const BIG_BIB_BYTES = 5_000_000;

export const isBigBib = (bytes: number): boolean => bytes >= BIG_BIB_BYTES;

/** Rough entry count from the file size — a UI hint only ("≈ 12,000 references").
 *  Real BBT entries run ~1–2KB; 1.5KB keeps the estimate honest either way. */
export const estimateBibEntries = (bytes: number): number => Math.max(1, Math.round(bytes / 1500));

export interface ZoteroSyncSummary {
  added: number; // new FluxLib entries
  merged: number; // already known (DOI/signature dedupe)
  attached: number; // PDFs copied into items/<key>/
  linked: number; // PDF pointers written (attach: "link")
  failed: number; // attach attempts that found no readable file
}

// ---------------------------------------------------------------------------------
// The no-change short-circuit. After each successful sync, both engines stamp the
// export's stat fingerprint into <FluxLib>/.fluxlib/zotero-sync.json (derived,
// rebuildable — losing it just means one extra full sync). AUTOMATIC syncs (startup,
// watcher) stat the export first and skip everything when the fingerprint matches:
// a ~0.05ms stat instead of re-parsing a possibly-huge bib to conclude "0 added".
// USER-invoked syncs (Sync now, CLI --force) always run fully — a forced pass can
// pick up attach-backfill for a PDF that appeared on disk without a bib rewrite.
// Safe in both directions: any BBT rewrite changes mtime (no false skip), and a
// wrong "changed" verdict merely costs today's behavior (a full, idempotent sync).
// ---------------------------------------------------------------------------------

export interface ZoteroSyncState {
  bibPath: string; // which export this fingerprint belongs to
  size: number; // bytes at last successful sync
  mtimeMs: number; // mtime at last successful sync
  at: string; // ISO of that sync
}

/** Path of the state file (POSIX-joined, both engines accept it). */
export const zoteroSyncStatePath = (lib: string): string => `${lib}/.fluxlib/zotero-sync.json`;

/** Parse a state file body; null on anything malformed (treated as "never synced"). */
export function parseZoteroSyncState(text: string): ZoteroSyncState | null {
  try {
    const j = JSON.parse(text) as ZoteroSyncState;
    return j && typeof j.bibPath === "string" && typeof j.size === "number" && typeof j.mtimeMs === "number" ? j : null;
  } catch {
    return null;
  }
}

/** True when the export is byte-for-byte the one already synced (same file, same
 *  size, same mtime — any BBT rewrite moves the mtime). */
export function bibUnchanged(state: ZoteroSyncState | null, bibPath: string, size: number, mtimeMs: number): boolean {
  return !!state && state.bibPath === bibPath && state.size === size && state.mtimeMs === mtimeMs;
}

/** The line both surfaces show for a short-circuited sync. */
export const ZOTERO_UP_TO_DATE = "already up to date (export unchanged)";

/** One human line for the GUI toast AND the CLI result — shared so they can't drift. */
export function summarizeZoteroSync(s: ZoteroSyncSummary): string {
  const parts = [`${s.added} added`];
  if (s.merged) parts.push(`${s.merged} already known`);
  if (s.attached) parts.push(`${s.attached} PDF${s.attached === 1 ? "" : "s"} copied`);
  if (s.linked) parts.push(`${s.linked} PDF${s.linked === 1 ? "" : "s"} linked`);
  if (s.failed) parts.push(`${s.failed} PDF${s.failed === 1 ? "" : "s"} not found`);
  return parts.join(" · ");
}
