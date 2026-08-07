// Web capture, receiving end. The bookmarklet (src/shell/modes/library/bookmarklet.ts)
// downloads `flux-<slug>.pdf` or `flux-<slug>.fluxcap` into the browser's download folder;
// main watches that folder and emits an fs:changed "capture" event; this decides what happens.
//
// THE FILE WORK IS MAIN'S, not ours: fsGuard deliberately refuses $HOME, so the renderer
// cannot read or move anything out of the download folder — and widening that guard would
// trade a real security boundary for convenience. `captureIntake()` moves captured PDFs into
// pdfs_to_assign/ and hands back the sidecars; this module only resolves those and reports.
//
// A captured PDF is deliberately NOT identified here. It goes into pdfs_to_assign/, which
// already owns that job and does it well — identify from the document's own content (embedded
// DOI → page-1 DOI → references → fuzzy title; measured 92% attach, zero misassignments). The
// landing bumps assignInboxRevision, so the existing auto-scan takes it from there. One
// pipeline, not two. A `.fluxcap` has no bytes to identify, so it resolves by DOI (else URL)
// through the same add path the Library's input box uses.
import { fileBridge } from "../project/types";
import { parseFluxCapture, parseSupplementCapture, doiFromSlug } from "./capture";
import { resolveFluxLibPath, loadFluxLib } from "./fluxlibBridge";
import { assignInboxDir } from "./items";
import { fileSupplementBytes } from "./itemsBridge";
import { bareDoi } from "./pdfFinder";
import { bumpAssignInbox, fluxLibRevision } from "./revision";
import { captureStatus } from "./captureStatus";

/** Where main stages captured supplements until their paper has a citekey. */
const STAGING = "_captured_supplements";

export interface CaptureResult {
  file: string;
  action: "queued" | "added" | "filed" | "waiting" | "failed";
  detail?: string;
}

/**
 * File staged supplements against their paper.
 *
 * A supplement is captured in the same click as its article, but it can't be filed until that
 * article has a citekey — which happens only after the assign scan identifies it. So each pass
 * files what it can and LEAVES the rest: a supplement whose paper isn't in the library yet is
 * simply picked up next time, once it is.
 */
async function fileStagedSupplements(out: CaptureResult[]): Promise<void> {
  const fb = fileBridge();
  const lib = await resolveFluxLibPath();
  if (!fb?.readdir || !lib) return;
  const dir = `${assignInboxDir(lib)}/${STAGING}`;
  let names: string[] = [];
  try {
    names = (await fb.readdir(dir)).filter((e) => !e.dir).map((e) => e.name);
  } catch {
    return; // no staging dir yet
  }
  if (!names.length) return;
  const entries = await loadFluxLib();
  const byDoi = new Map(entries.flatMap((e) => (bareDoi(e.doi) ? [[bareDoi(e.doi) as string, e.key] as [string, string]] : [])));
  for (const file of names) {
    const parsed = parseSupplementCapture(file.replace(/^\d+-(?=flux-supp-)/, ""));
    const doi = parsed ? doiFromSlug(parsed.slug) : "";
    const key = doi ? byDoi.get(doi.toLowerCase()) ?? byDoi.get(doi) : undefined;
    if (!parsed || !key) {
      out.push({ file, action: "waiting", detail: doi ? `no library entry for ${doi} yet` : "unrecognized name" });
      continue; // left in place on purpose — the paper may arrive on the next assign scan
    }
    try {
      const bytes = new Uint8Array((await fb.readFile(`${dir}/${file}`)) as ArrayBuffer);
      const stored = await fileSupplementBytes(key, parsed.name, bytes, { url: "", source: "capture" });
      if (!stored) {
        out.push({ file, action: "failed", detail: "could not write the supplement" });
        continue;
      }
      await fb.remove?.(`${dir}/${file}`);
      out.push({ file, action: "filed", detail: `${key}/${stored}` });
    } catch (e) {
      out.push({ file, action: "failed", detail: e instanceof Error ? e.message : String(e) });
    }
  }
}

let running = false;
let pending = false;

/**
 * File every capture waiting in the download folder.
 *
 * Serialized: a burst of downloads (or a watcher event mid-run) coalesces into one more pass
 * rather than racing. Never throws — a sidecar that fails to resolve is LEFT IN PLACE and
 * reported, so nothing the user captured disappears silently.
 */
