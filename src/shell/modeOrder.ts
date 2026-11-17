// The five modes in title-bar order. This one list drives the strip (TitleBar), the
// Ctrl+1…Ctrl+5 chords (Workspace) and the order the gates and docs are checked against
// (verify-mode-icons), so the order changes in exactly one place.
import type { ModeId } from "./shellStore";

export const MODE_ORDER: readonly ModeId[] = ["figure", "slide", "paper", "library", "reader"];

export const MODE_LABEL: Record<ModeId, string> = {
  figure: "Figure",
  slide: "Slide",
  paper: "Paper",
  library: "Library",
  reader: "Reader",
};
