// How the Dissect viewers SHOW the numbers in a table, and how they read a statistics table.
// Pure (no DOM, no Svelte): gated by scripts/verify-dissect-format.ts.
//
// Analysis code writes what the computer has: 6.596349872904714, 3.8829874339838984e-05. A
// reader wants 6.596 and 3.88 × 10⁻⁵. The rule here is conservative, because a viewer must
// never invent precision or hide what the file says:
//   · a value that is already short (≤ 6 significant digits, no exponent) is shown AS WRITTEN:
//     0.42 stays 0.42, 11.0 stays 11.0;
//   · a longer one is rounded to 4 significant digits (p-values to 2), in powers of ten when it
//     is very small or very large;
//   · the cell's tooltip and "As written" always give the file's own text.
// A p-value column also gets the conventional marks (* < .05, ** < .01, *** < .001), drawn as
// decoration: a cell's text stays the number.

const NUMERIC = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const SUPERSCRIPT: Record<string, string> = { "-": "⁻", "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹" };
const superscript = (n: number) => String(n).replace(/[-\d]/g, (c) => SUPERSCRIPT[c]);

/** Significant digits a plain decimal string carries (leading zeros do not count). */
function significantDigits(text: string): number {
  const digits = text.replace(/^[+-]/, "").replace(".", "").replace(/^0+/, "");
  return digits.length || 1;
}

/** `m × 10ⁿ`, with the mantissa at `digits` significant figures. */
function powerOfTen(value: number, digits: number): string {
  const [mantissa, exponent] = value.toExponential(Math.max(0, digits - 1)).split("e");
  const m = mantissa.includes(".") ? mantissa.replace(/\.?0+$/, "") : mantissa;
  const e = Number(exponent);
  return e === 0 ? m : `${m} × 10${superscript(e)}`;
}

/**
 * A numeric cell as it should be read. `digits` is the rounding for long values. Non-numeric
 * text, and numbers that are already short, come back unchanged.
 */
export function formatNumber(raw: string, digits = 4): string {
  const text = raw.trim();
  if (!NUMERIC.test(text)) return raw;
  const value = Number(text);
  if (!Number.isFinite(value)) return raw;
  const hasExponent = /[eE]/.test(text);
  if (!hasExponent && significantDigits(text) <= 6) return text;
  if (value === 0) return "0";
  const magnitude = Math.abs(value);
  if (magnitude < 1e-3 || magnitude >= 1e6) return powerOfTen(value, digits);
  // toPrecision may itself answer in e-notation for large integers; those are ≥ 1e6 and handled above.
  const rounded = Number(value.toPrecision(digits));
  return String(rounded);
}

export type ColumnKind = "text" | "number" | "p";

/** Column names that hold p-values: p, p-value, p_value, pval, p_adj, p_corrected_holm, p.adj, q-value… */
const P_NAME = /^(?:p|q)(?:[\s._-]*(?:val(?:ue)?s?|adj(?:usted)?|corr(?:ected)?|holm|bonf(?:erroni)?|bh|by|fdr|fwer|unc(?:orrected)?|perm(?:utation)?|two[\s._-]*sided|one[\s._-]*sided))*(?:[\s._-]+[a-z0-9]+)?$/i;
export function isPValueColumn(name: string): boolean {
  return P_NAME.test(name.trim());
}

/** What a column holds, from its name and whether its cells are numbers. */
export function columnKind(name: string, numeric: boolean): ColumnKind {
  return !numeric ? "text" : isPValueColumn(name) ? "p" : "number";
}

/** The conventional marks for a p-value ("" when it is not below .05, or not a probability). */
export function significance(raw: string): "" | "*" | "**" | "***" {
  const text = raw.trim();
  if (!NUMERIC.test(text)) return "";
  const p = Number(text);
  if (!(p >= 0 && p <= 1)) return "";
  return p < 0.001 ? "***" : p < 0.01 ? "**" : p < 0.05 ? "*" : "";
}

/** A cell for display: numbers by `formatNumber` (p-values at 2 significant digits), text unchanged. */
export function formatCell(raw: string, kind: ColumnKind): string {
  return kind === "text" ? raw : formatNumber(raw, kind === "p" ? 2 : 4);
}

// ---------------------------------------------------------------------------------------------
// A statistics table, read as results

export interface StatLine {
  /** The comparison, when the row names one: "open vs laparoscopic". */
  groups: string;
  /** "Paired t-test". */
  test: string;
  /** "t(11) = 6.596" (or "statistic = …" when the test's letter is not known). */
  statistic: string;
  /** "p = 3.9 × 10⁻⁵". */
  p: string;
  /** The marks for the p-value actually reported (the corrected one when there is one). */
  marks: string;
  /** "Holm 7.8 × 10⁻⁵" etc., one per correction column present. */
  corrected: string[];
  /** "Hedges' g_z = 1.771 [0.92, 2.86]". */
  effect: string;
  /** "n = 12". */
  n: string;
  /** Everything above as one sentence, for copying into a manuscript. */
  sentence: string;
}

