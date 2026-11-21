/**
 * Which dimension is which: ranked proposals from a probe's hints, the check of an answer, and remembered rules.
 * Pure.
 *
 * Never guess silently: a proposal is `ready` (convert without asking) only with high-confidence metadata (OME,
 * ImageJ, per-page JSON that partitions the pages, shaped JSON with axis names), a single plane, or a remembered
 * rule. A file with no metadata gets proposals ranked low, and the asking surface (or an agent) chooses.
 */
import type { AnswerRule, Confidence, DimSpec, DimsAnswer, DimsProposal, Hint, TiffProbe } from "./types";
import { fmt } from "./meta/imagej";
import { unitFromKey } from "./meta/pagejson";

const NAME_RE = /^[a-z][a-z0-9_]*$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const RANK: Record<Confidence, number> = { high: 0, medium: 1, low: 2 };
const SOURCE_RANK: Record<string, number> = { remembered: -1, ome: 0, imagej: 1, pagejson: 2, shaped: 3, single: 4, periodicity: 5, guess: 6 };

/** The pages an answer covers and its dims with resolved sizes and page strides (fastest stride 1). */
export interface AnswerPlan {
  first: number;
  count: number;
  dims: Array<{ name: string; size: number; stride: number }>;
  /** Channels from the samples of a pixel ("c" or "rgb"), or null for one sample. */
  samples: "c" | "rgb" | null;
  /** Channels the samples make (3 for RGB/RGBA, else the sample count). */
  sampleChannels: number;
}

/** Resolve sizes ("rest") and strides. Returns problems instead when the dims cannot cover the pages. */
export function planAnswer(probe: TiffProbe, answer: DimsAnswer): { plan: AnswerPlan | null; problems: string[] } {
  const problems: string[] = [];
  const first = answer.pages?.first ?? 0;
  const count = answer.pages?.count ?? probe.pages - first;
  if (!Number.isInteger(first) || !Number.isInteger(count) || first < 0 || count < 1 || first + count > probe.pages) {
    problems.push(`pages ${first + 1}..${first + count} are not inside the file's ${probe.pages} pages`);
    return { plan: null, problems };
  }
  const dims = Array.isArray(answer.dims) ? answer.dims : [];
  const rest = dims.filter((d) => d.size === "rest");
  if (rest.length > 1) problems.push(`only one dimension may be "the rest" (${rest.map((d) => d.name).join(", ")} are)`);
  let fixed = 1;
  for (const d of dims) {
    if (d.size === "rest") continue;
    if (!(Number.isInteger(d.size) && d.size >= 1)) problems.push(`${d.name || "a dimension"}: size must be a whole number of at least 1 (got ${JSON.stringify(d.size)})`);
    else fixed *= d.size;
  }
  if (problems.length) return { plan: null, problems };
  let restSize = 1;
  if (rest.length) {
    if (count % fixed !== 0) { problems.push(`${count} pages cannot be split into ${dims.filter((d) => d.size !== "rest").map((d) => `${d.name} ${d.size}`).join(" × ")} × ${rest[0].name} (${count} / ${fixed} is not whole)`); return { plan: null, problems }; }
    restSize = count / fixed;
  } else if (fixed !== count) {
    problems.push(`the sizes multiply to ${fixed} pages (${dims.map((d) => `${d.name} ${d.size}`).join(" × ") || "a single plane"}); the file has ${count}${answer.pages ? " in the chosen pages" : ""}`);
    return { plan: null, problems };
  }
  const sizes = dims.map((d) => (d.size === "rest" ? restSize : (d.size as number)));
  const strides = sizes.map((_, i) => sizes.slice(i + 1).reduce((a, b) => a * b, 1));
  const spp = probe.plane.samples;
  const samples = spp > 1 ? answer.samples ?? (probe.plane.photometric === 2 && spp >= 3 ? "rgb" : "c") : null;
  return {
    plan: { first, count, dims: dims.map((d, i) => ({ name: d.name, size: sizes[i], stride: strides[i] })), samples, sampleChannels: samples === "rgb" ? 3 : spp },
    problems,
  };
}

