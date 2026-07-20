# Manuscript authoring, the review loop, and live edits

## Documents are Quarto `.qmd`

The manuscript is `manuscript/main.qmd` (plus optional `supplementary/` and `sections/*.qmd`),
plain Quarto markdown with YAML front-matter (title, `bibliography: ../references/library.bib`).
**The `.qmd` is the source of truth** — edit it directly, or via the verbs:

```bash
{{FLUX_CLI}} manuscript                 # read main.qmd (--doc for others)
{{FLUX_CLI}} set-manuscript --file draft.md   # overwrite (holds the manuscript lock + journals)
{{FLUX_CLI}} docs                       # list documents
{{FLUX_CLI}} new-doc "Supplement"       # add one
```

When the app is open, an external `.qmd` write **live-reloads** if the user's editor is clean;
if they have unsaved edits it shows a non-destructive "reload / keep mine" banner (never
clobbers their work). For big rewrites of hand-edited prose, prefer proposing the change.

## Cross-references and citations (literal Quarto text in the `.qmd`)

- **Figures:** write `@fig-<label>` (panel: `@fig-<label>-a`). Append one with
  `ref growth` → adds `See @fig-growth.`. Numbers ("Figure 3") are resolved at
  render time from order. Panel refs survive `compile` too: they're translated to literal
  "Figure 3a" text at render time (bare Quarto only knows whole-figure refs).
- **Citations:** write `[@citekey]`. Grow the library with
  `cite-doi 10.1038/nature12373` (fetches BibTeX — it echoes the fetched
  author/title/year in full; CHECK it, registries serve junk metadata on automated deposits)
  or `add-reference . <bibtex>` / `add-reference . --file refs.bib`. Citekeys are stable join keys.
- **Embedding a figure** in the prose (an actual image): `![](../fig/renders/<id>.svg){#fig-<id>}`
  — **leave the alt empty.** The caption comes from the figure model (`fig/captions/<id>.md`,
  written by `set-caption`) and renders live under the figure; Quarto exports get it injected at
  compile time. Never paste caption text into the `![…]` alt slot (the app clears it anyway;
  `normalize-embeds` fixes legacy docs). In the editor the embed line shows as a compact chip
  carrying the figure's NAME — name figures well (`set-figure-layout <id> --name "Figure 3"`).
- **Section IDs:** standard Quarto header attributes (`## Results {#sec-results}`) are fine —
  the editor hides the `{#…}` tail unless the caret is on the heading.
- **Compile:** `compile --to pdf|html|docx` (needs `quarto` on PATH).

## The review loop (read → address → resolve)

This is how the user iterates with you. The user marks up the manuscript in the app; their
comments persist to a **sidecar JSON beside the document** — `manuscript/comments.json` for the
main doc, `<dir>/<base>.comments.json` for others — **never inside the `.qmd`**. Each thread:

```json
{ "id": "c…", "resolved": false,
  "anchor": { "start": 1234, "end": 1270, "quote": "the EXACT text the comment targets",
              "prefix": "…32 chars before", "suffix": "…32 chars after" },
  "messages": [ { "author": "You", "body": "Please cite Smith 2020 here.", "createdAt": "…" } ] }
```

`anchor.quote` is the exact manuscript text the note is about — that's how you know *where* each
comment applies. **Procedure when the user says "address my comments":**

```bash
# 1. list open threads across EVERY project document (JSON: doc, id, quote, messages)
{{FLUX_CLI}} comments            # add --all for resolved; --doc rel targets one document
# 2. for each thread: locate anchor.quote in the .qmd, make the requested change
{{FLUX_CLI}} manuscript          # read, edit, then:
{{FLUX_CLI}} set-manuscript --file revised.qmd
# 3. mark it resolved (by id or a unique substring of the quote), optionally reply
{{FLUX_CLI}} resolve-comment c… --note "Added the Smith 2020 citation."  # unique project-wide id
```

Bare `comments` and `resolve-comment` are project-wide so secondary and Context-document
threads cannot be missed; pass `--doc rel` only when deliberately targeting one document.
`resolve-comment` flips `resolved:true`, appends your reply (stamped with your client identity +
time), holds the `manuscript` lock, and journals it. MCP equivalents: `list_comments`,
`resolve_comment`. You *can* edit `comments.json` directly, but prefer the verb — it's
locked + journaled, and when the app is open it **live-refreshes the margin** so the user sees
threads close in real time.

