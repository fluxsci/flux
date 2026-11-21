/** The conditional image runtime (`FluxImageRuntime`, export/fluximgRuntime.ts) when the document carries it: present
 *  only in documents whose payload holds an image. The document carries it as a factory (`FluxImageRuntimeFactory`,
 *  scripts/runtime-seams.mjs imageRuntimeText), evaluated here once, on first use, after the base runtime published
 *  what the kit takes from it. A type-only import: nothing of it enters the eager runtimes. */
export type FluxImageRuntime = typeof import("./fluximgRuntime");
type Scope = { FluxImageRuntime?: FluxImageRuntime; FluxImageRuntimeFactory?: () => FluxImageRuntime };
export const imageRuntime = (): FluxImageRuntime | undefined => {
  const g = globalThis as Scope;
  if (!g.FluxImageRuntime && g.FluxImageRuntimeFactory) g.FluxImageRuntime = g.FluxImageRuntimeFactory();
  return g.FluxImageRuntime;
};
