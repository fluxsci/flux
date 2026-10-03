import type { FontRequest } from "./fontRequest.mjs";
export type { FontRequest } from "./fontRequest.mjs";
export { parseFamilyStack, fontRequestKey } from "./fontRequest.mjs";
export const BUNDLED_FAMILIES: Readonly<Record<string, string>>;
export type FontFormat = "ttf" | "otf" | "ttc" | "woff" | "woff2" | null;
export interface FontFace { index: number; family: string; legacyFamily: string; subfamily: string; weight: number; italic: boolean }
export interface ResolvedFont { file: string | null; index: number; family: string; bundled?: string }
export interface LookupResult { key: string; bytes: Uint8Array | null; format: FontFormat; file?: string; bundled?: string }
export interface ResolveOptions { platform?: string; dirs?: string[]; cacheFile?: string; fcMatch?: boolean }
export function fontFormat(bytes: Uint8Array): FontFormat;
export function readFontFaces(bytes: Uint8Array): FontFace[];
export function extractFace(bytes: Uint8Array, index?: number): Uint8Array | null;
export function systemFontDirs(platform?: string, env?: Record<string, string | undefined>, home?: string): string[];
export function fontIndex(opts?: { dirs?: string[]; cacheFile?: string }): Promise<Record<string, { stamp: string; faces: FontFace[] }>>;
export function pickFace(index: Record<string, { stamp: string; faces: FontFace[] }>, family: string, weight: number, italic: boolean): { file: string; index: number; family: string } | null;
export function resolveFontFile(req: FontRequest, opts?: ResolveOptions): Promise<ResolvedFont | null>;
export function lookupFont(req: FontRequest, opts?: ResolveOptions): Promise<LookupResult>;
