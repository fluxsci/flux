"use strict";
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs/promises"), path = require("node:path");
const root = process.env.PROBE_PROJECT, scratch = process.env.PROBE_SCRATCH, output = process.env.PROBE_ARTIFACTS;
if (!root || !scratch || !output) throw new Error("Isolated video-clip probe required");
require("../../electron/entry.cjs");
let win;
const checks = [], errors = [];
const js = code => win.webContents.executeJavaScript(code, true);
const paint = () => js("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))");
const check = (value, label) => { checks.push({ ok: !!value, label }); console.log("PROBE " + JSON.stringify(checks.at(-1))); if (!value) throw new Error(label); };
async function wait(fn, label, timeout = 30000) { const start = Date.now(); while (Date.now() - start < timeout) { try { const result = await fn(); if (result) return result; } catch {} await new Promise(resolve => setTimeout(resolve, 60)); } throw new Error(`Timeout: ${label}`); }
async function focusInput() {
  // On macOS focusing a window does not necessarily activate its application.
  // Wait for actual native/web focus before measuring or sending input.
  await wait(async()=>{app.focus({steal:true});win.focus();win.webContents.focus();return win.isFocused()&&await js('document.hasFocus()');},'native input focus');
}
async function click(selector) {
  await focusInput();
  const point = await js(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n)throw Error('Missing '+${JSON.stringify(selector)});const b=n.getBoundingClientRect();return{x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height/2)}})()`);
  win.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...point }); win.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...point }); await paint();
}
async function clickText(selector, text) {
  await js(`(()=>{const n=[...document.querySelectorAll(${JSON.stringify(selector)})].find(n=>n.textContent.trim()===${JSON.stringify(text)});if(!n)throw Error('Missing '+${JSON.stringify(text)});n.dataset.nativeHit='1';})()`); await click('[data-native-hit="1"]'); await js("document.querySelector('[data-native-hit]')?.removeAttribute('data-native-hit')");
}
async function key(keyCode, modifiers = []) { await focusInput(); win.webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers }); win.webContents.sendInputEvent({ type: "keyUp", keyCode, modifiers }); await paint(); }
const disk = async () => JSON.parse(await fs.readFile(path.join(root, "slides/video-deck/deck.json"), "utf8"));
async function main() {
  win = await wait(() => BrowserWindow.getAllWindows()[0], "window");
  win.setSize(1440, 1000); win.setAlwaysOnTop(true); win.show(); win.focus();
  await wait(() => js("!!document.querySelector('button[aria-label=Slide]')&&!!document.querySelector('.cm-editor')"), "project open");
  win.webContents.on("console-message", (_event, level, message) => { if (level === 3) errors.push(message); });
  check(app.getPath("userData").startsWith(scratch + path.sep), "native clip test uses isolated configuration");
  check(await js("!window.__flux&&location.protocol==='file:'"), "built editor uses the actual preload without dev handles");
  const figureFiles = await fs.readdir(path.join(root, "fig/assets")).catch(() => []);
  await click('button[aria-label="Slide"]'); await wait(() => js("!!document.querySelector('[data-editor-element-id=box]')"), "slide open");
  await clickText('.toolbar button', 'Plots & videos'); await wait(() => js("!!document.querySelector('.importer')"), "gallery open");
  await wait(() => js("[...document.querySelectorAll('.importer .nm')].some(n=>n.textContent==='_videos')"), "video source folder");
  await clickText('.importer .row .nm', '_videos');
  await wait(() => js("document.querySelectorAll('.preview img').length===2&&[...document.querySelectorAll('.preview img')].every(n=>n.complete&&n.naturalWidth>0)"), "native bounded poster previews");
  await js("Promise.all([...document.querySelectorAll('.preview img')].map(image=>image.decode()))"); await paint();
  check(await js("[...document.querySelectorAll('.preview img')].every(image=>{const c=document.createElement('canvas');c.width=image.naturalWidth;c.height=image.naturalHeight;const ctx=c.getContext('2d');ctx.drawImage(image,0,0);const data=ctx.getImageData(0,0,c.width,c.height).data;let red=0;for(let i=0;i<data.length;i+=4)if(data[i]>180&&data[i+1]<90&&data[i+2]<90)red++;return red>10;})"), 'native gallery posters contain decoded video pixels');
  check(await js("[...document.querySelectorAll('.importer .nm')].some(n=>n.textContent==='camera')"), "native gallery discovers both MP4 and MOV clips");
  await fs.writeFile(path.join(output, "native-gallery.png"), (await win.webContents.capturePage()).toPNG());
  await clickText('.importer .row .nm', 'moving-box'); await click('.insbtn');
  await wait(() => js("!document.querySelector('.importer')"), "native video prepared", 60000);
  let deck = await wait(async () => { const deck = await disk(); return deck.slides[0].elements.some(e => e.type === 'video') && deck; }, "import autosaved");
  let clip = deck.slides[0].elements.find(e => e.type === 'video');
  const asset = deck.assets.find(a => a.id === clip.assetId), poster = deck.assets.find(a => a.id === clip.posterAssetId);
  check(asset?.kind === 'mp4' && asset.hasAudio && asset.sourcePath === 'plots/_videos/moving-box.mp4' && poster?.kind === 'png', "native preparation persists portable movie and poster metadata");
  check((await fs.stat(path.join(root, 'slides/video-deck', asset.path))).size > 1000 && (await fs.stat(path.join(root, 'slides/video-deck', poster.path))).size > 100, "native preparation writes both full movie and bounded poster");
  await click(`[data-editor-element-id="${clip.id}"]`);
  await click('[aria-label="Undo"]'); await wait(() => js(`!document.querySelector('[data-editor-element-id="${clip.id}"]')`), "import undone");
  await click('[aria-label="Redo"]'); await wait(() => js(`!!document.querySelector('[data-editor-element-id="${clip.id}"] image')`), "import redone");
  check(true, "native Undo and Redo preserve playable video dependencies");
  await click(`[data-editor-element-id="${clip.id}"]`);
  const x = clip.x;
  await js("window.__videoInput=[];window.__videoKey=e=>{if(e.key==='ArrowRight'){const t=performance.now();requestAnimationFrame(()=>requestAnimationFrame(()=>window.__videoInput.push(performance.now()-t)))}};window.addEventListener('keydown',window.__videoKey,true);void 0");
  for (let i = 0; i < 12; i++) await key('Right');
  const times = await js("window.removeEventListener('keydown',window.__videoKey,true);window.__videoInput");
  const p95 = [...times].sort((a,b) => a-b)[Math.floor(times.length*.95)];
  deck = await wait(async () => { const d = await disk(); return d.slides[0].elements.find(e => e.id === clip.id)?.x === x+12 && d; }, 'native movement persisted');
  check(times.length === 12 && p95 <= 100, `native video manipulation input p95 ${p95.toFixed(1)}ms ≤100ms`);
  // Native mouse input requires the focused webContents and a hit-tested point.
  // The earlier bare mouseDown could miss after a native window focus change;
  // an actual pointer move also establishes hover before the button press.
  await focusInput();
  const handleSelector='.mc:not([inert]) .slide-mode .overlay-svg .handle:last-of-type';
  const handle = await wait(()=>js(`(()=>{const n=document.querySelector(${JSON.stringify(handleSelector)});if(!n)return;const b=n.getBoundingClientRect(),x=Math.round(b.x+b.width/2),y=Math.round(b.y+b.height/2);if(document.elementFromPoint(x,y)!==n)return;return{x,y}})()`),'native resize handle hit');
  win.webContents.sendInputEvent({type:'mouseMove',...handle}); await paint();
  await js(`window.__videoResizeDown=null;window.addEventListener('pointerdown',event=>{window.__videoResizeDown={handle:event.target.matches(${JSON.stringify(handleSelector)}),trusted:event.isTrusted,buttons:event.buttons};},{once:true,capture:true});void 0`);
  win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...handle });
  const down=await wait(()=>js('window.__videoResizeDown'),'native resize pointer down');
  check(down.handle&&down.trusted&&down.buttons===1,'native resize starts on the intended visible handle with the left button held');
  for (let i = 1; i <= 6; i++) { win.webContents.sendInputEvent({ type: 'mouseMove', button:'left', modifiers:['leftbuttondown'], x: handle.x + i*6, y: handle.y + i*4 }); await paint(); }
  win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: handle.x+36, y: handle.y+24 }); await paint();
  deck = await wait(async () => { const d = await disk(); return d.slides[0].elements.find(e => e.id === clip.id)?.width !== clip.width && d; }, 'native resize persisted');
  clip = deck.slides[0].elements.find(e => e.id === clip.id);
  check(Math.abs(clip.width/clip.height-160/90)<.001, 'native resize keeps clip proportions');
  check(await js("[...document.querySelectorAll('.inspector .nf .lb')].some(n=>n.textContent==='W')"), 'native Inspector exposes video width and height');
  await click('[aria-label="Mute video"]'); await click('[aria-label="Loop video"]');
  await clickText('.deckbar button','Animate ⏱'); await click('.step[data-step-index="1"]'); await clickText('.animator .actions button','Appear');
  await click('.step[data-step-index="2"]');
  await js("(()=>{const n=document.querySelector('.step-controls select');n.value='click';n.dispatchEvent(new Event('change',{bubbles:true}));})()");
  await clickText('.animator .actions button','Start video');
  deck = await wait(async () => { const d=await disk(); return d.slides[0].beats[2].tracks.some(t=>t.target===clip.id&&t.preset==='videoStart')&&d; },'separate commands saved');
  check(deck.slides[0].beats[1].tracks.some(t=>t.target===clip.id&&t.preset==='fade') && deck.slides[0].elements.find(e=>e.id===clip.id).muted, 'native authoring separates first-frame appearance and later playback');
  await clickText('.deckbar button','Present ▶'); await wait(()=>js("!!document.querySelector('.present video')"),'presentation opened');
  await key('Right');
  await wait(()=>js("(()=>{const v=document.querySelector('.present video'),box=document.querySelector('.present [data-el-id=box]');return v&&box&&parseFloat(getComputedStyle(box).left)+new DOMMatrix(getComputedStyle(box).transform).m41>239&&Number(getComputedStyle(v.parentElement).opacity)>.99&&v.paused&&v.currentTime<.05})()"),'first-frame appearance complete');
  check(await js("document.querySelectorAll('.present .hud .dot.on').length===2"), 'presentation waits after appearance with the clip visible and paused');
  await key('Right'); await wait(()=>js("(()=>{const v=document.querySelector('.present video');return v&&!v.paused&&v.currentTime>.1})()"),'presentation start command');
  await clickText('.present .hud button','Pause playback'); check(await js("document.querySelector('.present video').paused"),'presentation HUD pauses clip playback');
  await clickText('.present .hud button','Resume playback'); await wait(()=>js("!document.querySelector('.present video').paused"),'presentation HUD resumes playback');
  await clickText('.present .hud button','Esc'); await wait(()=>js("!document.querySelector('.present')"),'presentation closed');
  await clickText('.animator .transport button','▶ Play');
  await wait(()=>js("(()=>{const v=document.querySelector('.preview-overlay video');return v&&!v.paused&&v.currentTime>.15&&v.videoWidth===160})()"),'real capability URL decoding',15000);
  check(await js("document.querySelector('.preview-overlay video').src.startsWith('flux-media://')"), 'preview streams through the native media capability protocol');
  await fs.writeFile(path.join(output,'native-playing.png'),(await win.webContents.capturePage()).toPNG());
  await clickText('.animator .transport button','Ⅱ Pause'); check(await js("document.querySelector('.preview-overlay video').paused"),'native Pause freezes the clip');
  await clickText('.animator .transport button','▶ Play'); await wait(()=>js("!document.querySelector('.preview-overlay video').paused"),'native resume');
  await clickText('.animator .transport button','■ Stop'); check(await js("!document.querySelector('.preview-overlay video')"),'native Stop releases decoder and sound');
  await click('button[aria-label="Figure"]'); await wait(()=>js("!!document.querySelector('.mc:not([inert]) .figure-mode')"),'figure mode');
  await click('button[aria-label="Slide"]'); await wait(()=>js(`!!document.querySelector('[data-editor-element-id="${clip.id}"] image')`),'deck reopen');
  check(await js("!document.querySelector('.toast.err')"),'reopening the deck resolves prepared media without an import error');
  await clickText('.inspector-tabs button','Slide'); await clickText('.panel:not([hidden]) button','Save as preset…');
  await wait(()=>js("!!document.querySelector('[aria-label=\"Slide presets\"]')"),'preset dialog');
  await js("(()=>{const n=document.querySelector('[aria-label=\"Slide presets\"] input');n.value='Portable recording';n.dispatchEvent(new Event('input',{bubbles:true}));})()");
  await clickText('[aria-label="Slide presets"] button','Save preset');
  await wait(()=>js("!document.querySelector('[aria-label=\"Slide presets\"]')"),'portable preset saved');
  const stored=await js("window.fig.readSlideLibrary()");
  const saved=stored.find(entry=>entry.preset?.name==='Portable recording'||entry.payload?.name==='Portable recording');
  const rawPreset=saved?.preset??saved?.payload;
  check(rawPreset?.assets?.some(entry=>entry.asset.kind==='mp4'&&entry.data.startsWith('data:video/mp4;base64,')), 'portable slide preset embeds movie bytes instead of an expiring capability');
  await click('.deckpicker .dp-new'); await wait(()=>js("document.querySelector('.deckpicker .dp-item.active .dp-title')?.textContent==='Deck 2'"),'destination deck');
  await clickText('.filmstrip button','+ Preset'); await wait(()=>js("!!document.querySelector('[aria-label=\"Slide presets\"] .card.pickable')"),'preset library loaded');
  await click('[aria-label="Slide presets"] .card.pickable');
  const newId=await wait(async()=>{const manifest=JSON.parse(await fs.readFile(path.join(root,'project.json'),'utf8'));return manifest.slides?.find(deck=>deck.id!=='video-deck')?.id;},'new deck identity');
  const portable=await wait(async()=>{const d=JSON.parse(await fs.readFile(path.join(root,'slides',newId,'deck.json'),'utf8'));return d.slides.some(slide=>slide.elements.some(el=>el.type==='video'))&&d;},'portable clip autosaved');
  const movedClip=portable.slides.flatMap(slide=>slide.elements).find(el=>el.type==='video'),movedAsset=portable.assets.find(asset=>asset.id===movedClip.assetId),movedPoster=portable.assets.find(asset=>asset.id===movedClip.posterAssetId);
  check(movedClip.assetId!==clip.assetId&&movedClip.posterAssetId!==clip.posterAssetId&&(await fs.stat(path.join(root,'slides',newId,movedAsset.path))).size>1000&&(await fs.stat(path.join(root,'slides',newId,movedPoster.path))).size>100, 'inserting a portable preset writes independently owned movie and poster assets into the destination deck');
  await click('button[aria-label="Figure"]'); await wait(()=>js("!!document.querySelector('.mc:not([inert]) .figure-mode')"),'leave portable deck');
  await click('button[aria-label="Slide"]');
  await wait(()=>js("document.querySelector('.mc:not([inert]) .deckpicker .dp-item.active .dp-title')?.textContent==='Deck 2'"),'reopen destination deck');
  await clickText('.mc:not([inert]) .filmstrip .thumb .nm','Portable recording');
  await wait(()=>js(`!!document.querySelector('[data-editor-element-id="${movedClip.id}"] image')`),'select reopened portable slide');
  if(await js("!document.querySelector('.animator')"))await clickText('.deckbar button','Animate ⏱');
  await click('.step[data-step-index="2"]'); await clickText('.animator .transport button','▶ Play');
  await wait(()=>js("(()=>{const v=document.querySelector('.preview-overlay video');return v&&!v.paused&&v.currentTime>.1&&v.src.startsWith('flux-media://')})()"),'reopened portable movie decodes',15000);
  check(true,'portable preset plays after destination deck reopening through a fresh native media URL');
  await clickText('.animator .transport button','■ Stop');
  check(JSON.stringify(await fs.readdir(path.join(root,'fig/assets')).catch(()=>[])) === JSON.stringify(figureFiles),'video insertion never writes Figure assets');
  check(errors.length===0,`native renderer console clean: ${errors.join('; ')}`);
  await fs.writeFile(path.join(output,'native-editor.json'),JSON.stringify({checks,inputP95:p95},null,2));
  app.exit(0);
}
app.whenReady().then(main).catch(async error=>{console.error(error.stack);if(win&&!win.isDestroyed()){console.error(await js("document.querySelector('.importer')?.textContent||document.querySelector('.slide-mode')?.textContent"));await fs.writeFile(path.join(output,'native-failed.png'),(await win.webContents.capturePage()).toPNG()).catch(()=>{});}app.exit(1);});
