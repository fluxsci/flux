import { fileBridge, joinPath, type ProjectManifest } from './types';
import { withIpcLock, type IpcLease } from '../references/libLock';
import { applyManifestIntent } from './manifestTransaction';
export async function updateManifest(root: string, intent: (fresh: ProjectManifest, lease: IpcLease) => void | Promise<void>): Promise<ProjectManifest> {
  const fb = fileBridge();
  if (!fb) throw new Error('Manifest updates require a file bridge');
  return withIpcLock('project', 'manifest', lease => applyManifestIntent({
    read: () => fb.readText(joinPath(root, 'project.json')),
    write: async text => { await lease.assertOwned?.(); await fb.writeText(joinPath(root, 'project.json'), text); },
  }, fresh => intent(fresh, lease)), { root });
}
