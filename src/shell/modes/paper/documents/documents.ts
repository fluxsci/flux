// F4: a project holds many documents (main manuscript + supplementary + section
// .qmd files). This module discovers them, reads their titles, and creates new
// ones — registering them in project.json so they survive a reload.

import { fileBridge, joinPath, type LoadedProject } from "../../../../lib/project/types";
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

import { discoverDocuments, createDocumentFile, createDocumentFolder, moveDocumentFile, type DocumentIO } from "../../../../lib/project/documentFiles";

function documentIO(p: LoadedProject): DocumentIO {
  const fb = fileBridge();
  if (!fb) throw new Error("no file bridge");
  const abs = (rel: string) => joinPath(p.root, rel);
  return {
    exists: rel => fb.exists(abs(rel)), read: rel => fb.readText(abs(rel)),
    create: (rel, text) => fb.writeText(abs(rel), text, { createOnly: true }),
    write: (rel, text) => fb.writeText(abs(rel), text), mkdir: rel => fb.mkdir(abs(rel)),
    entries: rel => fb.readdir ? fb.readdir(abs(rel)) : Promise.resolve([]),
    remove: async rel => {
      if (!fb.remove) throw new Error("This build cannot move files.");
      await fb.remove(abs(rel));
      if (await fb.exists(abs(rel))) throw new Error(`Could not remove ${rel}.`);
    },
  };
}
export const listDocumentTree = (p: LoadedProject) => discoverDocuments(p.manifest, documentIO(p));
export async function listDocuments(p: LoadedProject): Promise<DocEntry[]> { return (await listDocumentTree(p)).docs; }
export const createFolder = (p: LoadedProject, parent: string, name: string) => createDocumentFolder(p.manifest, documentIO(p), parent, name);
export const moveDocument = (p: LoadedProject, rel: string, folder: string) => moveDocumentFile(p.manifest, documentIO(p), rel, folder);

/**
 * Record the user's Documents-list order. The manifest object is updated in
 * place FIRST (the rail re-renders from it immediately — a drag is
 * direct manipulation, §6), then project.json is rewritten.
 */
export async function setDocumentOrder(p: LoadedProject, order: string[]): Promise<void> {
  const fb = fileBridge();
  p.manifest.documentOrder = order;
  if (!fb) return;
  await fb.writeText(joinPath(p.root, "project.json"), JSON.stringify(p.manifest, null, 2) + "\n");
}

export const createDocument = (p: LoadedProject, name: string, folder?: string) => createDocumentFile(p.manifest, documentIO(p), name, folder);

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

  /** null = there was no such file; otherwise whether it went to the trash. */
  const removeOne = async (r: string): Promise<boolean | null> => {
    const abs = joinPath(p.root, r);
    if (!(await fb.exists(abs))) return null;
    if (fb.trash) return (await fb.trash(abs)).trashed;
    await fb.remove!(abs);
    return false;
  };
  const trashed = (await removeOne(rel)) ?? false;
  await removeOne(commentsSidecarRel(commentsMainPath(p.manifest), rel));
  const pruned = pruneDocumentFromManifest(p.manifest, rel);
  const changedDefault = !!p.manifest.documentRoot && p.manifest.manuscript.path === rel;
  if (changedDefault) p.manifest.manuscript.path = rows.find(d => d.path !== rel && !d.isContext)?.path ?? "";
  if (pruned || changedDefault)
    await fb.writeText(joinPath(p.root, "project.json"), JSON.stringify(p.manifest, null, 2) + "\n");
  return { trashed };
}
