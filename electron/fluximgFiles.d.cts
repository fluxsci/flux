// Types of fluximgFiles.cjs for its TypeScript callers (flux-core's place-image verb). Keep in step with the JSDoc there.
import type { FluximgImportResult } from "../src/lib/fluximg/bridge";
export interface FluximgImportLimits { maxFiles?: number; maxDirs?: number; maxDepth?: number; maxBytes?: number }
export function importBundle(request: {
  root: string; sourcePath: string; assetId: string;
  checkCurrent?: () => unknown; readGuard?: (path: string) => unknown; limits?: FluximgImportLimits; tryClone?: boolean;
}): Promise<FluximgImportResult>;
export function readRange(request: { root: string; bundle: string; path: string; offset: number; length: number; readGuard?: (path: string) => unknown }): Promise<Buffer>;
export function discardBundle(request: { root: string; assetId: string; checkCurrent?: () => unknown }): Promise<void>;
export function loadRules(): Promise<typeof import("./fluximgRules.js")>;
