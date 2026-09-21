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
const scratch=await fs.mkdtemp(path.join(os.tmpdir(),'Flux packaged smoke ')),evidence=path.join(directory,'smoke-evidence');await fs.mkdir(evidence,{recursive:true});
const scope=new TestProcessScope(),env=isolatedEnv(path.join(scratch,'configuration'));
const cwd=path.join(scratch,'unrelated directory');await fs.mkdir(cwd);
const capture=path.join(cwd,'browser downloads');await fs.mkdir(capture);
const preferences=path.join(env.XDG_CONFIG_HOME,'flux/preferences.json');
await fs.writeFile(preferences,JSON.stringify({...JSON.parse(await fs.readFile(preferences,'utf8')),captureDir:capture}));
let browser,docsBrowser;
async function command(file,argv,extraEnv={},deadlineMs=60000){const child=scope.spawn(argv[0]??'',argv.slice(1),{command:file,nodeArgs:[],cwd,env:{...env,...extraEnv},deadlineMs});const status=await scope.waitExit(child);assert.equal(status.code,0,`${file}: ${child.stdout}\n${child.stderr}`);return child.stdout+child.stderr;}
try{
 assert.match(await command(executable,[cli,'help'],{ELECTRON_RUN_AS_NODE:'1'}),/compose-figure/);
 const version=JSON.parse(await command(executable,[cli,'version'],{ELECTRON_RUN_AS_NODE:'1'}));assert.equal(version.entry,'bundle');
 const project=path.join(cwd,'scientific project');await command(executable,[cli,'new',project,'--title','Packaged scientific smoke'],{ELECTRON_RUN_AS_NODE:'1'});
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
 const end=Date.now()+60000;while(Date.now()<end){if(native.exited)throw Error(native.stderr);try{browser=await puppeteer.connect({defaultViewport:null,browserURL:`http://127.0.0.1:${port}`});break}catch{await new Promise(r=>setTimeout(r,100))}}
 assert.ok(browser,'packaged application exposes its own test debugging endpoint');
 const pages=await browser.pages(),page=pages.find(p=>p.url().startsWith('file:'))??pages[0];
 const errors=[];page.on('pageerror',e=>errors.push(String(e)));
 await page.waitForFunction(()=>window.fig&&document.body.textContent.includes('Packaged scientific smoke'),{timeout:60000});
 const runtimeEnvironment=await recordBrowserRuntime(page,{label:'installed-native-window',directory:evidence,appBuild:version});
 assert.ok(runtimeEnvironment.viewport.width>=940 && runtimeEnvironment.viewport.height>=620,'observe actual native minimum window without synthetic viewport override');
 const encoderPixels=await page.evaluate(async url=>{const image=new Image();image.src=url;await image.decode();const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;const context=canvas.getContext('2d');context.drawImage(image,0,0);return [...context.getImageData(16,12,1,1).data]},'data:image/png;base64,'+png.toString('base64'));
 assert.ok(encoderPixels[0]>240&&encoderPixels[1]<15&&encoderPixels[2]<15&&encoderPixels[3]===255,`Encoder pixel mismatch ${encoderPixels}`);
 const videoPixels=await page.evaluate(async url=>{const image=new Image();image.src=url;await image.decode();const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;const context=canvas.getContext('2d');context.drawImage(image,0,0);return [...context.getImageData(640,360,1,1).data]},'data:image/png;base64,'+frame.toString('base64'));
 assert.ok(videoPixels[0]>240&&videoPixels[1]<15&&videoPixels[2]>240&&videoPixels[3]===255,`Packaged worker pixel mismatch ${videoPixels}`);
 const nativeResult=await page.evaluate(async root=>{
  const lock=await window.fig.lockAcquire('project','project',root);if(!lock.ok)throw Error('packaged native lease refused');
  const valid=await window.fig.lockCheck('project','project',lock.token);await window.fig.lockRelease('project','project',lock.token);
  const text=root+'/packaged-io.txt';await window.fig.writeText(text,'saved scientific bytes');if(await window.fig.readText(text)!=='saved scientific bytes')throw Error('saved bytes mismatch');
  const pdf=root+'/packaged-no-script.pdf';await window.fig.printPdf('<html><body><p>STATIC_SCIENTIFIC_OUTPUT</p><script>document.body.textContent="SCRIPT_EXECUTED"</script></body></html>',pdf,{baseDir:root});
  let output='';const stop=window.fig.term.onData(e=>{output+=e.data});const pty=await window.fig.term.create({cwd:root,command:'/bin/sh',args:['-c','printf PACKAGED_PTY_OK']});if(!pty.ok)throw Error(pty.error);
  const until=Date.now()+5000;while(!output.includes('PACKAGED_PTY_OK')&&Date.now()<until)await new Promise(r=>setTimeout(r,20));await window.fig.term.kill(pty.id);stop();if(!output.includes('PACKAGED_PTY_OK'))throw Error('packaged terminal did not execute');
  return {valid,pdf,output};
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
 await fs.writeFile(path.join(evidence,'smoke.json'),JSON.stringify({version,platform,arch,checks:['CLI outside repo','MCP handshake','encoder pixels','packaged CLI video worker and decoded pixels','correction dynamic libraries','offline documentation inventory, file navigation and search','native application','lease','saved bytes','PDF scripts disabled','terminal native module','installed capture intake and decoy preservation','resident fulltext worker'],documentation:{pages:docsInventory.pages.length,files:Object.keys(docsInventory.files).length,results:documentationResults,errors:documentationErrors,dialogs:documentationDialogs,blockedExternalResources:[...new Set(blockedExternalResources)]},nativeResult,encoderPixels,videoPixels,captureResult},null,2));
 console.log(`Packaged application smoke PASS ${platform}-${arch}: ${evidence}`);
}finally{await docsBrowser?.close();browser?.disconnect();await scope.dispose();await fs.rm(scratch,{recursive:true,force:true});await fs.rm(env.TMPDIR,{recursive:true,force:true});}
