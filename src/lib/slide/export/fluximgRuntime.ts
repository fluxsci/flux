/** The exported deck's image host as a separate CONDITIONAL IIFE (`FluxImageRuntime`): inlined only into documents
 *  whose payload holds an image (exportDeck.imageRuntimeFor), like the 3D runtime, so a deck without images carries
 *  none of it. Never import this from the eager graph; the runtimes reach it through `imageRuntime()`. */
export { payloadImageHost, payloadImageContext } from "./fluximgPayloadHost";
