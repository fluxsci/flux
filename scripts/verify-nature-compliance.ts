#!/usr/bin/env -S npx tsx
// Journal Check (src/lib/manuscript/compliance.ts).
//
// Every rule gets a firing fixture AND a silent one — a checker that cries wolf
// is worse than none, because authors stop reading it.
//
// The load-bearing case is `authorAdjacent`: the real manuscript that drove
// this design says "Gao Figure 2D establishes column-level modular diversity",
// which is a reference to ANOTHER paper's figure. It must stay silent there.
//   Run: npx tsx scripts/verify-nature-compliance.ts
import { checkCompliance, sortFindings } from "../src/lib/manuscript/compliance";
import { NATURE_ROLE_ALIASES } from "../src/lib/manuscript/sections";
import { resolveJournalStyle } from "../src/lib/style/journalStyle";
import { BUILTIN_JOURNAL_STYLES } from "../src/lib/style/journalPresets";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("  ok:", msg);
}

const style = resolveJournalStyle("nature", BUILTIN_JOURNAL_STYLES);
const run = (doc: string, extra: Record<string, unknown> = {}) =>
  checkCompliance({ doc, style, aliases: NATURE_ROLE_ALIASES, ...extra });
const ids = (doc: string, extra?: Record<string, unknown>) => run(doc, extra).map((f) => f.ruleId);
const has = (doc: string, id: string, extra?: Record<string, unknown>) => ids(doc, extra).includes(id);

// --- THE case that shaped the design ----------------------------------------
{
  // Verbatim shapes from the real manuscript.
  const other = [
    "### Gao Figure 2D establishes column-level modular diversity",
    "",
    "Gao et al. partitioned cortex into 255 columns [@gao2026]. Figure 2D therefore",
    "supports a precise statement about prefrontal columns.",
    "",
    "An exact Figure 2D replication requires the authors' column labels.",
  ].join("\n");
  const found = run(other).filter((f) => f.ruleId === "fig.literal-house-style");
  assert(found.length === 0,
    `"Gao Figure 2D" — another paper's figure — raises NO house-style advice (got ${found.length})`);

  // The same literal WITHOUT an adjacent author is fair game to advise on.
  assert(has("We show this in Figure 2D here.", "fig.literal-house-style"),
    "…while a bare mid-sentence 'Figure 2D' does get advice");
  assert(!has("Smith et al. Fig. 3A shows this.", "fig.literal-house-style"),
    "an 'et al.' before the reference also suppresses it");
  assert(!has("As reported previously [@key] Figure 1A.", "fig.literal-house-style"),
    "a closing citation bracket before the reference suppresses it");
}

// --- literal figure references ------------------------------------------------
{
  const f = run("We show this in Fig. 1A, B here.").find((x) => x.ruleId === "fig.literal-house-style")!;
  assert(!!f, "capital panel letters + spaced list are flagged");
  assert(f.suggestion === "Fig. 1a,b", `the suggestion is Nature's form (got ${f.suggestion})`);
  assert(f.severity === "info", "it is ADVICE, never a warning — Flux does not rewrite prose");

  const hy = run("See Fig. 2a-c for details.").find((x) => x.ruleId === "fig.literal-house-style")!;
  assert(hy?.suggestion === "Fig. 2a–c", `a hyphen range is advised as an en dash (got ${hy?.suggestion})`);

  // Silent cases.
  assert(!has("See Fig. 1a,b for details.", "fig.literal-house-style"),
    "a reference ALREADY in house form is silent");
  assert(!has("Figure 1 shows the result.", "fig.literal-house-style"),
    "sentence-initial 'Figure' is correct and stays silent");
  assert(!has("Text with `Fig. 1A` in code.", "fig.literal-house-style"),
    "a reference inside inline code is masked");
  assert(!has("Fig. 1 | A caption lead.", "fig.literal-house-style"),
    "Flux's own generated caption lead is not advised against");
}

// --- headings ------------------------------------------------------------------
{
  assert(has("# Results\n\nx", "heading.forbidden"),
    "a 'Results' heading is flagged (0/61 Nature papers print one)");
  assert(has("# Introduction\n\nx", "heading.forbidden"), "'Introduction' likewise");
  assert(!has("# Pupil dynamics reveal sleep microstructure\n\nx", "heading.forbidden"),
    "a descriptive subheading — the form Nature actually uses — is silent");
  assert(!has("# Discussion\n\nx", "heading.forbidden"), "'Discussion' is legitimate and silent");
  assert(has(`# A\n\n## ${"x".repeat(60)}\n\nbody`, "heading.subhead-too-long"),
    "an over-long subheading is flagged");
}

