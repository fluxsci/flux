/** Browser asset boundary. The Node bundles replace only this module with the
 * packaged sidecar adapter, so every CLI verb need not parse runtime strings. */
export interface EmbedAssets { runtime: string; csp: string; fonts: string; model3dCsp?: string }
export async function loadEmbedAssets(): Promise<EmbedAssets> {
  return (await import('../../../.generated/slide-embed-assets.json')).default;
}
export async function loadEmbedModelRuntime(): Promise<string> {
  return (await import('../../../.generated/slide-embed-model3d-assets.json')).default.runtime;
}
