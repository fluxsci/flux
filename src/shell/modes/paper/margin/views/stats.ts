// Shared manuscript text metrics — used by the Stats margin view and the
// persistent StatusBar so the two never disagree.
// WS-4.1: boundary logic lives in frontmatter.ts (this re-export keeps the
// existing import sites working).

import { stripFrontMatter } from "../../frontmatter";

export { stripFrontMatter };

export function wordCount(src: string): number {
  return (stripFrontMatter(src).match(/\S+/g) ?? []).length;
}
