#!/usr/bin/env -S npx tsx
import assert from "node:assert/strict";
import { compileSlide, trackDuration } from "../src/lib/slide/compile";
import { planSlideVideo } from "../src/lib/slide/video";
import { videoAudioSegments, videoEventsForPlan, sampleVideo } from "../src/lib/slide/mediaTimeline";
import type { Slide } from "../src/lib/slide/types";

let checks = 0;
function check(value: unknown, label: string) { assert.ok(value, label); checks++; console.log(`  ok: ${label}`); }
const slide: Slide = { id: "video", elements: [{ id: "clip", type: "video", assetId: "movie", posterAssetId: "poster", durationMs: 1200, x: 20, y: 30, width: 160, height: 90, rotation: 0 }], beats: [
  { id: "base", tracks: [] },
  { id: "appear", tracks: [{ id: "appear-track", target: "clip", preset: "fade", duration: 200 }] },
  { id: "start", tracks: [{ id: "start-track", target: "clip", preset: "videoStart" }] },
  { id: "pause", tracks: [{ id: "pause-track", target: "clip", preset: "videoPause", start: 100 }] },
  { id: "restart", tracks: [{ id: "restart-track", target: "clip", preset: "videoStart" }] },
] };
const compiled = compileSlide(slide);
check(compiled.issues.length === 0, "media commands compile independently from appearance");
check(compiled.sample(0).presentation.elementStates.clip.visible === false && compiled.sample(1).presentation.elementStates.clip.visible, "appearance controls visibility, Start does not hide the poster");
check(trackDuration(slide.beats[2].tracks[0]) === 0 && compiled.cues[3].duration === 100, "media command duration is zero while its delay extends the step");
const plan = planSlideVideo(slide, compiled.cues.map(c => c.duration), { startHoldMs: 100, stepDelayMs: 200, endHoldMs: 300 });
const events = videoEventsForPlan(slide, plan);
assert.deepEqual(events.map(e => [e.command, e.at]), [["videoStart", 500], ["videoPause", 800], ["videoStart", 1000]]); checks++;
check(plan.durationMs === 2500, "last playing clip completes before the final hold");
assert.deepEqual(sampleVideo(events, "clip", 400, 1200), { timeMs: 0, running: false, started: false }); checks++;
assert.deepEqual(sampleVideo(events, "clip", 750, 1200), { timeMs: 250, running: true, started: true }); checks++;
assert.deepEqual(sampleVideo(events, "clip", 900, 1200), { timeMs: 300, running: false, started: true }); checks++;
assert.deepEqual(sampleVideo(events, "clip", 1050, 1200), { timeMs: 50, running: true, started: true }); checks++;
assert.deepEqual(sampleVideo(events, "clip", 2500, 1200), { timeMs: 1200, running: false, started: true }); checks++;
assert.deepEqual([2500, 1050, 750, 400].map(at => sampleVideo(events, "clip", at, 1200).timeMs), [1200, 50, 250, 0]); checks++;
const audio = videoAudioSegments(slide, events, plan.durationMs);
assert.deepEqual(audio, [{ assetId: "movie", startMs: 500, endMs: 800, offsetMs: 0, loop: false }, { assetId: "movie", startMs: 1000, endMs: 2200, offsetMs: 0, loop: false }]); checks++;
const loop = structuredClone(slide); (loop.elements[0] as Extract<Slide["elements"][number], { type: "video" }>).loop = true;
const loopPlan = planSlideVideo(loop, compiled.cues.map(c => c.duration), { startHoldMs: 100, stepDelayMs: 200, endHoldMs: 300 });
check(loopPlan.durationMs === 1300, "looping clips are bounded by authored export timing");
check(sampleVideo(events, "clip", 2450, 1200, true).timeMs === 250, "loop sampling wraps deterministically");
check(videoAudioSegments(loop, events, loopPlan.durationMs).at(-1)?.endMs === 1300, "loop audio stops at the exact export end");
const muted = structuredClone(slide); (muted.elements[0] as Extract<Slide["elements"][number], { type: "video" }>).muted = true;
check(videoAudioSegments(muted, events, plan.durationMs).length === 0, "muted clips never contribute audio");
const stopped = structuredClone(slide); stopped.beats.push({ id: "stop", tracks: [{ target: "clip", preset: "videoStop" }] });
const stopPlan = planSlideVideo(stopped, compileSlide(stopped).cues.map(c => c.duration), { startHoldMs: 100, stepDelayMs: 200, endHoldMs: 300 });
const stopEvents = videoEventsForPlan(stopped, stopPlan);
assert.deepEqual(sampleVideo(stopEvents, "clip", 1600, 1200), { timeMs: 0, running: false, started: false }); checks++;
check(stopPlan.durationMs === 1500, "Stop cancels the final-clip duration extension");
const grouped = structuredClone(slide); grouped.beats[3].advance = "with-prev";
const groupedPlan = planSlideVideo(grouped, compiled.cues.map(c => c.duration), { startHoldMs: 100, stepDelayMs: 200, endHoldMs: 300 });
check(videoEventsForPlan(grouped, groupedPlan)[1].at - videoEventsForPlan(grouped, groupedPlan)[0].at === 100, "with-previous media commands share their cue origin");
const hidden = structuredClone(slide); hidden.elements[0].groupId = "g"; hidden.groups = { g: { id: "g", hidden: true } };
check(videoEventsForPlan(hidden, plan).length === 0, "hidden groups never start invisible decoders or audio");
const initial = structuredClone(slide); initial.beats = [{ id: "base", tracks: [{ target: "clip", preset: "videoStart" }] }];
const initialPlan = planSlideVideo(initial, [0], { startHoldMs: 100, endHoldMs: 200 });
check(initialPlan.cues.length === 0 && initialPlan.durationMs === 300 && videoEventsForPlan(initial, initialPlan).length === 0, "Design stays static even when unsupported source data puts Start on step zero");
console.log(`\nSLIDE MEDIA: PASS (${checks} assertions)`);
