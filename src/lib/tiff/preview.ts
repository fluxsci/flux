/**
 * What an answer would make of a TIFF, as small pictures: one per channel of the answer, of a representative plane
 * (the middle of every other leading dimension), read through the same `PixelSource` the converter uses, so a
 * transpose, a flip, a de-interleave or a no-data value shows exactly as it will be stored. Pure (RGBA out; the
 * engine encodes PNG).
 *
 * The asking surface redraws these on every change of the answer, so this must stay well under 100 ms for an
 * ordinary file: one page read per channel, a strided box mean down to `max` px, a sorted sample of at most 64k
 * values for the 1–99.8 % window. An answer that does not fit the file (its sizes do not multiply to the page
 * count) still gets a picture: the representative page itself, with the answer's orientation, marked `fallback`.
 */
import { defaultChannelColours } from "../fluximg/writer";
import type { Codecs } from "./decode";
import type { TiffFile } from "./ifd";
import { throwIfAborted } from "./io";
import { answerProblems } from "./infer";
import { tiffPixelSource } from "./source";
import type { DimsAnswer, TiffProbe } from "./types";

export interface PreviewChannel {
  /** The channel's name as the answer has it (or "1", "2", … when it has none). */
  name: string;
  /** `#rrggbb`, or null for gray. */
  color: string | null;
  width: number;
  height: number;
  rgba: Uint8Array;
  /** The values mapped to black and white (1st and 99.8th percentile of the plane's finite values), or null when it has none. */
  window: [number, number] | null;
}

export interface TiffPreview {
  channels: PreviewChannel[];
  /** The full plane's size after the answer's transpose. */
  plane: { width: number; height: number };
  /** Where the pictured plane sits, in words ("t 408 of 816"). */
  at: string;
  /** True when the answer does not fit the file and the picture is its representative page instead. */
  fallback: boolean;
  /** How many channels the answer has (only the first `maxChannels` are pictured). */
  channelCount: number;
  /** Float data whose smallest value is a round number that fills a good part of the plane (-1 written where nothing
   *  was scanned, say): a value that probably means "no data". Null when nothing suggests one. NaN needs no answer. */
  frequentMin: { value: number; share: number } | null;
}

export interface PreviewOptions {
  /** Longest side of each picture (default 256, at most 512). */
  max?: number;
  /** Channels pictured (default 6). */
  maxChannels?: number;
  signal?: AbortSignal;
}

const SAMPLE = 65536;

/** A safe answer for the representative page alone: the answer's orientation, one plane. */
function pageAnswer(probe: TiffProbe, answer: DimsAnswer): DimsAnswer {
  const bool = (v: unknown): boolean => v === true;
  const a: DimsAnswer = { dims: [], pages: { first: probe.previewPage, count: 1 }, transpose: bool(answer?.transpose), flipX: bool(answer?.flipX), flipY: bool(answer?.flipY) };
  if (probe.plane.samples > 1 && (answer?.samples === "c" || answer?.samples === "rgb") && !(answer.samples === "rgb" && probe.plane.samples < 3)) a.samples = answer.samples;
  return a;
}

/** Pictures of what `answer` makes of the file. Throws only when the file itself cannot be read. */
export async function previewTiff(file: TiffFile, probe: TiffProbe, answer: DimsAnswer, codecs: Codecs, opts: PreviewOptions = {}): Promise<TiffPreview> {
  const max = Math.max(16, Math.min(512, Math.round(opts.max ?? 256)));
  const maxChannels = Math.max(1, Math.min(16, opts.maxChannels ?? 6));
  const fits = !answerProblems(probe, answer).length;
  const use = fits ? answer : pageAnswer(probe, answer);
  const src = tiffPixelSource(file, probe, use, codecs, { signal: opts.signal, cacheBytes: 64 * 1024 * 1024 });
  const lead = src.dims.slice(0, -2), H = src.shape[src.shape.length - 2], W = src.shape[src.shape.length - 1];
  const ci = lead.indexOf("c"), C = ci >= 0 ? src.shape[ci] : 1;
  // The middle of every other dimension (as the probe's preview page is the middle of the stack).
  const base = lead.map((_, k) => Math.floor(src.shape[k] / 2));
  const where = lead.map((d, k) => (d === "c" ? "" : `${d} ${base[k] + 1} of ${src.shape[k]}`)).filter(Boolean).join(" · ");
  const colours = defaultChannelColours(C);
  const names = fits ? answer.channels ?? [] : [];
  const rgb = use.samples === "rgb";
  const channels: PreviewChannel[] = [];
  let frequentMin: TiffPreview["frequentMin"] = null;
  for (let c = 0; c < Math.min(C, maxChannels); c++) {
    throwIfAborted(opts.signal);
    const leading = base.slice();
    if (ci >= 0) leading[ci] = c;
    const plane = await src.plane(leading);
    if (c === 0 && (src.dtype === "float32" || src.dtype === "float64") && !(fits && answer.nodata != null)) frequentMin = frequentMinimum(plane);
    const ch = names[c] ?? {};
    const color = rgb ? ["#ff0000", "#00ff00", "#0000ff"][c] ?? null : ch.color ?? colours[c] ?? null;
    channels.push(picture(plane, W, H, max, ch.name ?? (rgb ? ["red", "green", "blue"][c] : String(c + 1)), color));
  }
  return { channels, plane: { width: W, height: H }, at: where, fallback: !fits, channelCount: C, frequentMin };
}

