# Flux correction evaluation

- Provider: ollama
- Model: qwen3:4b-instruct
- Contract: direct
- Thinking: false
- Rescue mode: local-only
- Corpus: flux-correction-unseen-v1 (160/160 cases; `2b67dff2d12ec30ccbe3b3e76f7eca7eab74f13c739860d02a4a448691935483`)
- All experimental lanes: 95.59% precision (Wilson lower 87.81%), 81.25% coverage
- Shipped sentence policy: 95.59% precision (Wilson lower 87.81%), 81.25% coverage
- Paragraph lane enabled: no (failed its locked precision gate)
- Candidate availability: 87.50%
- Protected changes: 1
- Calls / 1,000 words (adversarial corpus): 123.4
- Calls / 1,000 words (realistic suppression/cache audit): 8.7 (pass; target ≤ 20)
- Latency p50/p95/p99: 232 / 451 / 596 ms
- Order stability: 99.35%
- Provider failures: 0

## Candidate availability by policy class

- mechanical: 87.50% (63/72)
