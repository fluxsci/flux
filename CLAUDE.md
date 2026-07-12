# Flux — notes for agents

## Read the engineering guide first (every session)

Before doing substantive work in this repo, read
**`docs/AGENT_ENGINEERING_GUIDE-RUNNING.md`** in full. It is the living,
agent-maintained engineering guide: architecture, hard rules, the verification
system, recipes, known traps, and a session log. It also tells you how to
UPDATE it — corrections when you find something outdated, and a concise
datetime-stamped session entry after any major work. Treat that document as
part of your instructions for every session; this file is only the short list
of absolute invariants.

## Responsiveness above all (the Nielsen budgets)

Flux targets the Nielsen response-time limits as standing product policy —
the full framework is §6 of the engineering guide. The non-negotiable core:
every direct-manipulation interaction (typing, cursor movement, drag/pan/
zoom, selection, scrolling, search-as-you-type) must feel **instantaneous
(≤100ms)**, and slow operations are made fast rather than masked with
artificial latency. There is no "locked feel" anywhere in the app — editing
behavior can be changed when there's a reason, provided the responsiveness
budgets hold and the affected gates are updated with the change (never
silently loosened).

After paper-module changes, run the paper regression suite against the dev
server on :1420: `node scripts/run-verifies.mjs --group paper-gate`.

## Verification conventions

- `npm run check` — svelte-check, must stay at 0 errors.
- `scripts/verify-*.mjs` — puppeteer against `npm run dev` (port 1420), using
  `scripts/lib/driver.mjs`, `window.__fluxView`, `__fluxSeedFigures`,
  `__fluxSeedBib`.
- `scripts/verify-*.ts` — pure logic, run with `npx tsx`.

## Machine config paths (hard rule)

- Machine-level config resolves ONLY to the lowercase app dir
  (`~/.config/flux` on Linux; lowercase "flux" on macOS/Windows). Never build a
  path containing a capital-F "Flux" — the one legacy reference lives in
  `electron/fluxPaths.cjs` (`legacyUserDataDir`, migration source only).
  Display strings that must say "Flux" carry a `// flux-cap-ok` marker.
- All user-level Flux state lives in `~/FluxConfig` (pointer: `fluxConfigPath`
  in preferences.json). FluxLib is always DERIVED: `<FluxConfig>/FluxLib` —
  never persist or read a separate fluxLibPath.
- `scripts/verify-fluxconfig.ts` (pure tier) gates this; if it fails, fix the
  path, don't extend the allowlist.

## Repo etiquette

- Stage explicit paths only (never `git add -A` / `commit -a`) — parallel
  agent sessions may have unrelated work in flight in this tree.
- Check whether :1420 is already serving before spawning a dev server.
