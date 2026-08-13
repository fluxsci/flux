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
  projectDir: `${CONTEXT_DIR}/Project`,
  mission: `${CONTEXT_DIR}/Project/MISSION.qmd`,
  transcriptsDir: `${CONTEXT_DIR}/Transcripts`,
  dispatchesDir: `${CONTEXT_DIR}/Dispatches`,
} as const;

/** The documents inside Context/ that the Paper editor surfaces, in display order. */
export const CONTEXT_DOC_RELS: readonly string[] = [
  CONTEXT_PATHS.mission,
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
    dirs: [
      CONTEXT_PATHS.dir,
      CONTEXT_PATHS.projectDir,
      CONTEXT_PATHS.transcriptsDir,
      CONTEXT_PATHS.dispatchesDir,
    ],
    files: [
      [CONTEXT_PATHS.mission, missionTemplate(title)],
      [CONTEXT_PATHS.notebook, notebookTemplate()],
      [CONTEXT_PATHS.rules, projectRulesTemplate()],
    ],
  };
}

export function missionTemplate(title: string): string {
  return `---
title: "Mission — ${title.replace(/"/g, '\\"')}"
---

<!-- The project charter: what we are doing and why. Co-owned by you and the
     principal agent — it drafts from your answers, you correct in place or via
     comments. The principal reads this at every session start. -->

## Question

What are we trying to learn?

## Data

What data exists, where it lives, and what shape it is in.

## Prior work

What has already been done (analyses, code, figures, drafts) before this project.

## Deliverable

What we are producing (paper, report, talk), for what venue/audience, and what
"done" looks like.

## Scope and non-goals

What is explicitly in and out of scope.
`;
}

export function notebookTemplate(): string {
  return `# Project notebook

<!-- The principal agent's memory of this project. Agent-owned: it writes; you read
     and leave comments. Body = current truth, edited in place. Session log =
     append-only history, newest last. -->

## State

*(Current state of the deliverable — kept true by the agent.)*

## Decisions

*(Decisions in force, each with its why.)*

## Tried

*(What has been attempted and what happened — including dead ends.)*

## Open questions

*(Unresolved items, for the human or for future work.)*

---

## Session log

*(Append-only, newest last: \`### YYYY-MM-DD HH:MM — title\` + a concise entry.)*
`;
}

/** The notebook section `flux note` appends under (notebookTemplate's part 2). */
export const SESSION_LOG_HEADING = "## Session log";

/** `YYYY-MM-DD HH:MM` (local time) — the session-log entry stamp the notebook
 *  template documents. */
export function sessionLogStamp(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Insert one entry at the END of the Session log section (newest last): before
 *  the next H1/H2 heading after it, or at EOF when the log is the final section
 *  (the template's shape). H3 entries never terminate the section. A notebook
 *  restructured without the heading gets the section appended — additive, never
 *  destructive. Pure string logic so the locked writer (flux-core addNote) and
 *  any future GUI affordance share one definition. */
export function appendSessionLogEntry(
  doc: string,
  entry: string,
): { text: string; createdSection: boolean } {
  const block = entry.replace(/\s+$/, "") + "\n";
  const m = /^##[ \t]+Session log[ \t]*$/im.exec(doc);
  if (!m) {
    const base = doc.replace(/\s+$/, "");
    return {
      text: (base ? base + "\n\n" : "") + `${SESSION_LOG_HEADING}\n\n` + block,
      createdSection: true,
    };
  }
  const after = m.index + m[0].length;
  const next = /^#{1,2}[ \t]/m.exec(doc.slice(after));
  const at = next ? after + next.index : doc.length;
  const head = doc.slice(0, at).replace(/\s+$/, "");
  const tail = doc.slice(at);
  return { text: head + "\n\n" + block + (tail ? "\n" + tail : ""), createdSection: false };
}

export function projectRulesTemplate(): string {
  return `# Project rules

<!-- Standing rules for THIS project only. Co-owned: you write rules here, and the
     principal agent promotes your recurring feedback into rules here. Global rules
     (all projects) live in <FluxConfig>/Context/UserContext/RULES.md. -->

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

/** The scaffolded AGENTS.md is a stub pointing at the two Context folders. */
export function agentsStubTemplate(): string {
  return `# Agents: read the Context folders

This is a Flux project. All agent context, memory, and instructions live in two places:

1. **Machine level:** \`<FluxConfig>/Context\` (run \`flux config\` for the absolute
   path — the \`contextPath\` field) — who the user is (\`UserContext/\`) and how to
   work in Flux (\`FluxContext/\` — start with its \`README.md\`; the full
   inside-a-project reference is \`FluxContext/PROJECT-GUIDE.md\`).
2. **Project level:** \`Context/\` in this folder — the mission
   (\`Project/MISSION.qmd\`), the running notebook (\`NOTEBOOK.md\`), and this
   project's rules (\`RULES.md\`).

If you are the **principal** (the user's standing collaborator), follow
\`FluxContext/PRINCIPAL.md\`. If you are a **dispatched worker**, your brief is your
contract — see \`FluxContext/WORKERS.md\`.
`;
}
