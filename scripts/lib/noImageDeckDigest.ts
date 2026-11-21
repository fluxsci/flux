// What a deck WITHOUT images compiles to and how its media clock runs, as one digest per deck (verify-fluximg-slide-authoring).
// The digests in that gate were recorded by running this file on the base it must not change (fluximg-s2 before W5+W6):
// compile cues, issues and sampled elements at every step; video events, the content end and the audio spans; the video
// clock sampled on a grid. Image work (the pace rule, movies) must leave every byte of this alone.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createDeck } from "../../src/lib/slide/ops";
import { compileSlide } from "../../src/lib/slide/compile";
import { sampleVideo, videoAudioSegments, videoContentEnd, videoEvents } from "../../src/lib/slide/mediaTimeline";
import { inlineSlideFixture } from "../fixtures/inline-slide";
import type { Deck } from "../../src/lib/slide/types";

/** A deck with a video and every media command, a Change and appearances (no image). */
export function videoDeck(): Deck {
  const d = createDeck({ id: "vid", title: "Video" });
  // fixed ids and stamps: the digest is of behaviour, never of fresh ids
  d.slides[0].id = "s"; d.slides[0].beats[0].id = "b0"; d.created = d.modified = "2026-11-21T00:00:00.000Z";
  d.slides[0].elements.forEach((e, i) => { e.id = `starter${i}`; });
  d.assets.push({ id: "clip", name: "clip", kind: "mp4", path: "assets/clip.mp4", naturalWidth: 320, naturalHeight: 180 } as Deck["assets"][number]);
  d.slides[0].elements.push(
    { id: "v", type: "video", x: 10, y: 10, width: 320, height: 180, rotation: 0, assetId: "clip", posterAssetId: "poster", durationMs: 2400, loop: false } as unknown as Deck["slides"][number]["elements"][number],
    { id: "w", type: "video", x: 340, y: 10, width: 160, height: 90, rotation: 0, assetId: "clip", posterAssetId: "poster", durationMs: 900, loop: true, muted: false } as unknown as Deck["slides"][number]["elements"][number],
    { id: "box", type: "rect", x: 40, y: 220, width: 80, height: 60, rotation: 0, fill: "#4385be", stroke: "none", strokeWidth: 0, cornerRadius: 0 } as unknown as Deck["slides"][number]["elements"][number],
  );
  d.slides[0].beats.push(
    { id: "b1", tracks: [{ id: "s1", target: "v", preset: "videoStart", duration: 0, start: 0 }, { id: "f1", target: "box", preset: "fade", duration: 400 }] },
    { id: "b2", advance: "with-prev", tracks: [{ id: "p2", target: "v", preset: "videoPause", duration: 0, start: 300 }, { id: "s2", target: "w", preset: "videoStart", duration: 0, start: 100 }, { id: "c2", target: "box", preset: "transform", duration: 1200, to: { state: { x: 300 } } }] },
    { id: "b3", tracks: [{ id: "s3", target: "v", preset: "videoStart", duration: 0 }, { id: "x3", target: "w", preset: "videoStop", duration: 0, start: 50 }] },
  );
  return d;
}

export function decksWithoutImages(): Deck[] {
  const ghost = JSON.parse(readFileSync(new URL("../fixtures/m4-ghost-disappear-pre-m3.json", import.meta.url), "utf8")) as Deck;
  return [inlineSlideFixture(), ghost, videoDeck()];
}

/** One deck's digest: everything the compiler and the media clock produce for it. */
export function deckDigest(deck: Deck): string {
  const out: unknown[] = [];
  for (const slide of deck.slides) {
    const compiled = compileSlide(slide, deck.stage, { animStyles: deck.animStyles });
    out.push(compiled.cues.map((c) => ({ id: c.id, duration: c.duration, tracks: c.tracks.map((t) => [t.track.id, t.beat, t.start, t.duration, t.end, t.parts, t.ranks, t.ease.key]) })));
    out.push(compiled.issues);
    for (let bi = 0; bi < slide.beats.length; bi++) for (const t of [0, 150, 600, Infinity]) out.push(compiled.sample(bi, t).elements, compiled.sample(bi, t).presentation);
    const events = videoEvents(slide, (bi) => bi * 1000);
    out.push(events, videoContentEnd(slide, events, slide.beats.length * 1000), videoAudioSegments(slide, events, 6000));
    for (const el of slide.elements) if (el.type === "video") for (let at = 0; at <= 6000; at += 125) out.push(sampleVideo(events, el.id, at, el.durationMs, !!el.loop));
  }
  return createHash("sha256").update(JSON.stringify(out)).digest("hex");
}

if (process.argv[1]?.endsWith("noImageDeckDigest.ts")) console.log(JSON.stringify(decksWithoutImages().map((d) => [d.id, deckDigest(d)])));
