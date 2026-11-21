/**
 * TIFF in the headless verbs, kept beside (not inside) the bundle code: `place-image` and `image-info` hand a
 * `.tif` / `.tiff` path here first.
 *
 * place-image: probe, then an answer from `--answer` / the flags, or the best proposal when the metadata leaves no
 * doubt; otherwise REFUSE with the ranked proposals in words, each with the flags that choose it (never a silent
 * guess: a wrong page order gives a plausible, wrong image). The TIFF is converted into a hidden scratch folder in
 * `fig/assets` and that bundle goes through the ordinary placement (copy or clone, content id, dedupe, figure or
 * slide), after which the scratch is removed. The element records the TIFF as its source, frozen (a TIFF is not a
 * bundle the source watcher could follow), with the content id the dedupe of slide-only images relies on.
 */
import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { convertTiff, probeTiff } from "./tiffConvert";
import { ValidationError, NotFoundError } from "./errors";
import { answerProblems, describeAnswer } from "../src/lib/tiff/infer";
import type { DimSpec, DimsAnswer, DimsProposal, TiffProbe } from "../src/lib/tiff/types";

export const isTiffPath = (p: string): boolean => /\.tiff?$/i.test(p);

/** The CLI / MCP flags (all optional): `place-image fig data/movie.tif --dims t,c=2 --transpose --pixel-size 0.25 --rate 80`. */
export interface TiffFlags {
  dims?: string;
  transpose?: boolean;
  flipX?: boolean;
  flipY?: boolean;
  pixelSize?: number;
  unit?: string;
  dt?: number;
  rate?: number;
  zStep?: number;
  nodata?: number;
  lossless?: boolean;
  /** Channel names, comma-separated on the CLI. */
  channels?: string[] | string;
  answer?: unknown;
}

const flagsGiven = (f: TiffFlags | undefined): boolean => !!f && Object.values(f).some((v) => v !== undefined);

/** "t,c" / "t=816,c=2" / "t=rest,c=2" → dims, sizes from the proposal where a name matches and none was given. */
export function parseDims(text: string, proposal: DimsProposal | undefined): DimSpec[] {
  const parts = text.split(/[,×x\s]+/).map((s) => s.trim()).filter(Boolean);
  if (!parts.length) throw new ValidationError('--dims: give the dimensions over the pages, slowest first, e.g. "t,c=2" or "t=816,c=2"');
  const dims: Array<{ name: string; size: number | "rest" | null }> = parts.map((p) => {
    const m = /^([a-z][a-z0-9_]*)(?:=(\d+|rest|\*))?$/.exec(p);
    if (!m) throw new ValidationError(`--dims: "${p}" is not name or name=size (names: t, z, c or lower-case words; size a whole number or rest)`);
    return { name: m[1], size: m[2] === undefined ? null : m[2] === "rest" || m[2] === "*" ? "rest" : Number(m[2]) };
  });
  const known = new Map((proposal?.answer.dims ?? []).map((d) => [d.name, d.size]));
  for (const d of dims) if (d.size === null && known.has(d.name) && dims.filter((x) => x.size === null).length > 1) d.size = known.get(d.name)!;
  const open = dims.filter((d) => d.size === null);
  if (open.length === 1 && !dims.some((d) => d.size === "rest")) open[0].size = "rest";
  const still = dims.filter((d) => d.size === null);
  if (still.length) throw new ValidationError(`--dims: give a size for ${still.map((d) => d.name).join(", ")} (one dimension may be "rest"), e.g. --dims ${dims.map((d, i) => `${d.name}=${i === 0 ? "rest" : d.size ?? 2}`).join(",")}`);
  return dims as DimSpec[];
}

/** The flags that choose a proposal, for the refusal text. */
export function proposalFlags(a: DimsAnswer): string {
  const f: string[] = [];
  if (a.dims.length) f.push(`--dims ${a.dims.map((d) => `${d.name}=${d.size}`).join(",")}`);
  if (a.transpose) f.push("--transpose");
  if (a.pixelSize) f.push(`--pixel-size ${a.pixelSize.x}${a.pixelSize.unit !== "µm" ? ` --unit ${a.pixelSize.unit}` : ""}`);
  if (a.time?.interval) f.push(`--dt ${a.time.interval}`);
  if (a.z?.step) f.push(`--z-step ${a.z.step}`);
  return f.join(" ");
}

