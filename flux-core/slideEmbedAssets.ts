/** Node counterpart of the browser's lazy generated assets. The existing
 * unpacked sidecar is shipped beside the CLI/MCP; no checkout is required. */
import { loadExportAssets } from '../src/lib/slide/export/exportDeck';
import type { EmbedAssets } from '../src/lib/slide/embedAssets';
export async function loadEmbedAssets(): Promise<EmbedAssets> {
  const assets = await loadExportAssets();
  if (!assets.embed?.runtime || !assets.embed.csp || !assets.embed.fonts) {
    throw new Error('Paper slide runtime is missing. Rebuild Flux before exporting slide embeds.');
  }
  return assets.embed;
}
export async function loadEmbedModelRuntime(): Promise<string> {
  const assets = await loadExportAssets();
  if (!assets.model3dRuntime) throw new Error('3D runtime is missing. Rebuild Flux before exporting slide embeds.');
  return assets.model3dRuntime;
}
