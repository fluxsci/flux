---
name: flux
description: >-
  Present analysis results as publication-quality figures and write-ups in a Flux
  project — generate plots with the fluxplot library in the house (Flexoki) style,
  compose multi-panel figures, write the Quarto manuscript, render the figures to
  look at them, and address the user's review comments and feedback in place. Also
  builds **Flux Slide** talks — figure-first animated decks exported as one
  self-contained offline `.html`. Use whenever the user asks to put results /
  figures / a paper / a report / a talk or slides into Flux, to "present results
  via Flux", or points at a Flux project (a folder containing project.json).
---

# Flux — the knowledge lives with Flux, not in this skill

This machine runs **Flux**, and all agent instructions for it are shipped *with Flux*
in the machine Context layer (so they can never go stale against the installed app).
This skill is only the trigger. Do this:

1. Locate the Context layer: it lives at `<FluxConfig>/Context` — by default
   `~/FluxConfig/Context/`. (If it isn't there, FluxConfig was moved: run
   `flux config`, whose JSON prints `userContextPath` + `fluxContextPath`; the exact
   CLI invocation for this machine is baked into
   `Context/FluxContext/FLUX-CLI.md`.)
2. Read **everything** under `<userContextPath>/` — who the user is + their standing
   rules for all Flux output.
3. Orient in `<fluxContextPath>/`: start with `README.md` (the scheme + reading map),
   then `WORKFLOW.md` (the session playbook). Principals follow `PRINCIPAL.md`;
   dispatched workers follow `WORKERS.md`; the complete references
   (`CLI-REFERENCE.md`, `PLOTS-AND-STYLE.md`, `PROJECT-AND-FIGURES.md`,
   `MANUSCRIPT-AND-REVIEW.md`, `SLIDES.md`, `TEMPLATES.md`) are siblings.
4. In a project, read `Context/Project/MISSION.qmd`, `Context/NOTEBOOK.md`, and
   `Context/RULES.md` before working, and check `flux feedback` + `flux comments`
   for open review items.

That's the whole skill — the canonical, always-current instructions are the files above.
