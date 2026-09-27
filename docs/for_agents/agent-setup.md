# Flux agent setup: implementation and verification

For agents maintaining setup or wiring the AI status monitor. User-facing instructions
are in [Working with agents](../agents/collaboration.qmd).

1. Call `probeAgents()` in Electron main (or flux-core), then pass its snapshot as
   `planSetup({probe, agents?, createLocalBin?, useThisInstall?})`. Planning is pure.
   Show the plan's actions, checks and next steps. `applySetup(plan, {yes})` requires
   confirmation for replacing existing MCP registrations and rechecks file baselines.
   Generate plans in main; do not accept arbitrary renderer-supplied file actions.
2. `planRemove({probe, agents?})` / `applyRemove(plan, {yes:true})` remove only owned
   integrations. They restore prior registrations, retain unrelated edits and keep the
   shared launcher installed. Edited stock skills are retained with a disconnected
   receipt, so the next sync cannot reconnect them accidentally.
3. `doctor()` returns per-check statuses and fixes. The CLI's JSON form and read-only
   core MCP `connect_doctor` wrap them in `{checks}`. The flux-core `connectDoctor`
   adapter accepts a `checkReceipt` dependency for the receipt engine; requesting receipt
   verification without that dependency returns an explicit error.
4. Verify through the hermetic runner: `--tier pure --only agent-setup`,
   `--only connect-doctor`, `--only skill-template`, then the full pure tier.
   Never run these scripts directly against a real home. Fixture binaries record argv,
   emulate user-scope MCP writes and exercise vendor failures. Build before validating
   the bundled CLI. UI/native/packaging acceptance belongs to integration.

The shared implementation is `electron/agentSetup.cjs`. It uses `fluxPaths.cjs` for
launcher resolution and installation, `processRunner.cjs` for bounded vendor processes,
and an operation lease for setup/sync serialization. Files use atomic replacement and
exclusive date-stamped backups. A removed or updated skill directory is backed up as a
`flux-skill-backup-v1` JSON file containing each relative filename, base64 bytes and mode.
This avoids putting a second discoverable SKILL.md inside the vendor's skills directory.

`ensureFluxConfig` refreshes only installed, unedited managed stock skills and publishes
UserContext skills for already-connected vendors, including on its fast path. Vendor
capability probes run in temporary homes, and doctor launches Flux children with
initialization disabled. Doctor requests `--toolset full` for its >=100-tool check;
the default core toolset stays compact. The doctor inspects hook installation, not the
vendor's private hook-trust database. No setup/removal tool is registered over MCP.

Vendor contracts verified on 2026-09-27:

- Claude's installed `mcp --help`, `mcp add --help`, and `mcp add-json --help` confirm
  user scope, single-JSON registration, and the variadic `--env` option. Setup puts
  `flux` before that option and uses `--` before the server executable. The current
  [MCP documentation](https://code.claude.com/docs/en/mcp) confirms these forms.
- [Claude skill frontmatter](https://code.claude.com/docs/en/skills) documents
  `disable-model-invocation` and `argument-hint`. The template preserves both for
  Claude. No `allowed-tools` grants are installed.
- [Codex skills](https://developers.openai.com/codex/skills) documents
  `~/.agents/skills`, symlink discovery and `policy.allow_implicit_invocation: false`
  in `agents/openai.yaml`. That policy is added to the plan's metadata template.
  The Codex render omits `argument-hint`; the installed Codex 0.157.1 app-server
  discovered this rendered skill in a scratch home with no parsing errors, including
  the retained `disable-model-invocation` field.
- [Codex configuration](https://learn.chatgpt.com/docs/config-file/config-reference)
  confirms `mcp_servers.<id>.tool_timeout_sec`, `command`, `args`, and `env`.
  [Codex hooks](https://developers.openai.com/codex/hooks) documents UserPromptSubmit,
  `hooks.json`, `statusMessage`, and hook trust through `/hooks`. Installed 0.157.1
  reports `hooks stable true` from `features list`. Setup detects that capability
  per installation; older or binary-less installations get a warning and retain
  MCP refresh. An explicitly disabled hooks feature is not silently enabled.
- [Claude hooks](https://code.claude.com/docs/en/hooks) documents UserPromptSubmit and
  `statusMessage`. Flux uses its exact statusMessage as the ownership marker and
  merges handlers without replacing user hooks.

The refresh command itself belongs to the delta engine; setup only installs its
`"<launcher>" connect --hook-delta` invocation. No real-home registration or live
model invocation was needed for this verification. Windows forms are tested as strings
and through the platform-aware fake executable fixture; native Windows, macOS and
packaged-app acceptance still require their respective integration runners. Other
vendors receive manual instructions; automatic registration is limited to Claude and Codex.
