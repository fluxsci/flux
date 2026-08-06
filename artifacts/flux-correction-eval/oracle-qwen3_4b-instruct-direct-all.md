# Flux correction evaluation

- Provider: oracle
- Model: qwen3:4b-instruct
- Contract: direct
- Thinking: false
- Corpus: flux-correction-v1 (3500/3500 cases; `d4e57b2e93b199204eb33c6c1b86ec86f26b85ca878021bfa079b01f3d8328e2`)
- All experimental lanes: 100.00% precision (Wilson lower 99.84%), 100.00% coverage
- Shipped sentence policy: 100.00% precision (Wilson lower 99.83%), 100.00% coverage
- Paragraph lane enabled: no (failed its locked precision gate)
- Candidate availability: 100.00%
- Protected changes: 0
- Calls / 1,000 words (adversarial corpus): 0.0
- Calls / 1,000 words (realistic suppression/cache audit): 8.7 (pass; target ≤ 20)
- Latency p50/p95/p99: 0 / 0 / 0 ms
- Order stability: 100.00%
- Provider failures: 0

## Candidate availability by policy class

- mechanical: 100.00% (75/75)
- real-word: 100.00% (400/400)
- boundary: 100.00% (100/100)
- phrase-punctuation: 100.00% (100/100)
