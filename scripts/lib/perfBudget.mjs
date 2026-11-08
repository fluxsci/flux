// Host scale for ABSOLUTE wall-clock budgets in pure-tier gates (2026-11-08).
//
// A pure gate's millisecond pin ("5,000-node ring align < 30 ms") was authored on the
// reference workstation and sized there with a few times headroom over the measured value.
// GitHub's hosted runner (4 vCPU EPYC, shared with three other gates under `--jobs 4`) reads
// the same code 4-11x slower than that desk (CI run 42455127186 vs the owner's box), so the
// pins went red on every push without any regression. A pin that opts in here is multiplied
// by FLUX_PERF_SCALE, and the assertion PRINTS the effective budget so a reader always sees
// what was enforced: "67.3 ms (< 40 × 4 = 160, FLUX_PERF_SCALE=4)".
//
// Rules (guide §7 "Host-scaled wall-clock budgets"):
//   - default 1: an unset variable leaves every budget exactly as authored (local runs);
//   - only absolute wall-clock pins opt in. Ratios ("< 1.4x the 16-glide case"), counts,
//     pixel residuals and structural checks NEVER scale — they are host-independent;
//   - ci.yml sets the value from MEASURED CI numbers (worst observed reading / its budget,
//     rounded up), never to make a newly slow gate pass; a reading over the SCALED budget is a
//     regression like any other;
//   - the value is bounded to [1, MAX_PERF_SCALE] so the knob cannot quietly switch a gate off.

export const MAX_PERF_SCALE = 8;

/** Parse FLUX_PERF_SCALE (unset or "" = 1). Throws on anything outside [1, MAX_PERF_SCALE]. */
export function perfScale(env = process.env) {
  const raw = env.FLUX_PERF_SCALE;
  if (raw === undefined || raw === "") return 1;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1 || n > MAX_PERF_SCALE)
    throw new Error(`FLUX_PERF_SCALE must be a number in [1, ${MAX_PERF_SCALE}] (got ${JSON.stringify(raw)})`);
  return n;
}

const fmt = (v) => String(Math.round(v * 1000) / 1000);

/**
 * A host-scaled wall-clock budget. `ms` is the effective limit to compare against; `text` is
 * the budget as the assertion should print it: "40" at scale 1, "40 × 4 = 160, FLUX_PERF_SCALE=4"
 * otherwise (so `(< ${b.text})` reads "(< 40)" locally and shows its arithmetic on CI).
 * @param {number} authoredMs the budget as authored on the reference workstation
 * @param {number} [scale] defaults to the process's FLUX_PERF_SCALE (an invalid value throws, failing the gate loudly)
 */
export function perfBudget(authoredMs, scale = perfScale()) {
  const ms = authoredMs * scale;
  return { ms, authoredMs, scale, text: scale === 1 ? fmt(authoredMs) : `${fmt(authoredMs)} × ${fmt(scale)} = ${fmt(ms)}, FLUX_PERF_SCALE=${fmt(scale)}` };
}
