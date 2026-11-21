// verify-fluximg-board-keys (pure tier): the image board takes exactly the keys of its key map and nothing else
// (ledger call 50; review A2, B1). The key map is data (src/lib/fluximg/live/keys.ts `BOARD_KEYS`); the board's
// handler, the modes (`session.liveKeyOwner`) and this gate all read it.
//   * Every key Slide mode binds (a census of SlideMode.svelte's own handler, Present's and the editor preview's keys)
//     is either one of the board's documented rows or passes to the mode; none is dead. The census fails closed: a
//     key literal in SlideMode's handler that this gate does not know fails it.
//   * Function keys, PageUp / PageDown, Home / End and every Ctrl / Cmd chord pass in every board state (the chooser
//     open, the layers card holding the keyboard, at a step); Alt chords pass except Alt + a channel's digit.
//   * Every row of the table is reachable (no row shadows another), and every key cap the board's paper keys show is
//     a row.
//   * The handlers read the table: FluximgBoard's onKey goes through `boardKeyOf`, SlideMode and the canvas keymap ask
//     `liveKeyOwner`, never "is the board open".
// Run: npx tsx scripts/verify-fluximg-board-keys.ts
import { readFileSync } from "node:fs";
import { harness } from "./lib/harness.mjs";
import { BOARD_KEYS, boardKeyOf, type BoardKeyState, type KeyLike } from "../src/lib/fluximg/live/keys";

const h = harness("verify-fluximg-board-keys");
const read = (p: string): string => readFileSync(p, "utf8");

/** A key event: "Shift+Ctrl+z", "F5", "Space", "Alt+Digit2", "ArrowRight". */
function ev(spec: string): KeyLike {
  const parts = spec.split("+");
  let name = parts.pop()!;
  if (name === "" ) name = "+";
  const mods = new Set(parts.map((m) => m.toLowerCase()));
  const shift = mods.has("shift");
  let key = name, code = name;
  if (name === "Space") { key = " "; code = "Space"; }
  else if (/^Digit\d$/.test(name)) { key = shift ? "!@#$%^&*("[Number(name.slice(5)) - 1] : name.slice(5); code = name; }
  else if (name.length === 1) { key = shift ? name.toUpperCase() : name.toLowerCase(); code = /[a-z]/i.test(name) ? `Key${name.toUpperCase()}` : name; }
  return { key, code, shiftKey: shift, altKey: mods.has("alt"), ctrlKey: mods.has("ctrl"), metaKey: mods.has("meta") };
}

const BASE: BoardKeyState = { channels: 2, rails: { t: "t", z: "z" }, hasLayers: true, atStep: false, insetArmed: false, choosing: 0, layersKeys: false };
const STATES: Record<string, BoardKeyState> = {
  "the board (Design)": BASE,
  "the board at a step": { ...BASE, atStep: true },
  "a still image (no rails, one channel, no layers)": { ...BASE, channels: 1, rails: {}, hasLayers: false },
  "the projection chooser open": { ...BASE, choosing: 6 },
  "the layers card holding the keyboard": { ...BASE, layersKeys: true },
  "an inset in hand": { ...BASE, insetArmed: true },
};
const owner = (spec: string, s: BoardKeyState = BASE): string | null => boardKeyOf(ev(spec), s)?.action ?? null;

