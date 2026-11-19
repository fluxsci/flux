/**
 * Projections over a run of planes (max / mean / min / sum / std) on VALUES, ignoring "no data" (pure).
 *
 * `projectPlanes` is the definition: per pixel, the statistic over the planes where that pixel has data, NaN
 * where it never has. `std` is the population standard deviation. Accumulation is float64 (Welford's update for
 * std, so a large offset with a small spread does not cancel); the result is a Float32Array of values with
 * `map === null` semantics, ready for `renderView`.
 *
 * Long stacks (a movie of a thousand frames, re-projected as its range is dragged) use block summaries:
 * `buildBlocks` reads every plane once and keeps, per block of `blockSize` planes and per pixel, the max, min,
 * mean, M2 (sum of squared deviations from the block mean) and count. `projectRange` then combines the whole
 * blocks inside [from, to) (Chan et al.'s pairwise update for mean / M2) and reads only the planes at the two
 * ends. max / min agree with `projectPlanes` exactly (float32 rounding is monotonic); mean / sum / std agree
 * within 1e-5 relative. Blocks keep mean (float64) + M2 (float32) instead of sum + sum of squares: the latter
 * loses the variance to cancellation when the mean is large next to the spread. 22 bytes per pixel per block.
 */
import type { FluximgProjectionMode } from "./view";
import { decoderOf, type RenderPlane } from "./render";

const MODES: readonly FluximgProjectionMode[] = ["max", "mean", "min", "sum", "std"];

/** Feed one plane's valid values into running per-pixel state. */
function feed(p: RenderPlane, length: number, mode: FluximgProjectionMode, n: Float64Array, a: Float64Array, b: Float64Array): void {
  const d = p.data, dec = decoderOf(p.map);
  const { mul, add, sub, ident } = dec;
  const nd = dec.nodata === null ? NaN : dec.nodata;
  if (d.length < length) throw new Error(`fluximg project: a plane has ${d.length} samples, expected ${length}`);
  for (let i = 0; i < length; i++) {
    const s = d[i];
    if (s === nd || s !== s) continue;
    const v = ident ? s : add + mul * (s - sub);
    const k = n[i] + 1;
    n[i] = k;
    if (mode === "max") { if (k === 1 || v > a[i]) a[i] = v; }
    else if (mode === "min") { if (k === 1 || v < a[i]) a[i] = v; }
    else if (mode === "std") { const dm = v - a[i]; a[i] += dm / k; b[i] += dm * (v - a[i]); }
    else a[i] += v; // mean, sum
  }
}

function finish(mode: FluximgProjectionMode, n: Float64Array, a: Float64Array, b: Float64Array): Float32Array {
  const out = new Float32Array(n.length);
  for (let i = 0; i < n.length; i++) {
    const k = n[i];
    if (k === 0) { out[i] = NaN; continue; }
    out[i] = mode === "mean" ? a[i] / k : mode === "std" ? Math.sqrt(Math.max(0, b[i] / k)) : a[i];
  }
  return out;
}

export function projectPlanes(planes: Iterable<RenderPlane>, length: number, mode: FluximgProjectionMode): Float32Array {
  if (!MODES.includes(mode)) throw new Error(`fluximg project: unknown mode ${mode}`);
  const n = new Float64Array(length), a = new Float64Array(length), b = new Float64Array(mode === "std" ? length : 0);
  for (const p of planes) feed(p, length, mode, n, a, b);
  return finish(mode, n, a, b);
}

// ---------------------------------------------------------------------------------------------
// Block summaries
// ---------------------------------------------------------------------------------------------

export interface ProjectionBlock {
  /** Plane indices [from, to). */
  from: number;
  to: number;
  max: Float32Array;
  min: Float32Array;
  /** float64: a float32 mean would put its rounding (~1e-7 of the mean) into a small spread's std. */
  mean: Float64Array;
  /** Sum of squared deviations from the block mean. */
  m2: Float32Array;
  /** Planes with data, per pixel. */
  count: Uint16Array;
}

export interface ProjectionBlocks { n: number; length: number; blockSize: number; blocks: ProjectionBlock[] }

export type GetPlane = (i: number) => RenderPlane | Promise<RenderPlane>;

