# Flux correction evaluation

- Provider: oracle
- Model: qwen3:4b-instruct
- Contract: direct
- Thinking: false
- Rescue mode: none
- Corpus: flux-correction-unseen-v1 (160/160 cases; `2b67dff2d12ec30ccbe3b3e76f7eca7eab74f13c739860d02a4a448691935483`)
- All experimental lanes: 100.00% precision (Wilson lower 67.56%), 10.00% coverage
- Shipped sentence policy: 100.00% precision (Wilson lower 67.56%), 10.00% coverage
- Paragraph lane enabled: no (failed its locked precision gate)
- Candidate availability: 87.50%
- Protected changes: 0
- Calls / 1,000 words (adversarial corpus): 0.0
- Calls / 1,000 words (realistic suppression/cache audit): 8.7 (pass; target ≤ 20)
- Latency p50/p95/p99: 0 / 0 / 0 ms
- Order stability: 100.00%
- Provider failures: 0

## Candidate availability by policy class

- mechanical: 87.50% (63/72)
