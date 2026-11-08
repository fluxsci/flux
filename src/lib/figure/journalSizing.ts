// Journal figure-width presets + physical↔pixel conversion (3.1). Publishers specify
// figure widths as physical column widths (mm) at a target resolution (dpi), not pixels.
// A scientist picks "double column @ 600 dpi" and the export renders at exactly
// mm/25.4 × dpi pixels — so the placed figure lands at the right physical size.

export const MM_PER_INCH = 25.4;

export interface WidthPreset {
  id: string;
  label: string;
  mm: number;
}

// Common column widths (mm). Values are the publishers' published figure widths; the
// generic set covers anything else. Height is always derived from the figure's aspect.
export const JOURNAL_PRESETS: { family: string; widths: WidthPreset[] }[] = [
  {
    family: "Generic",
    widths: [
      { id: "single", label: "Single column (90 mm)", mm: 90 },
      { id: "1.5", label: "1.5 column (140 mm)", mm: 140 },
      { id: "double", label: "Double column (190 mm)", mm: 190 },
    ],
  },
  {
    family: "Nature",
    widths: [
      // docs/journal_styleguide.md §2.9: 89 / 120–136 / 183 mm (final-submission page);
      // 180 mm is the Extended Data PAGE width (180 × 170 mm), not a main-figure width.
      { id: "nat-single", label: "Nature single (89 mm)", mm: 89 },
      { id: "nat-1.5", label: "Nature 1.5 column (120 mm)", mm: 120 },
      { id: "nat-double", label: "Nature double (183 mm)", mm: 183 },
      { id: "nat-page", label: "Nature Extended Data page (180 mm)", mm: 180 },
    ],
  },
  {
    family: "Science",
    widths: [
      // §3.9: the instructions pages give 5.7 / 12.1 / 18.4 cm (the 2022 figure guide's
      // 5.5 / 12 / 18.3 cm is older; owner ruling: the instructions).
      { id: "sci-1", label: "Science 1-column (57 mm)", mm: 57 },
      { id: "sci-2", label: "Science 2-column (121 mm)", mm: 121 },
      { id: "sci-3", label: "Science 3-column (184 mm)", mm: 184 },
    ],
  },
  {
    family: "Cell / PNAS", // §4.9: 85 / 114 / 174 mm
    widths: [
      { id: "cell-1", label: "1-column (85 mm)", mm: 85 },
      { id: "cell-1.5", label: "1.5-column (114 mm)", mm: 114 },
      { id: "cell-2", label: "2-column (174 mm)", mm: 174 },
    ],
  },
];

export const DPI_CHOICES = [300, 600, 1200];

export const mmToInch = (mm: number): number => mm / MM_PER_INCH;
export const inchToMm = (inch: number): number => inch * MM_PER_INCH;

/** Target pixel width for a physical width (mm) at a dpi (rounded, ≥1). */
export function mmToPx(mm: number, dpi: number): number {
  return Math.max(1, Math.round((mm / MM_PER_INCH) * dpi));
}

export interface ExportPlan {
  pxWidth: number;
  pxHeight: number;
  scale: number; // multiplier on the figure's design px (pxWidth / fig design width)
  mm: number;
  dpi: number;
}

/** Given a figure's design pixel size and a target physical width + dpi, compute the raster
 *  dimensions (aspect-preserved) and the scale factor the SVG rasterizer needs. */
export function planExport(figWidthPx: number, figHeightPx: number, mm: number, dpi: number): ExportPlan {
  const pxWidth = mmToPx(mm, dpi);
  const aspect = figWidthPx > 0 ? figHeightPx / figWidthPx : 1;
  const pxHeight = Math.max(1, Math.round(pxWidth * aspect));
  return { pxWidth, pxHeight, scale: figWidthPx > 0 ? pxWidth / figWidthPx : 1, mm, dpi };
}

/** Human-readable physical size of a raster, e.g. "90.0 × 67.5 mm @ 300 dpi". */
export function describeSize(pxWidth: number, pxHeight: number, dpi: number): string {
  const w = (pxWidth / dpi) * MM_PER_INCH;
  const h = (pxHeight / dpi) * MM_PER_INCH;
  return `${w.toFixed(1)} × ${h.toFixed(1)} mm @ ${dpi} dpi`;
}
