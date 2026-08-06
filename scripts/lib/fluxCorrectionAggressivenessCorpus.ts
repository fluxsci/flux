import type { LocalLintRecord } from "../../src/shell/modes/paper/editing/localCorrectionCore";
import type { CorrectionCorpusCase } from "./fluxCorrectionCorpus";

/**
 * Fixed stress set for the user-facing judgment control. Unlike the untouched
 * confirmation corpus, this set deliberately contains three/four-edit damage
 * so Standard, Aggressive, and Really aggressive exercise different hard
 * envelopes. It also carries scientific and inflection-preservation controls.
 */
export const CORRECTION_AGGRESSIVENESS_CORPUS_VERSION = "flux-correction-aggressiveness-v1";

const REPAIRS: ReadonlyArray<readonly [family: string, bad: string, good: string, sentence: string]> = [
  ["aggression-three-long", "subseqeubn", "subsequent", "The subsequent response remained stable across trials."],
  ["aggression-three-long", "reprxducblx", "reproducible", "The analysis remained reproducible across independent cohorts."],
  ["aggression-three-long", "prexarxion", "preparation", "The tissue preparation remained viable throughout the recording."],
  ["aggression-three-long", "expxrimnq", "experiment", "The experiment included a blinded validation cohort."],
  ["aggression-three-medium", "exxqplez", "example", "Another example comes from the frigatebird."],
  ["aggression-three-medium", "recurntx", "recurrent", "The recurrent input amplified the late response."],
  ["aggression-three-medium", "recxrdx", "recorded", "The signal was recorded from motor cortex."],
  ["aggression-three-medium", "coqxlzx", "complex", "The complex structure remained chemically stable."],
  ["aggression-four-long", "subseqxxbn", "subsequent", "The subsequent measurement confirmed the original result."],
  ["aggression-four-long", "flxorscenz", "fluorescence", "Background fluorescence was subtracted before analysis."],
  ["aggression-four-long", "charxterizx", "characterized", "The response was characterized across behavioral states."],
  ["aggression-four-long", "synxronizx", "synchronized", "The synchronized recordings shared one acquisition clock."],
];

const PRESERVE: ReadonlyArray<readonly [term: string, sentence: string]> = [
  ["hyperpolarizing", "The hyperpolarizing current suppressed action potentials."],
  ["segmentations", "Only the accepted segmentations entered the anatomical summary."],
  ["somata", "The neuronal somata remained visible throughout imaging."],
  ["glutamatergic", "The glutamatergic projection terminated in superficial cortex."],
  ["axodendritic", "The axodendritic contact occurred on a distal branch."],
  ["ipsilateral", "The ipsilateral response preceded the contralateral response."],
  ["contralateral", "The contralateral projection crossed near the midline."],
  ["optogenetic", "The optogenetic stimulus lasted five milliseconds."],
  ["chemogenetic", "Chemogenetic inhibition reduced spontaneous firing."],
  ["thalamocortical", "The thalamocortical axons formed a dense terminal field."],
  ["perisomatic", "Perisomatic inhibition controlled spike timing."],
  ["glycinergic", "The glycinergic input produced a fast current."],
];

function spellingLint(text: string, problem: string): LocalLintRecord {
  const from = text.indexOf(problem);
  return {
    from,
    to: from + problem.length,
    problem,
    kind: "Spelling",
    message: "Aggressiveness stress candidate",
    suggestions: [],
  };
}

export function buildCorrectionAggressivenessCorpus(): CorrectionCorpusCase[] {
  const repairs = REPAIRS.map(([family, bad, good, sentence], index): CorrectionCorpusCase => {
    const text = sentence.replace(good, bad);
    return {
      id: `fca-v1-r${String(index).padStart(3, "0")}`,
      family,
      partition: "held-out",
      policyClass: "mechanical",
      text,
      gold: [{ original: bad, replacement: good, action: "use" }],
      extraLints: [spellingLint(text, bad)],
      provenance: "synthetic",
    };
  });
  const controls = PRESERVE.map(([term, sentence], index): CorrectionCorpusCase => ({
    id: `fca-v1-k${String(index).padStart(3, "0")}`,
    family: "aggression-preservation",
    partition: "held-out",
    policyClass: "scientific-term",
    text: sentence,
    gold: [{ original: term, replacement: term, action: "keep" }],
    extraLints: [spellingLint(sentence, term)],
    provenance: "synthetic",
  }));
  return [...repairs, ...controls];
}
