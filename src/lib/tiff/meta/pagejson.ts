/**
 * Per-page JSON descriptions (acquisition software that writes one JSON object per page). Pure.
 *
 * THE RULE. Every page's object is parsed; for each scalar key:
 *   - the same on every page: metadata (a pixel size, a transform, counts);
 *   - integers cycling through k values with a fixed period (1, 2, 1, 2, ...): an INDEX: a dimension of size k
 *     whose pages are `run` apart;
 *   - numbers constant over runs and changing at every run boundary (21 depths, two pages each): a COORDINATE of
 *     the dimension at that level;
 *   - anything else: varying (kept, for coords on request).
 * Levels nest from the fastest out; a level no key names is a dimension the person names. Names come from the key
 * names, by generic patterns only (channel, z / slice / plane / depth, time / timestamp / frame). A constant
 * `pixel size`-like key gives the scale (its unit from a suffix such as `_um`); a constant 3 x 3 or 4 x 4 numeric
 * matrix is offered as the world matrix.
 */
import type { DimSpec, Hint, PageKey } from "../types";
import { fmt } from "./imagej";

const CHANNEL_RE = /^(frame|image)?_?chan(nel)?_?(idx|index|no|num|number)?$/i;
const Z_RE = /(?<!h)z(_?(idx|index|pos|position|um|µm))?$|slice|plane|depth/i;
const T_RE = /^(t(_?(idx|index))?|time.*|.*timestamp.*|elapsed.*|frame_?(number|num|no|idx|index)?|.*_time(_?(s|ms|us|sec))?)$/i;
const PIXEL_RE = /pixel_?size|pixelsize|pixel_?pitch|um_?per_?pix|microns_?per_?pixel/i;
const MAX_VALUES = 200_000;

export const dimNameFor = (key: string): "c" | "z" | "t" | "" =>
  CHANNEL_RE.test(key) ? "c" : T_RE.test(key) ? "t" : Z_RE.test(key) ? "z" : "";

/** The unit a key's suffix states (`pixelSize_um` → µm), or null. */
export function unitFromKey(key: string): { unit: string; factor: number } | null {
  const k = key.replace(/[\s-]/g, "_");
  if (/(_|[a-z])(um|µm|microns?)$/i.test(k) || /_um_|um_?per/i.test(k)) return { unit: "µm", factor: 1 };
  if (/(_|[a-z])nm$/i.test(k)) return { unit: "nm", factor: 1 };
  if (/_mm$/i.test(k)) return { unit: "mm", factor: 1 };
  if (/(_|[a-z])ms$/i.test(k) || /_?msec$/i.test(k)) return { unit: "s", factor: 1e-3 };
  if (/(_|[a-z])us$/i.test(k)) return { unit: "s", factor: 1e-6 };
  if (/(_s|_sec|seconds?)$/i.test(k)) return { unit: "s", factor: 1 };
  return null;
}

/** The JSON object of each page (a description or private per-page text that parses as a plain object, not shaped JSON). */
export function pageObjects(pages: ReadonlyArray<{ descriptions: string[]; privateText?: string }>): Array<Record<string, unknown> | null> {
  return pages.map((p) => {
    for (const d of [...p.descriptions, ...(p.privateText ? [p.privateText] : [])]) {
      const t = d.trim();
      if (!t.startsWith("{") || !t.endsWith("}")) continue;
      try {
        const j = JSON.parse(t);
        if (j && typeof j === "object" && !Array.isArray(j) && !Array.isArray((j as { shape?: unknown }).shape)) return j as Record<string, unknown>;
      } catch { /* not JSON */ }
    }
    return null;
  });
}

function isMatrix(v: unknown): v is number[][] {
  return Array.isArray(v) && (v.length === 3 || v.length === 4) && v.every((r) => Array.isArray(r) && r.length === v.length && r.every((x) => typeof x === "number" && Number.isFinite(x)));
}

