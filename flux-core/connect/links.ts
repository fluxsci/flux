// Links in ProjectContext: the owner's rule is "ProjectContext and everything
// it links". Pure: extraction only. collect.ts resolves and reads them.

export type LinkVia = "link" | "include" | "ref" | "code";

/** Every file-naming construct, with how it was written, in order, de-duplicated by target. */
export function extractLinkRefs(text: string): { target: string; via: LinkVia }[] {
  const out: { target: string; via: LinkVia }[] = [];
  const add = (raw: string, via: LinkVia) => {
    const t = raw.trim().replace(/^<|>$/g, "");
    if (!t || /^(https?|mailto|data|ftp):/i.test(t) || t.startsWith("#")) return;
    const clean = t.split("#")[0].split("?")[0];
    if (clean && !out.some((o) => o.target === clean)) out.push({ target: clean, via });
  };
  const body = stripCode(text);
  // Markdown links and images: [text](target "title") / ![alt](target)
  for (const m of body.matchAll(/!?\[[^\]]*\]\(\s*(<[^>]+>|[^)\s]+)(?:\s+"[^"]*")?\s*\)/g)) add(m[1], "link");
  // Quarto includes: {{< include path >}}
  for (const m of body.matchAll(/\{\{<\s*include\s+([^\s>]+)\s*>\}\}/g)) add(m[1], "include");
  // Reference-style definitions: [id]: target
  for (const m of body.matchAll(/^\s*\[[^\]]+\]:\s*(\S+)/gm)) add(m[1], "ref");
  // Bare paths in backticks that look like files (`../notes/plan.md`, `/data/x/README.md`)
  for (const m of text.matchAll(/`([^`\s]+\.[A-Za-z0-9]{1,6})`/g)) {
    if (/[/\\]/.test(m[1]) || /\.(qmd|md|markdown|txt|py|r|ipynb|csv|tsv|json|yaml|yml|toml|pdf|png|jpe?g|svg)$/i.test(m[1])) add(m[1], "code");
  }
  return out;
}

/** Quarto/Markdown constructs that name a file, in order of appearance, de-duplicated. */
export function extractLinks(text: string): string[] {
  return extractLinkRefs(text).map((r) => r.target);
}

/** Remove fenced code blocks (their contents are not links). */
function stripCode(text: string): string {
  return text.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, "");
}

const TEXT_EXT = /\.(qmd|md|markdown|txt|rst|py|r|jl|m|sh|toml|ya?ml|json|csv|tsv|tex|bib|ipynb)$/i;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg)$/i;

export function linkKind(path: string): "text" | "image" | "other" {
  if (IMAGE_EXT.test(path)) return "image";
  if (TEXT_EXT.test(path)) return "text";
  return "other";
}
