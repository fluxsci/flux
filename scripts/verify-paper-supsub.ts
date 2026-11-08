#!/usr/bin/env -S npx tsx
// 2026-11-08 — superscript `^…^` / subscript `~…~` everywhere. ONE grammar
// (science/supSubGrammar.ts) must agree with:
//   (a) the editor's parser — @lezer/markdown Superscript/Subscript, the exact
//       extension list markdown-setup.ts installs;
//   (b) Pandoc itself — the expected HTML below is Pandoc 3's own output for each
//       line (the Word/PDF exports go through Pandoc, so this IS the export);
//   (c) the markdown-it Preview/house-HTML rule (renderManuscript's pipeline);
//   (d) widget captions / table cells (mdInline) as real <sup>/<sub> nodes;
//   (e) spelling + automatic corrections never judging a sup/sub word;
//   (f) the Ctrl+. / Ctrl+, wrap commands (wrap, unwrap, escaped spaces,
//       strikethrough left alone) and their keymap/chord-table entries.
//   node scripts/run-verifies.mjs --tier pure --only paper-supsub

import "./lib/cssStub.mjs";
import { parseHTML } from "linkedom";
import { EditorState } from "@codemirror/state";
import { GFM, Superscript, Subscript, parser as baseParser } from "@lezer/markdown";
import MarkdownIt from "markdown-it";
import footnote from "markdown-it-footnote";
import {
  findSupSub,
  supSubWordRanges,
  markdownItSupSub,
  unescapeSupSub,
} from "../src/shell/modes/paper/science/supSubGrammar";
import { PAPER_MARKDOWN_EXTENSIONS } from "../src/shell/modes/paper/markdownExtensions";
import { protectedMarkdownRanges } from "../src/shell/modes/paper/editing/localCorrectionCore";
import { normalizeSpellingCandidates } from "../src/shell/modes/paper/editing/localSpelling";
import { toggleScript } from "../src/shell/modes/paper/editing/commands";
import { CM_CHORD_STRINGS, FORMATTING_BINDINGS } from "../src/shell/modes/paper/editing/keymap";

let failures = 0;
const ok = (m: string) => console.log("  ok:", m);
const fail = (m: string) => {
  console.error("  ✗ FAIL:", m);
  failures++;
};
const assert = (c: unknown, m: string) => (c ? ok(m) : fail(m));
const eq = (a: unknown, b: unknown, m: string) =>
  JSON.stringify(a) === JSON.stringify(b) ? ok(m) : fail(`${m}\n      expected ${JSON.stringify(b)}\n      got      ${JSON.stringify(a)}`);

// ---- the corpus: Pandoc 3 `-f markdown -t html` output, <p> stripped, <del>→<s> --
const CORPUS: Array<[string, string]> = [
  ["CO~2~ and H~2~O", "CO<sub>2</sub> and H<sub>2</sub>O"],
  ["Ca^2+^ ions", "Ca<sup>2+</sup> ions"],
  ["10^-3^ s", "10<sup>-3</sup> s"],
  ["~~strike~~ text", "<s>strike</s> text"],
  ["~5 min and ~10 min", "~5 min and ~10 min"],
  ["a^b c^ d", "a^b c^ d"],
  ["x^a\\ b^ y", "x<sup>a b</sup> y"],
  ["x^^y^^", "x^<sup>y</sup>^"],
  ["~/data/~x", "<sub>/data/</sub>x"],
  ["E = mc^2^.", "E = mc<sup>2</sup>."],
  ["*a^2^*", "<em>a<sup>2</sup></em>"],
  ["H~2~O^+^", "H<sub>2</sub>O<sup>+</sup>"],
  ["a~b~c", "a<sub>b</sub>c"],
  ["2^10^", "2<sup>10</sup>"],
  ["x^ ^", "x^ ^"],
  ["R^2^=0.9", "R<sup>2</sup>=0.9"],
  ["µm^2^", "µm<sup>2</sup>"],
];

