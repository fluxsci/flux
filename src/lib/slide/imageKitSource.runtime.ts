/**
 * The exported runtimes' `imageKitSource.ts` (swapped in by `scripts/runtime-seams.mjs`): the image kit is the one the
 * document's image runtime carries (`FluxImageRuntime.kit`, inlined only into documents whose payload holds an image).
 * Undefined in a document without images: the engine's image branches are never taken there.
 * It also publishes the engine functions the image runtime calls (`FluxSlideBase`, generated at build time).
 */
import "flux:image-host-base";
import { imageRuntime } from "./export/imageRuntime";
import type { ImageKit } from "./imageKitSource";

export type { ImageKit };
export const imageKit = (): ImageKit | undefined => imageRuntime()?.kit;
