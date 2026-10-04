#!/usr/bin/env node
// Fresh installed-shaped application smoke. No dev globals, real home or owner app.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import net from 'node:net';
import {pathToFileURL} from 'node:url';
import puppeteer from 'puppeteer-core';
import {TestProcessScope} from './lib/testProcess.mjs';
import {isolatedEnv} from './lib/verifyRuntime.mjs';
import {recordBrowserRuntime} from './lib/runtimeEvidence.mjs';
import {assertPackagedApp} from './lib/releasePolicy.mjs';
import {validateDocumentation} from './build-docs.mjs';
import {verifyCorrectionRuntime} from './fetch-correction-runtime.mjs';
import {verifyVideoEncoder,videoEncoderContract} from './fetch-video-encoder.mjs';
const args=process.argv.slice(2),arg=name=>args[args.indexOf(name)+1];
const directory=path.resolve(arg('--directory')),platform=arg('--platform'),arch=arg('--arch');
assert.equal(platform,process.platform);assert.equal(arch,process.arch);
async function walk(dir){const out=[];for(const e of await fs.readdir(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())out.push(...await walk(p));else if(e.isFile())out.push(p)}return out;}
const files=await walk(directory),cli=files.find(f=>f.endsWith('app.asar.unpacked/dist/flux-cli.mjs'));
assert.ok(cli,'fresh packaged CLI required');
const resources=path.dirname(path.dirname(path.dirname(cli))),app=platform==='darwin'?path.dirname(resources):path.dirname(resources);
const executable=platform==='darwin'?path.join(app,'MacOS','Flux'):path.join(app,'flux'); // flux-cap-ok packaged product executable, not configuration
const dist=path.dirname(cli),encoder=path.join(resources,'video-encoder'),correction=path.join(resources,'corrections/runtime');
await assertPackagedApp({executable,cli,mcp:path.join(dist,'flux-mcp.mjs'),worker:path.join(dist,'flux-fulltext-worker.mjs'),assets:path.join(dist,'slide-export-assets.json'),resources:{encoder:path.join(encoder,'ffmpeg'),correction:path.join(correction,'llama-server')}});
await verifyCorrectionRuntime(correction,{platform,arch});await verifyVideoEncoder(encoder,{platform,arch,...await videoEncoderContract()});
const docs=path.join(resources,'docs'),docsInventory=JSON.parse(await fs.readFile(path.join(docs,'.flux-docs.json'),'utf8'));
assert.equal(docsInventory.version,1);assert.ok(docsInventory.pages.includes('index.html'));
assert.deepEqual(await validateDocumentation(docs,docsInventory.pages),docsInventory.files,'packaged offline help must retain every validated page and resource byte');
const scratch=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'Flux packaged smoke '))),evidence=path.join(directory,'smoke-evidence');await fs.mkdir(evidence,{recursive:true});
const scope=new TestProcessScope(),env=isolatedEnv(path.join(scratch,'configuration'));
const cwd=path.join(scratch,'unrelated directory');await fs.mkdir(cwd);
const capture=path.join(cwd,'browser downloads');await fs.mkdir(capture);
// Flux's machine config dir (electron/fluxPaths.cjs): ~/Library/Application Support on macOS, the XDG
// dir elsewhere. The XDG path alone left the Mac app without the capture dir (v0.2.0 smoke, 2026-10-04).
const preferences=path.join(platform==='darwin'?path.join(env.HOME,'Library','Application Support'):env.XDG_CONFIG_HOME,'flux/preferences.json');
await fs.mkdir(path.dirname(preferences),{recursive:true});
await fs.writeFile(preferences,JSON.stringify({...JSON.parse(await fs.readFile(preferences,'utf8').catch(()=>'{}')),captureDir:capture}));
let browser,docsBrowser,sampled=false;
/** macOS: a hung packaged app prints nothing; sample every Flux process (main and helpers) before the
 *  scope kills them, so a failure names the stuck native stack (v0.2.0, 2026-10-04). Once per run. */
