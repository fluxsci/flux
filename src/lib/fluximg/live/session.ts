/**
 * The live view's transient state: which image is live, what it has in hand (what the wheel and a drag on the
 * image drive), and the one-undo-per-gesture edit session every control writes through.
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

export interface FluximgLiveState {
  elementId: string;
  /** The channel in hand: `black` / `white` / `gamma` / `window` are ITS points, and its strip is the lit one. */
  channel: number;
  /**
   * What is in hand, as a key: `pos:<dim>` (step planes), `run:<dim>` (a projection's length), `black` / `white` /
   * `gamma` / `window` (the channel in hand), `zoom` (the frame: wheel zooms, drag moves), `inset` (the next drag
   * on the image draws one), `layer:<id>` (a layer's opacity), or null. The wheel drives it; so does a drag on the image.
   */
  armed: string | null;
  /** Playback along one dimension, or null. */
  playing: { dim: string; fps: number; mode: PlayMode } | null;
  /** Playback speed as a multiple of the dimension's own rate (1 = real time). Kept while the view is open. */
  speed: number;
}

export const fluximgLive = writable<FluximgLiveState | null>(null);

/**
 * True while a gesture is streaming changes (a scrub, a drag): the element at rest postpones its new still until
 * this clears, so the decode workers serve the live view first.
 */
export const fluximgLiveBusy = writable(false);

/**
 * The object under the pointer or the hovered list row: both sides read and write it. A row of the key (a category)
 * lights every object it names: `keys`, with `key` the first of them.
 */
export interface LiveHover { layerId: string; key: string; from: "image" | "list" | "legend"; keys?: string[] }
export const fluximgHover = writable<LiveHover | null>(null);

/**
 * What a hovered (or walked) styling key would do, shown on the live image before it is chosen: ONE override, one
 * part of one layer's styling set to `column` (null = off), applied over the model by the overlay each time it draws
 * (`objectStyle.previewStyleBy`), so an undo under a preview shows the undone model. Nothing is written; leaving the
 * key or the drawer puts the image back.
 */
export const fluximgStylePreview = writable<{ layerId: string; part: "color" | "opacity"; column: string | null } | null>(null);

/**
 * Where the pointer is over the live image, in level-0 image pixels; null elsewhere. Read on demand (not a store).
 * `at` follows the pointer once a frame; `locate` (set by the overlay while it is mounted) answers for any client
 * point at once, which is what a wheel notch needs: the notch may come before the frame that would have updated `at`.
 */
export const livePointer: { at: { x: number; y: number } | null; locate: ((clientX: number, clientY: number) => { x: number; y: number } | null) | null } = { at: null, locate: null };

/**
 * The pixels on screen, for "Auto": per shown channel, the plane the current frame drew and the rectangle of it
 * that is in view. Set by the overlay while it is mounted; null otherwise. Read on demand (not a store).
 */
export interface LiveSample { channel: number; data: ArrayLike<number>; map: { mul: number; add: number; sub: number; nodata: number | null } | null; width: number; height: number; rect: { x: number; y: number; width: number; height: number } }
export const liveSampler: { read: (() => LiveSample[]) | null } = { read: null };

/**
 * Who put it in hand. The view takes its first rail by itself when it opens; that implicit hold answers the wheel
 * only over the image and the board, so the canvas still pans everywhere else. Something the user took in hand
 * (its key, a click on it) answers the wheel anywhere on screen.
 */
export const liveArm = { explicit: false };
/** Take something in hand because the user asked for it. */
export function armLive(key: string | null): void {
  liveArm.explicit = key !== null;
  setLive({ armed: key });
}

/** What is under the pointer on the live image: the board shows it on its instruments. */
export interface LiveReadout {
  /** Where the pointer is, in words: ["x 12.40 µm", "y 8.25 µm"]. */
  where: [string, string];
  /** The value of each channel the frame on screen drew, by channel index. NaN = no data there. */
  values: Array<{ channel: number; value: number; text: string }>;
  /** The object under the pointer, if any. */
  object: { layerId: string; key: string } | null;
  /** The pointer in the element's box, as fractions of its width and height (0 .. 1). */
  u: number; v: number;
}
export const fluximgReadout = writable<LiveReadout | null>(null);
/**
 * The board's one label: what the thing under the pointer is, and its key. Host px; `below` = under the thing
 * (when there is no room above it). The board draws it; the board's own parts and the overlay's (an annotation's
 * grip on the picture) set it.
 */
export interface LiveTip { text: string; hk: string; x: number; y: number; below: boolean }
export const fluximgTip = writable<LiveTip | null>(null);
/** A problem the live canvas ran into (no WebGL, an unreadable plane): shown on the board's head. */
export const fluximgLiveProblem = writable("");
/** What the frame on screen is: bumped by the overlay every time a frame is presented. */
export const fluximgFrame = writable<{ serial: number; sharp: boolean; pending: number }>({ serial: 0, sharp: true, pending: 0 });

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
  fluximgLive.set({ elementId: id, channel: 0, armed: null, playing: null, speed: 1 });
  return true;
}

export function closeFluximgLive(): void {
  if (!get(fluximgLive)) return;
  settleLiveEdit();
  fluximgHover.set(null);
  livePointer.at = null; livePointer.locate = null;
  liveSampler.read = null;
  liveArm.explicit = false;
  fluximgReadout.set(null);
  fluximgTip.set(null);
  fluximgLiveProblem.set("");
  fluximgLive.set(null);
}

/** Change what is in hand, or playback. Changing what is in hand settles the open gesture. */
export function setLive(patch: Partial<Omit<FluximgLiveState, "elementId">>): void {
  const live = get(fluximgLive);
  if (!live) return;
  if (("armed" in patch && patch.armed !== live.armed) || ("channel" in patch && patch.channel !== live.channel)) settleLiveEdit();
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
