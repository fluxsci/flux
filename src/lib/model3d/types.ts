/** Portable 3D data. No renderer or IO dependencies belong in this module. */
import type { Asset, ElementBase, PartOverride, SemanticPlotElement } from '../types';

export type Vec3 = [number, number, number];
/** `radius` (asset metadata only; never in scene3d manifests) is the tight orbit
 * framing radius from glbCore; bounds without it frame by the half-diagonal. */
export interface ModelBounds { min: Vec3; max: Vec3; radius?: number }
export interface ModelTopologyPart { node: string; mode: number; vertices: number; indicesHash: string }
export interface Model3dInfo {
  triangles: number; vertices: number; primitives: number; meshes: number;
  bounds: ModelBounds; hasNormals: boolean; hasColors: boolean; hasValues: boolean;
  materialColors: string[]; partNames: string[]; warnings: string[]; extensions: string[];
  topology: { key: string; parts: ModelTopologyPart[] }; states: string[];
}
export interface Model3dAsset extends Omit<Asset, 'kind'> {
  kind: 'glb'; sha256: string; bytes: number; model: Model3dInfo;
}
export type OrbitProjection = 'orthographic' | 'perspective';
export type ModelColors = 'uniform' | 'source';
export type ModelLighting = 'studio' | 'unlit';
export interface ModelFieldOverride { cmap?: string; range?: [number, number] }
export interface Model3dElement extends ElementBase {
  type: 'model3d'; assetId: string;
  orbitAzimuth: number; orbitElevation: number; orbitRoll?: number; orbitZoom: number;
  orbitPanX?: number; orbitPanY?: number; orbitProjection: OrbitProjection; orbitFov: number;
  fill: string; modelColors?: ModelColors; modelLighting?: ModelLighting;
  overrides?: Record<string, PartOverride>; fields?: Record<string, ModelFieldOverride>;
  modelStates?: Record<string, number>;
  manifestRef?: SemanticPlotElement['manifestRef'];
  /** source.sha256 is the original file receipt; Asset.sha256 hashes prepared bytes. */
  source?: { glbPath: string; sha256?: string; manifestPath?: string; recipePath?: string; external?: boolean; frozen?: boolean };
}
export interface Scene3dField {
  cmap: { name: string; stops: Array<[number, string]> }; range: [number, number];
  rule?: { percentile?: [number, number] }; label?: string; ticks?: number[]; missingColor?: string;
}
export interface Scene3dPart {
  id: string; role: string; series?: string; label?: string; parent?: string;
  kind?: 'mesh' | 'field' | 'missing' | 'furniture'; node?: string; color?: string;
  opacity?: number; hidden?: boolean; field?: Scene3dField | string; text?: string; length?: number; entries?: string[];
}
export interface Scene3dAxis { lim?: [number, number]; ticks?: number[]; tickLabels?: string[]; label?: string }
export interface Scene3dManifest {
  spec: 'fluxplot/scene3d'; schemaVersion: '0.1.0'; glb: string; glbSha256?: string; plotType?: 'scene3d';
  size?: { width: number; height: number; unit: 'in' }; units?: string; toWorld?: number[]; bounds?: ModelBounds;
  view?: { azimuth?: number; elevation?: number; roll?: number; zoom?: number; panX?: number; panY?: number;
    projection?: OrbitProjection; fov?: number; states?: Record<string, number> };
  lighting?: ModelLighting;
  style?: { font?: string; fontSizePt?: number; titleSizePt?: number; ink?: string; muted?: string; lineWidthPt?: number };
  parts?: Scene3dPart[];
  axes?: { kind?: 'none' | 'box' | 'triad'; x?: Scene3dAxis; y?: Scene3dAxis; z?: Scene3dAxis; grid?: boolean };
  layout?: { colorbar?: 'right' | 'none'; legend?: 'right' | 'none'; title?: 'top' | 'none' };
  morphGroup?: string; states?: Array<{name: string; label?: string}>; sequence?: boolean; order?: string[];
  build?: {generator?: string; provenance?: Record<string, unknown>};
}
export interface Model3dRenderSpec {
  assetId: string; w: number; h: number; element: Model3dElement; manifest?: Scene3dManifest;
  morph?: { to: string; t: number; pairs: Array<{nodeA: string; nodeB: string; primitiveA?: number; primitiveB?: number}>; toElement?: Model3dElement; toManifest?: Scene3dManifest };
  states?: Record<string, number>;
}
export type RenderSpec = Model3dRenderSpec;
export interface Rect { x: number; y: number; width: number; height: number }
