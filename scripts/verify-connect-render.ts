#!/usr/bin/env -S npx tsx
// 2026-09-27 — flux-connect's pure renderers (plan §8.3, §8.4, §8.6): the brief
// (≤10k chars, section markers against middle-truncation, receipt template, no
// proof codes), the bundle (core sections, dynamic fences, reading wraps, TOC
// line numbers, a proof code closing every section, FluxLib what/where/how
// only, ProjectContext + linked files under a budget, the Log from the last
// checkpoint + a full index), full depth, global mode, receipt checking, and
// ProjectContext link extraction. Hand-made facts: no filesystem.
//   Run: node scripts/run-verifies.mjs --tier pure --only connect-render
import { harness } from "./lib/harness.mjs";
import type { ConnectFacts, LogEntryFact } from "../flux-core/connect/facts";
import { planInclusion, LOG_ENTRIES_FULL } from "../flux-core/connect/budget";
import { renderBundle, fenceFor, wrapForReading, WRAP_AT } from "../flux-core/connect/bundle";
import { renderBrief, BRIEF_MAX_CHARS } from "../flux-core/connect/brief";
import { proofCode, sectionCodeLine, imageCode, checkReceipt } from "../flux-core/connect/codes";
import { extractLinks, linkKind } from "../flux-core/connect/links";

const h = harness("verify-connect-render");

const entries: LogEntryFact[] = Array.from({ length: 16 }, (_, i) => ({
  stamp: `2026-09-${String(1 + i).padStart(2, "0")} 10:00`,
  title: i === 3 ? "Checkpoint: summary of August" : `Entry ${i + 1}`,
  byline: i % 2 ? "Claude Opus 5.5 · Claude Code · CLI · lab:/data/x" : null,
  body: i === 15 ? "The last entry has a fence:\n```python\nprint(1)\n```\nand ~~~ tildes." : `Body of entry ${i + 1}.`,
  isCheckpoint: i === 3,
}));
const longLine = "word ".repeat(300).trim(); // 1,499 chars on one line
const bigLinked = ("A paragraph of linked analysis notes. ".repeat(40) + "\n\n").repeat(120); // ~200k chars

