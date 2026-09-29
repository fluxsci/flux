import type { ModelBounds, Scene3dManifest, Vec3 } from './types';
import { boundsSphere } from './orbit';
import { transformPoint } from './glbCore.mjs';

const ID = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** Data-space limits of a box-axes frame: an axis's `lim`, else the manifest
 *  bounds carried back into data space. Furniture draws this box; framing covers it. */
export function axesBoxLimits(manifest: Scene3dManifest): [number, number][] {
  const toWorld = manifest.toWorld ?? ID;
  // Bounds are world coordinates; axis limits are data coordinates. A proper
  // rotation's inverse is its transpose (exact for all signed-axis writers).
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let mask = 0; mask < 8; mask++) {
    const p = [0, 1, 2].map(i => manifest.bounds ? ((mask >> i) & 1 ? manifest.bounds.max[i] : manifest.bounds.min[i]) : ((mask >> i) & 1 ? 1 : -1));
    for (let i = 0; i < 3; i++) {
      const v = toWorld[i * 4] * p[0] + toWorld[i * 4 + 1] * p[1] + toWorld[i * 4 + 2] * p[2];
      min[i] = Math.min(min[i], v); max[i] = Math.max(max[i], v);
    }
  }
  return (['x', 'y', 'z'] as const).map((k, i) => manifest.axes?.[k]?.lim ?? [min[i], max[i]]);
}

/** The bounds the camera frames. A bare mesh frames its own tight sphere; box
 *  axes are part of the figure, so the frame grows to hold the whole axes box
 *  (its corners sit up to √3 × the mesh radius out). Every pose that pairs a
 *  poster with vector furniture must use this, or the two drift apart. */
export function framingBounds(bounds: ModelBounds, manifest: Scene3dManifest | null | undefined): ModelBounds {
  if (manifest?.axes?.kind !== 'box') return bounds;
  const toWorld = manifest.toWorld ?? ID, limits = axesBoxLimits(manifest);
  const min = [...bounds.min] as Vec3, max = [...bounds.max] as Vec3;
  for (let mask = 0; mask < 8; mask++) {
    const corner = transformPoint(toWorld, limits.map((lim, i) => lim[(mask >> i) & 1])) as Vec3;
    for (let i = 0; i < 3; i++) if (Number.isFinite(corner[i])) { min[i] = Math.min(min[i], corner[i]); max[i] = Math.max(max[i], corner[i]); }
  }
  // No `radius`: the union box's half-diagonal is what circumscribes the axes box.
  return { min, max };
}

/** Vertex morph cameras interpolate the endpoint framing spheres, including
 * box-axis limits. Furniture and the renderer share this exact calculation. */
export function sphereLerpBounds(a: ModelBounds, b: ModelBounds, t: number): ModelBounds {
  const sa = boundsSphere(a), sb = boundsSphere(b), r = sa.radius * (1 - t) + sb.radius * t;
  const center = sa.center.map((v, i) => v * (1 - t) + sb.center[i] * t);
  return { min: center.map(v => v - r / Math.sqrt(3)) as Vec3, max: center.map(v => v + r / Math.sqrt(3)) as Vec3, radius: r };
}
