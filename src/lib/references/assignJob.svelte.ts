// Background "assign PDFs" job — the GUI twin of flux-core/assign.ts. A MODULE-LEVEL Svelte-5
// runes singleton (like pdfFetchJob) so a scan survives mode switches. Scans ~/FluxLib/
// pdfs_to_assign/, identifies each PDF from its content via the SHARED pure core (pdfIdentify.ts),
// and files it: attach to an existing reference lacking a PDF, discard if it already has one, or
// add the reference then attach. Unidentified PDFs move to _unresolved/ with a sidecar note.
import { fileBridge, joinPath } from "../project/types";
import { resolveFluxLibPath, loadFluxLib } from "./fluxlibBridge";
import { searchWorld } from "./enrichBridge";
import { writePdfItem, readerHasPdf } from "./itemsBridge";
import { bumpFluxLib } from "./revision";
import { isPdfBytes, bareDoi } from "./pdfFinder";
import { assignInboxDir } from "./items";
import { identify, reconcile, type IdResult, type PaperMeta, type SearchHit } from "./pdfIdentify";
import { extractPdfSignals } from "../pdf/pdfSignals";
import { addDoiToLibrary } from "../../shell/modes/paper/scholar/bibLoad";

export type AssignAction = "attached" | "added-attached" | "discarded" | "unresolved";
export interface AssignItemResult {
  file: string;
  action: AssignAction;
  key?: string;
  doi?: string;
  title?: string;
  method?: string;
  reason?: string;
}

/** Count the PDFs currently waiting in the inbox (for the Library button label). Ignores the
 *  _unresolved/ quarantine (its files are done, not pending). */
export async function countInbox(): Promise<number> {
  const fb = fileBridge();
  const lib = await resolveFluxLibPath();
  if (!fb || !lib || !fb.readdir) return 0;
  try {
    const ents = await fb.readdir(assignInboxDir(lib));
    return ents.filter((e) => !e.dir && /\.pdf$/i.test(e.name)).length;
  } catch {
    return 0;
  }
}

/** DOI → canonical metadata via Crossref (through the main process, CORS-free). */
async function resolveDoiFn(doi: string): Promise<PaperMeta | null> {
  const fb = fileBridge();
  try {
    const r = await fb?.fetchDoi?.(doi);
    const m = (r as { message?: any })?.message;
    const title = Array.isArray(m?.title) ? m.title[0] : m?.title;
    if (!m || !title) return null;
    const authors = Array.isArray(m.author)
      ? m.author.map((a: any) => [a.given, a.family].filter(Boolean).join(" ") || a.name || a.family || "").filter(Boolean)
      : [];
    const dp = m.issued?.["date-parts"]?.[0]?.[0] ?? m["published-print"]?.["date-parts"]?.[0]?.[0] ?? m["published-online"]?.["date-parts"]?.[0]?.[0];
    const container = Array.isArray(m["container-title"]) ? m["container-title"][0] : undefined;
    return { doi, title: String(title), authors, year: dp != null ? String(dp) : undefined, container };
  } catch {
    return null;
  }
}

async function searchTitleFn(query: string): Promise<SearchHit[]> {
  try {
    const briefs = await searchWorld(query, { perPage: 5 });
    return briefs.map((b) => ({ doi: b.doi, title: b.title, authors: b.authors, year: b.year || undefined, score: b.relevanceScore }));
  } catch {
    return [];
  }
}

const DEPS = { resolveDoi: resolveDoiFn, searchTitle: searchTitleFn };

class AssignJob {
  running = $state(false);
  done = $state(0);
  total = $state(0);
  attached = $state(0);
  added = $state(0);
  discarded = $state(0);
  unresolved = $state(0);
  cancelled = $state(false);
  runSeq = $state(0); // bumps once per finished run (Library keys its refresh on this)
  lastResults = $state<AssignItemResult[]>([]);

  get active() {
    return this.running;
  }
  cancel() {
    this.cancelled = true;
  }

