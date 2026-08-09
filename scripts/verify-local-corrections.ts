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
import {
  guardContextCorrectionResult,
  makeContextCorrectionPacket,
  normalizeCorrectionCandidates,
  rescueApprovalKey,
  rescueReplacementAllowed,
} from "../src/shell/modes/paper/editing/contextualCorrectionCore";

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
    "a short adjacent-key scientific neighbor remains contextual",
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
      `${problem} waits for sentence context instead of guessing among insertion/deletion neighbors`,
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
    "a short deletion ambiguity waits for context instead of choosing Harper's shortest word",
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
  h.eq(reloaded.words("personal"), ["NREM"], "explicit personal dictionary persists");
  h.eq(reloaded.resolveAlias("IGF")?.expansion, "iGluSnFR4f", "project alias lookup is case-insensitive");
  const source = "A very compelx object.";
  h.eq(
    planLocalCorrections(source, [lint(source, "compelx", "Spelling", ["complex"])], { blockedPairs: reloaded.blockedPairs() }),
    [],
    "a learned veto prevents the correction",
  );
  const other = new LocalCorrectionProfile("project-b", storage);
  h.eq(other.words(), [], "project dictionary decisions do not leak between projects");
  h.eq(other.words("personal"), ["NREM"], "personal dictionary is shared across projects");
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
  h.ok(cleared.words().length === 0 && cleared.words("personal").length === 0 && !cleared.resolveAlias("igf"), "full profile clear removes both scopes and aliases");
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
  const synthesized = normalizeCorrectionCandidates(synth, [lint(synth, "compelx", "Spelling", ["complex"])], "sentence");
  h.ok(synthesized.some((c) => c.original === "then"), "the confusion table reaches words the linter never flagged");
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

