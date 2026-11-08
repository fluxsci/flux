// Manuscript Check — the platform. `checkManuscript` builds one shared scan
// (context.ts) and runs the selected rule packs over it; the Paper margin pane
// (Alt+K) and flux-core's `check_manuscript` verb (`flux check`) both call
// this and nothing else, so the GUI and the CLI can never disagree
// (verify-manuscript-check.ts pins CLI == pure call).
//
// NOT a typing-path operation (guide §6): callers run it on summon, on the
// Paper idle mirror (`latestIdle`, 150 ms after typing settles) and on
// "Check now" — never inside a transaction.
//
// Pure: no Svelte, no DOM, no Node.

import { buildContext, type CheckContext } from "./context";
import { referencesPack } from "./references";
import { displayPack } from "./display";
import { placeholdersPack } from "./placeholders";
import { abbreviationsPack } from "./abbreviations";
import { consistencyPack } from "./consistency";
import { commentsPack } from "./comments";
import {
  CHECK_PACKS,
  type CheckBibEntry,
  type CheckFinding,
  type CheckInput,
  type CheckPackId,
  type CheckResult,
  type CheckSeverity,
} from "./types";

export * from "./types";
export { commentInputs } from "./comments";

type PackRun = (ctx: CheckContext, add: (f: Omit<CheckFinding, "pack" | "doc" | "line" | "col">) => void) => void;

const RUNNERS: Record<CheckPackId, PackRun> = {
  references: referencesPack,
  display: displayPack,
  placeholders: placeholdersPack,
  abbreviations: abbreviationsPack,
  consistency: consistencyPack,
  comments: commentsPack,
};

const SEVERITY_RANK: Record<CheckSeverity, number> = { error: 0, warn: 1, info: 2 };

/** Pack order, then document position, then rule — deterministic, so the
 *  pane, the CLI and the parity gate all list findings identically. */
export function sortCheckFindings(f: readonly CheckFinding[]): CheckFinding[] {
  const packRank = (p: CheckPackId) => CHECK_PACKS.indexOf(p);
  return [...f].sort(
    (a, b) =>
      packRank(a.pack) - packRank(b.pack) ||
      (a.from ?? Number.MAX_SAFE_INTEGER) - (b.from ?? Number.MAX_SAFE_INTEGER) ||
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      a.ruleId.localeCompare(b.ruleId) ||
      a.message.localeCompare(b.message),
  );
}

export function parsePacks(spec: string | readonly string[] | undefined): CheckPackId[] | undefined {
  if (spec == null) return undefined;
  const list = (typeof spec === "string" ? spec.split(",") : [...spec]).map((s) => s.trim()).filter(Boolean);
  if (!list.length) return undefined;
  const bad = list.filter((p) => !(CHECK_PACKS as readonly string[]).includes(p));
  if (bad.length) throw new Error(`Unknown check pack ${bad.join(", ")}; packs are ${CHECK_PACKS.join(", ")}.`);
  return list as CheckPackId[];
}

export function checkManuscript(input: CheckInput): CheckResult {
  const ctx = buildContext(input);
  const findings: CheckFinding[] = [];
  const packs = input.packs?.length ? CHECK_PACKS.filter((p) => input.packs!.includes(p)) : CHECK_PACKS;
  for (const pack of packs) {
    RUNNERS[pack](ctx, (f) => {
      const at = f.from != null ? ctx.pos(f.from) : null;
      findings.push({ ...f, pack, doc: input.doc, ...(at ? { line: at.line, col: at.col } : {}) });
    });
  }
  const sorted = sortCheckFindings(findings);
  const counts: Record<CheckSeverity, number> = { error: 0, warn: 0, info: 0 };
  for (const f of sorted) counts[f.severity]++;
  return { doc: input.doc, findings: sorted, counts };
}

/** RefEntry-shaped bibliography → the checks' projection. The entry TYPE is
 *  read from the raw BibTeX when present (lightEntry keeps it). */
export function checkBibEntries(
  entries: readonly { key: string; title?: string; authors?: string[]; year?: string; container?: string; doi?: string; raw?: string; type?: string }[],
): CheckBibEntry[] {
  return entries
    .filter((e) => e.key)
    .map((e) => ({
      key: e.key,
      type: (e.type ?? /^\s*@([A-Za-z]+)/.exec(e.raw ?? "")?.[1] ?? "").toLowerCase(),
      title: e.title ?? "",
      authors: e.authors ?? [],
      year: e.year ?? "",
      ...(e.container ? { container: e.container } : {}),
      ...(e.doi ? { doi: e.doi } : {}),
    }));
}

/** Apply a fix's edits to a string — the reference semantics both engines'
 *  appliers follow (GUI: one CodeMirror transaction). Returns null when any
 *  range no longer holds its `expect` text (the document moved on). */
export function applyCheckFix(text: string, edits: readonly { from: number; to: number; insert: string; expect: string }[]): string | null {
  for (const e of edits) if (text.slice(e.from, e.to) !== e.expect) return null;
  let out = text;
  for (const e of [...edits].sort((a, b) => b.from - a.from)) out = out.slice(0, e.from) + e.insert + out.slice(e.to);
  return out;
}

/** One line per finding — the CLI's human output. */
export function formatCheckReport(r: CheckResult): string {
  const lines = r.findings.map((f) => {
    const where = `${r.doc || "(document)"}${f.line ? `:${f.line}:${f.col}` : ""}`;
    return `${where}  ${f.severity.padEnd(5)}  ${f.ruleId}  ${f.message}${f.fix ? `  [fix: ${f.fix.label}]` : ""}`;
  });
  const { error, warn, info } = r.counts;
  lines.push(
    r.findings.length
      ? `${error} error${error === 1 ? "" : "s"}, ${warn} warning${warn === 1 ? "" : "s"}, ${info} note${info === 1 ? "" : "s"}`
      : "No problems found.",
  );
  return lines.join("\n");
}
