// Annotations → Markdown (3.2). A scientist's highlights + margin notes live in
// items/<key>/annotations.json and were trapped in the reader; this pure formatter turns
// them into a clean Markdown digest — a citekey header, page-grouped blockquotes with the
// note and highlight colour — for pasting into notes apps, lab notebooks, or a manuscript.
// Shared by the reader/library "Export notes…" action, the CLI, and the MCP tool.
import type { Annotation } from "./annotations";

export interface AnnotationMdMeta {
  title?: string;
  authors?: string[];
  year?: string;
  doi?: string;
  exportedAt?: string; // caller-supplied (kept out of here so the formatter stays pure/testable)
}

const COLOR_LABEL: Record<string, string> = {
  yellow: "🟡 yellow",
  green: "🟢 green",
  blue: "🔵 blue",
  pink: "🩷 pink",
  orange: "🟠 orange",
};

const clean = (s: string): string => s.replace(/\s+/g, " ").trim();
const asBlockquote = (s: string): string =>
  clean(s)
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");

/** Render one paper's annotations to Markdown. Sorted by page, then time. Empty note +
 *  empty list are handled gracefully (a header + "No highlights yet."). */
export function annotationsToMarkdown(citekey: string, annotations: Annotation[], meta: AnnotationMdMeta = {}): string {
  const out: string[] = [];
  out.push(`# ${meta.title ? meta.title : `@${citekey}`}`);
  const sub: string[] = [];
  if (meta.authors?.length) sub.push(meta.authors.join(", "));
  if (meta.year) sub.push(`(${meta.year})`);
  if (sub.length) out.push(sub.join(" "));
  const links: string[] = [`\`@${citekey}\``];
  if (meta.doi) links.push(`https://doi.org/${meta.doi}`);
  out.push(links.join(" · "));

  const sorted = [...annotations].sort((a, b) => a.page - b.page || a.createdAt.localeCompare(b.createdAt));
  const pages = new Set(sorted.map((a) => a.page));
  const count = sorted.length;
  const summary = `*${count} highlight${count === 1 ? "" : "s"} across ${pages.size} page${pages.size === 1 ? "" : "s"}${meta.exportedAt ? ` · exported ${meta.exportedAt}` : ""}*`;
  out.push("");
  out.push(summary);

  if (!count) {
    out.push("");
    out.push("No highlights yet.");
    return out.join("\n") + "\n";
  }

  let curPage = -1;
  for (const a of sorted) {
    if (a.page !== curPage) {
      curPage = a.page;
      out.push("");
      out.push(`## Page ${a.page}`);
    }
    out.push("");
    out.push(asBlockquote(a.anchor.quote || ""));
    if (a.note && a.note.trim()) {
      out.push("");
      out.push(clean(a.note));
    }
    const caption: string[] = [COLOR_LABEL[a.color] ?? a.color];
    if (a.tags?.length) caption.push(a.tags.map((t) => `#${t}`).join(" "));
    out.push("");
    out.push(`*${caption.join(" · ")}*`);
  }
  return out.join("\n") + "\n";
}