// --- summary paragraph ---------------------------------------------------------
{
  const short = "---\ntitle: t\n---\n\n" + "word ".repeat(150) + "\n\n# Body\n\nx";
  const over = "---\ntitle: t\n---\n\n" + "word ".repeat(240) + "\n\n# Body\n\nx";
  const wayOver = "---\ntitle: t\n---\n\n" + "word ".repeat(330) + "\n\n# Body\n\nx";
  assert(!has(short, "abstract.too-long"), "a 150-word summary is silent");
  const o = run(over).find((f) => f.ruleId === "abstract.too-long")!;
  assert(o && o.severity === "info", "past 200 words it is INFO (Nature allows up to 300 with a closing passage)");
  const w = run(wayOver).find((f) => f.ruleId === "abstract.too-long")!;
  assert(w && w.severity === "warn", "past the 300-word ceiling it becomes a warning");
}

// --- title ---------------------------------------------------------------------
{
  const long = `---\ntitle: "${"a".repeat(90)}"\n---\n\nbody`;
  assert(has(long, "title.too-long"), "a 90-character title exceeds the 75-character limit");
  assert(!has('---\ntitle: "A short title"\n---\n\nbody', "title.too-long"), "a short title is silent");
}

// --- required sections + stage scaling -----------------------------------------
{
  const bare = "---\ntitle: t\n---\n\nlead\n\n# A finding\n\nx";
  const initial = run(bare, { stage: "initial" }).filter((f) => f.ruleId.startsWith("section.missing"));
  const final = run(bare, { stage: "final" }).filter((f) => f.ruleId.startsWith("section.missing"));
  assert(initial.length > 0 && initial.every((f) => f.severity === "info"),
    "missing sections are INFO at initial submission — Nature is explicitly format-flexible there");
  assert(final.length === initial.length && final.every((f) => f.severity === "warn"),
    "…and become warnings at the final/acceptance stage");
  assert(initial.some((f) => f.ruleId === "section.missing.methods"), "Methods is among them");

  const full = [
    "---", "title: t", "---", "", "lead", "",
    "# A finding", "x", "", "# Methods", "m", "", "# Data availability", "d", "",
    "# Code availability", "c", "", "# Author contributions", "a", "", "# Competing interests", "n",
  ].join("\n");
  assert(run(full, { stage: "final" }).filter((f) => f.ruleId.startsWith("section.missing")).length === 0,
    "a complete manuscript raises no missing-section findings at all");
}

// --- budgets --------------------------------------------------------------------
{
  assert(has("---\ntitle: t\n---\n\nlead\n\n# A\n\nx", "display-items.too-many", { figureCount: 12 }),
    "12 display items exceeds Nature's budget");
  assert(!has("---\ntitle: t\n---\n\nlead\n\n# A\n\nx", "display-items.too-many", { figureCount: 5 }),
    "5 display items is fine");
  assert(has("---\ntitle: t\n---\n\nlead\n\n# A\n\nx", "refs.too-many", { mainRefCount: 62 }),
    "62 main-text references exceeds the cap of 50");
  assert(!has("---\ntitle: t\n---\n\nlead\n\n# A\n\nx", "refs.too-many", { mainRefCount: 40 }),
    "40 references is fine");
  const m = run("---\ntitle: t\n---\n\nlead\n\n# Methods\n\n" + "word ".repeat(3200));
  assert(m.some((f) => f.ruleId === "methods.too-long"), "an over-long Methods is flagged");
}

// --- statistics ------------------------------------------------------------------
{
  const f = run("The effect was significant (p = 0.03).").find((x) => x.ruleId === "stats.p-lowercase")!;
  assert(!!f && f.suggestion === "P = 0.03", "a lowercase p value is advised as capital P");
  assert(!has("The effect was significant (P = 0.03).", "stats.p-lowercase"), "a capital P is silent");
  assert(has("Significant at P < 0.05.", "stats.inexact-p"), "a P threshold prompts for an exact value");
  assert(!has("Significant at P = 0.031.", "stats.inexact-p"), "an exact P value is silent");
  assert(!has("Set `p = 0.03` in the config.", "stats.p-lowercase"), "inline code is masked");
}

// --- nothing blocks --------------------------------------------------------------
{
  const all = run("# Results\n\nSee Fig. 1A, B (p = 0.03).");
  assert(all.length > 0, "the sweep does find things in a non-compliant document");
  assert(all.every((f) => f.severity === "info" || f.severity === "warn"),
    "NO finding is ever an error — the checker cannot block an export");
  assert(sortFindings(all)[0].severity === "warn", "sorting puts warnings first");
  // A clean, compliant document should be quiet.
  const clean = [
    "---", 'title: "A concise declarative title"', "---", "",
    "A short summary paragraph.", "",
    "# A descriptive finding", "", "The result held (P = 0.031) as shown in Fig. 1a,b.", "",
    "# Discussion", "", "It means something.", "",
    "# Methods", "", "How.", "", "# Data availability", "", "Here.", "",
    "# Code availability", "", "Here.", "", "# Author contributions", "", "All.", "",
    "# Competing interests", "", "None.",
  ].join("\n");
  assert(run(clean, { stage: "final", figureCount: 4, mainRefCount: 30 }).length === 0,
    `a compliant manuscript produces ZERO findings (got ${JSON.stringify(ids(clean, { stage: "final", figureCount: 4, mainRefCount: 30 }))})`);
}

console.log("\nNATURE-COMPLIANCE VERIFY: PASS");