function analyse(key: string, vals: unknown[]): PageKey {
  const n = vals.length;
  const first = vals[0];
  const typeOf = (v: unknown): PageKey["type"] =>
    typeof v === "number" ? (Number.isInteger(v) ? "int" : "float") : typeof v === "string" ? "string" : typeof v === "boolean" ? "bool" : isMatrix(v) ? "matrix" : "list";
  let type = typeOf(first);
  for (const v of vals) { const t = typeOf(v); if (t !== type) { if ((t === "int" || t === "float") && (type === "int" || type === "float")) type = "float"; else { type = "mixed"; break; } } }
  const same = (a: unknown, b: unknown): boolean => a === b || (typeof a === "object" && JSON.stringify(a) === JSON.stringify(b));
  if (vals.every((v) => same(v, first))) {
    const pk: PageKey = { key, type, kind: "constant", distinct: 1 };
    if (typeof first === "number" || typeof first === "string" || typeof first === "boolean") pk.value = first;
    return pk;
  }
  if (type !== "int" && type !== "float") {
    return { key, type, kind: "varying", distinct: new Set(vals.map((v) => JSON.stringify(v))).size };
  }
  const v = vals as number[];
  const distinct = new Set(v).size;
  const base: PageKey = { key, type, kind: "varying", distinct, ...(n <= MAX_VALUES ? { values: v.slice() } : {}) };
  // Runs of equal values, all the same length?
  let run = 1;
  while (run < n && v[run] === v[0]) run++;
  if (n % run !== 0) return base;
  const m = n / run;
  for (let i = 0; i < m; i++) {
    for (let j = 1; j < run; j++) if (v[i * run + j] !== v[i * run]) return base;
    if (i > 0 && v[i * run] === v[(i - 1) * run]) return base;
  }
  // The run values: periodic?
  let period = m;
  for (let p = 1; p < m; p++) {
    if (m % p !== 0) continue;
    let ok = true;
    for (let i = p; i < m && ok; i++) if (v[i * run] !== v[(i % p) * run]) ok = false;
    if (ok) { period = p; break; }
  }
  const cycle = Array.from({ length: period }, (_, i) => v[i * run]);
  if (new Set(cycle).size !== period) return base;          // a value repeats inside one cycle: not a clean level
  if (type === "int" && cycle.every((x, i) => i === 0 || x - cycle[i - 1] === 1)) return { ...base, kind: "index", run, period };
  return { ...base, kind: "coordinate", run, period };
}

interface Level { run: number; period: number; keys: PageKey[] }