const finitePos = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

const INT_RANGE: Record<string, [number, number]> = {
  uint8: [0, 255], int8: [-128, 127], uint16: [0, 65535], int16: [-32768, 32767], uint32: [0, 4294967295], int32: [-2147483648, 2147483647],
};

/** Every reason an answer is not acceptable for this file (empty: acceptable). */
export function answerProblems(probe: TiffProbe, answer: DimsAnswer): string[] {
  if (!answer || typeof answer !== "object") return ["the answer must be an object"];
  const problems: string[] = probe.refusals.map((r) => r.message);
  const { plan, problems: sizeProblems } = planAnswer(probe, answer);
  problems.push(...sizeProblems);
  const names = (answer.dims ?? []).map((d) => d.name);
  for (const n of names) {
    if (!n) problems.push("every dimension needs a name (t, z, c or a lower-case name such as trial)");
    else if (!NAME_RE.test(n)) problems.push(`"${n}" is not a valid dimension name: lower-case letters, digits and _ , starting with a letter`);
    else if (n === "y" || n === "x") problems.push(`"${n}" is the plane itself; the pages' dimensions need other names`);
  }
  const dup = names.filter((n, i) => n && names.indexOf(n) !== i);
  if (dup.length) problems.push(`dimension names repeat: ${[...new Set(dup)].join(", ")}`);
  if (probe.plane.samples > 1 && names.includes("c")) problems.push("each pixel has several samples, and they are the channels: no page dimension may be called c");
  if (answer.samples !== undefined && probe.plane.samples === 1) problems.push("samples: this file has one sample per pixel");
  if (answer.samples === "rgb" && probe.plane.samples < 3) problems.push("samples: RGB needs three or four samples per pixel");
  if (answer.samples !== undefined && answer.samples !== "c" && answer.samples !== "rgb" && probe.plane.samples > 1) problems.push('samples must be "c" or "rgb"');
  if (plan) {
    const series = probe.series.filter((s) => s.first < plan.first + plan.count && s.first + s.count > plan.first);
    if (series.length > 1) problems.push(`the chosen pages mix ${series.length} different plane shapes or types (${series.map((s) => `${s.width} x ${s.height} ${s.sampleType}`).join("; ")}); choose the pages of one (pages: {first, count})`);
  }
  for (const k of ["transpose", "flipX", "flipY", "lossless"] as const) if (answer[k] !== undefined && typeof answer[k] !== "boolean") problems.push(`${k} must be true or false`);
  if (answer.pixelSize) {
    const p = answer.pixelSize;
    if (!finitePos(p.x) || (p.y !== undefined && !finitePos(p.y))) problems.push("pixel size must be a finite number above 0");
    if (typeof p.unit !== "string" || !p.unit.trim()) problems.push("pixel size needs a unit (µm, nm, mm)");
  }
  const sizeOf = (d: string): number | null => plan?.dims.find((x) => x.name === d)?.size ?? null;
  const checkAxis = (label: string, dim: string, a: { coords?: number[]; key?: string } & Record<string, unknown>, scaleKeys: string[]): void => {
    if (!names.includes(dim)) { problems.push(`${label}: there is no ${dim} dimension`); return; }
    for (const k of scaleKeys) if (a[k] !== undefined && !finitePos(a[k])) problems.push(`${label}: ${k} must be a finite number above 0`);
    for (const k of ["t0", "origin", "offset"]) if (a[k] !== undefined && !finite(a[k])) problems.push(`${label}: ${k} must be a finite number`);
    if (a.coords !== undefined) {
      if (!Array.isArray(a.coords) || !a.coords.every(finite)) problems.push(`${label}: coords must be finite numbers`);
      else if (sizeOf(dim) !== null && a.coords.length !== sizeOf(dim)) problems.push(`${label}: ${a.coords.length} positions for ${sizeOf(dim)} ${dim} indices`);
    } else if (a.key !== undefined && !probe.keys?.keys.some((k) => k.key === a.key && k.values)) problems.push(`${label}: the pages have no numeric key "${a.key}" to read positions from`);
  };
  if (answer.time) {
    checkAxis("time", "t", answer.time as never, ["interval", "rate"]);
    if (answer.time.interval !== undefined && answer.time.rate !== undefined) problems.push("time: give an interval or a rate, not both");
  }
  if (answer.z) checkAxis("z", "z", answer.z as never, ["step"]);
  for (const [d, a] of Object.entries(answer.axes ?? {})) {
    checkAxis(`axes.${d}`, d, a as never, ["scale"]);
    if (a.labels !== undefined && (!Array.isArray(a.labels) || (sizeOf(d) !== null && a.labels.length !== sizeOf(d)))) problems.push(`axes.${d}: one label per index`);
  }
  if (answer.channels !== undefined) {
    const C = names.includes("c") ? sizeOf("c") : plan?.samples ? plan.sampleChannels : 1;
    if (!Array.isArray(answer.channels)) problems.push("channels must be a list");
    else {
      if (C !== null && answer.channels.length > C) problems.push(`${answer.channels.length} channels given; the image has ${C}`);
      const cn = answer.channels.map((c) => c?.name).filter((n): n is string => typeof n === "string");
      if (new Set(cn).size !== cn.length) problems.push("channel names repeat");
      for (const c of answer.channels) if (c?.color != null && !COLOR_RE.test(c.color)) problems.push(`channel colour ${JSON.stringify(c.color)} is not #rrggbb`);
    }
  }
  if (answer.nodata !== undefined && answer.nodata !== null) {
    const dt = probe.plane.dtype;
    if (!finite(answer.nodata)) problems.push("nodata must be a finite number (NaN already means no data in float images)");
    else if (dt && INT_RANGE[dt] && !(Number.isInteger(answer.nodata) && answer.nodata >= INT_RANGE[dt][0] && answer.nodata <= INT_RANGE[dt][1])) problems.push(`nodata ${answer.nodata} cannot occur in ${dt} data`);
  }
  if (answer.world) {
    const m = answer.world.matrix;
    if (!Array.isArray(m) || !(m.length === 3 || m.length === 4) || !m.every((r) => Array.isArray(r) && r.length === m.length && r.every(finite))) problems.push("world.matrix must be 3 x 3 or 4 x 4 finite numbers");
  }
  return problems;
}

