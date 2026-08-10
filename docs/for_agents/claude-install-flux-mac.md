# Flux — full install runbook for macOS (agent-facing)

> **This document is written for an AI agent** (Claude Code or similar) running inside a
> fresh clone of this repo on a user's Mac. It lives in `docs/for_agents/`, which is
> deliberately **not** part of the rendered user documentation (see the README there). The
> human-facing overview lives in `../installation.qmd` — this file is the executable,
> step-by-step version of it, with verification after every step.
>
> **How a user invokes this:** they clone the repo, open a Claude Code session in it, and
> say something like *"Read docs/for_agents/claude-install-flux-mac.md and set up Flux on this Mac."*
> Your job is to take the machine from "bare clone" to "fully ready to go", verify it, and
> then (only if the user says yes) drop a double-clickable launcher on their Desktop.

---

## 0. Ground rules for the agent

Read these before running anything:

1. **This is the user's machine, not the Flux dev box.** Nothing in `AGENTS.md` /
   `AGENT_ENGINEERING_GUIDE-RUNNING.md` about the owner's Linux desktop, `:1420` dev
   servers, or `--ozone-platform=x11` applies here. Do not start dev servers, do not run
   the UI test tiers, do not commit or push anything.
2. **Privileged steps go through the native macOS password pop-up — never ask the user to
   paste sudo commands, and never run plain `sudo` yourself** (your shell has no tty for its
   prompt). When a step needs root — in this runbook only the Quarto installer is expected
   to — run it as:

   ```bash
   osascript -e 'do shell script "<the command>" with administrator privileges'
   ```

   macOS shows its standard authentication dialog; the password goes to the OS, never
   through you or the terminal. **Tell the user a pop-up is coming and what it's for
   *before* triggering it**, and never route anything through it that doesn't strictly need
   root. If the dialog can't work (non-admin account, no GUI session — e.g. SSH), fall back
   to giving the user the exact `sudo` command to run in their own terminal.
3. **Check before you install.** Every step starts with a detection command. If the tool is
   already present and satisfies the version requirement, say so and skip the install. This
   runbook must be safe to re-run on a half-finished install.
4. **Ask before touching shell config.** Additions to `~/.zshrc` are append-only, wrapped in
   the marked block shown in step 2, and you tell the user what you added.
5. **Verify each step before moving on.** Each step ends with a ✅ check. If a check fails,
   stop and fix it (or report it) — don't pile steps onto a broken base.
6. **Steps marked 🧑 need the user at the keyboard** (the admin password pop-up, visually
   confirming the app window). Narrate what they should do and wait.
7. At the end, produce the **final report** (section 14) so the user knows exactly what was
   installed, what was skipped, and what (if anything) is left.

**What "fully ready to go" means** (the finish line):

- [ ] Node 22 (≥ 22.12) usable from a login shell
- [ ] `npm ci` completed in the Flux repo; Electron 43 launches
- [ ] `npm run build` produced `dist/` (renderer + `flux-cli.mjs` + `flux-mcp.mjs`)
- [ ] First run initialized `~/FluxConfig` and installed the `flux` shim in `~/.local/bin`
- [ ] `~/FluxConfig/agents.json` defaults point at **claude** (this machine has Claude Code)
- [ ] Quarto + TinyTeX (+ `lineno`, `setspace`) installed; `quarto check` clean; user docs rendered for the in-app
      Docs button
