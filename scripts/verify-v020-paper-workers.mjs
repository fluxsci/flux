import { launch, gotoApp, clickMode, waitFor, APP_URL, realErrors } from './lib/driver.mjs';
import { harness } from './lib/harness.mjs';
const h=harness('verify-v020-paper-workers');
const {browser,page}=await launch();
try {
 await gotoApp(page,{url:`${APP_URL}/?fixture=demo`});await clickMode(page,'Paper');
 await waitFor(page,()=>!!window.__fluxView,null,{timeout:10000,label:'Paper editor'});
 const math=await page.evaluate(async()=>{
  const {renderManuscript}=await import('/src/shell/modes/paper/render/renderManuscript.ts');
  const start=performance.now();
  const src='Before.\n\n$$\\begin{subarray}\\cr$$\n\nMiddle.\n\n$$\\def\\f{\\f}\\f$$\n\nAfter $E=mc^2$.';
  const out=await renderManuscript(src,{paginated:true});
  const plain=await renderManuscript('Plain words.');
  window.__workerExport=out.full;
  return {elapsed:performance.now()-start,before:out.inner.includes('Before.'),after:out.inner.includes('After'),fallback:out.inner.includes('katex-error'),valid:new DOMParser().parseFromString(out.inner,'text/html').querySelectorAll('.katex').length>=1,plain:plain.inner.includes('Plain words.')};
 });
 h.ok(math.before&&math.after&&math.fallback&&math.valid&&math.plain,'bad and recursive equations retain neighboring prose, source diagnostics, valid math, and later exports');
 h.ok(math.elapsed<6000,`worker initialization and bounded malformed expressions complete (${math.elapsed.toFixed(1)}ms)`);
 const correction=await page.evaluate(async()=>{
  const {localCorrectionService:s}=await import('/src/shell/modes/paper/editing/localCorrectionService.ts');
  s.warm('worker-gate');await s.lint('The control sentence is ready.',undefined,'lintOnly');
  const text=Array.from({length:17},(_,i)=>`quasineurophosphorylation${String.fromCharCode(97+i)}`).join(' ');
  const start=performance.now();
  const backlog=s.lint(text,undefined,'lintOnly','backlog');
  const foreground=s.lint('The microscope is ready.',undefined,'repair','foreground');
  window.__workerBacklog=backlog;await foreground;
  const elapsed=performance.now()-start;s.cancelScope('backlog');
  return {elapsed};
 });
 h.ok(correction.elapsed<1000,`foreground completes behind 17 unfamiliar scientific backlog words within scheduling budget (${correction.elapsed.toFixed(1)}ms)`);
 const paint=await page.evaluate(async()=>{
  const v=window.__fluxView;v.focus();const start=performance.now();v.dispatch({changes:{from:v.state.doc.length,insert:'\nWorker input stays responsive.'},userEvent:'input'});
  await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return performance.now()-start;
 });
 h.ok(paint<=100,`Paper edit reaches a painted frame within100ms with workers warm (${paint.toFixed(1)}ms)`);
 const exported=await page.evaluate(()=>window.__workerExport);
 const artifact=await browser.newPage();let outbound=0;
 await artifact.setRequestInterception(true);artifact.on('request',r=>{if(/^https?:/.test(r.url()))outbound++;r.abort();});
 await artifact.setContent(exported.replace('</body>','<script>window.__untrustedRan=true</script><img src="https://example.invalid/tracker"></body>'),{waitUntil:'load'});
 await artifact.waitForFunction(()=>document.querySelector('#flux-pages')?.children.length>0,{timeout:5000});
 h.ok(await artifact.evaluate(()=>!window.__untrustedRan&&document.querySelector('#flux-pages').children.length>0),'hash policy permits bundled pagination and blocks an untrusted inline script');
 h.eq(outbound,0,'offline artifact makes no external resource requests');
 await artifact.close();
 h.ok(!realErrors(page).length,'worker failures stay contained without renderer errors');
} finally {await browser.close();}
await h.done();