function planeWords(p: TiffProbe): string {
  return `${p.pages} page${p.pages === 1 ? "" : "s"} of ${p.plane.width} x ${p.plane.height} ${p.plane.sampleType}${p.plane.samples > 1 ? ` x ${p.plane.samples} samples` : ""}`;
}

/** The answer for a TIFF from the flags (or the best proposal when nothing is given and nothing is in doubt). */
export function answerFor(file: string, probe: TiffProbe, proposals: DimsProposal[], flags: TiffFlags | undefined): DimsAnswer {
  if (probe.refusals.length) throw new ValidationError(`${path.basename(file)} cannot be imported: ${probe.refusals.map((r) => r.message).join("; ")}`);
  const top = proposals[0];
  const f = flags ?? {};
  if (f.answer !== undefined) {
    let a: unknown = f.answer;
    if (typeof a === "string") { try { a = JSON.parse(a); } catch { throw new ValidationError('--answer must be JSON, e.g. {"dims": [{"name": "t", "size": "rest"}, {"name": "c", "size": 2}], "transpose": true}'); } }
    if (!a || typeof a !== "object" || !Array.isArray((a as DimsAnswer).dims)) throw new ValidationError('--answer needs at least "dims": [{"name", "size"}, ...] (slowest first; one size may be "rest")');
    return applyFlags(a as DimsAnswer, f, top);
  }
  // Without a page order from the caller, only metadata that leaves no doubt may decide it.
  if (f.dims) return applyFlags(top?.answer ?? { dims: [] }, f, top);
  if (top?.ready) return flagsGiven(flags) ? applyFlags(top.answer, f, top) : top.answer;
  throw new ValidationError(refusalText(file, probe, proposals));
}

function applyFlags(base: DimsAnswer, f: TiffFlags, top: DimsProposal | undefined): DimsAnswer {
  const a: DimsAnswer = JSON.parse(JSON.stringify(base));
  if (f.dims) {
    a.dims = parseDims(f.dims, top);
    // Positions read for another page order no longer apply.
    if (a.time && !a.dims.some((d) => d.name === "t")) delete a.time;
    if (a.z && !a.dims.some((d) => d.name === "z")) delete a.z;
    if (a.channels && !a.dims.some((d) => d.name === "c")) delete a.channels;
  }
  if (f.transpose !== undefined) a.transpose = f.transpose;
  if (f.flipX !== undefined) a.flipX = f.flipX;
  if (f.flipY !== undefined) a.flipY = f.flipY;
  if (f.pixelSize !== undefined) a.pixelSize = { x: f.pixelSize, unit: f.unit ?? a.pixelSize?.unit ?? "µm" };
  else if (f.unit !== undefined && a.pixelSize) a.pixelSize.unit = f.unit;
  if (f.dt !== undefined || f.rate !== undefined) a.time = { ...(f.dt !== undefined ? { interval: f.dt } : { rate: f.rate }), t0: 0, unit: "s" };
  if (f.zStep !== undefined) a.z = { step: f.zStep, unit: a.pixelSize?.unit ?? "µm" };
  if (f.nodata !== undefined) a.nodata = f.nodata;
  if (f.lossless !== undefined) a.lossless = f.lossless;
  if (f.channels !== undefined) {
    const names = Array.isArray(f.channels) ? f.channels : String(f.channels).split(",").map((s) => s.trim()).filter(Boolean);
    a.channels = names.map((name) => ({ name }));
  }
  return a;
}

