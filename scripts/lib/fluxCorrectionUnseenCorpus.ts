import type { CorrectionCorpusCase, CorrectionGoldEdit } from "./fluxCorrectionCorpus";

/**
 * A sealed, lexeme-disjoint evaluation set for the candidate-rescue path.
 *
 * The misspelling/correction pairs are authentic type-M annotations from the
 * ETS TOEFL-Spell corpus (CC BY-SA 4.0). Flux-authored sentences place each
 * pair in scientific or manuscript prose because the underlying TOEFL11 essay
 * text is not redistributed with the public annotations. Every positive typo
 * and every preservation term occurs once. None appears in the correction
 * prompts or the calibration corpus.
 *
 * Source: EducationalTestingService/TOEFL-Spell, Annotations.tsv
 * Paper: Flor, Fried & Rozovskaya (2019), ACL BEA.
 */
export const CORRECTION_UNSEEN_CORPUS_VERSION = "flux-correction-unseen-v1";
export const CORRECTION_UNSEEN_SOURCE = "https://github.com/EducationalTestingService/TOEFL-Spell";

const TYPO_CASES: ReadonlyArray<readonly [bad: string, good: string, sentence: string]> = [
  ["beacuse", "because", "The trial was repeated because the first recording contained motion."],
  ["enviroment", "environment", "The chamber environment remained stable throughout acquisition."],
  ["bussiness", "business", "The publishing business supported open access to the final article."],
  ["wihin", "within", "All fluorescence values remained within the calibrated dynamic range."],
  ["knowledege", "knowledge", "Prior anatomical knowledge constrained the registration procedure."],
  ["infomation", "information", "The metadata retained information about every imaging session."],
  ["interesing", "interesting", "An interesting transient appeared immediately after stimulation."],
  ["loger", "longer", "The inhibitory response lasted longer than the excitatory response."],
  ["futur", "future", "Future experiments will test the proposed circuit mechanism."],
  ["attractiv", "attractive", "The low computational cost makes this method attractive for screening."],
  ["pratical", "practical", "A practical advantage is that the preparation remains intact."],
  ["openion", "opinion", "In our opinion, the direct measurement is the clearest interpretation."],
  ["excisted", "existed", "A stable baseline existed before the perturbation began."],
  ["direcor", "director", "The core facility director approved the revised acquisition protocol."],
  ["sory", "story", "The complete mechanistic story requires both structural and functional evidence."],
  ["agrre", "agree", "The two independent measurements agree within experimental uncertainty."],
  ["succed", "succeed", "The registration can succeed despite moderate tissue deformation."],
  ["occuring", "occurring", "Events occurring during movement were excluded from the analysis."],
  ["softwares", "software", "The analysis software recorded its version in the project manifest."],
  ["resons", "reasons", "Several technical reasons motivated the shorter acquisition window."],
  ["parant", "parent", "Each parent dendrite was traced back to the reconstructed soma."],
  ["sucess", "success", "Segmentation success was assessed against manual annotations."],
  ["somthing", "something", "Something changed in the waveform after the final stimulus."],
  ["lecterature", "literature", "The existing literature supports a conserved cellular mechanism."],
  ["studi", "study", "The study included every animal that passed the prespecified criteria."],
  ["intrest", "interest", "The region of interest was defined before statistical testing."],
  ["whitout", "without", "The model converged without altering the raw observations."],
  ["speific", "specific", "A specific projection class carried the strongest response."],
  ["toghether", "together", "Structural and physiological measurements were analyzed together."],
  ["resorces", "resources", "All computational resources were documented for reproducibility."],
  ["qeustion", "question", "The central question concerns how sleep changes synaptic organization."],
  ["benifits", "benefits", "The method offers substantial benefits for longitudinal imaging."],
  ["thier", "their", "The neurons retained their original spatial relationships."],
  ["shool", "school", "The medical school maintained the shared microscopy facility."],
  ["arrengement", "arrangement", "The laminar arrangement was consistent across specimens."],
  ["comming", "coming", "The strongest input was coming from the contralateral pathway."],
  ["omly", "only", "Only trials with stable baselines entered the final analysis."],
  ["producted", "produced", "The stimulation produced a reproducible calcium transient."],
  ["neeeded", "needed", "No additional smoothing was needed for the displayed trace."],
  ["poblem", "problem", "This control addresses the problem of slow indicator drift."],
  ["counscious", "conscious", "The conscious animals explored the arena before sleep recording."],
  ["twent", "twenty", "Twenty sections were collected from each reconstructed hemisphere."],
  ["citizien", "citizen", "Each citizen scientist followed the same annotation instructions."],
  ["discoverd", "discovered", "We discovered a previously unreported projection gradient."],
  ["fellowers", "followers", "The protocol gained followers after the validation data were released."],
  ["everthing", "everything", "Everything required to reproduce the figure is stored in the project."],
  ["genarations", "generations", "The phenotype persisted across three generations of animals."],
  ["worled", "world", "The simulated world contained the same landmarks as the physical arena."],
  ["limted", "limited", "The analysis was limited to preregistered outcome measures."],
  ["wich", "which", "We selected the condition which preserved the highest signal-to-noise ratio."],
  ["elevant", "relevant", "Only relevant anatomical landmarks were included in the alignment."],
  ["independance", "independence", "Statistical independence was evaluated before pooling observations."],
  ["acutally", "actually", "The apparent decrease actually reflected a change in baseline variance."],
  ["improtant", "important", "An important control ruled out photobleaching as an explanation."],
  ["aquire", "acquire", "We acquire one structural stack before each functional session."],
  ["admitt", "admit", "The authors admit that the final cohort is relatively small."],
  ["definitly", "definitely", "The perturbation definitely altered the late response component."],
  ["uderstand", "understand", "To understand the effect, we compared matched cellular populations."],
  ["topyc", "topic", "The final section returns to the topic of circuit-level organization."],
  ["istance", "instance", "In each instance, the original image was retained unchanged."],
  ["remeber", "remember", "Readers should remember that correlation does not establish causation."],
  ["usefull", "useful", "This representation is useful for comparing projection geometries."],
  ["convincet", "convince", "The replication data should convince readers that the effect is robust."],
  ["vehicals", "vehicles", "Autonomous vehicles provided a controlled test of the navigation model."],
  ["benificial", "beneficial", "The slower scan was beneficial for resolving fine axonal branches."],
  ["obssesed", "obsessed", "The algorithm was not obsessed with minimizing a single error metric."],
  ["drasticaly", "drastically", "Background subtraction drastically improved contrast in deep tissue."],
  ["techincal", "technical", "A technical replicate confirmed the stability of the assay."],
  ["vehical", "vehicle", "The vehicle control received the same injection volume."],
  ["feul", "fuel", "Glucose served as the primary metabolic fuel during the experiment."],
  ["equiped", "equipped", "The microscope was equipped with resonant and galvo scanners."],
  ["numer", "number", "The number of detected events increased during stimulation."],
  ["perfomance", "performance", "Classifier performance was evaluated on an untouched test set."],
  ["incereasing", "increasing", "Increasing laser power improved signal but accelerated bleaching."],
  ["convinient", "convenient", "The compact representation is convenient for project-wide search."],
  ["atomosphere", "atmosphere", "The chamber atmosphere was continuously humidified."],
  ["beeing", "being", "The sample was imaged while being perfused with oxygenated solution."],
  ["exteme", "extreme", "Extreme outliers were retained until the blinded quality review."],
  ["eperiment", "experiment", "The experiment tested a prespecified causal prediction."],
  ["sceince", "science", "Open science makes the complete analysis easier to inspect and reproduce."],
];

