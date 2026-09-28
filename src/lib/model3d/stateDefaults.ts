import type { Scene3dManifest } from './types';

/** Source metadata may describe targets absent from this GLB. Reset/Home ignore
 * those warned-about names; explicit authored edits remain strictly validated. */
export function modelDefaultStates(manifest: Scene3dManifest | undefined, names: readonly string[]): Record<string, number> {
  const out: Record<string, number> = Object.create(null);
  for (const name of names) {
    const value = manifest?.view?.states && Object.hasOwn(manifest.view.states, name) ? manifest.view.states[name] : 0;
    if (Number.isFinite(value) && value !== 0) out[name] = value;
  }
  return out;
}
