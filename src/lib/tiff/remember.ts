/**
 * Remembered answers for "files like this one": the list a project keeps in `project.json` (`tiffRules`) and the
 * machine keeps in FluxConfig (`presets/tiff-answers.json`). Pure; every engine reads and writes the lists through
 * these functions, so the app, the in-memory bridge and the CLI agree on what a stored rule is.
 *
 * A rule is matched by the probe's structural fingerprint (never a file name or a page count) and re-validated
 * against each new file (`infer.applyRule`), so "c = 2, t = the rest" fits 1632 and 3262 pages alike and a rule
 * that does not fit is simply not offered. One rule per fingerprint and scope: remembering again replaces it.
 */
import type { AnswerRule, DimsAnswer } from "./types";

export interface RememberedRule extends AnswerRule {
  /** What it says, for the list a person reads ("t × c 2 (c fastest), transposed, 0.25 µm pixels, 80 Hz"). */
  summary: string;
  /** When it was remembered (ISO date). */
  saved: string;
}

/** At most this many rules per list (a list is read on every probe). */
export const MAX_RULES = 200;
const FINGERPRINT_RE = /^[0-9a-f]{16}$/;

/** The rules of a list read from disk: anything that is not a well-formed rule is dropped, never thrown on. */
export function sanitizeRules(raw: unknown): RememberedRule[] {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === "object" && Array.isArray((raw as { rules?: unknown }).rules) ? (raw as { rules: unknown[] }).rules : [];
  const out: RememberedRule[] = [];
  const seen = new Set<string>();
  for (const r of list) {
    if (!r || typeof r !== "object") continue;
    const x = r as Partial<RememberedRule>;
    if (x.rule !== 1 || typeof x.fingerprint !== "string" || !FINGERPRINT_RE.test(x.fingerprint) || seen.has(x.fingerprint)) continue;
    const a = x.answer as DimsAnswer | undefined;
    if (!a || typeof a !== "object" || !Array.isArray(a.dims)) continue;
    seen.add(x.fingerprint);
    out.push({ rule: 1, fingerprint: x.fingerprint, answer: JSON.parse(JSON.stringify(a)), summary: typeof x.summary === "string" ? x.summary.slice(0, 300) : "", saved: typeof x.saved === "string" ? x.saved.slice(0, 40) : "" });
    if (out.length >= MAX_RULES) break;
  }
  return out;
}

/** The list with `rule` remembered (it replaces a rule of the same fingerprint; newest first). */
export function rememberRule(list: readonly RememberedRule[], rule: AnswerRule, summary: string, saved: string): RememberedRule[] {
  const next: RememberedRule = { rule: 1, fingerprint: rule.fingerprint, answer: JSON.parse(JSON.stringify(rule.answer)), summary, saved };
  return [next, ...list.filter((r) => r.fingerprint !== rule.fingerprint)].slice(0, MAX_RULES);
}

/** The list without the rule of `fingerprint`. */
export const forgetRule = (list: readonly RememberedRule[], fingerprint: string): RememberedRule[] => list.filter((r) => r.fingerprint !== fingerprint);

/** The rules a probe consults: the project's first (they are nearer the work), then the machine's. */
export const consultedRules = (project: readonly RememberedRule[], machine: readonly RememberedRule[]): AnswerRule[] =>
  [...project, ...machine.filter((m) => !project.some((p) => p.fingerprint === m.fingerprint))].map(({ rule, fingerprint, answer }) => ({ rule, fingerprint, answer }));

/** The text of the machine's file. */
export const encodeRuleFile = (rules: readonly RememberedRule[]): string => JSON.stringify({ schemaVersion: "0.1.0", rules }, null, 2) + "\n";