/** The plane's minimum when it is a whole number held by at least 2 % of the finite samples (a strided count). */
function frequentMinimum(plane: ArrayLike<number>): TiffPreview["frequentMin"] {
  const stride = Math.max(1, Math.floor(plane.length / 262144));
  let min = Infinity, n = 0;
  for (let i = 0; i < plane.length; i += stride) { const v = plane[i]; if (Number.isFinite(v)) { n++; if (v < min) min = v; } }
  if (!n || !Number.isInteger(min)) return null;
  let at = 0;
  for (let i = 0; i < plane.length; i += stride) if (plane[i] === min) at++;
  const share = at / n;
  return share >= 0.02 && share < 1 ? { value: min, share: Number(share.toFixed(3)) } : null;
}

/** One plane → a small picture: box means of finite values (strided inside big blocks), the 1–99.8 % window, the colour. */
function picture(plane: ArrayLike<number>, W: number, H: number, max: number, name: string, color: string | null): PreviewChannel {
  const k = Math.max(W, H) > max ? Math.max(W, H) / max : 1;
  const w = Math.max(1, Math.round(W / k)), h = Math.max(1, Math.round(H / k));
  const out = new Float64Array(w * h);
  // At most 4 x 4 samples per output pixel: a preview, not a still (the still is the reference renderer's job).
  const step = Math.max(1, Math.floor(k / 4));
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor((y * H) / h), y1 = Math.max(y0 + 1, Math.floor(((y + 1) * H) / h));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor((x * W) / w), x1 = Math.max(x0 + 1, Math.floor(((x + 1) * W) / w));
      let s = 0, n = 0;
      for (let yy = y0; yy < y1; yy += step) for (let xx = x0, o = yy * W; xx < x1; xx += step) { const v = plane[o + xx]; if (v === v && v !== Infinity && v !== -Infinity) { s += v; n++; } }
      out[y * w + x] = n ? s / n : NaN;
    }
  }
  const finite: number[] = [];
  const stride = Math.max(1, Math.floor(out.length / SAMPLE));
  for (let i = 0; i < out.length; i += stride) { const v = out[i]; if (Number.isFinite(v)) finite.push(v); }
  finite.sort((a, b) => a - b);
  const q = (p: number): number => finite[Math.min(finite.length - 1, Math.max(0, Math.round(p * (finite.length - 1))))];
  const window: [number, number] | null = finite.length ? [q(0.01), q(0.998)] : null;
  const [lo, hi] = window ?? [0, 1];
  const span = hi > lo ? hi - lo : 1;
  const [r, g, b] = color ? [parseInt(color.slice(1, 3), 16), parseInt(color.slice(3, 5), 16), parseInt(color.slice(5, 7), 16)] : [255, 255, 255];
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < out.length; i++) {
    const v = out[i], o = i * 4;
    if (!Number.isFinite(v)) { rgba[o] = 40; rgba[o + 1] = 38; rgba[o + 2] = 36; rgba[o + 3] = 255; continue; } // no data: the board's dark, a little lifted
    const t = Math.min(1, Math.max(0, (v - lo) / span));
    rgba[o] = Math.round(r * t); rgba[o + 1] = Math.round(g * t); rgba[o + 2] = Math.round(b * t); rgba[o + 3] = 255;
  }
  return { name, color, width: w, height: h, rgba, window };
}
