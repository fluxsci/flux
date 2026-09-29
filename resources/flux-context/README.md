# The Flux context system (stock — shipped with Flux, do not edit)

This folder is the stock manual. Flux refreshes it on update and removes Markdown
files no longer in the stock set. Put personal context in UserContext, beside it.

## The two machine folders and the project Context

```
<FluxConfig>/Context/
  UserContext/                   # the user's background, rules and reference material
    WHO-AM-I.md
    RULES.md
    Skills/<name>/SKILL.md        # procedures published to connected agents
    ...                          # additional text and images
  FluxContext/                   # this manual, owned by Flux

<project>/Context/
  ProjectContext.qmd             # background, optional goals, data/code and must-read links
  RULES.md                       # standing rules for this project
  NOTEBOOK.md                    # append-only Log, entries on request
```

Get the resolved paths from the connect brief or `flux config`. ProjectContext is
the must-read hub: link anything an agent needs there. The core connection reads
its immediate links within a budget, lists everything else in the project map, and
reports any trimming. It also reads UserContext text, Rules and the recent Log and
shows canvas overviews. Read the indexed reference images before making figures.
Full depth reads all documents and adds individual figure images and deck sheets.

## Ownership

| Path | Owner | Agent action |
|---|---|---|
| `UserContext/**` | User | Read; propose changes to background, rules or skills before writing. |
| `FluxContext/**` | Flux | Read; never store user notes here. |
| `<project>/Context/ProjectContext.qmd` | User | Read it and its links; propose additions or corrections. |
| `<project>/Context/RULES.md` | User | Propose standing preferences; keep one-off requests in their threads. |
| `<project>/Context/NOTEBOOK.md` | User, with requested agent entries | Append to the Log only when asked; never replace history. |
| `<project>/.meta/**` | App | Use tools for journal, locks, annotations and presence; never hand-edit. |

The three project Context files are Paper documents and can carry margin comments.
Project-root AGENTS.md is a passive flux-connect pointer; CLAUDE.md imports it.
Neither starts a connection, watcher or task on its own.

## Manual index

| Document | When to read | What it covers |
|---|---|---|
| [README.md](README.md) | To find a reference. | Context folders, ownership and this index. |
| [FLUX.md](FLUX.md) | **Always read on connect.** | Primer, glossary, ownership and intent-to-tool map. |
| [CONNECT.md](CONNECT.md) | **Always read on connect.** | Receipt, passive default, routing, watching, live mode, Log and conduct. |
| [WORKFLOW.md](WORKFLOW.md) | Before an end-to-end analysis-to-write-up task. | Orient, plot, compose, look, author and review. |
| [CLI-REFERENCE.md](CLI-REFERENCE.md) | Before using an unfamiliar verb or configuring MCP. | Command tables, setup/doctor, packs, toolsets, roots and paths. |
| [PROJECT-AND-FIGURES.md](PROJECT-AND-FIGURES.md) | Before editing figures or project structure. | Files, document discovery, ownership, composition, captions and plot sources. |
| [PLOTS-AND-STYLE.md](PLOTS-AND-STYLE.md) | Before generating or regenerating plots. | fluxplot, house style, semantic parts, recipes and validation. |
| [PYTHON-CONVENTIONS.md](PYTHON-CONVENTIONS.md) | Before writing analysis Python or setting up its environment. | uv projects/libraries and the editable fluxplot dependency. |
| [MANUSCRIPT.md](MANUSCRIPT.md) | Before authoring or compiling documents. | Quarto, citations, cross-references, figure/slide embeds and exports. |
| [REVIEW.md](REVIEW.md) | Before handling comments, annotations, watch mode or live pairing. | Packets, images, targets, claims, replies and the wait loop. |
| [LIBRARY.md](LIBRARY.md) | Before research, reference/PDF work or Reader assistance. | FluxLib, search, import, identification, Highlights and snips. |
| [SLIDES.md](SLIDES.md) | Before building, animating or exporting a talk. | Shared figure content, steps, tracks, video and offline delivery. |
| [LIGHTTABLE.md](LIGHTTABLE.md) | Before producing exploratory image sets. | The separate sidecar's filename alignment and launch convention. |

Read the reference for the task at hand; do not load every manual on every connect.
The user's skills are indexed separately in the bundle and read on demand.
