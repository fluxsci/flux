#!/usr/bin/env -S npx tsx
// Pure safety + ranking gate for Paper's on-device correction fabric.
import { readFileSync } from "node:fs";
import { harness } from "./lib/harness.mjs";
import {
  correctionPairKey,
  damerauLevenshtein,
  extractCorrectionWindow,
  extractProjectVocabulary,
  planLocalCorrections,
  protectedMarkdownRanges,
  type LocalLintRecord,
} from "../src/shell/modes/paper/editing/localCorrectionCore";
import {
  clearLocalCorrectionProfiles,
  LocalCorrectionProfile,
} from "../src/shell/modes/paper/editing/localCorrectionProfile";

const h = harness("verify-local-corrections");
const lint = (
  source: string,
  problem: string,
  kind: string,
  suggestions: string[],
): LocalLintRecord => {
  const from = source.indexOf(problem);
  return { from, to: from + problem.length, problem, kind, suggestions, message: "candidate" };
};

h.section("mechanical ranking");
{
  const source = "The chemical structure is a very compelx o bject.";
  const plans = planLocalCorrections(source, [
    lint(source, "compelx", "Spelling", ["compel", "complex", "compels"]),
    lint(source, "o bject", "WordChoice", ["object"]),
  ]);
  h.eq(plans.map((p) => [p.original, p.replacement]), [
    ["compelx", "complex"],
    ["o bject", "object"],
  ], "the product example resolves to complex object (not Harper's first compel candidate)");
  h.ok(damerauLevenshtein("compelx", "complex") === 1, "adjacent transposition is one edit");
}
{
  const cases: Array<[string, string, string[], string]> = [
    ["This is teh result.", "teh", ["the"], "the"],
    ["This occured yesterday.", "occured", ["occurred", "occur", "obscured"], "occurred"],
    ["The experiemnt worked.", "experiemnt", ["experiment", "expedient"], "experiment"],
    ["The signal was recoreded.", "recoreded", ["recorded", "recorder", "receded"], "recorded"],
    ["The objectis complex.", "objectis", ["object is"], "object is"],
  ];
  for (const [source, problem, suggestions, expected] of cases) {
    const kind = problem === "teh" || problem === "objectis" ? "Typo" : "Spelling";
    h.eq(planLocalCorrections(source, [lint(source, problem, kind, suggestions)])[0]?.replacement, expected, `${problem} → ${expected}`);
  }
}

h.section("scientific and semantic restraint");
{
  const source = "We used iGluSnFR4f, jRGECO1a, SLAP2, NREM, and 5 Hz.";
  const records = ["iGluSnFR4f", "jRGECO1a", "SLAP2", "NREM"].map((word) =>
    lint(source, word, "Spelling", ["slap", "name"]),
  );
  h.eq(planLocalCorrections(source, records), [], "mixed-case, acronym, and digit-bearing scientific tokens never auto-change");
}
{
  const source = "The result was very unique.";
  h.eq(
    planLocalCorrections(source, [lint(source, "very unique", "WordChoice", ["unique", "very rare"])]),
    [],
    "style/semantic WordChoice suggestions never auto-rewrite prose",
  );
}
{
  const source = "The treatment did not increase firing by 5 Hz.";
  h.eq(
    planLocalCorrections(source, [lint(source, "not", "Spelling", ["now"])]),
    [],
    "an ambiguous real-word-like substitution is below the automatic confidence margin",
  );
}
{
  const source = "The soma depolarized.";
  h.eq(
    planLocalCorrections(source, [lint(source, "soma", "Typo", ["so ma"])]),
    [],
    "short scientific words are not split merely because Harper sees two common fragments",
  );
}
{
  const records = [
    ["The timepoint was fixed.", "timepoint", "time point"],
    ["The brainstem was sectioned.", "brainstem", "brain stem"],
    ["The wildtype mice were controls.", "wildtype", "wild type"],
  ] as const;
  h.ok(
    records.every(([source, problem, suggestion]) =>
      planLocalCorrections(source, [lint(source, problem, "Typo", [suggestion])]).length === 0),
    "scientific compound styling is never rewritten as a missing-space typo",
  );
}
{
  const source = "The somata depolarized.";
  h.eq(
    planLocalCorrections(source, [lint(source, "somata", "Spelling", ["sonata", "samara", "strata"])]),
    [],
    "an unfamiliar scientific word is not converted to a nearby common word",
  );
}

