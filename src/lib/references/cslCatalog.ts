// ---------------------------------------------------------------------------
// Citation style (CSL) choice for a document — pure planning (2026-11-08).
//
// A document's reference format for Pandoc-rendered exports is its front-matter
// `csl:` line (resolveCslIdentity's precedence: journal-style asset → front
// matter → _quarto.yml). The picker copies a CSL file into the project's
// `references/styles/` (where journal styles put theirs) and writes `csl:` as a
// path RELATIVE TO THE DOCUMENT, through the byte-minimal front-matter editor.
// The writer never restyles: this changes what the exports print, nothing in
// the editor (the owner's export-only rule; verify-writer-neutral).
//
// Pure: no DOM, no Node, no Vite. The GUI reads the shipped files and does IO.
// ---------------------------------------------------------------------------

/** Where project copies of CSL styles live (shared with journalAssets' plan). */
export const CSL_PROJECT_DIR = "references/styles";

export interface CslInfo {
  title: string;
  /** The Zotero style id URI (`<id>`), "" when absent. */
  id: string;
  /** `numeric`, `author-date`, `note`, `label`, `author` — "" when absent. */
  format: string;
}

const unxml = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&").trim();

/** Read a CSL file's `<info>`; null when the text is not a CSL style. */
export function cslInfo(xml: string): CslInfo | null {
  if (!/<style\b[^>]*xmlns="http:\/\/purl\.org\/net\/xbiblio\/csl"/.test(xml)) return null;
  const info = /<info>([\s\S]*?)<\/info>/.exec(xml)?.[1] ?? "";
  const title = /<title>([^<]*)<\/title>/.exec(info)?.[1];
  if (!title) return null;
  return {
    title: unxml(title),
    id: unxml(/<id>([^<]*)<\/id>/.exec(info)?.[1] ?? ""),
    format: /citation-format="([^"]+)"/.exec(info)?.[1] ?? "",
  };
}

/** A safe file name for a CSL copied into the project (`My Style (v2).csl` → `my-style-v2.csl`). */
export function cslFileName(name: string): string {
  const base = name.replace(/^.*[\\/]/, "").replace(/\.csl$/i, "");
  const slug = base.toLowerCase().normalize("NFKD").replace(/[^\w.-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
  return `${slug || "style"}.csl`;
}

/** Project-relative path of a CSL copy. */
export function cslProjectRel(fileName: string): string {
  return `${CSL_PROJECT_DIR}/${cslFileName(fileName)}`;
}

/** The `csl:` value for a document at `docRel` (project-relative, `/`-separated)
 *  pointing at the project-relative `targetRel`: relative to the document's folder,
 *  which is how Pandoc/Quarto and resolveCslIdentity resolve it. */
export function cslFrontMatterValue(docRel: string, targetRel: string): string {
  const from = docRel.split("/").slice(0, -1).filter(Boolean);
  const to = targetRel.split("/").filter(Boolean);
  let i = 0;
  while (i < from.length && i < to.length - 1 && from[i] === to[i]) i++;
  return [...from.slice(i).map(() => ".."), ...to.slice(i)].join("/");
}

/** The project-relative path a document's `csl:` value points at (null when it
 *  leaves the project or is absolute). Inverse of cslFrontMatterValue. */
export function cslTargetOf(docRel: string, value: string): string | null {
  if (!value || /^(?:[A-Za-z]:[\\/]|\/)/.test(value)) return null;
  const parts = docRel.split("/").slice(0, -1).filter(Boolean);
  for (const seg of value.replace(/\\/g, "/").split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join("/");
}
