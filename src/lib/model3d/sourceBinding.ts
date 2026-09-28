/** Original-byte provenance for metadata, independent of prepared GLB receipts. */
import type { Element } from '../types';
import type { Scene3dManifest } from './types';

export type Model3dSourceBinding =
  | { kind: 'known'; sha256: string }
  | { kind: 'conflict'; sha256s: string[] };

/** A missing binding is a legacy asset with no original receipt. All placements
 * participate: a known receipt binds legacy copies too, and conflicts never use
 * whichever placement happened to load first. Asset.sha256 is deliberately not
 * accepted here because preparation can change the bytes. */
export function collectModel3dSourceBindings(elements: Iterable<Element>): Map<string, Model3dSourceBinding> {
  const receipts = new Map<string, Set<string>>();
  for (const element of elements) {
    if (element.type !== 'model3d' || !element.source?.sha256) continue;
    let hashes = receipts.get(element.assetId);
    if (!hashes) receipts.set(element.assetId, hashes = new Set());
    hashes.add(element.source.sha256);
  }
  const bindings = new Map<string, Model3dSourceBinding>();
  for (const [assetId, hashes] of receipts) {
    const sha256s = [...hashes].sort();
    bindings.set(assetId, sha256s.length === 1
      ? { kind: 'known', sha256: sha256s[0] }
      : { kind: 'conflict', sha256s });
  }
  return bindings;
}

/** Used by both metadata IO engines and import policy. A hash-less manifest is
 * valid under the contract, but conflicting asset provenance still suppresses
 * it. Legacy documents without original receipts retain their prior behavior. */
export function scene3dSourceBindingIssue(
  manifest: Pick<Scene3dManifest, 'glbSha256'>,
  binding?: Model3dSourceBinding,
): string | undefined {
  if (binding?.kind === 'conflict') return 'Conflicting original GLB source receipts for this asset';
  if (binding?.kind === 'known' && manifest.glbSha256 && manifest.glbSha256 !== binding.sha256)
    return 'The scene3d manifest describes different GLB bytes';
  return undefined;
}
