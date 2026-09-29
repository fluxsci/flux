/** Lightweight player/embedding contract. Importing it never loads WebGL. */
import type { Model3dElement, Model3dInfo, Model3dRenderSpec } from './types';

export type Model3dRenderExtra = Partial<Omit<Model3dRenderSpec, 'element' | 'w' | 'h' | 'assetId'>>;
export interface Model3dView {
  /** Inline hosts publish before returning; worker hosts settle asynchronously. */
  render(element: Model3dElement, width: number, height: number, extra?: Model3dRenderExtra): unknown | Promise<unknown>;
  dispose(): void;
}
export interface Model3dHost {
  ready(assetIds: string[], warm?: Model3dRenderSpec[]): Promise<void>;
  view(canvas: HTMLCanvasElement): Model3dView;
  flightView?(canvas: HTMLCanvasElement): Model3dView;
  modelStats?(assetId: string): Promise<Model3dInfo | undefined> | undefined;
  snapshot?(spec: Model3dRenderSpec): Promise<ImageBitmap>;
  dispose(): void;
}
