/// <reference lib="webworker" />
// Decodes a raster image OFF the main thread and returns downsampled tiers / a cropped detail as PNG
// bytes (figure/imageTiers.ts is the policy, figure/imageDisplay.ts the owner). A 28 MP PNG takes
// ~0.4 s and 113 MB to decode: that must never happen on the thread that paints.

interface TierRequest { id: number; kind: "tiers"; key: string; bytes?: ArrayBuffer; mime: string; levels: { level: number; width: number; height: number }[] }
interface DetailRequest { id: number; kind: "detail"; key: string; bytes?: ArrayBuffer; mime: string; source: { x: number; y: number; width: number; height: number }; width: number; height: number }
interface ForgetRequest { id: number; kind: "forget"; key?: string }
type TierMessage = TierRequest | DetailRequest | ForgetRequest;

// Decoded sources, most recent last. A second detail of the same image (the next pan) must not pay
// the decode again; the budget keeps at most a couple of large images resident, briefly.
const SOURCE_PIXEL_BUDGET = 64_000_000, SOURCE_IDLE_MS = 30_000;
const sources = new Map<string, { bitmap: ImageBitmap; pixels: number; used: number }>();
let reaper: ReturnType<typeof setTimeout> | null = null;
function reap() {
  reaper = null;
  const now = performance.now();
  for (const [key, entry] of sources) if (now - entry.used >= SOURCE_IDLE_MS) { entry.bitmap.close(); sources.delete(key); }
  if (sources.size) reaper = setTimeout(reap, SOURCE_IDLE_MS);
}
async function source(key: string, bytes: ArrayBuffer | undefined, mime: string): Promise<ImageBitmap> {
  const held = sources.get(key);
  if (held) { held.used = performance.now(); sources.delete(key); sources.set(key, held); return held.bitmap; }
  if (!bytes) throw new Error("source-needed");
  const bitmap = await createImageBitmap(new Blob([bytes], { type: mime }));
  const pixels = bitmap.width * bitmap.height;
  let total = pixels;
  for (const entry of sources.values()) total += entry.pixels;
  for (const [k, entry] of sources) { if (total <= SOURCE_PIXEL_BUDGET) break; entry.bitmap.close(); sources.delete(k); total -= entry.pixels; }
  sources.set(key, { bitmap, pixels, used: performance.now() });
  if (!reaper) reaper = setTimeout(reap, SOURCE_IDLE_MS);
  return bitmap;
}
async function encode(bitmap: ImageBitmap, sx: number, sy: number, sw: number, sh: number, width: number, height: number): Promise<ArrayBuffer> {
  // High-quality resampling in one step; the 2D canvas only carries the pixels to the PNG encoder.
  const scaled = await createImageBitmap(bitmap, sx, sy, sw, sh, { resizeWidth: width, resizeHeight: height, resizeQuality: "high" });
  try {
    const canvas = new OffscreenCanvas(width, height), ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d context");
    ctx.drawImage(scaled, 0, 0);
    return await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer();
  } finally { scaled.close(); }
}

// One request at a time: a second decode must never evict (close) the bitmap a running request is
// still drawing from — two 28 MP images decoding together did exactly that and both lost their tiers.
let chain: Promise<void> = Promise.resolve();
self.onmessage = (event: MessageEvent<TierMessage>) => { chain = chain.then(() => handle(event.data)); };
async function handle(request: TierMessage): Promise<void> {
  try {
    if (request.kind === "forget") {
      for (const [key, entry] of sources) if (!request.key || key === request.key) { entry.bitmap.close(); sources.delete(key); }
      (self as unknown as Worker).postMessage({ id: request.id, ok: true });
      return;
    }
    const bitmap = await source(request.key, request.bytes, request.mime);
    const natural = { width: bitmap.width, height: bitmap.height };
    if (request.kind === "tiers") {
      const tiers: { level: number; width: number; height: number; bytes: ArrayBuffer }[] = [];
      for (const level of request.levels) tiers.push({ ...level, bytes: await encode(bitmap, 0, 0, bitmap.width, bitmap.height, level.width, level.height) });
      (self as unknown as Worker).postMessage({ id: request.id, ok: true, natural, tiers }, tiers.map(t => t.bytes));
    } else {
      const s = request.source;
      const x = Math.max(0, Math.min(bitmap.width - 1, Math.round(s.x))), y = Math.max(0, Math.min(bitmap.height - 1, Math.round(s.y)));
      const w = Math.max(1, Math.min(bitmap.width - x, Math.round(s.width))), h = Math.max(1, Math.min(bitmap.height - y, Math.round(s.height)));
      const bytes = await encode(bitmap, x, y, w, h, request.width, request.height);
      (self as unknown as Worker).postMessage({ id: request.id, ok: true, natural, bytes }, [bytes]);
    }
  } catch (error) {
    (self as unknown as Worker).postMessage({ id: request.id, ok: false, error: String((error as Error)?.message ?? error) });
  }
};