// --- the census: every key Slide mode binds ----------------------------------------------------------------------
// What each does with the board open: "board:<action>" (the board's documented thing) or "mode" (it passes on; the
// mode does what it always does). Source: SlideMode.svelte onKey / pickKey, PresentOverlay (the board is closed while
// Present is up), the editor preview (the board takes no key while the preview is up: `holdLiveKeys` "preview").
const SLIDE_MODE_KEYS: Record<string, string> = {
  F5: "mode", "Shift+F5": "mode", F2: "mode", PageDown: "mode", PageUp: "mode", Home: "mode", End: "mode",
  // Slide navigation with the arrows only applies with nothing selected; the board's image is selected: its rails.
  ArrowDown: "board:arrow", ArrowUp: "board:arrow", ArrowLeft: "board:arrow", ArrowRight: "board:arrow",
  Escape: "board:back",
  // b arms Become for the selection; on the board B is the scale bar (shown on its key). Become stays on Ctrl+Shift+E.
  b: "board:scalebar",
  "Ctrl+Shift+a": "mode", "Ctrl+Shift+d": "mode", "Ctrl+Shift+c": "mode", "Ctrl+Shift+e": "mode",
  "Ctrl+Alt+g": "mode", "Ctrl+Alt+a": "mode", "Ctrl+Alt+c": "mode",
  "Ctrl+z": "mode", "Ctrl+y": "mode", "Ctrl+Shift+z": "mode", "Ctrl+s": "mode", "Ctrl+k": "mode", "Ctrl+b": "mode", "Ctrl+p": "mode",
  "Alt+g": "mode", "Alt+t": "mode", "Alt+l": "mode", "Alt+Shift+r": "mode", "Alt+r": "mode", "Alt+m": "mode",
  // The board's own keys that the canvas keymap also binds (R opens / closes the board; Shift+R is the rulers'; F the menu).
  r: "board:close", "Shift+r": "board:movie", f: "board:menu",
  // Space: the board's preview (with the slide's editor preview up, the board yields: see the GUI gate).
  Space: "board:play",
};
h.section("every key Slide mode binds: the board's documented thing, or it passes");
for (const [spec, want] of Object.entries(SLIDE_MODE_KEYS)) {
  const got = owner(spec);
  h.eq(got ? `board:${got}` : "mode", want, `${spec} with the board open (Design)`);
}
// The census fails closed: every key literal in SlideMode's key handler must be classified above.
{
  const src = read("src/shell/modes/slide/SlideMode.svelte");
  const body = src.slice(src.indexOf("function onKey(e: KeyboardEvent)"), src.indexOf("// Paste onto the active slide"));
  const literals = new Set<string>();
  for (const m of body.matchAll(/e\.key\s*===\s*"([^"]+)"/g)) literals.add(m[1]);
  for (const m of body.matchAll(/e\.code\s*===\s*"([^"]+)"/g)) literals.add(m[1] === "KeyB" ? "b" : m[1]);
  for (const m of body.matchAll(/\[("[a-z]"(?:,\s*"[a-z]")*)\]\.includes\(k\)/g)) for (const l of m[1].matchAll(/"([a-z])"/g)) literals.add(`Ctrl+Shift+${l[1]}`);
  const known = new Set(Object.keys(SLIDE_MODE_KEYS).map((k) => k.replace(/^Shift\+/, "")));
  known.add("Space");
  const unknown = [...literals].filter((l) => !known.has(l) && !known.has(l.replace(/^Ctrl\+Shift\+/, "Ctrl+Shift+")));
  h.ok(literals.size >= 6, `SlideMode's handler read (${literals.size} key literals: ${[...literals].join(", ")})`);
  h.eq(unknown, [], "every key literal in SlideMode's handler is in the census");
}

h.section("function keys, page keys and Ctrl / Cmd chords pass in every board state; Alt chords too, but a channel's digit");
for (const [name, s] of Object.entries(STATES)) {
  const passing = ["F1", "F2", "F5", "Shift+F5", "F11", "F12", "PageUp", "PageDown", "Home", "End", "Ctrl+z", "Ctrl+Shift+z", "Meta+z", "Ctrl+s", "Ctrl+a", "Ctrl+Digit1", "Ctrl+Space", "Ctrl+ArrowRight", "Alt+g", "Alt+t", "Alt+ArrowRight", "Alt+Shift+r"];
  const wrong = passing.filter((k) => owner(k, s) !== null);
  h.eq(wrong, [], `${name}: ${passing.length} keys pass`);
}
h.eq(owner("Alt+Digit1"), "channel", "Alt + a channel's digit is the board's (shows that channel alone)");
h.eq(owner("Alt+Digit3"), null, "Alt + a digit with no such channel passes");
h.eq(owner("Escape", STATES["the layers card holding the keyboard"]), "back", "the layers card holding the keyboard: Escape is the board's (gives the keys back)");
h.eq(owner("x", STATES["the layers card holding the keyboard"]), null, "the layers card holding the keyboard: its letters are the card's own");
h.eq(owner("q", STATES["the projection chooser open"]), "chooser-hold", "the chooser open: a stray letter is held rather than firing another key");
h.eq(owner("Digit3", STATES["the projection chooser open"]), "chooser-pick", "the chooser open: a digit picks");
h.eq(owner("Delete"), null, "Delete is not the board's (the canvas keymap holds it while the board is open: session.liveKeyOwner)");
h.eq(owner("Tab"), null, "Tab is not the board's");
h.eq(owner("s", STATES["a still image (no rails, one channel, no layers)"]), null, "S with one channel (no Split key shown) is not the board's");
h.eq(owner("w", STATES["a still image (no rails, one channel, no layers)"]), null, "W with no rail (no stamp key shown) is not the board's");
h.eq(owner("Shift+t", STATES["the board at a step"]), "through", "at a step, Shift + a rail's key plays the step through");
h.eq(owner("Shift+t"), "rail", "in Design, Shift + a rail's key takes it in hand");
h.eq(owner("Shift+n", STATES["the board at a step"]), "blend", "at a step, Shift+N blends");
h.eq(owner("Enter", STATES["an inset in hand"]), "inset-make", "Enter makes the inset in hand");
h.eq(owner("Enter"), null, "Enter without an inset in hand is not the board's");

