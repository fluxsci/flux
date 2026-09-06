import { encodeTiff } from './tiff';
import { injectPngDpi } from './pngDpi';

/** Pixel readback and encoding stay off the editor thread. Bitmap ownership is
 * transferred in, output ownership transferred out, with no RGBA copy in IPC. */
self.onmessage = async (event: MessageEvent<{
  bitmap: ImageBitmap; width: number; height: number; background: string | null;
  format: 'png' | 'tiff'; dpi?: number; alpha: boolean;
}>) => {
  const job = event.data;
  try {
    const canvas = new OffscreenCanvas(job.width, job.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not allocate an export canvas.');
    if (job.background) { ctx.fillStyle = job.background; ctx.fillRect(0, 0, job.width, job.height); }
    ctx.drawImage(job.bitmap, 0, 0, job.width, job.height);
    let bytes: Uint8Array;
    if (job.format === 'tiff') {
      const data = ctx.getImageData(0, 0, job.width, job.height).data;
      bytes = encodeTiff(data, job.width, job.height, { dpi: job.dpi ?? 96, alpha: job.alpha });
    } else {
      const blob = await canvas.convertToBlob({ type: 'image/png' });
      bytes = new Uint8Array(await blob.arrayBuffer());
      if (job.dpi) bytes = injectPngDpi(bytes, job.dpi);
    }
    self.postMessage({ bytes }, { transfer: [bytes.buffer] });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  } finally { job.bitmap.close(); }
};