h.section("protected manuscript syntax");
{
  const source = "Use `compelx`, $compelx$, @compelx, {#compelx}, and https://x.test/compelx.";
  const records: LocalLintRecord[] = [];
  let from = source.indexOf("compelx");
  while (from >= 0) {
    records.push({ from, to: from + 7, problem: "compelx", kind: "Spelling", message: "", suggestions: ["complex"] });
    from = source.indexOf("compelx", from + 1);
  }
  h.eq(planLocalCorrections(source, records), [], "code, math, citations, attributes, and URLs are protected");
  h.ok(protectedMarkdownRanges(source).length >= 5, "protection scanner identifies every syntax family");
}
{
  const source = "We used the data set for analysis.";
  const record = { ...lint(source, "data set", "WordChoice", ["dataset"]), partsAreKnown: true };
  h.eq(planLocalCorrections(source, [record]), [], "two valid words are not silently merged as a style choice");
}
{
  const source = "| compelx | value |";
  h.eq(planLocalCorrections(source, [lint(source, "compelx", "Spelling", ["complex"])]), [], "table lines are protected from background rewriting");
}

h.section("profile learning");
{
  const map = new Map<string, string>();
  const storage = {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
  };
  const profile = new LocalCorrectionProfile("project-a", storage);
  profile.block("compelx", "complex");
  profile.addWord("iGluSnFR4f");
  const reloaded = new LocalCorrectionProfile("project-a", storage);
  h.ok(reloaded.blockedPairs().has(correctionPairKey("compelx", "complex")), "reverted pair persists per project");
  h.eq(reloaded.words(), ["iGluSnFR4f"], "explicit project dictionary persists");
  const source = "A very compelx object.";
  h.eq(
    planLocalCorrections(source, [lint(source, "compelx", "Spelling", ["complex"])], { blockedPairs: reloaded.blockedPairs() }),
    [],
    "a learned veto prevents the correction",
  );
  h.eq(new LocalCorrectionProfile("project-b", storage).words(), [], "dictionary decisions do not leak between projects");
  clearLocalCorrectionProfiles({ removeItem: (key: string) => void map.delete(key) });
  const reset = new LocalCorrectionProfile("project-a", storage);
  h.ok(reset.words().length === 0 && reset.blockedPairs().size === 0, "reset clears learned words and vetoes");
}

h.section("windowing and vocabulary");
{
  const doc = "Previous sentence. The structure is compelx. Next";
  const end = doc.indexOf(" Next");
  h.eq(extractCorrectionWindow(doc, end)?.text, "The structure is compelx.", "only the current completed sentence is submitted");
  h.ok((extractCorrectionWindow("x".repeat(700) + " compelx", 708)?.text.length ?? 0) <= 480, "correction context is hard-capped");
}
{
  const words = extractProjectVocabulary([
    "NREM iGluSnFR4f SLAP2 glutamate glutamate glutamate oneoff",
  ]);
  h.ok(words.includes("NREM") && words.includes("iGluSnFR4f") && words.includes("SLAP2"), "technical forms enter the project vocabulary immediately");
  h.ok(words.includes("glutamate") && !words.includes("oneoff"), "ordinary terms require recurrence before learning");
}

h.section("architecture pins");
{
  const worker = readFileSync("src/shell/modes/paper/editing/localCorrection.worker.ts", "utf8");
  const editor = readFileSync("src/shell/modes/paper/editing/localCorrections.ts", "utf8");
  const service = readFileSync("src/shell/modes/paper/editing/localCorrectionService.ts", "utf8");
  h.ok(/new LocalLinter/.test(worker) && !/new LocalLinter/.test(editor), "Harper/WASM construction stays in the dedicated worker");
  h.ok(/new Worker\(new URL/.test(service), "renderer orchestration uses a module worker");
  h.ok(/isolateHistory\.of\("full"\)/.test(editor), "automatic corrections are isolated into one exact undo step");
  h.ok(/input\.type\.compose/.test(editor), "IME composition is explicitly excluded");
  h.ok(!/fetch\(|https?:\/\//.test(worker + service), "local correction code contains no cloud/network path");
}

await h.done();
