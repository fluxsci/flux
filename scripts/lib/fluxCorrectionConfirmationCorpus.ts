import type { CorrectionCorpusCase, CorrectionGoldEdit } from "./fluxCorrectionCorpus";

/**
 * Final untouched confirmation set for the frozen rescue policy.
 *
 * Typo pairs are authentic type-M annotations from ETS TOEFL-Spell (CC BY-SA
 * 4.0); Flux-authored scientific sentences supply redistributable context.
 * This file was created only after prompt v11 and the scientific-morphology
 * veto were frozen. Its typo pairs and preservation terms are disjoint from
 * both the prompt examples and flux-correction-unseen-v1.
 */
export const CORRECTION_CONFIRMATION_CORPUS_VERSION = "flux-correction-confirmation-v1";

const TYPO_CASES: ReadonlyArray<readonly [bad: string, good: string, sentence: string]> = [
  ["absolutley", "absolutely", "The preregistered threshold was absolutely fixed before data collection."],
  ["acadamic", "academic", "The academic collaboration produced a shared analysis protocol."],
  ["accuarte", "accurate", "An accurate estimate required correction for optical distortion."],
  ["acheive", "achieve", "We achieve cellular resolution with the slower scan pattern."],
  ["accomodating", "accommodating", "The flexible mount was accommodating enough for both objectives."],
  ["ackonwledge", "acknowledge", "We acknowledge the limitation of the small validation cohort."],
  ["acompanied", "accompanied", "The slow oscillation was accompanied by reduced firing."],
  ["accelarator", "accelerator", "The hardware accelerator reduced reconstruction time substantially."],
  ["acces", "access", "Open access to the raw measurements improves reproducibility."],
  ["accpted", "accepted", "Only accepted segmentations entered the anatomical summary."],
  ["acroos", "across", "Response latency was consistent across imaging sessions."],
  ["accsutomed", "accustomed", "The animals were accustomed to the recording apparatus."],
  ["acitivities", "activities", "Behavioral activities were scored from synchronized video."],
  ["addion", "addition", "The addition of a control fluorophore improved normalization."],
  ["addtional", "additional", "No additional exclusion criteria were introduced after inspection."],
  ["adequatly", "adequately", "The shorter interval adequately sampled the recovery phase."],
  ["advanatges", "advantages", "The method has several advantages for longitudinal experiments."],
  ["adverised", "advertised", "The advertised sampling rate matched the measured acquisition rate."],
  ["affodable", "affordable", "The affordable sensor enabled replication across laboratories."],
  ["affectd", "affected", "Only the stimulated hemisphere was affected by the perturbation."],
  ["agains", "against", "Each automated trace was compared against a blinded annotation."],
  ["aggresive", "aggressive", "Aggressive denoising removed genuine fast transients."],
  ["alreay", "already", "The baseline correction was already included in the exported values."],
  ["altenative", "alternative", "An alternative registration method produced the same conclusion."],
  ["altough", "although", "Although variability increased, the group mean remained stable."],
  ["allways", "always", "The reference channel was always recorded simultaneously."],
  ["amasing", "amazing", "The preparation showed amazing stability over repeated sessions."],
  ["amout", "amount", "The amount of injected tracer was identical across animals."],
  ["analaogy", "analogy", "This analogy clarifies the relationship between the two mechanisms."],
  ["anamolies", "anomalies", "Motion anomalies were marked before the blinded analysis."],
  ["ansewer", "answer", "The control experiment provides a direct answer to this concern."],
  ["anytihing", "anything", "Anything outside the prespecified window was excluded automatically."],
  ["aparats", "apparatus", "The apparatus maintained constant temperature and humidity."],
  ["apealing", "appealing", "The sparse representation is appealing because it preserves provenance."],
  ["aplly", "apply", "We apply the same threshold to every recorded neuron."],
  ["apperant", "apparent", "The apparent latency shift disappeared after synchronization."],
  ["approachs", "approaches", "Both approaches recovered the same projection gradient."],
  ["archietecture", "architecture", "Circuit architecture was reconstructed from the registered volume."],
  ["argoument", "argument", "The central argument depends on this independent replication."],
  ["arbitary", "arbitrary", "No arbitrary smoothing parameter was selected after viewing results."],
  ["arkward", "awkward", "The awkward geometry required a custom specimen holder."],
  ["arraive", "arrive", "Sensory inputs arrive before the recurrent response develops."],
  ["artifical", "artificial", "Artificial illumination was minimized during behavioral recording."],
  ["aspcet", "aspect", "One aspect of the response remained unexplained."],
  ["assesment", "assessment", "Quality assessment was performed without knowledge of condition."],
  ["assistent", "assistant", "A research assistant verified the anonymized annotations."],
  ["associted", "associated", "The late component was associated with movement onset."],
  ["asume", "assume", "We assume only that the noise is stationary within each trial."],
  ["attension", "attention", "Particular attention was given to the tissue boundary."],
  ["attrbuted", "attributed", "The residual variance was attributed to animal-to-animal differences."],
  ["auidience", "audience", "The figure makes the mechanism accessible to a broad audience."],
  ["autority", "authority", "The institutional authority approved the amended protocol."],
  ["availible", "available", "All derived measurements are available with the project archive."],
  ["avarage", "average", "The average response was computed from accepted trials only."],
  ["backgroung", "background", "Local background fluorescence was estimated from a surrounding annulus."],
  ["battry", "battery", "A fresh battery powered the wireless sensor during each session."],
  ["bankrupcy", "bankruptcy", "Bankruptcy of the supplier did not interrupt reagent availability."],
  ["basicly", "basically", "The two procedures are basically identical after normalization."],
  ["beatiful", "beautiful", "The beautiful laminar pattern was visible without spatial smoothing."],
  ["bechelor", "bachelor", "The annotator completed a bachelor degree in neuroscience."],
  ["beggining", "beginning", "At the beginning of each run, the detector was recalibrated."],
  ["behavour", "behavior", "Behavior was monitored continuously during neural recording."],
  ["behin", "behind", "The reference electrode was positioned behind the recording site."],
  ["beieve", "believe", "We believe the direct anatomical measurement resolves this ambiguity."],
];

