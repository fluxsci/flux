// The keyboard reference (press ?) is drawn from src/lib/help/shortcuts.ts. This gate pins that
// data as a contract, because a reference that is wrong is worse than none and nothing else
// would notice a row that cannot be drawn or found. Run via run-verifies.
//
//   1. Shape: one section per title-bar mode plus Global, in the strip's order; no empty group,
//      no row listed twice in a group, every description a real sentence fragment.
//   2. Notation: every key string reads into pieces; a chord's keys are caps and its gestures
//      are words; no platform glyph (⌘ ⌃ ⌥ ⇧) or stray "Ctrl+"/"Cmd" is written by hand (Mod and
//      Ctrl are the two spellings, and the platform decides how each is drawn).
//   3. Platform: the same row draws Ctrl / Alt / Shift on Windows and Linux and ⌘ / ⌥ / ⇧ on
//      macOS; a `mac` override replaces the chord there.
//   4. Compact drawing: three or more alternatives under the same modifiers are drawn once
//      (Alt A / W / S / D), while search and screen readers still get every chord spelled out.
//   5. Search: words, chords as typed ("alt+t", "ctrl shift m", "cmd k"), all words required,
//      nothing for nonsense; matches are marked without touching the text.
//   6. The chords this app reserves are listed where a user would look for them.
import { harness } from "./lib/harness.mjs";
import { SECTIONS, keyPieces, keyText, markRuns, queryTerms, searchShortcuts, shortcutCount, type ShortcutRow } from "../src/lib/help/shortcuts";
import { MODE_ORDER, MODE_LABEL } from "../src/shell/modeOrder";

const h = harness("verify-help-shortcuts");
const rows: { section: string; group: string; row: ShortcutRow }[] = SECTIONS.flatMap((s) => s.groups.flatMap((g) => g.rows.map((row) => ({ section: s.label, group: g.title, row }))));
const where = (r: { section: string; group: string; row: ShortcutRow }) => `${r.section} › ${r.group} › "${r.row.keys}"`;

// ---- 1: shape ---------------------------------------------------------------------------------
h.section("shape");
h.eq(SECTIONS.map((s) => s.id), ["global", ...MODE_ORDER], "sections are Global, then the modes in the title bar's order");
h.eq(SECTIONS.slice(1).map((s) => s.label), MODE_ORDER.map((m) => MODE_LABEL[m]), "each mode's section carries the mode's own name");
h.ok(SECTIONS.every((s) => s.groups.length > 0 && s.groups.every((g) => g.rows.length > 0)), "no empty section or group");
h.ok(shortcutCount() === rows.length && rows.length >= 200, `the reference holds ${rows.length} rows (≥ 200)`);
const doubled = SECTIONS.flatMap((s) => s.groups.flatMap((g) => {
  const seen = new Set<string>();
  return g.rows.filter((row) => (seen.has(row.keys) ? true : (seen.add(row.keys), false))).map((row) => `${s.label} › ${g.title} › ${row.keys}`);
}));
h.ok(doubled.length === 0, "no key string is listed twice in one group", doubled.join("; "));
const thin = rows.filter((r) => r.row.does.trim().length < 3 || /\s$|^\s|\.$/.test(r.row.does) || /[a-z]/.test(r.row.does[0]));
h.ok(thin.length === 0, "every description starts with a capital, has no trailing full stop and says something", thin.map(where).join("; "));
const groupTitles = SECTIONS.map((s) => s.groups.map((g) => g.title));
h.ok(groupTitles.every((titles) => new Set(titles).size === titles.length), "group titles are unique within a section");
const modesListed = `(${MODE_ORDER.map((m) => MODE_LABEL[m]).join(", ")})`;
h.ok(rows.some((r) => r.row.does.includes(modesListed) && /Mod\+1 – Mod\+5/.test(r.row.keys)), `the mode chords row lists the modes in strip order ${modesListed}`);

