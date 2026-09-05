// Boot the actual composition root, observe its real DOM and preload events,
// and regenerate sources with ordinary filesystem writes outside the bridge.
"use strict";
process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = "1";
const fs = require("node:fs"), path = require("node:path");
const root = process.env.PROBE_PROJECT, external = process.env.PROBE_EXTERNAL, scratch = process.env.PROBE_SCRATCH, phase = process.env.PROBE_PHASE;
if (!root || !external || !scratch || !["initial", "reopen"].includes(phase)) throw new Error("Missing hermetic probe context");
const { app, BrowserWindow } = require("electron");
app.disableHardwareAcceleration();
let uncaught = 0;
const rendererExceptions = [];
process.on("uncaughtException", e => { uncaught++; console.log(`PROBE uncaught=${String(e?.stack || e)}`); });
require("../../electron/main.cjs");
const checks = [];
const check = (ok, label, detail) => { checks.push({ ok: !!ok, label, ...(detail ? { detail } : {}) }); console.log(`PROBE check=${JSON.stringify(checks.at(-1))}`); if (!ok) throw new Error(label); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(fn, label, timeout = 18000) {
  const start = Date.now(); let last;
  while (Date.now() - start < timeout) { try { const value = await fn(); if (value) return value; } catch (e) { last = e.message; } await sleep(100); }
  throw new Error(`Timeout: ${label}${last ? `; ${last}` : ""}`);
}
const read = rel => fs.readFileSync(path.join(root, rel), "utf8");
const json = rel => JSON.parse(read(rel));
function rewrite(file, text) { const temp = `${file}.probe-write`; fs.writeFileSync(temp, text); fs.renameSync(temp, file); }
function regenerate(file, source, version, width = 400) {
  rewrite(file, `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="120" viewBox="0 0 ${width} 120" data-probe-source="${source}" data-source-version="${version}"><rect x="0" y="0" width="${width}" height="120" fill="${version % 2 ? "#879a39" : "#8b7ec8"}"/><text x="15" y="65" font-size="24" fill="white">${source} v${version}</text></svg>`);
  rewrite(file.replace(/\.svg$/, ".fluxplot.json"), JSON.stringify({ spec: "fluxplot", schemaVersion: "0.2.0", axes: [], series: [], probeVersion: version }));
}
let win;
const js = code => win.webContents.executeJavaScript(code, true);
async function mode(label) {
  await waitFor(() => js(`(() => { const b=document.querySelector('button[aria-label=${JSON.stringify(label)}]'); if(!b)return false;b.click();return true;})()`), `${label} mode button`);
}
async function version(selector, source, value) {
  return waitFor(() => js(`!!document.querySelector(${JSON.stringify(`${selector} [data-probe-source="${source}"][data-source-version="${value}"]`)})`), `${selector}: ${source} v${value}`);
}
async function diskVersion(rel, value) { return waitFor(() => read(rel).includes(`data-source-version="${value}"`), `${rel}: v${value}`); }
async function main() {
  win = await waitFor(() => BrowserWindow.getAllWindows()[0], "native window");
  win.webContents.on("console-message", (_event, level, message) => {
    if (level >= 2) console.log("PROBE renderer=" + JSON.stringify({ level, message }));
    if (level >= 3 && /Uncaught/.test(message)) rendererExceptions.push(message);
  });
  win.webContents.on("render-process-gone", (_event, details) => console.log("PROBE rendererGone=" + JSON.stringify(details)));
  await waitFor(() => js("!!window.fig?.onFsChanged && !!document.querySelector('button[aria-label=Figure]')"), "project opened through native launch arguments");
  console.log("PROBE boot=" + JSON.stringify({ windows: BrowserWindow.getAllWindows().length, title: win.getTitle(), userData: app.getPath("userData"), url: win.webContents.getURL() }));
  check(app.getPath("userData").startsWith(scratch + path.sep), "native config and single-instance lock are isolated");
  check(await js("typeof window.fig.readText==='function' && typeof window.fig.watchRoot==='function'"), "real preload filesystem bridge is active");
  if (!process.env.VITE_DEV_SERVER_URL) check(await js("!window.__flux"), "built renderer has no dev store handle");
  await js("window.__sourceProbeEvents=[];window.fig.onFsChanged(e=>window.__sourceProbeEvents.push(e));void 0;");
  // Let the initially selected Paper mode mount before source-specific mode
  // changes; cold-chunk switching has a separate shell regression gate.
  await waitFor(() => js("!!document.querySelector('.cm-editor')"), "initial Paper editor mounted");
  const figure = '[data-editor-element-id="figure-live"]';
  const frozenFigure = '[data-editor-element-id="figure-frozen"]';
  const externalFigure = '[data-editor-element-id="figure-external"]';
  const slide = '[data-editor-element-id="slide-shared"]';
  const externalSlide = '[data-editor-element-id="slide-external"]';
  if (phase === "initial") {
    await mode("Figure"); await version(figure, "shared", 1);
    check(true, "Figure renders the initially accepted source");
    const grants = await js(`(async()=>{let denied=false;try{await window.fig.readText(${JSON.stringify(path.join(external, "unlinked-neighbor.txt"))});}catch{denied=true;}return {denied,linked:(await window.fig.readText(${JSON.stringify(path.join(external, "external-figure.svg"))})).includes('data-probe-source="external-figure"')};})()`);
    check(grants.denied && grants.linked, "external source read grant permits the exact SVG and denies its ordinary neighbor");
    regenerate(path.join(root, "plots/shared.svg"), "shared", 2);
    regenerate(path.join(root, "plots/frozen.svg"), "frozen", 2);
    regenerate(path.join(external, "external-figure.svg"), "external-figure", 2);
    await version(figure, "shared", 2); await version(externalFigure, "external-figure", 2);
    await diskVersion("fig/assets/shared.svg", 2); await diskVersion("fig/assets/figure-external.svg", 2);
    check(true, "real internal and external watch events update Figure and persist accepted SVGs");
    await version(frozenFigure, "frozen", 1); await diskVersion("fig/assets/figure-frozen.svg", 1);
    check(true, "frozen Figure copy survives regeneration");
    // Asset files precede the composition/index commit in saveFigFrom. Seeing
    // the new SVG does not yet mean the resized canvas has reached disk.
    const savedPlacement = await waitFor(() => {
      const placement = json("fig/canvases/source-canvas.json").figures[0].elements.find(e => e.id === "figure-live");
      const asset = json("fig/index.json").assets.find(a => a.id === "shared");
      if (placement.width !== 200 || placement.x !== 20 || asset.naturalWidth !== 400)
        throw new Error(`Saved placement x=${placement.x}, width=${placement.width}; accepted naturalWidth=${asset.naturalWidth}`);
      return placement;
    }, "Figure canvas and index commit the resized source");
    check(savedPlacement.width === 200 && savedPlacement.x === 20, "Figure resizing preserves deliberate scale and position");
    rewrite(path.join(root, "plots/shared.fluxplot.json"), JSON.stringify({ spec: "fluxplot", schemaVersion: "0.2.0", axes: [], series: [], probeVersion: 3 }));
    await waitFor(() => json("fig/assets/shared.fluxplot.json").probeVersion === 3, "manifest-only Figure persistence");
    check(true, "semantic sidecar-only change persists through the actual watcher");
    await mode("Paper"); await version(".flux-embed-art", "shared", 2);
    regenerate(path.join(root, "plots/shared.svg"), "shared", 3);
    await version(".flux-embed-art", "shared", 3); await diskVersion("fig/assets/shared.svg", 3);
    check(true, "open Paper embed refreshes automatically after source regeneration");
    await mode("Slide"); await version(slide, "shared", 3); await version('[data-editor-element-id="slide-frozen"]', "frozen", 1);
    const before = json("slides/watcher-talk/deck.json");
    const sharedWidth = before.slides[0].elements.find(e => e.id === "slide-shared").width;
    const sharedNatural = json("fig/index.json").assets.find(a => a.id === "shared").naturalWidth;
    const expectedSharedWidth = sharedWidth * 600 / sharedNatural;
    check(sharedWidth === 200 && expectedSharedWidth === 300, "closed deck catches up from its authored intrinsic baseline before opening");
    regenerate(path.join(root, "plots/shared.svg"), "shared", 4, 600);
    regenerate(path.join(root, "plots/local.svg"), "local", 4, 600);
    regenerate(path.join(root, "plots/target.svg"), "target", 4, 600);
    regenerate(path.join(external, "external-deck.svg"), "external-deck", 4, 600);
    await version(slide, "shared", 4); await version('[data-editor-element-id="slide-local"]', "local", 4); await version(externalSlide, "external-deck", 4);
    await diskVersion("fig/assets/shared.svg", 4); await diskVersion("slides/watcher-talk/assets/local.svg", 4); await diskVersion("slides/watcher-talk/assets/target.svg", 4); await diskVersion("slides/watcher-talk/assets/deck-external.svg", 4);
    await waitFor(() => { const elements = json("slides/watcher-talk/deck.json").slides[0].elements; return elements.find(e => e.id === "slide-local").width === 300 && elements.find(e => e.id === "slide-shared").width === expectedSharedWidth; }, "resized shared and local deck placements persist");
    const after = json("slides/watcher-talk/deck.json");
    check(after.slides[0].elements.find(e => e.id === "slide-shared").width === expectedSharedWidth, "linked Figure and deck-local metadata update while Slide owns the store", `shared ${sharedWidth}→${expectedSharedWidth}, local 100→300`);
    check(JSON.stringify(after.slides[0].beats) === JSON.stringify(before.slides[0].beats) && JSON.stringify(after.stage) === JSON.stringify(before.stage), "source updates preserve authored animations and stage");
    await version('[data-editor-element-id="slide-frozen"]', "frozen", 1); await diskVersion("slides/watcher-talk/assets/deck-frozen.svg", 1);
    check(true, "frozen deck copy retains its accepted SVG after repeated source writes");
    check(json("slides/watcher-talk/assets/target.fluxplot.json").probeVersion === 4, "animation-only target bundle refreshes durably");
  } else {
    await mode("Figure"); await version(figure, "shared", 4); await version(externalFigure, "external-figure", 2);
    check(true, "fresh native process reloads accepted Figure revisions from disk");
    const denied = await js(`window.fig.readText(${JSON.stringify(path.join(external, "unlinked-neighbor.txt"))}).then(()=>false,()=>true)`);
    check(denied, "cold reopen does not grant the source directory or its ordinary neighbor");
    regenerate(path.join(external, "external-figure.svg"), "external-figure", 5, 500);
    await version(externalFigure, "external-figure", 5); await diskVersion("fig/assets/figure-external.svg", 5);
    check(json("fig/assets/figure-external.fluxplot.json").probeVersion === 5, "saved external Figure link watches and reads its SVG/sidecar after cold reopen");
    await mode("Slide"); await version(slide, "shared", 4); await version(externalSlide, "external-deck", 4);
    check(true, "fresh native process reloads accepted deck revisions from disk");
    regenerate(path.join(external, "external-deck.svg"), "external-deck", 5, 800);
    await version(externalSlide, "external-deck", 5); await diskVersion("slides/watcher-talk/assets/deck-external.svg", 5);
    check(json("slides/watcher-talk/assets/deck-external.fluxplot.json").probeVersion === 5, "saved deck-only external link watches and reads its bundle after cold reopen");
    await version('[data-editor-element-id="slide-frozen"]', "frozen", 1);
    check(true, "frozen source remains frozen across process restart");
    await mode("Figure"); await version(figure, "shared", 4);
    await waitFor(() => js("(() => {const b=document.querySelector('button[title=\"Delete figure\"]');if(!b)return false;b.click();return true;})()"), "Figure deletion command");
    await waitFor(() => js("(() => {const b=document.querySelector('[role=dialog][aria-label=\"Delete figures\"] button.delete:not([disabled])');if(!b)return false;b.click();return true;})()"), "usage-aware Figure deletion dialog");
    await waitFor(() => !json("fig/index.json").figures.some(f => f.id === "source-figure"), "Figure deletion persists");
    await mode("Slide"); await version(slide, "shared", 4);
    regenerate(path.join(root, "plots/shared.svg"), "shared", 6, 800);
    await version(slide, "shared", 6); await diskVersion("fig/assets/shared.svg", 6);
    await waitFor(() => json("slides/watcher-talk/deck.json").slides[0].elements.find(e => e.id === "slide-shared").width === 400, "orphan-linked deck placement keeps half scale");
    check(true, "deleting the original Figure preserves the slide source watch, accepted bytes and scale");
  }
  check(await js("window.__sourceProbeEvents.some(e=>e.subsystem==='plots')"), "real preload delivered source filesystem notifications");
  check(uncaught === 0, "no uncaught main-process exceptions");
  check(rendererExceptions.length === 0, "no uncaught renderer exceptions", rendererExceptions.join("; "));
  const artifactDir = path.resolve(__dirname, "../../test-results");
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.writeFileSync(path.join(artifactDir, `source-sync-native-${phase}.png`), (await win.webContents.capturePage()).toPNG());
}
function finish(result) {
  fs.writeSync(1, "PROBE result=" + JSON.stringify(result) + "\n");
  // The probe tests committed disk state across a cold restart. Exit its own
  // process directly; Electron app.exit can wait on retained native watchers.
  process.exit(result.ok ? 0 : 1);
}
app.whenReady().then(() => main().then(() => {
  finish({ ok: true, checks });
}).catch(async e => {
  try {
    console.log("PROBE dom=" + JSON.stringify((await js("document.body.innerText")).slice(-6000)));
    const artifact = path.resolve(__dirname, "../../test-results/source-sync-native-failure.png");
    fs.writeFileSync(artifact, (await win.webContents.capturePage()).toPNG());
  } catch { /* no window */ }
  finish({ ok: false, checks, error: String(e.stack || e) });
}));
setTimeout(() => { fs.writeSync(1, "PROBE fatal=watchdog-timeout\n"); process.exit(2); }, 90000);
