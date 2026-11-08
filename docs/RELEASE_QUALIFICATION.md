# Release qualification

Use a clean checkout of the intended commit, Node22.15 or newer, a reproducible
`npm ci`, Quarto1.7.32, Chrome, and an isolated native display/profile. Do not use
the owner's running application or library. Linux x64 and native macOS arm64/x64
are the emitted targets; Windows portability checks do not certify an installer.

`node scripts/release-check.mjs --platform linux --arch x64` runs typechecks,
audit, production build, pure/browser/Paper/Reader/scale/native cohorts, builds
offline documentation, stages and rehashes native helpers, then builds fresh
deb/AppImage artifacts and exercises their installed layout. Run the matching
native target on each macOS architecture. It never publishes. `--skip-pack`
produces partial evidence only. Reused `--gate-report` evidence must match the
exact clean source digest, commit and target; documentation and helper inventories
are verified again before packaging. A failed, blocked or flaky attempt cannot
qualify a required cohort.

Each `release/qualification-*/qualification.json` records source identity, target,
check directories and artifact sizes/SHA256. Each runner attempt keeps stdout,
stderr and output artifacts under `test-results/runs/`. Earlier failed attempts
remain evidence; repairing a fixture requires explaining which assumption was
invalid while preserving its behavioral assertions and timing limits.

# How a release ships (release.yml, owner decision 2026-10-03)

The hosted path is deliberately small. Pushing a tag `vX.Y.Z` that equals `package.json`'s
version runs `.github/workflows/release.yml`, which:

1. waits (up to 75 minutes) for a **green `ci.yml` run on that exact commit** — type-check,
   build, the hermetic pure tier and the bundle handshakes on `ubuntu-latest`; a red CI blocks
   the release, so push the commit to `main` and let CI pass before tagging;
2. builds the three targets `install.sh` installs (`Flux-mac-arm64.zip`, `Flux-mac-x64.zip`,
   `Flux-linux-amd64.deb`) on their native runners, with the offline help and the pinned video
   encoder, and runs `scripts/verify-packaged-app.mjs` against each packaged app;
3. assembles `SHA256SUMS` over the three artifacts and `install.sh`, and creates ONE **draft**
   GitHub Release carrying exactly those five files, with generated notes.

Publishing that draft (one click on the Releases page) is the release: it becomes what
`curl -fsSL https://fluxsci.github.io/install.sh | bash` installs and what a running Flux's
update notice offers. `workflow_dispatch` is a dry run (build + smoke, artifacts kept on the
run, nothing published). The website's `site/install.sh` is a byte-for-byte copy of the
reviewed upstream installer; refresh it only when `install.sh` itself changes.

`scripts/release-check.mjs`, `scripts/verify-release-evidence.mjs` and the
`docs/release-platform-evidence.json` schema below remain the LOCAL deep-qualification tools
(every tier on each target, physical-display evidence). The hosted workflow does not require
them; a maintainer runs them before tagging when a release warrants it.

```json
{
  "commit": "the exact full release commit",
  "tag": "the exact matching version tag",
  "reviewer": "person who performed the recorded checks",
  "checks": {
    "linuxPhysicalDisplay": {"status": "passed", "evidence": "durable report or artifact location"},
    "macArm64PhysicalDisplay": {"status": "passed", "evidence": "durable report or artifact location"},
    "macX64PhysicalDisplay": {"status": "passed", "evidence": "durable report or artifact location"},
    "distributionPolicy": {"status": "passed", "evidence": "chosen signing/notarization/distribution policy and results"}
  }
}
```

This is a schema example, not approval. Software rendering/Xvfb does not qualify Wayland/NVIDIA
presentation or native macOS behavior. There is no Apple Developer ID (owner decision): the
macOS app is ad-hoc signed by `build/afterPack.cjs`, and the installer's curl download carries no
quarantine flag. Do not request or invent credentials to make a session appear qualified.

The ordinary main UI CI observer (`ui-gate`) and the Windows job can become blocking only
after the documented five consecutive green main-CI runs; local release qualification already
requires UI success.
