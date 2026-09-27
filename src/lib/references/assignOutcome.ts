// Shared by BOTH assign engines (flux-core/assign.ts, assignJob.svelte.ts): when filing a
// PDF fails, is that a network blink worth a silent retry, or a fault the user must see?
//
// Before 2026-09-26 every exception was reported as "deferred (network)". The owner's
// real inbox then sat unfiled for a day behind "network unavailable" while the network
// was fine — the actual cause was a Syncthing conflict copy beside library.bib, which the
// fortified add path refuses to write over. A fault labelled as weather never gets fixed.
//
// Transient = the request itself could not complete (offline, timeouts, 429/5xx). Anything
// else — a refused write, a lock lost, a malformed file, a bug — is an ERROR: the file stays
// in the inbox exactly like a deferral (never destructive), but the scan says why.

const TRANSIENT_RE =
  /\b(?:fetch failed|network|ECONN\w*|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|socket hang up|timed? ?out|offline|empty response|HTTP (?:408|425|429|5\d\d)|crossref HTTP (?:408|429|5\d\d)|doi\.org HTTP (?:408|429|5\d\d)|DOI fetch (?:408|429|5\d\d))\b/i;

/** True when `message` describes a failure that a later retry can plausibly clear. */
export function isTransientFailure(message: string): boolean {
  return TRANSIENT_RE.test(String(message || ""));
}

/** The per-file outcome for a failure message: "deferred" (retry later) or "error" (show it). */
export function failureAction(message: string): "deferred" | "error" {
  return isTransientFailure(message) ? "deferred" : "error";
}

/** This many consecutive transient results aborts a scan — we are offline. */
export const OFFLINE_BREAKER = 3;
/** This many consecutive ERRORS aborts a scan — something systemic (a refused library
 *  write, a lost lock) is failing every file, and grinding on would only repeat it. */
export const ERROR_BREAKER = 3;

/** A library write refused because a sync tool left a conflict copy beside library.bib.
 *  The Library banner resolves it; the assign summary points there instead of at the network. */
export function isLibraryConflictFailure(message: string): boolean {
  return /canonical sync conflict/i.test(String(message || ""));
}
