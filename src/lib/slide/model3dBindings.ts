/** All original-byte receipts participate, including content-only target models. */
import { model3dBindingsFromReceipts } from '../model3d/sourceBinding';
import { resolveTrack } from './resolve';
import type { Deck } from './types';
export function deckModel3dBindings(deck: Deck) {
  const receipts: { assetId: string; sha256: string }[] = [];
  for (const slide of deck.slides) {
    for (const element of slide.elements) if (element.type === 'model3d' && element.source?.sha256)
      receipts.push({ assetId: element.assetId, sha256: element.source.sha256 });
    for (const beat of slide.beats) for (const raw of beat.tracks) {
      const track = resolveTrack(raw, deck);
      if (track.to?.assetId && typeof track.to.sha256 === 'string') receipts.push({ assetId: track.to.assetId, sha256: track.to.sha256 });
    }
  }
  return model3dBindingsFromReceipts(receipts);
}
