# Flux correction evaluation

- Provider: oracle
- Model: qwen3:4b-instruct
- Contract: direct
- Thinking: false
- Corpus: flux-correction-rescue-v1 (160/160 cases; `9f00b9343afcfcb27a8f35a7aa3df56763cf6193ba7398fa4836fb8e07538589`)
- All experimental lanes: 100.00% precision (Wilson lower 95.42%), 100.00% coverage
- Shipped sentence policy: 100.00% precision (Wilson lower 95.42%), 100.00% coverage
- Paragraph lane enabled: no (failed its locked precision gate)
- Candidate availability: 15.00%
- Protected changes: 0
- Calls / 1,000 words (adversarial corpus): 0.0
- Calls / 1,000 words (realistic suppression/cache audit): 8.7 (pass; target ≤ 20)
- Latency p50/p95/p99: 0 / 0 / 0 ms
- Order stability: 100.00%
- Provider failures: 0

## Candidate availability by policy class

- mechanical: 15.00% (12/80)
