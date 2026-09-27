// F4: a project holds many documents (main manuscript + supplementary + section
// .qmd files). This module discovers them, reads their titles, and creates new
// ones — registering them in project.json so they survive a reload.

import { withIpcLock } from "../../../../lib/references/libLock";
import { updateManifest } from "../../../../lib/project/manifestBridge";
import { decodeManifest, encodeManifest } from "../../../../lib/project/manifestTransaction";
import { fileBridge, joinPath, type LoadedProject, type ProjectManifest } from "../../../../lib/project/types";
import {
  commentsSidecarRel,
  commentsMainPath,
  documentRemovalBlocker,
  pruneDocumentFromManifest,
} from "../../../../lib/project/docOrder";

export interface DocEntry {
  path: string; // relative to the project root, e.g. "manuscript/main.qmd"
  title: string;
  isMain: boolean;
  /** Lives under Context/ (mission/notebook/rules …) — grouped separately in the picker. */
  isContext?: boolean;
}

import { discoverDocuments, deleteDocumentFile, createDocumentFile, createDocumentFolder, moveDocumentFile, type DocumentIO } from "../../../../lib/project/documentFiles";

function documentIO(p: LoadedProject, assertOwned: () => Promise<void> = async () => {}): DocumentIO {
  const fb = fileBridge();
  if (!fb) throw new Error("no file bridge");
  const abs = (rel: string) => joinPath(p.root, rel);
  return {
    exists: rel => fb.exists(abs(rel)), read: rel => fb.readText(abs(rel)),
    create: async (rel, text) => { await assertOwned(); await fb.writeText(abs(rel), text, { createOnly: true }); },
    write: async (rel, text) => { await assertOwned(); await fb.writeText(abs(rel), rel === "project.json" ? encodeManifest(decodeManifest(text)) : text); },
    mkdir: async rel => { await assertOwned(); await fb.mkdir(abs(rel)); },
    entries: rel => fb.readdir ? fb.readdir(abs(rel)) : Promise.resolve([]),
    remove: async rel => {
      await assertOwned();
      if (!fb.remove) throw new Error("This build cannot move files.");
      await fb.remove(abs(rel));
      if (await fb.exists(abs(rel))) throw new Error(`Could not remove ${rel}.`);
    },
  };
}
/** Document file changes own manuscript before manifest, matching the Node
 * adapter and excluding cooperating autosaves during rename/delete rollback. */
function updateDocuments(p: LoadedProject, intent: (fresh: ProjectManifest, assertOwned: () => Promise<void>) => Promise<void>): Promise<ProjectManifest> {
  return withIpcLock('project', 'manuscript', manuscript => updateManifest(p.root, async (fresh, manifest) => {
    const assertOwned = async () => { await manuscript.assertOwned?.(); await manifest.assertOwned?.(); };
    await intent(fresh, assertOwned);
  }), { root: p.root });
}
export const listDocumentTree = (p: LoadedProject) => discoverDocuments(p.manifest, documentIO(p));
export async function listDocuments(p: LoadedProject): Promise<DocEntry[]> { return (await listDocumentTree(p)).docs; }
export const createFolder = (p: LoadedProject, parent: string, name: string) => withIpcLock("project", "manuscript", lease => createDocumentFolder(p.manifest, documentIO(p, async () => { await lease.assertOwned?.(); }), parent, name), { root: p.root });
export async function moveDocument(p: LoadedProject, rel: string, folder: string) {
  let result!: { path: string; changed: string[] };
  const manifest = await updateDocuments(p, async (fresh, assertOwned) => {
    result = await moveDocumentFile(fresh, documentIO({ ...p, manifest: fresh }, assertOwned), rel, folder);
  });
  p.manifest = manifest;
  return result;
}

/**
 * Record the user's Documents-list order. The manifest object is updated in
 * place FIRST (the rail re-renders from it immediately — a drag is
 * direct manipulation, §6), then project.json is rewritten.
 */
const orderRevisions = new WeakMap<LoadedProject, number>();
export async function setDocumentOrder(p: LoadedProject, order: string[]): Promise<void> {
  const revision = (orderRevisions.get(p) ?? 0) + 1;
  orderRevisions.set(p, revision);
  const previous = p.manifest.documentOrder;
  p.manifest.documentOrder = [...order]; // immediate optimistic row feedback
  if (!fileBridge()) return;
  try {
    const accepted = await updateManifest(p.root, fresh => { fresh.documentOrder = [...order]; });
    if (orderRevisions.get(p) === revision) p.manifest = accepted;
  } catch (e) {
    if (orderRevisions.get(p) === revision) p.manifest.documentOrder = previous;
    throw e;
  }
}
export async function createDocument(p: LoadedProject, name: string, folder?: string) {
  let result!: string;
  const manifest = await updateDocuments(p, async (fresh, assertOwned) => {
    result = await createDocumentFile(fresh, documentIO({ ...p, manifest: fresh }, assertOwned), name, folder);
  });
  p.manifest = manifest;
  return result;
}

/**
 * Delete a document from the project. The .qmd goes to the OS trash (a plain
 * remove where there is none — the result says which), its comments sidecar
 * goes with it, and the manifest forgets it (supplementary + documentOrder).
 * What may be deleted and which files count is the shared policy in
 * docOrder.ts, so flux-core's `delete_document` refuses the same requests and
 * leaves the same manifest. Figures, references and the other documents are
 * untouched: a document only REFERENCES figures, it owns none of them.
 *
 * The caller switches the editor away first (a file must never vanish under a
 * live editor + autosave — they would write it straight back).
 */
export async function deleteDocument(
  p: LoadedProject,
  rows: readonly DocEntry[],
  rel: string,
): Promise<{ trashed: boolean }> {
  const fb = fileBridge();
  if (!fb) throw new Error("no file bridge");
  if (!fb.trash && !fb.remove) throw new Error("this build can't delete files");
  const blocker = documentRemovalBlocker(rows, rel);
  if (blocker) throw new Error(blocker.reason);

  let trashed = false;
  const accepted = await updateDocuments(p, async (fresh, assertOwned) => {
    const io = documentIO({ ...p, manifest: fresh }, assertOwned);
    io.remove = async r => {
      await assertOwned();
      const abs = joinPath(p.root, r);
      if (fb.trash) { const result = await fb.trash(abs); if (r === rel) trashed = result.trashed; }
      else await fb.remove!(abs);
      if (await fb.exists(abs)) throw new Error(`Could not delete ${r}.`);
    };
    await deleteDocumentFile(fresh, io, rel);
  });
  p.manifest = accepted;
  return { trashed };
}
