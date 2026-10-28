#!/usr/bin/env -S npx tsx
// Pure safety + ranking gate for Paper's on-device correction fabric.
import { readFileSync } from "node:fs";
import { harness } from "./lib/harness.mjs";
import {
  correctionPairKey,
  damerauLevenshtein,
  extractCorrectionWindow,
  extractProjectVocabulary,
  generateMechanicalRescueVariants,
  planExplicitVocabularyCorrections,
  planLocalCorrections,
  protectedMarkdownRanges,
  scopeWindowLints,
  withinFocus,
  type LocalLintRecord,
} from "../src/shell/modes/paper/editing/localCorrectionCore";
import {
  clearLocalCorrectionLearning,
  clearLocalCorrectionProfiles,
  LocalCorrectionProfile,
} from "../src/shell/modes/paper/editing/localCorrectionProfile";
import {
  backlogScanWindows,
  classifyTypedBoundaries,
  extractCompletedWordWindow,
  extractSentenceWindow,
  isSentenceBoundaryAt,
  windowStartsSentence,
} from "../src/shell/modes/paper/editing/localCorrectionBoundary";
import { normalizeSpellingCandidates } from "../src/shell/modes/paper/editing/localSpelling";
import { SCIENTIFIC_VOCABULARY } from "../src/shell/modes/paper/editing/scientificVocabulary";

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
  h.ok(generateMechanicalRescueVariants("wayus").includes("ways"), "the bounded one-edit neighborhood contains the missing Harper candidate");
}
{
  const source = "This makes everhthing easier.";
  h.eq(
    planLocalCorrections(source, [lint(source, "everhthing", "Spelling", ["everything", "ever thing"])])[0]?.replacement,
    "everything",
    "a long dominant adjacent-key substitution is immediate",
  );
  const scientific = "The somata depolarized.";
  h.eq(
    planLocalCorrections(scientific, [lint(scientific, "somata", "Spelling", ["sonata"])]),
    [],
    "a short adjacent-key scientific neighbor requires an explicit choice",
  );
}
{
  const cases: Array<[string, string, string[], string]> = [
    ["This is teh result.", "teh", ["the"], "the"],
    ["The experiemnt worked.", "experiemnt", ["experiment", "expedient"], "experiment"],
    ["The objectis complex.", "objectis", ["object is"], "object is"],
  ];
  for (const [source, problem, suggestions, expected] of cases) {
    const kind = problem === "teh" || problem === "objectis" ? "Typo" : "Spelling";
    h.eq(planLocalCorrections(source, [lint(source, problem, kind, suggestions)])[0]?.replacement, expected, `${problem} → ${expected}`);
  }
  for (const [source, problem, suggestions] of [
    ["This occured yesterday.", "occured", ["occurred", "occur", "obscured"]],
    ["The signal was recoreded.", "recoreded", ["recorded", "recorder", "receded"]],
  ] as const) {
    h.eq(
      planLocalCorrections(source, [lint(source, problem, "Spelling", [...suggestions])]),
      [],
      `${problem} requires an explicit choice instead of guessing among insertion/deletion neighbors`,
    );
  }
  const splitTrap = "The bilogical response increased.";
  h.eq(
    planLocalCorrections(splitTrap, [lint(splitTrap, "bilogical", "Typo", ["bi logical"])]),
    [],
    "a two-letter pseudo-prefix is not mistaken for a missing word boundary",
  );
  const knownWordSplit = "Each trace was compared agains a blinded annotation.";
  h.eq(
    planLocalCorrections(knownWordSplit, [{ ...lint(knownWordSplit, "agains", "Typo", ["a gains"]), partsAreKnown: true }]),
    [],
    "a misspelling is never split into two independently valid words",
  );
  const shortDeletionTrap = "The sice remained viable.";
  h.eq(
    planLocalCorrections(shortDeletionTrap, [lint(shortDeletionTrap, "sice", "Spelling", ["sic", "sick", "side"])]),
    [],
    "a short deletion ambiguity requires a choice instead of choosing Harper's shortest word",
  );
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
  const source = "We measured IgluSnrf4 in the same preparation.";
  h.eq(
    planLocalCorrections(source, [], { explicitWords: ["iGluSnFR4f"] })
      .map((plan) => [plan.original, plan.replacement]),
    [["IgluSnrf4", "iGluSnFR4f"]],
    "an explicit scientific term resolves the motivating missing-letter + transposition typo",
  );
  h.eq(
    planExplicitVocabularyCorrections("iGluSnFR4f and SLAP3 and jRGECO1b", ["iGluSnFR4f", "SLAP2", "jRGECO1a"]),
    [],
    "correct terms, versioned identifiers, and plausible scientific substitutions remain untouched",
  );
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
    removeItem: (key: string) => void map.delete(key),
  };
  const profile = new LocalCorrectionProfile("project-a", storage);
  profile.block("compelx", "complex");
  profile.addWord("iGluSnFR4f");
  profile.addWord("NREM", "personal");
  profile.setAlias("igf", "iGluSnFR4f", "project");
  profile.setAlias("nr", "NREM", "personal");
  const reloaded = new LocalCorrectionProfile("project-a", storage);
  h.ok(reloaded.blockedPairs().has(correctionPairKey("compelx", "complex")), "reverted pair persists per project");
  h.eq(reloaded.words(), ["iGluSnFR4f"], "explicit project dictionary persists");
  h.ok(reloaded.hasWord("NREM", "personal") && reloaded.hasWord("glutamatergic", "personal"), "personal dictionary retains authored and seeded scientific terms");
  h.eq(reloaded.resolveAlias("IGF")?.expansion, "iGluSnFR4f", "project alias lookup is case-insensitive");
  const source = "A very compelx object.";
  h.eq(
    planLocalCorrections(source, [lint(source, "compelx", "Spelling", ["complex"])], { blockedPairs: reloaded.blockedPairs() }),
    [],
    "a learned veto prevents the correction",
  );
  const other = new LocalCorrectionProfile("project-b", storage);
  h.eq(other.words(), [], "project dictionary decisions do not leak between projects");
  h.eq(other.words("personal"), reloaded.words("personal"), "personal dictionary is shared across projects");
  h.eq(other.resolveAlias("nr")?.expansion, "NREM", "personal aliases are shared across projects");
  h.eq(other.resolveAlias("igf"), null, "project aliases do not leak between projects");
  reloaded.setAlias("nr", "project-NREM", "project");
  h.eq(reloaded.resolveAlias("nr")?.expansion, "project-NREM", "project alias overrides a personal alias with the same trigger");
  h.ok(reloaded.removeAlias("nr", "project") && reloaded.resolveAlias("nr")?.expansion === "NREM", "removing a project alias reveals the personal fallback");
  h.ok(reloaded.removeWord("iGluSnFR4f", "project") && !reloaded.hasWord("iGluSnFR4f", "project"), "an explicit word is easy to remove");
  reloaded.addWord("iGluSnFR4f", "project");

  clearLocalCorrectionLearning(storage);
  const reset = new LocalCorrectionProfile("project-a", storage);
  h.ok(reset.blockedPairs().size === 0, "reset clears automatic correction vetoes");
  h.eq(reset.words(), ["iGluSnFR4f"], "reset preserves the explicit project dictionary");
  h.eq(reset.resolveAlias("igf")?.expansion, "iGluSnFR4f", "reset preserves aliases");

  clearLocalCorrectionProfiles(storage);
  const cleared = new LocalCorrectionProfile("project-a", storage);
  h.ok(cleared.words().length === 0 && cleared.words("personal").length === SCIENTIFIC_VOCABULARY.length && !cleared.resolveAlias("igf"), "full profile clear removes authored data and restores the scientific seed");
}
{
  const map = new Map<string, string>();
  map.set("flux.paper.localCorrections.v1", JSON.stringify({
    version: 1,
    projects: { legacy: { words: ["iGluSnFR4f"], blockedPairs: [correctionPairKey("x", "y")] } },
  }));
  const storage = {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
  };
  const migrated = new LocalCorrectionProfile("legacy", storage);
  h.eq(migrated.words(), ["iGluSnFR4f"], "v1 project words migrate without loss");
  h.ok(migrated.blockedPairs().has(correctionPairKey("x", "y")), "v1 correction vetoes migrate without loss");
}

