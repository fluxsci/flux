/**
 * The live view's transient state: which image is live, which zone of its panel is open, what the wheel drives,
 * and the one-undo-per-gesture edit session every control writes through.
 *
 * Nothing here is saved. The view recipe itself lives on the element in the ordinary project
 * (`ops.setFluximgView`), so undo, autosave, agents and exports see every change the live view makes.
 */
import { get, writable } from "svelte/store";
import { findElement, mutate, project, selection } from "../../store";
import { storeTenant } from "../../tenancy";
import { editSession } from "../../interact/editSession";
import { selectionTargets } from "../../interact/selectionTargets";
import { setFluximgView } from "../../ops";
import type { FluximgElement } from "../../types";
import type { FluximgView } from "../view";
import type { PlayMode } from "./rail";

/** The panel's levels. `home` lists the zones; the others own the panel body until Esc backs out. */
export type LiveZone = "home" | "channel" | "layers" | "frame" | "annotate";

export interface FluximgLiveState {
  elementId: string;
  zone: LiveZone;
  /** The channel whose control is open (zone `channel`). */
  channel: number;
  /**
   * What the wheel drives, as a row key: `pos:<dim>` (step planes), `black` / `white` / `gamma` (the open
   * channel), `run:<dim>` (a projection's length), `zoom` (the frame), `layer:<id>` (a layer's opacity), or null.
   */
  armed: string | null;
  /** Playback along one dimension, or null. */
  playing: { dim: string; fps: number; mode: PlayMode } | null;
}

export const fluximgLive = writable<FluximgLiveState | null>(null);

/**
 * True while a gesture is streaming changes (a scrub, a drag): the element at rest postpones its new still until
 * this clears, so the decode workers serve the live view first.
 */
export const fluximgLiveBusy = writable(false);

/** The object under the pointer or the hovered list row: both sides read and write it. */
export interface LiveHover { layerId: string; key: string; from: "image" | "list" }
export const fluximgHover = writable<LiveHover | null>(null);

/** Where the pointer is over the live image, in level-0 image pixels; null elsewhere. Read on demand (not a store). */
export const livePointer: { at: { x: number; y: number } | null } = { at: null };

/**
 * The pixels on screen, for "Auto": per shown channel, the plane the current frame drew and the rectangle of it
 * that is in view. Set by the overlay while it is mounted; null otherwise. Read on demand (not a store).
 */
export interface LiveSample { channel: number; data: ArrayLike<number>; map: { mul: number; add: number; sub: number; nodata: number | null } | null; width: number; height: number; rect: { x: number; y: number; width: number; height: number } }
export const liveSampler: { read: (() => LiveSample[]) | null } = { read: null };

/**
 * Who armed the row the wheel drives. The view arms its first rail by itself when it opens; that implicit arm
 * takes the wheel only over the image and its rails, so the canvas still pans everywhere else. A row the user
 * armed (its key, a click on it or on its rail) takes the wheel anywhere on screen, as an armed F-menu row does.
 */
export const liveArm = { explicit: false };
/** Arm a row because the user asked for it. */
export function armLive(key: string | null): void {
  liveArm.explicit = key !== null;
  setLive({ armed: key });
}

/** What is under the pointer on the live image, in words: the panel shows it in a fixed strip. */
export interface LiveReadout { where: string; values: Array<{ name: string; ink: string; text: string }>; object: string }
export const fluximgReadout = writable<LiveReadout | null>(null);
/** A problem the live canvas ran into (no WebGL, an unreadable plane): shown where the readout goes. */
export const fluximgLiveProblem = writable("");

/** The screen box of the live image together with its rails (client px): the panel keeps clear of it. */
export const fluximgLiveRect = writable<{ x: number; y: number; w: number; h: number } | null>(null);

let session: ReturnType<typeof editSession> | null = null;
let gesture = "";
let idle: ReturnType<typeof setTimeout> | undefined;

/** End the open gesture: its changes become ONE undo step. */
export function settleLiveEdit(): void {
  clearTimeout(idle); idle = undefined;
  const s = session;
  session = null; gesture = "";
  s?.finish();
  fluximgLiveBusy.set(false);
}

