import { createPlayer } from "../player/player";
import { embedPlayerOptions } from "../embedRender";
import { planSlideVideo, videoFrame, videoOptions, videoSize, type SlideVideoOptions } from "../video";
import type { ExportPayload } from "./runtime";
import { videoAudioSegments, videoEventsForPlan } from "../mediaTimeline";

/** Isolated capture host: no editor stores, presenter chrome, timers or rAF. */
export async function boot(payload: ExportPayload, input: Partial<SlideVideoOptions>) {
  const options = videoOptions(input), { deck } = payload;
  if (deck.slides.length !== 1) throw new Error("Video export requires exactly one slide");
  const size = videoSize(deck.stage, options.height);
  const host = document.createElement("div");
  const scale = size.height / deck.stage.height;
  host.style.cssText = `position:absolute;left:${(size.width - deck.stage.width * scale) / 2}px;top:0;transform-origin:0 0;transform:scale(${scale})`;
  document.body.append(host);
  // Wait for actual fonts before the player's text-layout pass, including fonts
  // referenced only by later transform destinations.
  const fonts = new Set<string>();
  for (const el of deck.slides[0].elements) if (el.type === "text") fonts.add(`${el.fontStyle || "normal"} ${el.fontWeight || 400} 16px "${el.fontFamily.replace(/["\\]/g, "")}"`);
  for (const beat of deck.slides[0].beats) for (const t of beat.tracks) if (typeof t.to?.state?.fontFamily === "string") fonts.add(`16px "${t.to.state.fontFamily.replace(/["\\]/g, "")}"`);
  await Promise.all([...fonts].map(font => document.fonts.load(font)));
  await document.fonts.ready;
  const urls = new Set(Object.values(payload.assets ?? {}));
  for (const url of urls) {
    const img = new Image(); img.src = url;
    await img.decode();
  }
  const playerOptions = embedPlayerOptions(payload);
  document.body.style.background = deck.slides[0].background ?? deck.background ?? playerOptions.theme.background;
  const player = createPlayer(host, deck, playerOptions);
  await player.readyMedia();
  const plan = planSlideVideo(deck.slides[0], player.beatDurations(), options);
  const mediaEvents = videoEventsForPlan(deck.slides[0], plan);
  return {
    info: { ...size, frames: plan.frameCount, durationMs: plan.frameCount * 1000 / plan.fps, fps: plan.fps, issues: player.state().issues, audio: videoAudioSegments(deck.slides[0], mediaEvents, plan.frameCount * 1000 / plan.fps) },
    async frame(index: number) { const at = videoFrame(plan, index); player.seek(0, at.beat, at.time, at.fromBeat, false); await player.captureMedia(mediaEvents, index * 1000 / plan.fps); },
    destroy: () => player.destroy(),
  };
}