  #reset() {
    this.done = 0;
    this.total = 0;
    this.attached = 0;
    this.added = 0;
    this.discarded = 0;
    this.unresolved = 0;
    this.cancelled = false;
  }

  /** Scan the inbox and file each PDF. Returns the per-file results. */
  async start(): Promise<AssignItemResult[]> {
    if (this.running) return [];
    const fb = fileBridge();
    const lib = await resolveFluxLibPath();
    if (!fb || !lib || !fb.readdir) return [];
    this.running = true;
    this.#reset();
    const dir = assignInboxDir(lib);
    const results: AssignItemResult[] = [];
    try {
      const names = (await fb.readdir(dir).catch(() => []))
        .filter((e) => !e.dir && /\.pdf$/i.test(e.name))
        .map((e) => e.name)
        .sort();
      this.total = names.length;

      // DOI → citekey index over the current library (updated as we add within the batch).
      const doiIndex = new Map<string, string>();
      for (const e of await loadFluxLib()) {
        const d = bareDoi(e.doi);
        if (d) doiIndex.set(d, e.key);
      }

      for (const name of names) {
        if (this.cancelled) break;
        const rec = await this.#process(fb, dir, name, doiIndex);
        results.push(rec);
        if (rec.action === "attached") this.attached++;
        else if (rec.action === "added-attached") this.added++;
        else if (rec.action === "discarded") this.discarded++;
        else this.unresolved++;
        this.done++;
      }
    } finally {
      this.lastResults = results;
      this.runSeq++;
      this.running = false;
      if (results.some((r) => r.action !== "unresolved")) bumpFluxLib(); // refresh Library/reader
    }
    return results;
  }

  async #process(fb: NonNullable<ReturnType<typeof fileBridge>>, dir: string, name: string, doiIndex: Map<string, string>): Promise<AssignItemResult> {
    const src = joinPath(dir, name);
    const rec: AssignItemResult = { file: name, action: "unresolved" };
    try {
      const buf = await fb.readFile(src);
      const bytes = new Uint8Array(buf);
      if (!isPdfBytes(bytes)) {
        rec.reason = "not a PDF (bad magic bytes)";
        await this.#quarantine(fb, dir, name, bytes, null, rec.reason);
        return rec;
      }
      const sig = await extractPdfSignals(new Uint8Array(bytes)); // fresh copy — pdf.js detaches
      const id = await identify(sig, DEPS);
      if (id.status !== "identified") {
        rec.reason = id.reason;
        await this.#quarantine(fb, dir, name, bytes, id, id.reason);
        return rec;
      }
      rec.doi = id.doi;
      rec.title = id.meta.title;
      rec.method = id.method;
      const existingKey = doiIndex.get(bareDoi(id.doi)!) ?? null;
      const already = existingKey ? await readerHasPdf(existingKey) : false;
      const action = reconcile(id, existingKey, already);
      if (action.kind === "discard") {
        rec.action = "discarded";
        rec.key = action.key;
        await fb.remove?.(src);
      } else if (action.kind === "attach") {
        rec.action = "attached";
        rec.key = action.key;
        await writePdfItem(action.key, bytes, { source: "assigned", url: name, isOa: false });
        await fb.remove?.(src);
      } else {
        const added = await addDoiToLibrary(id.doi);
        if ("error" in added) {
          rec.action = "unresolved";
          rec.reason = "couldn't create library entry: " + added.error;
          return rec; // leave the file in place to retry (identity was fine)
        }
        rec.action = "added-attached";
        rec.key = added.key;
        doiIndex.set(bareDoi(id.doi)!, added.key);
        await writePdfItem(added.key, bytes, { source: "assigned", url: name, isOa: false });
        await fb.remove?.(src);
      }
    } catch (e) {
      rec.action = "unresolved";
      rec.reason = "error: " + String((e as Error)?.message || e);
    }
    return rec;
  }

  async #quarantine(
    fb: NonNullable<ReturnType<typeof fileBridge>>,
    dir: string,
    name: string,
    bytes: Uint8Array,
    id: IdResult | null,
    note: string,
  ): Promise<void> {
    try {
      const udir = joinPath(dir, "_unresolved");
      if (fb.mkdir) await fb.mkdir(udir);
      let dst = joinPath(udir, name);
      for (let i = 2; await fb.exists(dst); i++) dst = joinPath(udir, name.replace(/\.pdf$/i, `-${i}.pdf`));
      await fb.writeFile(dst, bytes);
      await fb.remove?.(joinPath(dir, name));
      const lines = [`Could not identify "${name}" with confidence.`, `Reason: ${note}`, ""];
      if (id && id.status === "unresolved") {
        const d = id.diagnostics;
        if (d.candidates.length) lines.push("DOI candidates seen:", ...d.candidates.map((c) => `  ${c.doi} (${c.source})`));
        if (d.rejected.length) lines.push("Rejected:", ...d.rejected.map((r) => `  ${r}`));
        if (d.query) lines.push(`Title query: ${d.query}`);
        if (d.topHits?.length) lines.push("Top search hits:", ...d.topHits.map((h) => `  ${h.sim.toFixed(2)}  ${h.title}${h.doi ? `  (${h.doi})` : ""}`));
      }
      await fb.writeText(`${dst}.txt`, lines.join("\n") + "\n");
    } catch {
      /* best-effort quarantine */
    }
  }
}

export const assignJob = new AssignJob();
