import type { FileBridge } from '../project/types';

type BrowserDropper = new () => { open(options: { signal: AbortSignal }): Promise<{ sRGBHex: string }> };
type Options = {
  bridge?: FileBridge;
  signal: AbortSignal;
  browserDropper?: BrowserDropper;
  onWindowFallback?: () => void;
};
const cancelled = () => new DOMException('Color picking cancelled', 'AbortError');
const check = (signal: AbortSignal) => { if (signal.aborted) throw cancelled(); };

/** A native SIGSEGV cannot be caught by JavaScript. Linux Electron must never
 * invoke Chromium's EyeDropperView, even when the API is advertised as present. */
export async function pickColor({ bridge, signal, browserDropper, onWindowFallback }: Options): Promise<string | null> {
  check(signal);
  if (bridge?.platform === 'linux') {
    if (bridge.pickScreenColor) {
      const requestId = crypto.randomUUID();
      const abort = () => { void bridge.cancelScreenColor?.(requestId).catch(() => {}); };
      signal.addEventListener('abort', abort, { once: true });
      try {
        const result = await bridge.pickScreenColor(requestId);
        check(signal);
        if (result.status === 'picked') {
          if (!/^#[0-9a-f]{6}$/i.test(result.hex)) throw new Error('The color picker returned an invalid color.');
          return result.hex.toLowerCase();
        }
        if (result.status === 'cancelled') return null;
        if (result.status === 'error') throw new Error(result.message || 'Unable to pick a screen color.');
      } finally { signal.removeEventListener('abort', abort); }
    }
    if (!bridge.captureWindow) throw new Error('Screen color picking is unavailable. Enter a hex color or use the spectrum.');
    onWindowFallback?.();
    return pickWindowColor(bridge.captureWindow, signal);
  }
  if (!browserDropper) throw new Error('Screen color picking is unavailable.');
  const result = await new browserDropper().open({ signal });
  check(signal);
  return result.sRGBHex.toLowerCase();
}

/** Exact captured device-pixel position, including noninteger DPR and zoom. */
export function capturedPixel(x: number, y: number, cssWidth: number, cssHeight: number, width: number, height: number): [number, number] {
  return [Math.max(0, Math.min(width - 1, Math.floor(x * width / cssWidth))), Math.max(0, Math.min(height - 1, Math.floor(y * height / cssHeight)))];
}

async function pickWindowColor(capture: NonNullable<FileBridge['captureWindow']>, signal: AbortSignal): Promise<string | null> {
  const cssWidth = window.innerWidth, cssHeight = window.innerHeight;
  const shot = await capture();
  check(signal);
  const bytes = new Uint8Array(shot.png.byteLength);
  bytes.set(shot.png);
  const url = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
  const img = new Image();
  try {
    img.src = url;
    await img.decode();
    check(signal);
    if (window.innerWidth !== cssWidth || window.innerHeight !== cssHeight) return null;
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx || !canvas.width || !canvas.height) throw new Error('Unable to read window colors.');
    ctx.drawImage(img, 0, 0);
    return await new Promise(resolve => {
      const focused = document.activeElement as HTMLElement | null;
      const overlay = document.createElement('div');
      overlay.dataset.fluxEyedropper = 'window';
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-modal', 'true');
      overlay.setAttribute('aria-label', 'Pick a color from the Flux window');
      overlay.tabIndex = -1;
      Object.assign(overlay.style, { position: 'fixed', inset: '0', zIndex: '2147483647', cursor: 'crosshair', backgroundImage: `url("${url}")`, backgroundSize: '100% 100%' });
      const label = document.createElement('div');
      label.textContent = 'Pick a color from the Flux window · Esc cancels';
      Object.assign(label.style, { position: 'absolute', top: '12px', left: '50%', transform: 'translateX(-50%)', padding: '8px 12px', background: '#100f0f', color: '#fffcf0', font: '13px sans-serif', pointerEvents: 'none' });
      const lens = document.createElement('canvas');
      lens.width = lens.height = 99;
      Object.assign(lens.style, { position: 'absolute', width: '99px', height: '99px', border: '2px solid #fff', outline: '1px solid #100f0f', pointerEvents: 'none', imageRendering: 'pixelated', display: 'none' });
      const lensContext = lens.getContext('2d')!;
      lensContext.imageSmoothingEnabled = false;
      overlay.append(label, lens);
      let done = false;
      function finish(hex: string | null) {
        if (done) return;
        done = true;
        overlay.remove();
        window.removeEventListener('keydown', key, true);
        window.removeEventListener('resize', cancel);
        window.removeEventListener('blur', cancel);
        signal.removeEventListener('abort', cancel);
        if (focused?.isConnected) focused.focus({ preventScroll: true });
        resolve(hex);
      }
      function cancel() { finish(null); }
      function key(event: KeyboardEvent) {
        event.preventDefault(); event.stopImmediatePropagation();
        if (event.key === 'Escape') cancel();
      }
      overlay.addEventListener('pointermove', event => {
        const [x, y] = capturedPixel(event.clientX, event.clientY, cssWidth, cssHeight, canvas.width, canvas.height);
        const pixel = ctx!.getImageData(x, y, 1, 1).data;
        label.textContent = `#${Array.from(pixel.subarray(0, 3), v => v.toString(16).padStart(2, '0')).join('')} · Pick from Flux window · Esc cancels`;
        lens.style.display = 'block';
        lens.style.left = `${Math.max(0, Math.min(cssWidth - 103, event.clientX + 18))}px`;
        lens.style.top = `${Math.max(0, Math.min(cssHeight - 103, event.clientY + 18))}px`;
        lensContext.clearRect(0, 0, 99, 99);
        lensContext.drawImage(canvas, x - 5, y - 5, 11, 11, 0, 0, 99, 99);
        lensContext.strokeStyle = '#fff'; lensContext.strokeRect(45.5, 45.5, 8, 8);
        event.stopPropagation();
      });
      overlay.addEventListener('pointerdown', event => { event.preventDefault(); event.stopPropagation(); });
      overlay.addEventListener('click', event => {
        event.preventDefault(); event.stopPropagation();
        if (event.button !== 0) return;
        const [x, y] = capturedPixel(event.clientX, event.clientY, cssWidth, cssHeight, canvas.width, canvas.height);
        const pixel = ctx!.getImageData(x, y, 1, 1).data;
        finish('#' + Array.from(pixel.subarray(0, 3), v => v.toString(16).padStart(2, '0')).join(''));
      });
      overlay.addEventListener('contextmenu', event => { event.preventDefault(); cancel(); });
      overlay.addEventListener('wheel', event => { event.preventDefault(); event.stopPropagation(); }, { passive: false });
      window.addEventListener('keydown', key, true);
      window.addEventListener('resize', cancel);
      window.addEventListener('blur', cancel);
      signal.addEventListener('abort', cancel, { once: true });
      document.body.append(overlay);
      overlay.focus({ preventScroll: true });
      if (signal.aborted) cancel();
    });
  } finally { URL.revokeObjectURL(url); }
}
