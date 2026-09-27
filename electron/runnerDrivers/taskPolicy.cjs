"use strict";
// Pure policy over a directory inventory. IO belongs to the runner.
function taskCwd(root, parent, entries) {
  const files = new Set(entries.filter(e => !e.directory).map(e => e.name));
  const analysis = ["pyproject.toml", "environment.yml", "environment.yaml", "requirements.txt", "DESCRIPTION", "Project.toml"].some(n => files.has(n)) ||
    [...files].some(n => /\.(ipynb|Rproj)$/i.test(n));
  return parent !== root && analysis && !files.has("project.json") ? parent : root;
}
function backgroundConcurrency(value) {
  return Number.isInteger(value) ? Math.max(1, Math.min(3, value)) : 2;
}
module.exports = { taskCwd, backgroundConcurrency };
