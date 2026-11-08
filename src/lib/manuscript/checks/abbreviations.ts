// Pack "abbreviations": define at first use, once, and only if it is used.
//
//   abbr.used-before-definition  warn  "LTP" appears before "long-term potentiation (LTP)"
//   abbr.defined-twice           warn  the same abbreviation defined again
//   abbr.defined-unused          info  defined, then never used
//   abbr.undefined               info  an all-caps abbreviation never defined (and not
//                                       on the common-knowledge list: DNA, PCR, ANOVA…)
//
// Definitions are recognised in both shapes — "long form (ABBR)" and
// "ABBR (long form)" — and only when the long form's letters ALIGN with the
// abbreviation (Schwartz & Hearst 2003), so "(n = 5)", "(Fig. 2)" or "(SLAP2)"
// after an unrelated phrase are never definitions. Code, math, front matter,
// citations, cross-references, links and attribute blocks are not read.
// Scope is the document body; figure legends (which live in the Figure model
// and must stand alone) are not part of this pass.
//
// Fixes (exact, one transaction each): define at first use (move the
// definition up), collapse a repeated definition to the bare abbreviation,
// drop an unused abbreviation's parenthesis.

import type { CheckContext } from "./context";
import { blankSpans } from "./context";
import type { CheckFinding } from "./types";

type Add = (f: Omit<CheckFinding, "pack" | "doc" | "line" | "col">) => void;

/** Abbreviations every reader of a research paper already knows. */
const COMMON = new Set(
  (
    "DNA RNA ATP ADP AMP GTP GDP NAD NADH PCR SEM SD SE CI ANOVA USA UK EU US UN UV IR NMR MRI EEG MEG ECG EKG EMG " +
    "CT PET HIV AIDS COVID SARS WHO NIH NSF NIMH NINDS NHS FDA EPA ID IDS OK TV PC CPU GPU RAM USB PDF HTML URL " +
    "HTTP API CSV JSON XML GFP YFP RFP CFP EGFP DAPI BSA PBS DMSO EDTA SDS PAGE ELISA FACS CRISPR LED LCD AC DC " +
    "DOI ISBN ISSN AM PM GMT UTC BC AD CNS PNS GABA NMDA AMPA BOLD ROI SNR FWHM PSF FFT RMS SVM PCA ICA LDA GLM " +
    "RNN CNN LSTM GAN AI ML NLP GPS ROC AUC MSE RMSE MAE IQR CV GWAS SNP QTL BMI ICU ER ATCC KO WT HEK CHO " +
    "OD RPM UTR ORF CDS IPSC MHC TCR BCR NK IFN TNF IL HPLC LC MS GC TLC XRD SEM TEM AFM STM EPR ESR FRET " +
    "LSD MDMA THC CBD HR EST CST PST CET CEST EDT PDT MDT IEEE ACM ISO ASCII GPL MIT BSD CC NA " +
    "TODO FIXME TBD XXX XXXX"
  ).split(/\s+/),
);

const LETTER = "A-Za-z0-9\\u0370-\\u03FF";
/** An abbreviation candidate: starts with a letter, ≤10 chars, ≥2 capitals. */
const SHORT_RE = new RegExp(`^[A-Za-z\\u0370-\\u03FF][${LETTER}\\-/&]{0,9}$`);
const capitals = (s: string) => {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 65 && c <= 90) n++;
  }
  return n;
};
const isShort = (s: string) => SHORT_RE.test(s) && capitals(s) >= 2 && !/^[IVXLCDM]+$/.test(s);
/** "EPSCs" → "EPSC" (a plural definition defines the singular). */
const singular = (s: string) => (/[A-Z0-9]s$/.test(s) && capitals(s) >= 2 ? s.slice(0, -1) : s);

/** Schwartz & Hearst: the shortest suffix of `long` whose characters, read
 *  right to left, contain the abbreviation's letters in order, with the
 *  abbreviation's first letter at the start of a word. */
function alignLongForm(short: string, long: string): string | null {
  let s = short.length - 1;
  let l = long.length - 1;
  for (; s >= 0; s--) {
    const c = short[s].toLowerCase();
    if (!/[\p{L}\p{N}]/u.test(c)) continue;
    while ((l >= 0 && long[l].toLowerCase() !== c) || (s === 0 && l > 0 && /[\p{L}\p{N}]/u.test(long[l - 1]))) l--;
    if (l < 0) return null;
    l--;
  }
  const start = long.lastIndexOf(" ", l) + 1;
  return long.slice(start);
}

