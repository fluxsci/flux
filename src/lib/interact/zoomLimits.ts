// The figure/slide editor's zoom range — the ONE place the clamp lives.
//
// Every route that writes viewport.zoom from user input (Ctrl-wheel in
// Canvas.svelte, the toolbar's − / + buttons) clamps through clampZoom, so the
// routes cannot drift apart (until 2026-09-25 each carried its own literal
// 0.05 / 16). Programmatic writes (fit, centre-on-figure, gates) are not
// clamped: they choose their zoom deliberately.
//
// Why a ceiling at all: the settled zoom is BAKED into the scene as an SVG
// scale(renderZoom) (Canvas.svelte, P6 rationale), and Skia's path math and
// the compositor's transforms run in float32. Device-space coordinates under
// 1e6 px still resolve to 1/16 px; past ~1e7 px geometry visibly jitters, and
// an unbounded wheel eventually overflows the transform with no way back but a
// reset. 256× (25600%) is the Figma ceiling: a figure 3,000 units wide stays
// under 1e6 device px, and a half-unit hairline is 128 px wide — ample for
// inspecting marker overlap or tick alignment. Raised from 16× at the owner's
// request (2026-09-25); the floor is unchanged.
//
// Pure (no DOM, no stores) so scripts/verify-zoom-limits.ts gates it
// hermetically.
export const ZOOM_MIN = 0.05;
export const ZOOM_MAX = 256;

/** Clamp a requested zoom into the editor's range. */
export function clampZoom(z: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
}
