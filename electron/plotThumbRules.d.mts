// Types for plotThumbRules.mjs (hand-written, the dissectRules.d.ts precedent).
export interface InkStats { v: number; opaqueBorder: number; exposed: number; halo: number; bins: number[]; edgeBins: number[] }
export type BackdropMode = "auto" | "paper" | "dark" | "checker" | "destination";
export type BackdropKind = "own" | "manifest" | "paper" | "dark" | "mid" | "checker" | "destination";
export interface BackdropChoice { kind: BackdropKind; color: string | null; reason: string }

export const THUMB_BUCKETS: number[];
export const PLOT_THUMB_GEN: number;
export const ANALYSIS_WIDTH: number;
export const HUG_RADIUS: number;
export const INK_BINS: number;
export const EDGE_SHARE: number;
export const BACKDROPS: Readonly<{ paper: string; dark: string; mid: string }>;
export const LOST_BELOW: number;
export const POOR_BELOW: number;
export const CONTRAST_CAP: number;
export const KNOCKOUT_SHARE: number;
export const BACKDROP_BIAS: Readonly<{ manifest: number; paper: number; dark: number; mid: number }>;

export function bucketFor(cssWidth: number, dpr?: number): number;
export function svgLengthPx(value: string | null | undefined): number | null;
export function svgRootTag(text: string): string | null;
export function svgIntrinsicSize(headText: string): { width: number; height: number } | null;
export function pngInfo(bytes: Uint8Array): { width: number; height: number; dpi: number | null } | null;
export function probeImageSize(name: string, bytes: Uint8Array | string): { width: number; height: number; physMm: [number, number] | null } | null;
export function luminance8(r: number, g: number, b: number): number;
export function contrastRatio(la: number, lb: number): number;
export function binLuminance(i: number): number;
export function analyzeInk(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number, opts?: { premultiplied?: boolean; classes?: Uint8Array | null }): InkStats;
export function presentBins(stats: InkStats | null | undefined): number[];
export function backdropScore(stats: InkStats, color: string, ignoreBelow?: number): number;
export function lostShare(stats: InkStats, color: string): number;
export function chooseBackdrop(stats: InkStats | null | undefined, opts?: { manifestPaper?: string | null; mode?: BackdropMode; destination?: string | null }): BackdropChoice;
export function readsPoorlyOn(stats: InkStats | null | undefined, background: string | null | undefined): boolean;
export function backdropTone(choice: BackdropChoice | null | undefined): "light" | "dark";
