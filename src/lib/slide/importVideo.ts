import { fileBridge } from "../project/types";
import { assetData, setAssetData } from "../assets";
import { makeVideoElement } from "./mediaTypes";
import type { Incoming } from "../io";

/** Native preparation keeps large source/encoded bytes out of renderer memory.
 * The caller rechecks its destination before publishing the returned placement. */
export async function readIncomingVideo(path: string, request: {
  root: string; deckId: string; jobId: string; width: number; height: number;
}): Promise<Incoming> {
  const bridge = fileBridge();
  if (!bridge?.prepareSlideVideo) throw new Error("Video import requires the Flux desktop app.");
  const result = await bridge.prepareSlideVideo({ root: request.root, deckId: request.deckId, path, jobId: request.jobId });
  const width = result.asset.naturalWidth ?? 0, height = result.asset.naturalHeight ?? 0;
  const durationMs = result.asset.durationMs ?? 0;
  if (!(width > 0 && height > 0 && durationMs > 0)) {
    await bridge.discardVideoImport?.({ root: request.root, deckId: request.deckId, assetId: result.asset.id });
    throw new Error("The clip has no readable video frames or duration.");
  }
  setAssetData(result.asset.id, result.url);
  setAssetData(result.posterAsset.id, result.poster);
  return {
    asset: result.asset,
    extraAssets: [result.posterAsset],
    el: makeVideoElement(result.asset, result.posterAsset.id, request),
  };
}

export async function discardIncomingVideo(incoming: Incoming, root: string, deckId: string): Promise<void> {
  if (incoming.el.type !== "video") return;
  await fileBridge()?.discardVideoImport?.({ root, deckId, assetId: incoming.asset.id });
  const ids = [incoming.asset.id, ...(incoming.extraAssets ?? []).map(asset => asset.id)];
  assetData.update(data => { const next = { ...data }; for (const id of ids) delete next[id]; return next; });
}
