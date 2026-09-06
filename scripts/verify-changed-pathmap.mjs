#!/usr/bin/env node
// Hermetic regression for --changed selection. No git changes, suite subprocesses,
// or browser are needed: exercise the same matcher/resolver used by the runner.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { collectChangedRuns, globToRegExp, resolveChangedRuns } from "./lib/changedVerifies.mjs";

let checks = 0;
function equal(actual, expected, label) {
  assert.deepEqual(actual, expected, label);
  checks++;
}

// Include negative paths: a broadened regex must not route a sibling directory,
// regex metacharacter, or nested file through a single-segment pattern.
for (const [glob, yes, no] of [
  ["src/lib/slide/**", ["src/lib/slide/player.ts", "src/lib/slide/player/player.ts"], ["src/lib/slides/player.ts", "other/src/lib/slide/player.ts"]],
  ["src/**/*.ts", ["src/a.ts", "src/a/b/c.ts"], ["src/a.tsx", "elsewhere/a.ts"]],
  ["**/player.ts", ["player.ts", "src/lib/slide/player.ts"], ["players.ts", "src/player.ts/child"]],
  ["scripts/verify-*", ["scripts/verify-foo.ts", "scripts/verify-foo.mjs"], ["scripts/lib/verify-foo.ts", "scripts/verify-foo/nested.ts"]],
  ["resources/{csl,docx}/**", ["resources/csl/nature.csl", "resources/docx/templates/nature.docx"], ["resources/css/nature.csl", "resources/docx-other/nature.docx"]],
  ["{electron/{captureIntake,captureInstall}.cjs,src/lib/references/capture*.ts}", ["electron/captureIntake.cjs", "electron/captureInstall.cjs", "src/lib/references/captureQueue.ts"], ["electron/captureOther.cjs", "src/lib/references/nested/captureQueue.ts"]],
  ["a/{one,two}/{x,y}.ts", ["a/one/x.ts", "a/two/y.ts"], ["a/three/x.ts", "a/one/z.ts"]],
  ["docs/report (v1)+[draft].md", ["docs/report (v1)+[draft].md"], ["docs/report v1draft.md", "docs/report (v1)+[draft]Xmd"]],
  ["docs/研究 notes/**", ["docs/研究 notes/a.md", "docs/研究 notes/nested/.hidden"], ["docs/研究/a.md"]],
]) {
  const re = globToRegExp(glob);
  for (const file of yes) equal(re.test(file), true, `${glob} includes ${file}`);
  for (const file of no) equal(re.test(file), false, `${glob} excludes ${file}`);
}

const manifest = JSON.parse(readFileSync(new URL("./verify-manifest.json", import.meta.url), "utf8"));
const actualCases = [
  ["src/lib/Canvas.svelte", ["group:figures-slides-overhaul", "group:slide-ghosts", "tier:pure"]],
  ["src/lib/slide/compile.ts", ["group:figures-slides-overhaul", "group:slide-ghosts", "tier:pure"]],
  ["src/lib/slide/player/player.ts", ["group:figures-slides-overhaul", "group:slide-ghosts", "tier:pure"]],
  ["src/shell/modes/slide/Animator/BeatRail.svelte", ["group:figures-slides-overhaul", "group:slide-ghosts", "tier:pure"]],
  ["src/lib/figureReferences.ts", ["group:figures-slides-overhaul", "group:slide-ghosts", "tier:pure"]],
  ["src/lib/editorPresentation.ts", ["group:figures-slides-overhaul", "group:slide-ghosts", "tier:pure"]],
  ["src/lib/project/figureReferenceSync.ts", ["group:figures-slides-overhaul", "group:slide-ghosts", "tier:pure"]],
  ["src/shell/ModeContent.svelte", ["verify-mode-cold-switch.mjs", "verify-keepalive.mjs", "verify-slide-tenancy-gui.mjs", "tier:pure"]],
  ["src/shell/modes/paper/PaperMode.svelte", ["group:paper-gate", "tier:pure"]],
  // The earlier paper rule must continue winning over the later documents rule.
  ["src/shell/modes/paper/documents/DocumentList.svelte", ["group:paper-gate", "tier:pure"]],
  ["electron/captureIntake.cjs", ["verify-capture-intake.ts", "verify-capture-e2e.cjs", "tier:pure"]],
  ["electron/captureInstall.cjs", ["verify-capture-intake.ts", "verify-capture-e2e.cjs", "tier:pure"]],
  ["resources/csl/nature.csl", ["verify-journal-assets.ts"]],
  ["resources/docx/templates/nature.docx", ["verify-journal-assets.ts"]],
  ["src/lib/FigureNamer.svelte", ["verify-fig-namer.mjs", "verify-m11-m14.mjs"]],
  ["docs/AGENT_ENGINEERING_GUIDE-RUNNING.md", ["verify-docs.ts"]],
  ["scripts/lib/driver.mjs", ["tier:pure"]],
  ["scripts/verify-changed-pathmap.mjs", ["self:scripts/verify-changed-pathmap.mjs", "tier:pure"]],
];
for (const [file, expected] of actualCases) {
  equal([...collectChangedRuns([file], manifest.pathMap)], expected, `actual manifest routes ${file}`);
}

