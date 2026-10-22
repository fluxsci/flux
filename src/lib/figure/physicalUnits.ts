// Physical sizes as the user reads them: INCHES by default — what one passes to matplotlib's
// `figsize` — or millimetres (Settings → Figure → Physical sizes). Display only: the document
// stays in CSS px at 96/in; nothing here converts stored geometry.

export type PhysicalUnit = "in" | "mm";
export const PHYSICAL_UNITS: readonly PhysicalUnit[] = ["in", "mm"];
export const DEFAULT_PHYSICAL_UNIT: PhysicalUnit = "in";

const MM_PER_INCH = 25.4;

/** One length given in CSS px (96/in): "3.30" (in, two decimals) or "83.8" (mm, one). */
export function formatLengthPx(px: number, unit: PhysicalUnit): string {
  const inches = px / 96;
  return unit === "mm" ? (inches * MM_PER_INCH).toFixed(1) : inches.toFixed(2);
}

/** "3.30 × 2.85 in" / "83.8 × 72.4 mm" from CSS px. */
export function formatSizePx(wPx: number, hPx: number, unit: PhysicalUnit): string {
  return `${formatLengthPx(wPx, unit)} × ${formatLengthPx(hPx, unit)} ${unit}`;
}

/** The same from a size in millimetres (the plot index's physMm); "" when unknown. */
export function formatSizeMm(physMm: readonly [number, number] | null | undefined, unit: PhysicalUnit): string {
  if (!physMm || !(physMm[0] > 0) || !(physMm[1] > 0)) return "";
  const px = (mm: number) => (mm / MM_PER_INCH) * 96;
  return formatSizePx(px(physMm[0]), px(physMm[1]), unit);
}

/** One width in millimetres, in the chosen unit with its suffix: "3.50 in" / "89.0 mm". */
export function formatWidthMm(mm: number, unit: PhysicalUnit): string {
  return `${formatLengthPx((mm / MM_PER_INCH) * 96, unit)} ${unit}`;
}
