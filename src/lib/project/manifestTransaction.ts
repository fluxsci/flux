// The one manifest boundary: preserve supported unknown metadata, reject corrupt
// or future authoring bytes, apply intent to a fresh revision under a host lease.
import { PROJECT_SCHEMA_VERSION, isNewerSchema, newerSchemaMessage, type ProjectManifest } from './types';
import { validateProjectManifest } from './validate';
export function decodeManifest(text: string): ProjectManifest {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error('project.json is not valid JSON; no changes were written.'); }
  const errors = validateProjectManifest(value);
  if (errors.length) throw new Error(`project.json failed validation: ${errors.slice(0, 6).join('; ')}`);
  const manifest = value as ProjectManifest;
  if (isNewerSchema(manifest.schemaVersion, PROJECT_SCHEMA_VERSION)) throw new Error(newerSchemaMessage('project.json', manifest.schemaVersion, PROJECT_SCHEMA_VERSION));
  return manifest;
}
export function encodeManifest(manifest: ProjectManifest): string {
  const text = JSON.stringify(manifest, null, 2) + '\n';
  decodeManifest(text);
  return text;
}
export interface ManifestIO { read(): Promise<string>; write(text: string): Promise<void> }
/** Caller owns the root's manifest lease throughout this operation. */
export async function applyManifestIntent(io: ManifestIO, intent: (fresh: ProjectManifest) => void | Promise<void>): Promise<ProjectManifest> {
  const before = await io.read();
  const fresh = decodeManifest(before);
  const original = JSON.stringify(fresh);
  await intent(fresh);
  if (JSON.stringify(fresh) !== original) {
    // File operations can publish while holding this same lease so their own
    // rollback includes the manifest. Do not perform a second success write.
    const current = JSON.stringify(decodeManifest(await io.read()));
    if (current !== original) {
      if (current === JSON.stringify(fresh)) return fresh;
      throw new Error('project.json changed during the transaction; no stale revision was written.');
    }
    fresh.modified = new Date().toISOString();
    await io.write(encodeManifest(fresh));
  }
  return fresh;
}
