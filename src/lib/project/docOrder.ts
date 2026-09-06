// ---------------------------------------------------------------------------
// Document ORDER — the one shared core behind the Paper rail's Documents list.
//
// A project's documents are DISCOVERED (main + supplementary + a scan of
// manuscript/** and Context/**), so their list order has to be decided rather
// than read off a file. That decision lives here, once, because both engines
// list documents: the GUI (`paper/documents/documents.ts`) and flux-core
// (`manuscript.ts listDocuments`, which the CLI/MCP `documents` verb renders).
// If they disagreed, an agent and the user would be looking at different lists.
//
// The order is the USER'S: dragging a row in the Documents list (or Alt+↑/↓ on
// a focused row) records it in `project.json` as `documentOrder` — a plain list
// of project-relative paths. Everything else is the fallback for documents the
// user has never arranged, and with no `documentOrder` at all the result is
// exactly the historical sort (main first, then title; Context group last, in
// mission → notebook → rules order).
//
// Two rules keep this self-healing, which matters because the list is a scan:
// a path in the order that no longer exists is ignored, and a document the
// order has never seen sorts AFTER the arranged ones (a new file appears at the
// end of its group, never in the middle of the user's arrangement).
//
// The same module owns the bookkeeping half of REMOVING a document (bottom of
// the file): both engines delete documents too — the rail's × and flux-core's
// `delete_document` — and they must refuse the same requests and leave the
// manifest in the same state.
//
// Pure: no Svelte, no DOM, no Node — it loads in both worlds (§2 twin-engine).
// ---------------------------------------------------------------------------

import { CONTEXT_DOC_RELS } from "./contextTemplates";

/** The shape both `listDocuments` twins produce (their `DocEntry`). */
export interface DocRow {
  /** project-relative, e.g. "manuscript/main.qmd" */
  path: string;
  title: string;
  /** Protected historical main role. New-project documents are ordinary rows. */
  isMain: boolean;
  /** Lives under Context/ — its own group, listed last. */
  isContext?: boolean;
}

/** Canonical rank of a stock Context document (mission → notebook → rules). */
function contextRank(rel: string): number {
  const i = CONTEXT_DOC_RELS.indexOf(rel);
  return i === -1 ? CONTEXT_DOC_RELS.length : i;
}

/**
 * The project's documents in display order: the user's `documentOrder` where it
 * covers them, the historical default where it doesn't. Never mutates `rows`.
 */
export function sortDocuments<T extends DocRow>(rows: readonly T[], order?: readonly string[]): T[] {
  const rank = new Map<string, number>();
  if (order) for (const p of order) if (!rank.has(p)) rank.set(p, rank.size);
  return rows.slice().sort((a, b) => {
    const ac = !!a.isContext;
    const bc = !!b.isContext;
    if (ac !== bc) return ac ? 1 : -1; // the Context group is always last
    const ra = rank.get(a.path);
    const rb = rank.get(b.path);
    if (ra !== undefined || rb !== undefined) {
      if (ra === undefined) return 1; // never arranged → after the arranged ones
      if (rb === undefined) return -1;
      return ra - rb;
    }
    if (a.isMain !== b.isMain) return a.isMain ? -1 : 1;
    if (ac && bc) {
      const r = contextRank(a.path) - contextRank(b.path);
      if (r !== 0) return r;
    }
    return a.title.localeCompare(b.title);
  });
}

/**
 * The one reorder primitive (the documents' `ops.reorderFigures`): move `moving`
 * so its first row lands at `toIndex` — an index counted among the rows that
 * STAY PUT, within the moving rows' own group. Returns the project's complete
 * new `documentOrder`.
 *
 * Like the figures' primitive: a multi-row pick lands as one contiguous block
 * keeping its relative order, a target outside the list clamps, and rows from
 * the other group (Documents vs Context) are ignored rather than dragged across
 * — the two groups are separate lists on screen.
 *
 * The result always names EVERY row, so the user's arrangement is explicit from
 * the first drag onward and can't be reshuffled later by a title edit.
 */