- [ ] uv installed; fluxplot cloned to `~/fluxplot` and importable
- [ ] Lighttable sidecar installed and built (`lighttable/`: its own `npm ci` + `npm run build`)
- [ ] The app itself launched and the user saw the window
- [ ] (Optional, user's choice) `LAUNCH-FLUX.command` on the Desktop

---

## 1. Preflight

```bash
sw_vers                          # confirm macOS
uname -m                         # arm64 (Apple Silicon) or x86_64 (Intel) — note it
git rev-parse --show-toplevel    # run from inside the clone; this is $FLUX_REPO below
xcode-select -p                  # Command Line Tools path (git worked, so this exists)
```

Set a working variable for the rest of the session (don't assume `~/flux` — use what
`git rev-parse --show-toplevel` printed):

```bash
FLUX_REPO="$(git rev-parse --show-toplevel)"
```

Sanity-check the clone is the real thing: `test -f "$FLUX_REPO/package.json" &&
grep -q '"name": "flux"' "$FLUX_REPO/package.json"`.

Also check whether Homebrew is present:

```bash
command -v brew
```

**Homebrew is optional and this runbook never installs it.** If it's already there, use it
where noted (Node); if not, every step below has a brew-free path that needs no terminal
password prompts. (The reason it's excluded: Homebrew's own installer refuses to run as
root and drives `sudo` interactively on a tty, so it's the one install that can't go
through the pop-up mechanism from ground rule 2. If the user wants Homebrew for their own
reasons, they can install it themselves any time — nothing here depends on it.)

✅ **Check:** you know `$FLUX_REPO`, the CPU arch, and whether brew is available.

---

## 2. Node 22

Flux's engine floor is **Node ≥ 22.12** (`package.json` engines; `.nvmrc` pins `22`; CI and
the release pipeline build on 22). Use the Node 22 LTS line specifically — newer "Current"
majors are untested against Electron 43 + electron-builder.

```bash
node --version 2>/dev/null       # ≥ v22.12 → skip to step 3
```

