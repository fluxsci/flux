/** Deterministic 8 × 250,000-triangle fixture; generated in scratch, never checked in. */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { blobMesh } from '../gen-model3d-fixtures.mjs';
import { writeGlb, inspectGlb } from '../../src/lib/model3d/glbCore.mjs';

export async function model3dScaleFixtures(count = 8) {
  const source = JSON.parse(await readFile(new URL('../fixtures/model3d/fluxplot/box-axes.fluxplot.json', import.meta.url), 'utf8'));
  const geometry = blobMesh(250, 500);
  return Array.from({ length: count }, (_, i) => {
    // A distinct position in each source prevents asset deduplication from
    // disguising eight resident meshes as eight views of one mesh.
    const positions = geometry.positions.map((value, n) => n % 3 === 0 ? value * (1 + i / 100) : value);
    const bytes = writeGlb({ parts: [{ name: 'sample.mesh', ...geometry, positions }] });
    const info = inspectGlb(bytes), stem = `scale-model-${i}`;
    const manifest = structuredClone(source);
    Object.assign(manifest, { glb: `${stem}.glb`, glbSha256: createHash('sha256').update(bytes).digest('hex'), bounds: { min: info.bounds.min, max: info.bounds.max } });
    for (const [axis, n] of [['x', 0], ['y', 1], ['z', 2]]) manifest.axes[axis].lim = [info.bounds.min[n], info.bounds.max[n]];
    manifest.size = { width: 2.5, height: 2.25, unit: 'in' };
    return { stem, bytes, info, manifest };
  });
}
