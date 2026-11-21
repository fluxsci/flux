/**
 * Every edit the TIFF asking surface makes to an answer, as pure functions (answer in, new answer out; nothing is
 * mutated). The surface's keys and drags call these and nothing else, so the gate checks them without a window.
 *
 * `tidy` keeps an answer coherent after any edit: time settings go when there is no t, depth settings when there is
 * no z, channel settings beyond the channel count are dropped, and at most one dimension is "the rest".
 */
import { planAnswer } from "./infer";
import type { DimSpec, DimsAnswer, TiffProbe } from "./types";

const clone = (a: DimsAnswer): DimsAnswer => JSON.parse(JSON.stringify(a));
const NAME_RE = /^[a-z][a-z0-9_]*$/;
/** The names a page key cycles through (then a free name). */
export const CYCLE = ["t", "z", "c"] as const;
/** Channel colours a chip cycles through (null = gray), the writer's defaults first. */
export const CHANNEL_COLOURS: Array<string | null> = [null, "#00ff00", "#ff00ff", "#00ffff", "#ffff00", "#ff0000", "#4488ff"];
export const LENGTH_UNITS = ["µm", "nm", "mm"] as const;

/** How many channels the answer makes (its c, or the samples of a pixel, or one). */
export function channelCount(probe: TiffProbe, a: DimsAnswer): number {
  const { plan } = planAnswer(probe, a);
  const c = plan?.dims.find((d) => d.name === "c");
  if (c) return c.size;
  if (plan?.samples) return plan.sampleChannels;
  const cd = a.dims.find((d) => d.name === "c");
  return typeof cd?.size === "number" ? cd.size : 1;
}

/** The resolved size of each page dimension (a "rest" resolved when the others divide the page count). */
export function resolvedSizes(probe: TiffProbe, a: DimsAnswer): Array<number | null> {
  const count = a.pages?.count ?? probe.pages - (a.pages?.first ?? 0);
  const fixed = a.dims.reduce((p, d) => (d.size === "rest" ? p : p * (d.size as number)), 1);
  return a.dims.map((d) => (d.size === "rest" ? (fixed > 0 && count % fixed === 0 ? count / fixed : null) : (d.size as number)));
}

/** Coherence after an edit (see the header). */
export function tidy(probe: TiffProbe, a: DimsAnswer): DimsAnswer {
  const out = clone(a);
  const names = out.dims.map((d) => d.name);
  if (out.time && !names.includes("t")) delete out.time;
  if (out.z && !names.includes("z")) delete out.z;
  if (out.axes) for (const k of Object.keys(out.axes)) if (!names.includes(k)) delete out.axes[k];
  if (out.axes && !Object.keys(out.axes).length) delete out.axes;
  if (out.channels) {
    const n = channelCount(probe, out);
    out.channels = out.channels.slice(0, n);
    if (!out.channels.length || out.channels.every((c) => !c || (!c.name && c.color === undefined && c.lut === undefined && c.visible === undefined))) delete out.channels;
  }
  return out;
}

/** Move the page key at `from` to `to` (slowest first, fastest last). */
export function moveDim(probe: TiffProbe, a: DimsAnswer, from: number, to: number): DimsAnswer {
  const out = clone(a);
  if (from < 0 || from >= out.dims.length) return out;
  const [d] = out.dims.splice(from, 1);
  out.dims.splice(Math.max(0, Math.min(out.dims.length, to)), 0, d);
  return tidy(probe, out);
}

/** The next name for a page key: t → z → c → a free name ("" asks for one), skipping names the others use. */
export function nextName(a: DimsAnswer, i: number): string {
  const used = new Set(a.dims.filter((_, k) => k !== i).map((d) => d.name));
  const cur = a.dims[i]?.name ?? "";
  const at = (CYCLE as readonly string[]).indexOf(cur);
  for (let k = at + 1; k < CYCLE.length; k++) if (!used.has(CYCLE[k])) return CYCLE[k];
  if (at >= 0) return "";
  for (const n of CYCLE) if (!used.has(n)) return n;
  return "";
}

/** Why a name cannot be a page dimension's (null: it can). */
export function nameProblem(a: DimsAnswer, i: number, name: string): string | null {
  if (!NAME_RE.test(name)) return "lower-case letters, digits and _, starting with a letter";
  if (name === "x" || name === "y") return `${name} is the plane itself`;
  if (a.dims.some((d, k) => k !== i && d.name === name)) return `${name} is already a dimension`;
  return null;
}

export function renameDim(probe: TiffProbe, a: DimsAnswer, i: number, name: string): DimsAnswer {
  const out = clone(a);
  if (!out.dims[i]) return out;
  out.dims[i].name = name;
  return tidy(probe, out);
}

