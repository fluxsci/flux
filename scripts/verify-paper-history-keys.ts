// Pure gate: Paper's redo chord works on Windows.
//
// CodeMirror's stock historyKeymap binds Ctrl+Shift+Z to redo only through a `linux:` entry
// (and Cmd+Shift+Z through `mac:`); Windows gets Ctrl+Y alone. Flux documents Ctrl+Shift+Z as
// redo in every editor, so src/shell/modes/paper/historyKeys.ts binds the shifted chord with
// no platform qualifier. This gate proves that through CodeMirror's OWN keymap builder and
// key-event dispatcher, without a DOM:
//
//   - the builder reads `win ?? key` on Windows and never sees `mac:`/`linux:` entries, so the
//     bindings are filtered to exactly that subset before they are handed to `keymap.of`;
//   - `runScopeHandlers` needs only `{state, dispatch}` and a keydown-shaped event, so a fake
//     view over an EditorState with `history()` is enough to observe whether redo RAN.
//
// Node reports the host platform (Linux here), which only decides what `Mod` normalizes to —
// Ctrl on Linux/Windows, Meta on a macOS dev box — and the synthetic event uses that same
// modifier, so the resolution is a Windows one wherever this runs.
//
//   npx tsx scripts/verify-paper-history-keys.ts
import { readFileSync } from "node:fs";
import { EditorState, type Transaction } from "@codemirror/state";
import { keymap, runScopeHandlers, type KeyBinding } from "@codemirror/view";
import { history, historyKeymap, defaultKeymap, indentWithTab, redo, undo } from "@codemirror/commands";
import { searchKeymap } from "@codemirror/search";
import { foldKeymap } from "@codemirror/language";
import { paperHistoryKeymap } from "../src/shell/modes/paper/historyKeys";
import { harness } from "./lib/harness.mjs";

const h = harness("verify-paper-history-keys");

// The subset CodeMirror's builder reads on win32 (view/dist: `b[platform] ?? b.key` with
// platform "win"; `mac`/`linux` are other platforms' names and never consulted there).
const asWindowsSees = (bindings: readonly KeyBinding[]): KeyBinding[] =>
  bindings
    .map((b) => ({ ...b, key: b.win ?? b.key, mac: undefined, linux: undefined, win: undefined }))
    .filter((b) => !!b.key);

const MOD = process.platform === "darwin" ? "metaKey" : "ctrlKey";
const TEXT = "redo me";

function makeView(bindings: readonly KeyBinding[]) {
  let state = EditorState.create({ doc: "", extensions: [history(), keymap.of(bindings)] });
  return {
    get state() { return state; },
    dispatch(tr: Transaction) { state = tr.state; },
    doc: () => state.doc.toString(),
  };
}
const keydown = (key: string, keyCode: number, shift: boolean) =>
  ({ key, keyCode, shiftKey: shift, altKey: false, ctrlKey: MOD === "ctrlKey", metaKey: MOD === "metaKey", preventDefault() {}, stopPropagation() {} }) as unknown as KeyboardEvent;

/** Type TEXT, undo it, then press the chord; report whether redo ran. */
function redoVia(bindings: readonly KeyBinding[], key: string, keyCode: number, shift: boolean) {
  const view = makeView(bindings);
  view.dispatch(view.state.update({ changes: { from: 0, insert: TEXT } }));
  undo(view);
  if (view.doc() !== "") throw new Error("undo did not revert the typed text — fixture broken");
  const handled = runScopeHandlers(view as never, keydown(key, keyCode, shift), "editor");
  return { handled, redid: view.doc() === TEXT };
}
/** Type TEXT, then press the chord; report whether undo ran. */
function undoVia(bindings: readonly KeyBinding[], key: string, keyCode: number) {
  const view = makeView(bindings);
  view.dispatch(view.state.update({ changes: { from: 0, insert: TEXT } }));
  runScopeHandlers(view as never, keydown(key, keyCode, false), "editor");
  return view.doc() === "";
}

h.section("Paper's keymap, as Windows reads it");
const win = asWindowsSees(paperHistoryKeymap);
h.ok(win.length < paperHistoryKeymap.length, `the linux-only entry is invisible on Windows (${paperHistoryKeymap.length} → ${win.length} bindings)`);
{
  const r = redoVia(win, "Z", 90, true);
  h.ok(r.redid, "Ctrl+Shift+Z redoes (the documented chord, every editor, every platform)");
  h.ok(r.handled, "…and the chord is reported handled, so the browser default never fires");
}
h.ok(redoVia(win, "y", 89, false).redid, "Ctrl+Y still redoes (the Windows convention is kept)");
h.ok(undoVia(win, "z", 90), "Ctrl+Z still undoes");
h.ok(!redoVia(win, "z", 90, false).redid, "plain Ctrl+Z does not redo");

h.section("Why the override exists");
{
  // Pinned so a CodeMirror upgrade that fixes this upstream says so here, instead of leaving a
  // redundant binding nobody remembers the reason for. If this fails: shrink historyKeys.ts.
  const stock = redoVia(asWindowsSees(historyKeymap), "Z", 90, true);
  h.ok(!stock.redid, "the STOCK historyKeymap alone does not redo on Ctrl+Shift+Z for Windows (upstream binds it linux-only)");
  h.ok(redoVia(historyKeymap, "Z", 90, true).redid || process.platform === "win32", "…while on this host's platform the stock list does (the gap really is Windows-only)");
}

h.section("In Paper's real assembly order");
{
  // markdown-setup.ts spreads search → default → history → fold → indentWithTab. Nothing ahead
  // of the history list may claim the chord first; resolve it in exactly that order.
  const assembled = [...searchKeymap, ...defaultKeymap, ...paperHistoryKeymap, ...foldKeymap, indentWithTab];
  h.ok(redoVia(asWindowsSees(assembled), "Z", 90, true).redid, "Ctrl+Shift+Z still reaches redo behind the search and default keymaps (Windows reading)");
  h.ok(redoVia(asWindowsSees(assembled), "y", 89, false).redid, "Ctrl+Y likewise");
  h.ok(undoVia(asWindowsSees(assembled), "z", 90), "Ctrl+Z likewise");
}

h.section("The editor assembles the fixed list");
{
  const setup = readFileSync("src/shell/modes/paper/markdown-setup.ts", "utf8");
  h.ok(/\.\.\.paperHistoryKeymap/.test(setup), "markdown-setup spreads paperHistoryKeymap into the editor keymap");
  h.ok(!/\.\.\.historyKeymap\b/.test(setup), "…and no longer spreads the bare stock historyKeymap");
  const first = paperHistoryKeymap[0];
  h.ok(first.key === "Mod-Shift-z" && first.run === redo && !first.mac && !first.linux && !first.win, "the override is the first entry, unqualified, and runs redo");
}

await h.done();
