/**
 * Image movies on a slide (stage 2, plan D7): Start / Pause / Stop on an image with a dimension to play. The video
 * controller's twin (`player/media.ts`): the same API, the same events (`mediaTimeline.videoEvents`), the same pure
 * clock (`sampleImagePlayback` / `playbackPlane`). Like a video's decoder, a running movie wakes on its own clock
 * while the slide rests (media are allowed to); it re-draws only the image it drives (the binding's `flush`), pauses
 * with the player, the host and a hidden document, and stops costing anything when nothing runs: no frame loop, no
 * listener. Seeks and capture are exact: the plane comes from the pure clock at that time.
 *
 * Created by the player only for a slide whose images take movie commands and only with a live host; joined to the
 * video controller (`joinMedia`) so the player keeps ONE media object. A slide without images never builds one.
 */
import type { FluximgElement } from "../../types";
import { resolvePlayback, type ResolvedPlayback } from "../../fluximg/playback";
import type { Slide, Track } from "../types";
import { cueEnd } from "../video";
import { mediaFold, playbackPlane, sampleImagePlayback, videoEvents, type VideoEvent } from "../mediaTimeline";
import { familyOf } from "../family";
import type { SlideRenderCtx } from "./render";
import { fluximgBindingOf } from "./fluximg";

/** What the player calls on its media (the video controller's shape). */
export interface MediaController {
  begin(from: number, to: number): void;
  tick(time: number): void;
  pause(paused: boolean, reason?: string): void;
  seek(beat: number, time: number, fromBeat?: number): void;
  capture(events: readonly VideoEvent[], at: number): Promise<void>;
  state(): { mediaPlaying: boolean; mediaPaused: boolean };
  stop(): void;
  ready(): Promise<unknown>;
  destroy(): void;
}

/** How often (ms) a running movie asks for the planes ahead of it, and how many. */
const AHEAD_EVERY_MS = 120, AHEAD_PLANES = 8;
/** A plane boundary this close (ms, two frames) is waited for on animation frames (a short period runs on them); a later
 *  one with ONE timer at the boundary, which draws there (what it draws is presented on the next frame, as a draw in that
 *  frame's animation callback would be). */
const RAF_WITHIN_MS = 34;

interface Movie { id: string; playback: ResolvedPlayback; running: boolean; started: boolean; position: number; origin: number; shown: number | null; shownRunning?: boolean }

/** Images of the slide that take a movie command, or none (then the player builds nothing). */
export function slideMovieTargets(slide: Slide, resolvedTracks?: readonly (readonly Track[])[]): string[] {
  const ids = new Set<string>();
  const images = new Set(slide.elements.filter((e) => e.type === "fluximg").map((e) => e.id));
  if (!images.size) return [];
  (resolvedTracks ?? slide.beats.map((b) => b.tracks)).forEach((tracks, bi) => { if (bi > 0) for (const t of tracks) if (!t.disabled && images.has(t.target) && familyOf(t) === "media") ids.add(t.target); });
  return [...ids];
}

