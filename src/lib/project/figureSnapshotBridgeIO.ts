import { joinPath, type FileBridge } from './types';
import type { FigureSnapshotIO } from './figureSnapshot';

/** Electron serializes Error messages; Node/fixture adapters retain errno. */
function missing(error: unknown): boolean {
  return (error as { code?: string })?.code === 'ENOENT' || /\bENOENT\b/.test(String(error));
}

/** Project-confined snapshot reads. Native enumeration explicitly retains IO
 * failures; fixture bridges may implement the same contract without a host FS. */
export function figureSnapshotBridgeIO(root: string, bridge: FileBridge): FigureSnapshotIO {
  async function validate(rel: string): Promise<void> {
    if (!bridge.projectAssetPath) return;
    let parent = rel;
    for (;;) {
      try { await bridge.projectAssetPath(root, parent); return; }
      catch (error) {
        if (!missing(error) || parent === '.') throw error;
        const slash = parent.lastIndexOf('/');
        parent = slash < 0 ? '.' : parent.slice(0, slash);
      }
    }
  }
  return {
    readText: async rel => {
      await validate(rel);
      return await bridge.exists(joinPath(root, rel)) ? bridge.readText(joinPath(root, rel)) : null;
    },
    listDirectory: async rel => {
      if (!bridge.readdir) throw new Error('Figure directory inventory is unavailable');
      await validate(rel);
      try { return await bridge.readdir(joinPath(root, rel), true); }
      catch (error) { if (missing(error)) return null; throw error; }
    },
  };
}
