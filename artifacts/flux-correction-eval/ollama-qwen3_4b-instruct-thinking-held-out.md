# Flux correction evaluation

- Provider: ollama
- Model: qwen3:4b-instruct
- Contract: direct
- Thinking: true
- Corpus: flux-correction-v1 (700/3500 cases; `d4e57b2e93b199204eb33c6c1b86ec86f26b85ca878021bfa079b01f3d8328e2`)
- All experimental lanes: 95.65% precision (Wilson lower 93.38%), 95.65% coverage
- Shipped sentence policy: 100.00% precision (Wilson lower 99.09%), 95.45% coverage
- Paragraph lane enabled: no (failed its locked precision gate)
- Candidate availability: 100.00%
- Protected changes: 0
- Calls / 1,000 words (adversarial corpus): 42.5
- Calls / 1,000 words (realistic suppression/cache audit): 8.7 (pass; target ≤ 20)
- Latency p50/p95/p99: 186 / 265 / 276 ms
- Order stability: 100.00%
- Provider failures: 0

## Candidate availability by policy class

- mechanical: 100.00% (50/50)
- real-word: 100.00% (80/80)
- boundary: 100.00% (20/20)
- phrase-punctuation: 100.00% (20/20)
