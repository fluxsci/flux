// The X-ray's "Animate selected" seam (2026-09-15). The X-ray is a shared
// figure surface and must not import the slide store, so Slide mode REGISTERS
// a handler here while it is mounted; in Figure mode the hook is null and the
// action renders greyed out. Keeps the slide bundle out of figure mode.

import { writable } from "svelte/store";

export interface XrayAnimateTarget {
  elementId: string;
  partId?: string;
  groupId?: string;
}
export type XrayAnimateKind = "appear" | "emphasize" | "disappear" | "change" | "become-destination" | "appear-from" | "animate-like";
export interface XrayAnimateRequest {
  kind: XrayAnimateKind;
  targets: XrayAnimateTarget[];
}
export type XrayAnimateHandler = (req: XrayAnimateRequest) => void;

/** Non-null only while a slide editor is mounted. */
export const xrayAnimate = writable<XrayAnimateHandler | null>(null);

/** View-only destination picking; the shared X-ray never imports Slide mode. */
export const xrayBecomeSource = writable<string | null>(null);

/** Live X-ray parity for the Slide Become picker (2026-10-02): while a pick is
 *  waiting (`xrayBecomeSource` set), every USER-driven row pick (click, toggle,
 *  range, sweep, `a`, Ctrl+A) is published here with the rows' targets in the
 *  "become-destination" form, so the canvas outlines follow the rows as they
 *  are picked. `rootElementIds` names the objects the X-ray tree covers: their
 *  picks are replaced by `targets`, everything else stays picked. */
export interface XrayPickUpdate { rootElementIds: string[]; targets: XrayAnimateTarget[] }
export const xrayPickSink = writable<((update: XrayPickUpdate) => void) | null>(null);
