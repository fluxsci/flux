# The Flux context system (stock — shipped with Flux, do not edit)

This folder (`FluxContext/`) is **stock documentation shipped with Flux**. It is overwritten
on every Flux update. User-editable context lives in the sibling folder `UserContext/`.

## The two Context folders

All agent memory, context, and instructions live in exactly two places:

```
<FluxConfig>/Context/            # machine level (this folder's parent)
  UserContext/                   # WHO the user is + THEIR standing rules (user-owned)
    WHO-AM-I.md                  #   the user: background, expertise, interests, taste
    RULES.md                     #   global rules applying to ALL projects (+ any sibling
                                 #   files/images the user adds — read everything here)
  FluxContext/                   # HOW to work in Flux (stock, app-owned — this folder)

<project>/Context/               # project level (inside every Flux project)
  RULES.md                       # rules for THIS project (human + agent co-owned)
  NOTEBOOK.md                    # the agent's memory of the project (agent-owned)
  Project/
    MISSION.qmd                  # goals, scope, scientific context (co-owned charter)
```

## Who reads what

Agents read UserContext, then this folder's README, then the project's Context/.

## File ownership (who writes what)

| File | Owner | Others may… |
|---|---|---|
| `UserContext/WHO-AM-I.md` | the user | read only |
| `UserContext/RULES.md` (+siblings) | the user | agent may PROPOSE edits |
| `FluxContext/**` | Flux itself | nobody edits (overwritten on update) |
| `<project>/Context/RULES.md` | co-owned | agent promotes standing preferences here |
| `<project>/Context/NOTEBOOK.md` | the agent | the user reads + leaves comments |
| `<project>/Context/Project/MISSION.qmd` | co-owned | user has final say |

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