async function sampleFlux(){if(platform!=='darwin'||sampled)return;sampled=true;const {execFileSync}=await import('node:child_process');
 const pids=(()=>{try{return execFileSync('pgrep',['-f',path.dirname(path.dirname(executable))],{encoding:'utf8'}).trim().split('\n').filter(Boolean)}catch{return []}})();
 for(const pid of pids){try{const out=path.join(os.tmpdir(),`flux-sample-${pid}.txt`);execFileSync('sample',[pid,'2','-file',out],{stdio:'ignore'});
  const lines=(await fs.readFile(out,'utf8')).split('\n'),hot=lines.filter(l=>/Keychain|SecItem|SecKeychain|OSCrypt|safe.?storage|kcsearch|SecurityAgent|semaphore|ConditionVariable|WaitableEvent|_pthread_cond_wait|mach_msg/i.test(l));
  console.error(`=== sample ${pid}\n`+lines.slice(0,45).join('\n')+`\n--- ${hot.length} wait/keychain frames ---\n`+hot.slice(0,70).join('\n'));}catch(e){console.error(`sample ${pid} failed: ${e.message}`)}}}
// puppeteer can reject outside an awaited call (a page it creates for an unresponsive target).
process.on('unhandledRejection',async error=>{console.error(error);await sampleFlux();process.exit(1);});
async function command(file,argv,extraEnv={},deadlineMs=60000){const child=scope.spawn(argv[0]??'',argv.slice(1),{command:file,nodeArgs:[],cwd,env:{...env,...extraEnv},deadlineMs});const status=await scope.waitExit(child);assert.equal(status.code,0,`${file}: ${child.stdout}\n${child.stderr}`);return child.stdout+child.stderr;}
try{
 assert.match(await command(executable,[cli,'help'],{ELECTRON_RUN_AS_NODE:'1'}),/compose-figure/);
 const version=JSON.parse(await command(executable,[cli,'version'],{ELECTRON_RUN_AS_NODE:'1'}));assert.equal(version.entry,'bundle');
 const project=path.join(cwd,'scientific project');await command(executable,[cli,'new',project,'--title','Packaged scientific smoke'],{ELECTRON_RUN_AS_NODE:'1'});
 // Only the installed entry/dependencies may supply this rasterizer. The cwd
 // is unrelated to the checkout, and no source-module import runs the render.
 const plot=path.join(project,'plots','packaged-red.svg'),figurePngPath=path.join(evidence,'packaged-figure.png');
 await fs.writeFile(plot,'<svg xmlns="http://www.w3.org/2000/svg" width="32" height="24"><rect width="32" height="24" fill="#ff0000"/></svg>');
 await command(executable,[cli,'compose-figure',plot,'--root',project,'--id','packaged-png','--no-label','--no-caption'],{ELECTRON_RUN_AS_NODE:'1',NODE_PATH:''});
 await command(executable,[cli,'render-figure',project,'packaged-png','--png','--out',figurePngPath],{ELECTRON_RUN_AS_NODE:'1',NODE_PATH:''});
 const figurePng=await fs.readFile(figurePngPath);
 assert.ok(figurePng.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])),'packaged CLI must produce a PNG');
 assert.ok(figurePng.readUInt32BE(16)>0&&figurePng.readUInt32BE(20)>0,'packaged PNG has nonzero dimensions');
 const mcp=scope.spawn(path.join(dist,'flux-mcp.mjs'),[project],{command:executable,nodeArgs:[],cwd,env:{...env,ELECTRON_RUN_AS_NODE:'1'},deadlineMs:60000});
 const response=new Promise((resolve,reject)=>{let buffer='',done=false;const timer=setTimeout(()=>reject(Error('Packaged MCP handshake timed out')),20000);mcp.child.stdout.on('data',chunk=>{buffer+=chunk;for(let at;(at=buffer.indexOf('\n'))>=0;){const line=buffer.slice(0,at);buffer=buffer.slice(at+1);let msg;try{msg=JSON.parse(line)}catch{continue}if(msg.id===1){assert.equal(msg.result?.serverInfo?.name,'flux');mcp.child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');mcp.child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/list',params:{}})+'\n');}if(msg.id===2){if(!msg.result?.tools?.some(t=>t.name==='list_project'))return reject(Error('Packaged MCP lacks project tool'));mcp.child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'list_project',arguments:{}}})+'\n');}if(msg.id===3&&!done){done=true;clearTimeout(timer);resolve(msg.result)}}});});
 mcp.child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'packaged-smoke',version:'1'}}})+'\n');assert.match(JSON.stringify(await response),/Packaged scientific smoke/);await scope.reap(mcp);
 await command(path.join(encoder,'ffmpeg'),['-v','error','-f','lavfi','-i','color=c=red:s=32x24:d=0.1','-frames:v','1',path.join(evidence,'encoder.png')]);
 const png=await fs.readFile(path.join(evidence,'encoder.png'));assert.equal(png.readUInt32BE(16),32);assert.equal(png.readUInt32BE(20),24);
 assert.match(await command(path.join(correction,'llama-server'),['--version']),/version|build|b10288/i);
 // Use the installed CLI and installed app entry dispatch, not a hand-copied
 // source helper, so missing unpacked worker dependencies cannot pass unnoticed.
 const manifest=JSON.parse(await fs.readFile(path.join(project,'project.json'),'utf8'));
 const deckFile=path.join(project,manifest.slides[0].path),deck=JSON.parse(await fs.readFile(deckFile,'utf8'));
 deck.stage={width:640,height:360};deck.assets=[];deck.slides=[{id:'packaged-frame',elements:[],background:'#ff00ff',beats:[{id:'base',tracks:[]}]}];
 const deckBytes=JSON.stringify(deck,null,2)+'\n';await fs.writeFile(deckFile,deckBytes);
 const videoEnv={ELECTRON_RUN_AS_NODE:'1'};
 if(platform==='linux'&&env.FLUX_ELECTRON_NO_SANDBOX==='1'){
  const shim=path.join(scratch,'packaged-electron');await fs.writeFile(shim,"#!/bin/sh\nexec '"+executable.replaceAll("'","'\\''")+"' --no-sandbox \"$@\"\n",{mode:0o700});videoEnv.FLUX_VIDEO_ELECTRON=shim;
 }
 const movie=path.join(evidence,'packaged-frame.mp4');
 const videoOutput=await command(executable,[cli,'export-slide-video',deck.id,'packaged-frame','--root',project,'--out',movie,'--start-hold','0','--end-hold','0','--height','720'],videoEnv,90000);
 assert.match(videoOutput,/"frames"\s*:\s*1/);assert.equal(await fs.readFile(deckFile,'utf8'),deckBytes);
 await command(path.join(encoder,'ffmpeg'),['-v','error','-i',movie,'-frames:v','1',path.join(evidence,'packaged-frame.png')]);
 const frame=await fs.readFile(path.join(evidence,'packaged-frame.png'));assert.equal(frame.readUInt32BE(16),1280);assert.equal(frame.readUInt32BE(20),720);
 const port=await new Promise((resolve,reject)=>{const s=net.createServer();s.once('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p))})});
 const launchArgs=[project,`--remote-debugging-port=${port}`,'--remote-debugging-address=127.0.0.1',`--user-data-dir=${path.join(scratch,'electron profile')}`];
 if(platform==='linux')launchArgs.push('--ozone-platform=x11','--disable-gpu');
 if(env.FLUX_ELECTRON_NO_SANDBOX==='1')launchArgs.push('--no-sandbox');
 const native=scope.spawn(launchArgs[0],launchArgs.slice(1),{command:executable,nodeArgs:[],cwd,env,deadlineMs:180000});
 // A cold first launch on a hosted Intel Mac is slow; 120 s bounds the wait, and a miss reports the
 // app's own output instead of a bare assertion (v0.2.0 Intel smoke, 2026-10-04).
 const end=Date.now()+120000;while(Date.now()<end){if(native.exited)throw Error(native.stderr);try{browser=await puppeteer.connect({defaultViewport:null,browserURL:`http://127.0.0.1:${port}`,protocolTimeout:60000});break}catch{await new Promise(r=>setTimeout(r,100))}}
 assert.ok(browser,`packaged application exposes its own test debugging endpoint (120 s). App stdout:\n${String(native.stdout??'').slice(-4000)}\nApp stderr:\n${String(native.stderr??'').slice(-4000)}`);
 // The debugging endpoint answers before the window exists (v0.2.0 Linux smoke, 2026-10-04): wait for
 // the app's own file: page rather than taking whatever pages() holds at connect time.
 const target=await browser.waitForTarget(t=>t.type()==='page'&&t.url().startsWith('file:'),{timeout:60000});
 // macOS v0.2.0 smoke: the window's renderer stopped answering CDP once a capture dir was set. Probe it
 // first; when it does not answer, pause it to print the JavaScript it is stuck in, then sample.
 {const probe=await target.createCDPSession(),within=(ms,work)=>Promise.race([work,new Promise(r=>setTimeout(()=>r('TIMEOUT'),ms))]);
  const answer=await within(20000,probe.send('Runtime.evaluate',{expression:'location.href+" "+document.readyState',returnByValue:true}).catch(e=>'ERR '+e.message));
  if(answer==='TIMEOUT'||typeof answer==='string'){console.error(`renderer did not answer Runtime.evaluate: ${answer}`);
   const paused=new Promise(r=>probe.once('Debugger.paused',r));await within(10000,probe.send('Debugger.enable').catch(()=>{}));await within(10000,probe.send('Debugger.pause').catch(()=>{}));
   const event=await within(15000,paused);console.error(event==='TIMEOUT'?'Debugger.pause got no answer (renderer blocked outside JavaScript)':'renderer JavaScript stack:\n'+event.callFrames.map(f=>`  ${f.functionName||'(anonymous)'} ${f.url}:${f.location.lineNumber+1}:${f.location.columnNumber+1}`).join('\n'));
   await sampleFlux();throw Error('packaged window renderer is unresponsive (see the stack and samples above)');}
  else{console.error(`renderer answers: ${answer.result?.value}`);
   // The Mac window then sat in readyState 'loading' with Network.enable hung until the app was killed
   // (2026-10-04). Wait for the document; if it never finishes, record what it is waiting on and sample
   // every Flux process while they are still alive.
   let state='loading';for(let i=0;i<60&&state==='loading';i++){await new Promise(r=>setTimeout(r,500));const v=await within(5000,probe.send('Runtime.evaluate',{expression:'document.readyState',returnByValue:true}).catch(()=>null));state=v&&v!=='TIMEOUT'?v.result?.value:state;}
   if(state==='loading'){const detail=await within(10000,probe.send('Runtime.evaluate',{returnByValue:true,expression:"JSON.stringify({scripts:[...document.querySelectorAll('script')].map(s=>(s.src||'inline')+(s.type?' '+s.type:'')+(s.async?' async':'')+(s.defer?' defer':'')),links:[...document.querySelectorAll('link')].map(l=>l.rel+' '+l.href),resources:performance.getEntriesByType('resource').map(e=>e.name+' end='+Math.round(e.responseEnd)),body:(document.body?.innerHTML||'').slice(0,300)})"}).catch(e=>'ERR '+e.message));
    console.error('document still loading after 30 s:',typeof detail==='string'?detail:detail.result?.value);await sampleFlux();throw Error('packaged window never finished loading (see resources and samples above)');}
   console.error(`document readyState: ${state}`);}
  await probe.detach().catch(()=>{});}
 const page=await target.page();
 assert.ok(page,'packaged application opens its window');
 const errors=[];page.on('pageerror',e=>errors.push(String(e)));
 await page.waitForFunction(()=>window.fig&&document.body.textContent.includes('Packaged scientific smoke'),{timeout:60000});
 // Recording is deliberately deferred beyond the project-open IPC. Observe
 // the eventual machine-local record without adding a wait to production open.
 const registryFile=path.join(platform==='darwin'?path.join(env.HOME,'Library','Application Support'):env.XDG_CONFIG_HOME,'flux','projects.json');
 let openedProject;
 const registryDeadline=Date.now()+10000;
 while(Date.now()<registryDeadline){
  try{openedProject=JSON.parse(await fs.readFile(registryFile,'utf8')).projects.find(p=>p.root===project&&p.title==='Packaged scientific smoke'&&p.lastOpened);if(openedProject)break}catch(error){if(error.code!=='ENOENT')throw error}
  await new Promise(resolve=>setTimeout(resolve,50)); // poll deferred history publication
 }
 assert.ok(openedProject,'native project-open path records the project title and timestamp');
 const runtimeEnvironment=await recordBrowserRuntime(page,{label:'installed-native-window',directory:evidence,appBuild:version});
 assert.ok(runtimeEnvironment.viewport.width>=940 && runtimeEnvironment.viewport.height>=620,'observe actual native minimum window without synthetic viewport override');
 const encoderPixels=await page.evaluate(async url=>{const image=new Image();image.src=url;await image.decode();const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;const context=canvas.getContext('2d');context.drawImage(image,0,0);return [...context.getImageData(16,12,1,1).data]},'data:image/png;base64,'+png.toString('base64'));
 const figurePixels=await page.evaluate(async url=>{const image=new Image();image.src=url;await image.decode();const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;const context=canvas.getContext('2d');context.drawImage(image,0,0);return [...context.getImageData(Math.floor(image.width/2),Math.floor(image.height/2),1,1).data]},'data:image/png;base64,'+figurePng.toString('base64'));
 assert.deepEqual(figurePixels,[255,0,0,255],'packaged figure PNG contains the fixture artwork');
 assert.ok(encoderPixels[0]>240&&encoderPixels[1]<15&&encoderPixels[2]<15&&encoderPixels[3]===255,`Encoder pixel mismatch ${encoderPixels}`);
 const videoPixels=await page.evaluate(async url=>{const image=new Image();image.src=url;await image.decode();const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;const context=canvas.getContext('2d');context.drawImage(image,0,0);return [...context.getImageData(640,360,1,1).data]},'data:image/png;base64,'+frame.toString('base64'));
 assert.ok(videoPixels[0]>240&&videoPixels[1]<15&&videoPixels[2]>240&&videoPixels[3]===255,`Packaged worker pixel mismatch ${videoPixels}`);
 const nativeResult=await page.evaluate(async root=>{
  const lock=await window.fig.lockAcquire('project','project',root);if(!lock.ok)throw Error('packaged native lease refused');
  const valid=await window.fig.lockCheck('project','project',lock.token);await window.fig.lockRelease('project','project',lock.token);
  const text=root+'/packaged-io.txt';await window.fig.writeText(text,'saved scientific bytes');if(await window.fig.readText(text)!=='saved scientific bytes')throw Error('saved bytes mismatch');
  const pdf=root+'/packaged-no-script.pdf';await window.fig.printPdf('<html><body><p>STATIC_SCIENTIFIC_OUTPUT</p><script>document.body.textContent="SCRIPT_EXECUTED"</script></body></html>',pdf,{baseDir:root});
  if ('term' in window.fig) throw Error('retired terminal bridge is exposed');
  return {valid,pdf};
 },project);
 assert.equal(nativeResult.valid,true);assert.equal(await fs.readFile(path.join(project,'packaged-io.txt'),'utf8'),'saved scientific bytes');
 const pdf=await fs.readFile(nativeResult.pdf);assert.ok(pdf.subarray(0,5).equals(Buffer.from('%PDF-')));await fs.copyFile(nativeResult.pdf,path.join(evidence,'no-script.pdf'));
 const {getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs');const loadingTask=getDocument({data:new Uint8Array(pdf),isEvalSupported:false,useSystemFonts:true});
 try{const document=await loadingTask.promise;const text=(await (await document.getPage(1)).getTextContent()).items.map(i=>i.str??'').join(' ');assert.match(text,/STATIC_SCIENTIFIC_OUTPUT/);assert.ok(!text.includes('SCRIPT_EXECUTED'));}finally{await loadingTask.destroy();}
 // The current capture contract is a browser-downloaded file, not the retired
 // flux:// scheme. Exercise the shipped filename producer and native intake.
 const {articleCaptureName}=await import('../electron/captureRules.js'),captureName=articleCaptureName('10.0000/packaged-qualification');
 await fs.writeFile(path.join(capture,'personal-decoy.pdf'),'untouched decoy');await fs.writeFile(path.join(capture,captureName),pdf);
 const captureResult=await page.evaluate(async()=>({extension:await window.fig.captureExtensionInfo(),intake:await window.fig.captureIntake(),fulltext:await window.fig.searchFulltext('packagedqualifier')}));
 assert.equal(captureResult.extension.hasDir,true);assert.ok(captureResult.extension.dir.startsWith(resources+path.sep));
 assert.ok(captureResult.intake.pdfs?.includes(captureName));assert.ok(!captureResult.fulltext?.error,JSON.stringify(captureResult.fulltext));
 assert.equal(await fs.readFile(path.join(capture,'personal-decoy.pdf'),'utf8'),'untouched decoy');
 assert.deepEqual(await fs.readFile(path.join(env.HOME,'FluxConfig/FluxLib/pdfs_to_assign',captureName)),pdf);
 await page.screenshot({path:path.join(evidence,'packaged-app.png')});assert.deepEqual(errors,[]);
 // Exercise the actual installed help as an OS file browser would, without
 // opening the owner's default browser or navigating a privileged app window.
 docsBrowser=await puppeteer.launch({executablePath:env.FLUX_CHROME||'/usr/bin/google-chrome',headless:true,userDataDir:path.join(scratch,'documentation browser'),env,args:['--no-sandbox','--disable-dev-shm-usage'],defaultViewport:{width:1440,height:960}});
 const help=await docsBrowser.newPage(),documentationErrors=[],documentationDialogs=[],blockedExternalResources=[];
 help.on('pageerror',error=>documentationErrors.push(String(error)));help.on('dialog',async dialog=>{documentationDialogs.push(dialog.message());await dialog.dismiss()});
 await help.setRequestInterception(true);help.on('request',request=>{if(/^https?:/.test(request.url())){blockedExternalResources.push(request.url());void request.abort()}else void request.continue()});
 await help.goto(pathToFileURL(path.join(docs,'index.html')).href,{waitUntil:'load'});await help.waitForSelector('.aa-Input');
 await help.screenshot({path:path.join(evidence,'packaged-docs-home.png'),fullPage:true});
 await Promise.all([help.waitForNavigation({waitUntil:'load'}),help.click('a[href="./modes/figure.html"]')]);
 assert.match(await help.$eval('h1',el=>el.textContent),/Figure/);
 await Promise.all([help.waitForNavigation({waitUntil:'load'}),help.click('.sidebar-title a')]);assert.match(help.url(),/\/index\.html$/);
 await help.type('.aa-Input','semantic');await help.waitForSelector('.aa-Item');
 const documentationResults=await help.$$eval('.aa-Item',items=>items.map(el=>({text:el.textContent,href:el.querySelector('a')?.href})));
 assert.ok(documentationResults.some(item=>/semantic/i.test(item.text)));assert.deepEqual(documentationErrors,[]);assert.deepEqual(documentationDialogs,[]);
 await help.screenshot({path:path.join(evidence,'packaged-docs-search.png'),fullPage:true});await docsBrowser.close();docsBrowser=null;
 await fs.writeFile(path.join(evidence,'smoke.json'),JSON.stringify({version,platform,arch,checks:['CLI outside repo','packaged CLI figure PNG signature and pixels','native project-open registry','MCP handshake','encoder pixels','packaged CLI video worker and decoded pixels','correction dynamic libraries','offline documentation inventory, file navigation and search','native application','lease','saved bytes','PDF scripts disabled','terminal bridge absent','installed capture intake and decoy preservation','resident fulltext worker'],documentation:{pages:docsInventory.pages.length,files:Object.keys(docsInventory.files).length,results:documentationResults,errors:documentationErrors,dialogs:documentationDialogs,blockedExternalResources:[...new Set(blockedExternalResources)]},nativeResult,openedProject,figurePixels,encoderPixels,videoPixels,captureResult},null,2));
 console.log(`Packaged application smoke PASS ${platform}-${arch}: ${evidence}`);
}catch(error){
 await sampleFlux();
 throw error;
}finally{await docsBrowser?.close();browser?.disconnect();await scope.dispose();await fs.rm(scratch,{recursive:true,force:true});await fs.rm(env.TMPDIR,{recursive:true,force:true});}
