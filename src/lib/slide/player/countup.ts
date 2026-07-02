// ---------------------------------------------------------------------------
// Flux Slide — countUp: the number tween ("n = 1,247 patients" counts up as you
// land the stat). A bespoke driver like morph — not WAAPI keyframes — sharing
// the MorphController {seek} contract, so the player's rAF driver, static-state
// seek(0|1), reduced-motion snap-to-1, and export bundling all come for free.
//
// Format is INFERRED from the target's current text (prefix/suffix around the
// first number, its decimals, thousands separators) so authors just type the
// final text and add the track; params can override every piece.
// ---------------------------------------------------------------------------

import type { Track } from "../types";
import type { MorphController } from "./morph";
import type { TargetNode } from "./presets";

interface CountUpParams {
  from?: number;
  to?: number;
  decimals?: number;
  prefix?: string;
  suffix?: string;
  /** Thousands separators in the output (default: inferred from the text). */
  separator?: boolean;
}

/** Build a countUp driver over ONE node (a text box, a block, or any element
 *  whose textContent carries the number). seek(0) shows `from`; seek(1) restores
 *  the authored final text exactly. */
export function createCountUp(node: TargetNode, track: Track): MorphController {
  const el = node as HTMLElement;
  const original = el.textContent ?? "";
  const m = original.match(/-?\d[\d,]*\.?\d*/);
  const parsed = m ? Number(m[0].replace(/,/g, "")) : NaN;
  const p = (track.params ?? {}) as CountUpParams;
  const to = p.to ?? (Number.isFinite(parsed) ? parsed : 100);
  const from = p.from ?? 0;
  const decimals = p.decimals ?? (m?.[0].includes(".") ? (m[0].split(".")[1]?.length ?? 0) : 0);
  const prefix = p.prefix ?? (m ? original.slice(0, m.index) : "");
  const suffix = p.suffix ?? (m ? original.slice((m.index ?? 0) + m[0].length) : "");
  const separator = p.separator ?? (m?.[0].includes(",") ?? false);

  const fmt = (v: number): string => {
    let s = v.toFixed(decimals);
    if (separator) {
      const [i, d] = s.split(".");
      s = i.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (d ? "." + d : "");
    }
    return prefix + s + suffix;
  };

  return {
    seek(t: number) {
      // t=1 restores the authored text verbatim (no rounding drift in the rest state).
      el.textContent = t >= 1 && m && p.to == null ? original : fmt(from + (to - from) * Math.max(0, Math.min(1, t)));
    },
  };
}
