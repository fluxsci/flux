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

The tag workflow requires an exact `v<package.json version>` tag and all three
native reports before its publication validator can emit an artifact list. It
also requires `docs/release-platform-evidence.json` with this structure:

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

This is a schema example, not approval. Create that file only from actual checks;
its absence deliberately prevents publication. Software rendering/Xvfb does not
qualify Wayland/NVIDIA presentation or native macOS behavior. Signed macOS
qualification uses the configured Developer ID and notarization credentials;
without credentials, report the explicitly unsigned path. Do not request or
invent credentials to make a local implementation session appear qualified.

Manual workflow runs produce qualification artifacts only. Tag publication
consumes only the validator's exact NUL-delimited list of verified artifacts and
creates a draft. No general `release/*` glob is eligible for publication. The
ordinary main UI CI observer can become blocking only after the documented five
consecutive green main-CI runs; release qualification already requires UI success.
