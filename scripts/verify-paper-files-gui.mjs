import { launch, gotoApp, clickMode, waitFor, APP_URL, realErrors, shot, sleep } from './lib/driver.mjs';
import { harness } from './lib/harness.mjs';
const h = harness('verify-paper-files-gui');
const {browser,page}=await launch();
const ROOT='/demo/myc-growth-paper';
try {
await gotoApp(page,{url:`${APP_URL}?fixture=demo`,settle:1000});
await page.evaluate(async root=>{
  await window.fig.writeText(`${root}/manuscript/main_files/libs/quarto-html/README.md`,'Generated render support');
  await window.fig.writeText(`${root}/manuscript/old-report_files/libs/quarto-html/README.md`,'Leftover render support');
  await window.fig.writeText(`${root}/Context/NOTEBOOK_files/libs/quarto-html/README.md`,'Generated Context support');
  await window.fig.mkdir(`${root}/manuscript/sections`);
},ROOT);
await clickMode(page,'Paper');
await waitFor(page,()=>!!document.querySelector('.docpicker .dp-item'),null,{timeout:10000});
const read = rel => page.evaluate((p)=>window.fig.readText(p),`${ROOT}/${rel}`);
const exists = rel => page.evaluate((p)=>window.fig.exists(p),`${ROOT}/${rel}`);
const clickLabel = label => page.evaluate(l=>{const b=[...document.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')===l);if(!b)throw new Error(`missing ${l}`);b.click();},label);
const prompt = async name => {
  await waitFor(page,()=>!!document.querySelector('#new-doc-input'),null,{timeout:5000});
  await page.type('#new-doc-input',name);await page.keyboard.press('Enter');
  await waitFor(page,()=>!document.querySelector('#new-doc-input'),null,{timeout:5000});
};
const folderPresent = folder => waitFor(page,p=>!![...document.querySelectorAll('[data-folder]')].find(e=>e.dataset.folder===p),folder,{timeout:5000});
const active = rel => waitFor(page,p=>document.querySelector('.dp-item.active')?.getAttribute('title')===p,rel,{timeout:5000});
const sizes=()=>page.evaluate(()=>({files:document.querySelector('.files-section')?.getBoundingClientRect().height??0,outline:document.querySelector('.outline-section')?.getBoundingClientRect().height??0}));
h.ok(await page.$$eval('[data-folder]',els=>!els.some(e=>/_files(?:\/|$)|\/sections$/.test(e.dataset.folder))),'render output and the unused sections scaffold are absent from the browser');
h.ok(await page.$$eval('.dp-item',els=>!els.some(e=>e.title.endsWith('/README.md'))),'bundled render-library Markdown is absent from Documents and Context');
h.ok(await exists('manuscript/main_files/libs/quarto-html/README.md'),'hiding generated output leaves its files intact');
await shot(page,'paper-generated-folders-hidden');
let s=await sizes();h.ok(Math.abs(s.files-s.outline)<3,'files and outline start at half height');
await page.click('.sidebar-toolbar button:nth-child(2)');s=await sizes();h.ok(s.outline===0 && s.files>400,'hiding outline gives files the full height');
await page.click('.sidebar-toolbar button:nth-child(2)');
await page.click('.sidebar-toolbar button:nth-child(1)');s=await sizes();h.ok(s.files===0 && s.outline>400,'hiding files gives outline the full height');
await page.click('.sidebar-toolbar button:nth-child(1)');
const grip=await page.$('.sidebar-divider');const box=await grip.boundingBox();
await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+box.width/2,box.y+90,{steps:4});await page.mouse.up();
s=await sizes();h.ok(s.files>s.outline+100,'divider drag resizes both sections');
await grip.focus();await page.keyboard.press('Home');s=await sizes();h.ok(Math.abs(s.files-s.outline)<3,'keyboard reset restores half height');
await clickLabel('New folder in Documents');await prompt('Experiments');await folderPresent('manuscript/Experiments');
h.ok(await exists('manuscript/Experiments/.flux-folder'),'folder creation records user intent on disk');
await clickLabel('New folder in Documents');await prompt('sections');await folderPresent('manuscript/sections');
h.ok(true,'explicitly creating sections makes the unused scaffold visible');
await clickLabel('New folder in Experiments');await prompt('Week 1');await folderPresent('manuscript/Experiments/Week 1');
h.ok(true,'nested folders created through the picker');
await clickLabel('New document in Week 1');await prompt('Protocol');
const source='manuscript/Experiments/Week 1/protocol.qmd';await active(source);
h.ok(await exists(source),'document created in the selected nested folder');
h.ok((await read(source)).includes('../../../references/library.bib'),'new nested document points at the project bibliography');
await page.evaluate(()=>{const v=window.__fluxView;v.dispatch({selection:{anchor:v.state.doc.length}});v.focus();});
await page.keyboard.type('/figure',{delay:40});
await waitFor(page,()=>document.querySelector('.cm-tooltip-autocomplete li[aria-selected="true"] .cm-completionLabel')?.textContent==='/figure',null,{timeout:5000});
await sleep(120); // CodeMirror's existing autocomplete interactionDelay is 75ms.
await page.keyboard.press('Enter');await page.waitForSelector('.picker .cell');await page.click('.picker .cell');
await waitFor(page,()=>window.__fluxView.state.doc.toString().includes('../../../fig/renders/'),null,{timeout:5000});
h.ok(true,'figure insertion resolves from the nested document folder');

await page.evaluate(()=>{const v=window.__fluxView;v.dispatch({changes:{from:v.state.doc.length,insert:'\n# Protocol\n\n![Plot](../../../plots/test.svg)\n\nSaved before the move.\n'}});});
// Move while the autosave is pending: relocation must flush the user's latest edit.
const sourceBox=await page.evaluate(p=>{const r=[...document.querySelectorAll('.dp-item')].find(e=>e.title===p).getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};},source);
const targetBox=await page.evaluate(()=>{const r=document.querySelector('[data-folder="manuscript"] .folder-label').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};});
await page.mouse.move(sourceBox.x,sourceBox.y);await page.mouse.down();await page.mouse.move(targetBox.x,targetBox.y,{steps:8});await page.mouse.up();
const destination='manuscript/protocol.qmd';await active(destination);
h.ok(!await exists(source) && await exists(destination),'drag to root actually moves the file');
const text=await read(destination);h.ok(text.includes('Saved before the move.'),'moving flushes a pending autosave');
h.ok(text.includes('![Plot](../plots/test.svg)'),'moved document image target is preserved');
h.ok(await exists('manuscript/protocol.comments.json'),'comments sidecar follows the open document');
await page.evaluate(()=>{const v=window.__fluxView;v.dispatch({changes:{from:v.state.doc.length,insert:'\nAFTER MOVE\n'}});});
await waitFor(page,async p=>(await window.fig.readText(p)).includes('AFTER MOVE'),`${ROOT}/${destination}`,{timeout:5000});
h.ok(!await exists(source),'subsequent autosave does not recreate the old file');
// Collapse active-document root explicitly; the active-path reveal must not reopen it.
await page.click('[data-folder="manuscript"] .folder-label');
h.ok(await page.$$eval('ul[aria-label="Documents"] .dp-item',a=>a.length)===0,'Documents is collapsible even while its document is active');
await page.click('[data-folder="manuscript"] .folder-label');
await page.click('[data-folder="Context"] .folder-label');
h.ok(await page.$$eval('ul[aria-label="Context"] .dp-item',a=>a.length)===0,'Context is independently collapsible');
await page.click('[data-folder="Context"] .folder-label');
await clickLabel('New folder in Context');await prompt('Reading');await folderPresent('Context/Reading');
await clickLabel('New document in Reading');await prompt('Ideas');await active('Context/Reading/ideas.qmd');
await clickLabel('Delete Ideas');
await waitFor(page,()=>!!document.querySelector('#doc-delete-confirm'),null,{timeout:5000});
await page.click('#doc-delete-confirm');
await waitFor(page,async p=>!await window.fig.exists(p),`${ROOT}/Context/Reading/ideas.qmd`,{timeout:5000});
h.ok(true,'custom Context documents can be created and deleted');
await shot(page,'paper-folders-sidebar');
// Reopen a fresh fixture configured like a new project before mounting Paper.
await gotoApp(page,{url:`${APP_URL}?fixture=demo`,settle:1000});
await waitFor(page,()=>!!window.__flux?.get(window.__flux.shell.projectModel),null,{timeout:10000});
await page.evaluate(()=>window.__flux.shell.goHome());
await waitFor(page,()=>!document.querySelector('.paper'),null,{timeout:5000});
await page.evaluate(async root=>{
  const pm=window.__flux.get(window.__flux.shell.projectModel);
  pm.manifest.documentRoot='paper';
  pm.manifest.manuscript={path:'paper/notes.qmd',config:'paper/_quarto.yml',format:'quarto'};
  pm.manifest.supplementary=[];
  await window.fig.writeText(`${root}/project.json`,JSON.stringify(pm.manifest));
  await window.fig.writeText(`${root}/paper/notes.qmd`,'---\ntitle: Notes\n---\n\n# Research notes\n');
  await window.fig.remove(`${root}/manuscript/main.qmd`);
  await window.fig.remove(`${root}/manuscript/supp.qmd`);
},ROOT);
await page.evaluate(root=>window.__flux.shell.openProjectAt(root),ROOT);
await clickMode(page,'Paper');await active('paper/notes.qmd');
h.ok(await page.$$eval('.dp-badge',els=>els.length)===0,'new projects have no main badge');
await clickLabel('Delete Notes');await page.waitForSelector('#doc-delete-confirm');await page.click('#doc-delete-confirm');
await waitFor(page,async root=>!await window.fig.exists(`${root}/paper/notes.qmd`),ROOT,{timeout:5000});
h.eq(JSON.parse(await read('project.json')).manuscript.path,'','deleting the last ordinary document clears the default in the GUI');
await clickLabel('New document in Documents');await prompt('Fresh notes');await active('paper/fresh-notes.qmd');
h.eq(JSON.parse(await read('project.json')).manuscript.path,'paper/fresh-notes.qmd','new-document action works after every ordinary document was deleted');
// Large tree: a real scan followed by collapse, expansion and scroll-to-end.
await page.evaluate(async root=>{
  for(let i=0;i<5000;i++) await window.fig.writeText(`${root}/paper/Bulk/note-${String(i).padStart(4,'0')}.qmd`,`---\ntitle: Note ${String(i).padStart(4,'0')}\n---\n`);
  window.__fluxEmitFsChange({subsystem:'manuscript',path:`${root}/paper/Bulk/note-4999.qmd`});
},ROOT);
await folderPresent('paper/Bulk');
h.ok(await page.$$eval('.dp-item',els=>els.length)<100,'5000-document tree mounts fewer than 100 document rows');
const timings=await page.evaluate(async()=>{
  const button=()=>document.querySelector('[data-folder="paper/Bulk"] .folder-label');
  const values=[];
  for(let i=0;i<8;i++){
    const start=performance.now();button().click();
    await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);
    values.push(performance.now()-start);
  }
  return values;
});
h.ok(Math.max(...timings)<100,`5000-document collapse/expand paints within 100ms (max ${Math.max(...timings).toFixed(1)}ms)`);
await page.evaluate(()=>{const el=document.querySelector('.dp-scroll');el.scrollTop=el.scrollHeight;});
await waitFor(page,()=>!!document.querySelector('.dp-item[title="paper/Bulk/note-4999.qmd"]'),null,{timeout:5000});
h.ok(await page.$$eval('.dp-item',els=>els.length)<100,'scrolling reaches the final document while keeping the tree windowed');
h.ok(realErrors(page).length===0,`clean browser console: ${realErrors(page).join(' | ')}`);
await h.done(()=>browser.close());

} finally { await browser.close(); }
