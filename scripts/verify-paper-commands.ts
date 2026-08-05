#!/usr/bin/env -S npx tsx
// WS-4.3 (fortify plan) — the ONE shortcut table's contract:
//   (a) every owner:"window" row is reachable via BOTH the palette and the
//       window dispatcher (and CM/none rows never carry chords);
//   (b) no window chord collides with the CodeMirror keymap layer's set
//       (both tables imported and intersected — the drift class that produced
//       hints promising keys another layer owned);
//   (c) dispatch semantics: exact modifier matching, both terminal chords on
//       one row, palette hints derived from the chords.
//   npx tsx scripts/verify-paper-commands.ts

import "./lib/cssStub.mjs";

const { PAPER_COMMANDS, paletteFromTable, dispatchWindowKey, matchesChord, chordHint } = await import(
  "../src/shell/modes/paper/commands"
);
const { CM_CHORD_STRINGS, CM_HINTS } = await import("../src/shell/modes/paper/editing/keymap");
import type { PaperCmdCtx } from "../src/shell/modes/paper/commands";

let failures = 0;
const ok = (m: string) => console.log("  ok:", m);
const fail = (m: string) => {
  console.error("  ✗ FAIL:", m);
  failures++;
};
const assert = (c: unknown, m: string) => (c ? ok(m) : fail(m));

function recorderCtx(): { ctx: PaperCmdCtx; calls: string[] } {
  const calls: string[] = [];
  const rec =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push(args.length ? `${name}:${args.join(",")}` : name);
    };
  const ctx = new Proxy({} as PaperCmdCtx, {
    get: (_t, prop: string) => {
      if (prop === "previewActive" || prop === "outlinerOpen" || prop === "marginOpen") return () => false;
      if (prop === "vimFlavor") return () => "off";
      return rec(prop);
    },
  });
  return { ctx, calls };
}

// ---- (a) window rows: palette + dispatcher reachability ------------------------
{
  const { ctx } = recorderCtx();
  const palette = paletteFromTable(ctx);
  const paletteIds = new Set(palette.map((p) => p.id));
  for (const row of PAPER_COMMANDS) {
    if (row.owner === "window") {
      assert(row.keys && row.keys.length > 0, `window row ${row.id} carries chord(s)`);
      if (row.palette !== false)
        assert(paletteIds.has(row.id), `window row ${row.id} is reachable via the palette`);
    } else {
      assert(!row.keys, `${row.owner} row ${row.id} carries NO window chords`);
    }
  }
  assert(!paletteIds.has("palette"), "the palette does not list itself");
}

// ---- (b) chord collision against the CM keymap layer ---------------------------
{
  // Normalize both vocabularies to {mod, alt, shift, key-char}.
  const CODE_TO_CHAR: Record<string, string> = { Backquote: "`", Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]" };
  const windowChords = PAPER_COMMANDS.flatMap((r) => (r.owner === "window" ? (r.keys ?? []) : []));
  const normWindow = windowChords.map((c) => {
    const parts = c.split("+");
    const code = parts[parts.length - 1];
    const mods = new Set(parts.slice(0, -1));
    const ch = code.startsWith("Key")
      ? code.slice(3).toLowerCase()
      : code.startsWith("Digit")
        ? code.slice(5)
        : (CODE_TO_CHAR[code] ?? code.toLowerCase());
    return `${mods.has("Mod") ? "M" : ""}${mods.has("Alt") ? "A" : ""}${mods.has("Shift") ? "S" : ""}:${ch}`;
  });
  const normCm = CM_CHORD_STRINGS.map((c: string) => {
    const parts = c.split("-");
    // CodeMirror syntax: "Mod-Shift-k", "Mod-Alt--" (trailing empty = literal -)
    let key = parts[parts.length - 1];
    if (key === "" ) key = "-";
    const mods = new Set(parts.slice(0, -1).filter(Boolean));
    if (c.endsWith("--")) mods.delete("");
    return `${mods.has("Mod") ? "M" : ""}${mods.has("Alt") ? "A" : ""}${mods.has("Shift") ? "S" : ""}${mods.has("Ctrl") ? "C" : ""}:${key.toLowerCase()}`;
  });
  const cmSet = new Set(normCm.map((s) => s.replace("C:", ":"))); // Mod covers ctrl for the collision check
  const collisions = normWindow.filter((w) => cmSet.has(w));
  assert(collisions.length === 0, `no window chord collides with the CM keymap layer (${collisions.join(", ") || "clean"})`);
}

