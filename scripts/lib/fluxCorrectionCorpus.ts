import type { LocalLintRecord } from "../../src/shell/modes/paper/editing/localCorrectionCore";
import type { ContextualCorrectionClass, ProjectLanguageContextV1 } from "../../src/shell/modes/paper/editing/contextualCorrectionCore";

export type CorrectionCorpusPartition = "development" | "calibration" | "held-out";
export const CORRECTION_RESCUE_CORPUS_VERSION = "flux-correction-rescue-v1";

export interface CorrectionGoldEdit {
  original: string;
  replacement: string;
  action: "keep" | "use";
  occurrence?: number;
}

export interface CorrectionCorpusCase {
  id: string;
  family: string;
  partition: CorrectionCorpusPartition;
  policyClass: ContextualCorrectionClass;
  text: string;
  gold: CorrectionGoldEdit[];
  extraLints?: LocalLintRecord[];
  explicitWords?: string[];
  context?: Partial<ProjectLanguageContextV1>;
  sequence?: Array<{ type: "type" | "edit" | "undo"; text?: string }>;
  provenance: "synthetic" | "toefl-spell";
}

const bases = [
  "The complex chemical structure was measured in the cortical preparation.",
  "The experiment occurred after the recorded baseline response.",
  "Fluorescence increased significantly during the biological analysis.",
  "The concentration parameter remained stable at room temperature.",
  "Each microscope image was aligned to a separate anatomical reference.",
  "The neuronal response was measured across repeated stimulation trials.",
  "The analysis preserved the structure of every recorded observation.",
  "The chemical preparation produced a significant fluorescence change.",
  "The cortical experiment used a calibrated microscope objective.",
  "Every biological parameter was recorded before the final analysis.",
];

const typoPairs: Array<[string, string]> = [
  ["complex", "compelx"], ["everything", "everhthing"], ["experiment", "experiemnt"],
  ["occurred", "occured"], ["recorded", "recoreded"], ["structure", "strucutre"],
  ["measured", "meausred"], ["analysis", "anlaysis"], ["response", "repsonse"],
  ["chemical", "chemcial"], ["cortical", "coritcal"], ["fluorescence", "flourescence"],
  ["parameter", "paramter"], ["significantly", "signficantly"], ["concentration", "concentraiton"],
  ["preparation", "prepartion"], ["microscope", "microsocpe"], ["biological", "biolgical"],
  ["temperature", "temeprature"], ["separate", "seperate"],
];

const ambiguousChange: Array<[string, string, string]> = [
  ["The signal was recorded form the motor cortex.", "form", "from"],
  ["The treatment did not effect the firing rate.", "effect", "affect"],
  ["The second group was larger then the first group.", "then", "than"],
  ["We did not want to loose the low-amplitude events.", "loose", "lose"],
  ["The principal of sparse coding guided the analysis.", "principal", "principle"],
  ["Please cite the recording cite in the methods.", "cite", "site"],
  ["The inhibitory input complimented the excitatory drive.", "complimented", "complemented"],
  ["The mouse past through the central chamber.", "past", "passed"],
];

const ambiguousKeep: Array<[string, string, string]> = [
  ["The waveform preserved its original form.", "form", "from"],
  ["The measured effect was small but reproducible.", "effect", "affect"],
  ["We first washed the slice and then recorded.", "then", "than"],
  ["The connector remained loose throughout calibration.", "loose", "lose"],
  ["The principal investigator reviewed the analysis.", "principal", "principle"],
  ["We cite the original method in the discussion.", "cite", "site"],
  ["The blue label was a compliment to the orange trace.", "compliment", "complement"],
  ["The electrode passed through the intact membrane.", "passed", "past"],
];

function partition(index: number): CorrectionCorpusPartition {
  const slot = index % 10;
  return slot < 6 ? "development" : slot < 8 ? "calibration" : "held-out";
}

function lintFor(text: string, original: string, replacement: string): LocalLintRecord {
  // The authored real-word cases intentionally place the target after words
  // such as "waveform", or after a correct earlier occurrence of the same
  // token ("cite ... cite"). Select the explicit final occurrence.
  const from = text.lastIndexOf(original);
  return {
    from,
    to: from + original.length,
    problem: original,
    kind: "WordChoice",
    message: "Synthetic context-sensitive candidate",
    suggestions: [replacement],
  };
}