h.section("context candidate contract and guard");
{
  const source = "The somata depolarized more then controls.";
  const records = [
    lint(source, "somata", "Spelling", ["sonata"]),
    lint(source, "then", "WordChoice", ["than"]),
  ];
  const candidates = normalizeCorrectionCandidates(source, records, "sentence");
  h.eq(candidates.length, 2, "declined Harper lints remain bounded contextual candidates");
  const packet = makeContextCorrectionPacket("r1", source, candidates, {
    revision: "ctx-1", dialect: "american", sectionPath: [], canonicalTerms: [], contextHints: [],
  });
  const guarded = guardContextCorrectionResult(packet, {
    version: 1,
    requestId: "r1",
    decisions: [{ candidateId: candidates[1].id, action: "use", suggestionIndex: 0 }],
  }, source);
  h.eq(guarded.map((plan) => [plan.original, plan.replacement]), [["then", "than"]], "missing decisions mean keep and an enumerated decision applies");
  h.eq(guardContextCorrectionResult(packet, { version: 1, requestId: "stale", decisions: [] }, source), [], "wrong request IDs fail closed");
  h.eq(guardContextCorrectionResult(packet, { version: 1, requestId: "r1", decisions: [{ candidateId: "unknown", action: "use", suggestionIndex: 0 }] }, source), [], "unknown candidate IDs fail closed");
}
{
  for (const [source, original, replacement] of [
    ["The signal came from the cortex.", "from", "form"],
    ["The device retained its calibration.", "its", "it's"],
    ["Please cite the recording site.", "cite", "site"],
  ] as const) {
    const [candidate] = normalizeCorrectionCandidates(source, [lint(source, original, "WordChoice", [replacement])], "sentence");
    const packet = makeContextCorrectionPacket(`real-${original}`, source, [candidate], {
      revision: "ctx-real-word", dialect: "american", sectionPath: [], canonicalTerms: [], contextHints: [],
    });
    h.eq(
      guardContextCorrectionResult(packet, {
        version: 1,
        requestId: `real-${original}`,
        decisions: [{ candidateId: candidate.id, action: "use", suggestionIndex: 0 }],
      }, source),
      [],
      `${original} → ${replacement} is blocked when the original is syntactically coherent`,
    );
  }
  const source = "Please cite the recording cite in the methods.";
  const candidates = normalizeCorrectionCandidates(source, [
    { ...lint(source, "cite", "WordChoice", ["site"]), from: source.lastIndexOf("cite"), to: source.lastIndexOf("cite") + 4 },
  ], "sentence");
  const packet = makeContextCorrectionPacket("noun-site", source, candidates, {
    revision: "ctx-noun-site", dialect: "american", sectionPath: [], canonicalTerms: [], contextHints: [],
  });
  h.eq(
    guardContextCorrectionResult(packet, {
      version: 1,
      requestId: "noun-site",
      decisions: [{ candidateId: candidates[0].id, action: "use", suggestionIndex: 0 }],
    }, source).map((plan) => [plan.original, plan.replacement]),
    [["cite", "site"]],
    "a noun-position cite → site correction remains available",
  );
}
{
  const source = "The wayus in which the system acts remain unclear.";
  const record = {
    ...lint(source, "wayus", "Typo", ["way us"]),
    rescueSuggestions: ["ways"],
  };
  const [candidate] = normalizeCorrectionCandidates(source, [record], "sentence");
  h.eq(candidate.suggestions, [], "an unsafe Harper spacing option cannot enter the first-pass selectable set");
  h.eq(candidate.rescueSuggestions, ["ways"], "a locally verified word is isolated as an optional rescue proposal");
  h.eq(candidate.rejectedSuggestions, ["way us"], "unsafe Harper text remains visible only to the proposal rejection contract");
  const packet = makeContextCorrectionPacket("wayus", source, [candidate], {
    revision: "ctx-wayus", dialect: "american", sectionPath: [], canonicalTerms: [], contextHints: [],
  });
  h.eq(
    guardContextCorrectionResult(packet, {
      version: 1,
      requestId: "wayus",
      decisions: [{ candidateId: candidate.id, action: "rescue", replacement: "ways" }],
    }, source, { approvedRescues: new Set([rescueApprovalKey(candidate.id, "ways")]) }).map((plan) => [plan.original, plan.replacement]),
    [["wayus", "ways"]],
    "context may approve Flux's isolated rescue proposal after rejecting Harper's spacing option",
  );
}
{
  const source = "The image used a seperate reference.";
  const [candidate] = normalizeCorrectionCandidates(source, [lint(source, "seperate", "Spelling", ["separate", "otherwise"])], "sentence");
  h.ok(candidate.rescueSuggestions.includes("separate"), "a bounded but mechanically non-dominant Harper word remains recoverable as a Flux proposal");
  h.ok(!candidate.rejectedSuggestions.includes("separate") && candidate.rejectedSuggestions.includes("otherwise"), "only distant Harper spellings are forbidden during rescue");
}
{
  const source = "The analysiz remained reproducible.";
  const [candidate] = normalizeCorrectionCandidates(source, [lint(source, "analysiz", "Spelling", [])], "sentence");
  h.ok(candidate.rescueEligible && candidate.suggestions.length === 0, "a flagged word with no supplied suggestion survives for bounded rescue");
  const packet = makeContextCorrectionPacket("rescue", source, [candidate], {
    revision: "ctx-rescue", dialect: "american", sectionPath: [], canonicalTerms: [], contextHints: [],
  });
  const result = {
    version: 1 as const,
    requestId: "rescue",
    decisions: [{ candidateId: candidate.id, action: "rescue" as const, replacement: "analysis" }],
  };
  h.eq(guardContextCorrectionResult(packet, result, source), [], "a generated replacement cannot self-approve");
  h.eq(
    guardContextCorrectionResult(packet, result, source, {
      approvedRescues: new Set([rescueApprovalKey(candidate.id, "analysis")]),
    }).map((plan) => [plan.original, plan.replacement]),
    [["analysiz", "analysis"]],
    "a close exact-span proposal applies only after independent lexical approval",
  );
  h.eq(
    guardContextCorrectionResult(packet, {
      ...result,
      decisions: [{ candidateId: candidate.id, action: "rescue", replacement: "analytical" }],
    }, source, { approvedRescues: new Set([rescueApprovalKey(candidate.id, "analytical")]) }),
    [],
    "a distant model proposal remains outside the silent mutation contract",
  );
}
{
  const source = "The control grop remained stable.";
  const [candidate] = normalizeCorrectionCandidates(source, [lint(source, "grop", "Spelling", ["grip"])], "sentence");
  const packet = makeContextCorrectionPacket("short-rescue", source, [candidate], {
    revision: "ctx-short", dialect: "american", sectionPath: [], canonicalTerms: [], contextHints: [],
  });
  h.eq(
    guardContextCorrectionResult(packet, {
      version: 1,
      requestId: "short-rescue",
      decisions: [{ candidateId: candidate.id, action: "rescue", replacement: "grip" }],
    }, source, { approvedRescues: new Set([rescueApprovalKey(candidate.id, "grip")]) }),
    [{
      from: source.indexOf("grop"),
      to: source.indexOf("grop") + 4,
      original: "grop",
      replacement: "grip",
      kind: "spelling",
      message: "candidate",
    }],
    "a short bounded word applies only after the separate model and local-lexicon approvals",
  );
}
{
  const words = extractProjectVocabulary([
    "NREM iGluSnFR4f SLAP2 glutamate glutamate glutamate oneoff",
  ]);
  h.ok(words.includes("NREM") && words.includes("iGluSnFR4f") && words.includes("SLAP2"), "technical forms enter the project vocabulary immediately");
  h.ok(words.includes("glutamate") && !words.includes("oneoff"), "ordinary terms require recurrence before learning");
}

