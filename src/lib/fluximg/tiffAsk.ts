/**
 * The TIFF asking surface's state (one question at a time per window), apart from the import flow so the canvas and
 * the keymap can read it without loading the flow (`tiffImport.ts` writes it; `TiffAskSurface.svelte` draws it).
 */
import { writable } from "svelte/store";
import type { DimsAnswer, DimsProposal, TiffProbe } from "../tiff/types";
import type { TiffPreviewPng } from "../tiff/bridge";

export type RememberScope = "off" | "project" | "machine";

export interface AskState {
  /** Bumps on every new question (the surface keys its entrance on it). */
  id: number;
  figureId: string;
  /** Figure-local point the surface centres on (where the image will land). */
  at: { x: number; y: number };
  name: string;
  probe: TiffProbe;
  proposals: DimsProposal[];
  answer: DimsAnswer;
  /** The proposal the answer came from (-1 once edited). */
  chosen: number;
  /** Fields the file itself says ("pixelSize", "time", "z", "channels"), for the marks beside them. */
  fileSays: Record<string, string>;
  /** Pictures of the current answer, and of what a hovered key would do (shown instead while it is hovered). */
  preview: TiffPreviewPng | null;
  hover: TiffPreviewPng | null;
  /** Why Convert is off, in words (null: it can convert). */
  problem: string | null;
  remember: RememberScope;
  /** A rule already remembered for files like this one. */
  remembered: { scope: "project" | "machine"; summary: string } | null;
  /** Why a file whose metadata says enough is asked about anyway (a value that looks like "no data"), or null. */
  reason: string | null;
  /** Files of this kind the answer converts (this one included), and files of other kinds waiting their turn. */
  counts: { kind: number; waiting: number };
}

export const tiffAsk = writable<AskState | null>(null);