h.section("windowing and vocabulary");
{
  const doc = "Previous sentence. The structure is compelx. Next";
  const end = doc.indexOf(" Next");
  h.eq(extractCorrectionWindow(doc, end)?.text, "The structure is compelx.", "only the current completed sentence is submitted");
  h.ok((extractCorrectionWindow("x".repeat(700) + " compelx", 708)?.text.length ?? 0) <= 480, "correction context is hard-capped");
}

h.section("word and scientific sentence boundaries");
{
  const sentence = "The result was compelx. ";
  const kinds = classifyTypedBoundaries(sentence, sentence.length - 1, " ");
  h.ok(kinds.has("word") && kinds.has("sentence"), "terminal whitespace schedules both lanes");
  const word = "The result was compelx ";
  const wordWindow = extractCompletedWordWindow(word, word.length)!;
  h.eq(
    wordWindow.text.slice(wordWindow.focus!.from, wordWindow.focus!.to),
    "was compelx",
    "word lane still corrects only two completed tokens",
  );
  const windowed = "Earlier. The result was compelx. ";
  h.eq(extractSentenceWindow(windowed, windowed.length)?.text, "The result was compelx.", "sentence lane shares extraction rules");
  for (const fragment of ["Results from et al. ", "See Fig. ", "That is, e.g. ", "A. ", "Published in J. Neurosci. "]) {
    h.ok(!isSentenceBoundaryAt(fragment, fragment.length - 1), `${fragment.trim()} does not end a sentence`);
  }
  const cited = "As shown [@smith2020]. ";
  h.ok(isSentenceBoundaryAt(cited, cited.length - 1), "a citekey followed by punctuation ends a sentence");
}