/** The reason an answer is not acceptable, in one sentence, or null when it is. */
export function validateAnswer(probe: TiffProbe, answer: DimsAnswer): string | null {
  const p = answerProblems(probe, answer);
  return p.length ? p.join("; ") : null;
}

/** The values of page key `key` at the first page of each index along `dim` (other dims at 0). */
export function keyCoords(probe: TiffProbe, plan: AnswerPlan, dim: string, key: string): number[] | null {
  const k = probe.keys?.keys.find((x) => x.key === key);
  const d = plan.dims.find((x) => x.name === dim);
  if (!k?.values || !d) return null;
  const out: number[] = [];
  for (let i = 0; i < d.size; i++) {
    const v = k.values[plan.first + i * d.stride];
    if (!Number.isFinite(v)) return null;
    out.push(v);
  }
  return out;
}

/** In words: "t 816 × c 2 (c fastest), transposed, 0.25 µm pixels, 80 Hz". */
export function describeAnswer(probe: TiffProbe, answer: DimsAnswer): string {
  const { plan } = planAnswer(probe, answer);
  const parts: string[] = [];
  const dims = plan ? plan.dims.map((d) => `${d.name || "?"} ${d.size}`) : answer.dims.map((d) => `${d.name || "?"} ${d.size}`);
  if (dims.length) parts.push(dims.join(" × ") + (dims.length > 1 ? ` (${answer.dims[answer.dims.length - 1].name || "?"} fastest)` : ""));
  else parts.push("a single plane");
  if (plan?.samples === "rgb") parts.push("RGB");
  else if (plan?.samples === "c") parts.push(`${plan.sampleChannels} channels from the samples`);
  if (answer.pages && (answer.pages.first > 0 || answer.pages.count < probe.pages)) parts.push(`pages ${answer.pages.first + 1}-${answer.pages.first + answer.pages.count}`);
  if (answer.transpose) parts.push("transposed");
  if (answer.flipX) parts.push("flipped left-right");
  if (answer.flipY) parts.push("flipped top-bottom");
  if (answer.pixelSize) parts.push(`${fmt(answer.pixelSize.x)} ${answer.pixelSize.unit} pixels`);
  const t = answer.time;
  if (t?.rate) parts.push(`${fmt(t.rate)} Hz`);
  else if (t?.interval) parts.push(`${fmt(t.interval)} ${t.unit ?? "s"} per frame`);
  else if (t?.coords || t?.key) parts.push(`frame times${t.key ? ` from ${t.key}` : ""}`);
  const z = answer.z;
  if (z?.step) parts.push(`z step ${fmt(z.step)}${z.unit ? ` ${z.unit}` : ""}`);
  else if (z?.coords || z?.key) parts.push(`z positions${z.key ? ` from ${z.key}` : ""}`);
  if (answer.nodata !== undefined && answer.nodata !== null) parts.push(`${answer.nodata} = no data`);
  if (answer.lossless) parts.push("lossless");
  return parts.join(", ");
}

