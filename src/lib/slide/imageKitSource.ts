/**
 * Where the slide engine finds its image code (`fluximg/slideKit.ts`): HERE, statically, for the app and Node (it costs
 * nothing at run time there). The exported runtimes are built with `imageKitSource.runtime.ts` in place of this module
 * (`scripts/runtime-seams.mjs`), so a document without images carries none of the kit. Only `imageSeam.ts` imports this.
 */
import * as kit from "../fluximg/slideKit";

export type ImageKit = typeof kit;
export const imageKit = (): ImageKit | undefined => kit;
