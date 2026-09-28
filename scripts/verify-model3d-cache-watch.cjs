"use strict";
// Actual chokidar + production file IPC handlers, with the production watcher
// classifier/prune closures. No Electron window, GPU, or user state is involved.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { createFileCore, TMP_WRITE_RE } = require("../electron/ipc/files.cjs");
const { isDerivedFigureRenderPath } = require("../electron/projectWatchPaths.cjs");
let checks = 0;
const ok = (value, message) => { assert.ok(value, message); checks++; };
async function waitFor(test, label) {
  const deadline = Date.now() + 5000;
  while (!test()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
(async () => {
  const { watch } = await import("chokidar");
  const main = await fs.readFile(path.join(__dirname, "../electron/main.cjs"), "utf8");
  const classifySource = main.match(/function subsystemFor\(root, abs\) \{[\s\S]*?\n\}/)?.[0];
  const pruneSource = main.match(/const isPrunedWatchPath = \(abs\) => \{[\s\S]*?\n  \};/)?.[0];
  ok(classifySource && pruneSource && /ignored:\s*\(p\)\s*=>\s*TMP_WRITE_RE\.test\(p\)\s*\|\|\s*isPrunedWatchPath\(p\)/.test(main), "native watcher actually consumes the tested pruning policy");
  const { isLighttableProjectRel } = await import("../electron/plotsFolders.js");
  const { isDissectionProjectRel } = await import("../electron/dissectRules.js");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "flux-model3d-cache-watch-"));
  const project = path.join(root, "project");
  const sandbox = { path, projectRoot: project, isDerivedFigureRenderPath,
    plotFolderRules: { isLighttableProjectRel }, dissectRules: { isDissectionProjectRel } };
  const classify = vm.runInNewContext(`(${classifySource})`, sandbox);
  const prune = vm.runInNewContext(`${pruneSource}\nisPrunedWatchPath`, sandbox);
  const pruneWithoutPlotRules = vm.runInNewContext(`${pruneSource}\nisPrunedWatchPath`, { ...sandbox, plotFolderRules: null });
  const actual = [], rootControl = [], settledCacheControl = [], watchers = [];
  const out = path.join(__dirname, "../test-results/model3d/cache-watch");
  await fs.mkdir(out, { recursive: true });
  let phase = "path policy", failure = null;
  try {
    for (const relative of ["fig/renders", "fig/renders/model3d", "fig/renders/model3d/m3d-a.png", "fig/renders/overview.svg"]) {
      const absolute = path.join(project, relative);
      ok(prune(absolute) && pruneWithoutPlotRules(absolute) && classify(project, absolute) === null, `derived directory/file excluded even before plot rules load: ${relative}`);
    }
    for (const relative of ["fig/index.json", "fig/canvases/main.json", "fig/assets/a.glb", "fig/assets/a.fluxplot.json", "fig/renders-source.svg", "fig/renderstate.json"]) {
      const absolute = path.join(project, relative);
      ok(!prune(absolute) && classify(project, absolute) === "fig", `canonical Figure path remains live: ${relative}`);
    }
    ok(!isDerivedFigureRenderPath(project, path.join(root, "other", "fig/renders/a.png")), "a different project path is not mistaken for this cache");
    ok(!prune(path.join(project, "plots", "model.glb")) && classify(project, path.join(project, "plots/model.glb")) === "plots", "linked GLB source updates keep their ordinary route");
    ok(prune(path.join(project, "plots/_lighttable/cells/a.png")) && classify(project, path.join(project, "plots/_lighttable/cells/a.png")) === null, "existing lighttable pruning is retained");
    const canonical = ["fig/index.json", "fig/canvases/main.json", "fig/assets/model.glb", "fig/assets/model.fluxplot.json", "plots/source.glb"];
    for (const relative of canonical) {
      await fs.mkdir(path.dirname(path.join(project, relative)), { recursive: true });
      await fs.writeFile(path.join(project, relative), "original");
    }
    const core = createFileCore({ app: { getPath: name => path.join(root, "state", name) }, roots: () => [project], dialog: {}, setPendingRoot() {} });
    const handlers = new Map(); core.registerHandlers({ handle: (name, callback) => handlers.set(name, callback) });
    const call = (name, ...args) => handlers.get(name)({ sender: { id: 1 } }, ...args);
    const options = { ignoreInitial: true, awaitWriteFinish: { stabilityThreshold: 250, pollInterval: 50 } };
    async function observe(rows, paths, ignored, label) {
      const watcher = watch(paths, { ...options, ignored });
      watchers.push(watcher);
      watcher.on("all", (event, absolute) => rows.push({ event, relative: path.relative(project, absolute).split(path.sep).join("/"), selfWrite: core.isSelfWrite(absolute), subsystem: classify(project, absolute) }));
      let ready = false, error = null;
      watcher.once("ready", () => { ready = true; }).once("error", caught => { error = caught; });
      await waitFor(() => { if (error) throw error; return ready; }, label);
      return watcher;
    }
    const roots = [path.join(project, "fig"), path.join(project, "plots")];
    await observe(actual, roots, p => TMP_WRITE_RE.test(p) || prune(p), "pruned project watcher ready");
    await observe(rootControl, roots, p => TMP_WRITE_RE.test(p), "unpruned root control ready");
    phase = "first native directory publication";
    const cache = path.join(project, "fig/renders/model3d");
    await call("fs:mkdir", cache);
    await waitFor(() => rootControl.some(row => row.relative === "fig/renders/model3d" && row.event === "addDir"), "real first native directory observed by unpruned root control");
    ok(rootControl.some(row => row.relative === "fig/renders/model3d" && row.event === "addDir" && !row.selfWrite), "unpruned root control reproduces the unmarked first-directory event");
    // addDir and getWatched() precede chokidar's recursive scan and descriptor
    // attachment. A root ready event therefore does not make a future child
    // directory ready. Keep the mandatory first-directory control above, then
    // establish a separately ready observer before the first native file write.
    phase = "empty cache control readiness";
    ok((await fs.readdir(cache)).length === 0, "new cache contains no file before the first poster publication");
    await observe(settledCacheControl, [path.join(project, "fig/renders")], p => TMP_WRITE_RE.test(p), "new cache subtree control ready");
    phase = "first native poster publication";
    await call("fs:writeFile", path.join(cache, "m3d-first.png"), Buffer.from("complete poster bytes"));
    await waitFor(() => settledCacheControl.some(row => row.relative === "fig/renders/model3d/m3d-first.png" && row.event === "add"), "real first native poster write observed by settled cache control");
    ok(settledCacheControl.some(row => row.relative.endsWith("m3d-first.png") && row.selfWrite), "actual native poster file write is self-marked, unlike its new directory");
    ok(actual.length === 0, "first directory and poster publication emit no canonical watcher event");
    ok(!Object.keys(watchers[0].getWatched()).some(absolute => isDerivedFigureRenderPath(project, absolute)), "cache subtree has no watch descriptors, not merely discarded notifications");
    phase = "external cache churn";
    await fs.writeFile(path.join(cache, "external.png"), "external derived cache");
    await fs.writeFile(path.join(project, "fig/renders/overview.svg"), "<svg/>");
    await waitFor(() => settledCacheControl.some(row => row.relative === "fig/renders/overview.svg") && settledCacheControl.some(row => row.relative.endsWith("external.png")), "external derived writes observed by settled cache control");
    await fs.rm(path.join(project, "fig/renders"), { recursive: true });
    await waitFor(() => settledCacheControl.some(row => row.relative === "fig/renders" && row.event === "unlinkDir"), "cache pruning observed by settled cache control");
    ok(actual.length === 0, "external cache publication and pruning also stay outside canonical revisions");
    phase = "canonical and source edits";
    for (const relative of canonical) await fs.writeFile(path.join(project, relative), `edited ${relative}`);
    await waitFor(() => canonical.every(relative => actual.some(row => row.relative === relative && row.event === "change" && !row.selfWrite)), "canonical and source changes delivered through actual watcher");
    ok(canonical.every(relative => actual.some(row => row.relative === relative && row.subsystem === (relative.startsWith("fig/") ? "fig" : "plots"))), "canvas/index/GLB/metadata/source edits still notify the correct subsystem");
    ok(!actual.some(row => row.relative === "fig/renders" || row.relative.startsWith("fig/renders/")), "cache churn never surfaces even across later canonical publication");
    phase = "complete";
    console.log(`MODEL3D CACHE WATCH: PASS (${checks} meaningful assertions)`);
  } catch (error) {
    failure = String(error.stack ?? error);
    throw error;
  } finally {
    const watched = watchers.map(watcher => watcher.getWatched());
    await Promise.all(watchers.map(watcher => watcher.close()));
    await fs.writeFile(path.join(out, "receipt.json"), JSON.stringify({ checks, phase, failure, actual, rootControl, settledCacheControl, watched, scope: "real chokidar + native fs handlers; no browser/Electron timing qualification" }, null, 2) + "\n");
    await fs.rm(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