/** A default name for an unnamed dimension (time for long runs, depth otherwise, never one already used). */
function defaultName(size: number, used: Set<string>): string {
  const pref = size > 200 ? ["t", "z"] : ["z", "t"];
  for (const n of [...pref, "n", "q"]) if (!used.has(n)) return n;
  let i = 1;
  while (used.has(`d${i}`)) i++;
  return `d${i}`;
}

function proposalFrom(probe: TiffProbe, from: string, confidence: Confidence, base: Partial<DimsAnswer> & { dims: DimSpec[] }, reasons: string[], extra: { problems?: string[] } = {}): DimsProposal {
  const answer: DimsAnswer = JSON.parse(JSON.stringify(base));
  const missing: string[] = [];
  const used = new Set(answer.dims.map((d) => d.name).filter(Boolean));
  let unnamed = false;
  for (const d of answer.dims) {
    if (d.name) continue;
    unnamed = true;
    d.name = defaultName(typeof d.size === "number" ? d.size : probe.pages, used);
    used.add(d.name);
    missing.push(`the name of the dimension of size ${d.size} (proposed: ${d.name})`);
  }
  // Physical fields the other hints know.
  const res = probe.hints.find((h) => h.source === "resolution");
  if (!answer.pixelSize && res?.pixelSize) { answer.pixelSize = { x: res.pixelSize.x, unit: res.pixelSize.unit, ...(res.pixelSize.y !== res.pixelSize.x ? { y: res.pixelSize.y } : {}) }; reasons = [...reasons, ...res.reasons]; }
  const samples = probe.hints.find((h) => h.source === "samples");
  if (probe.plane.samples > 1 && !answer.samples && samples?.samples) answer.samples = samples.samples;
  if (!answer.pixelSize) missing.push("pixel size");
  const names = answer.dims.map((d) => d.name);
  if (names.includes("t") && !answer.time) missing.push("frame interval or rate");
  if (names.includes("z") && !answer.z) missing.push("z step");
  const problems = [...(extra.problems ?? []), ...answerProblems(probe, answer)];
  const ready = confidence === "high" && !unnamed && !problems.length;
  return { answer, confidence: problems.length && confidence === "high" ? "medium" : confidence, from, summary: describeAnswer(probe, answer), reasons: problems.length ? [...reasons, ...problems.map((p) => `does not fit: ${p}`)] : reasons, missing, ready };
}