h.section("every row is reachable, every shown key is a row");
{
  const probe: Record<string, string> = { digit: "Digit1", rail: "t", arrow: "ArrowLeft", any: "q", " ": "Space" };
  for (const row of BOARD_KEYS) {
    if (row.action === "pass" || row.key === "any") continue;
    const s: BoardKeyState = { ...BASE, atStep: true, insetArmed: true, choosing: row.action.startsWith("chooser") ? 6 : 0 };
    let spec = probe[row.key] ?? (row.key.length === 1 ? row.key : row.key);
    if (row.shift) spec = `Shift+${spec}`;
    if (row.alt) spec = `Alt+${spec}`;
    const got = boardKeyOf(ev(spec), s);
    h.ok(got === row || (got?.action === row.action), `${row.action} (${row.cap}) is reached by ${spec}${got && got !== row ? ` (an equal row: ${got.cap})` : ""}`);
    h.ok(!!row.cap && !!row.does, `${row.action} has its cap and its words`);
  }
  // The caps the board shows (PaperKey hotkeys, data-hk) are rows.
  const shown = new Set<string>();
  for (const f of ["FluximgBoard", "BoardRail", "BoardChannel", "BoardStep"]) {
    const src = read(`src/lib/fluximg/live/${f}.svelte`);
    for (const m of src.matchAll(/hotkey="([^"]+)"/g)) shown.add(m[1]);
  }
  shown.add("⇧T"); shown.add("⇧N"); shown.add("⇧Space"); shown.add("1"); shown.add("⌥1"); shown.add("⇧1"); shown.add("Esc"); shown.add("T"); shown.add("Z");
  const specOf = (cap: string): string => cap.replace(/^⇧/, "Shift+").replace(/^⌥/, "Alt+").replace(/^Esc$/, "Escape").replace(/(^|\+)(\d)$/, "$1Digit$2");
  const missing = [...shown].filter((cap) => !boardKeyOf(ev(specOf(cap)), { ...BASE, atStep: true }));
  h.eq(missing, [], `every key the board shows (${[...shown].sort().join(" ")}) is a row of its key map`);
}

h.section("the handlers read the table");
{
  const board = read("src/lib/fluximg/live/FluximgBoard.svelte");
  h.ok(/boardKeyOf\(e, keyState\(\)\)/.test(board), "FluximgBoard decides a key through boardKeyOf");
  h.ok(/liveKeys\.take = /.test(board), "FluximgBoard registers its key map for the modes (liveKeys.take)");
  const onKey = board.slice(board.indexOf("function onKey(e: KeyboardEvent)"), board.indexOf("let spaceTap"));
  h.ok(!/done\(\);?\s*\/\/ the board owns unmodified keys/.test(onKey) && !/e\.key\.length === 1 \? e\.key\.toLowerCase\(\)/.test(onKey), "FluximgBoard's onKey swallows no key outside its map");
  const slide = read("src/shell/modes/slide/SlideMode.svelte");
  h.ok(/liveKeyOwner\(e\) === "board"/.test(slide) && !/get\(fluximgLive\) && !typing/.test(slide), "SlideMode yields only the board's own keys (liveKeyOwner)");
  h.ok(/function launchPresent[\s\S]{0,400}closeFluximgLive\(\)/.test(slide), "opening Present closes the board first");
  h.ok(/holdLiveKeys\(\(\) => presentOpen \? "present"/.test(slide), "Slide mode holds the board's keys while Present, its preview, pick mode or a dialog is up");
  const kb = read("src/lib/keyboard.ts");
  h.ok(/if \(liveKeyOwner\(e\)\) return;/.test(kb) && !/get\(fluximgLive\) && !\(e\.ctrlKey \|\| e\.metaKey\)/.test(kb), "the canvas keymap asks liveKeyOwner (the board's keys, or held), not 'is the board open'");
}

await h.done();
