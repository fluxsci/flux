# TODO

Open work for this repo. *Deliberate* non-goals — things decided against, not pending —
belong in `docs/AGENT_ENGINEERING_GUIDE-RUNNING.md` §10 ("don't 'fix' these"), not here.

## Known issues

- [ ] **FluxContext docs go stale when the checkout moves.** `syncFluxContext`
      (`electron/fluxPaths.cjs:534-541`) gates re-sync on `FLUX_CONTEXT_HASH` — a hash of the
      *shipped templates* — and when that hash is current it writes only missing files, never
      rewriting existing ones. But the docs have the absolute CLI path substituted into them
      (`{{FLUX_CLI}}`, `{{FLUX_MCP}}`, `{{FLUX_MCP_PATH}}`, `{{LIGHTTABLE_DIR}}`, `{{FLUX_REPO}}`,
      `:543-550`). Move the repo and `~/FluxConfig/Context/FluxContext/*.md` keep telling every
      agent to run `node /old/path/dist/flux-cli.mjs`, indefinitely. The `~/.local/bin` shim
      *does* self-heal (`cliShimUpToDateSync`, `:472-482`); the docs don't.
      **Needs a decision before patching:** the current behavior is deliberate — the comment at
      `:535-537` notes that a dev CLI and a packaged app resolve different `{{FLUX_CLI}}` strings,
      so rewriting on every engine switch would churn the folder. The stamp already records `cli`
      (`:561`) but nothing reads it. Options: re-sync on path change (churns on engine switch), or
      warn and leave the files alone. Gate is `scripts/verify-fluxconfig.ts`, which fails on macOS
      by design (XDG isolation) — verify on Linux.
- [x] **`electron:build` skips half the build.** `package.json` has
      `"electron:build": "vite build && electron ."` — plain `vite build`, so no export assets and
      no `dist/flux-cli.mjs` / `dist/flux-mcp.mjs`. Anyone using it hits the stale-CLI symptom the
      install runbook documents. Should be `npm run build && electron .`.
- [x] **README links into `notes/`, which is gitignored.** Lines 266-267 point at
      `notes/Flux_Agent_Native.md` and `notes/Flux_Agent_Layer.md`; per guide §10:581 `notes/` is
      on-disk only and never committed. Both are 404s on GitHub. Either relocate the content into
      `docs/` or drop the links.