interface Definition {
  abbr: string;
  long: string;
  /** The whole definition, "long form (ABBR)" or "ABBR (long form)". */
  from: number;
  to: number;
  shape: "long-first" | "abbr-first";
}

/** Words of the long form must fit the abbreviation (S&H's length bound). */
function plausible(abbr: string, long: string): boolean {
  const words = long.trim().split(/\s+/).filter(Boolean);
  if (words.length < 1 || long.length <= abbr.length) return false;
  if (words.length > Math.min(abbr.length + 5, abbr.length * 2)) return false;
  if (long.includes(abbr)) return false;
  return /[a-z]/.test(long); // a long form is words, not another acronym
}

/** Mask everything that is not running prose an abbreviation could live in. */
function abbreviationText(ctx: CheckContext): string {
  const spans: { from: number; to: number }[] = [];
  const add = (re: RegExp) => {
    for (const m of ctx.prose.matchAll(re)) spans.push({ from: m.index!, to: m.index! + m[0].length });
  };
  add(/\[[^\]\n]*@[^\]\n]*\]/g); // citation groups
  add(/@[A-Za-z][\w:.-]*/g); // bare cites + cross-references
  add(/\]\([^)\n]*\)/g); // link / image targets
  add(/\{[^}\n]*\}/g); // attribute blocks
  add(/https?:\/\/\S+/g);
  add(/<[^>\n]+>/g); // inline HTML
  spans.sort((a, b) => a.from - b.from);
  return blankSpans(ctx.prose, spans);
}