// ---- (c) dispatch semantics ------------------------------------------------------
{
  const mk = (over: Partial<KeyboardEvent>): KeyboardEvent =>
    ({ metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, code: "", key: "", preventDefault() {}, ...over }) as KeyboardEvent;

  const t1 = recorderCtx();
  assert(dispatchWindowKey(mk({ altKey: true, code: "KeyT" }), t1.ctx) && t1.calls.join() === "summonPane:terminal", "Alt+T → terminal");
  const t2 = recorderCtx();
  assert(dispatchWindowKey(mk({ ctrlKey: true, code: "Backquote" }), t2.ctx) && t2.calls.join() === "summonPane:terminal", "Mod+` → terminal (both chords, one row)");
  const t3 = recorderCtx();
  assert(dispatchWindowKey(mk({ ctrlKey: true, shiftKey: true, code: "KeyE" }), t3.ctx) && t3.calls.join() === "togglePreview", "Mod+Shift+E → preview toggle");
  const t4 = recorderCtx();
  assert(!dispatchWindowKey(mk({ altKey: true, shiftKey: true, code: "KeyT" }), t4.ctx), "extra Shift breaks the Alt+T match (exact modifiers)");
  const t5 = recorderCtx();
  assert(dispatchWindowKey(mk({ ctrlKey: true, altKey: true, code: "KeyP" }), t5.ctx) && t5.calls.join() === "closeAllPanes", "Mod+Alt+P → close all panes");
  const t6 = recorderCtx();
  assert(dispatchWindowKey(mk({ altKey: true, code: "KeyP" }), t6.ctx) && t6.calls.join() === "closeActivePane", "Alt+P (no mod) → close active pane");
  // Principal-agent scheme (2026-07-19): the ⌘K chord moved to the SHELL
  // (Workspace routes it back via commandBus.paperPaletteRequest) — a table row
  // too would double-fire and net to a no-op. The table must NOT own it.
  const t7 = recorderCtx();
  assert(!dispatchWindowKey(mk({ metaKey: true, code: "KeyK" }), t7.ctx) && t7.calls.length === 0, "Mod+K is NOT table-owned (the shell owns it; commandBus routes)");
  const t8 = recorderCtx();
  assert(!dispatchWindowKey(mk({ code: "KeyT" }), t8.ctx), "bare T dispatches nothing");
  const t9 = recorderCtx();
  assert(
    !dispatchWindowKey(mk({ altKey: true, code: "KeyD" }), t9.ctx) && t9.calls.length === 0,
    "Alt+D is NOT window-owned (the Personal dictionary owns it in CodeMirror)",
  );
  assert(matchesChord(mk({ metaKey: true, shiftKey: true, code: "KeyE" }), "Mod+Shift+KeyE"), "matchesChord: meta counts as Mod");

  // palette hint derivation for window rows
  const { ctx } = recorderCtx();
  const palette = paletteFromTable(ctx);
  const term = palette.find((p) => p.id === "margin-terminal");
  assert(term?.hint === "Alt+T · ⌘`", `terminal palette hint advertises BOTH chords (${term?.hint})`);
  assert(chordHint("Mod+Shift+KeyE") === "⌘⇧E", "chordHint ⌘⇧E");
  const vt = palette.find((p) => p.id === "view-toggle");
  assert(vt?.hint === "⌘⇧E", "view-toggle hint derived from its chord");
  assert(CM_HINTS.personalDictionary === "Alt+D", "Linux Personal dictionary hint is Alt+D");
  assert(CM_HINTS.projectDictionary === "Shift+Alt+D", "Linux project dictionary hint is Shift+Alt+D");
  assert(CM_HINTS.wordTools === "Shift+Alt+W", "Linux Word tools hint is Shift+Alt+W");
}

console.log(failures ? `\nPAPER COMMANDS: FAIL (${failures})` : "\nPAPER COMMANDS: PASS");
process.exit(failures ? 1 : 0);