const SCIENTIFIC_KEEP_CASES: ReadonlyArray<readonly [term: string, sentence: string]> = [
  ["somatodendritic", "The somatodendritic compartment integrated the incoming current."],
  ["glutamatergic", "The glutamatergic projection terminated in superficial layers."],
  ["gabaergic", "The gabaergic population suppressed spontaneous firing."],
  ["dopaminergic", "The dopaminergic input changed reward-related activity."],
  ["serotonergic", "The serotonergic fibers were sparse in the recorded region."],
  ["cholinergic", "The cholinergic signal preceded cortical desynchronization."],
  ["noradrenergic", "The noradrenergic axons increased activity during arousal."],
  ["postsynaptic", "The postsynaptic response decayed within fifty milliseconds."],
  ["presynaptic", "The presynaptic boutons were tracked across imaging sessions."],
  ["monosynaptic", "The monosynaptic connection was confirmed by short latency."],
  ["polysynaptic", "The polysynaptic response emerged after the initial component."],
  ["homeostatic", "The homeostatic mechanism stabilized network excitability."],
  ["allostatic", "The allostatic response depended on prior stress exposure."],
  ["neurovascular", "The neurovascular signal lagged behind neuronal activity."],
  ["hemodynamic", "The hemodynamic component was removed from fluorescence traces."],
  ["vasomotor", "The vasomotor oscillation remained visible during baseline."],
  ["arteriolar", "The arteriolar diameter increased after sensory stimulation."],
  ["myelinated", "The myelinated axons traversed the subcortical white matter."],
  ["unmyelinated", "The unmyelinated fibers formed a dense local plexus."],
  ["oligodendroglial", "The oligodendroglial lineage expanded after injury."],
  ["astroglial", "The astroglial processes surrounded the penetrating vessel."],
  ["microcircuit", "The local microcircuit generated a recurrent response."],
  ["connectomic", "The connectomic reconstruction contained every traced branch."],
  ["transcriptomic", "The transcriptomic cluster matched the physiological class."],
  ["proteomic", "The proteomic analysis identified several enriched pathways."],
  ["metabolomic", "The metabolomic profile changed after prolonged wakefulness."],
  ["epigenomic", "The epigenomic state differed between neuronal subtypes."],
  ["phosphoproteomic", "The phosphoproteomic screen revealed rapid kinase activation."],
  ["immunohistochemical", "The immunohistochemical label confirmed cell identity."],
  ["cytoarchitectonic", "The cytoarchitectonic boundary matched the atlas annotation."],
  ["tonotopic", "The tonotopic gradient extended across auditory cortex."],
  ["somatotopic", "The somatotopic map was preserved after registration."],
  ["visuomotor", "The visuomotor response predicted the upcoming turn."],
  ["sensorimotor", "The sensorimotor transformation depended on behavioral state."],
  ["corticospinal", "The corticospinal neurons projected to cervical segments."],
  ["corticostriatal", "The corticostriatal pathway carried action-related signals."],
  ["hippocampal", "The hippocampal ensemble reactivated during sleep."],
  ["hypothalamic", "The hypothalamic population tracked internal state."],
  ["cerebellar", "The cerebellar output corrected movement timing."],
  ["medullary", "The medullary circuit regulated respiratory rhythm."],
  ["mesencephalic", "The mesencephalic nucleus received bilateral input."],
  ["diencephalic", "The diencephalic territory was segmented separately."],
  ["telencephalic", "The telencephalic projection remained ipsilateral."],
  ["striatal", "The striatal neurons encoded movement vigor."],
  ["pallidal", "The pallidal output decreased before movement onset."],
  ["subthalamic", "The subthalamic response increased during stopping."],
  ["nigral", "The nigral projection innervated the dorsal striatum."],
  ["amygdalar", "The amygdalar ensemble responded to threat cues."],
  ["entorhinal", "The entorhinal input targeted distal dendrites."],
  ["perirhinal", "The perirhinal cortex contributed object information."],
  ["retrosplenial", "The retrosplenial signal tracked heading direction."],
  ["orbitofrontal", "The orbitofrontal population encoded expected outcome."],
  ["prelimbic", "The prelimbic activity increased during action selection."],
  ["infralimbic", "The infralimbic projection supported extinction learning."],
  ["parvalbumin", "The parvalbumin population fired at high rates."],
  ["somatostatin", "The somatostatin interneurons targeted distal dendrites."],
  ["calretinin", "The calretinin cells occupied superficial cortical layers."],
  ["calbindin", "The calbindin signal distinguished a neuronal subpopulation."],
  ["neuropeptide", "The neuropeptide concentration increased after stimulation."],
  ["endocannabinoid", "The endocannabinoid signal reduced transmitter release."],
  ["metabotropic", "The metabotropic response developed over several seconds."],
  ["ionotropic", "The ionotropic current produced a rapid depolarization."],
  ["extrasynaptic", "The extrasynaptic receptors mediated a tonic current."],
  ["perisynaptic", "The perisynaptic transporters limited glutamate spread."],
  ["juxtacellular", "The juxtacellular recording identified the labeled neuron."],
  ["intracortical", "The intracortical axons crossed multiple columns."],
  ["subcortical", "The subcortical input arrived before the cortical response."],
  ["corticofugal", "The corticofugal projection reached the auditory midbrain."],
  ["thalamostriatal", "The thalamostriatal boutons were distributed unevenly."],
  ["hippocamposeptal", "The hippocamposeptal projection followed the fornix."],
  ["septohippocampal", "The septohippocampal fibers entered through the fimbria."],
  ["neurofilament", "The neurofilament stain highlighted long-range axons."],
  ["synaptophysin", "The synaptophysin puncta marked presynaptic terminals."],
  ["postsynaptically", "The receptor acted postsynaptically in the target cell."],
  ["presynaptically", "The modulation acted presynaptically on release probability."],
  ["electrophoretic", "The electrophoretic separation resolved the protein bands."],
  ["photoactivatable", "The photoactivatable probe was uncaged in one dendrite."],
  ["photoconvertible", "The photoconvertible protein marked the stimulated cells."],
  ["bioluminescent", "The bioluminescent reporter tracked intracellular signaling."],
  ["neuropil", "The neuropil fluorescence was subtracted from the somatic trace."],
];