/** Why a TIFF was not converted, with the proposals ranked and the flags that pick each. */
export function refusalText(file: string, probe: TiffProbe, proposals: DimsProposal[]): string {
  const lines = [`${path.basename(file)}: ${planeWords(probe)}; ${probe.description.kind === "none" ? "no metadata says how the pages are ordered" : "its metadata does not settle the page order"}. Nothing was converted: choose with --dims (slowest first; one size may be rest), plus --transpose, --pixel-size, --rate or --dt, --z-step as needed, or pass --answer '<json>'. Proposals, best first:`];
  proposals.slice(0, 5).forEach((p, i) => {
    lines.push(`  ${i + 1}. ${p.summary} [${p.confidence}${p.ready ? "" : ", needs a choice"}]: ${p.reasons.join("; ")}${p.missing.length ? `; unknown: ${p.missing.join(", ")}` : ""}`);
    lines.push(`     ${proposalFlags(p.answer) || "(no flags: a single plane)"}`);
  });
  return lines.join("\n");
}

/**
 * Convert a TIFF for placement: returns the scratch bundle (inside `fig/assets`, so a copy-on-write filesystem
 * clones it into the asset for free), the answer used, and a cleanup to call once the placement is done.
 */
export async function convertForPlacement(root: string, tiffArg: string, flags: TiffFlags | undefined): Promise<{ bundle: string; answer: DimsAnswer; summary: string; notes: string[]; sourcePath: string; external: boolean; cleanup: () => Promise<void> }> {
  const file = path.resolve(root, tiffArg);
  const st = await fsp.stat(file).catch(() => null);
  if (!st || !st.isFile()) throw new NotFoundError(`TIFF not found: ${tiffArg}`);
  const { probe, proposals } = await probeTiff(file);
  const answer = answerFor(file, probe, proposals, flags);
  const problems = answerProblems(probe, answer);
  if (problems.length) throw new ValidationError(`The answer does not fit ${path.basename(file)}:\n  ${problems.join("\n  ")}`);
  const realRoot = await fsp.realpath(path.resolve(root));
  const realFile = await fsp.realpath(file);
  const rel = path.relative(realRoot, realFile);
  const external = rel.startsWith("..") || path.isAbsolute(rel);
  const sourcePath = external ? realFile : rel.split(path.sep).join("/");
  const scratch = path.join(realRoot, "fig", "assets", `.tiff-${randomUUID()}`);
  await fsp.mkdir(scratch, { recursive: true });
  const cleanup = (): Promise<void> => fsp.rm(scratch, { recursive: true, force: true }).catch(() => {});
  try {
    const name = path.basename(file).replace(/\.(ome\.)?tiff?$/i, "");
    const out = path.join(scratch, `${name}.fluximg`);
    const r = await convertTiff(file, answer, out, { name, sourcePath });
    return { bundle: r.path, answer, summary: describeAnswer(probe, answer), notes: r.notes, sourcePath, external, cleanup };
  } catch (error) { await cleanup(); throw error; }
}

/** image-info on a TIFF path: the probe and the ranked proposals (nothing converted). */
export async function tiffInfo(root: string, target: string) {
  const file = path.resolve(root, target);
  const st = await fsp.stat(file).catch(() => null);
  if (!st || !st.isFile()) throw new NotFoundError(`TIFF not found: ${target}`);
  const { probe, proposals } = await probeTiff(file);
  // Per-page values are for the converter; the answer here stays readable.
  const keys = probe.keys ? { pages: probe.keys.pages, keys: probe.keys.keys.map(({ values, ...k }) => ({ ...k, ...(values ? { sampled: values.slice(0, 8) } : {}) })) } : null;
  return {
    tiff: target, bytes: st.size,
    summary: `${planeWords(probe)}, ${probe.plane.compression === "none" ? "uncompressed" : probe.plane.compression}, ${probe.container.bigTiff ? "BigTIFF" : "TIFF"}; metadata: ${probe.description.kind}`,
    convertible: !probe.refusals.length,
    ...(probe.refusals.length ? { refusals: probe.refusals.map((r) => r.message) } : {}),
    needsAnswer: !proposals[0]?.ready,
    proposals: proposals.map((p) => ({ summary: p.summary, confidence: p.confidence, ready: p.ready, from: p.from, reasons: p.reasons, missing: p.missing, flags: proposalFlags(p.answer), answer: p.answer })),
    probe: { ...probe, keys },
  };
}
