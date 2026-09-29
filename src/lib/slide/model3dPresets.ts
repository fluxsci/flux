/** Explicit portable import: GLBs never enter assetData or a save journal. */
import { dataUrlToBytes } from '../assets';
import type { SlidePresetSnapshot } from './ops';
import { fileBridge, joinPath } from '../project/types';
import type { Model3dImportResult, Model3dImportOwnership } from '../model3d/importData';
import type { Asset } from '../types';
export async function preparePresetModels(snapshot: SlidePresetSnapshot, root: string, deckId: string, isCurrent: () => boolean) {
  const snap = structuredClone(snapshot), bridge = fileBridge();
  const models = (snap.assets ?? []).filter(entry => entry.asset.kind === 'glb');
  const assets: Asset[] = [], receipts: Model3dImportOwnership[] = [], remap = new Map<string, Model3dImportResult>();
  const native = bridge as typeof bridge & {
    importModel3d?: (request: unknown) => Promise<Model3dImportResult>;
    adoptModel3d?: (receipt: Model3dImportOwnership) => Promise<void>;
    discardModel3d?: (receipt: Model3dImportOwnership) => Promise<void>;
  };
  const current = () => { if (!isCurrent()) throw new Error('The destination deck changed while inserting the preset'); };
  const discard = async () => {
    const settled = await Promise.allSettled(receipts.map(receipt => native!.discardModel3d!(receipt)));
    const errors = settled.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
    if (errors.length) throw new AggregateError(errors, 'Some prepared model files could not be discarded; referenced files were retained');
  };
  if (models.length && (!root || !native?.importModel3d || !native.adoptModel3d || !native.discardModel3d || !native.remove)) throw new Error('3D slide presets require the Flux desktop app');
  try {
    for (const entry of models) {
      current();
      if (!entry.data.startsWith('data:model/gltf-binary;base64,')) throw new Error('Invalid 3D preset data');
      const dir = joinPath(root, '.meta'), stem = joinPath(dir, `model3d-preset-${crypto.randomUUID()}`), source = `${stem}.glb`;
      const temporary = [source, `${stem}.fluxplot.json`, `${stem}.recipe.json`];
      await native!.mkdir(dir);
      try {
        // This is an explicit portable import, not authoring-state residency.
        // The native importer validates/prepares these temporary bytes and owns
        // atomic publication of the final immutable asset and its receipt.
        await native!.writeFile(source, dataUrlToBytes(entry.data)); current();
        if (entry.manifest !== undefined) await native!.writeText(temporary[1], typeof entry.manifest === 'string' ? entry.manifest : JSON.stringify(entry.manifest));
        if (entry.recipe !== undefined) await native!.writeText(temporary[2], typeof entry.recipe === 'string' ? entry.recipe : JSON.stringify(entry.recipe));
        const result = await native!.importModel3d!({ root, sourcePath: source, target: { kind: 'slide', deckId } });
        receipts.push({ root, target: { kind: 'slide', deckId }, assetId: result.asset.id, receipt: result.receipt });
        current();
        if (entry.modelMetadataActive === false && result.manifest) {
          throw new Error('This preset contains inactive 3D metadata that would become active after import. Re-export the model with a matching manifest before inserting it; the saved preset is unchanged.');
        }
        assets.push(result.asset); remap.set(entry.asset.id, result);
      } finally {
        // FileBridge.remove deliberately removes files only. Never request a
        // recursive project-directory deletion for portable-import cleanup.
        await Promise.all(temporary.map(file => native!.remove!(file)));
      }
    }
    for (const element of snap.slide.elements) if (element.type === 'model3d' && remap.has(element.assetId)) {
      const result = remap.get(element.assetId)!; element.assetId = result.asset.id;
      delete element.source; delete element.manifestRef;
    }
    for (const beat of snap.slide.beats) for (const track of beat.tracks) if (track.to?.assetId && remap.has(track.to.assetId)) {
      track.to.assetId = remap.get(track.to.assetId)!.asset.id;
      for (const key of ['glbPath','sha256','manifestPath','recipePath','external','frozen']) delete (track.to as Record<string, unknown>)[key];
    }
    snap.assets = snap.assets?.filter(entry => entry.asset.kind !== 'glb');
    return { snapshot: snap, assets, results: [...remap.values()], discard,
      adopt: async () => { for (const receipt of receipts) await native!.adoptModel3d!(receipt); } };
  } catch (error) {
    try { await discard(); } catch (cleanup) { throw new AggregateError([error, cleanup], String(error)); }
    throw error;
  }
}
