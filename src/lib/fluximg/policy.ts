/** Placement policy for fluximg (pure; shared by both engines). */

/**
 * Stage 2 admits images onto slides (a deck refers to the project's bundle by id). What has not caught up yet is the
 * EXPORT of a deck holding one (stills and clips are a later package): the export payload warns with this text and
 * the exported slide draws the stand-in. The name is kept for that one remaining use.
 */
export const FLUXIMG_NOT_IN_SLIDES = "N-dimensional images (fluximg) are not in exported decks yet: an exported slide shows a placeholder in their place.";

/** True for a fluximg element (structural, so deck element unions without the kind can use it too). */
export const isFluximgElement = (el: { type: string }): boolean => el.type === "fluximg";

/** A Become from one image bundle to another is not supported yet (authoring refuses it; the compiler reports a track
 *  written by hand). */
export const FLUXIMG_BECOME_OTHER_IMAGE = "An image cannot become another image yet. Use Change on one image, or fade one out while the other appears.";
/** A consume Become INTO an image would rewrite the source as the image, which needs the bundle as a content half: refused,
 *  the hand-off (the default) works. */
export const FLUXIMG_NO_CONSUME = "An object cannot turn into an image in place. Use hand-off (the image crossfades in as the object moves).";
