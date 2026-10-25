// ---------------------------------------------------------------------------
// The device-pixel grid of a slide stage (smoothness pass, 2026-10-24).
//
// A node drawn on its own compositor layer and the same node painted into the stage are pixel-identical only when the node sits on a whole
// DEVICE pixel: anywhere else the layer is resampled at the fraction while the stage paints the node's anti-aliasing at it, and the two differ
// along every curve and diagonal (measured, offscreen Electron at devicePixelRatio 1.25: a stroked rect 76, an ellipse 97 at a fractional
// position, 0 at a whole one, for text, shapes and in both layer kinds). Two halves make "whole device pixel" knowable:
//   1. a stage HOST (the exported deck's fit, the editor preview, Present) puts the stage's origin on the device grid (gridFit). A host
//      centred with `left: 50%` + `translate(-50%, -50%)` landed on a fraction the browser then snapped by its own rule, and the stage's
//      true device origin was no longer what getBoundingClientRect reports (half a device pixel off in some window sizes);
//   2. the player puts a gliding node's REST on the grid (stageGrid + snapToGrid; render.ts applyWrapperBox), and the glide flies between
//      the snapped ends, so the landing frame is the rest and both are crisp.
// Every function here is pure apart from stageGrid, which reads the mount's box (a layout read) and is inert in a headless host.
// ---------------------------------------------------------------------------

/** The browser's layout snapping grid in local px per px: devicePixelRatio (browser zoom included); 1 in a headless host. */
export function devicePixelRatioOf(): number {
  const dpr = typeof window !== "undefined" ? window.devicePixelRatio : 1;
  return typeof dpr === "number" && Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
}

/** A stage of `stage` px fitted into `box` (CSS px, its own position included), letterboxed and centred, with the stage's ORIGIN on the
 *  device grid: `left` / `top` are relative to the box and land the origin on a whole device pixel; the host applies `scale(scale)` about
 *  its top-left corner (transform-origin 0 0). Pure. */
export function gridFit(box: { left: number; top: number; width: number; height: number }, stage: { width: number; height: number }, dpr: number): { scale: number; left: number; top: number } {
  const scale = Math.max(1e-6, Math.min(box.width / stage.width, box.height / stage.height));
  const on = (v: number) => Math.round(v * dpr) / dpr;
  const ax = box.left + (box.width - stage.width * scale) / 2, ay = box.top + (box.height - stage.height * scale) / 2;
  const tidy = (v: number) => Math.round(v * 1e6) / 1e6;
  return { scale, left: tidy(on(ax) - box.left), top: tidy(on(ay) - box.top) };
}

/** Where a camera layer's LOCAL coordinates land on the device: device = (fx, fy) + whole pixels + s · local. `s` is device px per local px
 *  (devicePixelRatio x the host's fit scale x the camera's zoom), `fx` / `fy` the fractional device offset of the local origin. */
export interface StageGrid { s: number; fx: number; fy: number }

/** Pure: the grid of a camera layer from its mount's device-space box and its own pose. `mountLeft` / `mountTop` are the mount's CSS px
 *  position, `hostScale` its fit scale, `pose` the camera's `translate(x px, y px) scale(z)` (or "" = identity). Null when unusable. */
export function gridOf(mountLeft: number, mountTop: number, hostScale: number, dpr: number, pose: string): StageGrid | null {
  const p = cameraPose(pose);
  if (!p || !(hostScale > 0) || !(dpr > 0)) return null;
  const s = dpr * hostScale * p.z;
  const ox = dpr * (mountLeft + hostScale * p.x), oy = dpr * (mountTop + hostScale * p.y);
  if (!(s > 0) || !Number.isFinite(ox) || !Number.isFinite(oy)) return null;
  return { s, fx: ox - Math.floor(ox), fy: oy - Math.floor(oy) };
}

/** Pure: [x, y, z] of a camera pose string (a translate in px and an optional scale, either order is NOT supported: the player writes
 *  translate then scale), "" / "none" = identity; null when unreadable. */
export function cameraPose(pose: string): { x: number; y: number; z: number } | null {
  const t = pose.trim();
  if (t === "" || t === "none") return { x: 0, y: 0, z: 1 };
  const tr = /translate\(\s*(-?[\d.]+(?:e[-+]?\d+)?)px\s*,\s*(-?[\d.]+(?:e[-+]?\d+)?)px\s*\)/i.exec(t);
  const sc = /scale\(\s*(-?[\d.]+(?:e[-+]?\d+)?)\s*\)/i.exec(t);
  const rest = t.replace(tr?.[0] ?? "", "").replace(sc?.[0] ?? "", "").trim();
  if (rest) return null;                     // a rotation or anything else: not a grid the player can snap to
  const x = tr ? Number(tr[1]) : 0, y = tr ? Number(tr[2]) : 0, z = sc ? Number(sc[1]) : 1;
  return [x, y, z].every(Number.isFinite) && z > 0 ? { x, y, z } : null;
}

/** Pure: the local-space shift that puts local point (x, y) on a whole device pixel of `grid` (each component within half a device pixel). */
export function snapDelta(grid: StageGrid, x: number, y: number): { dx: number; dy: number } {
  const ax = grid.fx + grid.s * x, ay = grid.fy + grid.s * y;
  return { dx: (Math.round(ax) - ax) / grid.s, dy: (Math.round(ay) - ay) / grid.s };
}

/** Where a camera layer's mount (its parent, the stage box) sits: CSS px position and fit scale. The one layout read of the grid. */
export interface StageMount { left: number; top: number; scale: number }
/** The mount box of a camera layer, read through getBoundingClientRect (exact for transforms; the hosts keep their own layout offsets on the
 *  grid, gridFit) and the stage width from the mount's layout box. Null in a headless host or before the stage is laid out. */
export function stageMountOf(camera: HTMLElement): StageMount | null {
  const mount = camera.parentElement;
  if (!mount || typeof mount.getBoundingClientRect !== "function" || typeof window === "undefined") return null;
  const width = mount.offsetWidth;
  if (!(width > 0)) return null;
  const r = mount.getBoundingClientRect();
  return r.width > 0 ? { left: r.left, top: r.top, scale: r.width / width } : null;
}
/** The grid of a camera layer from its mount box and its pose (the camera's inline transform), at the current devicePixelRatio. No layout. */
export function gridOfMount(mount: StageMount, pose: string): StageGrid | null { return gridOf(mount.left, mount.top, mount.scale, devicePixelRatioOf(), pose); }
/** The live grid of a camera layer (a layout read: stageMountOf). */
export function stageGrid(camera: HTMLElement): StageGrid | null { const m = stageMountOf(camera); return m ? gridOfMount(m, camera.style.transform) : null; }