/** Abandon the open gesture: the view returns to what it was when the gesture began. */
export function cancelLiveEdit(): void {
  clearTimeout(idle); idle = undefined;
  const s = session;
  session = null; gesture = "";
  s?.cancel();
  fluximgLiveBusy.set(false);
}

/**
 * Apply one step of a gesture. Steps with the same `key` join one undo entry; a new key settles the previous
 * gesture first. `settleAfter` (ms) settles on its own after that much quiet, for gestures without an end event
 * (the wheel); pass 0 for gestures the caller ends itself (a drag: call `settleLiveEdit` on release).
 */
function run(key: string, settleAfter: number, apply: () => void): void {
  const live = get(fluximgLive);
  if (!live) return;
  if (session && gesture !== key) settleLiveEdit();
  if (!session) {
    session = editSession({ handoff: "finish", terminalOnConflict: true, onSettle: () => { session = null; gesture = ""; fluximgLiveBusy.set(false); } });
    gesture = key;
  }
  fluximgLiveBusy.set(true);
  session.run(apply);
  clearTimeout(idle); idle = undefined;
  if (settleAfter > 0) idle = setTimeout(settleLiveEdit, settleAfter);
}

/** How long the wheel may rest before its run of notches is one finished undo step. */
export const WHEEL_SETTLE_MS = 420;

/** Patch the live element's view as one step of gesture `key`. */
export function liveView(key: string, patch: FluximgView, settleAfter = 0): void {
  const live = get(fluximgLive);
  if (!live) return;
  run(key, settleAfter, () => mutate((p) => setFluximgView(p, live.elementId, patch)));
}

/** Any other change to the project as one step of gesture `key` (split channels, make an inset). */
export function liveMutate(key: string, apply: Parameters<typeof mutate>[0], settleAfter = 0): void {
  run(key, settleAfter, () => mutate(apply));
}

/** The live element, or null when it is gone (deleted, undone away, another project). */
export function liveElement(): FluximgElement | null {
  const live = get(fluximgLive);
  if (!live) return null;
  const found = findElement(get(project), live.elementId);
  return found && found.element.type === "fluximg" ? found.element : null;
}

/** Why the live view cannot open on this element right now, or null when it can. */
export function fluximgLiveUnavailable(id: string): string | null {
  if (storeTenant() !== "figure") return "Images are live in figures only";
  const found = findElement(get(project), id);
  if (!found || found.element.type !== "fluximg") return "Select an image first";
  if (!selectionTargets(found.figure, new Set([id]), { editable: true }).length) return "Unlock and show the image to open it";
  return null;
}

/** Open the live view on an image. Returns false (and opens nothing) when it cannot. */
export function openFluximgLive(id: string): boolean {
  if (fluximgLiveUnavailable(id)) return false;
  closeFluximgLive();
  selection.set(new Set([id]));
  fluximgLive.set({ elementId: id, zone: "home", channel: 0, armed: null, playing: null });
  return true;
}

export function closeFluximgLive(): void {
  if (!get(fluximgLive)) return;
  settleLiveEdit();
  fluximgHover.set(null);
  fluximgLiveRect.set(null);
  livePointer.at = null;
  liveSampler.read = null;
  liveArm.explicit = false;
  fluximgReadout.set(null);
  fluximgLiveProblem.set("");
  fluximgLive.set(null);
}

/** Change panel state (zone, armed row, playback). Changing what is armed settles the open gesture. */
export function setLive(patch: Partial<Omit<FluximgLiveState, "elementId">>): void {
  const live = get(fluximgLive);
  if (!live) return;
  if (("armed" in patch && patch.armed !== live.armed) || ("zone" in patch && patch.zone !== live.zone)) settleLiveEdit();
  fluximgLive.set({ ...live, ...patch });
}

// The live view follows its element: when the selection moves off it, or it disappears, the view closes.
selection.subscribe((sel) => {
  const live = get(fluximgLive);
  if (live && !(sel.size === 1 && sel.has(live.elementId))) closeFluximgLive();
});
project.subscribe(() => {
  const live = get(fluximgLive);
  // Gone, or no longer editable (locked or hidden from the layers list while open): the view must not keep editing it.
  if (live && (!liveElement() || fluximgLiveUnavailable(live.elementId))) closeFluximgLive();
});
