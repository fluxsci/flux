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
  };
}

export interface ZoteroSyncSummary {
  added: number; // new FluxLib entries
  merged: number; // already known (DOI/signature dedupe)
  attached: number; // PDFs copied into items/<key>/
  linked: number; // PDF pointers written (attach: "link")
  failed: number; // attach attempts that found no readable file
}

/** One human line for the GUI toast AND the CLI result — shared so they can't drift. */
export function summarizeZoteroSync(s: ZoteroSyncSummary): string {
  const parts = [`${s.added} added`];
  if (s.merged) parts.push(`${s.merged} already known`);
  if (s.attached) parts.push(`${s.attached} PDF${s.attached === 1 ? "" : "s"} copied`);
  if (s.linked) parts.push(`${s.linked} PDF${s.linked === 1 ? "" : "s"} linked`);
  if (s.failed) parts.push(`${s.failed} PDF${s.failed === 1 ? "" : "s"} not found`);
  return parts.join(" · ");
}
