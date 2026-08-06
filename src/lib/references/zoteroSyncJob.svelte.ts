// Background Zotero sync job — the GUI twin of flux-core zoteroSync (references.ts).
// A MODULE-LEVEL Svelte-5 runes singleton (the assignJob pattern) so a sync survives
// mode switches. Re-imports the connected Better-BibTeX "Keep updated" auto-export
// into FluxLib: idempotent (planAdds dedupes by DOI, then signature), additive
// one-way (Zotero edits/deletions never mutate existing entries, nothing is written
// back), PDFs attach for new entries + backfill PDF-less known ones via the SHARED
// attach planner (zoteroFiles.attachCandidates — twin-engine rule).
//
// Runs: on startup (maybeAutoSync, kicked from Shell's idle warms), on the Library
// pane's "Sync now", and watcher-driven while the app is open (zoteroBibRevision —
// main watches the .bib when connected). A real run holds the FluxLib "zotero-sync"
// heartbeat lock so a concurrent CLI/MCP sync defers instead of double-importing
// (the FluxLib "library" write lock already serializes the actual append either way).
//
// NOTE: eager-import discipline (W15) — this module is reached ONLY from LibraryMode
// and from a dynamic import in Shell's idle callback; pdf.js rides the dynamic import
// inside writeLinkedPdfItem/writePdfItem. Keep it that way.
import { fileBridge, joinPath, isAbsolutePath } from "../project/types";
import { addToFluxLib, resolveFluxLibPath } from "./fluxlibBridge";
import { writePdfItem, writeLinkedPdfItem, readerHasPdf } from "./itemsBridge";
import { bibPdfAttachments, attachCandidates, attachPathCandidates } from "./zoteroFiles";
import {
  parseZoteroSettings,
  summarizeZoteroSync,
  zoteroSyncStatePath,
  parseZoteroSyncState,
  bibUnchanged,
  type ZoteroSettings,
  type ZoteroSyncState,
  type ZoteroSyncSummary,
} from "./zoteroSettings";
import { isPdfBytes } from "./pdfFinder";
import { bumpFluxLib, zoteroBibRevision } from "./revision";
import { pushToast } from "../toast";

export interface ZoteroSyncRun {
  at: string; // ISO
  summary: ZoteroSyncSummary;
  line: string;
  error?: string;
}

class ZoteroSyncJob {
  running = $state(false);
  settings = $state<ZoteroSettings | null>(null); // null = not connected
  settingsLoaded = $state(false);
  lastRun = $state<ZoteroSyncRun | null>(null);
  runSeq = $state(0); // bumps once per finished run (Library keys its refresh on this)

  /** Load (or reload) the machine `zotero` settings into state. */
  async loadSettings(): Promise<ZoteroSettings | null> {
    const fb = fileBridge();
    if (!fb?.prefsGet) {
      this.settingsLoaded = true;
      return null;
    }
    try {
      const prefs = await fb.prefsGet();
      this.settings = parseZoteroSettings(prefs?.zotero);
    } catch {
      this.settings = null;
    }
    this.settingsLoaded = true;
    return this.settings;
  }

  /** Persist new settings (connect / edit) and adopt them immediately. */
  async saveSettings(next: ZoteroSettings): Promise<void> {
    const fb = fileBridge();
    if (fb?.prefsSet) await fb.prefsSet({ zotero: next });
    this.settings = next;
    this.settingsLoaded = true;
  }

  /** Disconnect: clear the stored settings (FluxLib content is untouched). */
  async disconnect(): Promise<void> {
    const fb = fileBridge();
    if (fb?.prefsSet) await fb.prefsSet({ zotero: null });
    this.settings = null;
  }

  /** Startup entry (Shell idle): sync when connected + auto is on. Quiet on no-op. */
  async maybeAutoSync(): Promise<void> {
    const s = this.settings ?? (await this.loadSettings());
    if (s && s.auto) await this.sync({ quietWhenClean: true });
  }

