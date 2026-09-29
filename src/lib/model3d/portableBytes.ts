import { GLB_LIMITS } from './glbCore.mjs';
import type { Model3dAsset } from './types';

/** Validate an accepted asset's prepared bytes before embedding them in a portable file.
 * Original source receipts belong to source binding and must never replace asset.sha256.
 * Native/Node callers should also bound the read before allocating the input buffer. */
export async function validatedModelBytes(
  input: ArrayBuffer | Uint8Array,
  asset: Pick<Model3dAsset, 'id' | 'name' | 'sha256'>,
): Promise<Uint8Array> {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const label = asset.name || asset.id;
  if (bytes.byteLength > GLB_LIMITS.maxBytes) throw new Error(`3D model "${label}" exceeds the ${GLB_LIMITS.maxBytes} byte portable limit`);
  if (!/^[a-f\d]{64}$/i.test(asset.sha256 ?? '')) throw new Error(`3D model "${label}" has no valid prepared-byte SHA-256 receipt`);
  if (!(bytes.buffer instanceof ArrayBuffer)) throw new Error(`3D model "${label}" portable bytes must not use shared memory`);
  const view = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', view));
  const actual = Array.from(digest, value => value.toString(16).padStart(2, '0')).join('');
  if (actual !== asset.sha256.toLowerCase()) throw new Error(`3D model "${label}" prepared bytes do not match the saved SHA-256 receipt`);
  return bytes;
}
