# Ship a Flux release (vX.Y.Z)

For an agent (or the owner) shipping a release from a reviewed, approved branch. The human-facing
pages are `../installation.qmd` (how users install and update) and `../RELEASE_QUALIFICATION.md`
(what the tag workflow does and the local deep-qualification tools). This runbook is the ordered
procedure with a check after every step. It assumes the work is already merged or ready to merge
into `main` and that the owner has approved it — nothing here decides *whether* to ship.

Ground rules: never `git add -A`; never loosen a gate; never tag a commit whose `ci.yml` is not
green; never publish the draft release yourself unless the owner asked for exactly that.

## 0. Preconditions (read, do not skip)

- [ ] `package.json` `version` is the release version, and `package-lock.json`'s first two
      `"version"` fields match it. Check: `node -p "require('./package.json').version"`.
- [ ] `CHANGELOG.md` has a section for this version with the shipped work, and its heading no
      longer says *unreleased* (change it to the release date on the day).
- [ ] `docs/installation.qmd` names the current version in its `--version` example.
- [ ] The branch is rebased on or merged into `main` locally, the tree is clean
      (`git status --short` prints nothing), and the local qualification below is green.

## 1. Local qualification (what CI will run, plus the browser tiers CI only observes)

From the repository root, Node 22, on a checkout with `node_modules` installed:

```bash
npm run check && npm run check:headless                 # 0 errors / 0 warnings
npm run build && npm run build:docs                     # the Vite bundle, CLI/MCP bundles, offline help
node scripts/run-verifies.mjs --tier pure --jobs 4      # the blocking CI tier (~20 min)
node scripts/run-verifies.mjs --tier bundle             # CLI + MCP handshakes against dist/
```

Then, with a dev server you own (`npm run dev` on :1420, or `FLUX_URL=http://127.0.0.1:<port>/`):

```bash
node scripts/run-verifies.mjs --tier ui                 # the observing ui-gate's suite
node scripts/run-verifies.mjs --group paper-gate        # the Paper regression suite
```

Check after each: the runner's last line reads `N/N passed; 0 failed/blocked/flaky`. A red that
passes 3/3 alone is attributed, not re-rolled — read the guide's §7 and §9 before touching a gate.
Kill the dev server you started when done.

Optional, when the release warrants it: `node scripts/release-check.mjs --platform linux --arch x64`
(every tier plus packaging on this machine; produces evidence under `release/`, never publishes).

## 2. Merge and push `main`

```bash
git checkout main
git merge --ff-only <branch>          # or the reviewed merge commit
git push origin main
```

Check: `gh run list --workflow=ci.yml --branch=main --limit=1` shows the new run; wait for it:
`gh run watch <id>` or poll until `conclusion: success` for the blocking `test` job. The
`ui-gate` and `test-windows` jobs are observing (`continue-on-error`); their result does not block
the tag, but a new red there is worth a look before shipping.

## 3. Tag and push the tag

Only after `ci.yml` is green on the exact commit you will tag:

```bash
v="v$(node -p "require('./package.json').version")"
git tag -a "$v" -m "Flux $v"
git push origin "$v"
```

Check: `gh run list --workflow=release.yml --limit=1` shows a run for the tag. It waits for the
green CI run, builds `Flux-mac-arm64.zip`, `Flux-mac-x64.zip` and `Flux-linux-amd64.deb` on their
native runners, smokes each packaged app with `scripts/verify-packaged-app.mjs`, and creates a
DRAFT release with `SHA256SUMS` and `install.sh`. Follow it with `gh run watch <id>`; a failed
smoke on one target fails that target only (`fail-fast: false`) — read its "Diagnose a macOS launch
failure" step before retrying.

## 4. Review the draft, then publish (owner's click)

```bash
gh release view "$v" --json isDraft,assets --jq '{isDraft, assets: [.assets[].name]}'
```

Check: `isDraft: true` and exactly five assets: the three installers, `SHA256SUMS`, `install.sh`.
Edit the generated notes if wanted (paste the `CHANGELOG.md` section). Publishing the draft on the
Releases page is the release: from that moment `curl -fsSL https://fluxsci.github.io/install.sh | bash`
installs it and running copies offer **Update now** (macOS) or show the install line (Linux).

## 5. After publishing

- [ ] The website serves a byte-for-byte copy of `install.sh` (`site/install.sh` in the website
      repository, recorded in `media/installer.json`). If `install.sh` changed in this release,
      update that copy and its recorded sha/revision; otherwise nothing to do.
- [ ] Smoke the published artifact on one machine per platform you have:
      `curl -fsSL https://fluxsci.github.io/install.sh | bash -s -- --version "$v"`, open a project,
      run **AI status → Run doctor**.
- [ ] Start the next `CHANGELOG.md` section as *unreleased*.

## If something is red

- `ci.yml` red on `main` → fix forward on `main` (or revert), never tag around it. Perf pins on
  hosted runners run under the documented `FLUX_PERF_SCALE` profile (guide §7); a red there is a
  regression or a gate that lacks the profile, not a reason to raise a budget by hand.
- `release.yml` "tag does not match package.json version" → the tag was cut from the wrong commit;
  delete the tag locally and remotely (`git tag -d`, `git push origin :refs/tags/$v`), fix, re-tag.
- A packaged smoke fails on macOS → the workflow's diagnose step records where the main thread is,
  `codesign -dv`, and the privacy daemons' view; most past failures were launch-environment (the
  Chrome used for the help check, the default Xvfb depth on Linux) rather than the app.
