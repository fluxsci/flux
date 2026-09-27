/** Shared no-trust math policy. Source is preserved verbatim on every failure. */
export const MATH_OPTIONS = Object.freeze({ throwOnError: false, trust: false, strict: "ignore", output: "html", maxExpand: 128, maxSize: 100 });
export const MAX_MATH_SOURCE = 16_384;
export const MAX_MATH_HTML = 2 * 1024 * 1024;
const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
export function mathFallback(tex: string, reason: string): string {
  return `<span class="katex-error" title="${esc(reason)}">${esc(tex)}</span>`;
}
export function safeMathRender(renderer: { renderToString(tex: string, opts: any): string }, tex: string, display: boolean): string {
  if (tex.length > MAX_MATH_SOURCE) return mathFallback(tex, `Equation exceeds ${MAX_MATH_SOURCE} source characters`);
  try {
    const html = renderer.renderToString(tex, { ...MATH_OPTIONS, displayMode: display });
    return html.length <= MAX_MATH_HTML ? html : mathFallback(tex, "Equation exceeds the rendered size limit");
  } catch (error) { return mathFallback(tex, `Math rendering failed: ${error instanceof Error ? error.message : String(error)}`); }
}