const norm = (name: string) => name.trim().toLowerCase().replace(/[\s.-]+/g, "_");
/** The letter a test's statistic is reported with. */
function statisticSymbol(test: string): string {
  const t = test.toLowerCase();
  if (/anova|f[- ]test|welch.*f/.test(t)) return "F";
  if (/t[- ]?test|student/.test(t)) return "t";
  if (/wilcoxon.*signed|signed[- ]rank/.test(t)) return "W";
  if (/mann|rank[- ]sum|\bu\b/.test(t)) return "U";
  if (/kruskal/.test(t)) return "H";
  if (/friedman|chi|χ|log[- ]?rank/.test(t)) return "χ²";
  if (/pearson|correlation/.test(t)) return "r";
  if (/spearman/.test(t)) return "ρ";
  if (/z[- ]?test/.test(t)) return "z";
  return "";
}
/** "['open', 'laparoscopic']" → "open vs laparoscopic". */
function groupsText(raw: string): string {
  const names = [...raw.matchAll(/'([^']*)'|"([^"]*)"/g)].map((m) => m[1] ?? m[2]).filter(Boolean);
  if (names.length >= 2) return names.join(" vs ");
  return raw.replace(/^[[(]|[\])]$/g, "").trim();
}
const trimDf = (raw: string) => formatNumber(String(Number(raw)), 4);

/**
 * Read a table as test results when it has the columns of one (a test's name or a statistic,
 * and a p-value). Returns one line per row, or null when the table is not a statistics table.
 * Column names follow fluxplot's `_stats` output and the common variants of it.
 */
export function statsReport(header: readonly string[], rows: readonly (readonly string[])[], maxRows = 60): StatLine[] | null {
  const at = new Map(header.map((name, i) => [norm(name), i]));
  const find = (...names: string[]) => { for (const n of names) { const i = at.get(n); if (i !== undefined) return i; } return -1; };
  const iTest = find("sig_test_used", "test", "test_used", "method", "analysis");
  const iStat = find("test_statistic_value", "statistic", "test_statistic", "stat", "t", "f", "w", "u", "h", "z", "chi2");
  const iP = find("p_value", "p", "pvalue", "p_val", "pval");
  if (iP < 0 || (iTest < 0 && iStat < 0)) return null;
  const iDof = find("dof", "df", "df1", "dof_num"), iDofError = find("dof_error", "df2", "dof_den", "df_error");
  const iEffectName = find("effect_size_method", "effect_size_name", "effect_size_type");
  const iEffect = find("effect_size_value", "effect_size", "cohens_d", "hedges_g", "eta_squared", "r");
  const iLow = find("effect_size_ci_low", "ci_low", "ci95_low", "ci_lower"), iHigh = find("effect_size_ci_high", "ci_high", "ci95_high", "ci_upper");
  const iGroups = find("groups", "comparison", "contrast", "pair");
  const iN = find("n_total", "n", "n_pairs", "n_subjects");
  const corrections: [string, number][] = (["holm", "bh", "bonferroni", "fdr"] as const)
    .map((name) => [name === "bh" ? "BH" : name[0].toUpperCase() + name.slice(1), find(`p_corrected_${name}`, `p_${name}`, `p_adj_${name}`)] as [string, number])
    .filter(([, i]) => i >= 0);
  const out: StatLine[] = [];
  for (const row of rows.slice(0, maxRows)) {
    const cell = (i: number) => (i >= 0 ? (row[i] ?? "").trim() : "");
    const pRaw = cell(iP);
    if (!NUMERIC.test(pRaw)) continue;
    const test = cell(iTest);
    const symbol = statisticSymbol(test);
    const dof = cell(iDof), dofError = cell(iDofError);
    const degrees = NUMERIC.test(dof) ? (NUMERIC.test(dofError) ? `(${trimDf(dof)}, ${trimDf(dofError)})` : `(${trimDf(dof)})`) : "";
    const statRaw = cell(iStat);
    const statistic = NUMERIC.test(statRaw) ? `${symbol || "statistic"}${symbol ? degrees : ""} = ${formatNumber(statRaw, 4)}` : "";
    const p = `p = ${formatNumber(pRaw, 2)}`;
    const corrected = corrections.map(([name, i]) => [name, cell(i)] as const).filter(([, v]) => NUMERIC.test(v) && v !== pRaw).map(([name, v]) => `${name} ${formatNumber(v, 2)}`);
    const reported = corrections.map(([, i]) => cell(i)).find((v) => NUMERIC.test(v)) ?? pRaw;
    const effectValue = cell(iEffect);
    const low = cell(iLow), high = cell(iHigh);
    const interval = NUMERIC.test(low) && NUMERIC.test(high) ? ` [${formatNumber(low, 3)}, ${formatNumber(high, 3)}]` : "";
    const effect = NUMERIC.test(effectValue) ? `${cell(iEffectName) || "effect size"} = ${formatNumber(effectValue, 4)}${interval}` : "";
    const nRaw = cell(iN);
    const n = NUMERIC.test(nRaw) ? `n = ${formatNumber(nRaw, 4)}` : "";
    const groups = groupsText(cell(iGroups));
    const sentence = [[test, statistic].filter(Boolean).join(": "), [p, ...(corrected.length ? [`(${corrected.join(", ")})`] : [])].join(" "), effect, n].filter(Boolean).join(", ");
    out.push({ groups, test, statistic, p, marks: significance(reported), corrected, effect, n, sentence: groups ? `${groups}: ${sentence}` : sentence });
  }
  return out.length ? out : null;
}