export function createFluximgMovieController(root: HTMLElement, slide: Slide, ctx: SlideRenderCtx, durations: readonly number[], manual: boolean, onChange: () => void, resolvedTracks?: readonly (readonly Track[])[]): MediaController {
  const host = ctx.fluximg!;
  const pauseReasons = new Set<string>();
  const targets = slideMovieTargets(slide, resolvedTracks);
  const elements = new Map(slide.elements.filter((e): e is FluximgElement => e.type === "fluximg" && targets.includes(e.id)).map((e) => [e.id, e]));
  const movies = new Map<string, Movie>();
  let destroyed = false, loop = 0, timer: ReturnType<typeof setTimeout> | undefined, activeEvents: VideoEvent[] = [], nextEvent = 0;

  const movie = (id: string): Movie | null => {
    const hit = movies.get(id);
    if (hit) return hit;
    const el = elements.get(id), manifest = el && host.manifest(el.assetId);
    const playback = manifest ? resolvePlayback(manifest, el!.playback) : null;
    if (!playback) return null; // the manifest is not here yet: `ready` waits for it
    const m: Movie = { id, playback, running: false, started: false, position: 0, origin: 0, shown: null };
    movies.set(id, m);
    return m;
  };
  const bindingOf = (id: string) => {
    const node = root.querySelector<HTMLElement>(`[data-slide-fluximg-root="${CSS.escape(id)}"]`);
    return node ? fluximgBindingOf(node) : undefined;
  };
  /** Put the plane the movie stands on (or the state's own plane once stopped) on its image, and draw that image alone
   *  (the binding's media hook: an index override composed with whatever frame it shows, flushed outside paint()). */
  function show(m: Movie, plane: number | null, force = false): void {
    // A host that plays baked clips follows the movie's clock, so a change of its running state, and a jump of its
    // position (`force`: a command, a seek), are news too (W7).
    const running = m.running && !pauseReasons.size;
    if (!force && m.shown === plane && m.shownRunning === running) return;
    m.shown = plane; m.shownRunning = running;
    const b = bindingOf(m.id);
    if (!b) return;
    const now = performance.now(), p = m.playback;
    b.setIndexOverride(plane === null ? null : { dim: p.dim, index: p.from + plane, clock: { dim: p.dim, mode: p.mode, from: p.from, to: p.to, periodMs: p.periodMs, positionMs: positionNow(m, now), running, at: now } });
    b.flush();
  }
  /** Decode ahead the way the movie is going, at a low rate (never per frame). */
  let aheadAt = -Infinity;
  function ahead(m: Movie, now: number): void {
    if (now - aheadAt < AHEAD_EVERY_MS) return;
    aheadAt = now;
    const pos = positionNow(m, now), p = m.playback;
    const here = playbackPlane(pos, p.passMs, p.mode, p.planes).plane, next = playbackPlane(pos + p.periodMs, p.passMs, p.mode, p.planes).plane;
    bindingOf(m.id)?.decodeAhead(p.dim, next < here ? -1 : 1, 1, AHEAD_PLANES);
  }
  const positionNow = (m: Movie, now: number): number => m.position + (m.running && !pauseReasons.size ? now - m.origin : 0);
  function frame(now: number): void {
    loop = 0;
    if (destroyed) return;
    for (const m of movies.values()) {
      if (!m.running) continue;
      const p = playbackPlane(positionNow(m, now), m.playback.passMs, m.playback.mode, m.playback.planes);
      if (p.done) { m.position = m.playback.passMs; m.running = false; onChange(); }
      show(m, p.plane);
      if (m.running) ahead(m, now);
    }
    schedule();
  }
  /**
   * The next wake-up, and only one (review C7: no callback while nothing needs drawing). A movie whose binding draws
   * its planes, or whose overlay names them, wakes at its next plane boundary; one a clip plays natively (or one that
   * cannot be shown) wakes only where a "once" pass ends. A boundary more than two frames away is waited for with a
   * timer that draws at the boundary, so a plane reaches the screen on the same frame as a continuous loop would draw it
   * (a short period simply runs on animation frames). Nothing runs while media is paused.
   */
  function schedule(): void {
    if (loop) { cancelAnimationFrame(loop); loop = 0; }
    if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
    if (destroyed || pauseReasons.size) return;
    const now = performance.now();
    let wait = Infinity;
    for (const m of movies.values()) {
      if (!m.running) continue;
      const p = m.playback, pos = positionNow(m, now);
      if (p.mode === "once") wait = Math.min(wait, p.passMs - pos);
      if (bindingOf(m.id)?.movieNeeds(p.dim) === "none") continue;
      const k = Math.floor(Math.max(0, pos) / p.periodMs + 1e-9);
      wait = Math.min(wait, (k + 1) * p.periodMs - pos);
    }
    if (!Number.isFinite(wait)) return;
    if (wait <= RAF_WITHIN_MS) loop = requestAnimationFrame(frame);
    else timer = setTimeout(() => { timer = undefined; if (!destroyed && !pauseReasons.size) frame(performance.now()); }, wait + 1);
  }
  const planeAt = (m: Movie, now: number): number => playbackPlane(positionNow(m, now), m.playback.passMs, m.playback.mode, m.playback.planes).plane;
  function freeze(now = performance.now()): void { for (const m of movies.values()) if (m.running) { m.position = positionNow(m, now); m.origin = now; } }

  function apply(event: VideoEvent, lateMs: number): void {
    const m = movie(event.target);
    if (!m) return;
    const now = performance.now();
    if (event.command === "videoStart") { m.running = true; m.started = true; m.position = Math.max(0, lateMs); m.origin = now; show(m, 0, true); }
    else if (event.command === "videoPause") { m.position = positionNow(m, now); m.running = false; if (m.shown !== null) show(m, planeAt(m, now), true); }
    else { m.running = false; m.started = false; m.position = 0; show(m, null, true); }
    onChange();
  }
  /** Sample every movie at an absolute clock position (seek and capture: exact, from the pure clock). */
  function sampleAt(events: readonly VideoEvent[], at: number): void {
    for (const id of elements.keys()) {
      const m = movie(id);
      if (!m) continue;
      const s = sampleImagePlayback(events, id, at, m.playback.passMs, m.playback.mode, m.playback.planes);
      m.running = s.running; m.started = s.started; m.origin = performance.now();
      // the position the pure clock stands on (a running movie continues from there when the player resumes)
      m.position = s.started ? mediaFold(events, id, at).timeMs : 0;
      show(m, s.started ? s.plane : null, true);
    }
  }
  return {
    begin(from, to) {
      // A movie running into this step runs on (review A1), as a video clip does (`media.ts` begin leaves running clips
      // alone): its elapsed time is folded into its position BEFORE the origin moves. One the player or a seek held
      // (pause reasons) gained no time meanwhile, so the fold leaves it where it stood.
      const now = performance.now();
      for (const m of movies.values()) { m.position = positionNow(m, now); m.origin = now; }
      pauseReasons.delete("seek"); pauseReasons.delete("player");
      activeEvents = videoEvents(slide, (beat) => (beat >= from && beat <= to ? 0 : undefined), { resolvedTracks }).filter((e) => elements.has(e.target)); nextEvent = 0;
      schedule();
    },
    tick(time) {
      let changed = false;
      while (nextEvent < activeEvents.length && activeEvents[nextEvent].at <= time) { const e = activeEvents[nextEvent++]; apply(e, time - e.at); changed = true; }
      if (changed) schedule();
    },
    pause(paused, reason = "player") {
      if (paused) { freeze(); pauseReasons.add(reason); }
      else { pauseReasons.delete(reason); if (reason === "player") pauseReasons.delete("seek"); const now = performance.now(); if (!pauseReasons.size) for (const m of movies.values()) m.origin = now; }
      // The images learn the new running state (a no-op unless it changed: a host playing baked clips pauses its video).
      // (where nothing woke at each plane, `shown` is the plane of the last state change: the clock's plane is read now)
      const at = performance.now();
      for (const m of movies.values()) if (m.started && m.shown !== null) show(m, planeAt(m, at));
      schedule(); onChange();
    },
    seek(beat, time, fromBeat = beat) {
      // The video controller's own origin rule: earlier with-previous commands share one origin, as a live cue does.
      const starts = new Map<number, number>(); let origin = 0;
      for (let from = 0; from < fromBeat;) {
        const end = Math.min(fromBeat - 1, manual || from === 0 ? from : cueEnd(slide, from));
        for (let i = from; i <= end; i++) starts.set(i, origin);
        origin += Math.max(0, ...durations.slice(from, end + 1)); from = end + 1;
      }
      for (let i = fromBeat; i <= beat; i++) starts.set(i, origin);
      const local = Number.isFinite(time) ? Math.max(0, time) : Math.max(0, ...durations.slice(fromBeat, beat + 1));
      pauseReasons.add("seek"); activeEvents = []; nextEvent = 0;
      sampleAt(videoEvents(slide, (b) => starts.get(b), { resolvedTracks }), origin + local);
      schedule();
    },
    async capture(events, at) {
      pauseReasons.add("seek"); activeEvents = []; nextEvent = 0;
      await this.ready();
      sampleAt(events, at);
      schedule();
    },
    state() {
      const running = [...movies.values()].some((m) => m.running);
      return { mediaPlaying: running && !pauseReasons.size, mediaPaused: running && pauseReasons.size > 0 };
    },
    stop() {
      activeEvents = []; nextEvent = 0;
      for (const m of movies.values()) { m.running = false; m.started = false; m.position = 0; show(m, null); }
      schedule();
    },
    ready: () => Promise.all([...elements.values()].map((el) => (host.manifest(el.assetId) ? undefined : host.need(el.assetId).catch(() => undefined)))).then(() => { for (const id of elements.keys()) movie(id); }),
    destroy() {
      destroyed = true;
      if (loop) cancelAnimationFrame(loop);
      if (timer !== undefined) clearTimeout(timer);
      loop = 0; timer = undefined;
      for (const m of movies.values()) bindingOf(m.id)?.setIndexOverride(null);
      movies.clear();
    },
  };
}

/** One media object for the player: the videos' controller and the image movies', side by side. */
export function joinMedia(a: MediaController, b: MediaController): MediaController {
  return {
    begin: (f, t) => { a.begin(f, t); b.begin(f, t); },
    tick: (t) => { a.tick(t); b.tick(t); },
    pause: (p, r) => { a.pause(p, r); b.pause(p, r); },
    seek: (beat, t, from) => { a.seek(beat, t, from); b.seek(beat, t, from); },
    capture: async (events, at) => { await Promise.all([a.capture(events, at), b.capture(events, at)]); },
    state: () => { const x = a.state(), y = b.state(); return { mediaPlaying: x.mediaPlaying || y.mediaPlaying, mediaPaused: x.mediaPaused || y.mediaPaused }; },
    stop: () => { a.stop(); b.stop(); },
    ready: () => Promise.all([a.ready(), b.ready()]),
    destroy: () => { a.destroy(); b.destroy(); },
  };
}