export async function runCaptureIntake(): Promise<CaptureResult[]> {
  if (running) {
    pending = true;
    return [];
  }
  running = true;
  const out: CaptureResult[] = [];
  try {
    do {
      pending = false;
      const fb = fileBridge();
      if (!fb?.captureIntake) break;
      const { pdfs, sidecars, supplements } = await fb.captureIntake();
      // Staged supplements from an EARLIER pass may now be fileable even when nothing new
      // arrived, so this runs whenever we're woken.
      await fileStagedSupplements(out);
      if (!pdfs.length && !sidecars.length && !supplements.length) break;

      const total = pdfs.length + sidecars.length + supplements.length;
      captureStatus.show("busy", total === 1 ? "Filing capture…" : `Filing ${total} captures…`);
      for (const name of pdfs) out.push({ file: name, action: "queued" });
      if (pdfs.length) bumpAssignInbox(); // wakes the assign auto-scan, which does the matching

      for (const { name, json } of sidecars) {
        const cap = parseFluxCapture(json);
        if (!cap) {
          out.push({ file: name, action: "failed", detail: "unreadable capture file" });
          continue; // left in place on purpose — a bad file shouldn't vanish
        }
        try {
          const { addUrlOrDoiToLibrary } = await import("../../shell/modes/paper/scholar/bibLoad");
          const r = await addUrlOrDoiToLibrary(cap.doi || cap.url);
          if ("error" in r) {
            out.push({ file: name, action: "failed", detail: r.error });
            continue; // keep it: the user can retry, or add it by hand
          }
          out.push({ file: name, action: "added", detail: r.title || r.key });
          await fb.captureDiscard?.(name);
        } catch (e) {
          out.push({ file: name, action: "failed", detail: e instanceof Error ? e.message : String(e) });
        }
      }
    } while (pending);
  } finally {
    running = false;
  }
  report(out);
  return out;
}

function report(rows: CaptureResult[]): void {
  if (!rows.length) return captureStatus.clear();
  const queued = rows.filter((r) => r.action === "queued").length;
  const added = rows.filter((r) => r.action === "added").length;
  const filed = rows.filter((r) => r.action === "filed").length;
  const waiting = rows.filter((r) => r.action === "waiting").length;
  const failed = rows.filter((r) => r.action === "failed");
  if (!queued && !added && !filed && !failed.length) return captureStatus.clear(); // only waiting
  if (failed.length && !queued && !added) {
    captureStatus.show("err", `Couldn't file ${failed.length === 1 ? "that capture" : `${failed.length} captures`} — ${failed[0].detail ?? "unknown error"}`, 6000);
    return;
  }
  const bits: string[] = [];
  // A queued PDF is not matched to a reference yet — the assign scan does that next and
  // reports it itself. Claiming more than happened would be a lie by one step.
  if (queued) bits.push(`${queued} PDF${queued === 1 ? "" : "s"} queued for matching`);
  if (added) bits.push(`${added} reference${added === 1 ? "" : "s"} added`);
  if (filed) bits.push(`${filed} supplementary file${filed === 1 ? "" : "s"} filed`);
  if (waiting) bits.push(`${waiting} awaiting their paper`);
  if (failed.length) bits.push(`${failed.length} failed`);
  captureStatus.show(failed.length ? "err" : "ok", `Captured: ${bits.join(", ")}`, 4200);
}

// A supplement captured alongside its article often arrives BEFORE that article has a
// citekey — the assign scan has to identify it first. FluxLib bumps whenever a paper is added
// or a PDF attached, so that bump is exactly the moment a waiting supplement may become
// fileable. Debounced, and cheap when there's nothing staged (one readdir on an empty dir).
let sweepTimer: ReturnType<typeof setTimeout> | undefined;
let firstBump = true;
fluxLibRevision.subscribe(() => {
  if (firstBump) {
    firstBump = false; // stores fire on subscribe; that's not a change
    return;
  }
  clearTimeout(sweepTimer);
  sweepTimer = setTimeout(() => void runCaptureIntake(), 800);
});

/**
 * Start watching for captures. Call once, as soon as the bridge exists.
 *
 * The file watcher alone is NOT enough, for two reasons that both bit in real use:
 *   • it runs with `ignoreInitial`, so anything captured while Flux was CLOSED is invisible to
 *     it — the common case, since you capture in the browser and open Flux later;
 *   • it only exists while a project is open, so captures made on Home were never seen.
 * A sweep on startup and on window focus covers both, and focus is the natural moment anyway:
 * you click the extension in your browser, switch back to Flux, and the files are already in.
 */
export function startCaptureWatch(): void {
  if (watching) return;
  watching = true;
  void runCaptureIntake(); // whatever arrived while Flux was closed
  let focusTimer: ReturnType<typeof setTimeout> | undefined;
  const onFocus = () => {
    clearTimeout(focusTimer);
    focusTimer = setTimeout(() => void runCaptureIntake(), 250);
  };
  window.addEventListener("focus", onFocus);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) onFocus();
  });
}
let watching = false;
