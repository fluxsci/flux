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
  Transcripts/                   # principal-session transcripts (machine-captured)
  Dispatches/                    # worker dispatch records (principal-owned)
```

## Who reads what

**The Principal** (the user's standing project collaborator) reads, at every session start,
in this order:

1. `UserContext/` — every file (`WHO-AM-I.md`, `RULES.md`, siblings/images).
2. `FluxContext/PRINCIPAL.md` — your role doctrine. Follow it.
3. `<project>/Context/Project/MISSION.qmd` — what this project is driving toward.
4. `<project>/Context/RULES.md` — this project's standing rules.
5. `<project>/Context/NOTEBOOK.md` — your memory: decisions, state, what's been tried.
6. `<project>/.meta/journal.ndjson` (tail) + open feedback and project-wide comments — what just changed.

`Transcripts/` and `Dispatches/` are **archives**: searched when the notebook points at
them or when you need verbatim history — never bulk-read at session start.

**Workers** (agents dispatched by the Principal for one task) read their **brief** (given at
dispatch) plus `FluxContext/WORKERS.md`, and only the additional files the brief names.
Workers do not read `UserContext/` or the notebook — the brief contains everything relevant.

## File ownership (who writes what)

| File | Owner | Others may… |
|---|---|---|
| `UserContext/WHO-AM-I.md` | the user | read only |
| `UserContext/RULES.md` (+siblings) | the user | agent may PROPOSE edits |
| `FluxContext/**` | Flux itself | nobody edits (overwritten on update) |
| `<project>/Context/RULES.md` | co-owned | agent promotes standing preferences here |
| `<project>/Context/NOTEBOOK.md` | the agent | the user reads + leaves comments |
| `<project>/Context/Project/MISSION.qmd` | co-owned | user has final say |
| `<project>/Context/Transcripts/` | Flux (auto-captured) | append-only, nobody edits |
| `<project>/Context/Dispatches/` | the Principal | user reads |

## The other stock files here

Roles and the scheme:

- `PRINCIPAL.md` — the Principal's role: boot, standup, delegation, promotion, review.
- `WORKERS.md` — how a dispatched worker operates and reports.
- `AGENTS-CONFIG.md` — the `agents.json` roster format (which CLI is the principal,
  which are workers).

Working references (read on demand — briefs and the docs above point into these):

- `FLUX-CLI.md` — driving Flux headless: the CLI/MCP essentials (start here).
- `PROJECT-GUIDE.md` — the full inside-a-project reference: layout, ownership,
  conventions, the complete verb surface, the live bridge, safety.
- `WORKFLOW.md` — the end-to-end session playbook (orient → plots → figures →
  write-up → review), with copy-paste commands.
- `CLI-REFERENCE.md` — the complete verb cheat-sheet (CLI ↔ MCP) + root resolution.
- `PYTHON-CONVENTIONS.md` — how analysis Python is set up: uv projects/libraries,
  fluxplot as a dependency (standing rules for principals AND workers).
- `PLOTS-AND-STYLE.md` — fluxplot + the house (Flexoki) style; recipes + regeneration.
- `PROJECT-AND-FIGURES.md` — the on-disk tree, the figure model, compose/look/restyle.
- `MANUSCRIPT-AND-REVIEW.md` — Quarto authoring, comments, the feedback ledger, live edits.
- `SLIDES.md` — Flux Slide: build + animate a talk, export one offline `.html`.
- `LIGHTTABLE.md` — the image-set triage sidecar: the collection/set/filename-alignment
  convention ("a lighttable directory of X") and how to launch it.
- `TEMPLATES.md` — analysis-dir glue (AGENTS/CLAUDE stubs, per-project MCP wiring).
