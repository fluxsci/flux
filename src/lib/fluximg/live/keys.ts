/**
 * The board's key map, as data: the ONE table the board's key handler reads (`boardKeyOf`), the modes ask
 * (`session.liveKeyOwner`, through the board's registered `liveKeys.take`) and the gates check
 * (`verify-fluximg-board-keys`).
 *
 * THE LAW (ledger call 50): the board takes exactly the keys in this table, the ones its keys show, and nothing
 * else. Function keys, PageUp / PageDown, Home / End and every chord with Ctrl / Cmd pass to the mode at all times;
 * an Alt chord passes unless it is a row here (Alt + a digit solos a channel). A key the board does not take goes on
 * to the mode: the mode's own keys (F5 presents, F2 renames, PageDown changes slide) work with the board open; the
 * canvas keymap's own unmodified keys (Delete, the tool letters, Tab) are HELD by the canvas keymap while the board
 * is open (`session.liveKeyOwner` → "held"), so nothing edits the image under the board.
 *
 * Pure: no stores, no DOM. The board hands in what it knows (`BoardKeyState`); "a surface above the board owns the
 * keyboard" (Present, the slide preview, the X-ray, a dialog) is decided by the board before it asks.
 */

/** What a key event says, as far as the table cares. */
export interface KeyLike { key: string; code: string; shiftKey: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean }

/** What the board knows that decides whether a key is its own. */
export interface BoardKeyState {
  /** Channels in the view (digits 1-9 take them). */
  channels: number;
  /** Each rail's dimension and its key (`actions.dimKeys`). */
  rails: Record<string, string>;
  /** The image has layers (D hands the keyboard to the layers card). */
  hasLayers: boolean;
  /** On a slide at "Edit after step N" (the step card's keys). */
  atStep: boolean;
  /** An inset is in hand (Enter makes it). */
  insetArmed: boolean;
  /** The projection chooser is open, with this many choices (0 = closed). */
  choosing: number;
  /** The layers card holds the keyboard (after D): it walks its own list; only Escape is the board's. */
  layersKeys: boolean;
}

/** The board's actions, by key. "pass" is a row that hands the key on (the table says so, rather than leaving it out). */
export type BoardAction =
  | "back" | "close" | "movie" | "menu" | "channel" | "arrow" | "play" | "inset-make" | "rail" | "through" | "blend"
  | "auto" | "split" | "projection" | "layers" | "frame" | "inset" | "smooth" | "scalebar" | "stamp" | "channelLabels" | "colorbar"
  | "chooser-pick" | "chooser-walk" | "chooser-close" | "chooser-hold" | "pass";

type Match = string | "digit" | "rail" | "arrow" | "any";
export interface BoardKeyRow {
  action: BoardAction;
  /** `e.key` lowercased for a printable key, or its name ("Escape", " "), or a class: a digit by `e.code`, a rail's key, an arrow, any key. */
  key: Match;
  /** true: only with Shift; false: only without; absent: either. Alt likewise. */
  shift?: boolean;
  alt?: boolean;
  /** When the row applies. */
  when?: (s: BoardKeyState) => boolean;
  /** The key cap as the board shows it. */
  cap: string;
  /** What the board does, in words. */
  does: string;
  /** What the same key does in the mode when the board is closed (where both bind it). */
  instead?: string;
}

const ARROWS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]);
const digitOf = (code: string): number => { const m = /^Digit([1-9])$/.exec(code); return m ? Number(m[1]) : 0; };

/**
 * The table, in the order it is read (the first row that matches decides). Keys the board's paper keys show are here
 * with the cap they show; nothing here is not shown somewhere on the board (a key's label, a rail's cap, the chooser).
 */
