// The ask pack (plan §11.4): what FluxChat's Ask hands a hosted agent with each
// quick question. ≤ 4k tokens: CONNECT's ask rules, FLUX.md's ask summary, a
// one-line-per-item digest of the project, and the rules. The runner gets it
// from `flux connect <root> --depth ask --json` (askPackPath), so the pack
// builder stays single-engine. Pure.

import { tokensOf, type ConnectFacts } from "./facts";

export const ASK_MAX_TOKENS = 4_000;
const RULES_MAX_TOKENS = 1_000;
const LIST_MAX = 30;

/** The text between `<!-- name -->` and `<!-- /name -->`, trimmed; null when absent. */
export function extractBlock(text: string, name: string): string | null {
  const open = `<!-- ${name} -->`, close = `<!-- /${name} -->`;
  const a = text.indexOf(open);
  const b = a < 0 ? -1 : text.indexOf(close, a + open.length);
  return a < 0 || b < 0 ? null : text.slice(a + open.length, b).trim();
}

/** The first prose paragraph of a document (skipping front matter, headings, comments), ≤ maxWords. */
export function firstParagraph(text: string, maxWords = 120): string {
  const body = text.replace(/^---\n[\s\S]*?\n---\n?/, "").replace(/<!--[\s\S]*?-->/g, "");
  for (const block of body.split(/\n\s*\n/)) {
    const t = block.trim();
    if (!t || /^#{1,6}\s/.test(t) || /^\*\(.*\)\*$/.test(t)) continue;
    const words = t.replace(/\s+/g, " ").split(" ");
    return words.length > maxWords ? words.slice(0, maxWords).join(" ") + " …" : words.join(" ");
  }
  return "";
}

function capTokens(text: string, max: number): string {
  if (tokensOf(text) <= max) return text;
  return text.slice(0, Math.floor(max * 3.6)).replace(/\s+\S*$/, "") + "\n[… capped]";
}

export interface AskBlocks {
  askRules: string | null;
  askSummary: string | null;
  taskRules?: string | null;
}

export function renderAskPack(facts: ConnectFacts, blocks: AskBlocks, mode: "ask" | "task" = "ask"): string {
  const p = facts.project;
  const L: string[] = [`# Flux · ${mode} pack${p ? ` · project "${p.title}"` : ""}`, ""];
  if (mode === "task" && !blocks.taskRules) throw new Error("CONNECT.md is missing its task-rules block");
  L.push((mode === "task" ? blocks.taskRules : blocks.askRules) ?? "You are answering a quick question inside the Flux app about what the user is looking at. Be read-only and concise, and cite what you looked at.", "");
  if (blocks.askSummary) L.push("## Flux", "", blocks.askSummary, "");
  const lists: string[] = [];
  if (p) {
    L.push("## This project", "", `"${p.title}" at \`${p.root}\`.`);
    const lead = p.projectContext.missing || p.projectContext.isTemplate ? "" : firstParagraph(p.projectContext.text);
    if (lead) L.push("", `ProjectContext: ${lead}`);
    const line = (label: string, items: string[]) => {
      if (!items.length) return;
      lists.push("", `${label}:`, ...items.slice(0, LIST_MAX).map((i) => `- ${i}`));
      if (items.length > LIST_MAX) lists.push(`- … ${items.length - LIST_MAX} more`);
    };
    line("Documents", p.docs.map((d) => `\`${d.path}\` "${d.title}" (${d.words.toLocaleString("en-US")} words)`));
    line("Figures", p.figures.map((f) => `${f.id} "${f.displayName}"${f.captionLead ? ` — ${f.captionLead}` : ""}`));
    line("Decks", p.decks.map((d) => `${d.id} "${d.title}" (${d.slides.length} slide${d.slides.length === 1 ? "" : "s"})`));
  }
  const rules = [
    ...facts.user.files.filter((f) => f.rel === "RULES.md").map((f) => ["Your rules (all projects)", f.text] as const),
    ...(p?.rules.text ? [["This project's rules", p.rules.text] as const] : []),
  ];
  const tail: string[] = [];
  for (const [title, text] of rules) {
    const body = text.replace(/<!--[\s\S]*?-->/g, "").replace(/^#\s.*$/m, "").trim();
    if (body && !/^-?\s*\*\(none yet\)\*$/.test(body)) tail.push("", `## ${title}`, "", capTokens(body, RULES_MAX_TOKENS / rules.length));
  }
  // Fit the budget: the lists shrink first (they are an index; the agent can ask Flux for more).
  let out = [...L, ...lists, ...tail].join("\n").trimEnd() + "\n";
  for (let keep = LIST_MAX; tokensOf(out) > ASK_MAX_TOKENS && keep > 3; keep = Math.floor(keep / 2)) {
    const trimmed: string[] = [];
    let n = 0;
    for (const l of lists) {
      if (l.startsWith("- ")) {
        if (n++ < keep) trimmed.push(l);
      } else {
        n = 0;
        trimmed.push(l);
      }
    }
    out = [...L, ...trimmed, ...tail].join("\n").trimEnd() + "\n";
  }
  return tokensOf(out) > ASK_MAX_TOKENS ? capTokens(out, ASK_MAX_TOKENS) + "\n" : out;
}
