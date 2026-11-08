// Pack "consistency": one term, one spelling.
//
//   consistency.variant     info  a term written more than one way — "data set" (3) and
//                                 "dataset" (11); "wild-type" and "wildtype"; colour/color,
//                                 analyse/analyze, modelling/modeling, haem-/hem-…
//   consistency.et-al       info  "et al" without its period
//
// Variants are GENERATED, not curated: open, hyphenated and closed compounds
// group by their letters ("data set" = "data-set" = "dataset"), British and
// American spellings by a normalisation (-ise/-ize, -yse/-yze, -our/-or, ae/oe→e) plus a
// short list of doubled-l forms — and a group is reported only when BOTH
// spellings occur in this document, so a lone "precise" or "four" is never
// compared with anything. Phrasal verbs whose spaced form is a different word
// ("follow up" the verb vs "follow-up" the noun, "set up"/"setup") are left
// alone, as are stop-word pairs ("in to"/"into", "may be"/"maybe").
//
// The fix "Use X everywhere" rewrites every minority occurrence to the
// majority spelling (keeping a sentence-initial capital) in one transaction —
// the explicit-choice surface local corrections deliberately refuse to
// automate (localCorrectionCore: compounds "require an explicit user choice").

import type { CheckContext } from "./context";
import { blankSpans } from "./context";
import type { CheckEdit, CheckFinding } from "./types";

type Add = (f: Omit<CheckFinding, "pack" | "doc" | "line" | "col">) => void;

const STOP = new Set(
  ("a an the in on to into onto at by of for from with without up down out over under off back " +
    "be is are was were been may can not no all any every some each one it its this that these those " +
    "there here what how who when where which so as or and but if then than very more most less").split(/\s+/),
);
/** Spaced forms that are a different word class from the joined form. */
const PHRASAL = new Set(
  ("followup setup backup checkout login logout workout breakdown takeoff carryover cutoff markup " +
    "startup shutdown rollout lookup signup pickup readout turnover layout knockout knockdown pulldown " +
    "spinoff cleanup warmup buildup payoff tradeoff setback dropout washout blowout runoff giveaway " +
    "handout printout feedback walkthrough").split(/\s+/),
);
const DOUBLED_L: [string, string][] = [
  "modelling modeling", "modelled modeled", "labelling labeling", "labelled labeled", "travelling traveling",
  "travelled traveled", "signalling signaling", "signalled signaled", "cancelled canceled", "cancelling canceling",
  "fuelled fueled", "levelled leveled", "channelled channeled", "counselling counseling", "tunnelling tunneling",
  "totalled totaled", "centre center", "centres centers", "fibre fiber", "fibres fibers", "litre liter",
  "litres liters", "millilitre milliliter", "millilitres milliliters", "grey gray", "programme program",
].map((p) => p.split(" ") as [string, string]);
const DOUBLED_KEY = new Map<string, string>();
for (const [uk, us] of DOUBLED_L) {
  DOUBLED_KEY.set(uk, us);
  DOUBLED_KEY.set(us, us);
}

/** British/American key: the spelling a both-forms document would merge to. */
function dialectKey(w: string): string | null {
  const d = DOUBLED_KEY.get(w);
  if (d) return d;
  let m = /^(.{3,})(is|iz|ys|yz)(e|ed|es|ing|ation|ations|er|ers)$/.exec(w);
  if (m) return `${m[1]}${m[2][0]}z${m[3]}`;
  m = /^(.{3,})(our|or)(s|ed|ing|ful|ite|ites|al)?$/.exec(w);
  if (m && w.length >= 5) return `${m[1]}or${m[3] ?? ""}`;
  if (w.length >= 7 && /ae|oe/.test(w)) return w.replace(/ae|oe/g, "e");
  return null;
}

interface Occ {
  from: number;
  to: number;
  surface: string;
}

function recase(original: string, replacement: string): string | null {
  if (original === original.toLowerCase()) return replacement;
  if (original[0] === original[0].toUpperCase() && original.slice(1) === original.slice(1).toLowerCase())
    return replacement[0].toUpperCase() + replacement.slice(1);
  return null; // mixed / all-caps: leave it to the author
}

function consistencyText(ctx: CheckContext): string {
  const spans: { from: number; to: number }[] = [];
  const add = (re: RegExp) => {
    for (const m of ctx.prose.matchAll(re)) spans.push({ from: m.index!, to: m.index! + m[0].length });
  };
  add(/\[[^\]\n]*@[^\]\n]*\]/g);
  add(/@[A-Za-z][\w:.-]*/g);
  add(/\]\([^)\n]*\)/g);
  add(/\{[^}\n]*\}/g);
  add(/https?:\/\/\S+/g);
  add(/<[^>\n]+>/g);
  add(/"[^"\n]*"|“[^”\n]*”/g); // quoted text is someone else's spelling
  spans.sort((a, b) => a.from - b.from);
  return blankSpans(ctx.prose, spans);
}

