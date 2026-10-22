// Typed re-export of the shared plot-thumbnail rules. The rules live in
// electron/plotThumbRules.mjs because the thumbnail worker (a Node child running from
// app.asar.unpacked) and the renderer must analyze ink and size images identically — one
// definition, the dissectRules / plotsFolders precedent.
export {
  THUMB_BUCKETS,
  PLOT_THUMB_GEN,
  ANALYSIS_WIDTH,
  BACKDROPS,
  LOST_BELOW,
  POOR_BELOW,
  bucketFor,
  svgIntrinsicSize,
  probeImageSize,
  analyzeInk,
  presentBins,
  backdropScore,
  chooseBackdrop,
  readsPoorlyOn,
  backdropTone,
  contrastRatio,
  luminance8,
} from "../../../electron/plotThumbRules.mjs";
export type { InkStats, BackdropMode, BackdropKind, BackdropChoice } from "../../../electron/plotThumbRules.mjs";
