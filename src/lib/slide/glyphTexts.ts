// Which texts fly as LETTER OUTLINES (oct2 W3 §3.2) — one pure answer for the
// export bake (payload.ts) and the compiler's font diagnostic (compile.ts): one
// side of a text ↔ drawn-shape retype (a Consume or Change), or the text side of
// a hand-off between a whole text and a whole non-text object. Text ↔ text is
// the glyph-matched text morph and needs no outlines.
import type { Slide, Track } from "./types";
import type { Element, TextElement } from "../types";
import { transformPreState, transformEndState } from "./tween";
import { hasOutline } from "./outline";
import { isHandoff } from "./targets";

export function glyphTextTracks(slide: Slide): { track: Track; beat: number; text: TextElement }[] {
  const out: { track: Track; beat: number; text: TextElement }[] = [];
  slide.beats.forEach((beat, bi) => {
    for (const track of beat.tracks) {
      if (track.disabled || track.preset !== "transform") continue;
      const pre = transformPreState(slide, track.target, bi);
      if (!pre) continue;
      if (isHandoff(track)) {
        const ref = track.to!.become!.ref;
        if (track.part || track.parts?.length || ref.parts?.length || ref.group) continue;
        const dest = transformPreState(slide, ref.element, bi);
        if (!dest || (pre.type === "text") === (dest.type === "text")) continue;
        out.push({ track, beat: bi, text: (pre.type === "text" ? pre : dest) as TextElement });
        continue;
      }
      const end = transformEndState(pre, track);
      const text: Element | null = pre.type === "text" && hasOutline(end) ? pre : end.type === "text" && hasOutline(pre) ? end : null;
      if (text) out.push({ track, beat: bi, text: text as TextElement });
    }
  });
  return out;
}
