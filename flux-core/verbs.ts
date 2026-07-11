// WS-6.3 — the verb table (see registry.ts for the machinery). Migration is
// batched: registered verbs route through the registry on BOTH surfaces; verbs
// not yet here fall through to flux-cli's legacy switch / flux-mcp's manual
// registerTool blocks. Every entry must keep the EXACT observable behavior of
// the wrapper it replaces (verify-registry-parity.ts pins representative
// strings; verify-f1-mcp/w11-verbs/release-check stay green).

import type { VerbDef } from "./registry";
import * as model from "./model";
import * as references from "./references";

export const VERBS: VerbDef[] = [
  // --- batch 0: trivial project verbs ------------------------------------------
  {
    name: "list_project",
    cli: "list",
    summary: "List the project's documents, figures (with panel letters), and references.",
    params: {},
    cliArgs: [],
    handler: (ctx) => model.listProject(ctx.root),
    render: {
      // Both surfaces have always printed the JSON payload.
      human: (r) => ({ out: JSON.stringify(r, null, 2) }),
    },
  },
  {
    name: "reindex",
    cli: "reindex",
    summary: "Rebuild project.json.figures[] from fig/index.json.",
    params: {},
    cliArgs: [],
    handler: (ctx) => model.reindex(ctx.root),
    render: {
      human: (r) => ({ err: `✓ reindexed ${(r as { figures: number }).figures} figure(s)` }),
      mcp: (r) => ({ content: [{ type: "text", text: `reindexed ${(r as { figures: number }).figures} figure(s)` }] }),
    },
  },
  {
    name: "config_paths",
    cli: "config",
    aliases: ["config-paths"],
    summary:
      "Resolve Flux's machine-level paths as JSON: fluxConfigPath (the user's FluxConfig folder), fluxLibPath (the reference library, always <FluxConfig>/FluxLib), guidelinesPath, and userDataDir — plus `build` (version/commit/entry) identifying which Flux build is answering. Read every file in guidelinesPath before working — it holds the user's standing conventions for all Flux output.",
    params: {},
    cliArgs: [],
    handler: () => references.configInfo(),
    render: {
      human: (r) => ({ out: JSON.stringify(r, null, 2) }),
    },
  },
];
