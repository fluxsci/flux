// The export summary — what a journal export did, what it found, and what is
// still to do before submitting. Shown in the app after the export and written
// beside the file as `<name>.submission.md`; flux-core prints the same text.
//
// ADVISORY, never blocking (owner ruling): every limit — words, display items,
// references, highlights — produces a warning; nothing is cut and no export is
// refused. Ambiguities the styleguide resolved by a default are listed here too,
// so the author sees each judgment instead of discovering it.
//
// Pure: no Svelte, no DOM, no Node.

import type { ResolvedJournalStyle } from "./journalStyle";
import type { AssemblyReport, SubmissionStage } from "./journalManuscript";

export type SummarySeverity = "warn" | "info" | "done" | "todo";

export interface SummaryItem {
  severity: SummarySeverity;
  text: string;
}

export interface SummarySection {
  heading: string;
  items: SummaryItem[];
}

export interface ExportSummary {
  title: string;
  /** One line, e.g. "Nature · initial submission · Word". */
  subtitle: string;
  sections: SummarySection[];
  /** Counts for a compact badge: warnings / to-dos. */
  warnings: number;
  todos: number;
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

export function buildExportSummary(input: {
  style: ResolvedJournalStyle;
  stage: SubmissionStage;
  format: "docx" | "pdf" | "html";
  report: AssemblyReport;
  output?: string;
}): ExportSummary {
  const { style, stage, format, report } = input;
  const spec = style.manuscript;
  const lim = style.limits;
  const checks: SummaryItem[] = [];
  const warn = (text: string) => checks.push({ severity: "warn", text });
  const ok = (text: string) => checks.push({ severity: "info", text });

  // ---- limits (warnings only)
  const t = report.meta.title;
  if (lim.titleChars && t) {
    if (t.length > lim.titleChars) warn(`Title is ${t.length} characters; ${style.name} asks for ${lim.titleChars} or fewer.`);
    else ok(`Title: ${t.length}/${lim.titleChars} characters.`);
  }
  if (lim.abstractWords && report.meta.abstractWords) {
    const w = report.meta.abstractWords;
    const hard = lim.abstractWordsHard ?? lim.abstractWords;
    const label = spec?.titleBlock === "nature" ? "Summary paragraph" : spec?.titleBlock === "cell" ? "Summary" : "Abstract";
    if (w > hard) warn(`${label} is ~${w} words; ${style.name}'s limit is ${hard}.`);
    else if (w > lim.abstractWords) warn(`${label} is ~${w} words; ${style.name} asks for ${lim.abstractWords} (hard limit ${hard}).`);
    else ok(`${label}: ~${w}/${lim.abstractWords} words.`);
  }
  if (lim.mainTextWords && report.counts.mainTextWords) {
    const w = report.counts.mainTextWords;
    const what = spec?.titleBlock === "nature" ? "Main text (summary paragraph included)" : spec?.titleBlock === "cell" ? "Main text (main legends included)" : "Main text";
    if (w > lim.mainTextWords) warn(`${what} is ~${w} words; the guideline is about ${lim.mainTextWords}.`);
    else ok(`${what}: ~${w}/${lim.mainTextWords} words.`);
  }
  if (lim.methodsWords && report.counts.methodsWords > lim.methodsWords) warn(`Methods is ~${report.counts.methodsWords} words; ${style.name} suggests under ${lim.methodsWords}.`);
  if (lim.displayItems) {
    const n = report.counts.displayItems;
    if (n > lim.displayItems) warn(`${plural(n, "main display item")} (figures + tables); ${style.name} allows about ${lim.displayItems}.`);
    else if (n) ok(`Display items: ${n}/${lim.displayItems}.`);
  }
  if (lim.mainRefs && report.citations.mainList > lim.mainRefs) warn(`${report.citations.mainList} main-text references; ${style.name}'s guideline is ${lim.mainRefs}${spec?.splitReferences ? " (Methods references are not counted)" : ""}.`);
  const legendCap = lim.legendWordsHard ?? lim.legendWords;
  for (const l of report.counts.legendWords) {
    const cap = l.extended ? (lim.extendedLegendWords ?? legendCap) : legendCap;
    if (cap && l.words > cap) warn(`${l.label} legend is ~${l.words} words; the limit is ${cap}.`);
    else if (!l.extended && lim.legendWords && lim.legendWordsHard && l.words > lim.legendWords)
      warn(`${l.label} legend is ~${l.words} words — within Nature's 300 but over the 250 its initial-submission page asks for.`);
  }
  // ---- front-matter items the venue asks for
  const items = spec?.frontMatterItems ?? [];
  const finalNeeded = stage === "final" ? "required" : "needed at revision";
  if (items.includes("highlights")) {
    const h = report.meta.highlights;
    if (!h.length) checks.push({ severity: stage === "final" ? "warn" : "info", text: `No Highlights (\`highlights:\` list in the front matter) — ${finalNeeded}: ${lim.highlightsMin ?? 3}–${lim.highlightsMax ?? 4} bullets of ≤${lim.highlightChars ?? 85} characters.` });
    else {
      if ((lim.highlightsMin && h.length < lim.highlightsMin) || (lim.highlightsMax && h.length > lim.highlightsMax)) warn(`${plural(h.length, "highlight")}; ${style.name} asks for ${lim.highlightsMin}–${lim.highlightsMax}.`);
      h.forEach((x, i) => lim.highlightChars && x.length > lim.highlightChars && warn(`Highlight ${i + 1} is ${x.length} characters (limit ${lim.highlightChars}).`));
    }
  }
  if (items.includes("etoc")) {
    const e = report.meta.etoc;
    const w = (e.match(/\S+/g) ?? []).length;
    if (!e) checks.push({ severity: stage === "final" ? "warn" : "info", text: `No eTOC blurb (\`etoc:\` in the front matter) — ${finalNeeded}: ≤${lim.etocWords ?? 50} words, third person.` });
    else if (lim.etocWords && w > lim.etocWords) warn(`eTOC blurb is ${w} words (limit ${lim.etocWords}).`);
  }
  if (items.includes("keywords") && lim.keywordsMax && report.meta.keywords.length > lim.keywordsMax) warn(`${plural(report.meta.keywords.length, "keyword")}; at most ${lim.keywordsMax}.`);
  if (items.includes("one-sentence-summary")) {
    const s = report.meta.teaser;
    if (!s) checks.push({ severity: "info", text: "No one-sentence summary (`one-sentence-summary:` in the front matter) — Science's 2022 template asks for one (≤125 characters); its 2025 instructions no longer mention it." });
    else if (lim.oneSentenceSummaryChars && s.length > lim.oneSentenceSummaryChars) warn(`One-sentence summary is ${s.length} characters (limit ${lim.oneSentenceSummaryChars}).`);
  }

  const sections: SummarySection[] = [];
  const problems = report.problems.map((p) => ({ severity: "warn" as const, text: p }));
  if (problems.length || checks.some((c) => c.severity === "warn")) {
    sections.push({ heading: "Needs attention", items: [...problems, ...checks.filter((c) => c.severity === "warn")] });
  }
  const done: SummaryItem[] = report.actions.map((a) => ({ severity: "done", text: a }));
  if (spec?.citations === "literal" && report.citations.cited) {
    done.unshift({
      severity: "done",
      text: `Numbered ${plural(report.citations.cited, "reference")} in order of first citation (${report.citations.groups} citation marks) and wrote the ${style.referenceList.heading} list in ${style.name} form.`,
    });
  }
  if (report.movedSections.length) done.push({ severity: "done", text: `Reordered sections into ${style.name}'s order (moved: ${report.movedSections.join(", ")}). Your source is unchanged.` });
  if (report.figures.inline) done.push({ severity: "done", text: `Placed ${plural(report.figures.inline, "figure")} with ${report.figures.inline === 1 ? "its legend" : "their legends"} directly below.` });
  if (done.length) sections.push({ heading: "What Flux did", items: done });
  const fine = checks.filter((c) => c.severity === "info");
  if (fine.length) sections.push({ heading: "Checked", items: fine });
  const todo: SummaryItem[] = (spec?.outsideFlux ?? []).map((t) => ({ severity: "todo", text: t }));
  if (todo.length) sections.push({ heading: "Still to do outside Flux", items: todo });
  const fig = (spec?.figureGuidance ?? []).map((t) => ({ severity: "info" as const, text: t }));
  if (fig.length) sections.push({ heading: "Figure files", items: fig });

  const stageLabel = stage === "final" ? "revision / final files" : "initial submission";
  const fmt = format === "docx" ? "Word" : format.toUpperCase();
  const all = sections.flatMap((x) => x.items);
  return {
    title: `${style.name} export`,
    subtitle: `${style.name} · ${stageLabel} · ${fmt}${input.output ? ` · ${input.output.replace(/^.*[\\/]/, "")}` : ""}`,
    sections,
    warnings: all.filter((i) => i.severity === "warn").length,
    todos: all.filter((i) => i.severity === "todo").length,
  };
}

/** The summary as markdown — the `.submission.md` file and the CLI output. */
export function summaryMarkdown(s: ExportSummary): string {
  const mark: Record<SummarySeverity, string> = { warn: "⚠", info: "·", done: "✓", todo: "☐" };
  const lines = [`# ${s.title}`, "", s.subtitle, ""];
  for (const sec of s.sections) {
    lines.push(`## ${sec.heading}`, "");
    for (const i of sec.items) lines.push(`- ${mark[i.severity]} ${i.text}`);
    lines.push("");
  }
  lines.push("_Advisory: limits are warnings — Flux never cuts text or blocks an export. Rules: docs/journal_styleguide.md._", "");
  return lines.join("\n");
}
