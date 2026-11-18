// How the Dissect viewers show numbers and read a statistics table (src/lib/dissect/format.ts).
// A viewer must never invent precision or hide what a file says, so the rounding rule and the
// p-value marks are pinned here. Run via run-verifies.
import { harness } from "./lib/harness.mjs";
import { formatNumber, formatCell, columnKind, isPValueColumn, significance, statsReport } from "../src/lib/dissect/format";

const h = harness("verify-dissect-format");

h.section("numbers");
for (const same of ["0.42", "11.0", "3.91", "12", "-0.5", "0.003", "100000", "1.23456", "0", "007"]) h.eq(formatNumber(same), same, `${same} is short: shown as written`);
h.eq(formatNumber("6.596349872904714"), "6.596", "a long decimal rounds to 4 significant digits");
h.eq(formatNumber("71.77934741393433"), "71.78", "…wherever the point is");
h.eq(formatNumber("0.8671166137008184"), "0.8671", "…below one");
h.eq(formatNumber("1.9955613835623785e-07"), "1.996 × 10⁻⁷", "an exponent becomes a power of ten");
h.eq(formatNumber("0.0001947825788780547"), "1.948 × 10⁻⁴", "a very small decimal too");
h.eq(formatNumber("123456789.123"), "1.235 × 10⁸", "and a very large one");
h.eq(formatNumber("2e-9"), "2 × 10⁻⁹", "the mantissa keeps no padding zeros");
h.eq(formatNumber("1e3"), "1000", "an exponent that is not extreme is written out");
h.eq(formatNumber("-3.8829874339838984e-05", 2), "-3.9 × 10⁻⁵", "sign and a 2-digit rounding");
for (const text of ["", "n/a", "Paired t-test", "[0.92, 2.86]", "1,234", "12 ms", "NaN", "inf", "0x1F"]) h.eq(formatNumber(text), text, `"${text}" is not a number: unchanged`);
h.eq(formatNumber("  6.596349872904714 "), "6.596", "surrounding spaces do not stop a number being read");
h.ok(Number(formatNumber("2.0000001")) === 2 && formatNumber("0.30000000000000004") === "0.3", "float noise rounds away");

h.section("p-values");
for (const name of ["p", "P", "p-value", "p_value", "pval", "p.adj", "p_adj", "p_corrected_holm", "p_corrected_bh", "p_holm", "p_fdr", "q", "q-value", "p_two_sided", "p value"]) h.ok(isPValueColumn(name), `"${name}" is a p-value column`);
for (const name of ["peak", "power", "pressure", "p_mean_dff", "pairs", "n", "phase", "prob_density", "plot", "page"]) h.ok(!isPValueColumn(name), `"${name}" is not`);
h.eq([columnKind("p", true), columnKind("p", false), columnKind("estimate", true), columnKind("term", false)], ["p", "text", "number", "text"], "a column's kind needs both its name and numeric cells");
h.eq(["0.2", "0.05", "0.049", "0.01", "0.0099", "0.001", "0.00099", "3.9e-05", "0"].map(significance), ["", "", "*", "*", "**", "**", "***", "***", "***"], "marks follow .05 / .01 / .001, exclusive");
h.eq(["1.2", "-0.1", "n.s.", ""].map(significance), ["", "", "", ""], "what is not a probability gets no mark");
h.eq(formatCell("3.8829874339838984e-05", "p"), "3.9 × 10⁻⁵", "a p-value rounds to 2 significant digits");
h.eq(formatCell("0.003", "p"), "0.003", "a short p-value is shown as written");
h.eq(formatCell("6.596349872904714", "text"), "6.596349872904714", "text columns are never rounded");

h.section("a statistics table as results");
const header = ["sig_test_used", "test_statistic_value", "p-value", "p_corrected_holm", "dof", "effect_size_method", "effect_size_value", "effect_size_95_CI", "effect_size_ci_low", "effect_size_ci_high", "n_a", "n_b", "n_total", "groups", "alternative", "p_corrected_bh", "dof_error"];
const row = ["Paired t-test", "6.596349872904714", "3.8829874339838984e-05", "7.765974867967797e-05", "11.0", "Hedges' g_z", "1.7713508719955768", "[0.92, 2.86]", "0.9222804075578142", "2.8575306535839893", "12", "12", "12", "['open', 'laparoscopic']", "two-sided", "3.8829874339838984e-05", ""];
const report = statsReport(header, [row])!;
h.ok(!!report && report.length === 1, "fluxplot's _stats columns are recognised");
h.eq(report[0].sentence, "open vs laparoscopic: Paired t-test: t(11) = 6.596, p = 3.9 × 10⁻⁵ (Holm 7.8 × 10⁻⁵), Hedges' g_z = 1.771 [0.922, 2.86], n = 12", "one sentence a results section could use");
h.eq([report[0].groups, report[0].statistic, report[0].p, report[0].marks, report[0].effect, report[0].n], ["open vs laparoscopic", "t(11) = 6.596", "p = 3.9 × 10⁻⁵", "***", "Hedges' g_z = 1.771 [0.922, 2.86]", "n = 12"], "and its parts, with the marks of the corrected p");
h.eq(report[0].corrected, ["Holm 7.8 × 10⁻⁵"], "a correction equal to the raw p is not repeated");
const anova = statsReport(["analysis", "sig_test_used", "test_statistic_value", "p-value", "dof", "dof_error", "effect_size_method", "effect_size_value"], [["omnibus", "Repeated-measures ANOVA (Greenhouse–Geisser)", "71.77934741393433", "5.873928267646196e-09", "1.6641078477719091", "18.305186325491", "Partial eta squared", "0.8671166137008184"]])!;
h.eq(anova[0].statistic, "F(1.664, 18.31) = 71.78", "an F test reports both degrees of freedom");
h.eq(statsReport(["test", "statistic", "p"], [["Wilcoxon signed-rank", "3", "0.03125"], ["Mann-Whitney U", "40", "0.2"]])!.map((l) => `${l.statistic} ${l.marks}`), ["W = 3 *", "U = 40 "], "common column names and test letters");
h.eq(statsReport(["test", "statistic", "p"], [["Bayesian estimation", "2.1", "0.04"]])![0].statistic, "statistic = 2.1", "an unknown test keeps a plain word, never a guessed letter");
h.ok(statsReport(["centre", "approach", "los_days"], [["centre-01", "open", "3.91"]]) === null, "a data table is not read as statistics");
h.ok(statsReport(["term", "estimate", "p"], [["intake", "0.42", "0.003"]]) === null, "a p column alone is not enough: there must be a test or a statistic");
h.ok(statsReport(["test", "p"], [["t-test", "n/a"]]) === null, "rows without a numeric p are skipped");
h.eq(statsReport(["test", "statistic", "p"], Array.from({ length: 200 }, () => ["t-test", "2", "0.04"]))!.length, 60, "a very long table is read to a bound");

await h.done();