// ---- 2: notation --------------------------------------------------------------------------------
h.section("notation");
const handGlyphs = rows.filter((r) => /[⌘⌃⌥⇧]|\bCmd\b|\bOption\b|\bCommand\b/.test(`${r.row.keys} ${r.row.mac ?? ""}`));
h.ok(handGlyphs.length === 0, "no platform glyph or Cmd/Option is written by hand in a key string", handGlyphs.map(where).join("; "));
const namedInProse = rows.filter((r) => /\bMod\b/.test(r.row.does));
h.ok(namedInProse.length === 0, "no description says “Mod” (it is not a key anyone has)", namedInProse.map(where).join("; "));
const GESTURE = /^(?:double-|middle-)?(?:click|drag|wheel|type|select|every|hold)\b/;
const unreadable: string[] = [];
for (const r of rows) {
  for (const mac of [false, true]) {
    const pieces = keyPieces(r.row, mac);
    if (!pieces.length || pieces[0].kind === "sep" || pieces.at(-1)!.kind === "sep") unreadable.push(`${where(r)}: starts or ends on a separator`);
    for (const [i, piece] of pieces.entries()) {
      if (!piece.text.trim()) unreadable.push(`${where(r)}: empty piece`);
      if (piece.kind === "sep" && pieces[i + 1]?.kind === "sep") unreadable.push(`${where(r)}: two separators in a row`);
      if (piece.kind === "words" && !GESTURE.test(piece.text)) unreadable.push(`${where(r)}: “${piece.text}” is neither a key nor a gesture`);
      if (piece.kind === "key" && /\s/.test(piece.text)) unreadable.push(`${where(r)}: key cap “${piece.text}” has a space`);
      if (piece.kind === "key" && [...piece.text].length > 9) unreadable.push(`${where(r)}: key cap “${piece.text}” is too long to be a key`);
    }
  }
}
h.ok(unreadable.length === 0, "every key string reads into caps, gestures and separators on both platforms", unreadable.slice(0, 6).join("; "));

// ---- 3: platform ----------------------------------------------------------------------------
h.section("platform");
const chord = { keys: "Mod+Shift+M", does: "x" };
h.eq(keyPieces(chord, false).map((p) => p.text), ["Ctrl", "Shift", "M"], "Mod+Shift+M draws Ctrl Shift M on Windows and Linux");
h.eq(keyPieces(chord, true).map((p) => p.text), ["⌘", "⇧", "M"], "and ⌘ ⇧ M on macOS");
h.eq(keyPieces({ keys: "Ctrl+Tab", does: "x" }, true).map((p) => p.text), ["⌃", "Tab"], "a literal Ctrl is ⌃ on macOS, not ⌘");
h.eq(keyPieces({ keys: "Alt+Up / Alt+Down", does: "x" }, true).map((p) => p.text), ["⌥", "↑", "/", "⌥", "↓"], "arrows are drawn as arrows, Alt as ⌥");
const fold = rows.find((r) => r.row.mac);
h.ok(!!fold && keyText(fold.row, true) !== keyText(fold.row, false) && !/⇧/.test(keyText(fold.row, true)) === !/Shift/.test(fold.row.mac!), "a row with a macOS override draws that chord on macOS", fold ? `${keyText(fold.row, false)} | ${keyText(fold.row, true)}` : "none");
h.eq(keyPieces({ keys: "Mod+click a plot", does: "x" }, false), [{ kind: "key", text: "Ctrl" }, { kind: "words", text: "click a plot" }], "a gesture after a key is words, and its one-letter words are never caps");
h.eq(keyPieces({ keys: "Mod+1 – Mod+5", does: "x" }, false).map((p) => `${p.kind}:${p.text}`), ["key:Ctrl", "key:1", "sep:–", "key:Ctrl", "key:5"], "a run keeps both ends");
h.eq(keyPieces({ keys: "R / C / G · Plus / Minus", does: "x" }, false).map((p) => p.text), ["R", "/", "C", "/", "G", "·", "+", "/", "−"], "Plus and Minus are drawn as the keys they are");

