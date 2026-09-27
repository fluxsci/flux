// The project-level Context/ layer: seed content for scaffold + heal.
// Pure module (no Svelte, no DOM, no Node) — shared by the GUI scaffold path and
// flux-core (twin-engine rule). The machine-level twin (the blank UserContext
// seeds) lives in electron/fluxPaths.cjs; the stock FluxContext docs ship in
// resources/flux-context/ (generated into electron/fluxContextDocs.gen.cjs).

/** Project-relative paths of the Context layer. One source of truth. */
export const CONTEXT_DIR = "Context";
export const CONTEXT_PATHS = {
  dir: CONTEXT_DIR,
  rules: `${CONTEXT_DIR}/RULES.md`,
  notebook: `${CONTEXT_DIR}/NOTEBOOK.md`,
  projectContext: `${CONTEXT_DIR}/ProjectContext.qmd`,
} as const;

/** The documents inside Context/ that the Paper editor surfaces, in display order. */
export const CONTEXT_DOC_RELS: readonly string[] = [
  CONTEXT_PATHS.projectContext,
  CONTEXT_PATHS.notebook,
  CONTEXT_PATHS.rules,
];

/** The Context tree for one project — used by scaffold AND the open-time heal
 *  (existing projects gain Context/ on first open; every entry is
 *  existence-guarded by the caller). */
export function contextScaffoldEntries(title: string): {
  dirs: string[];
  files: [string, string][];
} {
  return {
    dirs: [CONTEXT_PATHS.dir],
    files: [
      [CONTEXT_PATHS.projectContext, projectContextTemplate(title)],
      [CONTEXT_PATHS.notebook, notebookTemplate()],
      [CONTEXT_PATHS.rules, projectRulesTemplate()],
    ],
  };
}

export function projectContextTemplate(title: string): string {
  return `---
title: ${JSON.stringify(`Project context — ${title}`)}
---

<!-- What any agent working on this project must know. Every flux-connected agent reads this
     file AND every file it links (Markdown links, images, Quarto includes) — so rather than
     copying material in, link it: [analysis plan](../notes/plan.md), [data notes](/data/…/README.md).
     Keep it current; it is the single place to put "things the agent keeps missing". -->

## Background

## Goals or questions

*(If there is a clear mission, state it here. It is fine if there isn't one yet.)*

## Data and code

*(Where the data and analysis code live; environments.)*

## Key files and links

## Deliverables

*(Papers, talks, reports — if any.)*
`;
}

export function notebookTemplate(): string {
  return `# Project notebook

<!-- The project's running log. Entries are added when you ask an agent to record one
     (or when you write one yourself). Every flux-connected agent reads it. -->

## Log

*(Append-only, newest last: \`### YYYY-MM-DD HH:MM — title\`, For each entry, note which agent you are and where you are working from (cli/vsCode/desktop app/etc.). Use as much detail as is appropriate for the entry you are making, which could be anything from a very concise sentence or two to a highly-detailed multi-paragraph or multi-page entry)*
`;
}

export const LOG_HEADING = "## Log";