function facts(over: Partial<ConnectFacts> = {}): ConnectFacts {
  return {
    mode: "project",
    packId: "pk7f3a",
    createdAt: "2026-09-27T12:00:00.000Z",
    machine: {
      fluxVersion: "0.2.0", commit: "abc1234", installKind: "source", installPath: "/home/u/flux",
      launcher: "/home/u/.local/share/flux/bin/flux", mcpRegistered: { claude: true, codex: false },
      fluxConfig: "/home/u/FluxConfig", fluxContextDir: "/home/u/FluxConfig/Context/FluxContext",
      stockDocs: [{ name: "FLUX.md", path: "/x/FLUX.md", tokens: 4800 }, { name: "CONNECT.md", path: "/x/CONNECT.md", tokens: 2600 }],
      fluxLib: { path: "/home/u/FluxConfig/FluxLib", entries: 1857, pdfs: 1400 }, plotLibrary: { path: "/home/u/FluxConfig/plot_library", count: 12 },
      fluxplot: { path: "/home/u/fluxplot", version: "0.3.1" }, quarto: "1.7.3", uv: null, canRender: true,
    },
    user: {
      dir: "/home/u/FluxConfig/Context/UserContext",
      files: [{ rel: "WHO-AM-I.md", text: "# Who am I\n\nA neuroscience postdoc.", sha: "aaaa1111" }, { rel: "RULES.md", text: "# Rules\n\n- " + longLine, sha: "bbbb2222" }],
      images: [{ rel: "sizing.png", abs: "/home/u/FluxConfig/Context/UserContext/sizing.png" }],
      skills: [{ name: "stats-conventions", description: "How I report statistics", path: "/home/u/FluxConfig/Context/UserContext/Skills/stats-conventions/SKILL.md" }],
    },
    project: {
      root: "/data/sleep/Proj", title: "Synaptic Sleep", authors: ["K. D."], defaultDoc: "paper/notes.qmd",
      docs: [
        { path: "paper/notes.qmd", title: "Notes", words: 1200, lines: 90, hasComments: true, sha: "c".repeat(64), outline: [{ level: 1, text: "Intro", line: 3 }, { level: 2, text: "Methods", line: 20 }, { level: 3, text: "Deep", line: 30 }], text: "# Intro\n\nNotes body.\n" },
        { path: "paper/drafts/draft_1.qmd", title: "Draft 1", words: 9000, lines: 600, hasComments: false, sha: "d".repeat(64), outline: [{ level: 2, text: "Results", line: 10 }], text: "## Results\n\nDraft body.\n" },
      ],
      figures: [{ id: "fig-1", displayName: "Figure 1", canvasId: "c1", captionLead: "Density by layer.", caption: "Density by layer. **a**, … **b**, …", panels: [{ label: "a", source: "plots/density.svg", recipe: "plots/density.recipe.json" }], stale: true }],
      canvases: [{ id: "c1", name: "Main", figureIds: ["fig-1"] }],
      decks: [{ id: "talk", title: "Lab talk", slides: [{ id: "s1", name: "Title", beats: 1 }, { id: "s2", name: "Results", beats: 3, notes: "Say the thing." }] }],
      plots: { count: 8, dissections: 2, lighttable: ["spines"] }, referencesCount: 31,
      workspace: { dir: "/data/sleep", markers: ["pyproject.toml", ".git"], entries: ["analysis", "data", "Proj"] },
      git: { branch: "main", dirty: 3 },
      projectContext: {
        path: "Context/ProjectContext.qmd", sha: "e".repeat(64), isTemplate: false, notAContext: false,
        text: "---\ntitle: Project context\n---\n\n## Background\n\nSee [plan](../notes/plan.md) and ![fig](media/sketch.png) and [big](../notes/big.md).",
        links: [
          { link: "../notes/plan.md", abs: "/data/sleep/notes/plan.md", display: "/data/sleep/notes/plan.md", kind: "text", text: "# Plan\n\nThe analysis plan.", sha: "f".repeat(64), outline: [], depth: 1 },
          { link: "media/sketch.png", abs: "/data/sleep/Proj/Context/media/sketch.png", display: "Context/media/sketch.png", kind: "image", depth: 1 },
          { link: "../notes/big.md", abs: "/data/sleep/notes/big.md", display: "/data/sleep/notes/big.md", kind: "text", text: bigLinked, sha: "9".repeat(64), outline: [{ level: 1, text: "Big", line: 1 }], depth: 1 },
          { link: "deeper.md", abs: "/data/sleep/notes/deeper.md", display: "/data/sleep/notes/deeper.md", kind: "text", text: "deeper", sha: "8".repeat(64), outline: [], depth: 2 },
        ],
      },
      rules: { path: "Context/RULES.md", text: "# Project rules\n\n- Nature style", sha: "7".repeat(64) },
      notebook: { path: "Context/NOTEBOOK.md", sha: "6".repeat(64), entries, legacySections: "## State\n\nThirty-four validated panels." },
      review: { items: [
        { id: "fb1", kind: "annotation", where: "figure · fig-1", text: "Move the legend", status: "open", chip: "Open", route: "any", tags: ["claude"], surface: "figure" },
        { id: "c1", kind: "comment", where: 'paper/notes.qmd · "the density"', text: "Cite Smith", status: "queued", chip: "Queued → heron", route: "@heron", tags: [], surface: "paper", doc: "paper/notes.qmd" },
      ] },
      activity: { journal: [{ client: "claude-code", action: "log", target: "Context/NOTEBOOK.md", count: 2, first: "2026-09-26T10:00", last: "2026-09-26T11:00" }], changedSinceLastPack: ["paper/notes.qmd"], lastPackAt: "2026-09-26T09:00:00Z" },
    },
    live: { appOpen: true, surface: "figure", selection: "fig-1 selected" },
    identity: { product: "Claude Code", surface: "CLI", sessionName: "heron" },
    knownProjects: [],
    ...over,
  };
}

const paths = { briefPath: "/c/pk/brief.md", bundlePath: "/c/pk/bundle.md", flux: "/x/FLUX.md", connect: "/x/CONNECT.md" };

h.section("links");
h.eq(
  extractLinks("See [a](../a.md), ![i](img/x.png \"t\"), <https://x.org>, [w](https://web), [s](#sec)\n{{< include _inc.qmd >}}\n[ref]: refs/r.md\n`/data/x/README.md` and `not a path` and `plan.py`\n```\n[in code](nope.md)\n```"),
  ["../a.md", "img/x.png", "_inc.qmd", "refs/r.md", "/data/x/README.md", "plan.py"],
  "Markdown links, images, includes, reference defs and backticked paths; not URLs, anchors or code",
);
h.eq([linkKind("a.qmd"), linkKind("b.PNG"), linkKind("c.pdf")], ["text", "image", "other"], "link kinds");

