// Paste arbitration between the in-app element clipboard and the OS clipboard
// (Figma-style screenshot paste). PURE — no DOM, no stores — so the decision
// table is pinned in the pure tier.
//
// The problem this solves: the internal element clipboard is module state and
// the OS clipboard is system state; neither clears the other, so a bare
// "always paste elements" keydown plus an "always import images" paste handler
// would DOUBLE-paste whenever both hold content. The fix: copySelected stamps
// the OS clipboard with a marker text, so the OS clipboard always reflects the
// MOST RECENT copy (in-app copy → marker; OS screenshot → image), and the ONE
// paste entry (the native "paste" event, which carries clipboard contents
// synchronously) decides from that.

/** Text copySelected() writes to the OS clipboard alongside the internal
 *  element clipboard. */
export const FLUX_CLIP_MARKER = "flux:elements:v1";

export type PasteAction = "elements" | "image" | "none";

/** Decide what a paste should do:
 *  - marker present + internal elements → paste the internal clipboard
 *  - an image on the OS clipboard → import it (screenshot paste)
 *  - otherwise → internal elements if any (pre-marker copies, cleared or
 *    text-bearing OS clipboard), else nothing. */
export function decidePaste(i: { text: string; hasImage: boolean; internalCount: number }): PasteAction {
  if (i.text.startsWith(FLUX_CLIP_MARKER) && i.internalCount > 0) return "elements";
  if (i.hasImage) return "image";
  return i.internalCount > 0 ? "elements" : "none";
}

/** Name for a pasted image: the Asset.name shown in the Layers panel, and the
 *  filename of the archived original under `plots/pasted/` (io.ts
 *  archivePastedImage, which dedupes a same-second collision). The DERIVED copy
 *  in fig/assets/ is always id-based. Chromium names clipboard files
 *  "image.png"; a dated name keeps multiple pastes tellable-apart. */
export function pastedImageName(now: Date, ext: "png" | "svg"): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `pasted-${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}.${ext}`;
}
