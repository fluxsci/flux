import { type FileBridge } from './types';
import { generationBridgeIO } from './generationBridgeIO';
import { confinedReferenceSyncIO } from './figureReferenceSync';
import { withIpcLock } from '../references/libLock';

export function referenceSyncBridgeIO(root: string, bridge: FileBridge) {
  const generation = generationBridgeIO(root, bridge);
  return confinedReferenceSyncIO(root, {
    readText: p => bridge.readText(p), writeText: (p,t) => bridge.writeText(p,t), exists: p => bridge.exists(p),
    ...(bridge.remove ? {remove: (p: string) => bridge.remove!(p)} : {}),
    ...(bridge.mkdir ? {mkdir: (p: string) => bridge.mkdir!(p)} : {}),
    ...(bridge.readdir ? {readdir: (p: string) => bridge.readdir!(p,true)} : {}),
  }, rel => generation.validatePath!(rel), work => withIpcLock('project','manuscript', lease => work(async () => { await lease.assertOwned?.(); }), {root}), work => withIpcLock('project','figure-references', lease => work(async () => { await lease.assertOwned?.(); }), {root}));
}
