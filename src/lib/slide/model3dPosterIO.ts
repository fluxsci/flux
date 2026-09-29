/** Browser static export adapter. Immutable file ownership, never active-Figure lookup. */
import type { SlidePayloadIO } from './payload';
import { fileBridge } from '../project/types';
export function slideModelPosterIO(root: string, io: SlidePayloadIO): SlidePayloadIO {
  if (io.modelPoster) return io;
  const bridge = fileBridge();
  if (!bridge) return io;
  return { ...io, modelPoster: async (request, relative) => {
    const { modelPosterUrl } = await import('../model3d/posterStore');
    const source = { root, prefix: '', bridge, scope: `slide-export:${root}`, isCurrent: () => true };
    return modelPosterUrl({ ...request, asset: { ...request.asset, path: relative }, surface: 'slide' }, { source });
  } };
}
