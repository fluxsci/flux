/** One portable model table across the complete include tree. Payloads remain immutable. */
import type { ExportPayload } from './payload';
export type SharedModelPayload = Omit<ExportPayload, 'models'> & { modelIds?: string[] };
export function shareEmbedModels(payloads: Record<string, ExportPayload>) {
  const models: Record<string, string> = Object.create(null);
  const shared: Record<string, SharedModelPayload> = Object.create(null);
  for (const [source, payload] of Object.entries(payloads)) {
    const { models: own, ...rest } = payload;
    const ids = Object.keys(own ?? {});
    for (const id of ids) {
      const bytes = own![id];
      if (Object.hasOwn(models, id) && models[id] !== bytes) throw new Error(`3D model "${id}" has different bytes in included slides`);
      models[id] = bytes;
    }
    shared[source] = ids.length ? { ...rest, modelIds: ids } : rest;
  }
  return { payloads: shared, models };
}
export function restoreEmbedModels(payload: SharedModelPayload, shared: Record<string, string>): ExportPayload {
  const { modelIds, ...rest } = payload;
  if (!modelIds?.length) return rest;
  const models: Record<string, string> = Object.create(null);
  for (const id of modelIds) {
    if (!Object.hasOwn(shared, id)) throw new Error(`Missing included 3D model "${id}"`);
    models[id] = shared[id];
  }
  return { ...rest, models };
}
