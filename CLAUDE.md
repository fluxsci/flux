# Flux — notes for agents

## The Paper editor's editing feel is LOCKED

The cursor/typing/editing feel of the manuscript editor
(`src/shell/modes/paper/**`) was overhauled and hand-tuned in July 2026 and
the owner wants it to stay **exactly** as it is. Before touching anything in
that module, read `src/shell/modes/paper/EDITING-FEEL.md` — it lists the
invariants (decorations are a pure function of the document, no block
atomicRanges, vim-first extension order, scroll margins, the 70ms caret
transition, focus-return discipline) and the verify-script gate.

Hard rules:

- Do NOT make major changes to cursor movement, typing behavior, or the
  editing feel unless the user explicitly asks for that specific change.
- After ANY paper-module change, run the `scripts/verify-paper-*.mjs` suite
  (plus `verify-fig-width.mjs`, `verify-citegroup.mjs`,
  `npx tsx scripts/verify-citenum.ts`) against the dev server on :1420. These
  scripts encode the feel contract — if one fails, fix the regression rather
  than loosening the test.

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