export function reorderDocuments(
  rows: readonly DocRow[],
  order: readonly string[] | undefined,
  moving: readonly string[],
  toIndex: number,
): string[] {
  const sorted = sortDocuments(rows, order);
  const byPath = new Map(sorted.map((r) => [r.path, r]));
  const picks = moving.map((p) => byPath.get(p)).filter((r): r is DocRow => !!r);
  const flat = sorted.map((r) => r.path);
  if (!picks.length) return flat;

  const group = !!picks[0].isContext; // the grabbed row's group owns the move
  const inGroup = new Set(picks.filter((r) => !!r.isContext === group).map((r) => r.path));
  const sibs = sorted.filter((r) => !!r.isContext === group).map((r) => r.path);
  const block = sibs.filter((p) => inGroup.has(p)); // relative order kept
  const rest = sibs.filter((p) => !inGroup.has(p));
  const at = Math.max(0, Math.min(rest.length, Math.round(toIndex)));
  const next = [...rest.slice(0, at), ...block, ...rest.slice(at)];

  const others = sorted.filter((r) => !!r.isContext !== group).map((r) => r.path);
  return group ? [...others, ...next] : [...next, ...others];
}

// ---------------------------------------------------------------------------
// Document REMOVAL — "delete this document from the project".
//
// What removal MEANS is decided here, once: the document's .qmd and its
// comments sidecar leave the project, and the manifest forgets it. Nothing
// else moves — a document only REFERENCES figures (`![](){#fig-…}`) and
// references (`[@key]`); it owns none of them, so fig/, references/ and every
// other document are untouched by design. The IO is each engine's own
// (the GUI trashes through the OS shell, flux-core removes), but the policy —
// what may be deleted, which files count, what the manifest keeps — is shared.
// ---------------------------------------------------------------------------

/** Why a document can't be deleted, for the user, plus a code for the engines. */
export interface RemovalBlocker {
  code: "unknown" | "main" | "context";
  reason: string;
}

/**
 * Whether `rel` may be deleted: null when it may, otherwise why not. Policy,
 * so it lives here for both the rail (which hides the × on such rows) and the
 * `delete_document` verb (which refuses with the same words):
 *  - a legacy main remains protected for compatibility; new projects have no
 *    protected main role, only a replaceable default export pointer;
 *  - a Context document (mission / notebook / rules) is the project's agent
 *    layer and is seeded back on the next open, so deleting it is a no-op
 *    with extra steps;
 *  - anything else has to be a document the project actually lists.
 */
export function documentRemovalBlocker(rows: readonly DocRow[], rel: string): RemovalBlocker | null {
  const row = rows.find((r) => r.path === rel);
  if (!row) return { code: "unknown", reason: `${rel} is not a document of this project` };
  if (row.isMain) return { code: "main", reason: "The main manuscript can't be deleted" };
  if (CONTEXT_DOC_RELS.includes(rel))
    return {
      code: "context",
      reason: "Context documents belong to the project's agent layer and come back on the next open",
    };
  return null;
}

/**
 * The project-relative path of a document's review-comments sidecar: the
 * main manuscript keeps the historical `comments.json`, every other document
 * gets `<base>.comments.json` beside it. Both comments modules derive their
 * paths from this, so a deleted document's sidecar is the one they wrote.
 */
export function commentsSidecarRel(mainPath: string, rel: string): string {
  const dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
  const base = rel.slice(rel.lastIndexOf("/") + 1).replace(/\.(qmd|md)$/, "");
  const name = rel === mainPath ? "comments.json" : `${base}.comments.json`;
  return dir ? `${dir}/${name}` : name;
}

/**
 * Forget `rel` in the manifest: its `supplementary` registration and its slot
 * in the user's `documentOrder`. Mutates `m` in place (the manifest objects
 * both engines hold are edited in place — see createDocument) and returns
 * whether anything changed. The order would self-heal a vanished path anyway
 * (sortDocuments ignores it); pruning keeps project.json honest.
 */
export function pruneDocumentFromManifest(
  m: { supplementary?: { path: string }[]; documentOrder?: string[] },
  rel: string,
): boolean {
  let changed = false;
  if (m.supplementary?.some((s) => s.path === rel)) {
    m.supplementary = m.supplementary.filter((s) => s.path !== rel);
    changed = true;
  }
  if (m.documentOrder?.includes(rel)) {
    m.documentOrder = m.documentOrder.filter((p) => p !== rel);
    changed = true;
  }
  return changed;
}

/** Legacy projects retain their historical main comments sidecar. New projects
 * use document-named sidecars, independent of the default export pointer. */
export function commentsMainPath(m: { documentRoot?: string; manuscript: { path: string } }): string {
  return m.documentRoot ? "" : m.manuscript.path;
}