export function consistencyPack(ctx: CheckContext, add: Add): void {
  const src = consistencyText(ctx);
  const { text } = ctx;
  const WORD = /[A-Za-z]+(?:-[A-Za-z]+)?/g; // ASCII words: case folding never moves an offset

  // Pass 1 — ONE scan: every word lowercased once, with its place; the
  // distinct vocabulary and hyphenated compounds. Later passes walk arrays.
  const lows: string[] = [];
  const starts: number[] = [];
  const vocab = new Set<string>();
  const hyphenKeys = new Set<string>();
  {
    // Lowercase the whole text once when that keeps every offset (it does
    // unless a character like "İ" changes length); else per word.
    const whole = src.toLowerCase();
    const lower = whole.length === src.length ? whole : null;
    let m: RegExpExecArray | null;
    WORD.lastIndex = 0;
    while ((m = WORD.exec(lower ?? src))) {
      const lw = lower ? m[0] : m[0].toLowerCase();
      lows.push(lw);
      starts.push(m.index);
      if (vocab.has(lw)) continue;
      vocab.add(lw);
      const dash = lw.indexOf("-");
      if (dash > 0) hyphenKeys.add(lw.slice(0, dash) + lw.slice(dash + 1));
    }
  }
  const n = lows.length;
  /** Word i and i+1 are adjacent, joined by exactly one space, neither hyphenated. */
  const adjacent = (i: number) =>
    i + 1 < n && starts[i + 1] === starts[i] + lows[i].length + 1 && src.charCodeAt(starts[i] + lows[i].length) === 32 &&
    !lows[i].includes("-") && !lows[i + 1].includes("-");
  // Pass 1b — adjacent pairs whose letters spell a word or compound seen here.
  const pairs = new Set<string>();
  for (let i = 0; i + 1 < n; i++) {
    const a = lows[i], b = lows[i + 1];
    if (a.length < 2 || b.length < 2 || STOP.has(a) || STOP.has(b) || !adjacent(i)) continue;
    const key = a + b;
    if ((vocab.has(key) || hyphenKeys.has(key)) && !PHRASAL.has(key)) pairs.add(key);
  }
  // Candidate groups: a key with two or more spellings present.
  const formsOf = new Map<string, Set<string>>(); // group key → lowercase surfaces
  const addForm = (key: string, form: string) => {
    const set = formsOf.get(key) ?? new Set<string>();
    set.add(form);
    formsOf.set(key, set);
  };
  for (const w of vocab) {
    if (w.includes("-")) {
      const [a, b] = w.split("-");
      if (a.length >= 2 && b.length >= 2 && !STOP.has(a) && !STOP.has(b)) addForm(`c:${a + b}`, w);
      continue;
    }
    if (w.length >= 4) {
      const dk = dialectKey(w);
      if (dk) addForm(`d:${dk}`, w);
    }
  }
  for (const key of pairs) {
    const c = `c:${key}`;
    if (formsOf.has(c) || vocab.has(key)) addForm(c, "\u0000" + key); // spaced form marker
  }
  for (const [key, forms] of formsOf) {
    if (!key.startsWith("c:")) continue;
    const k = key.slice(2);
    if (vocab.has(k) && k.length >= 5) forms.add(k);
  }
  const wanted = new Map<string, string>(); // lowercase surface → group key
  const wantedPairs = new Map<string, string>(); // pair key → group key
  for (const [key, forms] of formsOf) {
    if (forms.size < 2) continue;
    for (const f of forms) {
      if (f.startsWith("\u0000")) wantedPairs.set(f.slice(1), key);
      else wanted.set(f, key);
    }
  }
  if (!wanted.size && !wantedPairs.size && !/\bet al\b/.test(src)) return;

  // Pass 2 — occurrences of the candidate spellings only.
  const groups = new Map<string, Map<string, Occ[]>>(); // key → lowercase surface → occurrences
  const note = (key: string, o: Occ) => {
    const byForm = groups.get(key) ?? new Map<string, Occ[]>();
    const form = o.surface.toLowerCase();
    const list = byForm.get(form) ?? [];
    list.push(o);
    byForm.set(form, list);
    groups.set(key, byForm);
  };
  if (wanted.size || wantedPairs.size) {
    for (let i = 0; i < n; i++) {
      const from = starts[i], to = from + lows[i].length;
      const g = wanted.get(lows[i]);
      if (g) note(g, { from, to, surface: src.slice(from, to) });
      if (wantedPairs.size && adjacent(i)) {
        const pg = wantedPairs.get(lows[i] + lows[i + 1]);
        if (pg) note(pg, { from, to: starts[i + 1] + lows[i + 1].length, surface: src.slice(from, starts[i + 1] + lows[i + 1].length) });
      }
    }
  }

  const found: { first: number; f: Omit<CheckFinding, "pack" | "doc" | "line" | "col"> }[] = [];
  for (const byForm of groups.values()) {
    if (byForm.size < 2) continue;
    const forms = [...byForm.entries()].sort((x, y) => y[1].length - x[1].length || x[1][0].from - y[1][0].from);
    const majority = forms[0][0];
    const minority = forms.slice(1);
    const all = minority.flatMap(([, occ]) => occ).sort((a, b) => a.from - b.from);
    const edits: CheckEdit[] = [];
    for (const o of all) {
      const insert = recase(o.surface, majority);
      if (insert != null && insert !== o.surface) edits.push({ from: o.from, to: o.to, insert, expect: text.slice(o.from, o.to) });
    }
    const counts = forms.map(([form, occ]) => `"${form}" (${occ.length})`).join(" and ");
    found.push({
      first: all[0].from,
      f: {
        ruleId: "consistency.variant",
        severity: "info",
        message: `Written more than one way: ${counts}.`,
        from: all[0].from,
        to: all[0].to,
        excerpt: all[0].surface,
        ...(edits.length ? { fix: { label: `Use "${majority}" everywhere`, edits } } : {}),
      },
    });
  }
  found.sort((a, b) => a.first - b.first);
  for (const { f } of found) add(f);

  for (const m of src.matchAll(/\bet al\b(?!\.)/g)) {
    const at = m.index! + m[0].length;
    add({
      ruleId: "consistency.et-al",
      severity: "info",
      message: `"et al." takes a period.`,
      from: m.index!,
      to: at,
      excerpt: "et al",
      fix: { label: "Add the period", edits: [{ from: m.index!, to: at, insert: "et al.", expect: text.slice(m.index!, at) }] },
    });
  }
}
