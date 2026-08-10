# `docs/for_agents/` — runbooks written to be executed, not read

Everything in this folder is addressed to **an AI agent working on a user's behalf**, not to a
user browsing the documentation. These are step-by-step procedures with verification after each
step, written so an agent can carry them out without rediscovering the reasoning.

**Nothing here is rendered into the user-facing site.** The Docs button and
`quarto preview docs` show the Quarto website built from `docs/**/*.qmd`; this folder is
excluded twice over — it holds `.md` files only (the render globs are `.qmd`-only), and
`_quarto.yml` names `!for_agents/**` explicitly. `scripts/verify-docs.ts` gates both facts, so a
`.qmd` dropped in here fails the pure tier rather than quietly appearing in the sidebar.

That separation is the point: these documents talk about machine setup, sudo prompts, and
failure forensics in a register that would be wrong in the user docs, and they may be long and
exhaustive where a user page must be short.

| Document | What it does |
|---|---|
| [`claude-install-flux-mac.md`](claude-install-flux-mac.md) | Takes a Mac from a bare clone to a verified, fully capable Flux install. The executable counterpart to the human-facing `../installation.qmd`. Invoked by the user saying *"read `docs/for_agents/claude-install-flux-mac.md` and set up Flux on this Mac."* |
| [`cross-machine-sync.md`](cross-machine-sync.md) | Builds continuous folder sync between two of the user's own computers (Syncthing over a mesh VPN), including the application-side changes that make a folder safe to sync at all. Generic — not Flux-specific. |

## Writing another one

- **`.md`, never `.qmd`.** The extension is what keeps it out of the site.
- **Say who it's for in the first paragraph**, and say what the human-facing page is if one
  exists. An agent that lands here should know within two sentences whether it's in the right
  document.
- **Verify after every step.** A runbook whose steps can silently half-succeed is worse than no
  runbook, because it produces confident wrong reports.
- **Record the failures that cost real time**, with their exact symptom — the symptom is what a
  future agent will have in hand, not the cause.
- **Add a row to the table above.** These are meant to be found.
