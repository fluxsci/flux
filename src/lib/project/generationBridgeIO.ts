import { fileBridge, joinPath, type FileBridge } from './types';
import type { TextGenerationIO } from './textGeneration';

/** A stored journal is confined to its project, not the native file capability
 * union (which can legitimately include other open projects and dialog grants). */
export function generationBridgeIO(root: string, bridge: FileBridge = fileBridge()!): TextGenerationIO {
  if (!bridge) throw new Error('No file bridge available for source recovery');
  const abs = (rel: string) => joinPath(root, rel);
  async function validatePath(rel: string): Promise<void> {
    if (!rel || /[\\\x00]/.test(rel) || rel.startsWith('/') || /^[a-z]:/i.test(rel) || (rel !== '.' && rel.split('/').some(part => !part || part === '.' || part === '..'))) throw new Error('Invalid project generation path');
    // Memory/browser fixture bridges have no host filesystem or symlinks.
    // Every shipped native preload exposes this canonical project capability.
    if (!bridge.projectAssetPath) return;
    let probe = rel;
    while (probe !== '.' && !await bridge.exists(abs(probe))) {
      const slash = probe.lastIndexOf('/');
      probe = slash < 0 ? '.' : probe.slice(0, slash);
    }
    await bridge.projectAssetPath(root, probe);
  }
  return {
    validatePath,
    read: async rel => { await validatePath(rel); return await bridge.exists(abs(rel)) ? bridge.readText(abs(rel)) : null; },
    readBytes: async rel => { await validatePath(rel); return await bridge.exists(abs(rel)) ? new Uint8Array(await bridge.readFile(abs(rel))) : null; },
    write: async (rel, text) => { await validatePath(rel); await bridge.writeText(abs(rel), text); },
    writeBytes: async (rel, bytes) => { await validatePath(rel); await bridge.writeFile(abs(rel), bytes); },
    remove: async rel => { await validatePath(rel); if (!bridge.remove) throw new Error('Source recovery requires remove support'); await bridge.remove(abs(rel)); },
    fsyncDir: bridge.fsyncDir ? async rel => { await validatePath(rel); await bridge.fsyncDir!(abs(rel)); } : undefined,
  };
}