/** Read every plane once and summarize each run of `blockSize` planes (the last block may be shorter). */
export async function buildBlocks(getPlane: GetPlane, n: number, length: number, blockSize = 16): Promise<ProjectionBlocks> {
  const bs = Math.max(1, Math.min(65535, Math.floor(blockSize)));
  const cnt = new Float64Array(length), mx = new Float64Array(length), mn = new Float64Array(length), mean = new Float64Array(length), m2 = new Float64Array(length);
  const blocks: ProjectionBlock[] = [];
  for (let from = 0; from < n; from += bs) {
    const to = Math.min(n, from + bs);
    cnt.fill(0); mean.fill(0); m2.fill(0);
    for (let i = from; i < to; i++) {
      const p = await getPlane(i);
      const d = p.data, dec = decoderOf(p.map);
      const { mul, add, sub, ident } = dec;
      const nd = dec.nodata === null ? NaN : dec.nodata;
      if (d.length < length) throw new Error(`fluximg project: plane ${i} has ${d.length} samples, expected ${length}`);
      for (let j = 0; j < length; j++) {
        const s = d[j];
        if (s === nd || s !== s) continue;
        const v = ident ? s : add + mul * (s - sub);
        const k = cnt[j] + 1;
        cnt[j] = k;
        if (k === 1) { mx[j] = v; mn[j] = v; } else { if (v > mx[j]) mx[j] = v; if (v < mn[j]) mn[j] = v; }
        const dm = v - mean[j];
        mean[j] += dm / k;
        m2[j] += dm * (v - mean[j]);
      }
    }
    const blk: ProjectionBlock = {
      from, to, max: new Float32Array(length), min: new Float32Array(length), mean: new Float64Array(length), m2: new Float32Array(length), count: new Uint16Array(length),
    };
    for (let j = 0; j < length; j++) {
      const k = cnt[j];
      blk.count[j] = k;
      if (k === 0) { blk.max[j] = NaN; blk.min[j] = NaN; blk.mean[j] = NaN; blk.m2[j] = NaN; continue; }
      blk.max[j] = mx[j]; blk.min[j] = mn[j]; blk.mean[j] = mean[j]; blk.m2[j] = m2[j];
    }
    blocks.push(blk);
  }
  return { n, length, blockSize: bs, blocks };
}

/**
 * The projection over planes [from, to): whole blocks inside the range from their summaries, the planes at its
 * ends from `getPlane`. Equals `projectPlanes` over the same planes (see the header for how exactly).
 */
export async function projectRange(blocks: ProjectionBlocks, getPlane: GetPlane, from: number, to: number, mode: FluximgProjectionMode): Promise<Float32Array> {
  if (!MODES.includes(mode)) throw new Error(`fluximg project: unknown mode ${mode}`);
  const length = blocks.length;
  const lo = Math.max(0, Math.floor(from)), hi = Math.min(blocks.n, Math.floor(to));
  const n = new Float64Array(length), a = new Float64Array(length), b = new Float64Array(mode === "std" ? length : 0);
  let i = lo;
  while (i < hi) {
    const blk = blocks.blocks[Math.floor(i / blocks.blockSize)];
    if (blk && blk.from === i && blk.to <= hi) {
      combine(blk, mode, n, a, b);
      i = blk.to;
    } else {
      feed(await getPlane(i), length, mode, n, a, b);
      i++;
    }
  }
  return finish(mode, n, a, b);
}

/** Merge one block summary into running state (the same state `feed` keeps). */
function combine(blk: ProjectionBlock, mode: FluximgProjectionMode, n: Float64Array, a: Float64Array, b: Float64Array): void {
  const length = n.length;
  for (let j = 0; j < length; j++) {
    const kb = blk.count[j];
    if (kb === 0) continue;
    const ka = n[j], k = ka + kb;
    n[j] = k;
    if (mode === "max") { const v = blk.max[j]; if (ka === 0 || v > a[j]) a[j] = v; }
    else if (mode === "min") { const v = blk.min[j]; if (ka === 0 || v < a[j]) a[j] = v; }
    else if (mode === "std") {
      const mb = blk.mean[j], dm = mb - a[j];
      a[j] += (dm * kb) / k;
      b[j] += blk.m2[j] + (dm * dm * ka * kb) / k;
    } else a[j] += blk.mean[j] * kb;
  }
}
