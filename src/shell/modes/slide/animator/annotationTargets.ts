import { get } from "svelte/store";
import { deckOverlay, activeBeat, selTrackIds } from "../../../../lib/slide/store";
import { timelinePxPerMs } from "./animatorState";
import { registerTargetResolver, boundsOf, type TargetHit } from "../../../../lib/bridge/targetResolvers";
import { describeTarget, type TargetRef } from "../../../../lib/project/targets";
import { resolveTrack } from "../../../../lib/slide/resolve";
import { familyOf } from "../../../../lib/slide/family";
import type { Slide } from "../../../../lib/slide/types";

export function animatorAnnotationTargets(root: HTMLElement, getSlide: () => Slide | null) {
  let tracks = new Map<string, TargetRef>();
  function prepare() {
    tracks = new Map();
    const slide = getSlide(), deck = get(deckOverlay);
    if (slide && deck) slide.beats.forEach((b, beat) => b.tracks.forEach(t => {
      if (t.id) tracks.set(t.id, { kind: "track", deckId: deck.id, slideId: slide.id, trackId: t.id, family: familyOf(resolveTrack(t, deck)), elementId: t.target, beat, label: resolveTrack(t, deck).preset });
    }));
  }
  const dispose = registerTargetResolver({ surface: "slide", root: () => root, prepare,
    revision: () => [getSlide(), get(activeBeat), get(selTrackIds), get(timelinePxPerMs),
      root.querySelector(".timeline-scroll")?.scrollLeft, root.querySelector(".timeline-scroll")?.scrollTop],
    current() { prepare(); return get(selTrackIds).flatMap(id => tracks.has(id) ? [tracks.get(id)!] : []); },
    within(rect) {
      return [...root.querySelectorAll('[data-track-id] .trk')].flatMap(node => {
        const b = boundsOf(node), ref = tracks.get(node.closest('[data-track-id]')?.getAttribute('data-track-id') ?? "");
        return ref && b.x >= rect.x && b.y >= rect.y && b.x+b.w <= rect.x+rect.w && b.y+b.h <= rect.y+rect.h ? [{ref,bounds:b,label:describeTarget(ref)}] : [];
      });
    },
    at(_x, _y, node) {
      const slide = getSlide(), deck = get(deckOverlay);
      if (!slide || !deck || !node) return [];
      const row = node.closest('[data-track-id]'), step = node.closest('[data-beat]');
      const target = tracks.get(row?.getAttribute('data-track-id') ?? "");
      const beat = Number(step?.getAttribute('data-beat') ?? get(activeBeat));
      const refs: { ref: TargetRef; node: Element }[] = [];
      if (target && row) refs.push({ ref: target, node: node.closest('.trk') ?? row });
      refs.push({ ref: { kind: "beat", deckId: deck.id, slideId: slide.id, beat, label: slide.beats[beat]?.label }, node: step ?? root });
      refs.push({ ref: { kind: "slide", deckId: deck.id, slideId: slide.id }, node: root });
      return refs.map(({ ref, node }): TargetHit => ({ ref, bounds: boundsOf(node), label: describeTarget(ref) }));
    },
  });
  return { destroy: dispose };
}