- [x] **README misdescribes `npm run build`.** The scripts table says "Production web build →
      `dist/`"; it is actually `vite build && tsx scripts/gen-export-assets.ts &&
      node scripts/build-cli.mjs` — renderer *plus* slide-export assets *plus* the agent CLI
      bundles. The current wording makes substituting plain `vite build` look safe.

- [x] **TinyTeX is never put on PATH, so the docs' own TeX commands fail.** `quarto install tinytex`
      installs into `~/Library/TinyTeX` (macOS) / `~/.TinyTeX` (Linux) but does not add its bin dir
      to PATH — verified on macOS arm64 with quarto 1.10.18, where `lineno.sty`, `setspace.sty` and
      `rsvg-convert` were all present yet `kpsewhich` and `tlmgr` were both command-not-found.
      Two consequences: the verification step (`installation.qmd:82-85`) reports a broken TeX setup
      that is actually fine, and — worse — the *install* step `tlmgr install lineno setspace`
      (`installation.qmd:72`, runbook step 6) cannot run at all on a fresh machine. Since runbook
      ground rule 5 says stop on a failed check, an agent following it gets stuck there.
      Fix: document the PATH addition in both docs (`~/Library/TinyTeX/bin/universal-darwin` on
      macOS, `~/.TinyTeX/bin/*` on Linux), fold it into the runbook's marked `~/.zshrc` block from
      step 2, and call `tlmgr` by absolute path in the runbook's install step so it works before any
      shell config exists. Note in the docs that this does *not* affect Flux — Quarto resolves its
      own TinyTeX internally, so `flux compile --to pdf` works either way.

## Features

## Other

- [x] **Nothing gates dependency advisories.** `main` was shipping 13 of them (9 high) in
      `package-lock.json` until 9e5261b, and only turned up because someone ran `npm audit fix`
      by hand. `.github/workflows/ci.yml` has no audit step, so this recurs silently. Add one for
      both trees (root + `lighttable/`), and decide the failure threshold — `--audit-level=high`
      is the obvious start, since a `moderate` floor will block on transitive noise. Note that a
      hard gate means an unrelated PR can be blocked by an advisory published that morning; a
      scheduled job that opens an issue may fit better than a per-PR gate.
- [ ] **Migrate the toolchain from Node 22 to Node 24.** Node 24 is now the LTS line; the repo
      pins 22 in five places, and the prose reason given for the pin is out of date. Sites to
      change together: `.nvmrc` (`22`), `package.json` `engines` (`>=22.12`),
      `.github/workflows/ci.yml:29,65`, `.github/workflows/release.yml:34`, the README's Node
      section (its "odd/non-LTS 'Current' releases aren't tested" wording no longer describes 24)
      and its `EBADENGINE` troubleshooting row, `docs/installation.qmd:39-47`, and step 2 of
      `docs/claude-install-flux-mac.md` ("newer 'Current' majors are untested against Electron 43
      + electron-builder").
      **The gating question is electron-builder + Electron 43 under Node 24**, not application
      code — so verification means a real packaged build on *both* platforms (`dist:mac`,
      `dist:linux`), not just `npm run check` and the pure tier.
      Expect a one-time lockfile diff from the bundled npm going 10 → 11 (it records `license`
      fields npm 10 omitted). Land that churn as its own commit so it can't hide a dependency
      change — see the Hono 2.x bump that arrived transitively this way.
- [x] **The install runbook is undiscoverable.** `docs/claude-install-flux-mac.md` expects a user
      to say "read `docs/claude-install-flux-mac.md` and set up Flux on this Mac", but nothing
      links it — not the README, not `installation.qmd` (only a session-log mention in the
      engineering guide). Link it from both. Use the absolute GitHub URL from `installation.qmd`:
      the runbook is deliberately excluded from the rendered site (`_quarto.yml` renders `.qmd`
      only), so a relative link would break in `docs/_site`.
- [x] **`~/flux` and `~/fluxplot` read as equally mandatory in `installation.qmd`; only one is.**
      The repo path is pure convention — everything resolves from `__dirname`
      (`resolveRepoDirSync`, `electron/fluxPaths.cjs:450-452`); what actually matters is that the
      checkout doesn't *move* after setup. `~/fluxplot` is a hard requirement: it's hardcoded with
      no substitution in the shipped context docs (`resources/flux-context/PYTHON-CONVENTIONS.md:20,26,29`,
      `PLOTS-AND-STYLE.md:13`), so agents run `uv add --editable ~/fluxplot` verbatim. Say which is
      which. (`docs/lighttable.qmd:50` makes the same `~/flux` assumption.)
- [x] **README doesn't mention the companion tools.** The Develop walkthrough claims "a clean Mac
      to a running app" — true, but that app can't compile a PDF, has no semantic plots, and has a
      Lighttable button that errors. Add a short table (tool / what breaks without it / link to
      `installation.qmd`); don't inline the install steps, since `installation.qmd` already carries
      the per-platform TeX matrix and a second copy would drift. Correct the framing while there:
      Quarto isn't optional (compile + the in-app Docs button), TinyTeX is PDF-only, `lineno` +
      `setspace` are journal-style-only, fluxplot is the keystone, Lighttable is genuinely optional.
      Related signposting bug: `installation.qmd:33-36` mentions Lighttable and links
      `lighttable.qmd` without saying the setup steps are there — and on that page they sit under a
      heading called **"Running it"** (`:46-52`), not an install heading. So on the page that *is*
      the installation checklist, the one companion whose steps live elsewhere gives no hint where.
      Either signpost the link or inline the two commands.
- [x] **The runbook's "don't use `brew install --cask quarto`" misleads human readers, and
      contradicts `installation.qmd`.** The cask downloads and runs the same official `.pkg`, giving
      an identical result — verified: `/usr/local/bin/quarto` is a root-owned symlink to
      `/Applications/quarto/bin/quarto`, quarto 1.10.18, exactly the `.pkg` layout. The runbook's
      actual reason (step 6) is that the cask drives `sudo` on a tty an agent's shell can't answer —
      a constraint on *how an agent installs*, not on the result. As written it reads as a blanket
      prohibition, so a human who used brew concludes they installed the wrong thing. Meanwhile
      `installation.qmd:56` positively suggests `brew install quarto`. Reword the runbook to scope
      the prohibition to the agent, and confirm a brew-installed Quarto is fully supported.
- [x] **`npm install` vs `npm ci` is inconsistent across the docs, in both trees.** Both commands
      are defensible (`install` to iterate, `ci` to reproduce), but the guidance should be uniform
      wherever a lockfile is committed — and one is committed in both.
      *Root repo:* the README says `npm install` while `installation.qmd:28` and the runbook say
      `npm ci`; the README never mentions the reproducible path at all.
      *Sidecar:* `docs/lighttable.qmd:51` and its troubleshooting row `:94` say `npm install`, while
      runbook step 3 says `npm ci`. `lighttable/package-lock.json` is committed and tracked, so
      `npm ci` is correct there too.
      *Also outside the docs* (missed on the first pass, caught when the Lighttable button told a
      user to run the install they had already run): the button's own error string in
      `electron/main.cjs`, and `resources/flux-context/LIGHTTABLE.md` — a **shipped** agent doc that
      propagates to every user's `~/FluxConfig`. Lesson for the next sweep of this kind: user-visible
      strings live in code and in `resources/flux-context/` too, not only in `docs/*.qmd`.
- [x] **`installation.qmd` introduces `~/FluxConfig` out of order, and omits the `~/.local/bin`
      ordering trap.** Two small fixes in one pass:
      (a) §2.5 "Agent CLIs" references `~/FluxConfig/agents.json` as though it already exists, but
      nothing says what creates it until the *following* section — "First run" (`:140-147`), which
      does explain it correctly. Read top to bottom you meet the file before its origin. Add a
      forward pointer in §2.5; no new content needed.
      (b) Neither section tells the reader to `mkdir -p ~/.local/bin` *before* first run. The shim
      installs only when that directory already exists — Flux deliberately never creates it
      (`installCliShim` returns early, `electron/fluxPaths.cjs:487`). `:146` states the condition
      ("when that directory exists") but never turns it into an instruction, so a reader following
      `installation.qmd` alone ends up with no `flux` command and only the reactive troubleshooting
      row at `:174` to recover. The runbook gets this right at step 4 — mirror its ordering.
