"use strict";
// Recipe workspace trust, shared by the desktop app (recipe:run in main.cjs) and the headless
// engine (flux-core/recipe.ts, behind `flux rerun-plot` / rerun_plot and
// set-plot-color-scale --regenerate).
//
// A recipe.json names the command that regenerating a plot runs, so a project that arrived
// from someone else can carry any command at all. Both engines therefore refuse to run a
// recipe until its PROJECT has been trusted once on this machine. Trust is keyed by the
// resolved project root (a moved or copied project asks again) and lives in the machine
// preferences as `trustedRecipeRoots`, so a grant made in the app holds for the CLI and the
// other way round.
//
// Pure: callers pass the preferences object they read and write the one they get back.

const path = require("node:path");
const fs = require("node:fs");

/** The key trust is stored under: the project root holding `recipePath`, else its folder. */
function recipeTrustKey(recipePath) {
  const start = path.dirname(path.resolve(recipePath));
  let dir = start;
  for (let i = 0; i < 40; i++) {
    if (fs.existsSync(path.join(dir, "project.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return start;
}

function trustedRoots(prefs) {
  const list = prefs && prefs.trustedRecipeRoots;
  return Array.isArray(list) ? list.filter((x) => typeof x === "string") : [];
}

function isRecipeRootTrusted(prefs, key) {
  return trustedRoots(prefs).includes(key);
}

/** `prefs` with `key` trusted. Returns the SAME object when it already was (nothing to write). */
function withTrustedRecipeRoot(prefs, key) {
  if (isRecipeRootTrusted(prefs, key)) return prefs;
  return { ...(prefs || {}), trustedRecipeRoots: [...trustedRoots(prefs), key] };
}

/** One line a person or an agent can read: the exact command, quoted argument by argument. */
function recipeCommandLine(invocation) {
  return [invocation.executable, ...(invocation.argv || [])].map((x) => JSON.stringify(x)).join(" ");
}

module.exports = { recipeTrustKey, isRecipeRootTrusted, withTrustedRecipeRoot, recipeCommandLine };
