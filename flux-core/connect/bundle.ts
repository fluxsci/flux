// The bundle: every must-read text of a pack in ONE sectioned markdown file, so an
// agent reads it in a few chunked reads instead of dozens. Sources are wrapped
// in dynamic fences (never broken by content that itself contains fences); long
// lines are wrapped for reading (Claude Code's Read tool truncates lines over
// 2,000 characters, and Quarto paragraphs are often one line); every section
// ends with its proof code. Pure.

import { sectionCodeLine } from "./codes";
import { PARTIAL_WORDS, type InclusionPlan } from "./budget";
import { tokensOf, type ConnectFacts, type DocFact, type OutlineEntry, type ProjectFacts } from "./facts";

export const WRAP_AT = 400;

export interface BundleSection {
  id: string;
  title: string;
  startLine: number;
  endLine: number;
}

export interface RenderedBundle {
  text: string;
  sections: BundleSection[];
  tokens: number;
  lines: number;
}

/** A fence longer than any backtick run inside the content (minimum four). */
export function fenceFor(content: string): string {
  let longest = 0;
  for (const m of content.matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
  return "`".repeat(Math.max(4, longest + 1));
}

/** Wrap lines longer than `at` at word boundaries (a reading copy; sources are untouched). */
export function wrapForReading(text: string, at = WRAP_AT): string {
  return text
    .split("\n")
    .map((line) => {
      if (line.length <= at) return line;
      const out: string[] = [];
      let rest = line;
      while (rest.length > at) {
        let cut = rest.lastIndexOf(" ", at);
        if (cut < at / 2) cut = at; // one enormous token: hard cut
        out.push(rest.slice(0, cut));
        rest = rest.slice(cut).replace(/^ /, "");
      }
      out.push(rest);
      return out.join("\n");
    })
    .join("\n");
}

function fenced(content: string, lang = ""): string {
  const body = wrapForReading(content.replace(/\s+$/, ""));
  const f = fenceFor(body);
  return `${f}${lang}\n${body}\n${f}`;
}

function outlineLines(outline: readonly OutlineEntry[], limit = 40): string[] {
  const out = outline.slice(0, limit).map((o) => `${"  ".repeat(Math.max(0, o.level - 1))}- ${o.text} (line ${o.line})`);
  if (outline.length > limit) out.push(`- … ${outline.length - limit} more headings`);
  return out;
}

function opening(text: string, words = PARTIAL_WORDS): string {
  const w = text.split(/(\s+)/);
  let n = 0, i = 0;
  for (; i < w.length && n < words; i++) if (/\S/.test(w[i])) n++;
  return w.slice(0, i).join("") + (i < w.length ? "\n\n[…]" : "");
}

function langOf(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return ({ qmd: "markdown", md: "markdown", py: "python", r: "r", json: "json", yml: "yaml", yaml: "yaml", toml: "toml", sh: "bash", tex: "latex" } as Record<string, string>)[ext] ?? "";
}

function mapSection(p: ProjectFacts, plan: InclusionPlan): string[] {
  const L: string[] = [];
  L.push(`Project **${p.title}** at \`${p.root}\`${p.authors.length ? ` · authors: ${p.authors.join(", ")}` : ""}.`);
  if (p.defaultDoc) L.push(`Default document for export: \`${p.defaultDoc}\`.`);
  L.push("", `### Documents (${p.docs.length})`, "");
  const modes = new Map(plan.docs.map((d) => [d.path, d.mode]));
  for (const d of p.docs) {
    const m = modes.get(d.path);
    const note = m === "full" ? " — in full in §I" : m === undefined ? " — linked from ProjectContext, in §D" : "";
    L.push(`- \`${d.path}\` — "${d.title}" · ${d.words.toLocaleString("en-US")} words · ${d.lines} lines${d.hasComments ? " · has comments" : ""}${note}`);
    for (const o of outlineLines(d.outline.filter((x) => x.level <= 2), 12)) L.push(`  ${o}`);
  }
  L.push("", `### Figures (${p.figures.length})`, "");
  for (const f of p.figures) {
    const panels = f.panels.filter((x) => x.source).map((x) => `${x.label ? x.label + ": " : ""}\`${x.source}\`${x.recipe ? ` (recipe \`${x.recipe}\`)` : ""}`);
    L.push(`- **${f.id}** "${f.displayName}" · canvas ${f.canvasId}${f.stale ? " · ⚠ stale vs plots/ (run sync-figure)" : ""} — ${f.captionLead || "(no caption yet)"}`);
    if (panels.length) L.push(`  - panels → ${panels.join(" · ")}`);
  }
  if (p.canvases.length > 1) {
    L.push("", "### Canvases", "");
    for (const c of p.canvases) L.push(`- ${c.id} "${c.name}": ${c.figureIds.join(", ") || "(empty)"}`);
  }
  L.push("", `### Decks (${p.decks.length})`, "");
  for (const d of p.decks) L.push(`- **${d.id}** "${d.title}" — ${d.slides.map((s, i) => `${i + 1}. ${s.name} (${s.beats} step${s.beats === 1 ? "" : "s"})`).join(" · ") || "(no slides)"}`);
  L.push("", "### Plots and references", "");
  L.push(`- \`plots/\`: ${p.plots.count} plot${p.plots.count === 1 ? "" : "s"}${p.plots.dissections ? ` · ${p.plots.dissections} with dissections (\`plots/_dissections/\`)` : ""}${p.plots.lighttable.length ? ` · lighttable collections: ${p.plots.lighttable.join(", ")}` : ""}`);
  L.push(`- \`references/library.bib\`: ${p.referencesCount} cited reference${p.referencesCount === 1 ? "" : "s"}`);
  if (p.workspace) {
    L.push("", "### Analysis workspace (the folder around the project)", "");
    L.push(`\`${p.workspace.dir}\` — ${p.workspace.markers.join(", ") || "no markers"}`);
    if (p.workspace.entries.length) L.push(`Top level: ${p.workspace.entries.map((e) => `\`${e}\``).join(", ")}`);
  }
  if (p.git) L.push("", `Git: branch \`${p.git.branch}\`, ${p.git.dirty} uncommitted change${p.git.dirty === 1 ? "" : "s"}.`);
  return L;
}

function docBlock(path: string, text: string, sha: string, lines: number): string[] {
  return [`### \`${path}\` · ${lines} lines · sha ${sha.slice(0, 8)} (wrapped for reading)`, "", fenced(text, langOf(path)), ""];
}

function partialDocBlock(d: Pick<DocFact, "path" | "outline" | "sha" | "lines">, text: string | undefined): string[] {
  const L = [`### \`${d.path}\` · ${d.lines} lines · sha ${d.sha.slice(0, 8)} — OUTLINE + OPENING ONLY (read the file when relevant)`, ""];
  L.push(...outlineLines(d.outline), "");
  if (text) L.push(fenced(opening(text), langOf(d.path)), "");
  return L;
}

export function renderBundle(facts: ConnectFacts, plan: InclusionPlan): RenderedBundle {
  const p = facts.project;
  const sections: { id: string; title: string; body: string[] }[] = [];
  const add = (id: string, title: string, body: string[]) => sections.push({ id, title, body });

  // §A — the user
  {
    const L: string[] = [`Your context lives in \`${facts.user.dir}\` (yours; agents read it, and propose edits only).`, ""];
    for (const f of facts.user.files) L.push(...docBlock(`UserContext/${f.rel}`, f.text, f.sha, f.text.split("\n").length));
    if (facts.user.images.length) {
      L.push("Reference images (view them BEFORE making figures or plots):", "");
      for (const img of facts.user.images) L.push(`- \`${img.abs}\``);
      L.push("");
    }
    if (facts.user.skills.length) {
      L.push("Your own skills (published to your agents: invoke as /<name> in Claude Code, $<name> in Codex, or read the file):", "");
      for (const s of facts.user.skills) L.push(`- **${s.name}** — ${s.description} (\`${s.path}\`)`);
      L.push("");
    }
    add("A", "You", L);
  }

  // §B — FluxLib: what, where, how (never a paper list)
  {
    const lib = facts.machine.fluxLib;
    add("B", "FluxLib (the machine-wide reference library)", [
      `FluxLib is at \`${lib.path}\`: ${lib.entries.toLocaleString("en-US")} references, ${lib.pdfs.toLocaleString("en-US")} with stored PDFs. It is the user's library across all projects; a project's \`references/library.bib\` is the subset it cites.`,
      "",
      "- Search metadata: `flux search <query>` (MCP `search_references`); search full text of stored PDFs: `flux search-text <query>` (MCP `search_fulltext`).",
      "- Add: `flux cite-doi <doi>` (also cites it in this project), `flux lib-add <file.bib>`, `flux zotero-sync`.",
      "- PDFs: `flux fetch-pdfs`, `flux ingest-pdf <file> --key K`; the drop inbox `pdfs_to_assign/` + `flux assign-pdfs` (refuses rather than misassigns).",
      "- Highlights and notes from the Reader: `flux highlights`; what the user is reading right now: MCP `get_reading_context`.",
      "- Details: LIBRARY.md in the Flux manual.",
      "",
    ]);
  }

  if (p) {
    add("C", "Project map and index (read wide or deep from here)", mapSection(p, plan));

    // §D — ProjectContext and what it links
    {
      const pc = p.projectContext;
      const L: string[] = [];
      if (pc.isTemplate) L.push("**ProjectContext is still the unfilled template.** Mention it in your receipt; help fill it in only when asked.", "");
      if (pc.notAContext) L.push("**ProjectContext does not look like a project context** (none of its headings are there). Mention it in your receipt.", "");
      L.push(...docBlock(pc.path, pc.text, pc.sha, pc.text.split("\n").length));
      const byDisplay = new Map(pc.links.map((l) => [l.display, l]));
      for (const e of plan.linked) {
        const l = byDisplay.get(e.display)!;
        if (e.mode === "full" && l.text !== undefined) L.push(...docBlock(l.display, l.text, l.sha ?? "", l.text.split("\n").length));
        else if (e.mode === "partial" && l.text !== undefined) L.push(...partialDocBlock({ path: l.display, outline: l.outline ?? [], sha: l.sha ?? "", lines: l.text.split("\n").length }, l.text));
      }
      const listed = pc.links.filter((l) => plan.linked.find((e) => e.display === l.display)?.mode === "listed");
      if (listed.length) {
        L.push("Also linked (not text — look at images; other files as needed):", "");
        for (const l of listed) L.push(`- \`${l.display}\`${l.kind === "missing" ? " — ⚠ link does not resolve" : l.kind === "image" ? " — image: view it" : ""}`);
        L.push("");
      }
      add("D", "ProjectContext and the files it links", L);
    }

    add("E", "Project rules", docBlock(p.rules.path, p.rules.text, p.rules.sha, p.rules.text.split("\n").length));

    // §F — the Log
    {
      const L: string[] = [];
      const entries = p.notebook.entries;
      if (p.notebook.legacySections && plan.legacy) {
        L.push("#### Legacy notebook sections (earlier workflow; may be stale — the Log is newer)", "");
        const t = p.notebook.legacySections;
        L.push(fenced(plan.legacy === "full" ? t : t.slice(0, 6000 * 3.6) + "\n\n[… capped — read the file for the rest]", "markdown"), "");
      }
      if (!entries.length) L.push(`The Log (\`${p.notebook.path}\`) has no entries yet.`, "");
      else {
        L.push(`The Log (\`${p.notebook.path}\`) has ${entries.length} entr${entries.length === 1 ? "y" : "ies"}${plan.log.fromCheckpoint ? `; reading from the latest checkpoint "${plan.log.fromCheckpoint}"` : ""}. Newest last. Older entries stay in the file in full.`, "");
        L.push("#### Entries (in full)", "");
        for (const e of plan.log.full) {
          L.push(`##### ${e.stamp} — ${e.title}`);
          if (e.byline) L.push(`*${e.byline}*`);
          L.push("", fenced(e.body, "markdown"), "");
        }
        L.push("#### Every entry (index)", "");
        for (const e of entries) L.push(`- ${e.stamp} — ${e.title}${e.isCheckpoint ? " (checkpoint)" : ""}`);
        L.push("");
      }
      add("F", "Log", L);
    }

    // §G — open review items (awareness only)
    {
      const items = p.review.items;
      const L = ["**Do not act on these unless the user asks.**", ""];
      if (!items.length) L.push("Nothing open.");
      else {
        const by = (k: (i: (typeof items)[number]) => string) => {
          const m = new Map<string, number>();
          for (const i of items) m.set(k(i), (m.get(k(i)) ?? 0) + 1);
          return [...m].map(([k2, n]) => `${k2} ${n}`).join(" · ");
        };
        L.push(`By kind: ${by((i) => i.kind)}. By surface: ${by((i) => i.surface)}.`, "");
        const tags = [...new Set(items.flatMap((i) => i.tags))];
        if (tags.length) L.push(`Tags: ${tags.map((t) => `#${t}`).join(" ")}`, "");
        for (const i of items.slice(0, 50)) L.push(`- \`${i.id}\` · ${i.kind} · ${i.where} · "${i.text.slice(0, 100).replace(/\s+/g, " ")}" · ${i.chip} · route ${i.route}`);
        if (items.length > 50) L.push(`- … ${items.length - 50} more (\`flux inbox\`)`);
      }
      L.push("");
      add("G", "Open review items", L);
    }

    // §H — recent activity
    {
      const L: string[] = [];
      if (p.activity.lastPackAt) L.push(`Last flux-connect to this project: ${p.activity.lastPackAt}.`, "");
      if (p.activity.changedSinceLastPack.length) L.push(`Changed since then: ${p.activity.changedSinceLastPack.slice(0, 30).map((f) => `\`${f}\``).join(", ")}${p.activity.changedSinceLastPack.length > 30 ? " …" : ""}`, "");
      if (p.activity.journal.length) {
        L.push("Recent journal (newest last):", "");
        for (const j of p.activity.journal) L.push(`- ${j.last} · ${j.client} · ${j.action}${j.target ? ` ${j.target}` : ""}${j.count > 1 ? ` ×${j.count} (since ${j.first})` : ""}`);
      } else L.push("No recorded activity yet.");
      L.push("");
      add("H", "Recent activity", L);
    }

    if (plan.depth === "full") {
      const L: string[] = [];
      const docsByPath = new Map(p.docs.map((d) => [d.path, d]));
      for (const e of plan.docs) {
        const d = docsByPath.get(e.path)!;
        if (d.text !== undefined) L.push(...docBlock(d.path, d.text, d.sha, d.lines));
      }
      add("I", "Documents (in full)", L.length ? L : ["(no documents)"]);
      const J: string[] = [];
      for (const f of p.figures) J.push(`### ${f.id} "${f.displayName}"`, "", f.caption ? fenced(f.caption, "markdown") : "(no caption)", "");
      for (const d of p.decks) {
        J.push(`### Deck ${d.id} "${d.title}"`, "");
        for (const [i, s] of d.slides.entries()) J.push(`- ${i + 1}. ${s.name} (${s.beats} steps)${s.notes ? ` — notes: ${s.notes.replace(/\s+/g, " ").slice(0, 400)}` : ""}`);
        J.push("");
      }
      add("J", "Figure captions and deck notes (in full)", J.length ? J : ["(none)"]);
    }
  } else {
    const L: string[] = [];
    if (!facts.knownProjects.length) L.push("No projects recorded on this machine yet.");
    for (const k of facts.knownProjects.slice(0, 40)) L.push(`- "${k.title}" — \`${k.root}\`${k.lastOpened ? ` (last opened ${k.lastOpened.slice(0, 10)})` : ""}`);
    L.push("", "To work on one: `flux-connect <path>`.", "");
    add("K", "Known projects on this machine", L);
  }

  // Assemble: header + TOC (with line numbers) + sections, each ending in its code.
  const head = [
    `# FLUX-CONNECT BUNDLE · ${p ? `project "${p.title}"` : "global"} · pack ${facts.packId}`,
    "",
    "Read this whole file (in chunks). Each section ends with a code line; your receipt echoes them.",
    "",
  ];
  const bodies = sections.map((s) => [`## §${s.id} · ${s.title}`, "", ...s.body, sectionCodeLine(facts.packId, s.id)].join("\n"));
  // Two passes: the TOC has a fixed line count, so locate every section in the
  // assembled text, then fill in the numbers without moving anything.
  const assemble = (toc: string[]) => [...head, ...toc, "", ...bodies.flatMap((b) => [b, ""])].join("\n");
  const tocOf = (meta: BundleSection[]) => ["## Contents", "", ...sections.map((s, i) => `- §${s.id} ${s.title}${meta[i] ? ` — lines ${meta[i].startLine}–${meta[i].endLine}` : ""}`)];
  const draft = assemble(tocOf([])).split("\n");
  const meta: BundleSection[] = sections.map((s) => {
    const start = draft.indexOf(`## §${s.id} · ${s.title}`) + 1;
    const end = draft.indexOf(sectionCodeLine(facts.packId, s.id), start - 1) + 1;
    return { id: s.id, title: s.title, startLine: start, endLine: end };
  });
  const text = assemble(tocOf(meta));
  return { text, sections: meta, tokens: tokensOf(text), lines: text.split("\n").length };
}
