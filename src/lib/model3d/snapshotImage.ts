/** Decode a host snapshot into an owned SVG image. Temporary decoded storage is
 * closed on every path; the compressed URL lives only until cancel/disposal. */
import type { Model3dHost } from './host';
import type { Model3dRenderSpec } from './types';
export function modelSnapshotImage(image: SVGImageElement, host: Model3dHost, spec: Model3dRenderSpec) {
  let canceled = false, url: string | undefined, cancelLoad: (() => void) | undefined;
  const ready = (async () => {
    if (!host.snapshot) throw new Error('3D snapshots unavailable');
    await host.ready([spec.assetId], [{ ...spec, w: 32, h: 32 }]); if (canceled) return;
    const bitmap = await host.snapshot(spec), canvas = document.createElement('canvas');
    try {
      if (canceled) return;
      canvas.width = bitmap.width; canvas.height = bitmap.height;
      const context = canvas.getContext('2d'); if (!context) throw new Error('Model snapshot canvas is unavailable');
      context.drawImage(bitmap, 0, 0);
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('Model snapshot encoding failed')), 'image/png'));
      // Encoding owns the last decoded copy; image loading must not retain it.
      bitmap.close(); canvas.width = 0; canvas.height = 0;
      if (canceled) return; url = URL.createObjectURL(blob);
      await new Promise<void>((resolve, reject) => {
        const clear = () => { image.removeEventListener('load', loaded); image.removeEventListener('error', failed); cancelLoad = undefined; };
        const loaded = () => { clear(); resolve(); }, failed = () => { clear(); reject(new Error('Model snapshot image could not be decoded')); };
        cancelLoad = () => { clear(); resolve(); };
        image.addEventListener('load', loaded, { once: true }); image.addEventListener('error', failed, { once: true }); image.setAttribute('href', url!);
      });
    } finally { bitmap.close(); canvas.width = 0; canvas.height = 0; }
  })();
  void ready.catch(() => {}); // the owner exposes failure through readiness
  return { ready, cancel() { canceled = true; cancelLoad?.(); if (url) { URL.revokeObjectURL(url); url = undefined; } } };
}
