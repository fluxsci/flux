/** The conditional image runtime (`FluxImageRuntime`, export/fluximgRuntime.ts) when the document carries it: present
 *  only in documents whose payload holds an image. A type-only import: nothing of it enters the eager runtimes. */
export type FluxImageRuntime = typeof import("./fluximgRuntime");
export const imageRuntime = (): FluxImageRuntime | undefined => (globalThis as { FluxImageRuntime?: FluxImageRuntime }).FluxImageRuntime;