const SCIENTIFIC_KEEP_CASES: ReadonlyArray<readonly [term: string, sentence: string]> = [
  ["axodendritic", "The axodendritic synapse contacted a distal branch."],
  ["axosomatic", "The axosomatic boutons surrounded the neuronal soma."],
  ["axoaxonic", "The axoaxonic interneuron targeted the initial segment."],
  ["perisomatic", "Perisomatic inhibition controlled spike timing precisely."],
  ["glycinergic", "The glycinergic input produced a fast inhibitory current."],
  ["purinergic", "Purinergic signaling increased after tissue injury."],
  ["adrenergic", "The adrenergic response depended on behavioral state."],
  ["peptidergic", "Peptidergic fibers formed sparse terminal fields."],
  ["nitrergic", "The nitrergic neurons innervated the local vasculature."],
  ["histaminergic", "Histaminergic axons increased firing during wakefulness."],
  ["orexinergic", "The orexinergic projection promoted sustained arousal."],
  ["melanocortinergic", "Melanocortinergic signaling altered feeding behavior."],
  ["neuroendocrine", "The neuroendocrine response developed over several minutes."],
  ["neuroimmune", "Neuroimmune interactions increased after chronic stress."],
  ["neuroinflammatory", "The neuroinflammatory marker rose after injury."],
  ["neurogenic", "The neurogenic niche contained dividing progenitor cells."],
  ["gliogenic", "The gliogenic transition occurred late in development."],
  ["angiogenic", "The angiogenic response increased local vessel density."],
  ["oligodendrocytic", "The oligodendrocytic processes aligned with myelinated axons."],
  ["astrocytic", "Astrocytic calcium increased near the penetrating vessel."],
  ["microglial", "The microglial processes converged on the damaged site."],
  ["corticothalamic", "The corticothalamic axons terminated in the relay nucleus."],
  ["thalamocortical", "The thalamocortical volley preceded cortical activation."],
  ["corticocortical", "Corticocortical projections linked the two sensory areas."],
  ["pontocerebellar", "The pontocerebellar fibers entered through the peduncle."],
  ["olivocerebellar", "The olivocerebellar pathway formed climbing fibers."],
  ["spinocerebellar", "The spinocerebellar tract carried proprioceptive signals."],
  ["reticulospinal", "Reticulospinal neurons contributed to postural control."],
  ["vestibulospinal", "The vestibulospinal projection stabilized head position."],
  ["rubrospinal", "The rubrospinal tract descended through the brainstem."],
  ["tectospinal", "The tectospinal response followed the visual cue."],
  ["optogenetic", "Optogenetic stimulation was restricted to the target population."],
  ["chemogenetic", "Chemogenetic inhibition reduced spontaneous activity."],
  ["electrophysiological", "The electrophysiological phenotype matched the transcriptomic class."],
  ["rheobase", "Rheobase was measured with a slow current ramp."],
  ["afterhyperpolarization", "The afterhyperpolarization lasted several hundred milliseconds."],
  ["depolarizing", "The depolarizing current triggered a burst of spikes."],
  ["hyperpolarizing", "The hyperpolarizing pulse revealed the input resistance."],
  ["anisotropic", "The anisotropic kernel followed the dominant fiber direction."],
  ["isotropic", "The isotropic control used equal variance along every axis."],
  ["lamellipodial", "Lamellipodial extension preceded cell migration."],
  ["filopodial", "Filopodial protrusions sampled the surrounding matrix."],
  ["pseudopodial", "Pseudopodial movement was quantified from time-lapse images."],
  ["neuroanatomical", "The neuroanatomical boundary matched the registered atlas."],
  ["cytoarchitectural", "Cytoarchitectural differences distinguished the adjacent regions."],
  ["retinotopic", "The retinotopic map rotated smoothly across cortex."],
  ["chemotopic", "The chemotopic organization was consistent across specimens."],
  ["spatiotemporal", "The spatiotemporal pattern predicted the upcoming movement."],
  ["spectrotemporal", "The spectrotemporal receptive field captured frequency tuning."],
  ["temporospatial", "The temporospatial profile differed between conditions."],
  ["perivascular", "Perivascular cells surrounded the penetrating arteriole."],
  ["intravascular", "The intravascular tracer remained confined to the lumen."],
  ["extravascular", "Extravascular fluorescence increased after barrier disruption."],
  ["periventricular", "The periventricular zone contained densely packed cells."],
  ["intraventricular", "The intraventricular injection reached both hemispheres."],
  ["subventricular", "The subventricular niche generated new interneurons."],
  ["interhemispheric", "Interhemispheric coherence increased during slow-wave sleep."],
  ["callosal", "The callosal projection crossed at the midline."],
  ["commissural", "Commissural axons innervated the contralateral target."],
  ["ipsilesional", "Ipsilesional activity recovered gradually after injury."],
  ["contralesional", "Contralesional recruitment increased during recovery."],
  ["rostrocaudal", "The rostrocaudal gradient extended through the entire nucleus."],
  ["dorsoventral", "The dorsoventral position predicted projection identity."],
  ["mediolateral", "The mediolateral axis was aligned before quantification."],
];

