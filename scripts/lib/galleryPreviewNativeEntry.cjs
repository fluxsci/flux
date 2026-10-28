"use strict";
const { app, BrowserWindow, net } = require("electron");
const fs = require("node:fs/promises"), path = require("node:path");
const root = process.env.PROBE_PROJECT, scratch = process.env.PROBE_SCRATCH, output = process.env.PROBE_ARTIFACTS, appRoot = process.env.PROBE_APP_ROOT;
if (!root || !scratch || !appRoot || !output || !root.startsWith(scratch + path.sep) || process.platform === "linux" && process.env.PROBE_VIRTUAL_DISPLAY !== "1") throw new Error("Native preview acceptance requires scratch paths and a private display");
require(path.join(appRoot, "electron/entry.cjs"));
let owner, win;
const checks = [], errors = [], timings = [];
let stage = 'startup';
const errorWindows = new WeakSet();
function watchErrors(window) {
  if (errorWindows.has(window)) return;
  errorWindows.add(window);
  window.webContents.on('console-message', event => {
    if (event.level === 'error') errors.push(`[window ${window.webContents.id}; ${stage}] ${event.message}`);
  });
}
const js = code => win.webContents.executeJavaScript(code, true);
const paint = () => js("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))");
const check = (value, label) => { checks.push({ ok: !!value, label }); console.log("PROBE " + JSON.stringify(checks.at(-1))); if (!value) throw new Error(label); };
async function wait(fn, label, timeout = 25000) { const start = Date.now(); while (Date.now() - start < timeout) { try { const value = await fn(); if (value) return value; } catch {} await new Promise(resolve => setTimeout(resolve, 60)); } throw new Error(`Timeout: ${label}`); }
async function focus() { await wait(async () => { app.focus({ steal: true }); win.focus(); win.webContents.focus(); return win.isFocused() && await js("document.hasFocus()"); }, "private display focus"); }
async function click(selector, modifiers = [], clickCount = 1) {
  stage = `click ${selector}`;
  await focus();
  const point = await js(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n)return{error:'Missing control'};const b=n.getBoundingClientRect();if(!b.width||!b.height)return{error:'Control is hidden',tag:n.tagName};const x=Math.round(b.x+b.width/2),y=Math.round(b.y+b.height/2),hit=document.elementFromPoint(x,y);if(!n.contains(hit))return{error:'Control is covered',tag:n.tagName,hit:hit?.tagName,hitClass:hit?.className};return{x,y}})()`);
  if (point.error) throw new Error(`${point.error}: ${selector} (${JSON.stringify(point)})`);
  win.webContents.sendInputEvent({ type: "mouseMove", ...point });
  win.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount, modifiers, ...point });
  win.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount, modifiers, ...point }); await paint();
}
async function clickText(selector, text) {
  await js(`(()=>{const n=[...document.querySelectorAll(${JSON.stringify(selector)})].find(n=>n.textContent.trim()===${JSON.stringify(text)});if(!n)throw Error('Missing text');n.dataset.nativeHit='1'})()`);
  await click('[data-native-hit="1"]'); await js("document.querySelector('[data-native-hit]')?.removeAttribute('data-native-hit')");
}
async function key(keyCode, modifiers = []) { stage = `key ${keyCode}`; await focus(); win.webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers }); win.webContents.sendInputEvent({ type: "keyUp", keyCode, modifiers }); await paint(); }
async function previewSize(label) {
  let measured;
  await wait(async () => {
    measured = await js(`(()=>{const box=document.querySelector('.importer .list .preview'),page=box?.querySelector('.page'),image=page?.querySelector('img');if(!box||!page||!image?.naturalWidth)return null;const expectedW=Math.min(box.clientWidth-6,(box.clientHeight-6)*image.naturalWidth/image.naturalHeight),expectedH=expectedW*image.naturalHeight/image.naturalWidth;const r=page.getBoundingClientRect();return{width:box.clientWidth,height:box.clientHeight,pageW:r.width,pageH:r.height,expectedW,expectedH,document:box.ownerDocument.URL,matches:Math.abs(r.width-expectedW)<.1&&Math.abs(r.height-expectedH)<.1}})()`);
    return measured?.matches;
  }, `${label}: thumbnail fit follows actual owner geometry`, 2000).catch(error => { throw new Error(`${error.message}: ${JSON.stringify(measured)}`); });
  check(measured.matches && measured.width > 0 && measured.height > 0, `${label}: thumbnail fit matches its actual owner-window box (${JSON.stringify(measured)})`);
}
async function noteKeyboardNavigation(label) {
  await js("document.querySelector('.expanded-preview').focus()");
  let reached = false;
  for (let i = 0; i < 16; i++) {
    await key("Tab");
    if (await js("document.activeElement?.tagName==='TEXTAREA'")) { reached = true; break; }
  }
  check(reached, `${label}: Tab reaches the note textarea from preview controls`);
  await key("Tab");
  check(await js("document.activeElement?.getAttribute('aria-label')==='Find similar names'"), `${label}: Tab after the textarea wraps within the preview`);
  await key("Tab", ["shift"]);
  check(await js("document.activeElement?.tagName==='TEXTAREA'"), `${label}: Shift+Tab wraps back into the note textarea`);
}
async function search(value) { await js(`(()=>{const n=document.querySelector('.search-in');n.value=${JSON.stringify(value)};n.dispatchEvent(new Event('input',{bubbles:true}))})()`); await paint(); }
async function armPreviewTiming() {
  await js(`(()=>{window.__previewTiming=null;document.addEventListener('pointerdown',()=>{const start=performance.now();requestAnimationFrame(()=>requestAnimationFrame(()=>{window.__previewTiming={ms:performance.now()-start,visible:!!document.querySelector('[aria-label="Expanded plot preview"]')}}))},{capture:true,once:true})})()`);
}
const modal = '[aria-label="Expanded plot preview"]';
const row = extension => `.importer .row[data-path="${root.replaceAll("\\", "/")}/plots/study/source.${extension}"]`;
async function main() {
  owner = win = await wait(() => BrowserWindow.getAllWindows()[0], "app window");
  win.setSize(1440, 1000); win.show();
  watchErrors(win);
  await wait(() => js("!!document.querySelector('button[aria-label=Slide]')&&!!document.querySelector('.cm-editor,.slide-mode')"), "scratch project opened");
  check(app.getPath("userData").startsWith(scratch + path.sep) && await js("!window.__flux&&location.protocol==='file:'"), "built production app runs actual preload with isolated config and no development handles");
  await click('button[aria-label="Slide"]');
  // The mode wrapper mounts before its checked asynchronous document load.
  // Wait for the resident fixture content and enabled gallery control, not
  // the loading shell; preview timings still start at the actual pointerdown.
  await wait(() => js(`!!document.querySelector('.mc:not([inert]) .slide-mode [data-editor-element-id="underneath"]')&&[...document.querySelectorAll('.mc:not([inert]) .slide-mode .toolbar button')].some(n=>n.textContent.trim()==='Plots & videos'&&!n.disabled)`), "slide content and gallery ready");
  await clickText(".mc:not([inert]) .slide-mode .toolbar button", "Plots & videos"); await wait(() => js("!!document.querySelector('.importer')"), "gallery loaded");
  await search("source.svg"); await wait(() => js(`!!document.querySelector(${JSON.stringify(row("svg"))})`), "source image listed");
  await armPreviewTiming();
  await click(row("svg"), [process.platform === "darwin" ? "meta" : "control"]);
  await wait(() => js(`!!document.querySelector('${modal} img')?.naturalWidth`), "full image decoded");
  check(await js(`(()=>{const n=document.querySelector('${modal}'),r=n.getBoundingClientRect();const box=document.querySelector('.iwrap').getBoundingClientRect();return Math.abs(r.width-box.width)<1&&Math.abs(r.height-box.height)<1&&Math.abs(r.x-box.x)<1&&Math.abs(r.y-box.y)<1&&!document.querySelector('.importer .row.picked')})()`), "Ctrl-click opens a full-window image without changing picks");
  timings.push({label:"image preview",...await js("window.__previewTiming")});
  await key("D"); await wait(() => js("document.querySelectorAll('[data-dissect-cell]').length===2"), "dissection group loaded");
  await click('[data-dissect-cell][data-name="subject.svg"]'); await click('[data-dissect-cell][data-name="subject.svg"]', [], 2);
  await wait(() => js("!!document.querySelector('.dissection-detail img')?.naturalWidth"), "dissection image decoded");
  check(await js(`document.activeElement===document.querySelector('${modal}')`), "opening dissection detail retains keyboard focus inside the preview");
  await click(`${modal} [aria-label="Zoom in"]`);
  check(await js("document.querySelector('[data-dissect-zoom]')?.textContent!=='fit'"), "dissections reuse working image zoom controls");
  await fs.writeFile(path.join(output, "native-dissection.png"), (await win.webContents.capturePage()).toPNG());
  await key("Escape"); check(await js("!!document.querySelector('[data-dissect-grid]')"), "Escape returns from dissection detail to its grid");
  await click('[data-dissect-cell][data-name="review.txt"]', [], 2);
  await wait(() => js(`!!document.querySelector('${modal} textarea:not(:disabled)')`), "native note editor loaded");
  await noteKeyboardNavigation("Docked note");
  await click(`${modal} textarea`);
  win.webContents.sendInputEvent({ type:"keyDown", keyCode:"A", modifiers:[process.platform === "darwin" ? "meta" : "control"] });
  win.webContents.sendInputEvent({ type:"keyUp", keyCode:"A", modifiers:[process.platform === "darwin" ? "meta" : "control"] });
  await win.webContents.insertText("Native note #TODO persisted on close");
  // Close immediately, before the idle-save timer: blur/unmount must flush the captured draft.
  await click('[aria-label="Close preview"]');
  await wait(async()=>await fs.readFile(path.join(root,"plots/_dissections/study/source/by_subject/review.txt"),"utf8")==="Native note #TODO persisted on close","native note persisted after immediate close");
  check(true,"actual native note typing persists through the real confined preload channel on immediate close");
  check(await js(`!document.querySelector('${modal}')&&!!document.querySelector('.importer')`), "closing the note preview preserves the gallery");
  await click(".pinbtn");
  win = await wait(() => BrowserWindow.getAllWindows().find(candidate => candidate !== owner), "pinned window"); win.show();
  watchErrors(win);
  await wait(() => js("!!document.querySelector('.detached .importer')"), "gallery moved into pinned window");
  await search("source.svg"); await click(row("svg"), [process.platform === "darwin" ? "meta" : "control"]);
  await wait(() => js(`!!document.querySelector('${modal} img')?.naturalWidth`), "pinned image preview loaded");
  await key("D"); await wait(() => js("document.querySelectorAll('[data-dissect-cell]').length===2"), "pinned note group loaded");
  await click('[data-dissect-cell][data-name="review.txt"]', [], 2);
  await wait(() => js(`!!document.querySelector('${modal} textarea:not(:disabled)')`), "pinned note editor loaded");
  await noteKeyboardNavigation("Pinned note");
  await click(`${modal} textarea`);
  win.webContents.sendInputEvent({ type:"keyDown", keyCode:"A", modifiers:[process.platform === "darwin" ? "meta" : "control"] });
  win.webContents.sendInputEvent({ type:"keyUp", keyCode:"A", modifiers:[process.platform === "darwin" ? "meta" : "control"] });
  await win.webContents.insertText("Pinned native note #TODO persisted on close");
  await click('[aria-label="Close preview"]');
  await wait(async()=>await fs.readFile(path.join(root,"plots/_dissections/study/source/by_subject/review.txt"),"utf8")==="Pinned native note #TODO persisted on close","pinned native note saved");
  check(true,"note editing and save listeners survive moving the gallery into its native utility window");
  await search("source.mp4"); await wait(() => js(`!!document.querySelector(${JSON.stringify(row("mp4"))})`), "movie listed");
  await armPreviewTiming();
  await click(row("mp4"), [process.platform === "darwin" ? "meta" : "control"]);
  await wait(() => js("(()=>{const v=document.querySelector('video[data-gallery-preview-media]');return v?.videoWidth===160&&v.currentTime>.05&&!v.paused})()"), "native movie playing from range stream");
  timings.push({label:"pinned video preview",...await js("window.__previewTiming")});
  const videoUrl = await js("document.querySelector('video[data-gallery-preview-media]').src");
  check(videoUrl.startsWith("flux-media://video/") && await js("!!document.querySelector('video[data-gallery-preview-media]').controls"), "pinned full preview plays real video through scoped native streaming with controls");
  await fs.writeFile(path.join(output, "native-video.png"), (await win.webContents.capturePage()).toPNG());
  await js("window.__previousVideo=document.querySelector('video[data-gallery-preview-media]');void 0");
  await click('[aria-label="Dissections"]');
  await wait(async () => (await net.fetch(videoUrl)).status === 403, "video capability released on tab change");
  check(await js("window.__previousVideo.paused&&!window.__previousVideo.getAttribute('src')"), "switching to dissections releases the video decoder and sound");
  await key("Escape");
  check(await js(`!document.querySelector('${modal}')&&!!document.querySelector('.importer')&&!document.querySelector('.importer .row.picked')`), "native pinned preview closes without selecting or importing the movie");
  // Size observers must follow the adopted DOM even when the opener stops
  // painting. Then return the same mounted thumbnails and resize them again.
  await search('source.svg'); await previewSize('Pinned initial');
  owner.hide();
  for (const [width, height] of [[1180, 820], [982, 760]]) {
    stage = `pinned resize ${width}x${height}`;
    win.setSize(width, height); await previewSize(stage);
  }
  stage = 'dock gallery into opener';
  await focus();
  const pinned = win, dockPoint = await js("(()=>{const r=document.querySelector('.pinbtn').getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()");
  win.webContents.sendInputEvent({ type: 'mouseMove', ...dockPoint });
  win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...dockPoint });
  win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...dockPoint });
  win = owner; owner.show();
  await wait(() => pinned.isDestroyed(), 'pinned window closes after docking');
  await wait(() => js("!!document.querySelector('.iwrap:not(.detached) .importer')"), 'same mounted gallery returns to opener');
  owner.setSize(1502, 1010); await previewSize('Docked after return and resize');
  await click('.pinbtn');
  win = await wait(() => BrowserWindow.getAllWindows().find(candidate => candidate !== owner), 'gallery repins after size-observer return');
  watchErrors(win); win.show();
  await wait(() => js("!!document.querySelector('.detached .importer')"), 'repinned gallery mounted');
  await previewSize('Repinned after return');
  check(timings.every(t=>t.visible&&t.ms<=100), `preview controls paint within 100ms: ${JSON.stringify(timings)}`);
  check(errors.length === 0, `production renderer consoles clean: ${errors.join('; ')}`);
  await fs.writeFile(path.join(output, "native.json"), JSON.stringify({ checks, timings }, null, 2));
  win.close(); owner.close();
  if (process.platform === "darwin") await wait(() => owner.isDestroyed(), "owner closed").then(() => app.quit());
}
app.whenReady().then(main).catch(async error => {
  console.error(error.stack);
  if (win && !win.isDestroyed()) { console.error(await js("document.body.textContent.slice(-16000)")); await fs.writeFile(path.join(output, "native-failed.png"), (await win.webContents.capturePage()).toPNG()).catch(() => {}); }
  app.exit(1);
});
