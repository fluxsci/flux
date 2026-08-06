# Flux contextual-correction evaluation

These committed text reports are the acceptance evidence for Paper's two-layer
correction system. No private manuscript or TOEFL11 essay text is included.

## Corpora

- `flux-correction-v2`: 3,500 deterministic general-policy cases, SHA-256
  `8fd35709…8aa74b`.
- `flux-correction-unseen-v1`: 80 authentic TOEFL-Spell typo pairs in
  Flux-authored manuscript contexts plus 80 one-off scientific terms. This was
  the rescue development set; its first run exposed instant spacing and
  scientific-preservation failures that were fixed before confirmation.
- `flux-correction-confirmation-v1`: 64 different authentic TOEFL-Spell typo
  pairs plus 64 different scientific terms, SHA-256 `87b06360…fd150f`.
  Prompt v11 and the mutation policy were frozen before this set was created.
  Its originals are lexeme-disjoint from the development set.
- `flux-correction-aggressiveness-v1`: 12 deliberately difficult three/four-edit
  misspellings plus 12 preservation controls, SHA-256 `3065dbab…c759f2`. It
  distinguishes the wider modes on the class they are designed to affect; it
  is not substituted for the untouched confirmation corpus.

TOEFL-Spell is published by ETS under CC BY-SA 4.0. Flux uses only its public
misspelling/correction annotations; all surrounding sentences here are new,
redistributable Flux fixtures.

## Selected path

The selected sentence lane is bounded generation with four independent gates:

1. Harper identifies an exact unresolved spelling span and supplies up to six
   nearby dictionary words.
2. Qwen may keep the original, use a local proposal, or propose one plain word
   within the selected mode's hard edit envelope. Scientific-looking forms
   receive an additional preservation veto.
3. A fresh, separate Qwen call must approve the exact proposal in context.
4. The renderer requires current-source identity, protected-range safety,
   learned-veto and dictionary safety, plus an independent Harper lexicon check
   before the exact span can animate into place.

The model never rewrites a sentence and cannot approve its own generated word.

### Untouched same-case ablation

All three Ollama arms below ran the exact same 128 confirmation cases three
times with candidate and suggestion ordering shuffled:

| Qwen3 4B path | Correct automatic edits | Precision | Typo coverage | Scientific changes | Stability | p50 / p95 |
|---|---:|---:|---:|---:|---:|---:|
| No rescue | 7/7 | 100% | 10.94% | 0 | 100% | ~0 / ~0 ms |
| Harper/local proposals only | 55/55 | 100% | 85.94% | 0 | 100% | 227 / 403 ms |
| Full bounded generation | 60/60 | 100% | **93.75%** | 0 | 100% | 246 / 412 ms |

The deterministic oracle ceilings on those same cases are 10.94%, 90.63%, and
100%. After seven instant fixes, Harper/local proposals expose 51 of 57
remaining intended words (89.47%). Full generation therefore produces a real
7.81-point total-coverage gain over local-only and recovers five cases that no
Harper/local candidate could express.

### Flux-managed versus Ollama

Flux-managed uses the exact pinned 2,497,280,480-byte Qwen3 4B Instruct 2507
Q4_K_M blob (`85e4a5b7…54b18b9`) through Flux's pinned llama.cpp helper. On the
same Linux GPU host and confirmation corpus:

| Provider | Precision | Coverage | Stability | p50 / p95 / p99 | Acceleration |
|---|---:|---:|---:|---:|---|
| Flux managed | 100% (62/62) | **96.88%** | 100% | 293 / 513 / 627 ms | Vulkan |
| Ollama | 100% (60/60) | 93.75% | 100% | 246 / 412 / 496 ms | GPU |

Ollama was modestly faster on this host; Flux-managed recovered two additional
typos and remained well inside the 1.5-second silent-application window. Flux
managed remains the default because it is pinned, self-contained, and requires
no separate service. Apple Silicon packages use Metal; these are not M5-native
latency measurements.

## Judgment-envelope comparison

The current prompt-v13 implementation was rerun on the untouched 128-case
confirmation corpus for three shuffled repeats. The stress corpus was then run
separately to measure the difficult class rather than dilute or replace the
apples-to-apples result.

| Ollama mode | Confirmation typo coverage | Stress typo coverage | Measured precision | Scientific/control changes | Confirmation p50 / p95 |
|---|---:|---:|---:|---:|---:|
| Standard | 59/64 (92.19%) | 0/12 | 100% | 0 | 237 / 395 ms |
| Aggressive | 61/64 (95.31%) | 3/12 (25.00%) | 100% | 0 | 386 / 475 ms |
| Really aggressive | 61/64 (95.31%) | **10/12 (83.33%)** | 100% | 0 | 377 / 462 ms |

The wide mode therefore does not inflate the ordinary benchmark: Standard
remains the default, Aggressive provides the best small general-coverage gain,
and Really aggressive is an opt-in high-recall probe that materially helps only
the hard three/four-edit class in this evidence. Flux-managed confirmation in
Aggressive mode reached 62/64 (96.88%) at 517/740/1,148 ms p50/p95/p99; its
Really-aggressive stress run also reached 10/12 at 521/675/713 ms. All committed
runs had zero protected changes and zero provider failures.

## Reproduce

```bash
npx tsx scripts/flux-correct-eval.ts --suite confirmation --provider oracle --partition held-out --rescue-mode none
npx tsx scripts/flux-correct-eval.ts --suite confirmation --provider oracle --partition held-out --rescue-mode local-only
npx tsx scripts/flux-correct-eval.ts --suite confirmation --provider oracle --partition held-out --rescue-mode full
npx tsx scripts/flux-correct-eval.ts --suite confirmation --provider ollama --model qwen3:4b-instruct --partition held-out --rescue-mode none --repeats 3
npx tsx scripts/flux-correct-eval.ts --suite confirmation --provider ollama --model qwen3:4b-instruct --partition held-out --rescue-mode local-only --repeats 3
npx tsx scripts/flux-correct-eval.ts --suite confirmation --provider ollama --model qwen3:4b-instruct --partition held-out --rescue-mode full --repeats 3
FLUX_CONFIG_ROOT=/path/to/test-config npx tsx scripts/flux-correct-eval.ts --suite confirmation --provider managed --partition held-out --rescue-mode full --repeats 3
npx tsx scripts/flux-correct-eval.ts --suite confirmation --provider ollama --model qwen3:4b-instruct --partition all --aggressiveness aggressive --repeats 3
npx tsx scripts/flux-correct-eval.ts --suite aggressiveness --provider ollama --model qwen3:4b-instruct --partition all --aggressiveness really-aggressive --repeats 3
npx tsx scripts/verify-flux-correction-eval.ts
```

JSON reports include per-family metrics, bounded failure examples, candidate
availability, provider token counts, and latency distributions. Older standard,
batch, thinking, and rescue-stress reports remain as historical bakeoff data;
the confirmation reports above are the current acceptance gate.