export function abbreviationsPack(ctx: CheckContext, add: Add): void {
  const src = abbreviationText(ctx);
  const { text } = ctx;

  // ---- definitions -----------------------------------------------------------
  const defs: Definition[] = [];
  for (const m of src.matchAll(/\(([^()\n]{1,100})\)/g)) {
    const open = m.index!;
    const close = open + m[0].length;
    const inner = m[1].trim();
    // "long form (ABBR)"
    if (isShort(inner)) {
      const abbr = singular(inner);
      const before = src.slice(Math.max(0, open - 160), open);
      const segment = before.split(/[.;:!?()[\]\n,]/).pop() ?? "";
      const words = segment.trim().split(/\s+/).filter(Boolean);
      const window = words.slice(-Math.min(abbr.length + 5, abbr.length * 2)).join(" ");
      const long = window ? alignLongForm(abbr, window) : null;
      if (long && plausible(abbr, long)) {
        const longFrom = open - (before.length - before.lastIndexOf(long));
        if (longFrom >= 0 && text.slice(longFrom, longFrom + long.length) === long) {
          defs.push({ abbr, long, from: longFrom, to: close, shape: "long-first" });
          continue;
        }
      }
    }
    // "ABBR (long form)"
    if (/\s/.test(inner)) {
      const w = /([A-Za-zͰ-Ͽ][A-Za-z0-9Ͱ-Ͽ\-/&]*)\s*$/.exec(src.slice(Math.max(0, open - 14), open));
      if (w && isShort(w[1])) {
        const abbr = singular(w[1]);
        const long = alignLongForm(abbr, inner);
        if (long && long === inner && plausible(abbr, long)) {
          const from = open - w[0].length;
          defs.push({ abbr, long: inner, from, to: close, shape: "abbr-first" });
        }
      }
    }
  }

  const defined = new Map<string, Definition[]>();
  for (const d of defs) {
    const list = defined.get(d.abbr) ?? [];
    list.push(d);
    defined.set(d.abbr, list);
  }
  // Definitions arrive in document order and never overlap: binary search.
  const inDef = (i: number) => {
    let lo = 0, hi = defs.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (defs[mid].to <= i) lo = mid + 1;
      else if (defs[mid].from > i) hi = mid - 1;
      else return true;
    }
    return false;
  };

  // ---- uses ------------------------------------------------------------------
  // One tokenizing pass; hyphenated compounds count their abbreviation
  // prefix ("LTP-dependent" uses LTP), plurals their singular.
  const uses = new Map<string, { from: number; to: number; exact: boolean }[]>();
  const undefinedFirst = new Map<string, { from: number; to: number }>();
  // Only a word with two capitals can be an abbreviation; matching just those
  // skips the match objects for every other word (most of a manuscript).
  const tokenRe = new RegExp(`(?<![${LETTER}-])[${LETTER}]*[A-Z][${LETTER}]*[A-Z][${LETTER}]*(?:-[${LETTER}]+)*`, "g");
  // Words written in capitals (a shouted heading, "NOTE THIS") are not
  // abbreviations: an undefined-looking token whose neighbour word is also an
  // unknown all-caps word is shouting, not an acronym.
  const capsWord = (w: string | undefined) => !!w && /^[A-Z]{3,}$/.test(w) && !COMMON.has(w) && !defined.has(w);
  const shouting = (from: number, to: number) => {
    const prev = /([A-Za-z]+)[^A-Za-z\n]*$/.exec(src.slice(Math.max(0, from - 40), from))?.[1];
    const next = /^[^A-Za-z\n]*([A-Za-z]+)/.exec(src.slice(to, to + 40))?.[1];
    return capsWord(prev) || capsWord(next);
  };
  for (const m of src.matchAll(tokenRe)) {
    const tok = m[0];
    const from = m.index!;
    const parts = tok.split("-");
    let hit: string | null = null;
    let len = 0;
    for (let k = parts.length; k >= 1 && !hit; k--) {
      const cand = parts.slice(0, k).join("-");
      if (defined.has(cand)) [hit, len] = [cand, cand.length];
      else if (defined.has(singular(cand))) [hit, len] = [singular(cand), cand.length];
    }
    if (hit) {
      if (inDef(from)) continue;
      const list = uses.get(hit) ?? [];
      list.push({ from, to: from + len, exact: tok === hit });
      uses.set(hit, list);
      continue;
    }
    const bare = singular(parts[0]);
    if (/^[A-Z]{2,6}$/.test(bare) && !COMMON.has(bare) && !/^[IVXLCDM]+$/.test(bare) && !undefinedFirst.has(bare)) {
      if (!inDef(from) && !shouting(from, from + tok.length)) undefinedFirst.set(bare, { from, to: from + bare.length });
    }
  }

  // ---- findings ----------------------------------------------------------------
  for (const [abbr, list] of defined) {
    const def = list[0];
    const u = uses.get(abbr) ?? [];
    const early = u.find((x) => x.from < def.from);
    if (early) {
      const sentenceStart = /(^|[.!?]\s+|\n\s*)$/.test(text.slice(Math.max(0, early.from - 3), early.from));
      const long = sentenceStart ? def.long[0].toUpperCase() + def.long.slice(1) : def.long;
      add({
        ruleId: "abbr.used-before-definition",
        severity: "warn",
        message: `${abbr} is used before it is defined ("${def.long}" comes later).`,
        from: early.from,
        to: early.to,
        excerpt: abbr,
        ...(early.exact
          ? {
              fix: {
                label: "Define at first use",
                edits: [
                  { from: early.from, to: early.to, insert: `${long} (${abbr})`, expect: text.slice(early.from, early.to) },
                  { from: def.from, to: def.to, insert: abbr, expect: text.slice(def.from, def.to) },
                ],
              },
            }
          : {}),
      });
    }
    for (const again of list.slice(1)) {
      add({
        ruleId: "abbr.defined-twice",
        severity: "warn",
        message:
          again.long.toLowerCase() === def.long.toLowerCase()
            ? `${abbr} is defined again; it was already defined earlier.`
            : `${abbr} is defined again as "${again.long}" (first as "${def.long}").`,
        from: again.from,
        to: again.to,
        excerpt: text.slice(again.from, again.to),
        fix: { label: `Use ${abbr}`, edits: [{ from: again.from, to: again.to, insert: abbr, expect: text.slice(again.from, again.to) }] },
      });
    }
    if (!u.length) {
      add({
        ruleId: "abbr.defined-unused",
        severity: "info",
        message: `${abbr} is defined but never used; spell it out and drop the abbreviation.`,
        from: def.from,
        to: def.to,
        excerpt: text.slice(def.from, def.to),
        fix: { label: "Drop the abbreviation", edits: [{ from: def.from, to: def.to, insert: def.long, expect: text.slice(def.from, def.to) }] },
      });
    }
  }
  for (const [abbr, at] of undefinedFirst) {
    add({
      ruleId: "abbr.undefined",
      severity: "info",
      message: `${abbr} is never defined; spell it out at first use.`,
      from: at.from,
      to: at.to,
      excerpt: abbr,
    });
  }
}