h.section("judgment aggressiveness envelopes");
{
  const candidateFor = (original: string, mode: "standard" | "aggressive" | "really-aggressive") => {
    const source = `The ${original} result remained stable.`;
    return normalizeCorrectionCandidates(source, [lint(source, original, "Spelling", [])], "sentence", { aggressiveness: mode })[0];
  };
  const standardLong = candidateFor("subseqeubn", "standard");
  const aggressiveLong = candidateFor("subseqeubn", "aggressive");
  const reallyMedium = candidateFor("exxqplez", "really-aggressive");
  const reallyLong = candidateFor("subseqxxbn", "really-aggressive");
  h.eq(
    [standardLong.rescueMaxDistance, aggressiveLong.rescueMaxDistance, reallyMedium.rescueMaxDistance, reallyLong.rescueMaxDistance],
    [2, 3, 3, 4],
    "standard, aggressive, and really aggressive expose distinct renderer-owned edit ceilings",
  );
  h.eq(
    [
      rescueReplacementAllowed(standardLong, "subsequent"),
      rescueReplacementAllowed(aggressiveLong, "subsequent"),
      rescueReplacementAllowed(reallyMedium, "example"),
      rescueReplacementAllowed(reallyLong, "subsequent"),
    ],
    [false, true, true, true],
    "the wider modes admit three/four-edit long-word repairs while standard remains unchanged",
  );
  const short = candidateFor("grop", "really-aggressive");
  h.eq(short.rescueMaxDistance, 1, "really aggressive never widens the ambiguous short-word neighborhood");
  const plural = candidateFor("segmentations", "really-aggressive");
  h.ok(!rescueReplacementAllowed(plural, "segmentation"), "generated spelling rescue cannot silently remove an intact plural inflection");
  const scientificPrefix = candidateFor("hyperpolarizing", "really-aggressive");
  h.ok(!rescueReplacementAllowed(scientificPrefix, "depolarizing"), "generated rescue cannot remove a meaning-bearing scientific prefix");
  const grammarSource = "Background flxorscenz was subtracted before analysis.";
  const grammarCandidate = normalizeCorrectionCandidates(grammarSource, [lint(grammarSource, "flxorscenz", "Spelling", [])], "sentence", { aggressiveness: "really-aggressive" })[0];
  const grammarPacket = makeContextCorrectionPacket("grammar-rescue", grammarSource, [grammarCandidate], {
    revision: "grammar", dialect: "american", sectionPath: [], canonicalTerms: [], contextHints: [],
  }, { sectionPath: [] }, "sentence", "really-aggressive");
  h.eq(guardContextCorrectionResult(grammarPacket, {
    version: 1,
    requestId: grammarPacket.requestId,
    decisions: [{ candidateId: grammarCandidate.id, action: "rescue", replacement: "fluorescent" }],
  }, grammarSource, { approvedRescues: new Set([rescueApprovalKey(grammarCandidate.id, "fluorescent")]) }), [], "final grammar shape guard rejects an adjective in a nominal subject slot");
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
  const harperOnly = normalizeCorrectionCandidates(
    source,
    [lint(source, "compelx", "Spelling", ["complex"])],
    "sentence",
    { harperLintsOnly: true, explicitWords: ["FluxSite2"] },
  );
  h.eq(harperOnly.map((candidate) => candidate.original), ["compelx"], "harperLintsOnly yields exactly the Harper-flagged span");
  const withSynthetic = normalizeCorrectionCandidates(
    source,
    [lint(source, "compelx", "Spelling", ["complex"])],
    "sentence",
  );
  h.ok(withSynthetic.some((candidate) => candidate.original === "site" || candidate.original === "there"), "without the flag, confusion-table candidates still join the sentence lane");
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
  h.ok(/cm-context-issue-deferred/.test(styles) && /cm-context-issue-declined/.test(styles) && /flux-context-correction-line/.test(styles), "deferred, declined, and contextual-correction visual states have explicit zero-layout styling");
  h.ok(/really-aggressive/.test(settings) && /Really aggressive/.test(settings), "Settings exposes all three judgment modes");
  h.ok(!/fetch\(|https?:\/\//.test(worker + service), "local correction code contains no cloud/network path");
}

await h.done();