/** Analyse every page's JSON. `objs` are per page (null where a page has none). */
export function pageJsonHint(objs: Array<Record<string, unknown> | null>, pageCount: number): { hint: Hint | null; keys: { pages: number; keys: PageKey[] } | null } {
  const described = objs.findIndex((o) => !o) < 0 ? objs.length : objs.findIndex((o) => !o);
  if (described === 0) return { hint: null, keys: null };
  const used = objs.slice(0, described) as Array<Record<string, unknown>>;
  const names = Object.keys(used[0]).filter((k) => used.every((o) => k in o));
  const keys = names.map((k) => analyse(k, used.map((o) => o[k])));
  const reasons: string[] = [];
  const all = described === pageCount;
  reasons.push(all ? `every page carries a JSON description (${names.length} keys)` : described === 1 ? "the first page carries a JSON description" : `the first ${described} of ${pageCount} pages carry a JSON description`);
  const hint: Hint = { source: "pagejson", confidence: "medium", reasons };

  // Metadata from constants.
  const meta: Record<string, string | number | boolean> = {};
  for (const k of keys) {
    if (k.kind !== "constant") continue;
    if (k.value !== undefined && Object.keys(meta).length < 64 && !(typeof k.value === "string" && (k.value.length > 120 || /[\\/]/.test(k.value)))) meta[k.key] = k.value;
    if (k.type === "matrix" && !hint.world) {
      const m = used[0][k.key] as number[][];
      hint.world = { matrix: m.map((r) => r.slice()), note: `from the page key ${k.key}` };
      reasons.push(`a ${m.length} x ${m.length} matrix (${k.key}) offered as the world matrix`);
    }
    if (PIXEL_RE.test(k.key) && typeof k.value === "number" && k.value > 0 && !hint.pixelSize) {
      const u = unitFromKey(k.key);
      hint.pixelSize = { x: k.value, y: k.value, unit: u?.unit ?? "µm" };
      reasons.push(`pixel size ${fmt(k.value)} ${u?.unit ?? "µm"} from ${k.key}${u ? "" : " (unit assumed: µm)"}`);
    }
  }
  if (Object.keys(meta).length) hint.meta = meta;
  if (!all || pageCount === 1) {
    if (!all && described > 1) hint.problems = [`only ${described} of ${pageCount} pages were described; the dimensions cannot be read from them`];
    return { hint: hint.pixelSize || hint.world || hint.meta ? hint : null, keys: { pages: described, keys } };
  }

  // Levels: index and coordinate keys that are cycles at a level (period < runs) or span all pages.
  const N = pageCount;
  const levels: Level[] = [];
  for (const k of keys) {
    if ((k.kind !== "index" && k.kind !== "coordinate") || !k.run || !k.period) continue;
    const lv = levels.find((l) => l.run === k.run && l.period === k.period);
    if (lv) lv.keys.push(k); else levels.push({ run: k.run, period: k.period, keys: [k] });
  }
  levels.sort((a, b) => a.run - b.run || a.period - b.period);
  const placed: Array<{ size: number; stride: number; keys: PageKey[] }> = [];
  const spanning: PageKey[] = [];
  let cur = 1;
  for (const lv of levels) {
    if (lv.run === cur && cur * lv.period <= N && N % (cur * lv.period) === 0) { placed.push({ size: lv.period, stride: cur, keys: lv.keys }); cur *= lv.period; continue; }
    if (lv.run > cur && lv.run % cur === 0 && N % (lv.run * lv.period) === 0) {
      placed.push({ size: lv.run / cur, stride: cur, keys: [] });
      placed.push({ size: lv.period, stride: lv.run, keys: lv.keys });
      cur = lv.run * lv.period;
      continue;
    }
    spanning.push(...lv.keys);                          // varies inside a placed level (a per-page timestamp)
  }
  if (cur < N) placed.push({ size: N / cur, stride: cur, keys: [] });
  if (!placed.length) return { hint: hint.pixelSize || hint.world || hint.meta ? hint : null, keys: { pages: N, keys } };

  // Name the levels.
  const dimsFast: DimSpec[] = [];
  const nameOf = (keysAt: PageKey[]): { name: string; via: PageKey | null } => {
    for (const kind of ["index", "coordinate"] as const) for (const k of keysAt) if (k.kind === kind && dimNameFor(k.key)) return { name: dimNameFor(k.key), via: k };
    return { name: "", via: null };
  };
  const used3 = new Set<string>();
  const named = placed.map((p) => { const n = nameOf(p.keys); if (n.name && used3.has(n.name)) return { ...n, name: "" }; if (n.name) used3.add(n.name); return n; });
  // The outermost level with no key of its own is time when a spanning key says so.
  const timeKey = spanning.find((k) => dimNameFor(k.key) === "t") ?? keys.find((k) => k.kind === "varying" && k.values && dimNameFor(k.key) === "t") ?? null;
  const outer = placed.length - 1;
  if (!named[outer].name && timeKey && !used3.has("t")) { named[outer] = { name: "t", via: timeKey }; used3.add("t"); }
  placed.forEach((p, i) => dimsFast.push({ name: named[i].name, size: p.size }));
  hint.dims = dimsFast.slice().reverse();
  for (let i = placed.length - 1; i >= 0; i--) {
    const p = placed[i], nm = named[i];
    const ks = p.keys.map((k) => `${k.key} (${k.kind}, every ${p.stride} page${p.stride > 1 ? "s" : ""}${k.kind === "index" ? `, ${p.size} values` : ""})`);
    reasons.push(`${nm.name || "an unnamed dimension"} ${p.size}${ks.length ? ` from ${ks.join(", ")}` : nm.via ? ` (times from ${nm.via.key})` : " (the pages left over)"}`);
  }

  // Coordinates: a float key on a named level, or the time key, sampled at the first page of each index.
  const sample = (k: PageKey, stride: number, size: number): number[] | null => k.values ? Array.from({ length: size }, (_, i) => k.values![i * stride]) : null;
  placed.forEach((p, i) => {
    const name = named[i].name;
    if (name === "z") {
      const k = p.keys.find((x) => x.kind === "coordinate" && x.type === "float") ?? p.keys.find((x) => x.kind === "coordinate");
      const coords = k ? sample(k, p.stride, p.size) : null;
      if (k && coords) {
        const u = unitFromKey(k.key);
        hint.z = { coords: coords.map((c) => c * (u?.factor ?? 1)), key: k.key, unit: u?.unit ?? null };
        reasons.push(`z positions from ${k.key}${u ? ` (${u.unit})` : " (unit not stated)"}`);
      }
    }
    if (name === "t") {
      const k = (named[i].via && named[i].via!.type === "float" ? named[i].via : null) ?? p.keys.find((x) => x.type === "float" && dimNameFor(x.key) === "t") ?? (timeKey?.type === "float" || timeKey?.kind === "varying" ? timeKey : null);
      const raw = k ? sample(k, p.stride, p.size) : null;
      if (k && raw && raw.every((x) => Number.isFinite(x))) {
        const u = unitFromKey(k.key);
        const f = u?.unit === "s" ? u.factor : 1;
        const rel = raw.map((x) => (x - raw[0]) * f);
        const steps = rel.slice(1).map((x, j) => x - rel[j]).sort((a, b) => a - b);
        const med = steps.length ? steps[steps.length >> 1] : 0;
        const even = med > 0 && steps.every((s) => Math.abs(s - med) <= 0.01 * med);
        hint.time = even ? { interval: med, t0: 0, key: k.key, unit: "s" } : { coords: rel, key: k.key, unit: "s" };
        if (med > 0) reasons.push(`frame ${even ? "interval" : "times"} from ${k.key}${even ? `: ${fmt(med)} s` : ` (median step ${fmt(med)} s, uneven)`}${u?.unit === "s" ? "" : " (seconds assumed)"}`);
        if (Number.isFinite(raw[0])) (hint.meta ??= {})[`${k.key} at the first frame`] = raw[0];
      }
    }
  });
  const allNamed = hint.dims.every((d) => d.name);
  const hasIndex = placed.some((p) => p.keys.some((k) => k.kind === "index"));
  hint.confidence = allNamed && hasIndex ? "high" : "medium";
  if (!allNamed) reasons.push("a dimension's name is not in the file: name it");
  return { hint, keys: { pages: N, keys } };
}