Notes: don't rewrite `comments.json` while the user is actively composing a comment (the live
refresh is skipped during a draft to protect their in-progress work). Resolve a comment only
after you've actually addressed it in the prose.

**Asking the user something:** open your OWN thread with
`flux add-comment --quote "exact doc text" --body "your question" [--doc rel] [--at n]` —
it appears live in their margin; they reply at their leisure. Use it instead of guessing.

## The feedback ledger (context-stamped notes from anywhere in the app)

Comments cover manuscript text; the **feedback ledger** covers everything else. The user hits
a hotkey anywhere in the app and types a one-liner; the note lands in `.meta/feedback.ndjson`
**stamped with what they were looking at** — active figure, selected elements, drilled-in plot
part, paper doc + selection offsets + quoted text, or slide + beat. "Make this bigger" arrives
with *this* machine-resolved.

```bash
flux feedback                 # open notes (JSON; `where` = human summary, `context` = full stamp)
# … address each item (regenerate/restyle/edit) …
flux resolve-feedback <id|text substring> --note "what you did"   # user sees it close live
```

A `send` event in the ledger marks a **review-pass boundary** — everything open is a work
order (this is what wakes `flux attend`). MCP: `list_feedback` / `resolve_feedback`.
The ledger is event-sourced and append-only — never rewrite it; use the verbs.

## Context docs are documents too

`Context/Project/MISSION.qmd`, `Context/NOTEBOOK.md`, and `Context/RULES.md` open in Flux
Paper like any document, and comments work ON them — the user may leave threads on the
mission or on your notebook (treat those as corrections to your understanding/memory and
address them first).

## Live edits (optional, figure-only, app must be open)

When the Flux app is open it serves a loopback control bridge (`.meta/live/bridge.json` holds
the `url` + bearer `token`). Via MCP:

- `get_app_context` → what the user currently has selected: `activeFigureId`, `selection`,
  and `partSelection` (the drilled-in plot part, e.g. panel d's control line), plus a digest of
  the active figure.
- `dispatch_command` / `act_on_selection` → apply an **undoable** edit (same as the user's own;
  Ctrl+Z reverts it). Allow-listed: `restyle_part`, `set_style`, `arrange`, `align`,
  `distribute`, `auto_label`, `group`, `set_z`, `create_figure`, `select`, … (figures only —
  there is no live prose/comment dispatch; do those via files).

"Replot panel 4d's control series in green" has two readings:
- *Restyle it live:* `act_on_selection {patch:{stroke:"#66800B"}}` (acts on the drilled-in part).
- *Regenerate the data* (true replot): there's no live rerun — use the file verb
  `rerun-plot plots/<name>.recipe.json …`; the open app hot-reloads the panel, keeping overrides.

If `.meta/live/bridge.json` is absent, the app is closed → use the file verbs instead.

## Wiring MCP into a standalone agent (per analysis project)

The **principal and dispatched workers get MCP automatically** (the `{mcpJson}` roster
placeholder — `AGENTS-CONFIG.md`); this section is only for a standalone session you start
yourself. The server's project root is fixed at launch, so configure it per analysis
project (ready-to-copy versions of these: `TEMPLATES.md`). For **Codex**,
`<analysis-dir>/.codex/config.toml` with the final argument set to the Flux project path:

```toml
[mcp_servers.flux]
command = "node"
args = ["{{FLUX_MCP_PATH}}", "/data/microns_analysis/paper"]

[mcp_servers.flux.env]
FLUX_CLIENT = "codex"
```

For **Claude Code**, use `<analysis-dir>/.mcp.json`:

```json
{ "mcpServers": { "flux": {
  "command": "node",
  "args": ["{{FLUX_MCP_PATH}}", "/data/microns_analysis/paper"],
  "env": { "FLUX_CLIENT": "claude" }
} } }
```

Point the last arg at *this* project's Flux folder. MCP gives you typed verbs and, crucially,
`get_figure_image` (inline figure PNGs — the look step) and the live bridge. The pure-CLI path
always works as a fallback.
