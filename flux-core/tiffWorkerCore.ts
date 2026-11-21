/**
 * What the TIFF conversion child does, as functions (the child's message loop is `electron/tiffWorker.mjs`; the
 * Plots rail's thumbnail engine calls `tiffThumbPng` from its own bundle). Only a probe, small PNGs and progress
 * ever leave this process: no pixel array crosses IPC.
 *
 * Open files are kept (a few, least recently used first) so the asking surface's re-previews do not walk the IFDs
 * again; a file whose size or mtime changed is opened afresh.
 */
import fsp from "node:fs/promises";
import path from "node:path";
import { encodePng } from "./fluximgPng";
import { convertTiff, fsSource, nodeTiffCodecs, type ConvertProgress, type ConvertResult, type FileSource } from "./tiffConvert";
import { openTiff, type TiffFile } from "../src/lib/tiff/ifd";
import { probeFile } from "../src/lib/tiff/probe";
import { inferDims } from "../src/lib/tiff/infer";
import { previewTiff, type TiffPreview } from "../src/lib/tiff/preview";
import type { AnswerRule, DimsAnswer, DimsProposal, TiffProbe } from "../src/lib/tiff/types";

interface Open { key: string; src: FileSource; file: TiffFile; probe: TiffProbe; users: number; dead: boolean }
const open = new Map<string, Open>();
const MAX_OPEN = 4;

async function withFile<T>(file: string, signal: AbortSignal | undefined, fn: (o: Open) => Promise<T>): Promise<T> {
  const st = await fsp.stat(file);
  if (!st.isFile()) throw new Error(`${path.basename(file)} is not a file`);
  const key = `${st.size}:${st.mtimeMs}`;
  let o = open.get(file);
  if (o && o.key !== key) { retire(file, o); o = undefined; }
  if (!o) {
    const src = await fsSource(file);
    try {
      const tf = await openTiff(src, { signal });
      const probe = await probeFile(tf, { fileName: path.basename(file), codecs: nodeTiffCodecs(), periodicity: true, signal });
      o = { key, src, file: tf, probe, users: 0, dead: false };
    } catch (error) { await src.close().catch(() => {}); throw error; }
    open.set(file, o);
    while (open.size > MAX_OPEN) { const [k, v] = open.entries().next().value!; retire(k, v); }
  } else { open.delete(file); open.set(file, o); }
  o.users++;
  try { return await fn(o); } finally { o.users--; if (o.dead && !o.users) await o.src.close().catch(() => {}); }
}
function retire(k: string, o: Open): void {
  open.delete(k);
  o.dead = true;
  if (!o.users) void o.src.close().catch(() => {});
}

export interface PreviewPng { channels: Array<{ name: string; color: string | null; width: number; height: number; png: string; window: [number, number] | null }>; plane: TiffPreview["plane"]; at: string; fallback: boolean; channelCount: number; ms: number }

function encoded(p: TiffPreview, t0: number): PreviewPng {
  return { ...p, channels: p.channels.map((c) => ({ name: c.name, color: c.color, width: c.width, height: c.height, window: c.window, png: encodePng(c.rgba, c.width, c.height, { level: 3 }).toString("base64") })), ms: Math.round(performance.now() - t0) };
}

/** The probe, the ranked proposals (remembered rules first when one fits) and the top proposal's pictures. */
export async function probeOp(file: string, opts: { rules?: AnswerRule[]; max?: number; signal?: AbortSignal }): Promise<{ probe: TiffProbe; proposals: DimsProposal[]; preview: PreviewPng | null }> {
  return withFile(file, opts.signal, async (o) => {
    const proposals = inferDims(o.probe, { rules: opts.rules });
    let preview: PreviewPng | null = null;
    if (!o.probe.refusals.length) {
      const t0 = performance.now();
      preview = encoded(await previewTiff(o.file, o.probe, proposals[0]?.answer ?? { dims: [] }, nodeTiffCodecs(), { max: opts.max, signal: opts.signal }), t0);
    }
    return { probe: o.probe, proposals, preview };
  });
}

/** Pictures of what `answer` makes of the file. */
export function previewOp(file: string, answer: DimsAnswer, opts: { max?: number; signal?: AbortSignal }): Promise<PreviewPng> {
  return withFile(file, opts.signal, async (o) => {
    if (o.probe.refusals.length) throw new Error(o.probe.refusals.map((r) => r.message).join("; "));
    const t0 = performance.now();
    return encoded(await previewTiff(o.file, o.probe, answer, nodeTiffCodecs(), { max: opts.max, signal: opts.signal }), t0);
  });
}

/** Convert into `out` (which must not exist); progress at most every `everyMs`, and always the last. */
export async function convertOp(file: string, answer: DimsAnswer, out: string, opts: { name?: string; sourcePath?: string; signal?: AbortSignal; onProgress?: (p: ConvertProgress) => void; everyMs?: number }): Promise<ConvertResult> {
  let last = 0, pending: ConvertProgress | null = null;
  const every = opts.everyMs ?? 100;
  const r = await convertTiff(file, answer, out, {
    name: opts.name, sourcePath: opts.sourcePath, signal: opts.signal,
    onProgress: opts.onProgress ? (p) => {
      const now = performance.now();
      if (now - last >= every || (p.phase === "store" && p.done === p.total)) { last = now; pending = null; opts.onProgress!(p); } else pending = p;
    } : undefined,
  });
  if (pending && opts.onProgress) opts.onProgress(pending);
  return r;
}

/** One picture for the Plots rail: the top proposal when it needs no question, else the representative page; channels added. */
export async function tiffThumbPng(file: string, max: number): Promise<{ png: Buffer; width: number; height: number }> {
  return withFile(file, undefined, async (o) => {
    if (o.probe.refusals.length) throw Object.assign(new Error(o.probe.refusals[0].message), { unsupported: true });
    const top = inferDims(o.probe)[0];
    const p = await previewTiff(o.file, o.probe, top?.ready ? top.answer : { dims: [] }, nodeTiffCodecs(), { max: Math.min(512, max), maxChannels: 4 });
    const { width, height } = p.channels[0];
    const rgba = new Uint8Array(width * height * 4);
    for (const c of p.channels) for (let i = 0; i < rgba.length; i += 4) {
      rgba[i] = Math.min(255, rgba[i] + c.rgba[i]); rgba[i + 1] = Math.min(255, rgba[i + 1] + c.rgba[i + 1]); rgba[i + 2] = Math.min(255, rgba[i + 2] + c.rgba[i + 2]); rgba[i + 3] = 255;
    }
    return { png: encodePng(rgba, width, height), width, height };
  });
}

/** Close every kept file (the child's exit). */
export async function closeAll(): Promise<void> { for (const [k, o] of [...open]) retire(k, o); }
