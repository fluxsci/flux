// The X-ray row under the pointer, published for the canvas (2026-10-23): the
// canvas outlines those parts — dashed, like its own deep-hover box — so a row
// answers "where is this?" on the drawing itself (every plot, for a common row).
// Decoupled like animateHook: the X-ray writes it, the Canvas reads it.
import { writable } from "svelte/store";

export interface XrayHoverTarget { elementId: string; partId: string }
export const xrayHover = writable<XrayHoverTarget[] | null>(null);
