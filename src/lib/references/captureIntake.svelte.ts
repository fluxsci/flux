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
import { parseFluxCapture } from "./capture";
import { bumpAssignInbox } from "./revision";
import { captureStatus } from "./captureStatus";

export interface CaptureResult {
  file: string;
  action: "queued" | "added" | "failed";
  detail?: string;
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
      const { pdfs, sidecars } = await fb.captureIntake();
      if (!pdfs.length && !sidecars.length) break;

      const total = pdfs.length + sidecars.length;
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
  const failed = rows.filter((r) => r.action === "failed");
  if (failed.length && !queued && !added) {
    captureStatus.show("err", `Couldn't file ${failed.length === 1 ? "that capture" : `${failed.length} captures`} — ${failed[0].detail ?? "unknown error"}`, 6000);
    return;
  }
  const bits: string[] = [];
  // A queued PDF is not matched to a reference yet — the assign scan does that next and
  // reports it itself. Claiming more than happened would be a lie by one step.
  if (queued) bits.push(`${queued} PDF${queued === 1 ? "" : "s"} queued for matching`);
  if (added) bits.push(`${added} reference${added === 1 ? "" : "s"} added`);
  if (failed.length) bits.push(`${failed.length} failed`);
  captureStatus.show(failed.length ? "err" : "ok", `Captured: ${bits.join(", ")}`, 4200);
}