const figureSelection = resolveChangedRuns(collectChangedRuns(["src/lib/FigureNamer.svelte"], manifest.pathMap), manifest);
equal(figureSelection, { scripts: ["verify-fig-namer.mjs", "verify-m11-m14.mjs"], diagnostics: [] }, "literal filenames resolve to the actual GUI gates");
const slideSelection = resolveChangedRuns(collectChangedRuns(["src/lib/slide/player/player.ts"], manifest.pathMap), manifest);
equal(slideSelection.scripts.includes("verify-slide-authoring-gui.mjs"), true, "slide changes select the authoring GUI gate");
equal(slideSelection.scripts.includes("verify-slide-source-sync-gui.mjs"), true, "slide changes select the source synchronization GUI gate");
equal(slideSelection.scripts.includes("verify-slide-ghost-gui.mjs"), true, "slide changes select the ghost authoring gate");
equal(slideSelection.diagnostics, [], "overhaul mapping has no unresolved references");

// Isolate union/order/fallback from the real map, whose broad rules evolve.
const map = [
  { glob: "src/special/**", run: ["group:focused", "verify-shared.ts"] },
  { glob: "src/**", run: ["tier:ui"] },
  { glob: "scripts/verify-*", run: ["self"] },
];
const fixture = {
  tiers: { pure: ["verify-pure.ts", "verify-shared.ts"], ui: ["verify-gui.mjs", "verify-other.mjs"] },
  groups: { focused: ["verify-gui.mjs", "verify-shared.ts"] },
};
equal([...collectChangedRuns(["src/special/a.ts"], map)], ["group:focused", "verify-shared.ts"], "first match excludes later broad rule");
const wanted = collectChangedRuns(["src/special/a.ts", "src/b.ts", "src/special/a.ts", "scripts/verify-pure.ts"], map);
equal([...wanted], ["group:focused", "verify-shared.ts", "tier:ui", "self:scripts/verify-pure.ts"], "changed files union in first-seen order without duplicates");
equal(resolveChangedRuns(wanted, fixture), { scripts: ["verify-gui.mjs", "verify-shared.ts", "verify-other.mjs", "verify-pure.ts"], diagnostics: [] }, "tier/group/literal/self resolve once in first-seen order");
equal([...collectChangedRuns([], map)], ["tier:pure"], "empty diff keeps the pure safety floor");
equal([...collectChangedRuns(["unknown/file.ts"], map)], ["tier:pure"], "unmatched path keeps the pure safety floor");
equal([...collectChangedRuns(["src/special/a.ts", "unknown/file.ts"], map)], ["group:focused", "verify-shared.ts", "tier:pure"], "unmatched path adds the floor without dropping matched gates");
const invalid = resolveChangedRuns(["verify-typo.mjs", "../verify-pure.ts", "tier:missing", "group:missing", "self:src/verify-pure.ts"], fixture);
equal(invalid.scripts, [], "invalid names do not execute scripts");
equal(invalid.diagnostics.length, 5, "every invalid target produces a diagnostic");
equal(invalid.diagnostics.some((message) => message.includes('unknown script "verify-typo.mjs"')), true, "literal filename typo is named in its diagnostic");

const allRuns = new Set(manifest.pathMap.flatMap((entry) => entry.run).filter((run) => run !== "self"));
const allSelection = resolveChangedRuns(allRuns, manifest);
equal(allSelection.diagnostics, [], "all actual manifest run references resolve");
equal(allSelection.scripts.filter((name) => !existsSync(new URL(name, import.meta.url))), [], "every selected manifest script exists on disk");
equal(manifest.tiers.pure.includes("verify-changed-pathmap.mjs"), true, "this regression is registered in the pure gate");

console.log(`CHANGED PATHMAP VERIFY: PASS (${checks} checks)`);
