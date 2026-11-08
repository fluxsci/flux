// Pack "display": figures and tables as a journal's copy editor reads them.
//
//   display.out-of-order    warn  a figure/table first cited before a lower-numbered one
//                                 (each figure family — main, Extended Data,
//                                 Supplementary — is ordered on its own)
//   display.uncited         warn  a figure embedded here, or a labeled table, never cited
//   display.uncited-panels  info  panels of a figure that is cited panel by panel, never named
//   display.empty-caption   warn  an embedded figure or labeled table with no caption
//
// FLAG ONLY. Figure numbers come from the Figure model (never from embed or
// citation order), so the fix for an out-of-order figure is the author's
// choice — renumber in Figure (Ctrl+R) or move the prose — not a text edit.
// Tables number by appearance, so for them the finding says which table is
// cited before an earlier one appears.

import type { CheckContext } from "./context";
import { displayMentions } from "./references";
import type { CheckFinding, CheckFigure } from "./types";

type Add = (f: Omit<CheckFinding, "pack" | "doc" | "line" | "col">) => void;

interface Mention {
  label: string;
  number: number;
  display: string;
  from: number;
  to: number;
}

/** Flag every item first cited before a LOWER-numbered item of its group. */
function orderFindings(items: Mention[], add: Add, noun: string): void {
  const byPos = [...items].sort((a, b) => a.from - b.from);
  // suffix minimum: the lowest number first-cited AFTER position i
  const suffixMin: (Mention | null)[] = new Array(byPos.length + 1).fill(null);
  for (let i = byPos.length - 1; i >= 0; i--) {
    const next = suffixMin[i + 1];
    suffixMin[i] = !next || byPos[i].number < next.number ? byPos[i] : next;
  }
  for (let i = 0; i < byPos.length; i++) {
    const later = suffixMin[i + 1];
    if (!later || later.number >= byPos[i].number) continue;
    add({
      ruleId: "display.out-of-order",
      severity: "warn",
      message:
        `${byPos[i].display} is first cited before ${later.display}; journals number ${noun} ` +
        `in the order they are first cited.`,
      from: byPos[i].from,
      to: byPos[i].to,
      excerpt: byPos[i].display,
    });
  }
}

export function displayPack(ctx: CheckContext, add: Add): void {
  const { figures: figMentions, tables: tblMentions } = displayMentions(ctx);

  // ---- order: each figure family separately, then tables --------------------
  const families = new Map<string, Mention[]>();
  for (const [label, m] of figMentions) {
    const f = ctx.figByLabel.get(label)!;
    const list = families.get(f.family) ?? [];
    list.push({ label, number: f.number, display: f.display, from: m.from, to: m.to });
    families.set(f.family, list);
  }
  for (const list of families.values()) orderFindings(list, add, "figures");
  orderFindings(
    [...tblMentions].map(([label, m]) => ({
      label,
      number: ctx.tableNumbers.get(label)!,
      display: `Table ${ctx.tableNumbers.get(label)}`,
      from: m.from,
      to: m.to,
    })),
    add,
    "tables",
  );

  // ---- embedded figures: cited? captioned? panels named? --------------------
  const seen = new Set<string>();
  for (const e of ctx.embeds) {
    const f: CheckFigure | undefined = ctx.figByLabel.get(e.label);
    if (!f || seen.has(f.label)) continue;
    seen.add(f.label);
    const mention = figMentions.get(f.label);
    if (!mention) {
      add({
        ruleId: "display.uncited",
        severity: "warn",
        message: `${f.display} is embedded but never cited in the text (write @${f.label} where you discuss it).`,
        from: e.from,
        to: e.to,
        excerpt: f.display,
      });
    } else if (!mention.whole && mention.panels.size && f.panels.length > 1) {
      const never = f.panels.filter((p) => !mention.panels.has(p));
      if (never.length) {
        add({
          ruleId: "display.uncited-panels",
          severity: "info",
          message: `${f.display}: panel${never.length === 1 ? "" : "s"} ${never.join(", ")} ${never.length === 1 ? "is" : "are"} never cited.`,
          from: mention.from,
          to: mention.to,
          excerpt: f.display,
        });
      }
    }
    if (!f.caption.trim()) {
      add({
        ruleId: "display.empty-caption",
        severity: "warn",
        message: `${f.display} has no caption; write its legend in Figure (Figure-Meta).`,
        from: e.from,
        to: e.to,
        excerpt: f.display,
      });
    }
  }

  // ---- labeled tables -------------------------------------------------------
  const tablesSeen = new Set<string>();
  for (const t of ctx.tables) {
    if (!t.label || tablesSeen.has(t.label)) continue;
    tablesSeen.add(t.label);
    const n = ctx.tableNumbers.get(t.label);
    const display = `Table ${n}`;
    if (!tblMentions.has(t.label)) {
      add({
        ruleId: "display.uncited",
        severity: "warn",
        message: `${display} is never cited in the text (write @${t.label} where you discuss it).`,
        from: t.from,
        to: t.to,
        excerpt: display,
      });
    }
    if (!(t.caption ?? "").trim()) {
      add({
        ruleId: "display.empty-caption",
        severity: "warn",
        message: `${display} has an empty caption.`,
        from: t.from,
        to: t.to,
        excerpt: display,
      });
    }
  }
}
