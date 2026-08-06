# Flux correction evaluation

- Provider: oracle
- Model: qwen3:4b-instruct
- Contract: direct
- Thinking: false
- Rescue mode: full
- Corpus: flux-correction-confirmation-v1 (128/128 cases; `87b063603cd56786432af4b4738c38b9d862fa798acba63b7bb70d8b18fd150f`)
- All experimental lanes: 100.00% precision (Wilson lower 94.34%), 100.00% coverage
- Shipped sentence policy: 100.00% precision (Wilson lower 94.34%), 100.00% coverage
- Paragraph lane enabled: no (failed its locked precision gate)
- Candidate availability: 89.47%
- Protected changes: 0
- Calls / 1,000 words (adversarial corpus): 0.0
- Calls / 1,000 words (realistic suppression/cache audit): 7.6 (pass; target ≤ 20)
- Latency p50/p95/p99: 0 / 0 / 0 ms
- Order stability: 100.00%
- Provider failures: 0

## Candidate availability by policy class

- mechanical: 89.47% (51/57)
