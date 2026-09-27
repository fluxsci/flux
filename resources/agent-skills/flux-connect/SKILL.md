---
name: flux-connect
description: >-
  Connect to Flux — the user's scientific writing studio — and get fully up to speed:
  the Flux primer, the user's own context (FluxConfig), and for a project its ProjectContext,
  rules, log, documents and figures. Use ONLY when the user explicitly says "flux-connect"
  (or /flux-connect, $flux-connect), with a project path, "global", or nothing. Loads a large
  amount of context, so never run it unasked. If the user asks for Flux work without it,
  suggest it instead.
argument-hint: "[project path | global] [--live] [--refresh]"
disable-model-invocation: true
---

# flux-connect

Target: `$ARGUMENTS` — Claude Code fills this in; elsewhere take the target from the user's
message. No target means: the Flux project containing the current directory, else global.

1. If you have the Flux MCP tools (a `connect` tool from the `flux` server), call `connect`
   with `target` set to the target (and `live` / `refresh` if the user asked).
   Otherwise run: `"{{FLUX_CLI}}" connect <target>` (add `--live` / `--refresh` as asked).
   Add `--depth full` only if the user asks you to read everything.
2. The result is a BRIEF. Complete its reading plan in full — every file and image it lists —
   preferring MCP `read_pack` / `get_pack_image` when you have them. If any section-end marker
   is missing, your tool cut the output: read the full brief from the path it gives.
3. Reply with the receipt exactly as the brief specifies, then stop and wait for the user.
   Do not edit files, start watching, or write to the project Log unless the user asks.

If `{{FLUX_CLI}}` does not exist, Flux was moved or updated: ask the user to open
Flux → AI status → Repair, or to run `flux-connect setup`.
