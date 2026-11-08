// Pack "comments": margin comment threads still open.
//
//   comments.open  warn  N comment threads are still open (one finding; it
//                        jumps to the first, and clears when every thread is
//                        resolved — a count that can reach zero)
//
// The threads come from the document's comments sidecar (both engines read
// the same file); `commentInputs` resolves each thread's place the one way
// both engines share: the stored offsets when they still hold the quote,
// else the quote's first occurrence, else no place.

import type { CheckContext } from "./context";
import type { CheckComment, CheckFinding } from "./types";

type Add = (f: Omit<CheckFinding, "pack" | "doc" | "line" | "col">) => void;

export function commentInputs(
  threads: readonly { id: string; resolved?: boolean; anchor?: { start?: number; end?: number; quote?: string } }[],
  text: string,
): CheckComment[] {
  return threads.map((t) => {
    const quote = t.anchor?.quote ?? "";
    const start = t.anchor?.start ?? -1;
    const end = t.anchor?.end ?? -1;
    let from: number | undefined, to: number | undefined;
    if (quote && start >= 0 && text.slice(start, end) === quote) [from, to] = [start, end];
    else if (quote) {
      const i = text.indexOf(quote);
      if (i >= 0) [from, to] = [i, i + quote.length];
    }
    return { id: t.id, resolved: !!t.resolved, quote, ...(from != null ? { from, to } : {}) };
  });
}

export function commentsPack(ctx: CheckContext, add: Add): void {
  const open = (ctx.input.comments ?? []).filter((c) => !c.resolved);
  if (!open.length) return;
  const placed = open.filter((c) => c.from != null).sort((a, b) => a.from! - b.from!);
  const first = placed[0];
  add({
    ruleId: "comments.open",
    severity: "warn",
    message:
      open.length === 1
        ? "1 comment thread is still open."
        : `${open.length} comment threads are still open.`,
    ...(first ? { from: first.from, to: first.to, excerpt: first.quote.length > 60 ? first.quote.slice(0, 57) + "…" : first.quote } : {}),
  });
}