// ---- (a) the editor's Lezer parse agrees with the grammar ----------------------------
{
  const lezer = baseParser.configure(PAPER_MARKDOWN_EXTENSIONS);
  const names = new Set<string>();
  for (const ext of PAPER_MARKDOWN_EXTENSIONS.flat(Infinity as 1)) for (const n of (ext as { defineNodes?: Array<{ name: string } | string> }).defineNodes ?? []) names.add(typeof n === "string" ? n : n.name);
  assert(names.has("Superscript") && names.has("Subscript") && names.has("Strikethrough") && names.has("Table"), "markdown-setup installs GFM + Superscript + Subscript");
  void GFM; void Superscript; void Subscript;
  for (const [src] of CORPUS) {
    const spans: Array<[string, number, number]> = [];
    lezer.parse(src).iterate({
      enter: (n) => {
        if (n.name === "Superscript" || n.name === "Subscript") spans.push([n.name === "Superscript" ? "sup" : "sub", n.from, n.to]);
      },
    });
    eq(spans, findSupSub(src).map((s) => [s.kind, s.from, s.to]), `Lezer ≡ grammar: ${JSON.stringify(src)}`);
  }
  // Footnotes are never superscripts, in either parser.
  for (const src of ["note[^1] here", "inline^[a note] here"]) {
    let any = false;
    lezer.parse(src).iterate({ enter: (n) => { if (n.name === "Superscript") any = true; } });
    assert(!any && findSupSub(src).length === 0, `footnote is not a superscript: ${src}`);
  }
}

// ---- (b)+(c) markdown-it (the Preview / house HTML pipeline) prints what Pandoc prints --
{
  const md = new MarkdownIt({ html: false, linkify: true, typographer: true });
  md.use(footnote);
  md.use(markdownItSupSub);
  md.disable("replacements");
  for (const [src, pandoc] of CORPUS) {
    eq(md.renderInline(src).replace(/&quot;/g, '"'), pandoc, `markdown-it ≡ Pandoc: ${JSON.stringify(src)}`);
  }
  const fn = md.render("note[^1] here and inline^[a note] there.\n\n[^1]: The note.\n");
  assert(!/<sup>(?!<a)/.test(fn.replace(/<sup class="footnote-ref">/g, "")), "footnote refs stay footnotes (no bare <sup> from the sup rule)");
  assert(md.render("A table cell:\n\n| ion | x |\n|---|---|\n| Ca^2+^ | CO~2~ |\n").includes("<td>Ca<sup>2+</sup></td>"), "table cells render sup/sub");
  eq(unescapeSupSub("a\\ b\\^c"), "a b^c", "escaped space prints as Pandoc's non-breaking space");
}

// ---- (d) mdInline: widget captions / table cells get real nodes ----------------------
{
  const { document } = parseHTML("<!doctype html><html><body></body></html>");
  (globalThis as unknown as { document: Document }).document = document as unknown as Document;
  const { mdInlineFragment } = await import("../src/shell/modes/paper/science/mdInline");
  const host = document.createElement("div");
  host.appendChild(mdInlineFragment("Uptake of Ca^2+^ under CO~2~, **bold H~2~O**, ~~gone~~ and ~5 min.") as unknown as Node);
  eq(host.innerHTML, "Uptake of Ca<sup>2+</sup> under CO<sub>2</sub>, <strong>bold H<sub>2</sub>O</strong>, ~~gone~~ and ~5 min.", "mdInline: <sup>/<sub> nodes, nested in bold, strike + approx-tilde untouched");
  const h2 = document.createElement("div");
  h2.appendChild(mdInlineFragment("x\\^y\\~ and 10^-3^ s") as unknown as Node);
  eq(h2.innerHTML, "x^y~ and 10<sup>-3</sup> s", "mdInline: escaped markers stay literal");
}