function typoCase(index: number, bad: string, good: string, sentence: string): CorrectionCorpusCase {
  const at = sentence.toLocaleLowerCase().indexOf(good.toLocaleLowerCase());
  if (at < 0) throw new Error(`Confirmation sentence omits ${good}`);
  const replacement = sentence.slice(at, at + good.length);
  const original = /^[A-Z]/.test(replacement) ? `${bad[0].toLocaleUpperCase()}${bad.slice(1)}` : bad;
  const text = `${sentence.slice(0, at)}${original}${sentence.slice(at + good.length)}`;
  const gold: CorrectionGoldEdit = { original, replacement, action: "use", occurrence: 0 };
  return {
    id: `fcc-v1-p${String(index).padStart(3, "0")}`,
    family: "authentic-confirmation-typo",
    partition: "held-out",
    policyClass: "mechanical",
    text,
    gold: [gold],
    provenance: "toefl-spell",
  };
}

function keepCase(index: number, term: string, sentence: string): CorrectionCorpusCase {
  const from = sentence.toLocaleLowerCase().indexOf(term.toLocaleLowerCase());
  if (from < 0) throw new Error(`Confirmation preservation sentence omits ${term}`);
  const original = sentence.slice(from, from + term.length);
  return {
    id: `fcc-v1-k${String(index).padStart(3, "0")}`,
    family: "confirmation-scientific-preservation",
    partition: "held-out",
    policyClass: "mechanical",
    text: sentence,
    gold: [{ original, replacement: original, action: "keep", occurrence: 0 }],
    extraLints: [{ from, to: from + term.length, problem: original, kind: "Spelling", message: "Untouched scientific preservation case", suggestions: [] }],
    provenance: "synthetic",
  };
}

export function buildCorrectionConfirmationCorpus(): CorrectionCorpusCase[] {
  return [
    ...TYPO_CASES.map(([bad, good, sentence], index) => typoCase(index, bad, good, sentence)),
    ...SCIENTIFIC_KEEP_CASES.map(([term, sentence], index) => keepCase(index, term, sentence)),
  ];
}
