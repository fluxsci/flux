// Renderer IO for project-wide comments. Discovery and sidecar policy are shared
// with flux-core; an open Paper buffer owns its own mutations and persistence.
import { writable } from "svelte/store";
import { fileBridge, joinPath, type ProjectManifest } from "./types";
import { discoverDocuments, type DocumentIO } from "./documentFiles";
import { commentsSidecarRels } from "./docOrder";
import { appendCommentMessage, reopenCommentThread, mergeCommentThreads, type CommentsFile } from "./comments";
import { withIpcLock } from "../references/libLock";

export const commentsRevision = writable(0);
export const bumpComments = () => commentsRevision.update(n => n + 1);
export type CommentIntent = { kind: "reply"; body: string } | { kind: "reopen" };
type Owner = (id: string, intent: CommentIntent) => Promise<void>;
const owners = new Map<string, Owner>();
const key = (root: string, doc: string) => `${root}\n${doc}`;
export function registerCommentOwner(root: string, doc: string, owner: Owner): () => void {
  const k = key(root, doc); owners.set(k, owner);
  return () => { if (owners.get(k) === owner) owners.delete(k); };
}
export async function commentFiles(root: string, manifest: ProjectManifest, doc: string) {
  const fb = fileBridge();
  if (!fb) throw new Error("The project is no longer available");
  const files: { rel: string; file: CommentsFile }[] = [];
  for (const rel of commentsSidecarRels(manifest, doc)) {
    const path = joinPath(root, rel);
    if (!await fb.exists(path)) continue;
    const data = JSON.parse(await fb.readText(path));
    files.push({ rel, file: { ...data, version: 1, threads: Array.isArray(data.threads) ? data.threads : [] } });
  }
  return files;
}
export async function listAllComments(root: string) {
  const fb = fileBridge();
  if (!fb) throw new Error("The project is no longer available");
  const manifest = JSON.parse(await fb.readText(joinPath(root, "project.json"))) as ProjectManifest;
  const abs = (rel: string) => joinPath(root, rel);
  const io: DocumentIO = {
    exists: rel => fb.exists(abs(rel)), read: rel => fb.readText(abs(rel)),
    entries: rel => fb.readdir?.(abs(rel)) ?? Promise.resolve([]),
    write: async () => { throw new Error("Read-only discovery"); },
    create: async () => { throw new Error("Read-only discovery"); },
    mkdir: async () => { throw new Error("Read-only discovery"); },
    remove: async () => { throw new Error("Read-only discovery"); },
  };
  const { docs } = await discoverDocuments(manifest, io);
  const comments = [];
  for (const doc of docs) {
    // Match headless discovery: a malformed sidecar contributes no threads.
    const files = [];
    for (const rel of commentsSidecarRels(manifest, doc.path)) {
      try {
        if (!await fb.exists(abs(rel))) continue;
        const data = JSON.parse(await fb.readText(abs(rel)));
        files.push({ ...data, version: 1 as const, threads: Array.isArray(data.threads) ? data.threads : [] });
      } catch { /* unreadable sidecar; mutation below refuses it */ }
    }
    for (const thread of mergeCommentThreads(files)) comments.push({ ...thread, doc: doc.path });
  }
  return { comments, documents: docs, manifest };
}

export async function changeComment(root: string, doc: string, id: string, intent: CommentIntent): Promise<void> {
  const owner = owners.get(key(root, doc));
  if (owner) { await owner(id, intent); return; }
  await withIpcLock("project", "manuscript", async lease => {
    // Paper may have opened while this operation was waiting for its lease.
    if (owners.has(key(root, doc))) throw new Error("The document just opened. Retry the reply in its current view.");
    const fb = fileBridge();
    if (!fb) throw new Error("The project is no longer available");
    const manifest = JSON.parse(await fb.readText(joinPath(root, "project.json"))) as ProjectManifest;
    const found = (await commentFiles(root, manifest, doc)).find(f => f.file.threads.some(t => t.id === id));
    if (!found) throw new Error(`Comment ${id} is no longer in ${doc}`);
    const next = intent.kind === "reply"
      ? appendCommentMessage(found.file, id, { author: "You", kind: "human", body: intent.body, createdAt: new Date().toISOString() })
      : reopenCommentThread(found.file, id);
    await lease.assertOwned?.();
    await fb.writeText(joinPath(root, found.rel), JSON.stringify(next, null, 2) + "\n");
  }, { root });
  bumpComments();
}
