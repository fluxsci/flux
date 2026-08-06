# Flux correction evaluation

- Provider: managed
- Model: qwen3-4b-q4_k_m
- Contract: direct
- Thinking: false
- Rescue mode: full
- Judgment: really-aggressive
- Corpus: flux-correction-aggressiveness-v1 (24/24 cases; `3065dbab8b4cad7b734bf7e3eb3f8445f622b2cdcfc7bb1527a87ac173c759f2`)
- All experimental lanes: 100.00% precision (Wilson lower 72.25%), 83.33% coverage
- Shipped sentence policy: 100.00% precision (Wilson lower 72.25%), 83.33% coverage
- Paragraph lane enabled: no (failed its locked precision gate)
- Candidate availability: 58.33%
- Protected changes: 0
- Calls / 1,000 words (adversarial corpus): 147.2
- Calls / 1,000 words (realistic suppression/cache audit): 7.6 (pass; target ≤ 20)
- Latency p50/p95/p99: 521 / 675 / 713 ms
- Order stability: 100.00%
- Provider failures: 0

## Candidate availability by policy class

- mechanical: 58.33% (7/12)
