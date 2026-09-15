// The X-ray's "Animate selected" seam (2026-09-15). The X-ray is a shared
// figure surface and must not import the slide store, so Slide mode REGISTERS
// a handler here while it is mounted; in Figure mode the hook is null and the
// action renders greyed out. Keeps the slide bundle out of figure mode.

import { writable } from "svelte/store";

export interface XrayAnimateTarget {
  elementId: string;
  partId?: string;
}
export type XrayAnimateKind = "appear" | "emphasize" | "disappear" | "change";
export interface XrayAnimateRequest {
  kind: XrayAnimateKind;
  targets: XrayAnimateTarget[];
}
export type XrayAnimateHandler = (req: XrayAnimateRequest) => void;

/** Non-null only while a slide editor is mounted. */
export const xrayAnimate = writable<XrayAnimateHandler | null>(null);
