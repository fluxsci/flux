// Journal manuscript assembly — authored Flux manuscript → the venue's
// SUBMISSION document (Nature, Science, Cell, bioRxiv).
//
// Runs inside the shared export prep (exportPrep.ts) on the export COPY of the
// entry document, after the figure transform and before Quarto renders, so the
// GUI and flux-core produce byte-identical manuscripts. It never touches the
// author's sources and it never writes prose the author did not: statements a
// venue requires but the manuscript lacks are REPORTED (export summary), not
// invented. What it does generate comes only from data Flux owns — front-matter
// metadata (title page, Nature's correspondence line, Cell's lead-contact
// sentence), the figure model (legends, Science/Cell supplementary indexes) and
// the bibliography (numbered reference lists).
//
// The rules it applies are docs/journal_styleguide.md, encoded per venue in
// journalPresets.ts (`manuscript` spec). Blocks it creates are tagged with Word
// custom styles (`::: {custom-style="…"}`): the venue's reference.docx defines
// them (Science's use its own template's style names, so Science's metadata
// extraction recognises the sections), and resources/lua/flux-journal.lua maps
// them for the PDF path.
//
// Pure: no Svelte, no DOM, no Node (js-yaml is imported lazily, as exportPrep does).

import type { CslRecord } from "../references/zoteroFields";
import type { ExportQmdCtx } from "../exportQmd";
import { EMBED_RE } from "../exportQmd";
import { formatCaptionLabel, type FigureFamilyDef } from "../figfamily";
import { scanSections, normalizeHeading, JOURNAL_ROLE_ALIASES } from "../manuscript/sections";
import { proseWords } from "../manuscript/wordCount";
import { MAIN_TEXT_ROLES } from "../manuscript/wordBudget";
import type { ResolvedJournalStyle, ManuscriptSpec, DocxStyleRole } from "./journalStyle";
import { literalizeCitations } from "./journalCitations";
import { formatJournalReference, type RefLayout } from "./journalRefs";
import { formatLegend } from "./journalCaptions";
import { journalRenderMeta } from "./journalAssets";

export type SubmissionStage = "initial" | "final";

// The role table moved to manuscript/sections.ts (the word budget reads it too).
export { JOURNAL_ROLE_ALIASES };

/** Default Word custom-style names (each venue's reference.docx defines them). */
const DEFAULT_DOCX_STYLES: Record<DocxStyleRole, string> = {
  title: "Title",
  authors: "Author",
  affiliation: "Affiliation",
  correspondence: "Correspondence",
  abstract: "Abstract",
  teaser: "Teaser",
  label: "Section Label",
  bibliography: "Bibliography",
  bibheading: "Bibliography Heading",
  acknowledgement: "Acknowledgement",
  figure: "Figure",
  legend: "Figure Legend",
  highlights: "Highlights",
};

// ---------------------------------------------------------------- authors

export interface Affiliation {
  id: string;
  text: string;
}
export interface Author {
  name: string;
  given?: string;
  family?: string;
  affiliations: string[]; // affiliation ids
  email?: string;
  corresponding: boolean;
  equal: boolean;
  lead: boolean;
  orcid?: string;
}

const s = (v: unknown): string => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");
const truthy = (v: unknown) => v === true || v === "true" || v === "yes";

function affText(a: Record<string, unknown>, layout: "science" | "plain"): string {
  const inst = [s(a.department), s(a.name) || s(a.institution) || s(a.affiliation)].filter(Boolean).join(", ");
  const place = [s(a.address), s(a.city), s(a.region) || s(a.state), s(a["postal-code"]), s(a.country)].filter(Boolean).join(", ");
  if (!inst) return place;
  if (!place) return inst;
  return layout === "science" ? `${inst}; ${place}` : `${inst}, ${place}`;
}

/** Tolerant reader for Quarto's author/affiliation schema (plus `lead-contact`). */
export function readAuthors(meta: Record<string, unknown>, layout: "science" | "plain" = "plain"): { authors: Author[]; affiliations: Affiliation[] } {
  const affs: Affiliation[] = [];
  const byId = new Map<string, string>();
  const topAffs = Array.isArray(meta.affiliations) ? meta.affiliations : [];
  topAffs.forEach((a, i) => {
    if (a && typeof a === "object") {
      const o = a as Record<string, unknown>;
      const id = s(o.id) || String(i + 1);
      byId.set(id, affText(o, layout));
    } else if (typeof a === "string") byId.set(String(i + 1), a);
  });
  const ensure = (text: string, key?: string): string => {
    const found = affs.find((a) => a.text === text);
    if (found) return found.id;
    const id = key ?? `aff${affs.length + 1}`;
    affs.push({ id, text });
    return id;
  };
  const raw = meta.author ?? meta.authors;
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const authors: Author[] = [];
  for (const r of list) {
    if (typeof r === "string") {
      authors.push({ name: r, affiliations: [], corresponding: false, equal: false, lead: false });
      continue;
    }
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const nm = o.name;
    let name = "";
    let given: string | undefined;
    let family: string | undefined;
    if (typeof nm === "string") name = nm.trim();
    else if (nm && typeof nm === "object") {
      const n = nm as Record<string, unknown>;
      given = s(n.given) || undefined;
      family = s(n.family) || undefined;
      name = s(n.literal) || [given, family].filter(Boolean).join(" ");
    }
    if (!name) continue;
    const attrs = (o.attributes && typeof o.attributes === "object" ? o.attributes : {}) as Record<string, unknown>;
    const affRaw = o.affiliations ?? o.affiliation;
    const affList = Array.isArray(affRaw) ? affRaw : affRaw != null ? [affRaw] : [];
    const ids: string[] = [];
    for (const a of affList) {
      if (typeof a === "string" || typeof a === "number") {
        const key = String(a);
        if (byId.has(key)) ids.push(ensure(byId.get(key)!));
        else ids.push(ensure(key));
      } else if (a && typeof a === "object") {
        const ao = a as Record<string, unknown>;
        if (ao.ref != null && byId.has(String(ao.ref))) ids.push(ensure(byId.get(String(ao.ref))!));
        else if (affText(ao, layout)) ids.push(ensure(affText(ao, layout)));
      }
    }
    authors.push({
      name,
      given,
      family,
      affiliations: ids,
      email: s(o.email) || undefined,
      corresponding: truthy(o.corresponding) || truthy(attrs.corresponding),
      equal: truthy(o["equal-contributor"]) || truthy(attrs["equal-contributor"]),
      lead: truthy(o["lead-contact"]) || truthy(attrs["lead-contact"]),
      orcid: s(o.orcid) || undefined,
    });
  }
  return { authors, affiliations: affs };
}