// ---- 4: compact drawing ---------------------------------------------------------------------
h.section("compact drawing");
const four = { keys: "Alt+A / Alt+W / Alt+S / Alt+D", does: "x" };
h.eq(keyPieces(four, false).map((p) => p.text), ["Alt", "A", "/", "W", "/", "S", "/", "D"], "four alternatives under Alt draw the modifier once");
h.eq(keyText(four, false), "Alt+A / Alt+W / Alt+S / Alt+D", "the spelled form keeps every chord, for search and screen readers");
h.eq(keyPieces({ keys: "Alt+H / Alt+V", does: "x" }, false).map((p) => p.text), ["Alt", "H", "/", "Alt", "V"], "two alternatives stay spelled out");
h.eq(keyPieces({ keys: "Mod+X / Mod+C / Alt+V", does: "x" }, false).filter((p) => p.kind === "key").length, 6, "different modifiers are never merged");

// ---- 5: search ---------------------------------------------------------------------------------
h.section("search");
const found = (query: string, mac = false) => searchShortcuts(query, mac).map((hit) => `${hit.section.id}:${hit.row.keys}`);
h.ok(found("crystallize").includes("figure:Shift+A") && found("crystallize").every((id) => id.startsWith("figure:")), "a word finds its rows", found("crystallize").join(", "));
h.ok(found("alt+t").includes("figure:Alt+T"), "a chord typed as written finds its row");
h.ok(found("ALT+T").join() === found("alt+t").join(), "search ignores case");
h.ok(found("alt+w").includes("figure:Alt+A / Alt+W / Alt+S / Alt+D"), "a chord drawn without its repeated modifier is still found by its full spelling");
h.ok(found("ctrl+shift+m").includes("global:Mod+Shift+M") && found("ctrl shift m").includes("global:Mod+Shift+M"), "Mod is found as ctrl, with + or spaces");
h.ok(found("cmd+k", true).some((id) => id.endsWith(":Mod+K")) || found("cmd k").some((id) => id.endsWith(":Mod+K")), "and as cmd");
h.ok(found("inbox reply").length >= 1 && found("inbox reply").every((id) => id.startsWith("global:")), "every word must match (the group's name counts)", found("inbox reply").join(", "));
h.ok(found("zzzz").length === 0 && found("   ").length === 0 && found("").length === 0, "nonsense and an empty query find nothing");
const order = searchShortcuts("undo", false).map((hit) => SECTIONS.indexOf(hit.section));
h.ok(order.length >= 2 && order.every((at, i) => i === 0 || at >= order[i - 1]), "results keep the reference's reading order");
h.eq(markRuns("Send to back", queryTerms("back")), [{ text: "Send to ", hit: false }, { text: "back", hit: true }], "a match is marked in place");
h.eq(markRuns("Banana", ["an"]).map((r) => r.text).join(""), "Banana", "marking never changes the text");
h.eq(markRuns("Banana", ["ana", "nan"]).map((r) => (r.hit ? `[${r.text}]` : r.text)).join(""), "B[ana][n]a", "overlapping matches mark each letter once");
h.eq(markRuns("Banana", []), [{ text: "Banana", hit: false }], "no words, no marks");

// ---- 6: reserved chords are where a user looks ---------------------------------------------------
h.section("reserved chords");
const has = (section: string, keys: string) => rows.some((r) => r.section === section && r.row.keys.split(" / ").some((k) => k === keys));
for (const [section, keys] of [["Global", "?"], ["Global", "Alt+Q"], ["Global", "Mod+Shift+M"], ["Global", "Mod+Shift+J"], ["Global", "Mod+K"], ["Figure", "Shift+A"], ["Figure", "Alt+T"], ["Figure", "F"], ["Figure", "R"], ["Figure", "Alt+G"], ["Slide", "F5"], ["Paper", "Mod+Shift+E"], ["Paper", "Alt+E"], ["Reader", "Mod+F"], ["Library", "Alt+F"]] as const) {
  h.ok(has(section, keys), `${section} lists ${keys}`);
}

await h.done();