// ---- (e) spelling / corrections skip sup/sub words ------------------------------------
{
  const line = "Uptake of Ca^2+^ and CO~2~ rose in H~2~O within 10^-3^ s.";
  eq(supSubWordRanges(line).map(([a, b]) => line.slice(a, b)), ["Ca^2+^", "CO~2~", "H~2~O", "10^-3^"], "sup/sub ranges widen over their attached word");
  const prot = protectedMarkdownRanges(line);
  for (const w of ["Ca", "CO", "H", "O", "2+"]) {
    const at = w === "O" ? line.indexOf("O within") : line.indexOf(w);
    assert(prot.some(([a, b]) => at < b && at + w.length > a), `protectedMarkdownRanges covers "${w}"`);
  }
  const fake = (problem: string, from: number) => ({ from, to: from + problem.length, problem, kind: "Spelling", suggestions: ["Cat"], message: "" });
  const cands = normalizeSpellingCandidates(line, [fake("Ca", line.indexOf("Ca")), fake("Uptake", 0)] as never);
  eq(cands.map((c) => c.original), ["Uptake"], "a spelling verdict on `Ca` in `Ca^2+^` is dropped; plain words still judged");
  const unit = "Rose within 10^-3^ s, and 10 ms later the s key.";
  const unitCands = normalizeSpellingCandidates(unit, [fake("s", unit.indexOf("s,")), fake("ms", unit.indexOf("ms")), fake("s", unit.lastIndexOf(" s ") + 1)] as never);
  eq(unitCands.map((c) => [c.original, c.from]), [["s", unit.lastIndexOf(" s ") + 1]], "a unit right after a quantity (`10^-3^ s`, `10 ms`) is notation; a stray `s` elsewhere is still judged");
}

// ---- (f) Ctrl+. / Ctrl+, wrap and unwrap ------------------------------------------------
{
  const run = (doc: string, from: number, to: number, mark: "^" | "~") => {
    let state = EditorState.create({ doc, selection: { anchor: from, head: to } });
    const view = { get state() { return state; }, dispatch(spec: Parameters<EditorState["update"]>[0]) { state = state.update(spec).state; }, focus() {} };
    toggleScript(mark)(view as never);
    const r = state.selection.main;
    return { doc: state.doc.toString(), sel: state.sliceDoc(r.from, r.to), caret: r.head };
  };
  eq(run("CO2 gas", 2, 3, "~"), { doc: "CO~2~ gas", sel: "2", caret: 4 }, "Ctrl+, wraps the selection in ~…~ (selection kept)");
  eq(run("CO~2~ gas", 3, 4, "~"), { doc: "CO2 gas", sel: "2", caret: 3 }, "Ctrl+, again unwraps it");
  eq(run("Ca2+ ions", 2, 4, "^"), { doc: "Ca^2+^ ions", sel: "2+", caret: 5 }, "Ctrl+. wraps in ^…^");
  eq(run("Ca^2+^ ions", 2, 6, "^"), { doc: "Ca2+ ions", sel: "2+", caret: 4 }, "Ctrl+. on a selection INCLUDING the markers unwraps");
  eq(run("Ca^2+^ ions", 4, 4, "^"), { doc: "Ca2+ ions", sel: "", caret: 3 }, "Ctrl+. with the caret inside a superscript removes it");
  eq(run("x 10 ms y", 2, 7, "^"), { doc: "x ^10\\ ms^ y", sel: "10\\ ms", caret: 9 }, "a space is escaped on the way in (Pandoc allows none)");
  eq(run("x ^10\\ ms^ y", 3, 9, "^"), { doc: "x 10 ms y", sel: "10 ms", caret: 7 }, "…and unescaped on the way out");
  eq(run("a ~~gone~~ b", 4, 8, "~"), { doc: "a ~~~gone~~~ b", sel: "gone", caret: 9 }, "strikethrough is not mistaken for a subscript");
  eq(run("H2O", 1, 1, "~"), { doc: "H~~2O", sel: "", caret: 2 }, "empty selection: caret lands between the markers");
  const binds = FORMATTING_BINDINGS.map((b) => b.key);
  assert(binds.includes("Mod-.") && binds.includes("Mod-,"), "formatting keymap binds Mod-. and Mod-,");
  assert(FORMATTING_BINDINGS.filter((b) => b.key === "Mod-." || b.key === "Mod-,").every((b) => !("mac" in b) && !("linux" in b) && !("win" in b)),
    "the chords have no platform-only entries (Windows reads them too)");
  assert(CM_CHORD_STRINGS.includes("Mod-." as never) && CM_CHORD_STRINGS.includes("Mod-," as never), "CM_CHORD_STRINGS lists both (the window dispatcher never claims them)");
}

console.log(failures ? `\nPAPER-SUPSUB: FAIL (${failures})` : "\nPAPER-SUPSUB: PASS");
process.exit(failures ? 1 : 0);
