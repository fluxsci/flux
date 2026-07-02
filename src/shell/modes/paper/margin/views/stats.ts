// Shared manuscript text metrics — used by the Stats margin view and the
// persistent StatusBar so the two never disagree.

export function stripFrontMatter(s: string): string {
  if (s.startsWith("---")) {
    const e = s.indexOf("\n---", 3);
    if (e >= 0) return s.slice(e + 4);
  }
  return s;
}

export function wordCount(src: string): number {
  return (stripFrontMatter(src).match(/\S+/g) ?? []).length;
}
