import type { Slide } from "../types";
import { cueEnd } from "../video";
import { sampleVideo, videoEvents, type VideoEvent } from "../mediaTimeline";

const WAIT_MS = 15000;
const mediaError = (video: HTMLVideoElement) => new Error(`Cannot decode video clip${video.error?.message ? `: ${video.error.message}` : ". Reimport the original MP4 or MOV file."}`);
function decoderTime(timeMs: number, duration: number): number {
  // Chromium's media timeline quantizes to microseconds. Rounding a rational
  // 30/60fps timestamp down selected the preceding frame every third seek.
  // Round toward the requested frame (under 1µs), retaining the final frame.
  return Math.min(Math.ceil(Math.max(0, timeMs) * 1000) / 1e6, Math.max(0, duration - .000001));
}

/** Await the decoder rather than a guessed delay. Capture calls this after
 * every seek, so encoded frames never depend on the renderer's wall clock. */
export async function readyVideo(video: HTMLVideoElement): Promise<void> {
  if (video.error) throw mediaError(video);
  if (video.readyState >= 2 && !video.seeking) return;
  await new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timeout);
      for (const name of ["loadeddata", "canplay", "seeked"]) video.removeEventListener(name, ready);
      video.removeEventListener("error", failed);
      error ? reject(error) : resolve();
    };
    const ready = () => { if (video.readyState >= 2 && !video.seeking) finish(); };
    const failed = () => finish(mediaError(video));
    const timeout = setTimeout(() => finish(new Error("Timed out decoding a video clip")), WAIT_MS);
    for (const name of ["loadeddata", "canplay", "seeked"]) video.addEventListener(name, ready);
    video.addEventListener("error", failed);
    ready();
  });
}

export async function seekVideoFrame(video: HTMLVideoElement, timeMs: number): Promise<void> {
  video.pause();
  await readyVideo(video);
  // The last decodable frame precedes duration; seeking to exactly duration can
  // yield the poster on some Chromium decoders. The epsilon stays below 1 frame.
  const to = decoderTime(timeMs, video.duration);
  if (Math.abs(video.currentTime - to) < .000001 && !video.seeking) return;
  video.currentTime = to;
  await readyVideo(video);
}

interface Binding {
  id: string;
  video: HTMLVideoElement;
  durationMs: number;
  loop: boolean;
  running: boolean;
  started: boolean;
  epoch: number;
  desiredTime: number;
  retry?: HTMLButtonElement;
}

