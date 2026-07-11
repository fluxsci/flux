// WS-3.3 (fortify plan): the ONE present-shell logic core, shared by the app's
// PresentOverlay (Svelte host) and the exported deck's runtime.ts (string-
// template host). Framework-free by contract: NO svelte imports, NO node
// imports, NO DOM — this file must bundle into the export IIFE
// (verify-slide-export-core.ts actually bundles and would catch a violation).
//
// Hosts own: DOM/styling, pointer handling, fullscreen/wakeLock/idle-cursor,
// timers. The core owns: the clicker keymap semantics, the HUD + presenter-
// panel view-models, and the shared NEXT_W constant.
//
// Deliberate keymap unifications (fortify plan WS-3.3):
//   - digit-jump buffer survives modifier keys (PresentOverlay's behavior,
//     adopted in both — the runtime used to clear it on Shift/Ctrl/…).
//   - Escape returns a "close" effect; the runtime maps it to "none". The
//     blank-screen clear runs BEFORE the Escape branch so Esc still un-blanks
//     the exported deck (its old fallthrough behavior) and the overlay closes
//     either way.
//   - NEXT_W is 300 in both (was 300 app / 260 export).

import type { PlayerState } from "../player/player";

export interface PresentState {
  blank: "" | "black" | "white";
  showNotes: boolean;
  digits: string;
  reducedMotion: boolean;
}

export type PresentEffect = { kind: "close" | "fullscreen" | "rebuild" | "resetTimer" | "none" };

/** The navigation slice of Player both hosts hand to the reducer. */
export interface PresentNav {
  next(): void;
  prev(): void;
  nextSlide(): void;
  prevSlide(): void;
  goTo(slide: number, beat: number): void;
}

/** One clicker keypress → next state + host effect. `preventDefault` marks the
 *  navigation keys whose browser default (scroll/back) the host must swallow. */
export function reducePresentKey(
  key: string,
  shift: boolean,
  s: PresentState,
  nav: PresentNav,
  totalSlides: number,
): { state: PresentState; effect: PresentEffect; preventDefault: boolean } {
  let { blank, showNotes, digits, reducedMotion } = s;
  let effect: PresentEffect = { kind: "none" };
  let preventDefault = false;

  // Any key other than the blank toggles un-blanks (including Escape — the
  // export relied on that fallthrough; the overlay closes anyway).
  if (blank && !/^[bBwW]$/.test(key)) blank = "";
  if (key === "Escape")
    return { state: { blank, showNotes, digits, reducedMotion }, effect: { kind: "close" }, preventDefault: false };
  if (/^[0-9]$/.test(key))
    return { state: { blank, showNotes, digits: digits + key, reducedMotion }, effect, preventDefault: false };
  if (key === "Enter" && digits) {
    nav.goTo(Math.max(0, Math.min(totalSlides - 1, parseInt(digits, 10) - 1)), 0);
    return { state: { blank, showNotes, digits: "", reducedMotion }, effect, preventDefault: false };
  }
  // The digit buffer survives bare modifier presses (Shift+Arrow etc.).
  if (key !== "Shift" && key !== "Meta" && key !== "Control" && key !== "Alt") digits = "";

  switch (key) {
    case "ArrowRight":
    case " ":
    case "PageDown":
      preventDefault = true;
      if (shift) nav.nextSlide();
      else nav.next();
      break;
    case "ArrowLeft":
    case "Backspace":
    case "PageUp":
      preventDefault = true;
      if (shift) nav.prevSlide();
      else nav.prev();
      break;
    case "ArrowDown":
      preventDefault = true;
      nav.nextSlide();
      break;
    case "ArrowUp":
      preventDefault = true;
      nav.prevSlide();
      break;
    case "Home":
      nav.goTo(0, 0);
      break;
    case "End":
      nav.goTo(totalSlides - 1, 0);
      break;
    case "b":
    case "B":
      blank = blank === "black" ? "" : "black";
      break;
    case "w":
    case "W":
      blank = blank === "white" ? "" : "white";
      break;
    case "f":
    case "F":
      effect = { kind: "fullscreen" };
      break;
    case "s":
    case "S":
      showNotes = !showNotes;
      break;
    case "r":
    case "R":
      effect = { kind: "resetTimer" };
      break;
    case "m":
    case "M":
      reducedMotion = !reducedMotion;
      effect = { kind: "rebuild" };
      break;
  }
  return { state: { blank, showNotes, digits, reducedMotion }, effect, preventDefault };
}

/** HUD view-model: "3 / 12" + one boolean per beat dot. */
export function hudModel(st: PlayerState): { counter: string; dots: boolean[] } {
  const dots: boolean[] = [];
  for (let i = 0; i < st.totalBeats; i++) dots.push(i <= st.beat);
  return { counter: `${st.slide + 1} / ${st.totalSlides}`, dots };
}

/** Presenter-panel thumbnail width — ONE value for both hosts. */
export const NEXT_W = 300;

/** m:ss elapsed-timer text (panel clock + the runtime's per-second tick). */
export function clockText(elapsedSec: number): string {
  return `${Math.floor(elapsedSec / 60)}:${String(elapsedSec % 60).padStart(2, "0")}`;
}

export interface PanelModel {
  clock: string;
  pos: string;
  nextIdx: number; // -1 = end of deck
  nextLabel: string;
  nextScale: number;
  notes: string;
  hint: string;
}

export function panelModel(args: {
  slide: number;
  beat: number;
  totalSlides: number;
  totalBeats: number;
  notes: string | undefined | null;
  elapsedSec: number;
  reducedMotion: boolean;
  stageWidth: number;
}): PanelModel {
  const nextIdx = args.slide + 1 < args.totalSlides ? args.slide + 1 : -1;
  return {
    clock: clockText(args.elapsedSec),
    pos: `slide ${args.slide + 1}/${args.totalSlides} · beat ${args.beat + 1}/${args.totalBeats}`,
    nextIdx,
    nextLabel: nextIdx >= 0 ? "Next" : "End of deck",
    nextScale: NEXT_W / args.stageWidth,
    notes: args.notes || "No notes for this slide.",
    hint: `S notes · M motion ${args.reducedMotion ? "off" : "on"} · B/W blank · R reset · F full`,
  };
}