h.section("fences and wrapping");
h.eq(fenceFor("no ticks"), "````", "minimum fence is four backticks");
h.eq(fenceFor("has ````` five"), "``````", "a fence outgrows any run inside");
const wrapped = wrapForReading(longLine);
h.ok(wrapped.split("\n").every((l) => l.length <= WRAP_AT), "long lines wrap to ≤ WRAP_AT");
h.eq(wrapped.replace(/\n/g, " "), longLine, "wrapping loses nothing");

h.section("core plan");
const f = facts();
const plan = planInclusion(f, "core");
h.eq(plan.linked.map((l) => l.mode), ["full", "listed", "partial"], "linked: text in full, the image listed, the oversized doc partial; depth-2 links skipped in core");
h.ok(plan.trimmed.some((t) => t.what.endsWith("big.md")), "the oversized linked doc is reported as trimmed");
h.eq(plan.log.fromCheckpoint, "Checkpoint: summary of August", "the log reads from the latest checkpoint");
h.eq(plan.log.full.length, LOG_ENTRIES_FULL, `…capped at the ${LOG_ENTRIES_FULL} newest entries`);
h.eq(plan.log.full.at(-1)?.title, "Entry 16", "…ending with the newest");
h.eq(plan.docs.map((d) => d.mode), ["listed", "listed"], "core lists documents (outline in the map) rather than reading them");
h.eq(plan.figureImages, "canvases", "core looks at canvas overviews only");

h.section("bundle (core)");
const b = renderBundle(f, plan);
const lines = b.text.split("\n");
h.eq(b.sections.map((s) => s.id), ["A", "B", "C", "D", "E", "F", "G", "H"], "core sections A–H");
for (const s of b.sections) {
  h.ok(lines[s.startLine - 1]?.startsWith(`## §${s.id} ·`), `TOC line ${s.startLine} is §${s.id}'s heading`);
  h.eq(lines[s.endLine - 1], sectionCodeLine(f.packId, s.id), `§${s.id} ends with its proof code (line ${s.endLine})`);
}
h.ok(b.text.includes("1,857 references") && !/smith2020|Nature 20/.test(b.text.split("## §C")[0].split("## §B")[1]), "FluxLib: what/where/how, no paper list");
h.ok(b.text.includes("The analysis plan.") && b.text.includes("OUTLINE + OPENING ONLY"), "§D: the linked plan in full, the big doc as outline + opening");
h.ok(b.text.includes("`Context/media/sketch.png` — image: view it"), "§D lists linked images to view");
h.ok(!b.text.includes("deeper"), "core does not follow links two levels deep");
h.ok(b.text.includes("Legacy notebook sections (earlier workflow; may be stale"), "legacy notebook sections are labelled");
h.ok(b.text.includes("#### Every entry (index)") && b.text.includes("- 2026-09-01 10:00 — Entry 1"), "the log index lists every entry, oldest included");
h.ok(!b.text.includes("Body of entry 3.") && b.text.includes("Body of entry 7."), "entries before the checkpoint window are indexed, not inlined");
h.ok(b.text.includes("print(1)") && b.text.includes("~~~ tildes"), "content with fences survives inside the dynamic fence");
h.ok(b.text.split("\n").every((l) => l.length <= WRAP_AT + 250), "no bundle line is enormous (wrapped for reading)");
h.ok(b.text.includes("⚠ stale vs plots/") && b.text.includes("`plots/density.svg`"), "the map flags stale figures and names plot sources");
h.ok(b.text.includes("paper/drafts/draft_1.qmd") && b.text.includes("Results (line 10)"), "the map indexes documents with outlines");
h.ok(!b.text.includes("Draft body."), "core does not inline documents");
h.ok(b.text.includes("**Do not act on these unless the user asks.**") && b.text.includes("route @heron"), "open items are for awareness, with routes");
h.ok(b.text.includes("stats-conventions") && b.text.includes("/<name> in Claude Code"), "the user's skills are listed as invocable");

