// Types for managedTools.cjs (consumed by flux-core).
import type { spawn } from "node:child_process";

export type QuartoOrigin = "env" | "path" | "system" | "managed";
export interface QuartoAsset { file: string; bytes: number; sha256: string }
export declare const QUARTO: { readonly version: string; readonly baseUrl: string; readonly assets: Readonly<Record<string, QuartoAsset>> };
interface LookupOptions { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; home?: string; isExecutable?: (file: string) => boolean }

export declare function quartoAsset(platform?: NodeJS.Platform, arch?: string): QuartoAsset | null;
export declare function managedQuartoRoot(fluxConfigPath?: string): string;
export declare function managedQuartoDir(fluxConfigPath?: string, version?: string): string;
export declare function managedQuartoBin(fluxConfigPath?: string, platform?: NodeJS.Platform): string;
export declare function commonToolDirs(platform?: NodeJS.Platform, home?: string): string[];
export declare function findExecutableSync(name: string, options?: LookupOptions & { extraDirs?: string[] }): { file: string; origin: "path" | "system" } | null;
export declare function resolveQuartoSync(options?: LookupOptions & { fluxConfigPath?: string }): { command: string | null; origin: QuartoOrigin | null };
export declare function quartoCommandSync(options?: LookupOptions & { fluxConfigPath?: string }): string;
export declare function quartoVersion(command: string, options?: { spawnImpl?: typeof spawn; timeoutMs?: number }): Promise<string>;
export declare function installManagedQuarto(options?: {
  fluxConfigPath?: string; platform?: NodeJS.Platform; arch?: string; asset?: QuartoAsset | null; baseUrl?: string; version?: string;
  fetchImpl?: typeof fetch; spawnImpl?: typeof spawn; signal?: AbortSignal;
  onProgress?: (p: { phase: "download" | "verify" | "extract" | "done"; done: number; total: number }) => void;
}): Promise<{ command: string; version: string; origin: "managed" }>;
export declare function detectTexSync(options?: LookupOptions): { installed: boolean; kind: "tinytex" | "system" | null; path: string | null };
export declare function installTinytex(options?: { quarto?: string | null; spawnImpl?: typeof spawn; signal?: AbortSignal; onLog?: (chunk: string) => void }): Promise<{ ok: boolean; code: number | null; log: string }>;
export declare const PATH_MARKER: string;
export declare const PATH_LINE: string;
export declare function shellProfile(platform?: NodeJS.Platform, home?: string): string;
export declare function pathLinePresent(file: string): boolean;
export declare function ensurePathLine(options?: { platform?: NodeJS.Platform; home?: string; file?: string }): { file: string; changed: boolean };
export declare function launcherStatusSync(options?: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; home?: string }): { installed: boolean; onPath: boolean; launcher: string; profile: string };
