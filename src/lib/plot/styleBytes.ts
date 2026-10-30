// CSSOM rewrites declaration spelling/spacing even when restoring the same
// values. Restore the original bytes only when all declarations agree, so
// unrelated writers' properties survive (slides also use these writers).
export interface StyleBytes { raw: string | null; css: string; fields: readonly (readonly [string, string, string])[] }
/** Captures taken (a structural budget: per-frame hosts must take none). */
export const styleByteCaptures = { n: 0 };
export function captureStyleBytes(node: Element): StyleBytes {
  styleByteCaptures.n++;
  const st = (node as SVGElement).style;
  return { raw: node.getAttribute('style'), css: st.cssText,
    fields: Array.from(st).map(name => [name, st.getPropertyValue(name), st.getPropertyPriority?.(name) ?? ''] as const) };
}
export function restoreStyleBytes(node: Element, saved: StyleBytes): void {
  const st = (node as SVGElement).style;
  if (st.cssText !== saved.css && (st.length !== saved.fields.length || saved.fields.some(([name, value, priority]) =>
    st.getPropertyValue(name) !== value || (st.getPropertyPriority?.(name) ?? '') !== priority))) return;
  if (saved.raw === null) node.removeAttribute('style');
  else node.setAttribute('style', saved.raw);
}
