/**
 * THE seam between the slide engine and image code (stage 2, review B5). The engine's modules (player, render,
 * transform, compile, targets, geometry, tween, media timeline, the SVG writer) import image functions from HERE,
 * under their own names, never from `fluximg/**` or `player/fluximg*`. Each one forwards to the image kit
 * (`fluximg/slideKit.ts`) that `imageKitSource` finds: bound statically in the app and Node, the document's
 * `FluxImageRuntime.kit` in an exported runtime. So a deck, video or Paper embed without images carries none of the
 * image code: only this file (a forwarder per function) and the constant-time kind checks below.
 *
 * Every forwarder is reached only behind an image test (`el.type === "fluximg"`, an image part index, an image
 * context), except the lookups marked "any deck", which answer "none" without a kit.
 */
import type { FluximgPartIndex, FluximgPartsLookup, FluximgTableLookup } from "../fluximg/parts";
import { imageKit, type ImageKit } from "./imageKitSource";

export type { ImageKit };
export { imageKit };

/** The kit, on a path only an image takes (its absence there is a document built without its image runtime). */
function need(): ImageKit {
  const kit = imageKit();
  if (!kit) throw new Error("This document holds an image but not the image runtime. Export it again with this version of Flux.");
  return kit;
}

// --- constant-time kind checks (any deck) ----------------------------------------------------------------------
/** An image's object index (`parts.FLUXIMG_PARTS_SPEC`), as opposed to a plot or model manifest. */
export const isFluximgPartIndex = (m: unknown): m is FluximgPartIndex => !!m && (m as { spec?: unknown }).spec === "fluximg/parts";
/** `explicit` when given, else the registered provider (any deck: none without a kit). */
export const fluximgPartsLookup = (explicit?: FluximgPartsLookup): FluximgPartsLookup | undefined => explicit ?? imageKit()?.fluximgPartsLookup();
/** `explicit` when given, else the registered table lookup (any deck: none without a kit). */
export const fluximgTableLookup = (explicit?: FluximgTableLookup): FluximgTableLookup | undefined => explicit ?? imageKit()?.fluximgTableLookup();

/** The payload's image host (stills and baked clips): undefined without images or without a kit (any deck). */
export const payloadImageHost = (...a: Parameters<ImageKit["payloadImageHost"]>): ReturnType<ImageKit["payloadImageHost"]> => imageKit()?.payloadImageHost(...a);

// --- forwarders (image paths only) -----------------------------------------------------------------------------
type K = ImageKit;
export const createFluximgController: K["createFluximgController"] = (...a) => need().createFluximgController(...a);
export const flushSlideFluximgs: K["flushSlideFluximgs"] = (...a) => need().flushSlideFluximgs(...a);
export const fillFluximg: K["fillFluximg"] = (...a) => need().fillFluximg(...a);
export const fluximgTween: K["fluximgTween"] = (...a) => need().fluximgTween(...a);
export const setSlideFluximgFrame: K["setSlideFluximgFrame"] = (...a) => need().setSlideFluximgFrame(...a);
export const fluximgShownCrop: K["fluximgShownCrop"] = (...a) => need().fluximgShownCrop(...a);
export const createFluximgMovieController: K["createFluximgMovieController"] = (...a) => need().createFluximgMovieController(...a);
export const joinMedia: K["joinMedia"] = (...a) => need().joinMedia(...a);
export const slideMovieTargets: K["slideMovieTargets"] = (...a) => need().slideMovieTargets(...a);
export const fluximgObject: K["fluximgObject"] = (...a) => need().fluximgObject(...a);
export const fluximgPartIdOf: K["fluximgPartIdOf"] = (...a) => need().fluximgPartIdOf(...a);
export function fluximgPartNode<T = Element>(...a: Parameters<K["fluximgPartNode"]>): T | null { return need().fluximgPartNode<T>(...a); }
export function fluximgPartNodes<T = Element>(...a: Parameters<K["fluximgPartNodes"]>): Array<T | null> { return need().fluximgPartNodes<T>(...a); }
export const fluximgPartsPending: K["fluximgPartsPending"] = (...a) => need().fluximgPartsPending(...a);
export const fluximgPartTargets: K["fluximgPartTargets"] = (...a) => need().fluximgPartTargets(...a);
export const imageToBox: K["imageToBox"] = (...a) => need().imageToBox(...a);
export const imageToStage: K["imageToStage"] = (...a) => need().imageToStage(...a);
export const objectStaggerCoordinates: K["objectStaggerCoordinates"] = (...a) => need().objectStaggerCoordinates(...a);
export const missingStaggerColumns: K["missingStaggerColumns"] = (...a) => need().missingStaggerColumns(...a);
export const parseFluximgPartId: K["parseFluximgPartId"] = (...a) => need().parseFluximgPartId(...a);
export const partIndexFromTexts: K["partIndexFromTexts"] = (...a) => need().partIndexFromTexts(...a);
export const checkMergedView: K["checkMergedView"] = (...a) => need().checkMergedView(...a);
export const checkViewPatch: K["checkViewPatch"] = (...a) => need().checkViewPatch(...a);
export const lerpFluximgView: K["lerpFluximgView"] = (...a) => need().lerpFluximgView(...a);
// a step's view as a patch over the view before it (the tween core's applyState / diffState, on an image only)
export const patchView: K["patchView"] = (...a) => need().patchView(...a);
export const viewPatch: K["viewPatch"] = (...a) => need().viewPatch(...a);
export const isEmptyViewPatch: K["isEmptyViewPatch"] = (...a) => need().isEmptyViewPatch(...a);
export const explicitView: K["explicitView"] = (...a) => need().explicitView(...a);
export const sampleViewTween: K["sampleViewTween"] = (...a) => need().sampleViewTween(...a);
export const planViewTween: K["planViewTween"] = (...a) => need().planViewTween(...a);
export const insetsOf: K["insetsOf"] = (...a) => need().insetsOf(...a);
export const clampCrop: K["clampCrop"] = (...a) => need().clampCrop(...a);
export const zoomedStillScale: K["zoomedStillScale"] = (...a) => need().zoomedStillScale(...a);
export const resolveView: K["resolveView"] = (...a) => need().resolveView(...a);
export const cachedObjectStyles: K["cachedObjectStyles"] = (...a) => need().cachedObjectStyles(...a);
export const missingStyle: K["missingStyle"] = (...a) => need().missingStyle(...a);
export const walkableDims: K["walkableDims"] = (...a) => need().walkableDims(...a);
export const payloadImageContext: K["payloadImageContext"] = (...a) => need().payloadImageContext(...a);
export const fluximgElementMarkup: K["fluximgElementMarkup"] = (...a) => need().fluximgElementMarkup(...a);
