// The ONE Lezer markdown extension list of the Paper editor (markdown-setup.ts
// installs it; verify-paper-supsub.ts parses with exactly this list). Pandoc
// markdown, not CommonMark: GFM tables/strikethrough/task lists/autolinks plus
// Pandoc's superscript `^…^` and subscript `~…~` (2026-11-08).
import { GFM, Superscript, Subscript, type MarkdownExtension } from "@lezer/markdown";

export const PAPER_MARKDOWN_EXTENSIONS: MarkdownExtension[] = [GFM, Superscript, Subscript];
