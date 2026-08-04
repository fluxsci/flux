// The ONE project-scaffold source (AGT-15). Both engines write EXACTLY this tree —
// the GUI (scaffold.ts, via the file bridge) and flux-core (`flux new`, via Node fs) —
// so a CLI-scaffolded project and a GUI-scaffolded one can never drift again. They
// had: two different manifests (the CLI's pointed at a _quarto.yml it never wrote,
// format "pdf" vs "quarto", empty capabilities), an empty CLI fig index (no seeded
// canvas/figure), no CLI README/.gitignore, GUI projects missing the .meta/schema/
// contract files, and two divergent AGENTS.md (orientation-only vs verb-guide).
// Pure: string/JSON building only — each engine supplies its own I/O.

import { PROJECT_SCHEMA_VERSION, slugify, type ProjectManifest } from "./types";
import { SCHEMAS, SCHEMA_FILENAMES } from "./schemas";
import { BLANK_FIGURE } from "../ops";
import { agentsStubTemplate, contextScaffoldEntries } from "./contextTemplates";
import type { Deck } from "../slide/types";

export interface ScaffoldOptions {
  title: string;
  author?: string;
}

export interface ScaffoldTree {
  manifest: ProjectManifest;
  /** Relative directories to create (in order). */
  dirs: string[];
  /** Relative file path → content (text). */
  files: [string, string][];
}

const stamp = () => new Date().toISOString();
const uuid = () =>
  typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;

/** Directories created for every new project (relative to root). */
const DIRS = [
  "manuscript",
  "manuscript/sections",
  "supplementary",
  "plots",
  "fig",
  "fig/canvases",
  "fig/captions",
  "fig/renders",
  "fig/assets",
  "references",
  "references/styles",
  "slides",
  "styles",
  "styles/journal",
  "assets",
  "exports",
  ".meta",
  ".meta/cache",
  ".meta/locks",
  ".meta/schema",
];

function buildManifest(opts: ScaffoldOptions): ProjectManifest {
  const now = stamp();
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    id: `proj_${uuid()}`,
    slug: slugify(opts.title),
    title: opts.title,
    created: now,
    modified: now,
    authors: opts.author ? [{ name: opts.author, orcid: null, email: null }] : [],
    manuscript: {
      path: "manuscript/main.qmd",
      config: "manuscript/_quarto.yml",
      format: "quarto",
    },
    supplementary: [],
    references: {
      library: "references/library.bib",
      csljson: "references/library.csl.json",
      defaultStyle: null,
      zoteroSync: null,
    },
    figures: [],
    slides: [],
    capabilities: {
      manuscript: "0.1",
      figures: "0.1",
      references: "0.1",
      slides: "0.1",
    },
  };
}

function mainQmd(opts: ScaffoldOptions): string {
  const author = opts.author ? `\n  - ${opts.author}` : "";
  return `---
title: "${opts.title}"
author:${author || " []"}
bibliography: ../references/library.bib
---

# Introduction

Start writing here.
`;
}

const QUARTO_YML = `project:
  type: default
format:
  html: default
  docx: default
bibliography: ../references/library.bib
`;

/* The old per-project verb-guide AGENTS.md moved to the machine-level
 * FluxContext (PROJECT-GUIDE.md, resources/flux-context/) in the principal-agent
 * scheme — per-project baked copies went stale on every Flux release; the
 * FluxContext copy re-syncs with the app. The scaffolded AGENTS.md is now a
 * stub pointer (contextTemplates.agentsStubTemplate). */

function readmeMd(opts: ScaffoldOptions): string {
  return `# ${opts.title}

A Flux project. Open it in Flux, or work with the files directly.

- \`manuscript/main.qmd\` — the manuscript
- \`plots/\` — drop your analysis plots here
- \`fig/\` — figures (managed by the app)
- \`references/library.bib\` — bibliography

See \`AGENTS.md\` for the full layout and conventions.
`;
}

const GITIGNORE = `exports/
.meta/cache/
.meta/locks/
.meta/live/
fig/renders/
`;

// A new project opens with one canvas holding a default "Figure 1" frame, so
// the figure editor has something to work with immediately. (Palette/colorGroups are
// omitted here so the loader can fall back to the Flexoki default.)
function figIndex(): string {
  return (
    JSON.stringify(
      {
        schemaVersion: "0.1.0",
        canvases: [{ id: "canvas-1", name: "Canvas 1", order: 1 }],
        figures: [
          {
            id: "fig-1",
            name: "Figure 1",
            label: "fig-1",
            order: 1,
            kind: "main",
            family: "figure",
            number: 1,
            canvas: "canvas-1",
            caption: "",
          },
        ],
      },
      null,
      2,
    ) + "\n"
  );
}

function figCanvas(): string {
  return (
    JSON.stringify(
      {
        schemaVersion: "0.1.0",
        id: "canvas-1",
        name: "Canvas 1",
        figures: [
          {
            id: "fig-1",
            name: "Figure 1",
            family: "figure",
            number: 1,
            canvasId: "canvas-1",
            x: 0,
            y: 0,
            width: BLANK_FIGURE.width,
            height: BLANK_FIGURE.height,
            background: BLANK_FIGURE.background,
            elements: [],
          },
        ],
      },
      null,
      2,
    ) + "\n"
  );
}

// The project's library.bib is the *cited subset*: it starts empty and fills as
// references are cited (materialized from the machine-global FluxLib). It stays
// canonical-within-project, so the project zips/clones/renders standalone.
const PROJECT_BIB_HEADER =
  "% This project's cited references (BibLaTeX), materialized from your FluxLib.\n";

/** Build the complete new-project tree. `deck` = the starter deck (each engine
 *  creates it via slide/ops createDeck and registers it here). */
export function buildScaffoldTree(opts: ScaffoldOptions, deck: Deck): ScaffoldTree {
  const manifest = buildManifest(opts);
  const deckRel = `slides/${deck.id}/deck.json`;
  manifest.slides = [{ id: deck.id, path: deckRel, title: deck.title, order: 1 }];

  const context = contextScaffoldEntries(opts.title);
  const dirs = [...DIRS, ...context.dirs, `slides/${deck.id}`, `slides/${deck.id}/assets`];
  const files: [string, string][] = [
    ["project.json", JSON.stringify(manifest, null, 2) + "\n"],
    ["AGENTS.md", agentsStubTemplate()],
    ["README.md", readmeMd(opts)],
    [".gitignore", GITIGNORE],
    ["manuscript/main.qmd", mainQmd(opts)],
    ["manuscript/_quarto.yml", QUARTO_YML],
    ["references/library.bib", PROJECT_BIB_HEADER],
    ["fig/index.json", figIndex()],
    ["fig/canvases/canvas-1.json", figCanvas()],
    [deckRel, JSON.stringify(deck, null, 2) + "\n"],
    [".meta/journal.ndjson", ""],
    ...context.files,
    // The machine contract ships in-project: agents validate writes against these.
    ...Object.entries(SCHEMA_FILENAMES).map(
      ([key, filename]): [string, string] => [
        `.meta/schema/${filename}`,
        JSON.stringify(SCHEMAS[key], null, 2) + "\n",
      ],
    ),
  ];
  return { manifest, dirs, files };
}
