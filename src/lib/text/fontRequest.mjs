// Flux — font REQUEST identity (oct2 W3 §3.2). Plain ESM with no Node or DOM
// APIs: Electron main, flux-core and the renderer all name a font request with
// this ONE key, so the IPC cache, the GUI provider and the export payload agree.

/** Split a CSS font-family stack into family names (quotes removed). */
export function parseFamilyStack(stack) {
  const out = [];
  for (const raw of String(stack ?? "").split(",")) {
    const name = raw.trim().replace(/^(["'])(.*)\1$/, "$2").trim();
    if (name) out.push(name);
  }
  return out;
}

/** The canonical request key: the family stack as authored (whitespace-normalized),
 *  the weight on the CSS 100 grid, and normal|italic. Shared by the renderer cache,
 *  the IPC and the export payload, so all three agree on what "this font" is. */
export function fontRequestKey(req) {
  const fam = parseFamilyStack(req.family).join(", ");
  const weight = Math.min(900, Math.max(100, Math.round((Number(req.weight) || 400) / 100) * 100));
  const style = req.style === "italic" || req.style === "oblique" ? "italic" : "normal";
  return `${fam}|${weight}|${style}`;
}