function finalOccurrence(text: string, value: string): number {
  const final = text.lastIndexOf(value);
  let count = 0;
  let from = 0;
  while (from < final) {
    const at = text.indexOf(value, from);
    if (at < 0 || at >= final) break;
    count += 1;
    from = at + value.length;
  }
  return count;
}

function mechanicalSentence(pair: [string, string]): { text: string; gold: CorrectionGoldEdit } {
  const [correct, typo] = pair;
  let base = bases.find((value) => value.toLocaleLowerCase().includes(correct.toLocaleLowerCase()));
  if (!base && correct === "everything") base = "Everything in the completed manuscript remained internally consistent.";
  base ??= `The ${correct} value was evaluated in the completed scientific manuscript.`;
  const from = base.toLocaleLowerCase().indexOf(correct.toLocaleLowerCase());
  const original = base.slice(from, from + correct.length);
  const typed = /^[A-Z]/.test(original) ? `${typo[0].toLocaleUpperCase()}${typo.slice(1)}` : typo;
  const replacement = /^[A-Z]/.test(original) ? `${correct[0].toLocaleUpperCase()}${correct.slice(1)}` : correct;
  return {
    text: `${base.slice(0, from)}${typed}${base.slice(from + correct.length)}`,
    gold: { original: typed, replacement, action: "use" },
  };
}

