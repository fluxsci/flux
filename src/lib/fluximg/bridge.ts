/** Requests that cross to the file side (Electron main, or the in-memory bridge in dev fixtures). Pure types. */
import type { FluximgManifest } from "./types";

/** Copy a bundle into the project as an immutable asset directory. */
export interface FluximgImportRequest {
  /** Project root. */
  root: string;
  /** The source bundle directory: absolute, or relative to the project root. */
  sourcePath: string;
  /** The asset id it will be stored under: `fig/assets/<assetId>.fluximg/`. */
  assetId: string;
}

export interface FluximgImportResult {
  /** Path inside `fig/`, the way `Asset.path` is written: `assets/<assetId>.fluximg`. */
  path: string;
  /** Content id: SHA-256 over the sorted (relative path, file SHA-256) pairs of the bundle. */
  sha256: string;
  bytes: number;
  files: number;
  manifest: FluximgManifest;
  /** How the bytes got there. */
  method: "clone" | "hardlink" | "copy";
}

/** Read part of one file of a bundle. The file side confines it to the named bundle. */
export interface FluximgReadRequest {
  root: string;
  /** Bundle directory relative to the project root (`fig/assets/<id>.fluximg`, or a bundle under `plots/`). */
  bundle: string;
  /** POSIX path inside the bundle. */
  path: string;
  /** Byte offset; negative counts from the end of the file. */
  offset: number;
  /** Bytes to read; -1 reads from `offset` to the end. A single read is limited to 32 MiB. */
  length: number;
}

export const FLUXIMG_READ_LIMIT = 32 * 1024 * 1024;
