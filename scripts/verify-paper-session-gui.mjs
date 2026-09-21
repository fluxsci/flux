import { launch, gotoApp, clickMode, waitFor, APP_URL, realErrors } from './lib/driver.mjs';
import { harness } from './lib/harness.mjs';
const h = harness('verify-paper-session-gui');
const { browser, page } = await launch();
try {
  await gotoApp(page, { url: `${APP_URL}/?fixture=demo` });
  await clickMode(page, 'Paper');
  await waitFor(page, () => window.__fluxView && document.querySelectorAll('.docpicker .dp-item').length >= 2, null, {timeout:10000,label:'Paper documents'});
  const fixture = await page.evaluate(async () => {
    const rows=[...document.querySelectorAll('.docpicker .dp-item')].filter(n=>!n.title.startsWith('Context/'));
    const a=rows.find(n=>n.classList.contains('active'))?.title ?? rows[0].title;
    const b=rows.find(n=>n.title!==a).title;
    const root='/demo/myc-growth-paper';
    return { root,a,b,bText:await window.fig.readText(`${root}/${b}`) };
  });
  await page.evaluate(() => { const v=window.__fluxView;v.dispatch({changes:{from:v.state.doc.length,insert:'\nSESSION_A_DISTINCT\n'},userEvent:'input'});v.focus(); });
  await page.evaluate(path => [...document.querySelectorAll('.docpicker .dp-item')].find(n=>n.title===path).click(),fixture.b);
  await waitFor(page, path=>document.querySelector('.docpicker .dp-item.active')?.title===path && window.__fluxView?.state.doc.toString().indexOf('SESSION_A_DISTINCT')<0,fixture.b,{timeout:10000,label:'document B owns fresh editor'});
  await page.keyboard.down(process.platform==='darwin'?'Meta':'Control');
  await page.keyboard.press('z');
  await page.keyboard.up(process.platform==='darwin'?'Meta':'Control');
  const afterUndo=await page.evaluate(()=>window.__fluxView.state.doc.toString());
  h.eq(afterUndo,fixture.bText,'Undo after picker switch cannot restore document A into B');
  await page.evaluate(()=>{const v=window.__fluxView;v.dispatch({changes:{from:v.state.doc.length,insert:'\nSESSION_B_DISTINCT\n'},userEvent:'input'});});
  await waitFor(page,async ({root,b})=>(await window.fig.readText(`${root}/${b}`)).includes('SESSION_B_DISTINCT'),fixture,{timeout:8000,label:'B saved bytes'});
  const saved=await page.evaluate(async ({root,a,b})=>({a:await window.fig.readText(`${root}/${a}`),b:await window.fig.readText(`${root}/${b}`)}),fixture);
  h.ok(saved.a.includes('SESSION_A_DISTINCT')&&!saved.a.includes('SESSION_B_DISTINCT'),'A persisted its own edits only');
  h.ok(saved.b.includes('SESSION_B_DISTINCT')&&!saved.b.includes('SESSION_A_DISTINCT'),'B persisted its own edits only');
  await page.evaluate(path=>[...document.querySelectorAll('.docpicker .dp-item')].find(n=>n.title===path).click(),fixture.a);
  await waitFor(page,()=>window.__fluxView.state.doc.toString().includes('SESSION_A_DISTINCT'),null,{timeout:8000,label:'A reopened'});
  await page.keyboard.down(process.platform==='darwin'?'Meta':'Control');
  await page.keyboard.press('z');
  await page.keyboard.up(process.platform==='darwin'?'Meta':'Control');
  h.ok(!(await page.evaluate(()=>window.__fluxView.state.doc.toString())).includes('SESSION_B_DISTINCT'),'reopening A starts its own history boundary');
  // A slow read may finish after a newer navigation intent, but cannot publish.
  await page.evaluate(({b})=>{const read=window.fig.readText.bind(window.fig);window.__restoreSessionRead=()=>window.fig.readText=read;window.fig.readText=async path=>{if(path.endsWith('/'+b))await new Promise(r=>setTimeout(r,300));return read(path);};},fixture);
  await page.evaluate(({a,b})=>{const row=p=>[...document.querySelectorAll('.docpicker .dp-item')].find(n=>n.title===p);row(b).click();row(a).click();},fixture);
  await page.evaluate(async()=>{await new Promise(r=>setTimeout(r,450));window.__restoreSessionRead();}); // controlled delayed-read fault completes
  h.eq(await page.evaluate(()=>document.querySelector('.docpicker .dp-item.active')?.title),fixture.a,'newer switch intent wins over delayed read');
  // A held shared manuscript writer must cover read/check/write. Advance a
  // cold coauthor while queued, then require conflict rather than stale overwrite.
  await page.evaluate(({root,a})=>{
    const fb=window.fig, read=fb.readText.bind(fb), write=fb.writeText.bind(fb), acquire=fb.lockAcquire;
    window.__paperLeaseReads=0;window.__paperLeaseHeld=false;
    fb.readText=async p=>{if(p===`${root}/${a}`)window.__paperLeaseReads++;return read(p)};
    fb.lockAcquire=async(scope,name,expected)=>{if(scope==='project'&&name==='manuscript'){window.__paperLeaseRoot=expected;window.__paperLeaseHeld=true;return new Promise(r=>window.__paperLeaseRelease=()=>r({ok:true,noop:true}));}return acquire?acquire(scope,name,expected):{ok:true,noop:true};};
    window.__paperLeaseRestore=()=>{fb.readText=read;fb.lockAcquire=acquire};
    window.__paperColdWrite=()=>write(`${root}/${a}`,'COLD_WRITER_SCIENTIFIC_17.25\n');
    window.__paperReadExact=()=>read(`${root}/${a}`);
    const v=window.__fluxView;v.dispatch({changes:{from:v.state.doc.length,insert:'\nLEASE_QUEUED_EDIT\n'},userEvent:'input'});
  },fixture);
  await waitFor(page,()=>window.__paperLeaseHeld,null,{label:'actual autosave waits manuscript lease'});
  h.eq(await page.evaluate(()=>window.__paperLeaseReads),0,'autosave does not read a baseline before acquiring shared manuscript lease');
  h.eq(await page.evaluate(()=>window.__paperLeaseRoot),fixture.root,'autosave lease captures the expected project root');
  await page.evaluate(async()=>{await window.__paperColdWrite();const v=window.__fluxView;v.dispatch({changes:{from:v.state.doc.length,insert:'TYPED_WHILE_LEASE_QUEUED\n'},userEvent:'input'});window.__paperLeaseRelease();});
  await waitFor(page,()=>[...document.querySelectorAll('button')].some(n=>n.textContent==='Overwrite with mine'),null,{label:'cold coauthor conflict visible'});
  h.eq(await page.evaluate(()=>window.__paperReadExact()),'COLD_WRITER_SCIENTIFIC_17.25\n','cold writer bytes survive the queued Paper read/check/write');
  h.ok((await page.evaluate(()=>window.__fluxView.state.doc.toString())).includes('TYPED_WHILE_LEASE_QUEUED'),'typing stays live while manuscript writer is queued');
  await page.evaluate(()=>{window.__paperLeaseRestore();[...document.querySelectorAll('button')].find(n=>n.textContent==='Overwrite with mine').click();});
  await waitFor(page,async()=> (await window.__paperReadExact()).includes('TYPED_WHILE_LEASE_QUEUED'),null,{label:'explicit Keep mine publishes current editor bytes'});
  h.ok(!(await page.evaluate(()=>window.__paperReadExact())).includes('COLD_WRITER_SCIENTIFIC'),'only explicit Keep mine replaces external bytes');

  // Freeze A while an actual include read is pending, then navigate to B.
  await page.evaluate(()=>{ const v=window.__fluxView; v.dispatch({changes:{from:0,to:v.state.doc.length,insert:'# SESSION_A_EXPORT\n\n{{< include v020-export-include.qmd >}}\n'},userEvent:'input'}); const read=window.fig.readText.bind(window.fig);window.__restoreExportRead=()=>window.fig.readText=read;window.fig.readText=async p=>{if(p.endsWith('/v020-export-include.qmd')){window.__exportAwaiting=true;return new Promise(resolve=>window.__releaseExport=()=>resolve('INCLUDED_A_ONLY'));}return read(p);};});
  await page.evaluate(()=>[...document.querySelectorAll('.statusbar .seg')].find(n=>/export/i.test(n.textContent)).click());
  await waitFor(page,()=>!!document.querySelector('.export-dialog'),null,{label:'export dialog'});
  await page.evaluate(()=>[...document.querySelectorAll('.export-dialog .seg')].find(n=>/html/i.test(n.textContent)).click());
  await waitFor(page,()=>document.querySelector('.export-dialog .path-text')?.textContent.trim().endsWith('.html'),null,{label:'HTML destination'});
  const outPath=await page.evaluate(()=>document.querySelector('.export-dialog .path-text').textContent.trim());
  await page.evaluate(()=>[...document.querySelectorAll('.export-dialog button')].find(n=>/^export$/i.test(n.textContent.trim())).click());
  await waitFor(page,()=>window.__exportAwaiting===true,null,{timeout:10000,label:'pending include read'});
  await page.evaluate(path=>[...document.querySelectorAll('.docpicker .dp-item')].find(n=>n.title===path).click(),fixture.b);
  await waitFor(page,path=>document.querySelector('.docpicker .dp-item.active')?.title===path,fixture.b,{timeout:10000,label:'B selected during A export'});
  await page.evaluate(()=>{window.__releaseExport();window.__restoreExportRead();});
  await waitFor(page,async p=>await window.fig.exists(p),outPath,{timeout:10000,label:'saved A export artifact'});
  const exported=await page.evaluate(p=>window.fig.readText(p),outPath);
  h.ok(exported.includes('SESSION_A_EXPORT')&&exported.includes('INCLUDED_A_ONLY')&&!exported.includes('SESSION_B_DISTINCT'),'switching to B during include I/O preserves A identity in saved HTML artifact');
  h.ok(!realErrors(page).length,'no renderer errors during switches');
} finally { await browser.close(); }
await h.done();
