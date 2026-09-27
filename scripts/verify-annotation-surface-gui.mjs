// W4b: one real composer across all surfaces. No native screenshot claim here:
// memBridge supplies an identifiable PNG; the native child capture has its own gate.
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { launch, gotoApp, clickMode, realErrors, waitFor, APP_URL } from './lib/driver.mjs';
import { harness } from './lib/harness.mjs';
import { NOTE, chord, openAnnotation, cancelAnnotation, fillNote, center, drag, seedAnnotationFigure, ledger, findPlotPoint } from './lib/annotationFixture.mjs';
const h=harness('verify-annotation-surface-gui'), {browser,page}=await launch({width:1500,height:1000});
const waitClosed=()=>waitFor(page,()=>!document.querySelector('[data-annotation-surface]'),null,{label:'saved annotation closed'}).catch(async e=>{const why=await page.evaluate(()=>{const s=document.querySelector('[data-annotation-surface]');const b=s?.querySelector('button.primary');return `${s?.querySelector('[role="alert"]')?.textContent??'(no error shown)'} · Add button "${b?.textContent?.trim()}"${b?.disabled?' (disabled)':''} · note "${s?.querySelector('textarea')?.value}"`;});throw new Error(`${e.message}; the composer says: ${why}`);});
const clickText=(selector,text)=>page.evaluate(({selector,text})=>{const el=[...document.querySelectorAll(selector)].find(e=>e.textContent.trim()===text);if(!el)throw Error('Missing '+text);el.click();},{selector,text});
const add=async text=>{await fillNote(page,text);await page.keyboard.press('Enter');await waitClosed();};
const queue=async()=>{await page.click('.inbox-link button');await page.waitForSelector('.inbox-panel');};
const closeInbox=async()=>{await page.click('.inbox-panel header [aria-label="Close Inbox"]');await waitFor(page,()=>!document.querySelector('.inbox-panel'),null,{label:'Inbox closed'});};
const inboxAction=async(id,name)=>{await page.click(`[data-inbox-row][data-item-id="${id}"]`);await clickText('.detail .actions button',name);};
const chip=()=>page.$eval('.target-chips',el=>el.textContent);
const selectTool=code=>chord(page,code,{altKey:true});
try {
 await gotoApp(page,{url:APP_URL}); await chord(page);
 await waitFor(page,()=>document.body.textContent.includes('Open a project to annotate'),null,{label:'Home toast'});
 h.ok(!await page.$('[data-annotation-surface]'),'Home toasts without opening a surface');
 await gotoApp(page,{url:APP_URL+'?fixture=demo'}); await seedAnnotationFigure(page);
 // No installed CLI in this run: the background route must explain itself and refuse to save
 // (verify-inbox-gui and verify-background-run-gui cover the available case).
 await waitFor(page,()=>!!window.__fluxRefreshBackground,null,{label:'background store'});
 await page.evaluate(async()=>{window.fig._setRunnerCapabilities([{driver:'claude',detected:false,available:false,reason:'Claude Code is not installed on PATH'},{driver:'codex',detected:false,available:false,reason:'Codex is not installed on PATH'}]);await window.__fluxRefreshBackground();});
 const p=await findPlotPoint(page), textPoint=await center(page,'[data-editor-element-id="annot-text"]');
 // Hold capture on a barrier. The real cold/async path must keep every key.
 await page.evaluate(()=>{const capture=window.fig.captureWindow;window.__annotationCapture=capture;window.fig.captureWindow=async options=>{window.__captureSawOverlay=!!document.querySelector('[data-annotation-surface]');await new Promise(r=>window.__releaseCapture=r);return capture(options);};window.__annotationStart=performance.now();});
 await chord(page); await page.keyboard.type('abc');
 await page.evaluate(()=>window.__releaseCapture());
 await waitFor(page,()=>document.activeElement===document.querySelector('.annotation-composer textarea'),null,{label:'early typing focused'});
 h.ok(await page.$eval(NOTE,e=>e.value)==='abc','Typing abc immediately after the chord loses no characters');
 const ms=await page.evaluate(()=>performance.now()-window.__annotationStart);
 h.ok(!await page.evaluate(()=>window.__captureSawOverlay),'Capture starts before overlay paint');
 h.ok(ms<=1000,`Chord to focused composer ${Math.round(ms)} ms (≤1000, including capture barrier)`);
 await page.evaluate(()=>window.fig.captureWindow=window.__annotationCapture);
 h.ok(await page.$eval('.annotation-tools button[aria-pressed="true"]',e=>e.textContent.includes('arrow')),'Arrow is the default tool');
 h.ok(await page.$eval('.annotation-shot',e=>e.naturalWidth>0),'The frozen PNG is displayed');
 await page.mouse.move(p.x,p.y);
 await waitFor(page,()=>!!document.querySelector('[data-annotation-surface] .target-label'),null,{label:'plot hover'});
 h.ok(await page.$eval('[data-annotation-surface] .target-label',(e,label)=>e.textContent.includes(label),p.label),'Plot-part hover shows the semantic label');
 await selectTool('ArrowUp'); h.ok(await page.$eval('[data-annotation-surface] .target-label',e=>!e.textContent.includes('›')&&e.textContent.includes('Density')),'Alt+↑ widens part to plot');
 await selectTool('ArrowUp'); h.ok(await page.$eval('[data-annotation-surface] .target-label',e=>e.textContent.includes('Annotation figure')),'Alt+↑ widens plot to figure');
 await selectTool('ArrowDown');await selectTool('ArrowDown');
 await drag(page,{x:p.x+80,y:p.y+50},p);
 h.ok(await page.$eval('.annotation-marks .mark',e=>e.dataset.kind==='arrow'&&e.dataset.n==='1'&&e.querySelector('.badge-n').textContent==='1'),'Drag draws numbered arrow #1');
 h.ok(await page.$eval('.target-chips',(el,id)=>[...el.querySelectorAll('[data-target]')].some(e=>e.dataset.target.includes('#'+id)),p.ref.partId),'Arrow tip adds its semantic target chip');
 await page.mouse.move(textPoint.x,textPoint.y);
 h.ok(await page.$eval('[data-annotation-surface] .target-label',e=>e.textContent.includes('Sample size')),'Text-box hover names the text object');
 const r=await page.evaluate(()=>{const a=document.querySelector('[data-editor-element-id="annot-text"]').getBoundingClientRect(),b=document.querySelector('[data-editor-element-id="annot-box1"]').getBoundingClientRect();return {a:{x:a.left-3,y:a.top-3},b:{x:b.right+3,y:Math.max(a.bottom,b.bottom)+3}};});
 await selectTool('KeyB');await drag(page,r.a,r.b);
 h.ok(await page.$$eval('.mark',els=>els.length===2&&els[1].dataset.kind==='box'),'Alt+B draws a box without typing Option characters');
 h.ok((await chip()).includes('Sample size')&&(await chip()).includes('Box 1'),'Box resolves all contained elements');
 await selectTool('KeyZ');h.ok(await page.$$eval('.mark',els=>els.length===1),'Alt+Z undoes one mark and its targets');
 await selectTool('KeyP');await drag(page,textPoint,{x:textPoint.x+20,y:textPoint.y+10});
 h.ok(await page.$$eval('.mark',els=>els.at(-1).dataset.kind==='pen'),'Alt+P draws a pen stroke');
 await selectTool('KeyZ');
 await fillNote(page,'Arrow review #layout');
 h.ok(await page.$eval('.tags',e=>e.textContent.includes('#layout')),'Tags appear live');
 await page.keyboard.press('Enter');await waitClosed();
 let lines=await ledger(page), note=lines.find(e=>e.kind==='note');
 h.ok(lines.length===1&&note.text==='Arrow review #layout'&&note.context.snapshot.marks[0].anchor?.path,'Enter writes exactly one note with its anchor');
 h.ok(note.context.targets.some(t=>t.kind==='part')&&note.context.snapshot.marks[0].targets[0].partId===p.ref.partId,'Ledger carries both stamp targets and per-mark targets');
 h.ok(await page.evaluate(async rel=>{const F=window.__flux,root=F.get(F.shell.currentProject).path;const b=new Uint8Array(await window.fig.readFile(root+'/'+rel));return b[0]===137&&b[1]===80;},note.context.snapshot.image),'PNG is saved alongside the ledger');
 // Attach preference, crop-free screenshot cap, cancel/toggle drafts, and Enter semantics.
 await openAnnotation(page);await page.click('.actions input[type=checkbox]');await fillNote(page,'draft kept');await page.keyboard.down('Shift');await page.keyboard.press('Enter');await page.keyboard.up('Shift');await page.keyboard.type('second line');await cancelAnnotation(page);
 await openAnnotation(page);
 h.ok(await page.$eval(NOTE,e=>e.value)==='draft kept\nsecond line','Escape retains the draft and Shift+Enter inserts a newline');
 h.ok(!await page.$eval('.actions input',e=>e.checked)&&await page.evaluate(()=>JSON.parse(localStorage.getItem('flux.settings'))['annotate.attachView']===false),'Attach view persists in preferences');
 await page.keyboard.press('Enter');await waitClosed();lines=await ledger(page);
 h.ok(lines.at(-1).context.snapshot==null,'Attach off writes no image');
 await openAnnotation(page);await page.click('.actions input[type=checkbox]');await add('Whole view');
 note=(await ledger(page)).at(-1);
 const size=await page.evaluate(async rel=>{const root=window.__flux.get(window.__flux.shell.currentProject).path;const image=await createImageBitmap(new Blob([await window.fig.readFile(root+'/'+rel)]));return {w:image.width,h:image.height};},note.context.snapshot.image);
 h.ok(Math.max(size.w,size.h)<=1600,'Unmarked screenshot long edge is capped at 1600px');
 await openAnnotation(page);await fillNote(page,'toggle draft');await chord(page);await waitClosed();await openAnnotation(page);
 h.ok(await page.$eval(NOTE,e=>e.value)==='toggle draft','Chord toggles closed and keeps the draft');await add('toggle draft');
 await openAnnotation(page);await fillNote(page,'Retained view');await cancelAnnotation(page);
 await page.evaluate(()=>window.__flux.fig.viewport.update(v=>({...v,panX:v.panX+12})));
 await openAnnotation(page);
 h.ok(await page.$eval('.annotation-tools button',e=>e.disabled),'A changed view cannot receive marks against the draft’s older picture');
 await clickText('.annotation-composer button','Refresh view (clears marks)');
 await waitFor(page,()=>document.activeElement===document.querySelector('.annotation-composer textarea'),null,{label:'refreshed draft focused'});
 h.ok(await page.$eval(NOTE,e=>e.value)==='Retained view'&&!await page.$eval('.annotation-tools button',e=>e.disabled),'Refresh preserves the note and enables drawing on the current picture');await add('Retained view');
 // Edit and Withdraw keep the original stamp/snapshot in an append-only history.
 await openAnnotation(page);await queue();await inboxAction(note.id,'Edit');
 await waitFor(page,()=>document.querySelector('.heading strong')?.textContent==='Edit annotation',null,{label:'edit loaded'});
 await add('Edited whole view');lines=await ledger(page);
 const edited=lines.at(-1);
 h.ok(lines.at(-2).kind==='withdraw'&&lines.at(-2).target===note.id&&edited.context.snapshot.image===note.context.snapshot.image,'Edit withdraws the original and preserves its captured context');
 await inboxAction(edited.id,'Withdraw');
 await waitFor(page,id=>!document.querySelector(`[data-item-id="${id}"]`),edited.id,{label:'withdrawn row'});
 h.ok((await ledger(page)).at(-1).target===edited.id,'Withdraw appends history and removes the active row');await closeInbox();
 // Presence and routing, with external claim/resolve writes through the watcher.
 await page.evaluate(async()=>{const F=window.__flux,root=F.get(F.shell.currentProject).path;for(const [name,watching]of [['heron',true],['wren',false]])await window.fig.writeText(root+'/.meta/live/sessions/'+name+'.json',JSON.stringify({v:1,id:name,name,display:'codex · cli · '+name,product:'codex',surface:'cli',client:'codex',pid:1,host:'fixture',startedAt:new Date().toISOString(),heartbeatAt:new Date().toISOString(),watching,live:watching}));window.fig._emitFsChange({subsystem:'presence',path:root+'/.meta/live/sessions/heron.json'});});
 await openAnnotation(page);await page.click('.to-pill');
 await waitFor(page,()=>document.querySelector('.routes')?.textContent.includes('wren'),null,{timeout:7000,label:'live sessions'});
 h.ok(await page.$eval('.routes',el=>[...el.querySelectorAll('button')].slice(2).map(e=>e.textContent).join('|').match(/^heron.*\|wren/)!=null&&!!el.querySelector('button.muted')),'To lists watching sessions first and greys nonwatching sessions');
 h.ok(await page.$eval('.routes',el=>el.querySelectorAll('.pairing').length===1&&el.querySelector('.pairing')?.textContent==='Pairing'&&el.querySelector('.pairing')?.closest('button').textContent.includes('heron')),'Only live:true sessions carry a Pairing badge');
 await page.click('.to-pill');await fillNote(page,'@any routed');h.ok(await page.$eval('.to-pill',e=>e.textContent.includes('Any')),'@any updates To live');
 await page.keyboard.press('Tab');h.ok(!await page.$eval(NOTE,e=>e.value.includes('@any')),'Tab cycles the pill and strips a superseded mention');
 await fillNote(page,'@new background');h.ok(await page.$eval('.actions .primary',e=>e.disabled)&&await page.$eval('.hint',e=>!!e),'Unavailable background route is explained and cannot silently save');
 await fillNote(page,'@heron Please inspect #review');h.ok(await page.$eval('.to-pill',e=>e.textContent.includes('heron')),'Named mention updates To live');
 await page.keyboard.press('Enter');await waitClosed();lines=await ledger(page);note=lines.at(-2);
 h.ok(note.kind==='note'&&note.text==='Please inspect #review'&&note.route.session.name==='heron'&&lines.at(-1).kind==='assign'&&lines.at(-1).target===note.id,'Named routing strips mention and writes route + assign');
 await openAnnotation(page);await queue();await page.type('.inbox-search','all');
 h.ok(await page.$eval(`[data-item-id="${note.id}"] .status-chip`,e=>e.textContent==='Queued → heron'),'Named queue chip names the recipient');
 const external=async kind=>page.evaluate(async({kind,id})=>{const root=window.__flux.get(window.__flux.shell.currentProject).path,p=root+'/.meta/feedback.ndjson';const event={kind,target:id,ts:new Date().toISOString(),client:'codex',session:{id:'heron',name:'heron',client:'codex'}};if(kind==='resolve')event.author={kind:'agent',name:'heron'};if(kind==='reply'){event.author={kind:'agent',name:'heron'};event.id='reply-heron';event.text='Which axis?';event.state='needs-input';}await window.fig.feedbackAppend(p,JSON.stringify(event)+'\n');window.fig._emitFsChange({subsystem:'feedback',path:p});},{kind,id:note.id});
 await external('claim');await waitFor(page,id=>document.querySelector(`[data-item-id="${id}"] .status-chip`)?.textContent==='Claimed by heron',note.id,{label:'external claim'});
 h.ok(await page.evaluate(()=>window.__flux.get(window.__flux.toast.toasts).some(t=>t.msg.includes('heron claimed'))),'Claim toast names heron');
 await external('reply');await waitFor(page,id=>document.querySelector(`[data-item-id="${id}"] .status-chip`)?.textContent.includes('heron needs your input'),note.id,{label:'needs input'});
 h.ok(true,'Needs-input chip updates live');await external('resolve');await waitFor(page,id=>document.querySelector(`[data-item-id="${id}"] .status-chip`)?.textContent==='Resolved by heron',note.id,{label:'external resolve'});
 h.ok(true,'Resolve chip updates from a second writer');await closeInbox();
 // Figure-Meta, Dissect, Settings, Help, and the global palette.
 await chord(page,'KeyM',{altKey:true});await page.waitForSelector('.figure-meta');await openAnnotation(page);h.ok(!!await page.$('.figure-meta'),'Figure-Meta stays open beneath Annotate');await cancelAnnotation(page);await page.focus('.figure-meta');await page.keyboard.press('Escape');await waitFor(page,()=>!document.querySelector('.figure-meta'),null,{label:'Figure-Meta closed'});
 await page.evaluate(async()=>{const F=window.__flux,root=F.get(F.shell.currentProject).path;await window.fig.writeText(root+'/plots/_dissections/annotation/overview.svg','<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="blue"/></svg>');F.fig.selectOnly('annot-plot');});
 await page.keyboard.press('d');await page.waitForSelector('[data-dissect]');await openAnnotation(page);h.ok(!!await page.$('[data-dissect]'),'Dissect yields the chord and remains underneath');await cancelAnnotation(page);await page.keyboard.press('Escape');
 for(const name of ['settingsOpen','helpOpen']){
  await page.evaluate(async name=>(await import('/src/lib/settings.ts'))[name].set(true),name);await openAnnotation(page);
  h.ok(await page.$eval('[data-annotation-surface]',el=>getComputedStyle(el).zIndex==='2000'),`${name}: annotation z-index is above the modal`);await cancelAnnotation(page);
  await page.evaluate(async name=>(await import('/src/lib/settings.ts'))[name].set(false),name);
 }
 await chord(page,'KeyK',{ctrlKey:true});await page.waitForSelector('.cp input');await page.type('.cp input','Annotate');await page.keyboard.press('Enter');await page.waitForSelector(NOTE);h.ok(true,'Global palette opens Annotate');await cancelAnnotation(page);
 // Paper selection and its own palette.
 await clickMode(page,'Paper');await waitFor(page,()=>!!window.__fluxView,null,{label:'Paper editor'});
 const selected=await page.evaluate(()=>{const v=window.__fluxView,text=v.state.doc.toString(),from=text.indexOf('Question');const a=Math.max(0,from);v.dispatch({selection:{anchor:a,head:Math.min(a+8,text.length)}});v.focus();return text.slice(a,a+8);});
 await openAnnotation(page);h.ok((await chip()).includes(selected),'Paper selection prefills an exact document target');await cancelAnnotation(page);
 await chord(page,'KeyK',{ctrlKey:true});await page.waitForSelector('.cp input');await page.type('.cp input','Annotate');await page.keyboard.press('Enter');await page.waitForSelector(NOTE);h.ok(true,'Paper palette opens the same surface');await cancelAnnotation(page);
 // Library has its own command route; Ctrl+K retains add-box ownership.
 await clickMode(page,'Library');await waitFor(page,()=>!!document.querySelector('.lib'),null,{label:'Library'});
 await clickText('.lib button','Commands…');await page.type('.cp input','Annotate');await page.keyboard.press('Enter');await page.waitForSelector(NOTE);
 h.ok(await page.$eval('.annotation-composer .context',e=>e.textContent.startsWith('library')),'Library command surface opens a Library stamp');await cancelAnnotation(page);
 // Reader drives the real pdf.js selection and ✦ action.
 await clickMode(page,'Reader');await waitFor(page,()=>!!window.__fluxOpenReader&&!!window.__fluxSeedReaderItem,null,{label:'Reader hooks'});
 await page.evaluate(b64=>{window.__fluxSeedReaderItem('annotation2026',b64,{version:1,annotations:[]});window.__fluxOpenReader('annotation2026');},readFileSync('scripts/fixtures/reader-sample.pdf').toString('base64'));
 await page.waitForSelector('.pdf-page .textLayer span');
 const passage=await page.evaluate(()=>{const span=[...document.querySelectorAll('.pdf-page .textLayer span')].find(s=>s.textContent.trim().length>10);const range=document.createRange();range.selectNodeContents(span);const sel=window.getSelection();sel.removeAllRanges();sel.addRange(range);document.dispatchEvent(new Event('selectionchange'));span.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));return span.textContent;});
 await page.waitForSelector('[aria-label="Annotate this passage"]');await page.click('[aria-label="Annotate this passage"]');await page.waitForSelector(NOTE);
 h.ok((await chip()).includes('annotation2026')&&(await chip()).includes(passage.slice(0,20)),'Reader ✦ prefills citekey/page/passage');await cancelAnnotation(page);await openAnnotation(page);h.ok((await chip()).includes('annotation2026'),'Reader chord carries current passage context');await cancelAnnotation(page);
 await page.evaluate(()=>{const span=[...document.querySelectorAll('.pdf-page .textLayer span')].find(s=>s.textContent.trim().length>10),range=document.createRange();range.selectNodeContents(span);const sel=window.getSelection();sel.removeAllRanges();sel.addRange(range);span.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));});
 await page.waitForSelector('.hl-menu .dot');await page.click('.hl-menu .dot');await page.waitForSelector('.annlist [aria-label="Edit highlight"]');await page.click('.annlist [aria-label="Edit highlight"]');
 await page.waitForSelector('.hl-pop [aria-label="Annotate this passage"]');await page.click('.hl-pop [aria-label="Annotate this passage"]');await page.waitForSelector(NOTE);await add('Saved highlight review');
 note=(await ledger(page)).findLast(e=>e.kind==='note');
 h.ok(note.context.targets.some(t=>t.kind==='passage'&&t.highlightId&&t.quote===passage)&&note.context.reader.highlightId,'Saved-highlight ✦ preserves its highlight ID in the stamp and passage target');
 // Slide timeline and Present fullscreen; author one real clip.
 await clickMode(page,'Slide');await waitFor(page,()=>!!window.__flux.get(window.__flux.slide.deckOverlay),null,{timeout:15000,label:'Slide deck'});
 await page.evaluate(()=>{const F=window.__flux,id=F.get(F.fig.activeFigureId);F.fig.commit(p=>p.figures.find(f=>f.id===id).elements.push({type:'rect',id:'annot-slide',name:'Hero',x:50,y:50,width:100,height:80,rotation:0,fill:'#205ea6',stroke:'none',strokeWidth:0,cornerRadius:0}));F.fig.selectOnly('annot-slide');[...document.querySelectorAll('.deckbar button')].find(b=>/Animate/.test(b.textContent))?.click();});
 await page.waitForSelector('.animator');await chord(page,'KeyA');await page.waitForSelector('.lane-row .trk');
 const clipPoint=await center(page,'.lane-row .trk');await openAnnotation(page);await page.mouse.move(clipPoint.x,clipPoint.y);
 h.ok(await page.$eval('[data-annotation-surface] .target-label',e=>e.textContent.includes('clip')),'Animator resolver wins over Slide and labels the clip');await cancelAnnotation(page);
 const before=await page.evaluate(()=>JSON.stringify(window.__flux.slide.currentDeck()));await chord(page,'KeyS');
 h.ok(!await page.$('[data-annotation-surface]')&&await page.evaluate(old=>JSON.stringify(window.__flux.slide.currentDeck())===old,before),'Ctrl+Shift+S is inert in the animator');
 await page.evaluate(()=>[...document.querySelectorAll('.deckbar button')].find(b=>/Present/.test(b.textContent))?.click());await page.waitForSelector('.present');
 // Present enters fullscreen on its own when it opens; F toggles, so press it only if that did not happen.
 await new Promise(r=>setTimeout(r,500));if(!await page.evaluate(()=>!!document.fullscreenElement))await page.keyboard.press('f');
 await waitFor(page,()=>!!document.fullscreenElement,null,{label:'Present fullscreen'});
 await page.keyboard.press('s');
 const presentBefore=await page.$eval('.present',e=>({notes:!!e.querySelector('.notes'),text:e.querySelector('.notes-hint')?.textContent}));
 await openAnnotation(page);h.ok(await page.evaluate(()=>document.fullscreenElement.contains(document.querySelector('[data-annotation-surface]'))),'Annotation is inside the Present fullscreen root');
 h.ok(await page.$eval('.annotation-composer .context',e=>e.textContent.startsWith('present')),'Present stamp names deck, slide, and beat');await cancelAnnotation(page);await chord(page,'KeyS');
 h.ok(await page.$eval('.present',(e,b)=>!!e.querySelector('.notes')===b.notes&&e.querySelector('.notes-hint')?.textContent===b.text,presentBefore),'Present modified M/S leave notes and motion unchanged');
 await page.keyboard.press('f');await page.keyboard.press('Escape');
 // A true unsaved/demo project disables publication, without disabling capture.
 await page.evaluate(()=>window.__flux.shell.currentProject.set({name:'Unsaved demo',path:null}));await openAnnotation(page);await fillNote(page,'demo');
 h.ok(await page.$eval('.actions .primary',e=>e.disabled)&&await page.$eval('.annotation-composer',e=>e.textContent.includes('Demo project — annotations are not saved')),'path:null shows the demo hint and disables Add');await cancelAnnotation(page);
 h.ok((await realErrors(page)).length===0,'Clean console');
 mkdirSync('test-results',{recursive:true});writeFileSync('test-results/annotation-surface-timing.json',JSON.stringify({chordToComposerMs:ms},null,2));
} finally { await browser.close(); }
await h.done();
