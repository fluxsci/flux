// Pure gate for the glyph-matched text morph's core (src/lib/slide/textMatch.ts):
// the tokenizer, the five-pass matcher (incl. the owner's two Deck-3 examples),
// the closeness policy and its pinned thresholds, the morph plan (line cuts,
// fade units, glue, caps) and the timeline shape. No DOM.
import { harness } from "./lib/harness.mjs";
import {
  tokenize, matchTokens, charLevelAllowed, planTextMorph, textMorphTimeline, windowProgress, fadeLook, crossArc,
  TEXT_MATCH_POLICY, TEXT_MORPH_CAPS, TEXT_MORPH_TIMING, type TextRange,
} from "../src/lib/slide/textMatch";
import { contentPlan } from "../src/lib/slide/tween";
import type { TextElement } from "../src/lib/types";

const h = harness("verify-text-match");
const slice = (s: string, r: TextRange) => s.slice(r.from, r.to);
const runsOf = (a: string, b: string, m = matchTokens(a, b)) => m.runs.map((r) => `${r.kind}:${slice(a, r.a)}→${slice(b, r.b)}`);
const line = (s: string): TextRange[] => [{ from: 0, to: s.length }];

// --- tokenizer --------------------------------------------------------------
const toks = tokenize("It's 1,200.5 km—Light. café");
h.eq(toks.map((t) => `${t.kind}:${t.text}`).join("|"), "word:It's|space: |word:1,200.5|space: |word:km|punct:—|word:Light|punct:.|space: |word:café",
  "tokenize: words keep inner apostrophes, numbers keep separators, punctuation is its own token");
h.ok(toks.every((t, i) => i === 0 || t.start === toks[i - 1].end), "tokenize: tokens tile the text exactly");

// --- the policy -------------------------------------------------------------
h.eq(JSON.stringify(TEXT_MATCH_POLICY), JSON.stringify({ charRatio: 0.4, charMaxLength: 60, minCharBlock: 2 }), "policy thresholds are pinned (never tune silently)");
h.eq(JSON.stringify(TEXT_MORPH_CAPS), JSON.stringify({ maxSpans: 48, maxChars: 200 }), "span caps are pinned");
h.ok(charLevelAllowed("Microscope", "Microscopy").allowed && charLevelAllowed("Microscope", "Microscopy").ratio > 0.85, "char level: a shared stem is close");
h.ok(!charLevelAllowed("Microscopy", "Optics and Light").allowed && charLevelAllowed("Microscopy", "Optics and Light").ratio < 0.4, "char level: Microscopy vs Optics and Light is refused by ratio");
h.ok(!charLevelAllowed("a".repeat(61), "a".repeat(61)).allowed, "char level: strings over 60 chars are refused");
h.ok(!charLevelAllowed("ab", "ba").allowed, "char level: single shared letters never count (min block 2)");

// --- the owner's two examples (Deck 3, slide 4) -------------------------------
{
  const m = matchTokens("Microscopy", "Optics and Light");
  h.eq(m.runs.length, 0, "owner Become: Microscopy → Optics and Light shares no word and no close stem");
  h.eq(m.charLevel, "refused", "owner Become: the char level was considered and refused");
  h.eq(m.exits.map((r) => slice("Microscopy", r)).join("|"), "Microscopy", "owner Become: the old word exits");
  h.eq(m.enters.map((r) => slice("Optics and Light", r)).join("|"), "Optics|and|Light", "owner Become: the new words enter");
  const plan = planTextMorph("Microscopy", "Optics and Light", { aLines: line("Microscopy"), bLines: line("Optics and Light") });
  h.eq(plan.fadeUnit, "letter", "owner Become: the fades are a letter wave (24 letters fit the cap)");
  h.eq(plan.spans.filter((s) => s.kind === "exit").length, 10, "owner Become: ten exiting letters");
  h.eq(plan.spans.filter((s) => s.kind === "enter").length, 14, "owner Become: fourteen entering letters (spaces draw nothing)");
}
{
  const a = "Some text to change", b = "Subtextual Context";
  const m = matchTokens(a, b);
  h.eq(m.runs.length, 1, "owner Change: exactly one shared run");
  h.eq(runsOf(a, b, m).join(","), "char:text→text", "owner Change: the word 'text' glides into the 'text' of Context (the closest stem)");
  h.eq(slice(b, m.runs[0].b), "text", "owner Change: the landing range is a real 'text' in the new string");
  h.ok(m.runs[0].b.from === b.indexOf("Context") + 3, "owner Change: it lands at Con|text, the higher-ratio match (8/11 over 8/14)");
}

