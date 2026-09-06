import type { Slide, Track } from "../../../../lib/slide/types";

/** A ghost keeps its ordinary element identity after its birth step. */
export function ghostBirth(slide: Slide | null, targetId: string | undefined): { track: Track; beatIndex: number } | null {
  if (!slide || !targetId) return null;
  for (let beatIndex = 1; beatIndex < slide.beats.length; beatIndex++) {
    const track = slide.beats[beatIndex].tracks.find(t => t.target === targetId && t.ghostFrom);
    if (track) return { track, beatIndex };
  }
  return null;
}

export function ghostSiblings(slide: Slide, birth: NonNullable<ReturnType<typeof ghostBirth>>): Track[] {
  return slide.beats[birth.beatIndex].tracks.filter(t => t.ghostFrom === birth.track.ghostFrom);
}

export function objectLabel(slide: Slide, id: string): string {
  const el = slide.elements.find(e => e.id === id);
  return el?.name || (el?.type === "text" ? el.text.split("\n")[0].slice(0, 48) : el?.type) || "Missing object";
}
