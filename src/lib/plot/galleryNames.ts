/** Filename similarity for the gallery's explicit "Similar names" filter.
 * Paths never contribute: sharing a directory is not a related plot name.
 * Numeric suffixes identify common per-subject/run variants. */
function words(name: string): Set<string> {
  const stem = name.replace(/^.*[\\/]/, "").replace(/\.(svg|png|mp4|mov)$/i, "");
  return new Set(stem.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase()
    .split(/[^\p{L}\p{N}]+/u).map(word => word.replace(/\d+$/u, ""))
    .filter(Boolean));
}

/** Zero means unrelated. Higher scores rank nearer filename variants first. */
export function galleryNameSimilarity(reference: string, candidate: string): number {
  const a = words(reference), b = words(candidate);
  if (!a.size || !b.size) return reference.toLowerCase() === candidate.toLowerCase() ? 1 : 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared++;
  const score = 2 * shared / (a.size + b.size);
  return shared >= Math.min(2, a.size, b.size) && score >= .5 ? score : 0;
}