h.section("a window cut never invents a lint");
{
  // Every record below is what Harper 2.7 really returns for the quoted text —
  // measured, not imagined. The bug they pin: the word lane used to submit the
  // final two tokens ALONE, so the linter read the tail of one sentence as the
  // head of another and reported the manuscript's own prose as broken.
  const doc = 'The goal is to analyze data acquired in "acute neuropixel" experiments. These are technical experiments.';
  const head = doc.indexOf("These are") + "These ".length;
  const window = extractCompletedWordWindow(doc, head)!;
  h.ok(window.text.startsWith("These"), "the word lane submits the sentence it is inside, not a cut across the previous one");
  h.eq(doc.slice(window.from + window.focus!.from, window.from + window.focus!.to), "These", "the focus stays on the completed word");

  const cut = "experiments. These";
  const capitalization: LocalLintRecord = {
    from: 0, to: 11, problem: "experiments", kind: "Capitalization",
    message: "This sentence does not start with a capital letter", suggestions: ["Experiments"],
  };
  h.eq(scopeWindowLints({ text: cut }, [capitalization], false), [], "a sentence-opening verdict is dropped when the window opens mid-sentence");
  h.eq(scopeWindowLints({ text: cut }, [capitalization], true), [capitalization], "the same verdict is kept where the window really opens a sentence");

  const discourse = lint("therefore treat", "therefore", "Punctuation", [","]);
  h.eq(scopeWindowLints({ text: "therefore treat" }, [discourse], false), [], "a discourse-marker comma is dropped when the window opens mid-sentence");

  // Sentence-position rules are dropped only for the window's FIRST sentence,
  // the one the cut invented; a genuinely lowercase opener after a real
  // boundary inside the window survives. Harper reports both spans here.
  const twoSentences = "signals were noisy. they were discarded.";
  const invented: LocalLintRecord = {
    from: 0, to: 7, problem: "signals", kind: "Capitalization",
    message: "This sentence does not start with a capital letter", suggestions: ["Signals"],
  };
  const real: LocalLintRecord = {
    from: 20, to: 24, problem: "they", kind: "Capitalization",
    message: "This sentence does not start with a capital letter", suggestions: ["They"],
  };
  h.eq(scopeWindowLints({ text: twoSentences }, [invented, real], false), [real], "a lowercase opener after a real boundary is still reported");

  // Only the focus is correctable; leading context is read-only.
  const focused = { text: "The result was compelx", focus: { from: 11, to: 22 } };
  const inContext = lint(focused.text, "result", "Spelling", ["results"]);
  const inFocus = lint(focused.text, "compelx", "Spelling", ["complex"]);
  h.eq(scopeWindowLints(focused, [inContext, inFocus], true), [inFocus], "context words are linted for meaning, never corrected");

  // The planners synthesize spans from the whole window text — the confusion
  // table and explicit vocabulary never saw the lint list — so the focus must
  // bound their OUTPUT, not just their input.
  const synth = "The somata depolarized more then a compelx control";
  const focusOnLastTwo = { from: synth.indexOf("compelx"), to: synth.length };
  const synthesized = normalizeSpellingCandidates(synth, [lint(synth, "compelx", "Spelling", ["complex"])]);
  h.ok(!synthesized.some((c) => c.original === "then"), "diagnostics never invent unflagged confusion-word candidates");
  h.eq(
    withinFocus(synthesized, focusOnLastTwo).map((c) => c.original),
    ["compelx"],
    "a focused window never proposes a change to the context it was given",
  );
  h.eq(
    withinFocus(planLocalCorrections(synth, [lint(synth, "compelx", "Spelling", ["complex"])]), focusOnLastTwo)
      .map((p) => [p.original, p.replacement]),
    [["compelx", "complex"]],
    "automatic edits stay inside the focus too",
  );

  // The trailing period is what makes "et al." a known abbreviation rather than
  // two unknown words, so the linted text must keep it.
  const cite = "This matches Smith et al. ";
  const citeWindow = extractCompletedWordWindow(cite, cite.length)!;
  h.ok(citeWindow.text.endsWith("et al."), "punctuation the user just typed stays in the linted text");

  for (const [before, expected, label] of [
    ["", true, "the document start opens a sentence"],
    ["The data were noisy. ", true, "a terminated sentence opens the next one"],
    ["Shown in Fig. ", false, "an abbreviation does not open a sentence"],
    ["Reported by Smith et al. ", false, "et al. does not open a sentence"],
    ["a value of 3.5 ", false, "a decimal does not open a sentence"],
    ['acquired in "acute neuropixel" ', false, "mid-sentence prose does not open a sentence"],
    ["## Question\n\n", true, "a new block opens a sentence"],
  ] as const) {
    h.eq(windowStartsSentence(before), expected, label);
  }
}