// --- the matcher's passes ---------------------------------------------------------
h.eq(runsOf("Learning rate 0.1", "Learning rate 0.01").join(","), "exact:Learning rate→Learning rate,count:0.1→0.01", "glide + countUp: the shared words are one run, the number counts");
h.eq(runsOf("The quick brown fox", "The brown fox quickly").join(","), "exact:The→The,char:quick→quick,exact:brown fox→brown fox", "reorder: brown fox glides left, quick glides to the end and becomes quick|ly");
h.eq(runsOf("Alpha beta gamma", "Gamma beta alpha").join(","), "fold:Alpha→alpha,exact:beta→beta,fold:gamma→Gamma", "reorder by content: all three words glide (case folded)");
h.eq(runsOf("Light.", "light").join(","), "fold:Light→light", "attached punctuation does not block a match");
h.eq(runsOf("café au lait", "Cafe au lait!").join(","), "fold:café→Cafe,exact:au lait→au lait", "accent-insensitive fold pass");
h.eq(matchTokens("one, two", "two, one").runs.filter((r) => r.kind === "exact" && slice("one, two", r.a) === ",").length <= 1, true, "punctuation never reorders on its own");
h.eq(runsOf("hello", "hello").join(","), "exact:hello→hello", "identity is one exact run");
{
  const m = matchTokens("", "Hello world");
  h.ok(!m.runs.length && m.enters.length === 2 && !m.exits.length, "empty source: everything enters");
}

// --- the plan ----------------------------------------------------------------------
{
  const a = "The quick brown fox", b = "The brown fox quickly";
  // b wrapped after "fox": a run crossing a line on EITHER side is cut there.
  const plan = planTextMorph("alpha beta gamma", "alpha beta gamma", { aLines: line("alpha beta gamma"), bLines: [{ from: 0, to: 10 }, { from: 11, to: 16 }] });
  h.eq(plan.spans.map((s) => `${s.kind}:${slice("alpha beta gamma", s.a!)}`).join("|"), "glide:alpha beta|glide:gamma", "a run is cut at the destination's line break");
  const p2 = planTextMorph(a, b, { aLines: line(a), bLines: line(b) });
  const ly = p2.spans.find((s) => s.kind === "enter")!;
  h.eq(slice(b, ly.b!), "l", "letters: the entering suffix is a letter wave");
  h.ok(ly.with !== undefined && p2.spans[ly.with].kind === "glide" && slice(b, p2.spans[ly.with].b!) === "quick", "glue: the entering 'ly' rides with the 'quick' glide (same word)");
  const glides = p2.spans.filter((s) => s.kind === "glide");
  h.ok(glides.every((s, i) => s.order === i) && glides.map((s) => s.b!.from).every((v, i, arr) => !i || arr[i - 1] < v), "glides are ranked in the destination's reading order");
}
{
  // Segment cuts (style runs) split a run so every clone paints in one look.
  const plan = planTextMorph("make it bold now", "make it bold now", { aLines: line("make it bold now"), bLines: line("make it bold now"), bCuts: [8, 12] });
  h.eq(plan.spans.map((s) => slice("make it bold now", s.b!)).join("|"), "make it|bold|now", "style segment boundaries cut runs");
}
{
  const words = Array.from({ length: 40 }, (_, i) => `w${i}`);
  const a = words.join(" "), b = words.map((w) => w + "x").reverse().join(" ");
  const plan = planTextMorph(a, b, { aLines: line(a), bLines: line(b) });
  h.ok(plan.spans.length <= TEXT_MORPH_CAPS.maxSpans, `caps: a 40-word rewrite stays within ${TEXT_MORPH_CAPS.maxSpans} spans (got ${plan.spans.length}, level ${plan.level})`);
  h.eq(plan.fadeUnit, "word", "caps: too many letters fade as words/lines, never letters");
  const long = "x".repeat(150) + " " + "y".repeat(80);
  const lp = planTextMorph(long, long.toUpperCase(), { aLines: [{ from: 0, to: 150 }, { from: 151, to: 231 }], bLines: [{ from: 0, to: 150 }, { from: 151, to: 231 }] });
  h.eq(lp.level, "line", "caps: beyond 200 characters the morph is line-level");
}

