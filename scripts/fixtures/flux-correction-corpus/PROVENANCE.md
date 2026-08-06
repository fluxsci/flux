# Flux correction corpus provenance

Corpus version: `flux-correction-v1`

Every case emitted by `scripts/lib/fluxCorrectionCorpus.ts` is synthetic and authored for Flux.
No manuscript sentence or third-party publication text is included. The generator is deterministic;
the evaluation report records the generator version, case count, partition, and content hash.

The held-out partition is assigned deterministically before provider evaluation. Its cases are not
used to change prompts or thresholds after a benchmark run begins.