export function buildCorrectionCorpus(): CorrectionCorpusCase[] {
  const out: CorrectionCorpusCase[] = [];
  let serial = 0;
  const add = (value: Omit<CorrectionCorpusCase, "id" | "partition" | "provenance">) => {
    const index = serial++;
    out.push({ ...value, id: `fc-v1-${String(index).padStart(4, "0")}`, partition: partition(index), provenance: "synthetic" });
  };

  for (let i = 0; i < 500; i += 1) add({
    family: "clean-scientific",
    policyClass: "mechanical",
    text: bases[i % bases.length],
    gold: [],
  });

  for (let i = 0; i < 500; i += 1) {
    const generated = mechanicalSentence(typoPairs[i % typoPairs.length]);
    add({ family: "single-mechanical", policyClass: "mechanical", text: generated.text, gold: [generated.gold] });
  }

  for (let i = 0; i < 500; i += 1) {
    const first = mechanicalSentence(typoPairs[i % typoPairs.length]);
    const second = mechanicalSentence(typoPairs[(i + 7) % typoPairs.length]);
    add({
      family: "multi-mechanical",
      policyClass: "mechanical",
      text: `${first.text.slice(0, -1)}; ${second.text[0].toLocaleLowerCase()}${second.text.slice(1)}`,
      gold: [first.gold, second.gold],
    });
  }

  for (let i = 0; i < 400; i += 1) {
    const [text, original, replacement] = ambiguousChange[i % ambiguousChange.length];
    add({
      family: "ambiguous-change",
      policyClass: "real-word",
      text,
      gold: [{ original, replacement, action: "use", occurrence: finalOccurrence(text, original) }],
      extraLints: [lintFor(text, original, replacement)],
    });
  }

  for (let i = 0; i < 400; i += 1) {
    const [text, original, replacement] = ambiguousKeep[i % ambiguousKeep.length];
    add({
      family: "ambiguous-keep",
      policyClass: "real-word",
      text,
      gold: [{ original, replacement, action: "keep", occurrence: finalOccurrence(text, original) }],
      extraLints: [lintFor(text, original, replacement)],
    });
  }

  const terms = ["iGluSnFR4f", "jRGECO1a", "SLAP2", "NREM", "somata", "astrocytic", "neuropil", "GluA1"];
  for (let i = 0; i < 300; i += 1) {
    const term = terms[i % terms.length];
    add({
      family: "scientific-terminology",
      policyClass: "scientific-term",
      text: `The ${term} measurements were preserved exactly in every reported preparation.`,
      gold: [],
      explicitWords: [term],
      context: { canonicalTerms: [term], projectGuidance: `Preserve ${term} exactly.` },
    });
  }

  const protectedTemplates = [
    "Use `compelx` exactly in this code example.",
    "The expression $compelx + x$ is illustrative.",
    "See [@compelx2026] for the original method.",
    "The source is https://example.test/compelx.",
    "> The quoted source says \"compelx\" exactly.",
    "The identifier {#compelx} is referenced below.",
  ];
  for (let i = 0; i < 300; i += 1) add({
    family: "protected-syntax",
    policyClass: "scientific-term",
    text: protectedTemplates[i % protectedTemplates.length],
    gold: [],
    extraLints: [lintFor(protectedTemplates[i % protectedTemplates.length], "compelx", "complex")],
  });

  for (let i = 0; i < 200; i += 1) {
    const closed = i % 2 === 0;
    const text = closed ? "The first time point was excluded." : "The first timepoint was excluded.";
    const original = closed ? "time point" : "timepoint";
    const replacement = closed ? "timepoint" : "time point";
    const preferClosed = i % 4 < 2;
    add({
      family: "project-context-pair",
      policyClass: "boundary",
      text,
      gold: [{ original, replacement, action: (closed === preferClosed) ? "use" : "keep" }],
      extraLints: [lintFor(text, original, replacement)],
      context: {
        projectGuidance: preferClosed ? "Use timepoint as a closed compound." : "Use time point as an open compound.",
        canonicalTerms: [preferClosed ? "timepoint" : "time point"],
      },
    });
  }

  for (let i = 0; i < 200; i += 1) {
    const text = i % 2
      ? "The neurons fired during baseline. This response were stable across trials."
      : "The neurons fired during baseline. This response was stable across trials.";
    const original = i % 2 ? "were" : "was";
    const replacement = i % 2 ? "was" : "were";
    add({
      family: "paragraph-cross-sentence",
      policyClass: "phrase-punctuation",
      text,
      gold: [{ original, replacement, action: i % 2 ? "use" : "keep" }],
      extraLints: [lintFor(text, original, replacement)],
    });
  }

  for (let i = 0; i < 200; i += 1) add({
    family: "rapid-typing-race",
    policyClass: "mechanical",
    text: "The experiemnt ended. The next sentence continued immediately.",
    gold: [{ original: "experiemnt", replacement: "experiment", action: "use" }],
    sequence: [
      { type: "type", text: "The experiemnt ended. " },
      { type: "type", text: "The next sentence continued immediately." },
      ...(i % 2 ? [{ type: "edit" as const, text: "experiemnt" }] : []),
    ],
  });

  return out;
}

/**
 * A separate locked stress suite for the rare path where Harper's supplied
 * candidates omit the intended word. It is intentionally separate from the
 * original v1 corpus so the pre-rescue quality baseline remains comparable.
 */
