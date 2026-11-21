/**
 * ImageJ hyperstack descriptions (`ImageJ=1.54f\nimages=24\nchannels=2\nslices=3\nframes=4\n...`). Pure.
 *
 * Pages are in XYCZT order: channel fastest, then slice, then frame. The pixel size is 1/XResolution in the
 * description's `unit`; `spacing` is the z step and `finterval` (or `fps`) the frame interval.
 */
import type { Hint } from "../types";

export interface ImageJInfo {
  version: string;
  images: number | null;
  channels: number;
  slices: number;
  frames: number;
  unit: string | null;
  spacing: number | null;
  finterval: number | null;
  tunit: string | null;
  raw: Record<string, string>;
}

export const isImageJ = (d: string | undefined): boolean => !!d && d.startsWith("ImageJ=");

export function parseImageJ(d: string): ImageJInfo {
  const raw: Record<string, string> = {};
  for (const line of d.split(/\r?\n/)) {
    const i = line.indexOf("=");
    if (i > 0) raw[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  const num = (k: string): number | null => { const v = Number(raw[k]); return raw[k] !== undefined && Number.isFinite(v) ? v : null; };
  const pos = (k: string): number => { const v = num(k); return v !== null && v >= 1 ? Math.round(v) : 1; };
  const fps = num("fps");
  return {
    version: raw.ImageJ ?? "", images: num("images"), channels: pos("channels"), slices: pos("slices"), frames: pos("frames"),
    unit: raw.unit ? unescapeUnicode(raw.unit) : null, spacing: num("spacing"),
    finterval: num("finterval") ?? (fps && fps > 0 ? 1 / fps : null), tunit: raw.tunit ?? null, raw,
  };
}

const unescapeUnicode = (s: string): string => s.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));

/** A spatial unit in Flux's spelling, or null when it is not a physical length ("pixel", "inch" kept as is). */
export function normaliseLengthUnit(u: string | null | undefined): string | null {
  if (!u) return null;
  const s = u.trim().toLowerCase();
  if (["micron", "microns", "um", "µm", "μm", "micrometer", "micrometre"].includes(s)) return "µm";
  if (["nm", "nanometer", "nanometre"].includes(s)) return "nm";
  if (["mm", "millimeter", "millimetre"].includes(s)) return "mm";
  if (["cm", "centimeter", "centimetre"].includes(s)) return "cm";
  if (["m", "meter", "metre"].includes(s)) return "m";
  if (["inch", "in", "inches"].includes(s)) return "in";
  if (["pixel", "pixels", "px", ""].includes(s)) return null;
  return u.trim();
}

/** Seconds per `unit` for the time units ImageJ and OME write. */
export function secondsPer(unit: string | null | undefined): number | null {
  const s = (unit ?? "s").trim().toLowerCase();
  if (["s", "sec", "secs", "second", "seconds"].includes(s)) return 1;
  if (["ms", "msec", "millisecond", "milliseconds"].includes(s)) return 1e-3;
  if (["us", "µs", "μs", "microsecond", "microseconds"].includes(s)) return 1e-6;
  if (["min", "mins", "minute", "minutes"].includes(s)) return 60;
  if (["h", "hr", "hour", "hours"].includes(s)) return 3600;
  return null;
}

/**
 * The hint an ImageJ description gives for a file of `pages` pages whose first page has `samples` samples and
 * horizontal resolution `xres` (pixels per unit).
 */
export function imagejHint(d: string, pages: number, samples: number, xres: number | null): Hint {
  const ij = parseImageJ(d);
  const reasons: string[] = [`ImageJ ${ij.version || ""} hyperstack description`.replace("  ", " ")];
  const problems: string[] = [];
  const dims = [{ name: "t", size: ij.frames }, { name: "z", size: ij.slices }, { name: "c", size: ij.channels }].filter((x) => x.size > 1);
  const product = ij.frames * ij.slices * ij.channels;
  if (dims.length) reasons.push(`pages in ImageJ order (channel fastest, then slice, then frame): ${dims.map((x) => `${x.name} ${x.size}`).join(" × ")}`);
  if (ij.images !== null && ij.images !== product && !(product === 1 && ij.images === pages)) problems.push(`the description says images=${ij.images} but channels × slices × frames = ${product}`);
  if (product === 1 && pages > 1) {
    // A plain stack saved by ImageJ: images=N without channels/slices/frames is a z stack by ImageJ's convention.
    dims.push({ name: "z", size: pages });
    reasons.push(`${pages} images with no channels, slices or frames: ImageJ calls such a stack slices`);
  } else if (product !== pages) problems.push(`the description accounts for ${product} pages; the file has ${pages}`);
  const hint: Hint = { source: "imagej", confidence: problems.length ? "medium" : "high", dims, reasons, ...(problems.length ? { problems } : {}) };
  if (samples >= 3 && !d.includes("channels=")) { hint.samples = "rgb"; reasons.push("RGB pixels (ImageJ writes colour images as three samples)"); }
  const unit = normaliseLengthUnit(ij.unit);
  if (unit && xres && xres > 0) {
    hint.pixelSize = { x: 1 / xres, y: 1 / xres, unit };
    reasons.push(`pixel size ${fmt(1 / xres)} ${unit} (resolution and unit)`);
  }
  if (ij.spacing && ij.spacing > 0 && ij.slices > 1) { hint.z = { step: ij.spacing, unit }; reasons.push(`z step ${fmt(ij.spacing)} ${unit ?? "(no unit)"}`); }
  const tScale = secondsPer(ij.tunit);
  if (ij.finterval && ij.finterval > 0 && ij.frames > 1) {
    hint.time = { interval: ij.finterval * (tScale ?? 1), unit: "s" };
    reasons.push(`frame interval ${fmt(ij.finterval * (tScale ?? 1))} s`);
  }
  return hint;
}

export const fmt = (v: number): string => (Math.abs(v) >= 1e4 || (Math.abs(v) < 1e-3 && v !== 0) ? v.toExponential(3) : String(Number(v.toPrecision(6))));
