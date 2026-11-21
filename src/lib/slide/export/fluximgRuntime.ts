/** The image runtime as a separate CONDITIONAL IIFE (`FluxImageRuntime`): inlined only into documents whose payload
 *  holds an image (exportDeck.imageRuntimeFor, embedDocument), like the 3D runtime, so a deck without images carries
 *  none of it. It carries the image kit (`kit`: the player's image binding and movies, the view tween and checks, the
 *  object index and styles, the payload's image host) that the base runtimes reach through `slide/imageSeam.ts`.
 *  Never import this from the eager graph; the runtimes reach it through `imageRuntime()` / `imageKitSource`. */
export * as kit from "../../fluximg/slideKit";
export { payloadImageHost, payloadImageContext } from "./fluximgPayloadHost";
