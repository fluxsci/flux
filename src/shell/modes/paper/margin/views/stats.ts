// Shared manuscript text helpers for the Stats margin view. Word counts are NOT
// computed here any more: every count is THE shared counter's
// (src/lib/manuscript/wordCount.ts + wordBudget.ts), read through the pane's
// wordCounts object so the Stats view, the status bar and the outline agree.
// WS-4.1: boundary logic lives in frontmatter.ts (this re-export keeps the
// existing import sites working).

import { stripFrontMatter } from "../../frontmatter";

export { stripFrontMatter };
