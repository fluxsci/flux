/**
 * Everything of an image the slide engine runs (stage 2, review B5): the player's image binding and movies, the view
 * tween and checks, the object index, its styles and geometry, the static markup. The engine never imports these
 * modules: it reaches them through `slide/imageSeam.ts`, which asks `slide/imageKitSource.ts` for this kit.
 *   - The app and Node bind it statically (`imageKitSource.ts` imports this module: nothing to load at run time).
 *   - The exported runtimes (eager, video, Paper embed) are built with `imageKitSource.runtime.ts` in its place, which
 *     takes the kit from the image runtime a document with images carries (`FluxImageRuntime.kit`,
 *     `export/fluximgRuntime.ts`). A document without images carries none of this code.
 * A new export here is a new reach of the engine into image code: add it to `imageSeam.ts`, never import it directly.
 */
export { createFluximgController, flushSlideFluximgs, fillFluximg, fluximgTween, setSlideFluximgFrame } from "../slide/player/fluximg";
export { createFluximgMovieController, joinMedia, slideMovieTargets } from "../slide/player/fluximgMedia";
export {
  fluximgObject, fluximgPartIdOf, fluximgPartNode, fluximgPartNodes, fluximgPartsLookup, fluximgPartsPending, fluximgPartTargets,
  fluximgTableLookup, imageToBox, imageToStage, objectStaggerCoordinates, parseFluximgPartId, partIndexFromTexts,
} from "./parts";
export { checkMergedView, checkViewPatch } from "./viewCheck";
export { lerpFluximgView, planViewTween, sampleViewTween } from "./viewTween";
export { resolveView, explicitView, isEmptyViewPatch, patchView, viewPatch } from "./viewOps";
export { cachedObjectStyles, missingStyle } from "./objectStyle";
export { walkableDims } from "./playback";
export { fluximgElementMarkup } from "./exportStatic";
export { insetsOf } from "./static";
export { clampCrop, zoomedStillScale } from "./crop";
export { payloadImageHost, payloadImageContext } from "../slide/export/fluximgPayloadHost";
