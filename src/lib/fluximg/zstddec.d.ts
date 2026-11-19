/** three ships this decoder without types. It is the zstd decoder the renderer's workers use. */
declare module "three/examples/jsm/libs/zstddec.module.js" {
  export class ZSTDDecoder {
    init(): Promise<void>;
    decode(array: Uint8Array, uncompressedSize?: number): Uint8Array;
  }
}
