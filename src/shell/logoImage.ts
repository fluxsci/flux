// The Flux mark as ONE image (2026-11-20): the same 88 dots as Logomark.svelte (logoDots.ts), as an SVG data URL
// for an <img>. A surface that opens and closes all day (the property menu) shows the mark at 14 px; as 88 live
// <circle> nodes it was a third of that surface's elements, built, styled and torn down on every open. Built once,
// decoded once at first use, and thereafter painted from the document's image cache with the frame it appears in.
import { logoDots } from "./logoDots";

let url: string | null = null;
/** The mark's SVG as a data URL (memoised). */
export function logoImageUrl(): string {
  if (url) return url;
  const dots = logoDots().map((d) => `<circle cx="${d.x}" cy="${d.y}" r="${d.r}" fill="${d.fill}"/>`).join("");
  url = "data:image/svg+xml," + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${dots}</svg>`);
  // Decode ahead of the first showing, so that showing is already a cached image.
  if (typeof Image !== "undefined") {
    const img = new Image();
    img.src = url;
    void img.decode?.().catch(() => {});
  }
  return url;
}
