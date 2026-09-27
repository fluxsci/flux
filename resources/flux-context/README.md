# The Flux context system (stock — shipped with Flux, do not edit)

This folder (`FluxContext/`) is **stock documentation shipped with Flux**. It is overwritten
on every Flux update; Markdown files absent from the stock set are removed. Put your own
context in the sibling folder `UserContext/`.

## The two Context folders

All agent memory, context, and instructions live in exactly two places:

```
<FluxConfig>/Context/            # machine level (this folder's parent)
  UserContext/                   # WHO the user is + THEIR standing rules (user-owned)
    WHO-AM-I.md                  #   the user: background, expertise, interests, taste
    RULES.md                     #   global rules applying to ALL projects (+ any sibling
                                 #   files/images the user adds — read everything here)
    Skills/<name>/SKILL.md        #   your procedures, published to connected agents
  FluxContext/                   # HOW to work in Flux (stock, app-owned — this folder)

<project>/Context/               # project level (inside every Flux project)
  RULES.md                       # your standing rules for THIS project
  NOTEBOOK.md                    # append-only Log; entries only when requested
  ProjectContext.qmd             # background, goals and links every connected agent reads
```

## Who reads what

Every flux-connected agent reads UserContext, ProjectContext and its linked files, project
rules, and the recent Log. Project-root `AGENTS.md` suggests connecting only when asked;
`CLAUDE.md` imports that pointer with `@AGENTS.md`.

## File ownership (who writes what)

| File | Owner | Others may… |
|---|---|---|
| `UserContext/WHO-AM-I.md` | the user | read only |
| `UserContext/RULES.md` (+siblings) | the user | agent may PROPOSE edits |
| `FluxContext/**` | Flux itself | nobody edits (overwritten on update) |
| `<project>/Context/RULES.md` | the user | agent may propose standing preferences |
| `<project>/Context/NOTEBOOK.md` | the user and requested agents | append entries; read and leave comments |
| `<project>/Context/ProjectContext.qmd` | co-owned | user has final say |

## The other stock files here

Working references (read on demand):

- `FLUX-CLI.md` — driving Flux headless: the CLI/MCP essentials (start here).
- `PROJECT-GUIDE.md` — the full inside-a-project reference: layout, ownership,
  conventions, the complete verb surface, the live bridge, safety.
- `WORKFLOW.md` — the end-to-end session playbook (orient → plots → figures →
  write-up → review), with copy-paste commands.
- `CLI-REFERENCE.md` — the complete verb cheat-sheet (CLI ↔ MCP) + root resolution.
- `PYTHON-CONVENTIONS.md` — how analysis Python is set up: uv projects/libraries,
  fluxplot as a dependency (standing rules for agents).
- `PLOTS-AND-STYLE.md` — fluxplot + the house (Flexoki) style; recipes + regeneration.
- `PROJECT-AND-FIGURES.md` — the on-disk tree, the figure model, compose/look/restyle.
- `MANUSCRIPT-AND-REVIEW.md` — Quarto authoring, comments, the feedback ledger, live edits.
- `SLIDES.md` — Flux Slide: build + animate a talk, export one offline `.html`.
- `LIGHTTABLE.md` — the image-set triage sidecar: the collection/set/filename-alignment
  convention ("a lighttable directory of X") and how to launch it.
- `TEMPLATES.md` — analysis-dir glue (AGENTS/CLAUDE stubs, per-project MCP wiring).