  /** One sync pass. `quietWhenClean` suppresses the toast when nothing changed
   *  (startup/watcher runs — silence is golden on a no-op). `force` (Sync now)
   *  bypasses the stat short-circuit — a forced pass can also pick up attach
   *  backfill for a PDF that appeared on disk without a bib rewrite. */
  async sync(opts: { quietWhenClean?: boolean; force?: boolean } = {}): Promise<ZoteroSyncRun | null> {
    if (this.running) return null;
    const fb = fileBridge();
    const s = this.settings ?? (await this.loadSettings());
    if (!fb || !s) return null;
    // The short-circuit: automatic passes skip everything when the export's stat
    // fingerprint matches the last successful sync (one ~0.05ms stat instead of
    // re-parsing a possibly-huge bib — see zoteroSettings.ts). Stat unavailable
    // (memBridge) → just sync.
    if (!opts.force && fb.stat) {
      try {
        const [st, lib] = await Promise.all([fb.stat(s.bibPath), resolveFluxLibPath()]);
        if (st && lib) {
          const state = parseZoteroSyncState(await fb.readText(zoteroSyncStatePath(lib)).catch(() => ""));
          if (bibUnchanged(state, s.bibPath, st.size, st.mtimeMs)) return null; // silent no-op
        }
      } catch {
        /* stat/state hiccup — proceed with a full sync */
      }
    }
    // Cross-engine coordination: refuse to race a CLI/MCP sync; hold a heartbeat lock.
    const got = await fb.lockAcquire?.("fluxlib", "zotero-sync");
    if (got && !got.ok) {
      pushToast("info", "Zotero sync deferred", { detail: `a sync is already running in ${got.heldBy ?? "another session"}` });
      return null;
    }
    await fb.lockSet?.("zotero-sync", true, "fluxlib");
    this.running = true;
    const run: ZoteroSyncRun = { at: new Date().toISOString(), summary: { added: 0, merged: 0, attached: 0, linked: 0, failed: 0 }, line: "" };
    try {
      // Pre-read stat for the success stamp (a rewrite landing mid-sync can only make
      // the next pass re-run, never be missed — same discipline as flux-core).
      const preStat = await fb.stat?.(s.bibPath).catch(() => null);
      let text: string;
      try {
        text = await fb.readText(s.bibPath);
      } catch {
        throw new Error(`couldn't read ${s.bibPath} — is the Better BibTeX "Keep updated" export still in place?`);
      }
      const res = await addToFluxLib(text, { source: "bibtex" });
      run.summary.added = res.added.length;
      run.summary.merged = res.deduped.length;

      // PDFs: new entries always; merged entries only when they have no PDF/pointer yet.
      const needsPdf = new Set<string>();
      for (const d of res.deduped) if (!(await readerHasPdf(d.key))) needsPdf.add(d.key);
      const candidates = attachCandidates(text, res.added, res.deduped, needsPdf);
      const baseDir = s.bibPath.replace(/[/\\][^/\\]*$/, "");
      const deferred = s.attach === "link" && s.deferFulltext;
      for (const { key, raw } of candidates) {
        const atts = bibPdfAttachments(raw);
        if (!atts.length) continue;
        const paths = attachPathCandidates(atts[0].path, {
          baseDir,
          zoteroDir: s.dataDir,
          isAbsolute: isAbsolutePath,
          join: joinPath,
        });
        if (deferred) {
          // Stat-only pointer write — never read the linked file at sync time (the
          // huge-library posture; text backfills on first reader open). Twin of the
          // flux-core deferFulltext branch.
          let resolved = "";
          for (const p of paths) {
            try {
              if (await fb.exists(p)) {
                resolved = p;
                break;
              }
            } catch {
              /* try the next candidate */
            }
          }
          if (resolved && (await writeLinkedPdfItem(key, resolved))) run.summary.linked++;
          else run.summary.failed++;
          continue;
        }
        let bytes: Uint8Array | null = null;
        let resolved = "";
        for (const p of paths) {
          try {
            const buf = await fb.readFile(p);
            bytes = new Uint8Array(buf);
            resolved = p;
            break;
          } catch {
            /* try the next candidate */
          }
        }
        if (!bytes || !isPdfBytes(bytes)) {
          run.summary.failed++;
          continue;
        }
        if (s.attach === "link") {
          if (await writeLinkedPdfItem(key, resolved, bytes)) run.summary.linked++;
          else run.summary.failed++;
        } else {
          if ((await writePdfItem(key, bytes, { source: "ingest", url: resolved })).ok) run.summary.attached++;
          else run.summary.failed++;
        }
      }
      run.line = summarizeZoteroSync(run.summary);
      // Stamp the fingerprint so the next automatic pass can short-circuit
      // (best-effort — a lost stamp only costs one extra full sync).
      if (preStat) {
        try {
          const lib = await resolveFluxLibPath();
          if (lib) {
            const state: ZoteroSyncState = { bibPath: s.bibPath, size: preStat.size, mtimeMs: preStat.mtimeMs, at: run.at };
            await fb.writeText(zoteroSyncStatePath(lib), JSON.stringify(state, null, 2) + "\n");
          }
        } catch {
          /* best-effort */
        }
      }
      const activity = run.summary.added || run.summary.attached || run.summary.linked || run.summary.failed;
      if (activity || !opts.quietWhenClean) {
        pushToast(run.summary.failed ? "info" : "success", "Zotero sync", { detail: run.line });
      }
      if (run.summary.attached || run.summary.linked) bumpFluxLib(); // refresh PDF pills/reader
    } catch (e) {
      run.error = e instanceof Error ? e.message : String(e);
      run.line = "sync failed";
      pushToast("error", "Zotero sync failed", { detail: run.error });
    } finally {
      await fb.lockSet?.("zotero-sync", false, "fluxlib").catch(() => {});
      this.lastRun = run;
      this.runSeq++;
      this.running = false;
    }
    return run;
  }
}

export const zoteroSyncJob = new ZoteroSyncJob();

// Watcher-driven re-sync: Better BibTeX rewrote the connected .bib (with a project
// open, so the chokidar watcher is running) → sync ~1.5s later. Guarded: never while
// a sync runs, only when connected + auto (the assignJob debounce pattern).
let bibDebounce: ReturnType<typeof setTimeout> | null = null;
let seenBibRev = 0;
zoteroBibRevision.subscribe((n) => {
  if (n === 0 || n === seenBibRev) return; // skip the subscribe replay
  seenBibRev = n;
  if (bibDebounce) clearTimeout(bibDebounce);
  bibDebounce = setTimeout(() => {
    bibDebounce = null;
    if (!zoteroSyncJob.running && zoteroSyncJob.settings?.auto) void zoteroSyncJob.sync({ quietWhenClean: true });
  }, 1500);
});