function fromHint(probe: TiffProbe, h: Hint): DimsProposal {
  const base: Partial<DimsAnswer> & { dims: DimSpec[] } = { dims: (h.dims ?? []).map((d) => ({ ...d })) };
  if (h.pages && (h.pages.first > 0 || h.pages.count !== probe.pages)) base.pages = { ...h.pages };
  if (h.samples) base.samples = h.samples;
  if (h.pixelSize) base.pixelSize = { x: h.pixelSize.x, unit: h.pixelSize.unit, ...(h.pixelSize.y !== h.pixelSize.x ? { y: h.pixelSize.y } : {}) };
  if (h.time) base.time = { ...h.time };
  if (h.z) base.z = { ...h.z };
  if (h.channels?.length) base.channels = h.channels.map((c) => ({ ...(c.name ? { name: c.name } : {}), ...(c.color ? { color: c.color } : {}) }));
  if (h.world) base.world = { matrix: h.world.matrix.map((r) => r.slice()), ...(h.world.unit !== undefined ? { unit: h.world.unit } : {}), ...(h.world.note ? { note: h.world.note } : {}) };
  return proposalFrom(probe, h.source, h.problems?.length ? (h.confidence === "high" ? "medium" : h.confidence) : h.confidence, base, h.reasons, { problems: h.problems });
}

export interface InferOptions {
  /** Remembered rules; one whose fingerprint matches and that fits this file is proposed first, ready. */
  rules?: AnswerRule[];
}

/** Ranked proposals, best first. Never empty for a file without refusals. */
export function inferDims(probe: TiffProbe, opts: InferOptions = {}): DimsProposal[] {
  const out: DimsProposal[] = [];
  for (const rule of opts.rules ?? []) {
    const applied = applyRule(rule, probe);
    if (applied.answer && !applied.problems.length) {
      out.push({ answer: applied.answer, confidence: "high", from: "remembered", summary: describeAnswer(probe, applied.answer), reasons: ["remembered for files like this one"], missing: [], ready: true });
      break;
    }
  }
  const dimHints = probe.hints.filter((h) => h.dims !== undefined && ["ome", "imagej", "pagejson", "shaped", "periodicity"].includes(h.source));
  for (const h of dimHints) out.push(fromHint(probe, h));
  // Per-page JSON or OME that says nothing about dims still has physical facts worth carrying into the guesses.
  const facts = probe.hints.find((h) => h.dims === undefined && (h.source === "pagejson" || h.source === "ome"));
  const series = probe.series;
  if (probe.pages === 1 || (series.length > 1 && series.every((s) => s.count === 1) && !dimHints.length)) {
    const base: Partial<DimsAnswer> & { dims: DimSpec[] } = { dims: [] };
    if (probe.pages > 1) base.pages = { first: 0, count: 1 };
    if (facts?.pixelSize) base.pixelSize = { x: facts.pixelSize.x, unit: facts.pixelSize.unit };
    if (facts?.world) base.world = { matrix: facts.world.matrix, ...(facts.world.note ? { note: facts.world.note } : {}) };
    out.push(proposalFrom(probe, "single", "high", base, [probe.pages === 1 ? "one page: a single plane" : "pages of different shapes: the first one is the image"]));
  } else if (!out.some((p) => p.confidence !== "low")) {
    // Nothing says how the pages are ordered: guesses, ranked low, so a person (or an agent) chooses.
    const s = series.length > 1 ? [...series].sort((a, b) => b.count - a.count)[0] : { first: 0, count: probe.pages };
    const pages = series.length > 1 ? { first: s.first, count: s.count } : undefined;
    const why = [`no metadata says how the ${s.count} pages are ordered`, ...(series.length > 1 ? [`the file mixes ${series.length} plane shapes; these are pages ${s.first + 1}-${s.first + s.count}`] : [])];
    const name = s.count > 200 ? "t" : "z";
    const withFacts = (b: Partial<DimsAnswer> & { dims: DimSpec[] }): Partial<DimsAnswer> & { dims: DimSpec[] } => ({ ...b, ...(pages ? { pages } : {}), ...(facts?.pixelSize ? { pixelSize: { x: facts.pixelSize.x, unit: facts.pixelSize.unit } } : {}) });
    out.push(proposalFrom(probe, "guess", "low", withFacts({ dims: [{ name, size: "rest" }] }), [...why, `one dimension: ${name === "t" ? "time (many pages)" : "depth (few pages)"}`]));
    const other = name === "t" ? "z" : "t";
    out.push(proposalFrom(probe, "guess", "low", withFacts({ dims: [{ name: other, size: "rest" }] }), [...why, `one dimension: ${other === "t" ? "time" : "depth"}`]));
    if (s.count % 2 === 0 && !dimHints.some((h) => h.source === "periodicity")) out.push(proposalFrom(probe, "guess", "low", withFacts({ dims: [{ name: "t", size: "rest" }, { name: "c", size: 2 }] }), [...why, "two interleaved channels, channel fastest (common for two-colour acquisitions)"]));
  }
  out.sort((a, b) => RANK[a.confidence] - RANK[b.confidence] || (a.ready === b.ready ? 0 : a.ready ? -1 : 1) || (SOURCE_RANK[a.from] ?? 9) - (SOURCE_RANK[b.from] ?? 9));
  return out;
}

