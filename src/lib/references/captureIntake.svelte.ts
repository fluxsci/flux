// Web capture, receiving end. The bookmarklet (src/shell/modes/library/bookmarklet.ts)
// downloads `flux-<slug>.pdf` or `flux-<slug>.fluxcap` into the browser's download folder;
// this module pulls those files in and files them.
//
// WHEN IT RUNS — exactly two moments, both the user's: app startup, and the Library's
// "Assign PDFs" button. It is deliberately NOT ambient. It used to also fire on every window
// focus, on every FluxLib change, and on every watcher event, so files left the user's
// download folder at moments they hadn't asked for and couldn't predict. The watcher still
// reports captures landing, but only to refresh `captureWaiting` — a COUNT, so the button can
// say how many are there. Nothing moves until it's clicked.
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
import { writable } from "svelte/store";
import { fileBridge } from "../project/types";
import { parseFluxCapture, parseSupplementCapture, doiFromSlug, captureSlug } from "./capture";
import { resolveFluxLibPath, loadFluxLib } from "./fluxlibBridge";
import { assignInboxDir } from "./items";
import { fileSupplementBytes } from "./itemsBridge";
import { bareDoi } from "./pdfFinder";
import { bumpAssignInbox, fluxLibRevision } from "./revision";
import { captureStatus, markCaptured } from "./captureStatus";

/** Where main stages captured supplements until their paper has a citekey. */
const STAGING = "_captured_supplements";

/**
 * A DEFINITIVE failure (the server answered — `HTTP 403`, `HTTP 404`) will fail identically
 * forever, so retrying it is pure noise: the sidecar re-failed on every startup and every
 * window focus, toasting each time. A TRANSIENT one (offline, timeout) deserves another go.
 * Same rule the OA waterfall uses (`isTransientErr` in pdfFinderBridge) — an `HTTP <status>`
 * means the request completed and the answer was no.
 */
const isDefinitive = (err?: string): boolean => /^HTTP \d/.test(String(err ?? ""));

export interface CaptureResult {
  file: string;
  action: "queued" | "added" | "filed" | "waiting" | "failed";
  detail?: string;
}

/**
 * How many captures are sitting in the download folder waiting to be pulled in.
 *
 * Display only, and read-only on disk — the Library folds it into the Assign button's count so
 * the button can offer the work without anything having happened yet. Refreshed when the
 * watcher sees a capture land, when the Library mounts, and after every pass.
 */
export const captureWaiting = writable(0);