// ---------------------------------------------------------------- blocks

const div = (style: string, body: string) => `::: {custom-style="${style}"}\n${body}\n:::`;
const sup = (t: string) => (t ? `^${t.replace(/ /g, "\\ ")}^` : "");

function md(text: string): string {
  // Metadata strings are plain text: escape what pandoc would reinterpret.
  return text.replace(/([\\`*_[\]^~@#<>|])/g, "\\$1");
}

interface TitleBlockOut {
  text: string;
  notes: string[];
}

function titleBlock(spec: ManuscriptSpec, styles: Record<DocxStyleRole, string>, title: string, authors: Author[], affs: Affiliation[]): TitleBlockOut {
  const notes: string[] = [];
  const out: string[] = [];
  if (title) out.push(div(styles.title, md(title)));
  if (!authors.length) {
    notes.push("No authors in the front matter — the title page has no author list.");
    return { text: out.join("\n\n"), notes };
  }
  // Affiliation numbers by first appearance in the author list.
  const order: string[] = [];
  for (const a of authors) for (const id of a.affiliations) if (!order.includes(id)) order.push(id);
  const affNum = (id: string) => order.indexOf(id) + 1;
  const anyEqual = authors.some((a) => a.equal);
  const corresponding = authors.filter((a) => a.corresponding);
  const lead = authors.find((a) => a.lead) ?? (spec.titleBlock === "cell" ? corresponding[0] : undefined);
  // Cell: extra numbered footnotes after the affiliations (equal contribution, lead contact).
  const cellEqualNum = order.length + 1;
  const cellLeadNum = order.length + (anyEqual ? 2 : 1);

  const authorTokens = authors.map((a, i) => {
    const nums = a.affiliations.map(affNum).filter((n) => n > 0);
    let marks = "";
    if (spec.titleBlock === "science") {
      // Superscript affiliation numbers, then NON-superscript symbols.
      const symbols = `${a.corresponding ? "\\*" : ""}${a.equal ? "†" : ""}`;
      marks = `${sup(nums.join(","))}${symbols}`;
    } else if (spec.titleBlock === "cell") {
      const extra = [...nums];
      if (a.equal) extra.push(cellEqualNum);
      if (lead === a) extra.push(cellLeadNum);
      const star = a.corresponding ? "\\*".repeat(Math.max(1, corresponding.indexOf(a) + 1)) : "";
      marks = sup([extra.join(","), star].filter(Boolean).join(","));
    } else {
      const flags = `${a.equal ? "†" : ""}${a.corresponding ? "\\*" : ""}`;
      marks = sup([nums.join(","), flags].filter(Boolean).join(","));
    }
    const sep = i === 0 ? "" : spec.titleBlock === "cell" && i === authors.length - 1 ? (authors.length > 2 ? ", and " : " and ") : ", ";
    return `${sep}${md(a.name)}${marks}`;
  });
  out.push(div(styles.authors, authorTokens.join("")));

  const affLines = order.map((id) => {
    const a = affs.find((x) => x.id === id);
    const text = md(a?.text ?? id);
    return `${sup(String(affNum(id)))}${spec.titleBlock === "science" && !/\.$/.test(text) ? `${text}.` : text}`;
  });
  if (spec.titleBlock === "cell") {
    if (anyEqual) affLines.push(`${sup(String(cellEqualNum))}These authors contributed equally`);
    if (lead) affLines.push(`${sup(String(cellLeadNum))}Lead contact`);
  }
  if (affLines.length) out.push(div(styles.affiliation, affLines.join("\\\n")));
  else notes.push("No affiliations in the front matter — the title page lists none.");

  const corrLines: string[] = [];
  if (spec.titleBlock === "cell") {
    corresponding.forEach((a, i) => {
      if (a.email) corrLines.push(`${"\\*".repeat(i + 1)}Correspondence: ${md(a.email)}`);
    });
  } else if (corresponding.length) {
    const emails = corresponding.map((a) => a.email).filter(Boolean) as string[];
    if (emails.length) {
      corrLines.push(
        spec.titleBlock === "science"
          ? `\\*Corresponding author. Email: ${emails.map(md).join("; ")}`
          : spec.titleBlock === "nature"
            ? `\\*e-mail: ${emails.map(md).join("; ")}`
            : `\\*Corresponding author: ${emails.map(md).join("; ")}`,
      );
    }
  }
  if (anyEqual && spec.titleBlock !== "cell") corrLines.push("†These authors contributed equally to this work.");
  if (corrLines.length) out.push(div(styles.correspondence, corrLines.join("\\\n")));
  if (!corresponding.length) notes.push("No corresponding author is marked (`corresponding: true` on an author in the front matter).");
  else if (!corresponding.some((a) => a.email)) notes.push("The corresponding author has no `email:` in the front matter.");
  if (spec.titleBlock === "cell" && !lead) notes.push("Cell needs a lead contact (`lead-contact: true` on one corresponding author).");
  return { text: out.join("\n\n"), notes };
}

// ---------------------------------------------------------------- sections

interface Section {
  role: string;
  heading: string;
  /** Heading attribute block (`{#sec-x .unnumbered}`), kept so @sec refs survive. */
  attrs: string;
  /** Body text below the heading (no heading line). */
  body: string;
}

function splitHeading(h: string): { text: string; attrs: string } {
  const m = /^(.*?)\s*(\{[^}]*\})\s*$/.exec(h);
  return m ? { text: m[1].trim(), attrs: m[2] } : { text: h.trim(), attrs: "" };
}

/** Top-level sections with roles; nested headings stay inside their parent. */
function readSections(body: string): { preamble: string; sections: Section[] } {
  const st = scanSections(body, JOURNAL_ROLE_ALIASES);
  const tops = st.sections.filter((x) => x.level === 1);
  const minLevel = st.sections.length ? Math.min(...st.sections.map((x) => x.level)) : 1;
  // A manuscript whose top level is ## (common when # is the title) is read at that level.
  const topLevel = tops.length ? 1 : minLevel;
  const heads = st.sections.filter((x) => x.level === topLevel);
  const preamble = heads.length ? body.slice(0, heads[0].from) : body;
  const sections = heads.map((h) => {
    const text = body.slice(h.from, h.to);
    const nl = text.indexOf("\n");
    const { text: heading, attrs } = splitHeading(h.heading);
    const role = (JOURNAL_ROLE_ALIASES[normalizeHeading(h.heading)] as string | undefined) ?? "body";
    // Re-level nested headings so the section's top heading is level 1 in the output.
    let inner = nl < 0 ? "" : text.slice(nl + 1);
    if (topLevel > 1) inner = inner.replace(/^(#{2,6})(\s)/gm, (_m, hs: string, sp: string) => `${hs.slice(topLevel - 1)}${sp}`);
    return { role, heading, attrs, body: inner.replace(/\s+$/, "") };
  });
  return { preamble, sections };
}

/** Promote nested headings by one level (a dropped parent heading's children). */
function promote(body: string): string {
  return body.replace(/^##(#{0,4})(\s)/gm, "#$1$2");
}

function upperHeadings(body: string): string {
  return body.replace(/^(#)(\s+)(.+)$/gm, (_m, h: string, sp: string, t: string) => {
    const { text, attrs } = splitHeading(t);
    return `${h}${sp}${text.toUpperCase()}${attrs ? ` ${attrs}` : ""}`;
  });
}

const isBlank = (t: string) => !t.replace(/<!--[\s\S]*?-->/g, "").trim();

/** Prefix the first paragraph of `body` with a run-in bold label. */
function runIn(label: string, body: string): string {
  const t = body.trim();
  if (!t) return "";
  if (/^(#|:::|```|\||- |\* |\d+\. |>)/.test(t)) return `**${label}**\n\n${t}`;
  return `**${label}** ${t}`;
}

// --------------------------------------------------------- STAR Methods

const STAR_MODEL = /\b(animals?|mice|mouse|rats?|subjects?|participants?|patients?|human|cell lines?|strains?|organisms?|zebrafish|drosophila|flies|primates?|volunteers?|cohort|experimental models?|study participants?|husbandry|housing)\b/i;
const STAR_STATS = /\b(statistic(s|al)?|quantification|data analysis|analyses|power analysis|sample size)\b/i;

/** Cell: put the author's Methods subsections under the fixed STAR headings. */
function starMethods(body: string, report: string[]): string {
  const known = /^#{1,3}\s+(key resources table|experimental model and (study participant|subject) details|method details|quantification and statistical analysis|additional resources)\b/im;
  if (known.test(body)) return body.replace(/^(#{1,3})\s+(.+)$/gm, (m, h: string, t: string) =>
    /^(key resources table|experimental model and (study participant|subject) details|method details|quantification and statistical analysis|additional resources)/i.test(t)
      ? `## ${t.replace(/subject details/i, "study participant details").toUpperCase()}`
      : m,
  );
  // Units: ## subsections, else run-in bold paragraph leads (***Animals.*** …).
  type Unit = { title: string; text: string };
  const units: Unit[] = [];
  let pre = "";
  if (/^##\s/m.test(body)) {
    const parts = body.split(/^(?=##\s)/m);
    pre = parts[0].startsWith("##") ? "" : parts.shift()!;
    for (const p of parts) units.push({ title: /^##\s+(.*)$/m.exec(p)?.[1] ?? "", text: p });
  } else {
    const paras = body.split(/\n{2,}/);
    for (const p of paras) {
      const lead = /^\s*\*{2,3}([^*\n]{2,80}?)[.:]?\*{2,3}/.exec(p);
      if (lead || !units.length) units.push({ title: lead?.[1] ?? "", text: p });
      else units[units.length - 1].text += `\n\n${p}`;
    }
  }
  const model: Unit[] = [];
  const stats: Unit[] = [];
  const details: Unit[] = [];
  for (const u of units) (STAR_STATS.test(u.title) ? stats : STAR_MODEL.test(u.title) ? model : details).push(u);
  const block = (h: string, us: Unit[]) => (us.length ? `## ${h}\n\n${us.map((u) => u.text.trim().replace(/^##\s/gm, "### ")).join("\n\n")}` : "");
  if (!model.length) report.push("STAR Methods: no subsection reads as experimental models or study participants — EXPERIMENTAL MODEL AND STUDY PARTICIPANT DETAILS is empty (required when the study uses models or participants).");
  if (!stats.length) report.push("STAR Methods: no statistics subsection found — QUANTIFICATION AND STATISTICAL ANALYSIS is empty.");
  if (units.length) report.push("STAR Methods: your Methods subsections were grouped under the STAR headings by their titles — check the grouping.");
  return [pre.trim(), block("EXPERIMENTAL MODEL AND STUDY PARTICIPANT DETAILS", model), block("METHOD DETAILS", details), block("QUANTIFICATION AND STATISTICAL ANALYSIS", stats)]
    .filter(Boolean)
    .join("\n\n");
}

// ---------------------------------------------------------------- figures

export interface FigureInfo {
  family: FigureFamilyDef;
  number: number;
  caption: string;
}

interface Legend {
  label: string;
  family: string;
  number: number;
  text: string;
  /** The caption alone (no "Figure 1 |" lead) — what legend word limits count. */
  caption: string;
}

/** Replace each embed with figure + legend (inline) or remove it (legends-only). */
function placeFigures(
  emptyLegends: string[],
  images: ReadonlyMap<string, string> | undefined,
  body: string,
  ctx: ExportQmdCtx,
  style: ResolvedJournalStyle,
  spec: ManuscriptSpec,
  styles: Record<DocxStyleRole, string>,
  placement: "inline" | "legends-only",
  legends: Legend[],
): string {
  return body
    .split("\n")
    .map((line) => {
      // The figure transform demoted the id to #x-fig-…; accept both forms.
      const m = /^\s*!\[((?:\\.|[^\]])*)\]\(([^)]*)\)\{#(?:x-)?(fig-[A-Za-z0-9_-]+)([^}]*)\}\s*$/.exec(line) ?? EMBED_RE.exec(line);
      if (!m) return line;
      const label = m[3];
      const fig = ctx.figures.get(label);
      if (!fig) return line;
      const lead = formatCaptionLabel(fig.family, fig.number).trim();
      const caption = ctx.captions.get(label)?.trim() || (m[1] ? m[1].replace(/\\([\\[\]])/g, "$1") : "");
      const text = formatLegend(lead, caption, spec.legend, style.figures.panels);
      if (!caption) emptyLegends.push(lead.replace(/[\s|.]+$/, ""));
      if (!legends.some((l) => l.label === label)) legends.push({ label, family: fig.family.id, number: fig.number, text, caption });
      if (placement === "legends-only") return "";
      const attrs = m[4].trim();
      const target = images?.get(label) ?? m[2];
      return `${div(styles.figure, `![](${/\s/.test(target) ? `<${target}>` : target})${attrs ? `{${attrs}}` : ""}`)}\n\n${div(styles.legend, text)}`;
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
}

// ---------------------------------------------------------------- assemble

export interface AssembleInput {
  style: ResolvedJournalStyle;
  stage: SubmissionStage;
  /** Bibliography records keyed by citekey (citation-js CSL-JSON). */
  records: Record<string, CslRecord>;
  /** Figure identity + captions (the export ctx the figure transform used). */
  ctx: ExportQmdCtx;
  /** Supplementary-family figures known to the project (for SI indexes). */
  supplementaryFigures?: number;
  /** Wrap printed citation marks (Zotero live fields). */
  wrapCitation?: (keys: string[], mark: string) => string;
  /** Project-relative directory of the entry document (render-setting paths). */
  docDir?: string;
  /** label → image to place instead of the embed's own (print-resolution PNGs for the PDF path). */
  figureImages?: ReadonlyMap<string, string>;
}

export interface AssemblyReport {
  /** Things the assembler did that the author should know about. */
  actions: string[];
  /** Problems: missing required pieces, unresolved keys, limits. */
  problems: string[];
  citations: { cited: number; groups: number; missing: string[]; mainList: number; secondList: number; notes: number };
  figures: { inline: number; legends: number };
  movedSections: string[];
  /** Detected metadata, for the summary. */
  meta: { title: string; abstractWords: number; authors: number; highlights: string[]; etoc: string; keywords: string[]; teaser: string };
  /** Roles present in the assembled document. */
  roles: string[];
  /** Measured against the venue's limits by the export summary. */
  counts: { mainTextWords: number; methodsWords: number; legendWords: { label: string; words: number; extended: boolean }[]; displayItems: number; tables: number };
}

// Word counts follow THE counting law (manuscript/wordCount.ts) — the same
// counter the editor's status bar and Journal Check use. A placed legend block
// (a custom-style div) is not running text.
const PLACED_BLOCK = /::: \{custom-style="[^"]*"\}[\s\S]*?\n:::/g;
const words = (t: string) => proseWords(t.replace(PLACED_BLOCK, ""));

function strList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => s(x)).filter(Boolean);
  if (typeof v === "string") return v.split(/[;,]\s*|\n/).map((x) => x.trim()).filter(Boolean);
  return [];
}

/**
 * Assemble the submission document. Returns the full .qmd text (front matter
 * included) plus a report the export summary renders.
 */
export async function assembleJournalManuscript(src: string, input: AssembleInput): Promise<{ text: string; report: AssemblyReport }> {
  const { style, stage, ctx } = input;
  const spec = style.manuscript;
  if (!spec) throw new Error(`${style.name} has no manuscript specification`);
  const styles = { ...DEFAULT_DOCX_STYLES, ...(spec.docxStyles ?? {}) } as Record<DocxStyleRole, string>;
  const yaml = await import("js-yaml");
  const { frontMatterBounds } = await import("../../shell/modes/paper/frontmatter");
  const b = frontMatterBounds(src);
  const parsed = b.has ? yaml.load(b.fmText) : {};
  const meta = (parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}) as Record<string, unknown>;
  let body = b.has ? src.slice(b.bodyStart) : src;
  const actions: string[] = [];
  const problems: string[] = [];

  // ---- metadata the venue asks for
  const title = s(meta.title);
  const { authors, affiliations } = readAuthors(meta, spec.titleBlock === "science" ? "science" : "plain");
  const highlights = strList(meta.highlights);
  const etoc = s(meta.etoc) || s(meta["in-brief"]) || s(meta["etoc-blurb"]);
  const keywords = strList(meta.keywords);
  const teaser = s(meta["one-sentence-summary"]) || s(meta.teaser);

  // ---- sections
  let { preamble, sections } = readSections(body);

  // A hand-written title block in the preamble (the title text appears there)?
  const norm = (t: string) => t.replace(/[*_`#>\\]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
  const preLines = preamble.split("\n").map((p) => p.trim()).filter(Boolean);
  const manualTitle = !!title && preLines.some((p) => norm(p) === norm(title));

  // ---- abstract: front matter, an Abstract section, or (no title block) the preamble prose
  let abstract = s(meta.abstract);
  const absIdx = sections.findIndex((x) => x.role === "abstract");
  if (absIdx >= 0) {
    if (!abstract && !isBlank(sections[absIdx].body)) abstract = sections[absIdx].body.trim();
    sections.splice(absIdx, 1);
  }
  let keepPreamble = "";
  if (manualTitle) {
    keepPreamble = preamble.trim();
    actions.push("Your manuscript writes its own title block, so Flux kept it as written. Put authors and affiliations in the front matter to have Flux set the title page in this journal's form.");
  } else if (!abstract && !isBlank(preamble)) {
    abstract = preamble.trim();
  } else if (!isBlank(preamble)) {
    keepPreamble = preamble.trim();
  }
  if (!abstract) problems.push(`No abstract${spec.abstract.heading ? ` (${spec.abstract.heading})` : ""} — add \`abstract:\` to the front matter or an "Abstract" section.`);

  // ---- figures
  const legends: Legend[] = [];
  const emptyLegends: string[] = [];
  const placement = stage === "final" ? spec.figures.final : spec.figures.initial;
  sections = sections.map((x) => ({ ...x, body: placeFigures(emptyLegends, input.figureImages, x.body, ctx, style, spec, styles, placement, legends) }));
  keepPreamble = placeFigures(emptyLegends, input.figureImages, keepPreamble, ctx, style, spec, styles, placement, legends);

  if (emptyLegends.length) problems.push(`${[...new Set(emptyLegends)].join(", ")} ${emptyLegends.length === 1 ? "has" : "have"} no legend text — write the caption in Figure mode.`);

  // ---- section-level venue rules
  const roleOf = (r: string) => sections.filter((x) => x.role === r);
  const take = (r: string) => {
    const found = roleOf(r);
    sections = sections.filter((x) => x.role !== r);
    return found;
  };
  // Cell: Limitations of the study closes the Discussion.
  if (spec.titleBlock === "cell") {
    const lim = take("limitations");
    const disc = sections.find((x) => x.role === "discussion");
    if (lim.length) {
      const text = lim.map((l) => promote(l.body)).join("\n\n").replace(/^#\s/gm, "### ");
      if (disc) {
        disc.body = `${disc.body}\n\n## Limitations of the study\n\n${text}`;
        actions.push('Moved "Limitations of the study" to the end of the Discussion.');
      } else sections.push({ role: "discussion", heading: "Discussion", attrs: "", body: `## Limitations of the study\n\n${text}` });
    } else if (disc && !/^##\s+limitations/im.test(disc.body)) {
      problems.push('Cell requires a "Limitations of the study" subsection at the end of the Discussion.');
    }
    // Resource availability from its parts.
    const ra = take("resource-availability");
    const leadSec = take("lead-contact");
    const mat = take("materials-availability");
    const data = take("data-availability");
    const code = take("code-availability");
    const raBody = ra.map((x) => x.body).join("\n\n");
    const sub = (name: string) => new RegExp(`^##\\s+${name}\\b`, "im").test(raBody);
    const parts: string[] = [];
    if (raBody.trim()) parts.push(raBody.trim());
    const leadAuthor = authors.find((a) => a.lead) ?? authors.find((a) => a.corresponding);
    if (!sub("lead contact")) {
      if (leadSec.length) parts.push(`## Lead contact\n\n${leadSec.map((x) => x.body.trim()).join("\n\n")}`);
      else if (leadAuthor) {
        parts.push(`## Lead contact\n\nRequests for further information and resources should be directed to and will be fulfilled by the lead contact, ${md(leadAuthor.name)}${leadAuthor.email ? ` (${md(leadAuthor.email)})` : ""}.`);
        actions.push("Wrote the Lead contact sentence from the front matter (Cell's standard wording).");
      } else problems.push("RESOURCE AVAILABILITY: no lead contact (front matter `lead-contact: true`, or a \"Lead contact\" section).");
    }
    if (!sub("materials availability")) {
      if (mat.length) parts.push(`## Materials availability\n\n${mat.map((x) => x.body.trim()).join("\n\n")}`);
      else problems.push('RESOURCE AVAILABILITY: no "Materials availability" statement (e.g. "This study did not generate new materials.").');
    }
    if (!sub("data and code availability")) {
      const dc = [...data, ...code].map((x) => x.body.trim()).filter(Boolean);
      if (dc.length) {
        parts.push(`## Data and code availability\n\n${dc.join("\n\n")}`);
        if (!/additional information/i.test(dc.join(" "))) problems.push('Data and code availability: Cell asks for three bullets — data, code, and "Any additional information required to reanalyze the data reported in this paper is available from the lead contact upon request."');
      }
      else problems.push('RESOURCE AVAILABILITY: no "Data and code availability" statement (Cell asks for three bullets: data, code, and "Any additional information…").');
    }
    sections.push({ role: "resource-availability", heading: "Resource availability", attrs: "", body: parts.join("\n\n") });
    // Funding belongs in the Acknowledgments.
    const funding = take("funding");
    if (funding.length) {
      const ack = sections.find((x) => x.role === "acknowledgements");
      const ftext = funding.map((x) => x.body.trim()).join("\n\n");
      if (ack) ack.body = `${ack.body.trim()}\n\n${ftext}`;
      else sections.push({ role: "acknowledgements", heading: "Acknowledgments", attrs: "", body: ftext });
      actions.push("Folded the Funding section into ACKNOWLEDGMENTS (Cell has no separate funding section).");
    }
    // STAR Methods.
    for (const m of sections.filter((x) => x.role === "methods")) m.body = starMethods(m.body, problems);
    // Keywords from the front matter, if the manuscript does not carry its own.
    if (keywords.length && !sections.some((x) => x.role === "keywords")) {
      sections.push({ role: "keywords", heading: "Keywords", attrs: "", body: keywords.map(md).join(", ") });
    }
    if (input.supplementaryFigures && !sections.some((x) => x.role === "supplementary")) {
      const n = input.supplementaryFigures;
      sections.push({ role: "supplementary", heading: "Supplemental information", attrs: "", body: `Document S1. ${n > 1 ? `Figures S1–S${n}` : "Figure S1"}` });
      actions.push("Listed the supplemental figures under SUPPLEMENTAL INFORMATION (Document S1).");
    }
  }

  // Science: the acknowledgment statements become run-in paragraphs.
  if (spec.runIn) {
    const ri = spec.runIn;
    const parent = take(ri.parent);
    const children: string[] = [];
    // Data and code availability share one Science paragraph.
    const dataLike = take("data-availability").concat(take("code-availability")).concat(take("materials-availability"));
    for (const c of ri.children) {
      const found = c.role === "data-availability" ? dataLike : take(c.role);
      const text = found.map((x) => x.body.trim()).filter(Boolean).join("\n\n");
      if (text) children.push(runIn(c.label, text));
      else if (spec.required.some((r) => r.role === c.role)) problems.push(`Acknowledgments: no "${c.label.replace(/:$/, "")}" statement.`);
    }
    const general = parent.map((x) => x.body.trim()).filter(Boolean).join("\n\n");
    const all = [general ? runIn(ri.heading, general) : `**${ri.heading}**`, ...children].filter(Boolean).join("\n\n");
    sections.push({ role: ri.parent, heading: "", attrs: "", body: div(styles.acknowledgement, all) });
  }

  // Science: the Supplementary Materials list (template SOMHead/SOMContent).
  if (spec.titleBlock === "science" && input.supplementaryFigures && !sections.some((x) => x.role === "supplementary")) {
    const n = input.supplementaryFigures;
    sections.push({ role: "supplementary", heading: "Supplementary Materials", attrs: "", body: div("SOMContent", n > 1 ? `Figs. S1 to S${n}` : "Fig. S1") });
    actions.push("Listed the supplementary figures under Supplementary Materials — add Materials and Methods, tables, movies and \"References (n–m)\" lines as they apply.");
  }

  // Nature: the Additional information block from metadata when absent.
  if (spec.titleBlock === "nature" && !sections.some((x) => x.role === "additional-information")) {
    const corr = authors.filter((a) => a.corresponding).map((a) => md(a.name));
    const lines: string[] = [];
    if (input.supplementaryFigures) lines.push("Supplementary Information is available for this paper.");
    if (corr.length) lines.push(`Correspondence and requests for materials should be addressed to ${corr.length > 1 ? `${corr.slice(0, -1).join(", ")} or ${corr[corr.length - 1]}` : corr[0]}.`);
    if (lines.length) {
      sections.push({ role: "additional-information", heading: "Additional information", attrs: "", body: lines.join(" ") });
      actions.push("Wrote the Additional information block (supplementary line + correspondence) from the front matter.");
    }
  }

  // ---- required statements
  for (const r of spec.required) {
    if (r.stage === "final" && stage !== "final") continue;
    if (spec.runIn?.children.some((c) => c.role === r.role)) continue; // reported above
    if (spec.titleBlock === "cell" && ["data-availability", "code-availability", "materials-availability", "lead-contact"].includes(r.role)) continue;
    if (!sections.some((x) => x.role === r.role)) problems.push(`No "${r.label}" section.`);
  }

  // ---- order + headings
  const order = spec.order;
  const authoredOrder = sections.map((x) => x.heading);
  if (order.length) {
    const rank = new Map(order.map((r, i) => [r, i]));
    const bodyRank = rank.get("body") ?? 0;
    sections = sections
      .map((x, i) => ({ x, i }))
      .sort((a, z) => (rank.get(a.x.role) ?? bodyRank) - (rank.get(z.x.role) ?? bodyRank) || a.i - z.i)
      .map((v) => v.x);
  }
  const movedSections = sections.map((x) => x.heading).filter((h, i) => h && authoredOrder.indexOf(h) !== i && authoredOrder.includes(h));

  // ---- legends section (legends-only placement)
  const mainLegends = legends.filter((l) => l.family === "figure").sort((a, z) => a.number - z.number);
  const edLegends = legends.filter((l) => l.family === "extended-data").sort((a, z) => a.number - z.number);
  const otherLegends = legends.filter((l) => l.family !== "figure" && l.family !== "extended-data");
  if (placement === "legends-only" && legends.length) {
    const legendBlock = (ls: Legend[]) => ls.map((l) => div(styles.legend, l.text)).join("\n\n");
    const ins = (role: string, heading: string, ls: Legend[]) => {
      if (!ls.length) return;
      const at = sections.findIndex((x) => (order.indexOf(x.role) > order.indexOf(role)) && order.indexOf(role) >= 0);
      const sec = { role, heading, attrs: "", body: legendBlock(ls) };
      if (at < 0) sections.push(sec);
      else sections.splice(at, 0, sec);
    };
    if (!sections.some((x) => x.role === "figure-legends")) ins("figure-legends", spec.legendsHeading, mainLegends.concat(otherLegends));
    if (edLegends.length) ins("extended-data", spec.titleBlock === "nature" ? "Extended Data" : "Extended Data figure legends", edLegends);
    actions.push(`Removed the figure images and listed ${legends.length} legend${legends.length === 1 ? "" : "s"} under "${spec.legendsHeading}" (upload each figure as its own file).`);
  }
  if (otherLegends.length && spec.titleBlock !== "preprint") {
    problems.push(`${otherLegends.length} supplementary figure${otherLegends.length === 1 ? " is" : "s are"} embedded in the main manuscript — ${spec.titleBlock === "nature" ? "Nature prints extra figures as Extended Data, not supplementary figures" : spec.titleBlock === "science" ? "Science puts them in the Supplementary Materials file" : "Cell puts them in the supplemental PDF (Document S1)"}.`);
  }

  // ---- references placeholder(s)
  const REFS_MAIN = "\u0003FLUX-REFS-MAIN\u0003";
  const REFS_SPLIT = "\u0003FLUX-REFS-SPLIT\u0003";
  const SPLIT_AT = "\u0003FLUX-SPLIT-AT\u0003";
  let refsSec = sections.find((x) => x.role === "references");
  if (refsSec && !isBlank(refsSec.body) && !/::: *\{#refs\}/.test(refsSec.body) && spec.citations === "literal") {
    problems.push("Your References section has text of its own — Flux kept it above the generated list. Delete hand-written entries before submitting.");
  }
  if (!refsSec) {
    refsSec = { role: "references", heading: spec.referencesHeading, attrs: "", body: "" };
    const rank = new Map(order.map((r, i) => [r, i]));
    const at = order.length ? sections.findIndex((x) => (rank.get(x.role) ?? rank.get("body") ?? 0) > (rank.get("references") ?? Infinity)) : -1;
    if (at < 0) sections.push(refsSec);
    else sections.splice(at, 0, refsSec);
  }

  // ---- render sections
  const renderSection = (x: Section): string => {
    let inner = x.body;
    if (x.role === "references") {
      const own = isBlank(inner) || /::: *\{#refs\}/.test(inner) ? "" : `${inner.trim()}\n\n`;
      inner = spec.citations === "literal" ? `${own}${REFS_MAIN}` : `${own}::: {#refs}\n:::`;
    }
    if (spec.splitReferences && x.role === spec.splitReferences.afterRole) inner = `${inner}\n\n${REFS_SPLIT}`;
    const drop = spec.dropHeadings.includes(x.role);
    if (drop) {
      actions.push(`Dropped the "${x.heading}" heading (${style.name} prints none); its text and subheadings are kept.`);
      return promote(inner);
    }
    if (!x.heading) return inner;
    let heading = spec.renameHeadings[x.role] ?? x.heading;
    if (x.role === "references") heading = spec.referencesHeading;
    if (spec.headingCase === "upper") heading = heading.toUpperCase();
    return `# ${heading}${x.attrs ? ` ${x.attrs}` : ""}\n\n${inner}`.trimEnd();
  };
  // A heading-dropped role whose run of sections follows directly: fine as is.
  let mainParts = sections.map((x) => {
    const r = renderSection(x);
    return spec.splitReferences && x.role === "methods" ? `${SPLIT_AT}\n\n${r}` : r;
  });
  let assembled = mainParts.filter((p) => !isBlank(p)).join("\n\n");
  if (spec.headingCase === "upper") assembled = upperHeadings(assembled);
  if (spec.mainTextLabel) assembled = `${div(styles.label, `**${spec.mainTextLabel}**`)}\n\n${assembled}`;

  // ---- front blocks: title page, abstract, teaser, keywords
  const front: string[] = [];
  if (!manualTitle) {
    const tb = titleBlock(spec, styles, title, authors, affiliations);
    if (tb.text) front.push(tb.text);
    problems.push(...tb.notes);
  } else if (keepPreamble) front.push(keepPreamble), (keepPreamble = "");
  if (keepPreamble) front.push(keepPreamble);
  if (abstract) {
    const a = spec.abstract;
    if (a.heading) {
      const h = spec.headingCase === "upper" ? a.heading.toUpperCase() : a.heading;
      front.push(`# ${h} {.unnumbered}\n\n${div(styles.abstract, abstract)}`);
    } else if (a.label) front.push(div(styles.abstract, runIn(a.label, abstract)));
    else front.push(div(styles.abstract, a.bold ? abstract.split(/\n{2,}/).map((p) => `**${p.trim()}**`).join("\n\n") : abstract));
  }
  if (spec.titleBlock === "science" && teaser) front.push(div(styles.teaser, runIn("One-Sentence Summary:", md(teaser))));
  let text = [...front, assembled].join("\n\n");

  // ---- citations + reference lists
  let mainList = 0;
  let secondList = 0;
  let citeStats = { cited: 0, groups: 0, missing: [] as string[], notes: 0 };
  if (spec.citations === "literal") {
    const r = literalizeCitations(text, {
      spec: style.citations.numeric,
      records: input.records,
      notesInReferences: spec.footnotes === "notes-in-references",
      wrap: input.wrapCitation,
    });
    text = r.text;
    const layout = style.referenceList.layout as RefLayout;
    const byOrdinal = new Map<number, string>();
    for (const [key, n] of r.ordinals) byOrdinal.set(n, formatJournalReference(input.records[key], layout));
    for (const [n, note] of r.notes) byOrdinal.set(n, note.trim().replace(/\n+/g, " "));
    const total = byOrdinal.size;
    const splitAt = text.indexOf(SPLIT_AT);
    let firstSecond = total + 1;
    if (spec.splitReferences && splitAt >= 0) {
      for (let n = 1; n <= total; n++) {
        if ((r.firstAt.get(n) ?? 0) >= splitAt) {
          firstSecond = n;
          break;
        }
      }
    }
    // Literal numbers, not a Word auto-numbered list: the ordinals are OURS
    // (split lists start mid-sequence, Science notes interleave), and a literal
    // "12.<tab>" renders the same in Word, LibreOffice and a journal's converter.
    // The tab lands on the style's hanging indent; the PDF path hangs it in Lua.
    const TAB = "`<w:r><w:tab/></w:r>`{=openxml}`\\hspace{0.6em}`{=latex}";
    const list = (from: number, to: number) => {
      const items: string[] = [];
      for (let n = from; n <= to; n++) items.push(div(styles.bibliography, `${n}.${TAB}${byOrdinal.get(n) ?? ""}`));
      return items.join("\n\n");
    };
    mainList = Math.min(total, firstSecond - 1);
    secondList = total - mainList;
    text = text.replace(REFS_MAIN, mainList ? list(1, mainList) : "");
    const second = secondList ? `${spec.splitReferences?.heading ? `# ${spec.splitReferences.heading}\n\n` : ""}${list(firstSecond, total)}` : "";
    text = text.replace(REFS_SPLIT, second);
    citeStats = { cited: r.ordinals.size, groups: r.groups, missing: r.missing, notes: r.notes.size };
    if (r.missing.length) problems.push(`${r.missing.length} citation key${r.missing.length === 1 ? "" : "s"} not in the bibliography (shown as [?key]): ${r.missing.slice(0, 8).join(", ")}${r.missing.length > 8 ? "…" : ""}.`);
    if (secondList) actions.push(`Numbered the ${secondList} reference${secondList === 1 ? "" : "s"} first cited in the Methods on from the main list, in a second list after the Methods (${style.name} style).`);
    if (r.notes.size) actions.push(`Turned ${r.notes.size} footnote${r.notes.size === 1 ? "" : "s"} into numbered notes in References and Notes.`);
    if (r.annotated) actions.push(`${r.annotated} citation${r.annotated === 1 ? "" : "s"} with a prefix or locator were written out ("see ref. 4, p. 12").`);
  }
  text = text.replace(SPLIT_AT, "").replace(/\n{3,}/g, "\n\n");

  // ---- front matter for the render
  const fm: Record<string, unknown> = { ...meta };
  for (const k of ["title", "subtitle", "author", "authors", "affiliations", "abstract", "date", "highlights", "etoc", "in-brief", "etoc-blurb", "keywords", "one-sentence-summary", "teaser", "toc", "number-sections"]) delete fm[k];
  if (title) fm["pagetitle"] = title;
  // The venue's page setup, reference doc, Lua filter and crossref wording.
  const render = journalRenderMeta(style, { docDir: input.docDir ?? "" });
  const authorFormat = fm.format && typeof fm.format === "object" ? (fm.format as Record<string, unknown>) : {};
  // The author's own Pandoc filters run first; the venue's Lua filter is appended.
  const authorFilters = Array.isArray(fm.filters) ? fm.filters : fm.filters != null ? [fm.filters] : [];
  Object.assign(fm, render, {
    format: { ...authorFormat, ...(render.format as Record<string, unknown>) },
    filters: [...authorFilters, ...((render.filters as unknown[]) ?? [])],
  });
  if (spec.citations === "literal") {
    delete fm.bibliography;
    delete fm.csl;
    delete fm["citation-style"];
    fm.citeproc = false;
    fm["suppress-bibliography"] = true;
  }
  const head = Object.keys(fm).length ? `---\n${yaml.dump(fm, { lineWidth: -1 })}---\n\n` : "";

  const footnoteCount = (text.match(/\^\[/g) ?? []).length;
  if (footnoteCount && spec.footnotes === "keep" && spec.titleBlock === "nature") problems.push(`${footnoteCount} footnote${footnoteCount === 1 ? "" : "s"} — Nature does not use footnotes; fold them into the text.`);
  else if (footnoteCount && spec.footnotes === "keep" && style.citations.numeric.presentation === "superscript" && spec.citations === "literal")
    problems.push(`${footnoteCount} footnote${footnoteCount === 1 ? "" : "s"} — footnote numbers are superscripts, like ${style.name}'s citations; fold them into the text.`);
  const marks = (text.match(/\]\{\.mark\}/g) ?? []).length;
  if (marks) problems.push(`${marks} highlighted ([…]{.mark}) passage${marks === 1 ? "" : "s"} still in the text.`);

  let mainTextWords = sections.filter((x) => MAIN_TEXT_ROLES.includes(x.role)).reduce((n, x) => n + words(x.body), 0);
  if (spec.titleBlock === "nature") mainTextWords += words(abstract); // Nature counts the summary paragraph
  if (spec.titleBlock === "cell") mainTextWords += mainLegends.reduce((n, l) => n + words(l.caption), 0); // Cell counts main legends
  const methodsWords = sections.filter((x) => x.role === "methods").reduce((n, x) => n + words(x.body), 0);
  const tables = (src.match(/^:\s.*\{#tbl-[^}]*\}\s*$/gm) ?? []).length;
  const counts = {
    mainTextWords,
    methodsWords,
    legendWords: legends.map((l) => ({ label: `${l.family === "figure" ? "Figure" : l.family} ${l.number}`, words: words(l.caption), extended: l.family !== "figure" })),
    displayItems: mainLegends.length + tables,
    tables,
  };

  return {
    text: head + text.trim() + "\n",
    report: {
      actions: [...new Set(actions)],
      problems: [...new Set(problems)],
      citations: { ...citeStats, mainList, secondList },
      figures: { inline: placement === "inline" ? legends.length : 0, legends: legends.length },
      movedSections,
      meta: { title, abstractWords: words(abstract), authors: authors.length, highlights, etoc, keywords, teaser },
      roles: [...new Set(sections.map((x) => x.role))],
      counts,
    },
  };
}
