// The ONE wheel → steps law (2026-09-15 surface redesign). Shared by the
// property menu, NumberField and the colour picker so a roll of the wheel means
// the same thing everywhere; pure, so scripts/verify-wheel-law.ts gates it
// hermetically.
//
// Browsers report wheel motion in three dialects and the law has to read all
// of them as "notches":
//   · deltaMode 1/2 (lines/pages) — each unit is a notch (pages count three).
//   · pixel deltas ≥ 40px — a discrete notch. Chromium on Windows reports 100px
//     per notch, Linux ~53px, and a SPUN mouse on macOS 40–300px (acceleration):
//     steps = max(1, round(|dy| / 100)), so a faster spin moves further, and a
//     flick (notches under 45 ms apart) doubles the step.
//   · pixel deltas < 40px — either a SLOW macOS mouse notch (Chromium reports
//     4–30px, one event per notch, ≥ 30 ms apart) or a stream (a trackpad, or
//     a "smooth scrolling" mouse: many small deltas 8–16 ms apart, plus
//     momentum). The first event after ≥ 30 ms of rest is a notch; inside a
//     stream the pixels accumulate and every 40px is a notch — so a two-finger
//     drag scrubs smoothly, a smooth-scroll notch burst stays one or two steps,
//     and a lone notch always moves exactly one step.
// The sign is the caller's: positive = wheel UP = increase. Shift ×10 and Alt ×0.1
// are applied by the caller (they are per-gesture, not per-notch).

export interface WheelSample {
  deltaY: number;
  /** WheelEvent.deltaMode: 0 pixels (default), 1 lines, 2 pages. */
  deltaMode?: number;
  /** Event time in ms (performance.now()). */
  time: number;
}

export const WHEEL_DISCRETE_PX = 40;
export const WHEEL_NOTCH_PX = 100;
export const WHEEL_STREAM_NOTCH_PX = 40;
export const WHEEL_REST_MS = 30;
export const WHEEL_FLICK_MS = 45;

export class WheelStepper {
  private acc = 0;
  private lastAt = -Infinity;
  private lastNotchAt = -Infinity;

  /** Signed steps for one wheel event (positive = wheel up = increase); 0 when
   *  the motion has not yet crossed a notch. */
  steps(s: WheelSample): number {
    const dy = s.deltaY;
    if (!dy || !Number.isFinite(dy)) return 0;
    const dir = dy > 0 ? -1 : 1;
    const mag = Math.abs(dy);
    const gap = s.time - this.lastAt;
    this.lastAt = s.time;
    if (s.deltaMode === 1 || s.deltaMode === 2) {
      this.acc = 0;
      return dir * Math.max(1, Math.round(mag * (s.deltaMode === 2 ? 3 : 1)));
    }
    if (mag >= WHEEL_DISCRETE_PX) {
      const flick = s.time - this.lastNotchAt < WHEEL_FLICK_MS;
      this.lastNotchAt = s.time;
      this.acc = 0;
      return dir * Math.max(1, Math.round(mag / WHEEL_NOTCH_PX)) * (flick ? 2 : 1);
    }
    if (gap >= WHEEL_REST_MS) {
      this.acc = 0;
      return dir;
    }
    this.acc += dy;
    let n = 0;
    while (Math.abs(this.acc) >= WHEEL_STREAM_NOTCH_PX) {
      n += this.acc > 0 ? -1 : 1;
      this.acc -= Math.sign(this.acc) * WHEEL_STREAM_NOTCH_PX;
    }
    return n;
  }

  /** Forget the stream (a new gesture, a re-armed row). */
  reset() {
    this.acc = 0;
    this.lastAt = -Infinity;
    this.lastNotchAt = -Infinity;
  }
}

/** The dominant axis of a wheel event (a horizontal trackpad swipe still steps). */
export function wheelDelta(e: { deltaX: number; deltaY: number }): number {
  return Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
}

/** Per-gesture multiplier: Shift ×10, Alt ×0.1. */
export function wheelMultiplier(e: { shiftKey: boolean; altKey: boolean }): number {
  return e.shiftKey ? 10 : e.altKey ? 0.1 : 1;
}