export function buildCorrectionRescueCorpus(): CorrectionCorpusCase[] {
  const out: CorrectionCorpusCase[] = [];
  let serial = 0;
  const add = (value: Omit<CorrectionCorpusCase, "id" | "partition" | "provenance">) => {
    const index = serial++;
    out.push({
      ...value,
      id: `fcr-v1-${String(index).padStart(4, "0")}`,
      partition: partition(index),
      provenance: "synthetic",
    });
  };

  const omitted: Array<{ bad: string; good: string; sentence: string }> = [
    { bad: "cotext", good: "context", sentence: "The surrounding context determines how the response should be interpreted." },
    { bad: "conext", good: "context", sentence: "Sentence context made the intended scientific meaning unambiguous." },
    { bad: "cotnext", good: "context", sentence: "The project context supported the selected interpretation." },
    { bad: "mthod", good: "method", sentence: "The method was described in sufficient detail for replication." },
    { bad: "mehod", good: "method", sentence: "This method preserved every recorded observation." },
    { bad: "reslts", good: "results", sentence: "The results support the original experimental conclusion." },
    { bad: "resuts", good: "results", sentence: "These results remained stable across repeated trials." },
    { bad: "samles", good: "samples", sentence: "All samples were processed with the same biological protocol." },
    { bad: "analsis", good: "analysis", sentence: "The analysis remained reproducible across independent runs." },
    { bad: "parmeter", good: "parameter", sentence: "The parameter remained fixed throughout model fitting." },
    { bad: "bilogical", good: "biological", sentence: "The biological response increased during stimulation." },
    { bad: "wavefrom", good: "waveform", sentence: "The waveform preserved its original shape after filtering." },
    { bad: "codig", good: "coding", sentence: "Sparse coding guided the final population analysis." },
    { bad: "goup", good: "group", sentence: "The second group received the experimental treatment." },
    { bad: "grup", good: "group", sentence: "Each group contributed the same number of observations." },
    { bad: "grop", good: "group", sentence: "The control group remained at baseline throughout recording." },
    { bad: "mosue", good: "mouse", sentence: "The mouse entered the central chamber after habituation." },
    { bad: "sice", good: "slice", sentence: "The slice remained viable during the full recording period." },
    { bad: "itact", good: "intact", sentence: "The intact membrane remained stable during stimulation." },
    { bad: "ecitatory", good: "excitatory", sentence: "The excitatory response preceded the inhibitory component." },
  ];
  const suffixes = ["", " This pattern was replicated.", " The observation was independently confirmed.", " No other interpretation fit the sentence."];
  for (const item of omitted) {
    for (const suffix of suffixes) {
      const text = item.sentence.replace(item.good, item.bad) + suffix;
      add({
        family: "missing-candidate-rescue",
        policyClass: "mechanical",
        text,
        gold: [{ original: item.bad, replacement: item.good, action: "use" }],
      });
    }
  }

  const protectedTerms: Array<[string, string, string]> = [
    ["somata", "sonata", "The somata depolarized during stimulation."],
    ["astrocytic", "astronautic", "The astrocytic response increased during stimulation."],
    ["neuropil", "neutrophil", "The neuropil fluorescence remained stable."],
    ["gliosis", "glosses", "Reactive gliosis followed the cortical lesion."],
    ["axonal", "atonal", "The axonal fluorescence increased after stimulation."],
    ["dendritic", "dendrite", "The dendritic calcium events were detected reliably."],
    ["corticothalamic", "cortical", "The corticothalamic projection remained intact."],
    ["optogenetic", "ontogenetic", "The optogenetic stimulation evoked a rapid response."],
    ["chemogenetic", "chemogenic", "The chemogenetic inhibition reduced firing."],
    ["photometry", "geometry", "Fiber photometry measured population activity."],
    ["neuromodulatory", "modulatory", "The neuromodulatory input changed circuit gain."],
    ["microglial", "microbial", "The microglial processes contacted the damaged tissue."],
    ["oligodendrocyte", "oligonucleotide", "The oligodendrocyte lineage was labeled genetically."],
    ["perisomatic", "charismatic", "The perisomatic inhibition controlled spike timing."],
    ["interneuron", "interior", "The interneuron fired throughout the delay."],
    ["retinotopic", "isotropic", "The retinotopic map was reconstructed anatomically."],
    ["ipsilateral", "is lateral", "The ipsilateral projection was quantified separately."],
    ["contralateral", "collateral", "The contralateral pathway crossed the midline."],
    ["thalamocortical", "cortical", "The thalamocortical input reached layer four."],
    ["electrophysiological", "physiological", "The electrophysiological recordings confirmed the effect."],
  ];
  for (const [term, suggestion, sentence] of protectedTerms) {
    for (const suffix of suffixes) {
      const text = sentence + suffix;
      const from = text.indexOf(term);
      add({
        family: "unfamiliar-scientific-keep",
        policyClass: "mechanical",
        text,
        gold: [{ original: term, replacement: term, action: "keep" }],
        extraLints: [{
          from,
          to: from + term.length,
          problem: term,
          kind: "Spelling",
          message: "Synthetic omitted-candidate scientific stress case",
          suggestions: [suggestion],
        }],
      });
    }
  }
  return out;
}

export const CORRECTION_CORPUS_VERSION = "flux-correction-v2";