export function createVideoController(root: HTMLElement, slide: Slide, durations: readonly number[], manual: boolean, onChange: () => void, onIssue: (target: string, reason: string) => void) {
  let destroyed = false;
  const pauseReasons = new Set<string>();
  const bindings: Binding[] = [];
  const byId = new Map<string, Binding>();
  const videoNodes = new Map(Array.from(root.querySelectorAll<HTMLVideoElement>("video[data-slide-video]")).map(video => [video.dataset.slideVideo, video]));
  const cleanup: Array<() => void> = [];
  let activeEvents: VideoEvent[] = [], nextEvent = 0;
  for (const element of slide.elements) {
    if (element.type !== "video") continue;
    const video = videoNodes.get(element.id);
    if (!video) continue;
    const binding: Binding = { id: element.id, video, durationMs: element.durationMs, loop: !!element.loop, running: false, started: false, epoch: 0, desiredTime: 0 };
    bindings.push(binding);
    byId.set(binding.id, binding);
    const ended = () => { if (!binding.loop) binding.running = false; onChange(); };
    const failed = () => { binding.running = false; onIssue(binding.id, mediaError(video).message); };
    const loaded = () => { if (destroyed) return; setTime(binding, binding.desiredTime); };
    video.addEventListener("ended", ended); video.addEventListener("error", failed); video.addEventListener("loadedmetadata", loaded);
    cleanup.push(() => { video.removeEventListener("ended", ended); video.removeEventListener("error", failed); video.removeEventListener("loadedmetadata", loaded); });
  }
  function setTime(binding: Binding, ms: number) {
    binding.desiredTime = ms;
    if (binding.video.readyState < 1) return;
    const to = decoderTime(ms, binding.video.duration);
    if (Math.abs(binding.video.currentTime - to) > .000001) binding.video.currentTime = to;
  }
  function tryPlay(binding: Binding) {
    if (destroyed || !binding.running || pauseReasons.size) return;
    const stamp = ++binding.epoch;
    void binding.video.play().then(() => {
      if (destroyed || stamp !== binding.epoch || !binding.running || pauseReasons.size) return;
      binding.retry?.remove(); binding.retry = undefined; onChange();
    }).catch(error => {
      if (destroyed || stamp !== binding.epoch || !binding.running || pauseReasons.size) return;
      if (error instanceof DOMException && error.name === "AbortError") return;
      if (binding.video.error) { onIssue(binding.id, mediaError(binding.video).message); return; }
      // Browsers may require a fresh user gesture for sound. Make that state
      // actionable; never silently mute the user's clip to circumvent policy.
      if (!binding.retry) {
        const retry = document.createElement("button"); retry.type = "button"; retry.textContent = "Play video";
        retry.style.cssText = "position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);padding:8px 14px;border:1px solid #fff9;border-radius:5px;background:#111d;color:#fff;font:14px system-ui;cursor:pointer;z-index:2";
        retry.addEventListener("click", event => { event.preventDefault(); event.stopPropagation(); tryPlay(binding); });
        binding.video.parentElement?.append(retry); binding.retry = retry;
      }
      onChange();
    });
  }
  function pauseBinding(binding: Binding) { binding.epoch++; binding.video.pause(); binding.retry?.remove(); binding.retry = undefined; }
  function applyCommand(event: VideoEvent) {
    const binding = byId.get(event.target);
    if (!binding) return;
    if (event.command === "videoStart") {
      pauseBinding(binding); setTime(binding, 0); binding.running = true; binding.started = true; tryPlay(binding);
    } else {
      binding.running = false; pauseBinding(binding);
      if (event.command === "videoStop") { setTime(binding, 0); binding.started = false; }
    }
    onChange();
  }
  function begin(from: number, to: number) {
    if (!bindings.length) return;
    pauseReasons.delete("seek"); pauseReasons.delete("player");
    activeEvents = videoEvents(slide, beat => beat >= from && beat <= to ? 0 : undefined); nextEvent = 0;
    for (const binding of bindings) if (binding.running && binding.video.paused) tryPlay(binding);
  }
  function tick(time: number) { while (nextEvent < activeEvents.length && activeEvents[nextEvent].at <= time) applyCommand(activeEvents[nextEvent++]); }
  function pause(paused: boolean, reason = "player") {
    if (paused) pauseReasons.add(reason); else { pauseReasons.delete(reason); if (reason === "player") pauseReasons.delete("seek"); }
    for (const binding of bindings) if (pauseReasons.size) pauseBinding(binding); else tryPlay(binding);
    onChange();
  }
  function seek(beat: number, time: number, fromBeat = beat) {
    if (!bindings.length) return;
    // Static/scrub positions have zero manual waits. Earlier with-previous
    // commands share one origin, just like a live presenter cue.
    const starts = new Map<number, number>(); let origin = 0;
    for (let from = 0; from < fromBeat;) {
      const end = Math.min(fromBeat - 1, manual || from === 0 ? from : cueEnd(slide, from));
      for (let i = from; i <= end; i++) starts.set(i, origin);
      origin += Math.max(0, ...durations.slice(from, end + 1)); from = end + 1;
    }
    for (let i = fromBeat; i <= beat; i++) starts.set(i, origin);
    const local = Number.isFinite(time) ? Math.max(0, time) : Math.max(0, ...durations.slice(fromBeat, beat + 1));
    const events = videoEvents(slide, b => starts.get(b));
    seekEvents(events, origin + local);
  }
  function seekEvents(events: readonly VideoEvent[], at: number) {
    pauseReasons.add("seek"); activeEvents = []; nextEvent = 0;
    for (const binding of bindings) {
      pauseBinding(binding);
      const sample = sampleVideo(events, binding.id, at, binding.durationMs, binding.loop);
      binding.running = sample.running; binding.started = sample.started; setTime(binding, sample.timeMs);
    }
  }
  async function capture(events: readonly VideoEvent[], at: number) {
    seekEvents(events, at);
    await Promise.all(bindings.map(binding => seekVideoFrame(binding.video, binding.desiredTime)));
  }
  function state() {
    const running = bindings.some(b => b.running);
    return { mediaPlaying: running && !pauseReasons.size && bindings.some(b => b.running && !b.video.paused), mediaPaused: running && pauseReasons.size > 0 };
  }
  function stop() {
    activeEvents = []; nextEvent = 0;
    for (const binding of bindings) { binding.running = false; binding.started = false; pauseBinding(binding); setTime(binding, 0); }
  }
  function destroy() {
    destroyed = true;
    for (const fn of cleanup) fn();
    for (const binding of bindings) { pauseBinding(binding); binding.video.removeAttribute("src"); binding.video.load(); }
    bindings.length = 0;
    byId.clear();
  }
  return { begin, tick, pause, seek, capture, state, stop, ready: () => Promise.all(bindings.map(b => readyVideo(b.video))), destroy };
}
