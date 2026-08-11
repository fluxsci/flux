// Which paper pane is editing which document (dual-paper B4, 2026-08-11).
// Two panes on the SAME document would be two live editors + two autosave
// controllers + two comment writers against one file — the configuration that
// can actually lose writing (CodeMirror has no shared-EditorState split view
// here; that is a separate feature, deliberately refused). So documents are
// exclusive: a pane claims its document, and any request to open a claimed one
// FOCUSES the claiming pane instead — the same rule the pane gate used to
// apply to the whole mode, narrowed to the document.
//
// A registry keyed BY PANE is not a singleton: each entry is per-instance
// state; the module map only exists so instances can see each other's claims.

const claims = new Map<string, string>(); // paneId -> project-relative doc path

/** Claim `docPath` for `paneId` (replaces the pane's previous claim). */
export function claimDoc(paneId: string, docPath: string): void {
  if (paneId) claims.set(paneId, docPath);
}

/** Drop a pane's claim (PaperMode destroy). */
export function releaseDocClaim(paneId: string): void {
  claims.delete(paneId);
}

/** The pane (other than `exceptPane`) currently editing `docPath`, if any. */
export function paneEditingDoc(docPath: string, exceptPane: string): string | null {
  for (const [pane, doc] of claims) {
    if (pane !== exceptPane && doc === docPath) return pane;
  }
  return null;
}
