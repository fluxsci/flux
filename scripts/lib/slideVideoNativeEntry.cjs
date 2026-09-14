"use strict";
const { app, BrowserWindow, dialog } = require("electron");
const fs = require("node:fs/promises"), path = require("node:path");
const root = process.env.PROBE_PROJECT, scratch = process.env.PROBE_SCRATCH;
if (!root || !scratch) throw new Error("Isolated video probe context required");
const output = process.env.PROBE_VIDEO;
dialog.showSaveDialog = async () => ({ canceled: false, filePath: output });
require("../../electron/entry.cjs");
let win;
const js = code => win.webContents.executeJavaScript(code, true);
const checks = [];
const check = (value, label) => { checks.push({ ok: !!value, label }); console.log("PROBE " + JSON.stringify(checks.at(-1))); if (!value) throw new Error(label); };
async function wait(fn, label, timeout = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { try { const value = await fn(); if (value) return value; } catch {} await new Promise(r => setTimeout(r, 60)); }
  throw new Error(`Timeout: ${label}`);
}
async function click(selector) {
  const p = await js(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n)throw Error('Missing control');const b=n.getBoundingClientRect();return{x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height/2)}})()`);
  win.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...p });
  win.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...p });
  await js("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))");
}
async function openSettings() {
  await click(".video-export"); await wait(() => js("!!document.querySelector('dialog[open]')"), "video settings");
}
async function setInput(label, value) {
  await js(`(()=>{const n=document.querySelector('dialog [aria-label=${JSON.stringify(label)}]');n.value=${JSON.stringify(String(value))};n.dispatchEvent(new Event('input',{bubbles:true}));n.dispatchEvent(new Event('change',{bubbles:true}));})()`);
}
async function main() {
  win = await wait(() => BrowserWindow.getAllWindows()[0], "app window");
  win.setSize(1440, 1000); win.setAlwaysOnTop(true); win.show(); win.focus();
  await wait(() => js("!!document.querySelector('button[aria-label=Slide]')&&!!document.querySelector('.cm-editor')"), "project open");
  check(app.getPath("userData").startsWith(scratch + path.sep), "native test uses isolated configuration");
  check(await js("!window.__flux && location.protocol==='file:'"), "built app and real preload, without dev handles");
  const errors = []; win.webContents.on("console-message", (_event, level, message) => { if (level === 3) errors.push(message); });
  await click('button[aria-label="Slide"]');
  await wait(() => js("!!document.querySelector('[data-editor-element-id=box]')"), "slide open");
  await openSettings();
  for (const width of [760, 1024, 1440]) {
    win.setSize(width, 900);
    await js("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))");
    check(await js("(()=>{const d=document.querySelector('dialog'),b=d.getBoundingClientRect();return b.left>=0&&b.right<=innerWidth&&d.scrollWidth<=d.clientWidth;})()"), `${width}px window: settings fit without horizontal overflow`);
  }
  await setInput("Delay between steps", -1);
  check(await js("document.querySelector('dialog button[type=submit]').disabled"), "invalid timing cannot export");
  await setInput("Delay between steps", .25); await setInput("Hold at start", .5); await setInput("Hold at end", .5);
  await setInput("Video resolution", 1080); await setInput("Video frame rate", 60);
  const before = await fs.readFile(path.join(root, "slides/video-deck/deck.json"), "utf8");
  await fs.writeFile(path.join(scratch, "before-deck.json"), before);
  await js("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))");
  await fs.writeFile(process.env.PROBE_SCREENSHOT, (await win.webContents.capturePage()).toPNG());
  await click("dialog button[type=submit]");
  await wait(() => js("document.querySelector('.video-job [role=status]')?.textContent.includes('Rendering')"), "actual background capture started");
  check(await js("!document.querySelector('dialog[open]')"), "export releases modal and keeps editor available");
  // Actual native nudge events during capture, with positive evidence that they edit.
  await click('[data-editor-element-id="box"]');
  const getX = "Number([...document.querySelectorAll('.inspector .nf')].find(n=>n.querySelector('.lb')?.textContent==='X')?.querySelector('input')?.value)";
  const x = await js(getX);
  await js("window.__videoTimes=[];window.__videoKey=e=>{if(e.key==='ArrowRight'){const t=performance.now();requestAnimationFrame(()=>requestAnimationFrame(()=>window.__videoTimes.push(performance.now()-t)))}};window.addEventListener('keydown',window.__videoKey,true);void 0");
  for (let i = 0; i < 16; i++) {
    win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Right" }); win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Right" });
    await js("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))");
  }
  const times = await js("window.removeEventListener('keydown',window.__videoKey,true);window.__videoTimes");
  check(await js(getX) === x + 16, "native keyboard input actually moves the slide object while exporting");
  const p95 = [...times].sort((a,b) => a-b)[Math.floor(times.length * .95)];
  check(times.length === 16 && p95 <= 100, `native input-to-paint p95 ${p95.toFixed(1)}ms during 1080p/60 capture ≤100ms`);
  await click('button[aria-label="Paper"]');
  await wait(() => js("!!document.querySelector('.mc:not([inert]) .cm-editor') && !document.querySelector('.mc:not([inert]) .slide-mode')"), "leave slide editor during export");
  await click('button[aria-label="Slide"]');
  await wait(() => js("!!document.querySelector('.mc:not([inert]) .slide-mode') && !!document.querySelector('.mc:not([inert]) .video-job')"), "return to window-owned export job");
  check(await js("document.querySelector('.video-job strong').textContent.includes('Smooth motion')"), "export job and its result survive editor mode changes");
  await wait(() => js("document.querySelector('.video-job strong')?.textContent.includes('MP4 ready')"), "MP4 complete", 120000);
  check((await fs.stat(output)).size > 1000, "real MP4 saved through native export IPC");
  check(await js("!document.querySelector('.video-job p')"), "no export warnings or errors");
  const firstBytes = await fs.readFile(output);
  await openSettings();
  check(await js("document.querySelector('dialog input[aria-label=\"Delay between steps\"]').value==='0.25'"), "export settings are remembered");
  await setInput("Hold at end", 30); await click("dialog button[type=submit]");
  await wait(() => js("document.querySelector('.video-job [role=status]')?.textContent.includes('Rendering')"), "second export rendering");
  await click(".video-job button");
  await wait(() => js("document.querySelector('.video-job strong')?.textContent.includes('Export cancelled')"), "cancel completed");
  check((await fs.readFile(output)).equals(firstBytes), "cancellation preserves an existing output byte-for-byte");
  check(!(await fs.readdir(path.dirname(output))).some(name => name.startsWith(`.${path.basename(output)}.tmp-`)), "cancelled export removes partial MP4 files");
  const invalid = await js(`window.fig.exportSlideVideo({root:${JSON.stringify(root)},deckId:'../escape',slideId:'motion',jobId:'invalid',options:{}})`);
  check(!invalid.ok && /Invalid/.test(invalid.error), "native IPC rejects unsafe identifiers before invoking tools");
  check(errors.length === 0, `renderer console clean: ${errors.join("; ")}`);
  await fs.writeFile(process.env.PROBE_METRICS, JSON.stringify({ checks, inputP95: p95, frames: 165, resolution: "1920x1080", fps: 60 }, null, 2));
  app.exit(0);
}
app.whenReady().then(main).catch(async error => { console.error(error.stack); if (win && !win.isDestroyed()) console.error(await js("document.querySelector('.video-job')?.textContent || document.querySelector('dialog')?.textContent")); app.exit(1); });
