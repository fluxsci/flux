"use strict";
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs/promises"), path = require("node:path");
const root = process.env.PROBE_PROJECT, scratch = process.env.PROBE_SCRATCH, output = process.env.PROBE_ARTIFACTS, build = process.env.PROBE_BUILD;
const appRoot = process.env.PROBE_APP_ROOT || path.resolve(__dirname, "../..");
if (!root || !scratch || !output || !build || !root.startsWith(scratch + path.sep)) throw new Error("Isolated stash acceptance paths required");
if (process.platform === "linux" && process.env.PROBE_VIRTUAL_DISPLAY !== "1") throw new Error("An isolated display is required; never focus the user's app desktop");
// Substitute only the production entry file. All product IPC, preload, stores,
// disk I/O and native events remain real. No build output in the repo is edited.
const loadFile = BrowserWindow.prototype.loadFile;
BrowserWindow.prototype.loadFile = function(file, options) {
  const repoEntry = path.join(appRoot, "dist/index.html");
  return loadFile.call(this, path.resolve(file) === repoEntry ? path.join(build, "index.html") : file, options);
};
require(path.join(appRoot, "electron/entry.cjs"));
let win;
const checks = [], errors = [];
const js = code => win.webContents.executeJavaScript(code, true);
const paint = () => js("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))");
const check = (value, label) => { checks.push({ ok: !!value, label }); console.log("PROBE " + JSON.stringify(checks.at(-1))); if (!value) throw new Error(label); };
async function wait(fn, label, timeout = 30000) { const start = Date.now(); while (Date.now() - start < timeout) { try { const value = await fn(); if (value) return value; } catch {} await new Promise(resolve => setTimeout(resolve, 60)); } throw new Error(`Timeout: ${label}`); }
async function focus() { await wait(async () => { app.focus({ steal: true }); win.focus(); win.webContents.focus(); return win.isFocused() && await js("document.hasFocus()"); }, "native focus on the private display"); }
async function clickAt(point) {
  await focus(); win.webContents.sendInputEvent({ type: "mouseMove", ...point });
  win.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...point });
  win.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...point }); await paint();
}
async function center(selector) { return js(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n)throw Error('Missing '+${JSON.stringify(selector)});const b=n.getBoundingClientRect();return{x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height/2)}})()`); }
async function click(selector) { await clickAt(await center(selector)); }
async function clickText(selector, text) {
  await js(`(()=>{const n=[...document.querySelectorAll(${JSON.stringify(selector)})].find(n=>n.textContent.trim()===${JSON.stringify(text)});if(!n)throw Error('Missing '+${JSON.stringify(text)});n.dataset.nativeHit='1';})()`);
  await click('[data-native-hit="1"]'); await js("document.querySelector('[data-native-hit]')?.removeAttribute('data-native-hit')");
}
async function key(keyCode, modifiers = []) { await focus(); win.webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers }); win.webContents.sendInputEvent({ type: "keyUp", keyCode, modifiers }); await paint(); }
const element = id => `.mc:not([inert]) [data-editor-element-id="${id}"]`;
const opacity = id => js(`(()=>{const n=document.querySelector(${JSON.stringify(element(id))});return n?Number(getComputedStyle(n).opacity):0})()`);
const presentOpacity = id => js(`(()=>{const n=document.querySelector(${JSON.stringify(`.present [data-el-id="${id}"]`)});if(!n)return null;const effects=n.querySelector(':scope > .sl-effects');return Number(getComputedStyle(n).opacity)*(effects?Number(getComputedStyle(effects).opacity):1)})()`);
const disk = async () => JSON.parse(await fs.readFile(path.join(root, "slides/stash-deck/deck.json"), "utf8"));
const endpointX = deck => deck.slides[0].beats[1].tracks.find(track => track.target === "underneath" && track.preset === "transform")?.to?.state?.x;
async function after(index) { await click(`.step[data-step-index="${index}"]`); await clickText(".edit-switch button", `Edit after step ${index}`); }
async function showHidden(value) {
  if (await js("document.querySelector('.ghost-toggle input').checked") !== value) await click(".ghost-toggle input");
}
async function presentCheck(resurrected) {
  await clickText(".deckbar button", "Present ▶");
  await wait(() => js("!!document.querySelector('.present [data-el-id=disappeared-large]')"), "presentation mounted");
  check(await presentOpacity("disappeared-large") > .99, "presentation initial frame still includes the disappeared object");
  await key("Right");
  await wait(async () => await presentOpacity("disappeared-large") === 0, "actual disappeared frame");
  check(await presentOpacity("disappeared-text") === 0, "both disappearance animations remain hidden in presentation");
  if (resurrected) {
    await key("Right");
    await wait(async () => await presentOpacity("disappeared-large") > .99, "explicit Appear resurrects object");
    check(await presentOpacity("disappeared-text") === 0, "explicit Appear resurrects only its chosen object");
  }
  await clickText(".present .hud button", "Esc"); await wait(() => js("!document.querySelector('.present')"), "presentation closed");
}
async function main() {
  win = await wait(() => BrowserWindow.getAllWindows()[0], "window"); win.setSize(1440, 1000); win.show();
  win.webContents.on("console-message", (_event, level, message) => { if (level === 3) errors.push(message); });
  await wait(() => js("!!document.querySelector('button[aria-label=Slide]')&&!!document.querySelector('.cm-editor,.slide-mode')"), "scratch project opened");
  check(app.getPath("userData").startsWith(scratch + path.sep), "native process uses isolated machine configuration");
  check(await js(`!window.__flux&&location.protocol==='file:'&&decodeURI(location.pathname)===${JSON.stringify(path.join(build, "index.html"))}`), "production bundle runs actual preload without development handles");
  await click('button[aria-label="Slide"]'); await wait(() => js(`!!document.querySelector(${JSON.stringify(element("underneath"))})`), "scratch slide opened");
  if (!await js("!!document.querySelector('.animator')")) await clickText(".deckbar button", "Animate ⏱");
  if (process.env.PROBE_PHASE === "reopen") {
    const saved = await disk();
    check(endpointX(saved) === 102 && saved.slides[0].elements.find(e => e.id === "underneath").x === 90, "cold reopen preserves endpoint edit and original Design geometry");
    check(saved.slides[0].elements.length === 3 && saved.slides[0].beats[2].tracks.some(t => t.target === "disappeared-large" && t.preset === "fade"), "cold reopen preserves all objects and explicit resurrection animation");
    await after(1);
    check(await opacity("disappeared-large") === .25 && await opacity("disappeared-text") === .25, "cold reopen keeps the existing Show hidden default without a new persistent preference");
    await showHidden(false);
    check(await opacity("disappeared-large") === 0 && await opacity("disappeared-text") === 0, "Show hidden off clears the reopened frame without deleting any saved objects");
    await presentCheck(true);
  } else {
    await after(1);
    const baseline = JSON.stringify(await disk());
    check(await opacity("disappeared-large") === .25 && await opacity("disappeared-text") === .25, "existing Show hidden behavior starts as an editing ghost");
    await click(element("disappeared-large"));
    const underneathPoint = await center(element("underneath"));
    await showHidden(false);
    check(await opacity("disappeared-large") === 0 && await opacity("disappeared-text") === 0, "Show hidden off removes every disappeared object from the painted canvas");
    check(await js("!document.querySelector('.slide-mode .overlay-svg .handle')"), "Show hidden off clears the selected disappeared object's manipulation handles");
    await key("Right");
    check(JSON.stringify(await disk()) === baseline && await js("!document.querySelector('.slide-mode .dirty.on')"), "turning Show hidden off preserves canonical deck bytes and does not dirty the project");
    await showHidden(true);
    check(await opacity("disappeared-large") === .25 && await opacity("disappeared-text") === .25, "Show hidden on restores all existing editing ghosts");
    await click(element("disappeared-large"));
    check(await js("!!document.querySelector('.slide-mode .overlay-svg .handle')"), "restored editing ghosts remain selectable through ordinary native pointer input");
    await showHidden(false);
    check(await opacity("disappeared-large") === 0 && JSON.stringify(await disk()) === baseline, "the existing checkbox is reversible view state and preserves canonical deck bytes");
    await clickAt(underneathPoint);
    check(await js("!!document.querySelector('.slide-mode .overlay-svg .handle')"), "native pointer input selects the visible object through the disappeared image");
    await key("A", [process.platform === "darwin" ? "meta" : "control"]);
    await js("window.__stashInput=[];window.__stashKey=e=>{if(e.key==='ArrowRight'){const t=performance.now();requestAnimationFrame(()=>requestAnimationFrame(()=>window.__stashInput.push(performance.now()-t)))}};window.addEventListener('keydown',window.__stashKey,true);void 0");
    for (let i = 0; i < 12; i++) await key("Right");
    const times = await js("window.removeEventListener('keydown',window.__stashKey,true);window.__stashInput");
    const p95 = [...times].sort((a,b) => a-b)[Math.floor(times.length * .95)];
    const edited = await wait(async () => { const d = await disk(); return endpointX(d) === 102 && d; }, "underlying object endpoint saved");
    check(edited.slides[0].elements.find(e => e.id === "underneath").x === 90 && edited.slides[0].elements.find(e => e.id === "disappeared-large").x === 50, "native click passes through hidden content and edits only the underlying step endpoint");
    check(!edited.slides[0].beats[1].tracks.some(t => t.preset === "transform" && t.target !== "underneath"), "Select all and native keyboard nudges exclude disappeared images and text");
    check(times.length === 12 && p95 <= 100, `native key-to-paint p95 ${p95.toFixed(1)}ms ≤100ms on isolated virtual display`);
    await fs.writeFile(path.join(output, "stashed-canvas.png"), (await win.webContents.capturePage()).toPNG());
    await presentCheck(false);
    await after(2);
    await showHidden(true);
    await click(element("disappeared-large"));
    await clickText(".animator .actions button", "Appear");
    await wait(async () => (await disk()).slides[0].beats[2].tracks.some(t => t.target === "disappeared-large" && t.preset === "fade"), "explicit appearance saved");
    check(await opacity("disappeared-large") === 1 && await opacity("disappeared-text") === .25, "Appear restores the chosen object to the actual later frame while other hidden objects remain editing ghosts");
    await presentCheck(true);
    await after(1);
    await fs.writeFile(path.join(output, "show-hidden-on.png"), (await win.webContents.capturePage()).toPNG());
    await showHidden(false);
    await fs.writeFile(path.join(output, "input.json"), JSON.stringify({ samplesMs: times, p95, display: "isolated Xvfb", renderer: build }, null, 2));
  }
  check(errors.length === 0, `native renderer console clean: ${errors.join("; ")}`);
  await fs.writeFile(path.join(output, `${process.env.PROBE_PHASE}.json`), JSON.stringify({ checks }, null, 2));
  // All edits have positively reached disk. Exit normally through the app's
  // existing close/flush path so the second process exercises a true cold open.
  win.close();
  if (process.platform === "darwin") await wait(() => win.isDestroyed(), "window close flush").then(() => app.quit());
}
app.whenReady().then(main).catch(async error => {
  console.error(error.stack);
  if (win && !win.isDestroyed()) {
    console.error(await js("document.querySelector('.slide-mode')?.textContent"));
    await fs.writeFile(path.join(output, `${process.env.PROBE_PHASE}-failed.png`), (await win.webContents.capturePage()).toPNG()).catch(() => {});
  }
  app.exit(1);
});
