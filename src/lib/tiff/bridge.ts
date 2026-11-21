/** Requests a window sends to convert a TIFF (Electron main's `tiff:*`, or the in-memory bridge's twin). Pure types. */
import type { FluximgImportResult } from "../fluximg/bridge";
import type { AnswerRule, DimsAnswer, DimsProposal, TiffProbe } from "./types";

export interface TiffProbeRequest {
  root: string;
  /** Absolute, or relative to the project root. A dropped file names none: its path is the preload's. */
  sourcePath: string;
  /** Remembered rules to consult (the project's, then the machine's). */
  rules?: AnswerRule[];
  /** Longest side of each preview picture (default 256). */
  max?: number;
}

/** Small pictures of what an answer makes of the file: one per channel, PNG as base64. */
export interface TiffPreviewPng {
  channels: Array<{ name: string; color: string | null; width: number; height: number; png: string; window: [number, number] | null }>;
  plane: { width: number; height: number };
  at: string;
  fallback: boolean;
  channelCount: number;
  ms: number;
}

export interface TiffProbeResult {
  /** Stands for this file in this window from now on (previews and the conversion name it, never the path). */
  token: string;
  /** The file's name. */
  name: string;
  /** What the placed image records as its source: project-relative inside the project, else the path. */
  sourcePath: string;
  external: boolean;
  probe: TiffProbe;
  proposals: DimsProposal[];
  /** The top proposal's pictures (null when the file is refused). */
  preview: TiffPreviewPng | null;
}

export interface TiffPreviewRequest { root: string; token: string; answer: DimsAnswer; max?: number }

export interface TiffConvertRequest {
  root: string;
  token: string;
  answer: DimsAnswer;
  /** The bundle is published at fig/assets/<assetId>.fluximg. */
  assetId: string;
  /** Names this conversion for progress and cancel. */
  jobId: string;
}

export interface TiffConvertResult extends FluximgImportResult {
  /** The writer's notes (how the values were stored), as fluxplot prints them. */
  notes: string[];
  ms: number;
  bytesRead: number;
}

/** Progress of a conversion (at most ten a second). `queued`: waiting behind another conversion of this window. */
export interface TiffProgress {
  jobId: string;
  queued?: number;
  phase?: "learn" | "store";
  done?: number;
  total?: number;
  fraction?: number;
  bytesRead?: number;
  elapsedMs?: number;
}