export const BOARD_KEYS: readonly BoardKeyRow[] = [
  { action: "back", key: "Escape", cap: "Esc", does: "Lets go of what is in hand (stops a preview, closes the chooser, gives the layers card's keys back); then closes the board", instead: "the canvas's Escape (clears the selection)" },
  // The layers card holds the keyboard after D: its own handler (BoardLayers, capture phase) takes its keys first.
  { action: "pass", key: "any", when: (s) => s.layersKeys, cap: "", does: "The layers card walks its own list (BoardLayers); what it does not take passes" },
  // The projection chooser, while open: its numbers, a walk through it, a pick, and E again closes it.
  { action: "chooser-pick", key: "digit", alt: false, when: (s) => s.choosing > 0, cap: "1-9", does: "Picks a projection by its number" },
  { action: "chooser-walk", key: "arrow", alt: false, when: (s) => s.choosing > 0, cap: "← →", does: "Walks the projection choices" },
  { action: "chooser-pick", key: "Enter", alt: false, when: (s) => s.choosing > 0, cap: "Enter", does: "Picks the lit projection" },
  { action: "chooser-pick", key: " ", alt: false, when: (s) => s.choosing > 0, cap: "Space", does: "Picks the lit projection" },
  { action: "chooser-close", key: "e", alt: false, when: (s) => s.choosing > 0, cap: "E", does: "Closes the projection chooser" },
  { action: "pass", key: "any", alt: true, when: (s) => s.choosing > 0, cap: "", does: "Alt chords pass while the chooser is open" },
  { action: "chooser-hold", key: "any", when: (s) => s.choosing > 0, cap: "", does: "An open choice holds stray keys rather than firing another key" },
  { action: "close", key: "r", shift: false, alt: false, cap: "R", does: "Closes the board (its open edit kept as one undo step)", instead: "opens the board on a selected image" },
  { action: "movie", key: "r", shift: true, alt: false, cap: "⇧R", does: "Movie as MP4 along the rail in hand (again: stops it)", instead: "shows or hides the rulers" },
  { action: "menu", key: "f", alt: false, cap: "F", does: "Opens the properties menu (as everywhere in Flux)", instead: "opens the properties menu" },
  { action: "channel", key: "digit", when: (s) => s.channels > 0, cap: "1-9 · ⇧ · ⌥", does: "Takes a channel in hand; with Shift shows or hides it; with Alt shows it alone" },
  { action: "pass", key: "any", alt: true, cap: "", does: "Any other Alt chord passes to the mode" },
  { action: "arrow", key: "arrow", cap: "← → ↑ ↓", does: "Steps along the rails (left / right the first lying rail, up / down depth); with Shift by 10; without a rail, holds them so the image is not nudged", instead: "nudges the selection, or (nothing selected) changes slide" },
  { action: "play", key: " ", cap: "Space · ⇧Space", does: "Tap: plays the rail in hand (on a slide, a preview that writes nothing); at a step, Shift+Space starts the movie at this step or takes the start away", instead: "pans while held (Space+drag)" },
  { action: "inset-make", key: "Enter", when: (s) => s.insetArmed, cap: "Enter", does: "Makes the inset from the frame as it is" },
  { action: "through", key: "rail", shift: true, when: (s) => s.atStep, cap: "⇧ + a rail's key", does: "Plays this step through along that rail" },
  { action: "rail", key: "rail", cap: "T · Z · Q", does: "Takes that rail in hand (the wheel steps it)" },
  { action: "blend", key: "n", shift: true, when: (s) => s.atStep, cap: "⇧N", does: "Blends planes while this step walks" },
  { action: "auto", key: "a", cap: "A", does: "Auto contrast (the channel in hand, else all)" },
  { action: "split", key: "s", when: (s) => s.channels > 1, cap: "S", does: "Splits the channels into panels (Design only on a slide)" },
  { action: "projection", key: "e", when: (s) => Object.keys(s.rails).length > 0, cap: "E", does: "Opens the projection chooser of the rail in hand" },
  { action: "layers", key: "d", when: (s) => s.hasLayers, cap: "D", does: "Hands the keyboard to the layers card", instead: "opens a plot's dissections" },
  { action: "frame", key: "v", cap: "V · ⇧V", does: "Takes the frame in hand (wheel zooms, drag moves); with Shift shows the whole image" },
  { action: "inset", key: "x", cap: "X", does: "Inset: drag a box on the image (Design only on a slide)" },
  { action: "smooth", key: "n", cap: "N", does: "True pixels or smoothed" },
  { action: "scalebar", key: "b", cap: "B · ⇧B", does: "Scale bar on or off; with Shift to its next corner", instead: "Become (on a slide)" },
  { action: "stamp", key: "w", when: (s) => Object.keys(s.rails).length > 0, cap: "W · ⇧W", does: "Position stamp on or off; with Shift to its next corner" },
  { action: "channelLabels", key: "c", cap: "C · ⇧C", does: "Channel names on or off; with Shift to their next corner" },
  { action: "colorbar", key: "g", cap: "G · ⇧G", does: "Calibration bar on or off; with Shift to its next corner" },
];

/** Keys that always pass to the mode, whatever the board holds: the function keys and the page keys. */
export const PASSING_KEYS: readonly string[] = ["F1-F24", "PageUp", "PageDown", "Home", "End", "Ctrl / Cmd + any key"];
export const alwaysPasses = (e: KeyLike): boolean => e.ctrlKey || e.metaKey || /^F\d{1,2}$/.test(e.key) || e.key === "PageUp" || e.key === "PageDown" || e.key === "Home" || e.key === "End";

function matches(row: BoardKeyRow, e: KeyLike, k: string, s: BoardKeyState): boolean {
  if (row.shift !== undefined && row.shift !== e.shiftKey) return false;
  if (row.alt !== undefined && row.alt !== e.altKey) return false;
  switch (row.key) {
    case "any": break;
    case "arrow": if (!ARROWS.has(k)) return false; break;
    case "digit": {
      const n = digitOf(e.code);
      if (!n) return false;
      if (row.action === "channel" ? n > s.channels : n > s.choosing) return false;
      break;
    }
    case "rail": if (!Object.values(s.rails).includes(k)) return false; break;
    default: if (row.key !== k) return false;
  }
  return !row.when || row.when(s);
}

/** The row that owns a key, or null when the key is not the board's (it passes to the mode). */
export function boardKeyOf(e: KeyLike, s: BoardKeyState): BoardKeyRow | null {
  if (alwaysPasses(e)) return null;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  for (const row of BOARD_KEYS) if (matches(row, e, k, s)) return row.action === "pass" ? null : row;
  return null;
}

/** The rail a rail-key row names (its dimension), or null. */
export function railOfKey(e: KeyLike, s: BoardKeyState): string | null {
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  return Object.entries(s.rails).find(([, key]) => key === k)?.[0] ?? null;
}