export async function refreshCaptureWaiting(): Promise<number> {
  const n = (await fileBridge()?.captureCount?.().catch(() => 0)) ?? 0;
  captureWaiting.set(n);
  return n;
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
  // MATCH IN THE LOSSY SPACE, don't try to invert it. `captureSlug` maps every run of unusual
  // characters to one "_", so it is not reversible: 10.1093/jcr/ucy008 and 10.1093/jcr_ucy008
  // both slug to `10.1093_jcr_ucy008`, and `doiFromSlug`'s first-underscore-is-the-slash guess
  // returns neither. That silently stranded every supplement whose paper has a slash in its DOI
  // suffix — 61 of the 1627 DOIs in the author's own library. Slugging BOTH sides is exact.
  // Case: the library side is lowercased by bareDoi, the producer's side keeps the publisher's
  // (`10.48550/arXiv.…`), so the join is case-insensitive.
  const bySlug = new Map<string, string | null>();
  for (const e of entries) {
    const d = bareDoi(e.doi);
    if (!d) continue;
    const s = captureSlug(d).toLowerCase();
    // Two papers whose DOIs slug alike is vanishingly unlikely, but filing a supplement under
    // the wrong paper is not a mistake worth risking: refuse rather than guess.
    bySlug.set(s, bySlug.has(s) ? null : e.key);
  }
  for (const file of names) {
    const parsed = parseSupplementCapture(file.replace(/^\d+-(?=flux-supp-)/, ""));
    const key = parsed ? bySlug.get(parsed.slug.toLowerCase()) ?? undefined : undefined;
    if (!parsed || !key) {
      // doiFromSlug is best-effort and only used to WORD this message, never to match.
      const label = parsed ? doiFromSlug(parsed.slug) || parsed.slug : "";
      out.push({ file, action: "waiting", detail: label ? `no library entry for ${label} yet` : "unrecognized name" });
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
/** A pass asked for while one was running. `true` if that follow-up must also pull downloads. */
let queued: boolean | null = null;

/**
 * Pull in every capture waiting in the download folder and file it.
 *
 * USER-INITIATED ONLY — startup or the Library's Assign button. This is the one call that
 * moves files out of the user's downloads; see the module header for why nothing else may
 * trigger it. Never throws: a sidecar that fails to resolve is LEFT IN PLACE and reported, so
 * nothing the user captured disappears silently.
 */
export const runCaptureIntake = (): Promise<CaptureResult[]> => pass(true);

/**
 * File staged supplements whose paper has just arrived, and nothing else.
 *
 * A supplement is captured in the same click as its article but can only be filed once the
 * assign scan has given that article a citekey — which is usually a minute AFTER the pass that
 * pulled it in. So a FluxLib change wakes this. It touches only FluxLib's own staging folder;
 * the download folder is not read, and no file moves out of it.
 */
export const sweepStagedSupplements = (): Promise<CaptureResult[]> => pass(false);

/**
 * One filing pass, serialized: a second request mid-run coalesces into a single follow-up
 * rather than racing over the same staging folder.
 */
async function pass(pullDownloads: boolean): Promise<CaptureResult[]> {
  if (running) {
    queued = (queued ?? false) || pullDownloads;
    return [];
  }
  running = true;
  const out: CaptureResult[] = [];
  try {
    for (let pull = pullDownloads; ; ) {
      queued = null;
      const fb = fileBridge();
      if (!fb) break;
      const { pdfs, sidecars, supplements } = pull && fb.captureIntake ? await fb.captureIntake() : EMPTY_INTAKE;
      // Staged supplements from an EARLIER pass may now be fileable even when nothing new
      // arrived, so this runs on every pass, pull or not.
      await fileStagedSupplements(out);
      if (pdfs.length || sidecars.length || supplements.length) {
        const total = pdfs.length + sidecars.length + supplements.length;
        captureStatus.show("busy", total === 1 ? "Filing capture…" : `Filing ${total} captures…`);
        for (const name of pdfs) out.push({ file: name, action: "queued" });
        markCaptured(); // proof of life for the setup panel
        if (pdfs.length) bumpAssignInbox(); // wakes the assign scan, which does the matching

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
              // Definitive: set it aside with a note rather than re-failing on every launch.
              // Transient: leave it in place and try again next time.
              if (isDefinitive(r.error)) await fb.capturePark?.(name, r.error ?? "could not be resolved");
              continue;
            }
            out.push({ file: name, action: "added", detail: r.title || r.key });
            await fb.captureDiscard?.(name);
          } catch (e) {
            out.push({ file: name, action: "failed", detail: e instanceof Error ? e.message : String(e) });
          }
        }
      }
      if (queued === null) break;
      pull = queued;
    }
  } finally {
    running = false;
  }
  report(out);
  void refreshCaptureWaiting(); // whatever we took is no longer waiting
  return out;
}

const EMPTY_INTAKE = { pdfs: [] as string[], sidecars: [] as { name: string; json: string }[], supplements: [] as string[] };

function report(rows: CaptureResult[]): void {
  if (!rows.length) return captureStatus.clear();
  const queued = rows.filter((r) => r.action === "queued").length;
  const added = rows.filter((r) => r.action === "added").length;
  const filed = rows.filter((r) => r.action === "filed").length;
  const waiting = rows.filter((r) => r.action === "waiting").length;
  const failed = rows.filter((r) => r.action === "failed");
  if (!queued && !added && !filed && !failed.length) return captureStatus.clear(); // only waiting
  if (failed.length && !queued && !added) {
    const one = failed.length === 1;
    const why = failed[0].detail ?? "unknown error";
    const parked = isDefinitive(why) ? " — set aside in pdfs_to_assign/_unresolved" : "";
    captureStatus.show("err", `Couldn't file ${one ? "that capture" : `${failed.length} captures`} — ${why}${parked}`, 6000);
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
// fileable. This is the STAGING sweep only: the files involved are already inside FluxLib,
// pulled in by an earlier user-initiated pass, so finishing the job they started isn't the
// ambient download-folder access the manual-only rule exists to prevent. Debounced, and cheap
// when there's nothing staged (one readdir on an empty dir).
let sweepTimer: ReturnType<typeof setTimeout> | undefined;
let firstBump = true;
fluxLibRevision.subscribe(() => {
  if (firstBump) {
    firstBump = false; // stores fire on subscribe; that's not a change
    return;
  }
  clearTimeout(sweepTimer);
  sweepTimer = setTimeout(() => void sweepStagedSupplements(), 800);
});

/**
 * Pull in whatever was captured while Flux was closed. Call once, as soon as the bridge exists.
 *
 * This is the startup half of the manual-only rule, and it's the important half: you capture in
 * the browser and open Flux later, so the common case is a folder full of captures made while
 * the app wasn't running. The other half is the Library's Assign button. Nothing else pulls.
 */
export function captureIntakeOnStartup(): void {
  if (started) return;
  started = true;
  void runCaptureIntake();
}
let started = false;