h.section("explicit spelling choices and vocabulary seed");
{
  for (const [source, original, kind, replacement] of [
    ["This is a example.", "a", "WordChoice", "an"],
    ["the cell remained stable.", "the", "Capitalization", "The"],
    ["There are more then two cells.", "then", "WordChoice", "than"],
  ]) h.eq(normalizeSpellingCandidates(source, [lint(source, original, kind, [replacement])]), [], `${original} → ${replacement} is sentence-dependent and cannot enter the learned spelling menu`);
  const source = "A seperate enviroment.";
  const choices = normalizeSpellingCandidates(source, [lint(source, "seperate", "Spelling", ["otherwise", "separate", "separation", "separate"])]);
  h.eq(choices[0].suggestions[0], "separate", "nearby spelling is ranked before a distant word");
  h.eq(new Set(choices[0].suggestions).size, choices[0].suggestions.length, "choices are deduplicated");
  h.eq(normalizeSpellingCandidates(source, [lint(source, "seperate", "Spelling", ["separate"])], ["SEPERATE"]), [], "personal dictionary suppresses an existing flag regardless of case");
  h.eq(normalizeSpellingCandidates("`enviroment`", [lint("`enviroment`", "enviroment", "Spelling", ["environment"])]), [], "protected markup never becomes an explicit spelling target");
  const map = new Map<string,string>();
  const storage = { getItem: (key:string) => map.get(key) ?? null, setItem: (key:string,value:string) => void map.set(key,value) };
  const profile = new LocalCorrectionProfile("seed-test",storage);
  await profile.ready();
  h.ok(profile.words("personal").length >= 700, "the personal dictionary starts with broad neuroscience and biology coverage");
  for (const word of ["NREM", "glutamate", "synaptogenesis", "pupillometry", "iGluSnFR4f", "oligodendrocytes", "transcriptomics", "immunohistochemistry"]) h.ok(profile.hasWord(word,"personal"), `${word} is recognized out of the box`);
  h.eq(profile.explicitCorrectionWords(), [], "the scientific seed does not widen automatic technical near-matching");
  profile.addWord("iGluSnFR4f", "project");
  h.eq(planLocalCorrections("We measured IgluSnrf4.", [], { explicitWords: profile.explicitCorrectionWords() }).map(plan => plan.replacement), ["iGluSnFR4f"], "authored canonical terms retain precise correction even beside similar seeded sensors");
  profile.addWord("iGluSnFR4f", "personal");
  h.ok(profile.explicitCorrectionWords().includes("iGluSnFR4f"), "explicit addition promotes a supplied Personal word to an authored canonical target");
  const oldValues = new Map<string, string>([["flux.paper.localLanguage.v2", JSON.stringify({ version: 2, personal: { words: ["iGluSnFR4f"], aliases: [] }, projects: {} })]]);
  const legacyStorage = { getItem: (key: string) => oldValues.get(key) ?? null, setItem: (key: string, value: string) => void oldValues.set(key, value) };
  const legacyPersonal = new LocalCorrectionProfile("legacy-authored", legacyStorage);
  await legacyPersonal.ready();
  h.eq(legacyPersonal.explicitCorrectionWords(), ["iGluSnFR4f"], "seeding preserves a Personal term authored before that word entered the seed catalog");
  h.eq(planLocalCorrections("We measured IgluSnrf4.", [], { explicitWords: legacyPersonal.explicitCorrectionWords() }).map(plan => plan.replacement), ["iGluSnFR4f"], "preexisting Personal scientific terms retain their canonical near-match correction behavior");
  h.ok(!legacyPersonal.explicitCorrectionWords().includes("iGluSnFR3") && legacyPersonal.hasWord("iGluSnFR3", "personal"), "newly supplied related sensor names teach recognition without widening authored correction targets");
  const legacyReopen = new LocalCorrectionProfile("legacy-authored", legacyStorage);
  await legacyReopen.ready();
  h.eq(legacyReopen.explicitCorrectionWords(), ["iGluSnFR4f"], "authored-versus-seeded provenance survives reopening");
  profile.removeWord("glutamate","personal");
  const reopened = new LocalCorrectionProfile("seed-test",storage);
  await reopened.ready();
  h.ok(!reopened.hasWord("glutamate","personal"), "an intentional removal stays removed after profile reopen");
  profile.setAlias("enviroment","environment","personal");
  const learned = new LocalCorrectionProfile("other-project",storage);
  h.eq(learned.resolveAlias("enviroment")?.expansion,"environment","a personal correction mapping survives reopening and follows the user across projects");
}

