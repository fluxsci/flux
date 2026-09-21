import assert from 'node:assert/strict';
import { launch, gotoApp, APP_URL, waitFor, realErrors, shot } from './lib/driver.mjs';
const {browser,page}=await launch();
try {
  await page.evaluateOnNewDocument(()=>localStorage.setItem('flux.recents','"corrupt"'));
  await gotoApp(page,{url:APP_URL});
  await waitFor(page,()=>!!window.__flux,null,{timeout:15000,label:'live app handle'});
  const recents=await page.evaluate(()=>window.__flux.get(window.__flux.shell.recents)); assert.deepEqual(recents,[]);
  await gotoApp(page,{url:APP_URL+'?fixture=demo'});
  await waitFor(page,()=>!!window.__fluxView,null,{timeout:15000,label:'Paper editor'});
  const preserved=await page.evaluate(async()=>{
    const {shell,lifecycle,get}=window.__flux;
    const pm=get(shell.projectModel), text=window.__fluxView.state.doc.toString();
    let calls=0;
    const unreg=lifecycle.registerFlushable({id:'injected-save-failure',isDirty:()=>true,flush:async()=>{calls++;throw new Error('ENOSPC');}});
    const result=await shell.goHome();
    const out={result,calls,view:get(shell.view),same:pm===get(shell.projectModel),text:text===window.__fluxView.state.doc.toString()};
    unreg(); return out;
  });
  assert.deepEqual(preserved,{result:false,calls:1,view:'workspace',same:true,text:true});
  const unknown=await page.evaluate(async()=>{
    const {lifecycle,shell,get}=window.__flux;
    const unreg=lifecycle.registerFlushable({id:'unknown-state',isDirty:()=>{throw new Error('broken');},flush:async()=>{}});
    const dirty=lifecycle.anyDirty(); const result=await shell.goHome(); unreg(); return {dirty,result,view:get(shell.view)};
  });
  assert.deepEqual(unknown,{dirty:true,result:false,view:'workspace'});
  const pane=await page.evaluate(async()=>{
    const {panes,lifecycle,get}=window.__flux;
    panes.splitWith('paper'); const id=get(panes.focusedPaneId);
    const unreg=lifecycle.registerFlushable({id:'controlled-pane',paneId:id,isDirty:()=>true,flush:async()=>{}});
    const result=await panes.closePane(id); const retained=get(panes.panes).some(p=>p.id===id); unreg();
    return {result,retained};
  });
  assert.deepEqual(pane,{result:false,retained:true});
  const divider=await page.$('[role=separator][aria-label="Pane width"]'); await divider.focus(); await page.keyboard.press('ArrowRight');
  assert.equal(await divider.evaluate(el=>el.getAttribute('aria-valuenow')),'52');
  await page.keyboard.press('End'); assert.equal(await divider.evaluate(el=>el.getAttribute('aria-valuenow')),'80');
  const dispatch=await page.evaluate(async()=>{
    const {liveCommands,fig,get}=window.__flux; const before=JSON.stringify(get(fig.project));
    let message=''; try{await liveCommands.dispatchCommand({type:'add_text',text:'must refuse'});}catch(e){message=e.message;}
    return {message,unchanged:before===JSON.stringify(get(fig.project))};
  });
  assert.match(dispatch.message,/not-applied/);assert.equal(dispatch.unchanged,true);
  const feedback=await page.evaluate(async()=>{
    const {feedback,shell,get}=window.__flux; const original=get(shell.currentProject); const bridge=window.fig;
    const append=bridge.feedbackAppend; let release; const started=new Promise(r=>release=r); let resolveWrite; const held=new Promise(r=>resolveWrite=r); const paths=[];
    bridge.feedbackAppend=async(p,line)=>{paths.push(p);release();await held;return true;};
    const work=feedback.addFeedbackNote('Project A note'); await started;
    shell.currentProject.set({name:'B',path:'/different-project'});resolveWrite();await work;
    const state=get(feedback.feedbackState);bridge.feedbackAppend=append;shell.currentProject.set(original);
    return {paths,state,root:original.path};
  });
  assert.equal(feedback.paths.length,1);assert.ok(feedback.paths[0].startsWith(feedback.root+'/'));assert.equal(feedback.state?.notes.length ?? 0,0);
  const terminal=await page.evaluate(async()=>{
    const {terminal}=window.__flux; const old=window.fig.term;let release;const killed=[];
    window.fig.term={create:()=>new Promise(r=>release=r),kill:async id=>{killed.push(id);},write(){},resize(){},onData(){return()=>{};},onExit(){return()=>{};}};
    const start=terminal.restart(); await Promise.resolve(); await terminal.kill(); release({ok:true,id:'stale-pty',shell:'fixture',cwd:'/A',pid:7}); await start;
    window.fig.term=old;return killed;
  });
  assert.deepEqual(terminal,['stale-pty']);
  await shot(page,'shell-fortification');
  const transitions=await page.evaluate(async()=>{
    const {shell,get}=window.__flux, bridge=window.fig, original=get(shell.currentProject), read=bridge.readText;
    const destinations=['/transition-A','/transition-B'];
    for(const destination of destinations){
      for(const [p,b] of [...bridge._files])if(p.startsWith(original.path+'/'))bridge._files.set(destination+p.slice(original.path.length),b.slice());
      for(const p of [...bridge._dirs])if(p===original.path||p.startsWith(original.path+'/'))bridge._dirs.add(destination+p.slice(original.path.length));
    }
    let release, started;const gate=new Promise(r=>release=r),blocked=new Promise(r=>started=r);
    bridge.readText=async p=>{if(p==='/transition-A/project.json'){started();await gate;return '{corrupt superseded load';}return read(p);};
    const roots=[];const stop=shell.currentProject.subscribe(p=>roots.push(p?.path));
    const first=shell.openProjectAt(destinations[0]);await blocked;
    const last=shell.openProjectAt(destinations[1]);release();await Promise.all([first,last]);
    const winner=get(shell.currentProject)?.path, error=get(shell.projectError);
    bridge.readText=read;stop();await shell.openProjectAt(original.path);
    return {winner,error,roots};
  });
  assert.equal(transitions.winner,'/transition-B');assert.ok(!transitions.roots.includes('/transition-A'));assert.equal(transitions.error,null);
  await page.setViewport({width:800,height:600});await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'reduce'}]);
  const invoking=await page.$('button[aria-label="Settings"]');await invoking.focus();
  await page.keyboard.down('Control');await page.keyboard.down('Shift');await page.keyboard.press('KeyM');await page.keyboard.up('Shift');await page.keyboard.up('Control');
  await page.waitForSelector('[role="dialog"] textarea');
  await page.type('[role="dialog"] textarea','Keep this draft on failed append.');
  await page.evaluate(()=>{window.__appendOriginal=window.fig.feedbackAppend;window.fig.feedbackAppend=async()=>false;});
  await page.keyboard.press('Enter');await page.waitForSelector('[role="dialog"] [role="alert"]');
  assert.equal(await page.$eval('[role="dialog"] textarea',e=>e.value),'Keep this draft on failed append.');
  await shot(page,'shell-feedback-small-reduced-motion');
  await page.evaluate(()=>{window.fig.feedbackAppend=window.__appendOriginal;});
  await page.focus('[role="dialog"] textarea');await page.keyboard.press('Enter');
  await page.waitForFunction(()=>!document.querySelector('[role="dialog"] textarea'));
  assert.equal(await page.evaluate(()=>document.activeElement?.getAttribute('aria-label')),'Settings');
  const notes=await page.evaluate(()=>window.__flux.get(window.__flux.feedback.feedbackState)?.notes.filter(n=>n.text==='Keep this draft on failed append.').length);
  assert.equal(notes,1);
  assert.deepEqual(await realErrors(page),[]);
  // One controlled loader rejection tests the actual recovery view/cache.
  // Interception modifies only this disposable browser's module response.
  const recovery=await browser.newPage();const recoveryErrors=[];recovery.on('pageerror',e=>recoveryErrors.push(String(e)));
  await recovery.evaluateOnNewDocument(()=>{window.requestIdleCallback=()=>1;window.cancelIdleCallback=()=>{};});
  await recovery.setRequestInterception(true);
  recovery.on('request',async request=>{
    if(new URL(request.url()).pathname==='/src/shell/modeRegistry.ts') {
      const source=await(await fetch(request.url())).text();
      const marker='const cache =';assert.ok(source.includes(marker));
      const patched=source.replace(marker,`const normalLibraryLoader=loaders.library;let rejectLibraryOnce=true;loaders.library=()=>{if(rejectLibraryOnce){rejectLibraryOnce=false;return Promise.reject(new Error('controlled chunk load failure'));}return normalLibraryLoader();};\n${marker}`);
      await request.respond({status:200,contentType:'application/javascript',body:patched});
    } else await request.continue();
  });
  await recovery.goto(APP_URL+'?fixture=demo',{waitUntil:'domcontentloaded'});
  await recovery.waitForFunction(()=>!!window.__fluxView);
  const neighbor=await recovery.evaluate(()=>{const {get,panes,lifecycle}=window.__flux;const id=get(panes.focusedPaneId);window.__neighborEditor=window.__fluxView;window.__neighborText=window.__fluxView.state.doc.toString();window.__removeNeighbor=lifecycle.registerFlushable({id:'test-neighbor',paneId:id,isDirty:()=>true,flush:async()=>{}});panes.splitWith('library');return id;});
  await recovery.waitForSelector('.mode-load-error');
  assert.equal(await recovery.evaluate(()=>window.__neighborEditor.state.doc.toString()===window.__neighborText),true);
  await recovery.click('.mode-load-error button');
  await recovery.waitForSelector('.lib .ltitle');
  assert.equal(await recovery.evaluate(id=>window.__flux.get(window.__flux.panes.panes).some(p=>p.id===id&&p.mode==='paper')&&window.__neighborEditor.state.doc.toString()===window.__neighborText,neighbor),true);
  assert.deepEqual(recoveryErrors,[]);await recovery.close();
  console.log('shell preservation, unknown dirty state, independent pane flush, keyboard separator, absent live owner, feedback root, stale PTY regressions PASS');
} finally {await browser.close();}