// --- the timeline ------------------------------------------------------------------
{
  const tl = textMorphTimeline(3, 4, 1750);
  h.ok(tl.glide.start === 0 && tl.glide.end === 1, "timeline: glides span the whole duration");
  h.ok(Math.max(...tl.exits.map((w) => w.end)) <= TEXT_MORPH_TIMING.word.exitEnd + 1e-9, "timeline: word exits are done by 55 %");
  h.ok(Math.abs(Math.max(...tl.enters.map((w) => w.end)) - 1) < 1e-9 && Math.min(...tl.enters.map((w) => w.start)) >= 0.4 - 1e-9, "timeline: word enters run 40 % → 100 %");
  h.ok(tl.exits[2].start <= 0.12 + 1e-9 && tl.enters[3].start - tl.enters[0].start <= 0.15 + 1e-9, "timeline: word stagger ≤ 12 % / ≤ 15 % in total");
  h.ok(tl.exits.every((w, i) => !i || w.start > tl.exits[i - 1].start), "timeline: stagger follows reading order");
  const short = textMorphTimeline(30, 30, 600, "letter");
  h.ok(short.exits[1].start - short.exits[0].start <= TEXT_MORPH_TIMING.stepMs / 600 + 1e-9 && short.exits[29].start <= TEXT_MORPH_TIMING.letter.exitStagger + 1e-9, "timeline: a letter wave is bounded by 25 % and 45 ms a step");
  h.ok(Math.max(...short.exits.map((w) => w.end)) <= 0.55 + 1e-9 && Math.abs(Math.max(...short.enters.map((w) => w.end)) - 1) < 1e-9, "timeline: the letter wave keeps the 55 % / 100 % ends");
  const overlap = Math.max(...tl.exits.map((w) => w.end)) - Math.min(...tl.enters.map((w) => w.start));
  h.ok(overlap > 0, "timeline: exits and enters overlap, so the text never looks empty");
  h.ok(Math.abs(windowProgress({ start: 0.2, end: 0.6 }, 0.4) - 0.5) < 1e-12, "windowProgress is linear in its window");
  h.ok(windowProgress({ start: 0.2, end: 0.6 }, -1) === 0 && windowProgress({ start: 0.2, end: 0.6 }, 2) === 1, "windowProgress clamps (opacity never overshoots)");
  const e0 = fadeLook("exit", 0), e1 = fadeLook("exit", 1), n0 = fadeLook("enter", 0), n1 = fadeLook("enter", 1);
  h.ok(e0.opacity === 1 && e0.dy === 0 && e0.scale === 1 && e1.opacity === 0 && Math.abs(e1.dy - 0.06) < 1e-12 && Math.abs(e1.scale - 0.92) < 1e-12, "fadeLook: exits drift 6 % of the font size down and shrink to 0.92");
  h.ok(n0.opacity === 0 && Math.abs(n0.dy - 0.08) < 1e-12 && Math.abs(n0.scale - 0.96) < 1e-12 && n1.opacity === 1 && n1.dy === 0 && n1.scale === 1, "fadeLook: enters rise from +8 % and grow from 0.96");
  h.ok(crossArc(200, 0, 20, 0) === 0 && crossArc(200, 0, 20, 1) === 0 && crossArc(200, 0, 20, 0.5) < 0 && crossArc(-200, 0, 20, 0.5) > 0, "crossArc: rightward movers lift, leftward dip, zero at both ends");
  h.ok(crossArc(10, 0, 20, 0.5) === 0 && crossArc(100, 300, 20, 0.5) === 0 && Math.abs(crossArc(1000, 0, 20, 0.5)) <= 0.3 * 20 + 1e-9, "crossArc: none for short or vertical moves; bounded by 0.3 em");
}

// --- tween routing ------------------------------------------------------------------
{
  const t = (text: string): TextElement => ({ id: "t", type: "text", x: 0, y: 0, width: 100, height: 20, rotation: 0, text, fontFamily: "Arial", fontSize: 16, fontWeight: 400, fontStyle: "normal", align: "left", color: "#000000", sizing: "auto" });
  h.eq(contentPlan(t("hello"), t("world")).mode, "textMorph", "contentPlan: a text rewrite is the text morph (never the flat crossfade)");
  h.eq(contentPlan(t("Revenue 10"), t("Revenue 20")).mode, "tween", "contentPlan: a pure digit change keeps the in-place count-up");
  h.eq(contentPlan(t("hello"), { ...t("hello"), fontSize: 30 }).mode, "tween", "contentPlan: a style-only change keeps the in-place tween");
}

await h.done();