h.section("backlog scan windows and Harper-only candidates");
{
  const paragraphOne = "The first paragraph has a compelx idea. It continues briefly.";
  const longSentences = Array.from({ length: 12 }, (_, index) => `Sentence number ${index} carries roughly sixty characters of prose here.`).join(" ");
  const doc = `${paragraphOne}\n\n${longSentences}\n\n\`\`\`\ncode block text\n\`\`\`\n\nLast paragraph.`;
  const windows = backlogScanWindows(doc);
  h.ok(windows.length >= 4, "paragraphs and long-paragraph splits each get their own window");
  h.ok(windows.every((w) => w.text.length <= 640), "every backlog window respects the live-lint size cap");
  h.ok(windows.every((w) => doc.slice(w.from, w.to) === w.text), "every window's offsets address its exact text");
  h.eq(windows[0].text, paragraphOne, "a short paragraph is one window");
  const rejoined = windows.map((w) => w.text).join(" ");
  h.ok(rejoined.includes("Sentence number 11") && rejoined.includes("Last paragraph."), "the scan covers the document through its final paragraph");
  const boundarySplit = windows.filter((w) => w.text.startsWith("Sentence number"));
  h.ok(boundarySplit.every((w) => /[.!?]$/.test(w.text)), "long paragraphs split at sentence boundaries, not mid-sentence");

  const source = "We know there is a compelx site here.";
  const harperOnly = normalizeSpellingCandidates(source, [lint(source, "compelx", "Spelling", ["complex"])], ["FluxSite2"]);
  h.eq(harperOnly.map((candidate) => candidate.original), ["compelx"], "the scan shows only spans Harper actually flagged");
}

h.section("architecture pins");
{
  const worker = readFileSync("src/shell/modes/paper/editing/localCorrection.worker.ts", "utf8");
  const editor = readFileSync("src/shell/modes/paper/editing/localCorrections.ts", "utf8");
  const wordTools = readFileSync("src/shell/modes/paper/editing/localWordTools.ts", "utf8");
  const service = readFileSync("src/shell/modes/paper/editing/localCorrectionService.ts", "utf8");
  const styles = readFileSync("src/app.css", "utf8");
  const settings = readFileSync("src/lib/Settings.svelte", "utf8");
  h.ok(/new LocalLinter/.test(worker) && !/new LocalLinter/.test(editor), "Harper/WASM construction stays in the dedicated worker");
  h.ok(/new Worker\(new URL/.test(service), "renderer orchestration uses a module worker");
  h.ok(/isolateHistory\.of\("full"\)/.test(editor), "automatic corrections are isolated into one exact undo step");
  h.ok(/input\.type\.compose/.test(editor), "IME composition is explicitly excluded");
  h.ok(/transactionFilter/.test(editor) && /sequential:\s*true/.test(editor), "alias expansion joins the delimiter's original transaction");
  h.ok(/Prec\.highest/.test(wordTools) && /KeyD/.test(wordTools) && /KeyW/.test(wordTools), "dictionary chords precede Vim's DOM key handler");
  h.ok(/tr\.newDoc\.sliceString\(floor, ceiling\)/.test(editor) && !/classifyTypedBoundaries\(tr\.newDoc\.toString\(\)/.test(editor), "keystroke boundary detection reads a bounded slice, never the whole manuscript");
  h.ok(/cm-spelling-issue/.test(styles) && /text-underline-offset/.test(styles), "spelling diagnostics use zero-layout underlines");
  h.ok(!/Sentence judgment|correctionModelInstall|paperCorrectionProvider/.test(settings), "Settings contains only the fast local correction controls");
  h.ok(!/fetch\(|https?:\/\//.test(worker + service), "local correction code contains no cloud/network path");
}

await h.done();