h.section("brief");
const images = [{ path: "/c/pk/images/canvas-c1.png", label: 'canvas "Main": fig-1 "Figure 1"' }];
const brief = renderBrief({ facts: f, plan, paths, bundle: b, images, linkedImages: ["/data/sleep/Proj/Context/media/sketch.png"], live: true });
h.ok(brief.length <= BRIEF_MAX_CHARS, `brief is ≤ ${BRIEF_MAX_CHARS} chars (${brief.length})`);
h.ok(brief.trimEnd().endsWith(`END OF FLUX-CONNECT BRIEF ${f.packId}`), "the brief ends with its sentinel");
const markers = [...brief.matchAll(/^— end §(\w+) · pk7f3a —$/gm)].map((m) => m[1]);
h.eq(markers, ["0", "1", "2", "3", "4", "5"], "every section ends with a marker (middle-truncation detection)");
const stated = Number(/This brief has (\d+) lines/.exec(brief)?.[1]);
h.eq(stated, brief.split("\n").length, "the header states the true line count");
h.ok(b.sections.every((s) => !brief.includes(proofCode(f.packId, `section:${s.id}`))) && !brief.includes(imageCode(f.packId, 0)), "no proof code appears in the brief");
h.ok(brief.includes("You are heron") && brief.includes("ProjectContext (+2 linked)"), "the receipt template names the session and the linked count");
h.ok(brief.includes("Expected: 8 section codes (A, B, C, D, E, F, G, H) and 1 image code"), "the brief states what the proof must contain");
h.ok(brief.includes("## 5 · Live mode") && brief.includes("`get_view`"), "--live adds the live section");
h.ok(brief.includes("REVIEW.md") && brief.includes("SLIDES.md"), "on-demand references are listed");
h.ok(brief.includes("do not write to the project Log"), "the passive default is stated");
const noLive = renderBrief({ facts: f, plan, paths, bundle: b, images, linkedImages: [], live: false });
h.ok(!noLive.includes("## 5 · Live mode"), "no live section without --live");

h.section("receipt check");
const good = `Proof: ${b.sections.map((s) => `${s.id}-${proofCode(f.packId, `section:${s.id}`)}`).join(" ")} · ${imageCode(f.packId, 0)}`;
h.eq(checkReceipt(f.packId, good, b.sections.map((s) => s.id), 1).complete, true, "the right codes pass");
const missing = checkReceipt(f.packId, good.replace(proofCode(f.packId, "section:D"), "ZZZZ"), b.sections.map((s) => s.id), 1);
h.eq([missing.complete, missing.sections.find((s) => s.id === "D")?.ok], [false, false], "a missing section code is flagged");
h.ok(!checkReceipt(f.packId, "Proof: A-XXXX", ["A"], 0).complete, "wrong codes fail");

h.section("full depth");
const planFull = planInclusion(f, "full");
const bf = renderBundle(f, planFull);
h.eq(bf.sections.map((s) => s.id), ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"], "full adds documents (§I) and captions/notes (§J)");
h.ok(bf.text.includes("Draft body.") && bf.text.includes("Say the thing."), "full inlines documents and deck notes");
h.ok(bf.text.includes("deeper") && planFull.linked.every((l) => l.mode !== "partial"), "full follows deeper links and reads them whole");
h.eq(planFull.log.full.length, 16, "full reads the whole Log");

h.section("global mode");
const g = facts({ mode: "global", project: null, live: null, knownProjects: [{ root: "/data/sleep/Proj", title: "Synaptic Sleep", lastOpened: "2026-09-25T10:00:00Z" }] });
const gp = planInclusion(g, "core");
const gb = renderBundle(g, gp);
h.eq(gb.sections.map((s) => s.id), ["A", "B", "K"], "global: you, FluxLib, known projects");
const gbrief = renderBrief({ facts: g, plan: gp, paths, bundle: gb, images: [], linkedImages: [], live: false });
h.ok(gbrief.includes("✓ flux-connected · global") && gbrief.includes("Known projects: 1") && !gbrief.includes("ProjectContext ("), "global receipt");
h.ok(gb.text.includes('"Synaptic Sleep" — `/data/sleep/Proj`'), "known projects are listed with paths");

h.section("brief stays under the limit when lists are long");
const many = facts();
many.user.skills = Array.from({ length: 120 }, (_, i) => ({ name: `skill-${i}`, description: "x".repeat(70), path: `/s/${i}` }));
const manyPlan = planInclusion(many, "core");
for (let i = 0; i < 60; i++) manyPlan.trimmed.push({ what: `/data/big-${i}.md`, tokens: 50000, reason: "too big" });
const manyImages = Array.from({ length: 40 }, (_, i) => ({ path: `/c/pk/images/fig-${i}.png`, label: `figure ${i}` }));
const mb = renderBrief({ facts: many, plan: manyPlan, paths, bundle: renderBundle(many, manyPlan), images: manyImages, linkedImages: [], live: false });
h.ok(mb.length <= BRIEF_MAX_CHARS, `a crowded brief compacts under the limit (${mb.length})`);
h.ok(mb.includes("more"), "…and says how many items it folded away");

await h.done();