function typoCase(index: number, bad: string, good: string, sentence: string): CorrectionCorpusCase {
  const at = sentence.toLocaleLowerCase().indexOf(good.toLocaleLowerCase());
  if (at < 0) throw new Error(`Unseen correction sentence omits ${good}`);
  const replacement = sentence.slice(at, at + good.length);
  const original = /^[A-Z]/.test(replacement) ? `${bad[0].toLocaleUpperCase()}${bad.slice(1)}` : bad;
  const text = `${sentence.slice(0, at)}${original}${sentence.slice(at + good.length)}`;
  const gold: CorrectionGoldEdit = { original, replacement, action: "use", occurrence: 0 };
  return {
    id: `fcu-v1-p${String(index).padStart(3, "0")}`,
    family: "authentic-unseen-typo",
    partition: "held-out",
    policyClass: "mechanical",
    text,
    gold: [gold],
    provenance: "toefl-spell",
  };
}

function keepCase(index: number, term: string, sentence: string): CorrectionCorpusCase {
  const from = sentence.indexOf(term);
  if (from < 0) throw new Error(`Unseen preservation sentence omits ${term}`);
  return {
    id: `fcu-v1-k${String(index).padStart(3, "0")}`,
    family: "unseen-scientific-preservation",
    partition: "held-out",
    policyClass: "mechanical",
    text: sentence,
    gold: [{ original: term, replacement: term, action: "keep", occurrence: 0 }],
    extraLints: [{
      from,
      to: from + term.length,
      problem: term,
      kind: "Spelling",
      message: "Sealed scientific preservation stress case",
      suggestions: [],
    }],
    provenance: "synthetic",
  };
}

export function buildCorrectionUnseenCorpus(): CorrectionCorpusCase[] {
  const typoLexemes = new Set<string>();
  const keepLexemes = new Set<string>();
  const positives = TYPO_CASES.map(([bad, good, sentence], index) => {
    const key = `${bad.toLocaleLowerCase()}\u0000${good.toLocaleLowerCase()}`;
    if (typoLexemes.has(key)) throw new Error(`Duplicate unseen typo pair: ${key}`);
    typoLexemes.add(key);
    return typoCase(index, bad, good, sentence);
  });
  const keeps = SCIENTIFIC_KEEP_CASES.map(([term, sentence], index) => {
    const key = term.toLocaleLowerCase();
    if (keepLexemes.has(key)) throw new Error(`Duplicate unseen preservation term: ${term}`);
    keepLexemes.add(key);
    return keepCase(index, term, sentence);
  });
  return [...positives, ...keeps];
}
