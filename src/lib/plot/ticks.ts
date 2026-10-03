// Nice tick generation for redrawn plot guides (colour-system plan A7.4; F4 reuses it for
// axes). Pure arithmetic: linear ticks at 1·2·5 × 10ᵏ steps aiming at ~`target` ticks, log
// ticks the way fluxplot labels a log colour key (decades, 3×10ᵏ over short spans, minor
// mantissas 2…9), and matplotlib-like labels (a shortest plain number, or 10ᵏ for a log
// formatter).

/** The 1·2·5 step that puts about `target` ticks across `span`. */
export function niceStep(span: number, target = 5): number {
  if (!(span > 0) || !Number.isFinite(span)) return 1;
  const raw = span / Math.max(1, target);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const r = raw / mag;
  return (r < 1.5 ? 1 : r < 3 ? 2 : r < 7 ? 5 : 10) * mag;
}

/** Nice linear ticks inside [lo, hi] (inclusive, rounded to the step's precision). */
export function linearTicks(lo: number, hi: number, target = 5): number[] {
  if (!(Number.isFinite(lo) && Number.isFinite(hi))) return [];
  const [a, b] = lo <= hi ? [lo, hi] : [hi, lo];
  if (a === b) return [a];
  const step = niceStep(b - a, target);
  const digits = Math.max(0, -Math.floor(Math.log10(step)) + 1);
  const out: number[] = [];
  for (let v = Math.ceil(a / step - 1e-9) * step; v <= b + step * 1e-9; v += step) {
    const r = Number(v.toFixed(digits));
    if (r >= a - step * 1e-9 && r <= b + step * 1e-9) out.push(r === 0 ? 0 : r);
  }
  return out;
}

/** Log ticks inside [lo, hi] (both > 0), the way fluxplot labels a log colour key: decades,
 *  with 3×10ᵏ added while the span is three decades or fewer (LogLocator subs (1, 3)); a span
 *  too short for two such ticks falls back to 1·2·5 mantissas, then to nice linear ticks. */
export function logTicks(lo: number, hi: number): number[] {
  if (!(lo > 0 && hi > 0 && Number.isFinite(lo) && Number.isFinite(hi))) return [];
  const [a, b] = lo <= hi ? [lo, hi] : [hi, lo];
  const majors = logMantissas(a, b, Math.log10(b / a) <= 3 ? [1, 3] : [1]);
  if (majors.length >= 2) return majors;
  const fine = logMantissas(a, b, [1, 2, 5]);
  return fine.length >= 2 ? fine : linearTicks(a, b);
}

/** The unlabelled minor ticks of a log key: mantissas 2…9 in range that are not majors. */
export function logMinorTicks(lo: number, hi: number, majors: number[]): number[] {
  if (!(lo > 0 && hi > 0 && Number.isFinite(lo) && Number.isFinite(hi))) return [];
  const [a, b] = lo <= hi ? [lo, hi] : [hi, lo];
  return logMantissas(a, b, [2, 3, 4, 5, 6, 7, 8, 9]).filter((v) => !majors.some((m) => Math.abs(m - v) <= v * 1e-9));
}

function logMantissas(a: number, b: number, subs: number[]): number[] {
  const out: number[] = [];
  for (let k = Math.floor(Math.log10(a)) - 1; k <= Math.ceil(Math.log10(b)) + 1; k++)
    for (const m of subs) { const v = m * 10 ** k; if (v >= a * (1 - 1e-9) && v <= b * (1 + 1e-9)) out.push(v); }
  return out.sort((x, y) => x - y);
}

/** matplotlib's `%g`-like shortest plain label. */
export function formatPlain(v: number): string {
  if (v === 0) return "0";
  const abs = Math.abs(v);
  if (abs >= 1e6 || abs < 1e-4) {
    const e = Math.floor(Math.log10(abs));
    const m = Number((v / 10 ** e).toPrecision(6));
    return `${m}e${e < 0 ? "-" : "+"}${String(Math.abs(e)).padStart(2, "0")}`;
  }
  return String(Number(v.toPrecision(6)));
}

export type TickFormatter = "plain" | "sci" | "log" | "percent" | "custom";
/** A tick label: `text` plus, for a log formatter's power of ten, the exponent to superscript. */
export function formatTick(v: number, formatter: TickFormatter = "plain"): { text: string; base?: string; exponent?: string } {
  if (formatter === "percent") return { text: `${formatPlain(v)}%` };
  if (formatter === "log" && v > 0) {
    const k = Math.log10(v);
    if (Math.abs(k - Math.round(k)) < 1e-9) return { text: `10^${Math.round(k)}`, base: "10", exponent: String(Math.round(k)) };
    return { text: formatPlain(v) };
  }
  return { text: formatPlain(v) };
}

/** matplotlib's ScalarFormatter labels for one tick set: every label carries the same number of
 *  decimals — the fewest that still distinguish the ticks (`_set_format`) — and a unicode minus
 *  (`axes.unicode_minus`). `["−1.0", "−0.5", "0.0", "0.5", "1.0"]`, `["10", "20", "30"]`. */
export function scalarLabels(values: number[]): string[] {
  if (!values.length) return [];
  const finite = values.filter(Number.isFinite);
  let range = finite.length ? Math.max(...finite) - Math.min(...finite) : 0;
  if (range === 0) range = finite.length ? Math.max(...finite.map(Math.abs)) : 0;
  if (range === 0) range = 1;
  const oom = Math.floor(Math.log10(range));
  let sigfigs = Math.max(0, 3 - oom);
  const thresh = 1e-3 * 10 ** oom;
  while (sigfigs >= 0) {
    const off = Math.max(...finite.map((v) => Math.abs(v - Number(v.toFixed(sigfigs)))));
    if (off < thresh) sigfigs -= 1; else break;
  }
  sigfigs += 1;
  return values.map((v) => (Number.isFinite(v) ? (Math.abs(v) < 0.5 * 10 ** -sigfigs ? 0 : v).toFixed(sigfigs).replace("-", "\u2212") : ""));
}

/** The ticks for a norm's limits: decades on a log scale, nice steps otherwise. */
export function ticksFor(kind: string, vmin: number, vmax: number, target = 5): number[] {
  return kind === "log" ? logTicks(vmin, vmax) : linearTicks(vmin, vmax, target);
}
