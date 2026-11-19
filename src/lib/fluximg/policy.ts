/** Stage-1 placement policy for fluximg (pure; shared by both engines and every deck chokepoint). */

/** ARCHITECTURE decision 8: a fluximg cannot enter a Slide deck yet. Every deck chokepoint refuses with this one text. */
export const FLUXIMG_NOT_IN_SLIDES = "N-dimensional images (fluximg) cannot be placed on slides yet: keep them in a figure.";

/** True for a fluximg element (structural, so deck element unions without the kind can use it too). */
export const isFluximgElement = (el: { type: string }): boolean => el.type === "fluximg";
