// Monitor IO reads saved sidecars; the shared inbox core owns status and counts.
import { fileBridge, joinPath, type LoadedProject } from '../../lib/project/types';
import { commentsMainPath, commentsSidecarRel } from '../../lib/project/docOrder';
import type { InboxComment } from '../../lib/project/inbox';
export async function readProjectComments(project: LoadedProject, docs: readonly { path: string }[]): Promise<InboxComment[]> {
  const fb = fileBridge();
  if (!fb) return [];
  return (await Promise.all(docs.map(async doc => {
    const found = new Map<string, InboxComment>();
    // Legacy mains may have both sidecars after a promotion; preserve all threads.
    const paths = new Set([commentsSidecarRel(commentsMainPath(project.manifest), doc.path), commentsSidecarRel('', doc.path)]);
    for (const rel of paths) {
      const file = joinPath(project.root, rel);
      if (!await fb.exists(file)) continue;
      const data = JSON.parse(await fb.readText(file));
      if (!Array.isArray(data.threads)) throw new Error(`Invalid comment sidecar: ${rel}`);
      for (const thread of data.threads) if (!found.has(thread.id)) found.set(thread.id, { ...thread, doc: doc.path });
    }
    return [...found.values()];
  }))).flat();
}