If missing or too old, install via **nvm** (no sudo, no password; this is the README's
documented path):

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh"
nvm install 22 && nvm alias default 22
```

nvm's installer wires itself into `~/.zshrc`. Additionally append this marked block (it
puts `~/.local/bin` on PATH for the `flux` command installed in step 5; put any later PATH
additions inside this same block, and tell the user what you added):

```bash
# >>> flux install (managed by the Flux install runbook) >>>
export PATH="$HOME/.local/bin:$PATH"
# <<< flux install <<<
```

**If Homebrew is already present**, `brew install node@22` is an equivalent alternative —
it's keg-only, so add `export PATH="$(brew --prefix node@22)/bin:$PATH"` inside the marked
block too.

✅ **Check:** in a fresh shell, `node --version` prints v22.x with x ≥ 12, and
`npm --version` works. Record the output of `dirname "$(command -v node)"` — the launcher
in step 13 bakes this path in.

---

## 3. Install dependencies and build Flux

From `$FLUX_REPO`:

```bash
cd "$FLUX_REPO"
npm ci          # reproducible install from the committed package-lock.json
```

Notes:

- This downloads the Electron 43 binary (~100 MB) — needs network, takes a few minutes.
- Flux has a **prebuilt-only native-dependency posture** (`npmRebuild: false`): nothing
  compiles, so no Xcode beyond the Command Line Tools is needed. If npm tries to build
  anything from source, something is wrong — stop and investigate rather than installing
  compilers.
- Don't use `--omit=dev`: Electron itself is a devDependency.

Then build:

```bash
npm run build
```

`npm run build` = `vite build` (renderer → `dist/index.html` + `dist/assets/` +
`dist/pdfjs/`) **plus** the slide-export sidecar (`dist/slide-export-assets.json`) **plus**
the bundled agent CLI (`dist/flux-cli.mjs`, `dist/flux-mcp.mjs`). All three matter — never
substitute plain `vite build` here (it would leave the CLI bundle stale or missing, and the
`flux` shim in step 5 points at it).

Treat any esbuild `import-is-undefined` warning during the build as an error and report it
— on a fresh tagged clone there should be none.

**Lighttable (install by default):** Flux's top bar has a launcher button for Lighttable —
the image-set contact-sheet viewer that lives in `lighttable/` as a self-contained sidecar
app (its own dependencies and its own build; nothing is shared with Flux's). Set it up now
so the button just works:

```bash
cd "$FLUX_REPO/lighttable" && npm ci && npm run build && cd "$FLUX_REPO"
```

✅ **Check:**

```bash
npx electron --version                 # v43.x.x
test -f dist/index.html && test -f dist/flux-cli.mjs && echo dist-ok
node dist/flux-cli.mjs version         # prints version + commit + build date
test -f lighttable/dist/index.html && echo lighttable-ok
```

If `npx electron --version` fails with a missing-binary error, the Electron download was
interrupted: `rm -rf node_modules/electron && npm ci` and retry.

---

## 4. First run of the machine layer (`~/FluxConfig`)

**Order matters here:** create `~/.local/bin` *before* the first CLI run — Flux installs its
`flux` command shim there, but only if the directory already exists (it deliberately never
invents `~/.local/bin`).

```bash
mkdir -p ~/.local/bin
node dist/flux-cli.mjs config
```

That one command runs the full first-run initialization (the app does the identical thing on
first launch): it creates **`~/FluxConfig`** (the user-level home for everything Flux:
agent context, the FluxLib reference library, presets), seeds
`~/FluxConfig/Context/UserContext/` (blank, user-owned templates) and
`~/FluxConfig/Context/FluxContext/` (the stock agent docs), writes a default
`~/FluxConfig/agents.json`, and installs the `~/.local/bin/flux` shim. Machine-level
preferences live at `~/Library/Application Support/flux/preferences.json` (lowercase
`flux` — created automatically; never create or reference a capital-F `Flux` path).

✅ **Check:**

```bash
node dist/flux-cli.mjs config              # prints resolved FluxConfig/FluxLib paths
test -x ~/.local/bin/flux && echo shim-ok
test -f ~/FluxConfig/agents.json && echo agents-ok
```

And in a **fresh** shell (so the step-2 PATH block is active): `flux version` works.

---

## 5. Point the agent roster at Claude

`~/FluxConfig/agents.json` seeds with **Codex as the default principal**. This machine has
the Claude Code CLI, so switch the standing defaults. Edit only the `defaults` object —
leave the `families` section (both `codex` and `claude` templates) intact:

```json
"defaults": {
  "principal": { "family": "claude", "model": "fable",  "effort": "default" },
  "worker":    { "family": "claude", "model": "sonnet", "effort": "default" },
  "pass":      { "family": "claude", "model": "fable",  "effort": "default" }
}
```

(The `claude` family's model menu is `fable | opus | sonnet`. The user can change any of
this later — interactively via the `flux principal` picker, which remembers the last choice,
or by editing this file.)

✅ **Check:** `python3 -c "import json;json.load(open('$HOME/FluxConfig/agents.json'))"`
parses clean, and `claude --version` works (it should — the user was told to have Claude
Code installed; if it's missing, flag it in the final report).

---

## 6. Quarto + TinyTeX (manuscript compilation)

Flux detects Quarto at runtime and uses it for `flux compile` and Word/PDF export of
manuscripts; it also renders this repo's user docs for the in-app Docs button.

```bash
quarto --version 2>/dev/null     # present? skip the install
```

🧑 **Install** — download the official installer yourself, then run it through the macOS
admin pop-up (ground rule 2). Quarto ships **one universal `.pkg`** for both arm64 and
x64:

```bash
PKG_URL="$(curl -fsSL https://api.github.com/repos/quarto-dev/quarto-cli/releases/latest \
  | grep -oE '"browser_download_url": *"[^"]+macos\.pkg"' | cut -d'"' -f4 | head -1)"
curl -fsSL -o /tmp/quarto-macos.pkg "$PKG_URL"
```

Tell the user: *"macOS is about to show a password dialog — that's the Quarto installer
needing admin rights."* Then:

```bash
osascript -e 'do shell script "installer -pkg /tmp/quarto-macos.pkg -target /" with administrator privileges'
```

(Don't reach for `brew install --cask quarto` **as the agent** even when Homebrew is present
— the cask wraps this same `.pkg` in a tty `sudo` prompt your shell can't answer. That's a
limit on *how you install*, not on the result: the cask runs the identical official `.pkg`
and lands the identical `/Applications/quarto` + `/usr/local/bin/quarto` layout. So if the
detection step found a Homebrew-installed Quarto, it is fully supported — say so and skip
this step rather than reinstalling.)

Then the TeX layer for PDF output (no sudo; installs into the user account):

```bash
quarto install tinytex
# TinyTeX is NOT added to PATH by that install, so call tlmgr by absolute path —
# a bare `tlmgr` here fails with command-not-found on a fresh machine:
"$HOME/Library/TinyTeX/bin/universal-darwin/tlmgr" install lineno setspace
quarto check                     # should end with no errors
```

`tlmgr install` needs **no admin prompt** here — TinyTeX installs into the user's home
directory, so this is one of the steps that stays hands-off (ground rule 2).

Then add TinyTeX to the marked `~/.zshrc` block from step 2, so the user's own `tlmgr` and
`kpsewhich` work in future shells (Flux and Quarto locate TinyTeX internally and don't need
this — it's purely for the human):

```bash
export PATH="$HOME/Library/TinyTeX/bin/universal-darwin:$PATH"
```

Without TinyTeX, `flux compile --to pdf` fails while `--to html|docx` still work — so
TinyTeX is strongly recommended, not optional-in-practice. Without `lineno` and
`setspace`, ordinary PDF export still works but a **journal-styled** PDF (Nature and the
like) does not: those two supply the line numbers and double spacing a submission needs.

Journal PDFs also place Flux's SVG figures through `rsvg-convert`. If Homebrew is
present, `brew install librsvg` covers it; if not, leave it — Word export is unaffected,
and it is the format Nature prefers for submission anyway.

Finally, render the user docs once so the app's top-bar **Docs** button works (it opens
`docs/_site/index.html` and shows an error toast until this has been run):

```bash
cd "$FLUX_REPO" && quarto render docs
```

**Fonts:** nothing to do on macOS — the house styles fall back to fonts macOS ships
(Arial/Helvetica/Georgia/Times). This is a Linux-only concern.

✅ **Check:** `quarto check` clean; `test -f "$FLUX_REPO/docs/_site/index.html"`.

---

## 7. uv + fluxplot (the plotting layer)

fluxplot is Flux's semantic-plot Python library — a **separate repo** that, by convention,
**must live at `~/fluxplot`**: that is where agents look for it (and add it as an editable
dependency) when setting up analysis projects. Environments are uv projects.

```bash
uv --version 2>/dev/null || curl -LsSf https://astral.sh/uv/install.sh | sh
# (uv's installer drops binaries in ~/.local/bin — already on PATH from step 2.
#  `brew install uv` is an equivalent alternative.)

git clone https://github.com/fluxsci/fluxplot ~/fluxplot
```

If the HTTPS clone fails with an auth error (the repo may be private), ask the user how they
access it (SSH key → `git clone git@github.com:fluxsci/fluxplot.git ~/fluxplot`, or a
GitHub login via `gh auth login`).

Set up its environment and prove it imports (uv fetches a suitable Python automatically —
no system-Python wrangling):

```bash
cd ~/fluxplot
uv sync                                    # creates .venv from the committed uv.lock
uv run python -c "import fluxplot; print('fluxplot ok')"
```

Do **not** add fluxplot to the Flux repo or set PYTHONPATH anywhere — analysis projects
consume it per-project with `uv add --editable ~/fluxplot` (plus `uv add cmasher`); that's
covered by the stock agent docs in `~/FluxConfig/Context/FluxContext/PYTHON-CONVENTIONS.md`
and is per-project setup, not machine setup.

✅ **Check:** the import line above prints `fluxplot ok`.

---

## 8. Zotero — deliberately nothing to do

The user may well have Zotero installed. **Do not set up, configure, or even ask about
Zotero during this install.** The reference library (FluxLib) starts empty, and that is the
intended state — connecting a Zotero library happens later, entirely from inside the app
(Library mode → **Zotero** panel), guided by the user docs. No terminal work, no plugins,
no decisions now.

The only Zotero-related thing you do in this whole runbook is include the Zotero docs page
in the reading tips of your final report (section 14).

✅ **Check:** nothing — move on.

---

## 9. Health verification

Run these from `$FLUX_REPO` and require all of them green:

```bash
node --version                             # ≥ 22.12
npx electron --version                     # v43.x
npm run check                              # svelte-check: MUST be 0 errors 0 warnings
node scripts/run-verifies.mjs --tier bundle   # CLI bundle smoke (needs the step-3 build)
node dist/flux-cli.mjs config              # paths resolve; FluxConfig healthy
quarto check                               # quarto + tinytex
"$HOME/Library/TinyTeX/bin/universal-darwin/kpsewhich" lineno.sty setspace.sty   # journal-PDF prereqs
cd ~/fluxplot && uv run python -c "import fluxplot"
```

**Do not** treat the full test suite as an install gate, but if the user asks for a deeper
check, `node scripts/run-verifies.mjs --tier pure --jobs 4` runs the hermetic tier
(~150 scripts, a minute or two). Known macOS caveats — these are **platform assumptions in
the test scripts, not install breakage**:

- `verify-fluxconfig` and `verify-zotero-sync` isolate prefs via `XDG_CONFIG_HOME`, which
  macOS ignores → they fail on darwin by design of the scripts.
- Three slide-export scripts drive headless Chrome at the Linux path
  `/usr/bin/google-chrome` → they fail unless Google Chrome is installed and
  `FLUX_CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"` is exported.

Everything else in the pure tier should pass; report anything else that fails.

✅ **Check:** the seven commands in the block above all succeed.

---

## 10. First real launch

Launch the built app (production-style — loads `dist/`, no dev server):

```bash
cd "$FLUX_REPO" && ./node_modules/.bin/electron .
```

🧑 Ask the user to confirm: the Flux window opens, Home shows the Flux mark and the New/Open
buttons (the five mode icons appear in the top bar once a project is open), and — since step 6 ran — the **Docs** button near
the Settings gear opens the user documentation in their browser. Then they can quit it
(⌘Q), or keep it open.

Two useful pointers for the user at this moment (don't do these for them):

- `~/FluxConfig/Context/UserContext/WHO-AM-I.md` and `RULES.md` are blank templates —
  filling them in is how every future agent session learns who they are and how they like
  to work.
- The docs' **Getting started** page (Docs button → "Getting started") is the guided first
  project.

✅ **Check:** user confirms the window opened and quit cleanly.

---

## 11. Optional extras (offer, don't push)

- **Google Chrome + `FLUX_CHROME`** — only if the user intends to run the full test suite
  (see step 9). (Lighttable is not optional — it's part of step 3.)

---

## 12. Ask about the launcher

🧑 Ask the user, explicitly:

> "Everything is installed and verified. Do you want a double-clickable **LAUNCH-FLUX**
> launcher on your Desktop? Double-clicking it opens Flux directly — it rebuilds
> automatically only if you've updated the repo since the last build."

**Only if they say yes**, continue to step 13. If no, tell them the manual launch command
(`cd <repo> && ./node_modules/.bin/electron .`) and go to the final report.

---

## 13. Write the launcher

Write the file below to `~/Desktop/LAUNCH-FLUX.command`, substituting the two
`__PLACEHOLDERS__`, then `chmod +x ~/Desktop/LAUNCH-FLUX.command`.

- `__FLUX_REPO__` → the absolute repo path from step 1
- `__NODE_BIN_DIR__` → the absolute node bin dir recorded in step 2
  (`dirname "$(command -v node)"`)

Why a `.command` file: it's the native macOS "double-click a shell script" format — Finder
opens it in Terminal, so the user sees build output when a rebuild happens. Why the paths
are baked in: Finder launches with a minimal environment (no `~/.zshrc`), so the script
cannot rely on the user's interactive PATH — and Flux spawns external tools (`quarto`,
`claude`, recipe interpreters) with the PATH it inherits, so the launcher must provide a
complete one. Why it launches detached: otherwise closing the leftover Terminal window
would kill Flux mid-session.

```bash
#!/bin/bash
# LAUNCH-FLUX.command — double-click to start Flux.
# Generated by the Flux install runbook (docs/for_agents/claude-install-flux-mac.md).
set -euo pipefail

FLUX_REPO="__FLUX_REPO__"
NODE_BIN_DIR="__NODE_BIN_DIR__"

# Finder starts .command files with a bare environment — build a real PATH.
# Flux inherits this PATH for everything it spawns (quarto, claude, recipes).
export PATH="$NODE_BIN_DIR:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

cd "$FLUX_REPO"

# Rebuild only when the checkout moved past the last build (e.g. after `git pull`).
# The stamp lives in node_modules/ (gitignored) so it never dirties the repo.
STAMP="$FLUX_REPO/node_modules/.launch-flux-build-sha"
HEAD_SHA="$(git rev-parse HEAD 2>/dev/null || echo unknown)"
if [ ! -f dist/index.html ] || [ "$(cat "$STAMP" 2>/dev/null || true)" != "$HEAD_SHA" ]; then
  echo "Flux: building (first run, or the repo changed since the last build)…"
  npm run build
  echo "$HEAD_SHA" > "$STAMP"
fi

# Launch detached so this Terminal window can be closed without quitting Flux.
nohup ./node_modules/.bin/electron . >/dev/null 2>&1 &
disown
echo "Flux is starting — you can close this window."
exit 0
```

Notes for you (the agent):

- The file is created locally, so it carries no quarantine attribute — double-click works
  without a Gatekeeper override.
- First double-click: macOS may ask to allow **Terminal** access to the Desktop folder
  (TCC). That's expected; the user clicks Allow once.
- Flux holds a single-instance lock — double-clicking while Flux is already running just
  focuses the existing window, it never launches a second copy. Safe to over-click.
- If the user later moves the repo or reinstalls Node somewhere else, the two baked paths go
  stale — the fix is re-running this step.

✅ **Check:** run the launcher once yourself non-interactively
(`bash ~/Desktop/LAUNCH-FLUX.command`), then 🧑 have the user double-click it in Finder and
confirm Flux opens.

---

## 14. Final report

End your session with a summary containing:

1. **Installed / already present / skipped**, per component (Node, Electron deps, build,
   FluxConfig + shim, agents.json, Quarto + TinyTeX, docs render, uv, fluxplot,
   Lighttable, launcher) — with versions.
2. **Every file you created or modified outside the repo** (`~/.zshrc` block,
   `~/FluxConfig/agents.json` edit, `~/Desktop/LAUNCH-FLUX.command`, …).
3. **Anything left undone or needing the user** (e.g. Claude CLI missing, a failed check),
   each with the exact command or action to finish it.
4. How to launch Flux (the launcher, or the manual command), and how to update
   (`git pull` in the repo — the launcher rebuilds automatically; without the launcher,
   `git pull && npm run build`).
5. **Reading tips** — close with a short "where to go from here" list pointing at the user
   docs (the in-app **Docs** button, or `docs/_site/index.html`):
   - **Getting started** — the guided first project.
   - The **Zotero** page — connecting their Zotero library to Flux, done entirely from
     inside the app whenever they're ready (this is why the install skipped Zotero).
   - **Working with agents** — how Flux and agents like you collaborate on projects.

---

## Appendix: troubleshooting

| Symptom | Cause → fix |
|---|---|
| `npx electron --version` → missing binary | Interrupted download → `rm -rf node_modules/electron && npm ci` |
| `flux: command not found` | `~/.local/bin` missing at first run (shim never installed) or not on PATH → `mkdir -p ~/.local/bin`, re-run any verb (`node dist/flux-cli.mjs config`), check the step-2 PATH block |
| `flux` prints a stale version/commit | `dist/flux-cli.mjs` predates the checkout → `npm run build:cli` (or full `npm run build`) |
| Docs button shows "Docs aren't rendered yet" | `quarto render docs` hasn't been run in this checkout → run it (step 6) |
| Lighttable button errors ("isn't installed" / "isn't built yet") | The sidecar's own deps/build are missing → `cd lighttable && npm ci && npm run build` (step 3) |
| App can't find `quarto`/`claude` when launched from Finder | Finder PATH is minimal → launch via `LAUNCH-FLUX.command` (it exports a full PATH), or from a terminal |
| `flux compile --to pdf` fails, html/docx fine | No TeX → `quarto install tinytex`, then `quarto check` |
| `tlmgr` / `kpsewhich`: command not found (but TeX looks installed) | `quarto install tinytex` never touches PATH → call them at `~/Library/TinyTeX/bin/universal-darwin/`, and add that dir to the step-2 `~/.zshrc` block. Flux/Quarto are unaffected — they resolve TinyTeX internally |
| Launcher opens Terminal but no Flux window | Baked paths stale (repo moved / node reinstalled) → regenerate the launcher (step 13); check `dist/index.html` exists |
| Double-click does nothing / "cannot execute" | Lost the executable bit → `chmod +x ~/Desktop/LAUNCH-FLUX.command` |
| Admin password pop-up never appears / `osascript` errors ("Not authorized", −10004) | No GUI session (SSH’d in) or a non-admin account → fall back per ground rule 2: give the user the exact `sudo` command to run in their own terminal |
| Pure-tier failures on macOS: `verify-fluxconfig`, `verify-zotero-sync`, 3 slide-export scripts | Known platform assumptions in the scripts (XDG isolation; Linux Chrome path) — not an install problem; see step 9 |
