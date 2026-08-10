// The renderer/TypeScript face of the web-capture file rules.
//
// The rules themselves live in electron/captureRules.js — see that file for why they sit
// under electron/ and why they're ESM. Re-exporting rather than reimplementing is the point:
// main.cjs classifies watched downloads with the SAME isCaptureFile the intake uses, so the
// two halves cannot drift.
export { CAPTURE_PREFIX, CAPTURE_EXT, SUPP_PREFIX, SUPP_SEP, isCaptureFile, isSupplementCapture, parseSupplementCapture, parseFluxCapture, captureSlug, doiFromSlug, safeCaptureFileName, articleCaptureName, sidecarCaptureName, supplementCaptureName } from "../../../electron/captureRules.js";
export type { FluxCapture } from "../../../electron/captureRules.js";
