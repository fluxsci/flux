// The single source of truth for highlight colour rendering (LR-11: these maps were
// previously duplicated in ReaderMode + PdfView with drifting alphas). Two contexts:
//
//  - HL_PAGE: painted ON the PDF page with `mix-blend-mode: multiply`, so use light,
//    opaque marker pastels — over the white page they read as the colour itself and
//    the black canvas text underneath stays crisp (white × c = c, black × c = black).
//  - HL_SWATCH: solid dots/swatches on the app's dark chrome (sidebar, colour menu),
//    where the multiply pastels would glare — mid-strength translucent tones instead.
//
// Keyed by ANNOTATION_COLORS (annotations.ts). Add a colour there + here, nowhere else.
import { ANNOTATION_COLORS } from "./annotations";

export const HL_PAGE: Record<(typeof ANNOTATION_COLORS)[number], string> = {
  yellow: "#ffe066",
  green: "#b7e6b0",
  blue: "#b5d3f2",
  pink: "#f7bfd9",
  orange: "#ffcf94",
};

export const HL_SWATCH: Record<(typeof ANNOTATION_COLORS)[number], string> = {
  yellow: "rgba(255, 221, 51, 0.75)",
  green: "rgba(94, 189, 108, 0.7)",
  blue: "rgba(67, 133, 190, 0.65)",
  pink: "rgba(225, 90, 140, 0.65)",
  orange: "rgba(218, 160, 23, 0.7)",
};

export const hlPage = (c: string): string => HL_PAGE[c as keyof typeof HL_PAGE] ?? HL_PAGE.yellow;
export const hlSwatch = (c: string): string => HL_SWATCH[c as keyof typeof HL_SWATCH] ?? HL_SWATCH.yellow;
