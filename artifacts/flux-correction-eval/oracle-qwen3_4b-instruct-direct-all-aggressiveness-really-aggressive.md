# Flux correction evaluation

- Provider: oracle
- Model: qwen3:4b-instruct
- Contract: direct
- Thinking: false
- Rescue mode: full
- Judgment: really-aggressive
- Corpus: flux-correction-aggressiveness-v1 (24/24 cases; `4627afa3d5fe779e6b0af38c294640cf122efee8d986dfc677716fc25f53c9e0`)
- All experimental lanes: 100.00% precision (Wilson lower 75.75%), 100.00% coverage
- Shipped sentence policy: 100.00% precision (Wilson lower 75.75%), 100.00% coverage
- Paragraph lane enabled: no (failed its locked precision gate)
- Candidate availability: 58.33%
- Protected changes: 0
- Calls / 1,000 words (adversarial corpus): 0.0
- Calls / 1,000 words (realistic suppression/cache audit): 7.6 (pass; target ≤ 20)
- Latency p50/p95/p99: 0 / 0 / 0 ms
- Order stability: 100.00%
- Provider failures: 0

## Candidate availability by policy class

- mechanical: 58.33% (7/12)
