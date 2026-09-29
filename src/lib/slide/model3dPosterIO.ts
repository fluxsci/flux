/** Browser static export adapter. Immutable file ownership, never active-Figure lookup. */
import type { SlidePayloadIO } from './payload';
import { fileBridge } from '../project/types';
export function slideModelPosterIO(root: string, io: SlidePayloadIO, owner: { scope?: string; isCurrent?: () => boolean } = {}): SlidePayloadIO {
  if (io.modelPoster || typeof window === "undefined") return io;
  const bridge = fileBridge();
  if (!bridge) return io;
  return { ...io, modelPoster: async (request, relative) => {
    const { modelPosterUrl } = await import('../model3d/posterStore');
    const source = { root, prefix: '', bridge, scope: owner.scope ?? `slide-export:${root}`, isCurrent: owner.isCurrent ?? (() => true) };
    return modelPosterUrl({ ...request, asset: { ...request.asset, path: relative }, surface: 'slide' }, { source });
  } };
}
