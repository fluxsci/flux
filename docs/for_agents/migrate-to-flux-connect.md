# Migrate an existing Flux installation to flux-connect

This runbook is for an agent working for a user, including Lorenzo, who already has Flux
projects from before September 2026. It accompanies the [one-shot migration script](../../scripts/oneoff/migrate-2026-09-flux-connect.mjs).
The human-facing background is in [Your context and your project's](../agents/context.qmd).

The script is a historical migration record, independent of the app and its dependencies.
It needs **Node 22.15 or newer**. It does not launch Flux, run Git, install agents, or connect
an agent. Run it separately for each user's account on **every machine** with an existing
installation. A fresh installation needs setup, but has no old project state to migrate.

## 1. Update the checkout and stop writers

1. Locate the user's Flux checkout. Run `git status --short` there and preserve all local work.
   Pull the approved update with `git pull --ff-only`. If it cannot fast-forward, stop and
   report the local changes/divergence; do not reset, stash, rebase, or discard work for the user.
2. Verify that `scripts/oneoff/migrate-2026-09-flux-connect.mjs` exists in the updated checkout.
   Check `node --version` and the script's `--help`. No npm install or build is needed to run it.
   Update the installed Flux application too before reopening migrated projects.
3. Have the user save and close Flux and stop agents that write these projects. Disable any
   old installation's automatic launch while migrating. The script compares file baselines,
   but it is an offline migration, not a lock shared with an open editor.
4. Identify project roots and whether archived projects should be included. Choose a writable
   report directory outside the project trees; use the same directory for the dry run and apply.
   Reports include complete before/after text, so keep them private with the user's records.

Verify the checkout revision, Node version, root list, and absence of active project writers
before proceeding. Do not assume that upgrading one machine upgrades the others.

## 2. Dry run and inspect the report

From the report directory, use the script's **absolute path**. For example, after replacing
the checkout location and project roots with the user's actual paths:

```sh
node /path/to/flux/scripts/oneoff/migrate-2026-09-flux-connect.mjs --roots "$HOME/FluxProjects" /path/to/other/projects
```

The default is a dry run. **Its only write is a report in the current directory**; it changes
no project or machine state. It also prints the full report. The filename is
`migration-report-YYYY-MM-DD-HHMM.md`; same-minute runs add a numeric suffix so an earlier
report is never overwritten. Preserve this report for comparison with the applied result.

`--roots` accepts one or more directories and replaces the default discovery roots. With no
`--roots`, discovery uses HOME, `/data` when present, and absolute project roots in the
lowercase platform config directory's `projects.json`. It searches for `project.json` to a
maximum depth of six, skips `node_modules`, `.git`, `.claude/worktrees`, and symlink directories,
and skips paths containing an `archived` component. Add `--include-archived` deliberately if
those projects should be updated. A project deeper than the limit needs a nearer explicit root.
**Machine migration still examines this HOME even with explicit project roots.**

Read the entire report, including its discovery list, full proposed text edits, dependencies,
and `REVIEW`/`ERROR` entries. Confirm that every intended project is listed once and no
unintended project is listed. The planned work is:

- Move nonempty `Context/Transcripts`, `Context/Dispatches`, and `.meta/agent` into
  `.meta/archive/2026-09-agent-workflow/`, add an explanatory README, and remove empty source
  folders. Moves use filesystem rename, never copy, including across devices: a failed
  rename preserves the source and is reported.
- Rename `Context/Project/MISSION.qmd` to `Context/ProjectContext.qmd` and move its comments
  sidecar without changing thread IDs. Replace an exact historical template, or change only
  its exact generated title line in an authored document. Update the old path only within
  `project.json`'s `documentOrder`. Remove `Context/Project/` only if empty.
- Replace the notebook's first `## Session log` heading with `## Log`, and replace only the
  exact old generated comment and instruction line. Preserve body sections, dated H2 entries,
  and hand-written text.
- Replace `AGENTS.md` only when the whole text matches a historical generated guide/stub
  after LF and trailing-whitespace normalization. Create `CLAUDE.md` as `@AGENTS.md` only
  when absent; existing user instructions stay untouched.
- Remove the exact `.meta/agent/` ignore line; add `.meta/archive/`, `.meta/feedback/`, and
  `.meta/live/`. Git indexes are untouched. After review, a user who tracks the old archives
  needs to stage their old-path removals; the relocated archives remain on disk and ignored.
- Move `~/FluxConfig/agents.json`, `.agents-last.json`, and `agents.json.bak*` into
  `~/FluxConfig/.retired-2026-09/`. Remove only the old `flux` skill symlinks under
  `~/.claude/skills/` and `~/.agents/skills/` whose targets are proven to be a Flux checkout's
  `skills/flux`. The target directories stay intact, including when a link is dangling after
  an upgrade. Other skill directories/links and `flux.pre-neutral` are preserved and reported.

Review old-path links/includes manually; the script reports candidate documents but never
rewrites those links. It also flags a notes starter stored as MISSION with
**“not a mission — review it”**. Preserve the notes and decide their role with the user.
A nonempty `Context/Project/` is intentional preservation, not something to delete blindly.
Syncthing markers, conflict copies, known install leftovers, and running processes are
**reported only**. Nothing sync-related is removed or stopped. Stale stock FluxContext docs
are the updated app's responsibility; the migration leaves them alone.

## 3. Apply the reviewed migration

Proceed only when the user's authorization covers the concrete report. Show any collisions,
unrecognized instructions, or unexpected roots first. Use the **same roots and archived flag**:

```sh
node /path/to/flux/scripts/oneoff/migrate-2026-09-flux-connect.mjs --roots "$HOME/FluxProjects" /path/to/other/projects --apply
```

Read the new report and verify the exit status. `0` means no inspection error or failed/skipped
action; review notices may remain. `1` means inspection or application failed in part: completed
independent actions remain applied. Keep the report and the data. Do not report success solely
because some files moved.

Check the resulting ProjectContext and notebook text, comment thread IDs, `documentOrder`,
archive contents, stubs, and retired machine files against the dry run. In tracked projects,
inspect `git status --short` and `git diff` yourself; the script never invokes Git or stages
anything. Stage only explicit reviewed paths if the user requests it; do not delete archives.

Run the same `--apply` command again. A successful completed migration must say
**`Planned actions: 0`** and leave project/machine file bytes and mtimes unchanged. Its new
report file is expected. Persistent review notices (old links, authored stubs, sync leftovers)
are not additional planned mutations.

## 4. Connect agents and verify the updated app

Open the updated Flux application. Open **Flux → AI status**, choose **Connect an AI agent**,
and connect each agent the user uses (Claude Code, Codex). This is the setup step; its command-line
entry point is `flux-connect setup`. Review its proposed configuration changes before applying
when the user's authorization does not already cover them. Do not edit vendor config by hand
or reinstall the retired `flux` skill.

Verify the AI status monitor's per-agent and bundle checks, then open a migrated project.
Confirm its ProjectContext, notebook, and existing comments are visible. When the user asks
to connect a session, invoke `/flux-connect <project>` in Claude Code,
`$flux-connect <project>` in Codex, or `flux-connect <project>` in a shell. Verify the receipt's
project path and reading coverage. The root stubs are pointers; they do not connect automatically.

Repeat the update, dry run, migration, setup, and verification on every other existing machine.
Do not reopen a migrated tree in an older build, which may recreate retired files. A clean
reinstallation on another machine still needs agent setup; do not revive the old sync system.

## Troubleshooting and handoff

- **Destination exists / both mission paths or sidecars exist:** both are preserved. Compare
  them with the user; do not overwrite or merge comment IDs automatically. Rerun after a
  deliberate resolution. A sidecar collision prevents the mission rename.
- **EACCES / EPERM / EXDEV / EROFS:** the source stays in place. Resolve the permissions or
  filesystem layout, then rerun. Do not use copy-and-delete as a migration fallback.
- **Symlink path left untouched:** resolve and review the intended real location; pass an
  explicit real root. Do not bypass a symlink guard by deleting user links.
- **User-edited AGENTS.md or a hand-written notebook:** preservation is expected. Review and
  update it separately only when requested. Similar-looking generated text is not sufficient.
- **Report cannot be created:** choose a writable report directory. The script reserves and flushes its full
  report before applying any action. Existing reports are never replaced.
- **Interrupted apply:** inspect the saved report and filesystem before retrying. The full plan is flushed before the first action. A rerun completes a mission rename
  whose exact text update or sidecar move was interrupted. Per-file text writes are atomic,
  but the complete migration is not a single transaction. Keep any
  `.flux-migration-*.tmp` file for inspection; never discard a source to force progress.
- **Node too old / unknown arguments:** fix the invocation; no migration has started.

Give the user a concise handoff: checkout/app versions, report paths, projects covered and
excluded, applied counts, remaining review items/errors, agent setup results, and machines
still awaiting the update. Never claim a real-project migration from fixture tests alone.
