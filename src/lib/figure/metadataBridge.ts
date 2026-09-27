import { get } from 'svelte/store';
import { project, commit } from '../store';
import { storeTenant } from '../tenancy';
import { figureStoreRoot } from '../project/figbridge';
import { hasFlushOwner } from '../../shell/lifecycle';
import { projectModel } from '../../shell/shellStore';
import { withIpcLock } from '../references/libLock';
import { fileBridge, joinPath } from '../project/types';
import { readFigureSnapshot, requireCompleteFigureSnapshot } from '../project/figureSnapshot';
import { figureSnapshotBridgeIO } from '../project/figureSnapshotBridgeIO';
import { planFigSave, executeFigSave } from '../project/figfiles';
import { generationBridgeIO } from '../project/generationBridgeIO';
import { commitTextGeneration, recoverTextGeneration, type GenerationWrite } from '../project/textGeneration';
import { stageFigureRegistration } from '../project/figureGeneration';
import { recoverFigureReferenceUpdate } from '../project/figureReferenceSync';
import { referenceSyncBridgeIO } from '../project/referenceSyncBridgeIO';
import { bumpFigRevision } from '../../shell/scholar/revisions';
import { applyMetadataChange, type MetadataChange } from './metadata';

export function metadataUsesLiveFigure(root: string | null): boolean {
  return storeTenant() === 'figure' && (!root || (figureStoreRoot() === root && hasFlushOwner('figure')));
}
export async function readMetadataProject(root: string | null) {
  if (metadataUsesLiveFigure(root)) return get(project);
  const bridge = fileBridge();
  if (!root || !bridge) throw new Error('Open a project to edit figure metadata.');
  return requireCompleteFigureSnapshot(await readFigureSnapshot(figureSnapshotBridgeIO(root, bridge))).project;
}

/** Paper can edit without mounting Figure or replacing a live Slide tenant.
 * Cold writes acquire the same leases and publish the same recoverable save
 * generation as Figure. A live Figure instead owns history and autosave. */
export async function writeMetadataChange(root: string | null, change: MetadataChange): Promise<void> {
  if ((get(projectModel)?.root ?? null) !== root) throw new Error('The project changed; this edit was not applied.');
  if (metadataUsesLiveFigure(root)) {
    // Preflight before creating history. Recheck within the synchronous commit.
    applyMetadataChange(structuredClone(get(project)), change);
    commit(p => applyMetadataChange(p, change));
    return;
  }
  const bridge = fileBridge();
  if (!root || !bridge) throw new Error('No project file connection is available.');
  await withIpcLock('project', 'project', async lease => {
    const current = () => {
      if (get(projectModel)?.root !== root) throw new Error('The project changed; this edit was not applied.');
      if (metadataUsesLiveFigure(root) || hasFlushOwner('figure')) throw new Error('Figure is opening. Retry this edit when it is ready.');
    };
    current();
    const io = generationBridgeIO(root, bridge);
    await withIpcLock('project', 'slides', slides => withIpcLock('project', 'manifest', manifest =>
      recoverTextGeneration(io, async () => { await lease.assertOwned?.(); await slides.assertOwned?.(); await manifest.assertOwned?.(); }), { root }), { root });
    await recoverFigureReferenceUpdate(root, referenceSyncBridgeIO(root, bridge));
    const snapshot = requireCompleteFigureSnapshot(await readFigureSnapshot(figureSnapshotBridgeIO(root, bridge)));
    applyMetadataChange(snapshot.project, change);
    const plan = planFigSave(snapshot.project, snapshot.index, snapshot.baselines);
    const writes = new Map<string, GenerationWrite>();
    await executeFigSave(plan, { read: io.read, write: async (path, text) => { writes.set(path, text); } });
    await withIpcLock('project', 'manifest', async manifest => {
      await stageFigureRegistration(io, JSON.parse(plan.index.text), writes);
      for (const [path, baseline] of snapshot.baselines) if (await io.read(path) !== baseline) throw new Error('Figures changed while saving. Your draft has been kept; retry the edit.');
      current();
      for (const directory of ['.meta', 'fig', 'fig/canvases', 'fig/captions']) await bridge.mkdir(joinPath(root, directory));
      await commitTextGeneration(io, writes, async () => { await lease.assertOwned?.(); await manifest.assertOwned?.(); current(); });
    }, { root });
  }, { root });
  bumpFigRevision();
}
