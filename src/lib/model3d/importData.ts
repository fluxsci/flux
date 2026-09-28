/** Import and preview policy shared by the renderer fixture, native IO and CLI.
 * This module owns data only. Publication and source authorization belong to IO. */
import { prepareGlb } from './glbCore.mjs';
import { parseScene3d, scene3dStateIssues } from './scene3d';
import { makeModel3dElement, type Model3dMakeOptions } from './make';
import { isUnderRoot, toProjectRelativeSource } from '../plot/source';
import { scene3dSourceBindingIssue } from './sourceBinding';
import type { Model3dAsset, Model3dInfo, Scene3dManifest } from './types';

export type Model3dImportTarget = { kind: 'figure' };
export interface Model3dImportMetadata {
  manifest?: Scene3dManifest;
  recipe?: unknown;
  raw?: { manifest?: string; recipe?: string };
  warnings: string[];
  manifestHash?: string;
}
export interface Model3dImportData extends Model3dImportMetadata {
  asset: Model3dAsset;
  sourceSha256: string;
}
export interface Model3dImportSource {
  glbPath: string;
  manifestPath?: string;
  recipePath?: string;
  frozen?: boolean;
}
export interface Model3dImportResult extends Model3dImportData {
  source: Model3dImportSource;
  receipt: string;
  assetPrefix: '' | 'fig';
}
export interface Model3dImportRequest {
  root: string;
  sourcePath: string;
  manifestPath?: string;
  recipePath?: string;
  target: Model3dImportTarget;
}
export interface Model3dImportOwnership {
  root: string;
  target: Model3dImportTarget;
  assetId: string;
  receipt: string;
}

const MAX_METADATA_BYTES = 4 * 1024 * 1024;
const encoder = new TextEncoder();
export async function sha256ModelBytes(bytes: Uint8Array | ArrayBuffer): Promise<string> {
  const copy = bytes instanceof Uint8Array ? new Uint8Array(bytes) : new Uint8Array(bytes.slice(0));
  const digest = await crypto.subtle.digest('SHA-256', copy.buffer);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

/** Large preview geometry has already been inspected in the worker. This helper
 * validates only small metadata and binds it to the original source receipt. */
export async function parseModel3dImportMetadata(input: {
  info: Model3dInfo;
  sourceSha256: string;
  manifestText?: string;
  recipeText?: string;
}): Promise<Model3dImportMetadata> {
  const result: Model3dImportMetadata = { warnings: [...input.info.warnings] };
  if (input.manifestText !== undefined) {
    const text = input.manifestText;
    if (encoder.encode(text).byteLength > MAX_METADATA_BYTES) {
      result.warnings.push('3D manifest exceeds 4 MiB; importing the mesh without scene metadata');
    } else {
      result.raw = { manifest: text };
      result.manifestHash = await sha256ModelBytes(encoder.encode(text));
      const parsed = parseScene3d(text);
      if ('issue' in parsed) result.warnings.push(`${parsed.issue}; importing the mesh without scene metadata`);
      else {
        const issue = scene3dSourceBindingIssue(parsed, { kind: 'known', sha256: input.sourceSha256 });
        if (issue) result.warnings.push(`${issue}; importing the mesh without scene metadata`);
        else {
          result.manifest = parsed;
          result.warnings.push(...scene3dStateIssues(parsed, input.info));
        }
      }
    }
  }
  if (input.recipeText !== undefined) {
    if (encoder.encode(input.recipeText).byteLength > MAX_METADATA_BYTES) {
      result.warnings.push('3D recipe exceeds 4 MiB; regeneration metadata was ignored');
    } else {
      result.raw = { ...result.raw, recipe: input.recipeText };
      try { result.recipe = JSON.parse(input.recipeText); }
      catch { result.warnings.push('Invalid 3D recipe JSON; regeneration metadata was ignored'); }
    }
  }
  result.warnings = [...new Set(result.warnings)];
  return result;
}

export async function prepareModel3dImport(input: {
  bytes: Uint8Array;
  assetId: string;
  name: string;
  manifestText?: string;
  recipeText?: string;
}): Promise<{ bytes: Uint8Array; data: Model3dImportData }> {
  if (!/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,180}$/.test(input.assetId) ||
      ['__proto__', 'constructor', 'prototype'].includes(input.assetId)) throw new Error('Unsafe model asset id');
  const prepared = prepareGlb(input.bytes);
  const [sourceSha256, sha256] = await Promise.all([
    sha256ModelBytes(input.bytes), sha256ModelBytes(prepared.bytes),
  ]);
  const metadata = await parseModel3dImportMetadata({
    info: prepared.info, sourceSha256, manifestText: input.manifestText, recipeText: input.recipeText,
  });
  const naturalWidth = (metadata.manifest?.size?.width ?? 3.5) * 96;
  const naturalHeight = (metadata.manifest?.size?.height ?? 2.625) * 96;
  const asset: Model3dAsset = {
    id: input.assetId, kind: 'glb', name: input.name, path: `assets/${input.assetId}.glb`,
    naturalWidth, naturalHeight, sha256, bytes: prepared.bytes.byteLength, model: prepared.info,
  };
  return { bytes: prepared.bytes, data: { ...metadata, asset, sourceSha256 } };
}

export function makeImportedModel3dElement(
  result: Model3dImportData & { source?: Model3dImportSource },
  options: Model3dMakeOptions & { root?: string | null } = {},
) {
  const element = makeModel3dElement(result.asset, { ...options, manifest: result.manifest });
  if (result.manifest) element.manifestRef = {
    specVersion: result.manifest.schemaVersion, ...(result.manifestHash ? { hash: result.manifestHash } : {}),
  };
  if (result.source) {
    const source = result.source;
    const relative = (p?: string) => p ? toProjectRelativeSource(options.root, p) : undefined;
    element.source = {
      glbPath: relative(source.glbPath)!, sha256: result.sourceSha256,
      ...(source.manifestPath ? { manifestPath: relative(source.manifestPath) } : {}),
      ...(source.recipePath ? { recipePath: relative(source.recipePath) } : {}),
      ...(options.root && !isUnderRoot(options.root, source.glbPath) ? { external: true } : {}),
      ...(source.frozen ? { frozen: true } : {}),
    };
  }
  return element;
}