/** Set a page key's size; "rest" makes it the one computed from the page count (any other "rest" is fixed at its value). */
export function setDimSize(probe: TiffProbe, a: DimsAnswer, i: number, size: number | "rest"): DimsAnswer {
  const out = clone(a);
  if (!out.dims[i]) return out;
  if (size === "rest") {
    const now = resolvedSizes(probe, out);
    out.dims.forEach((d, k) => { if (k !== i && d.size === "rest") d.size = now[k] ?? 1; });
  }
  out.dims[i].size = size;
  return tidy(probe, out);
}

/** A new page key at the fast end: the first unused of t, z, c (else "n"), size 2; the slowest becomes the rest if none is. */
export function addDim(probe: TiffProbe, a: DimsAnswer): DimsAnswer {
  const out = clone(a);
  const used = new Set(out.dims.map((d) => d.name));
  const name = [...CYCLE, "n", "m", "q"].find((n) => !used.has(n)) ?? `d${out.dims.length + 1}`;
  out.dims.push({ name, size: out.dims.length ? 2 : "rest" } as DimSpec);
  if (!out.dims.some((d) => d.size === "rest")) out.dims[0].size = "rest";
  delete out.pages;
  return tidy(probe, out);
}

export function removeDim(probe: TiffProbe, a: DimsAnswer, i: number): DimsAnswer {
  const out = clone(a);
  const gone = out.dims.splice(i, 1)[0];
  if (gone?.size === "rest" && out.dims.length) out.dims[0].size = "rest";
  return tidy(probe, out);
}

/** Toggle transpose / flipX / flipY / lossless. */
export function toggle(a: DimsAnswer, key: "transpose" | "flipX" | "flipY" | "lossless"): DimsAnswer {
  const out = clone(a);
  if (out[key]) delete out[key]; else out[key] = true;
  return out;
}

export function setPixelSize(a: DimsAnswer, x: number | null, unit?: string): DimsAnswer {
  const out = clone(a);
  if (x === null) { delete out.pixelSize; return out; }
  out.pixelSize = { x, unit: unit ?? out.pixelSize?.unit ?? "µm" };
  return out;
}
export function setPixelUnit(a: DimsAnswer, unit: string): DimsAnswer {
  const out = clone(a);
  if (out.pixelSize) out.pixelSize = { ...out.pixelSize, unit };
  if (out.z && out.z.unit !== null) out.z = { ...out.z, unit };
  return out;
}

/** Time as a rate (Hz) or an interval (s); null clears it. Per-page times are replaced. */
export function setTime(a: DimsAnswer, kind: "rate" | "interval", value: number | null): DimsAnswer {
  const out = clone(a);
  const t0 = out.time?.t0;
  if (value === null) { delete out.time; return out; }
  out.time = kind === "rate" ? { rate: value, ...(t0 !== undefined ? { t0 } : {}) } : { interval: value, unit: "s", ...(t0 !== undefined ? { t0 } : {}) };
  return out;
}
export function setT0(a: DimsAnswer, t0: number | null): DimsAnswer {
  const out = clone(a);
  if (!out.time) out.time = {};
  if (t0 === null) delete out.time.t0; else out.time.t0 = t0;
  if (!Object.keys(out.time).length) delete out.time;
  return out;
}
export function setZStep(a: DimsAnswer, step: number | null): DimsAnswer {
  const out = clone(a);
  if (step === null) { delete out.z; return out; }
  out.z = { step, unit: out.pixelSize?.unit ?? "µm" };
  return out;
}

export function setChannel(probe: TiffProbe, a: DimsAnswer, i: number, patch: { name?: string | null; color?: string | null }): DimsAnswer {
  const out = clone(a);
  const n = channelCount(probe, out);
  const list = Array.from({ length: n }, (_, k) => ({ ...(out.channels?.[k] ?? {}) }));
  if (!list[i]) return out;
  if (patch.name !== undefined) { if (patch.name) list[i].name = patch.name; else delete list[i].name; }
  if (patch.color !== undefined) list[i].color = patch.color;
  out.channels = list;
  return tidy(probe, out);
}

/** The colour after `current` in the chip's cycle. */
export function nextColour(current: string | null | undefined): string | null {
  const at = CHANNEL_COLOURS.findIndex((c) => (c ?? null) === (current ?? null));
  return CHANNEL_COLOURS[(at + 1) % CHANNEL_COLOURS.length];
}

export function setNodata(a: DimsAnswer, value: number | null): DimsAnswer {
  const out = clone(a);
  if (value === null) delete out.nodata; else out.nodata = value;
  return out;
}

/** A number typed in place: "0.25", ".25", "1e-3", "80"; null for anything else (empty included). */
export function parseNumber(text: string): number | null {
  const t = text.trim().replace(",", ".").replace(/^−/, "-");
  if (!/^-?(\d+\.?\d*|\.\d+)(e-?\d+)?$/i.test(t)) return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
}

/** A round step to nudge `v` by (wheel, arrows): a tenth of its decade. */
export function nudgeStep(v: number): number {
  const a = Math.abs(v);
  return a > 0 ? Math.pow(10, Math.floor(Math.log10(a)) - 1) : 0.1;
}