/** Whether the best proposal may be converted without asking. */
export const needsAsking = (proposals: DimsProposal[]): boolean => !proposals[0]?.ready;

/**
 * Turn an answer into a rule for "files like this one": the slowest dimension's size becomes "the rest" (so
 * "c = 2, t = pages / 2" fits other page counts), positions read from a page key are re-read per file, and the
 * page range is dropped.
 */
export function answerRule(answer: DimsAnswer, probe: TiffProbe): AnswerRule {
  const a: DimsAnswer = JSON.parse(JSON.stringify(answer));
  delete a.pages;
  if (a.dims.length && !a.dims.some((d) => d.size === "rest")) a.dims[0].size = "rest";
  if (a.time?.key) delete a.time.coords;
  if (a.z?.key) delete a.z.coords;
  for (const ax of Object.values(a.axes ?? {})) if (ax.key) delete ax.coords;
  return { rule: 1, fingerprint: probe.fingerprint, answer: a };
}

/** A rule applied to a file: the answer (positions re-read from page keys) and why it does not fit, if it does not. */
export function applyRule(rule: AnswerRule, probe: TiffProbe): { answer: DimsAnswer | null; problems: string[] } {
  if (!rule || rule.rule !== 1) return { answer: null, problems: ["not a remembered rule"] };
  if (rule.fingerprint !== probe.fingerprint) return { answer: null, problems: ["the rule was made for files of another structure"] };
  const a: DimsAnswer = JSON.parse(JSON.stringify(rule.answer));
  const { plan } = planAnswer(probe, a);
  if (plan) {
    if (a.time?.key) { const c = keyCoords(probe, plan, "t", a.time.key); if (c) a.time.coords = rebase(c, a.time.key); }
    if (a.z?.key) { const c = keyCoords(probe, plan, "z", a.z.key), f = unitFromKey(a.z.key)?.factor ?? 1; if (c) a.z.coords = c.map((v) => v * f); }
    for (const [d, ax] of Object.entries(a.axes ?? {})) if (ax.key) { const c = keyCoords(probe, plan, d, ax.key); if (c) ax.coords = c; }
    // A time key whose values are evenly spaced is an interval, as the inference reads it.
    if (a.time?.key && a.time.coords && a.time.interval !== undefined) delete a.time.coords;
  }
  return { answer: a, problems: answerProblems(probe, a) };
}

/** Frame times relative to the first frame, in seconds (keys may be absolute clocks; `_ms`-like keys are scaled). */
const rebase = (c: number[], key: string): number[] => { const u = unitFromKey(key), f = u?.unit === "s" ? u.factor : 1; return c.map((v) => (v - c[0]) * f); };