/** Local time, in the form documented by the notebook template. */
export function logStamp(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** The Log extends to EOF, including any H2 sections inside an entry. */
export function appendLogEntry(doc: string, entry: string): { text: string; createdSection: boolean } {
  const createdSection = !/^##[ \t]+Log[ \t]*$/m.test(doc);
  const base = doc.trimEnd();
  return {
    text: (base ? base + "\n\n" : "") + (createdSection ? `${LOG_HEADING}\n\n` : "") + entry.trimEnd() + "\n",
    createdSection,
  };
}

export interface LogEntry {
  stamp: string;
  title: string;
  /** Without the Markdown emphasis; null for entries without a byline. */
  byline: string | null;
  body: string;
  isCheckpoint: boolean;
}

/** Parse dated H2/H3 entries after ## Log. Ordinary headings belong to the
 *  entry body; fenced examples and HTML comments are never entry boundaries. */
export function parseLog(doc: string): LogEntry[] {
  const entries: LogEntry[] = [];
  let inLog = false, inComment = false;
  let fence: { char: string; length: number } | null = null;
  let current: { stamp: string; title: string; lines: string[] } | null = null;
  const finish = () => {
    if (!current) return;
    let body = current.lines.join("\n").trim();
    const bylineMatch = /^\*([^\n]+ · [^\n]+ · [^\n]+)\*[ \t]*(?:\n|$)/.exec(body);
    const byline = bylineMatch?.[1] ?? null;
    if (bylineMatch) body = body.slice(bylineMatch[0].length).trim();
    entries.push({ stamp: current.stamp, title: current.title, byline, body, isCheckpoint: /^Checkpoint:/i.test(current.title) });
  };
  for (const line of doc.split(/\r?\n/)) {
    const wasProtected = inComment || !!fence;
    if (!fence) {
      for (const token of line.matchAll(/<!--|-->/g)) {
        if (token[0] === "<!--") inComment = true;
        else inComment = false;
      }
    }
    if (!inComment) {
      const mark = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (mark && !wasProtected) fence = { char: mark[1][0], length: mark[1].length };
      else if (mark && fence && mark[1][0] === fence.char && mark[1].length >= fence.length && !mark[2].trim()) fence = null;
    }
    if (!wasProtected && !inComment && !fence) {
      if (!inLog && /^##[ \t]+Log[ \t]*$/.test(line)) { inLog = true; continue; }
      const match = inLog && /^#{2,3}[ \t]+(\d{4}-\d{2}-\d{2}(?:[ \t]+\d{2}:\d{2})?)[ \t]+—[ \t]*(.*?)[ \t]*$/.exec(line);
      if (match) {
        finish();
        current = { stamp: match[1], title: match[2], lines: [] };
        continue;
      }
    }
    current?.lines.push(line);
  }
  finish();
  return entries;
}

/** Entries back as readable Markdown (read-log's default output); titles-only
 *  is a one-line-per-entry index. */
export function renderLogEntries(entries: readonly LogEntry[], titlesOnly = false): string {
  if (!entries.length) return "The Log has no entries yet.";
  if (titlesOnly) return entries.map((e) => `- ${e.stamp} — ${e.title}${e.byline ? ` (${e.byline})` : ""}`).join("\n");
  return entries
    .map((e) => [`### ${e.stamp} — ${e.title}`, e.byline ? `*${e.byline}*` : "", e.body].filter(Boolean).join("\n\n"))
    .join("\n\n");
}

export function projectRulesTemplate(): string {
  return `# Project rules

<!-- Standing rules for THIS project only. Yours: agents follow them, and may propose
     additions when you state a standing preference. Rules for all projects live in
     <FluxConfig>/Context/UserContext/RULES.md. -->

- *(none yet)*
`;
}

/** Recognize the RETIRED generated per-project verb-guide AGENTS.md (its content
 *  moved to FluxContext/PROJECT-GUIDE.md). The heal path replaces exactly these
 *  with the stub; anything else in AGENTS.md is treated as user-authored and
 *  left alone. */
export function isRetiredAgentsGuide(text: string): boolean {
  const firstLine = text.slice(0, text.indexOf("\n") + 1 || undefined);
  return /^# .+ — agent guide\s*$/.test(firstLine.trim()) && text.includes("The file *is* the API");
}

/** A project pointer, never an automatic connection. */
export function agentsStubTemplate(): string {
  return `# This is a Flux project

This folder is managed by Flux, a scientific writing studio (documents, figures, slides,
references). To get fully up to speed on it, the user can flux-connect you:
\`/flux-connect <this folder>\` in Claude Code, \`$flux-connect <this folder>\` in Codex, or
\`flux-connect <this folder>\` in any shell. If the user asks for work on this project and you
are not connected, suggest it; do not connect unasked. Connecting loads a large amount of context.

Never hand-edit \`fig/**\` or \`.meta/**\`; use the Flux verbs (\`flux-connect\` prints how to run them).
`;
}

export function claudeStubTemplate(): string {
  return "@AGENTS.md\n";
}

export interface ContextHealResult {
  created: string[];
  skipped?: "not-a-project";
}
