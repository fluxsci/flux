// NR10: independently constructed native owners, injected I/O/process/windows;
// exact registration shape and lifecycle state without booting Electron.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{EventEmitter}=require('node:events');
const {createCaptureFamily}=require('../electron/ipc/capture.cjs');
const {createGlobalLibraryWatcher}=require('../electron/globalLibraryWatcher.cjs');
const {createReadJobs}=require('../electron/ipc/readJobs.cjs');
const {createStaticPrint}=require('../electron/ipc/staticPrint.cjs');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'flux-native-families-'));let checks=0;
const ok=(condition,label)=>{assert(condition,label);checks++;console.log('✓ '+label);};
const handlers=owner=>{const map=new Map();owner.registerHandlers({handle:(name,fn)=>{assert(!map.has(name));map.set(name,fn);}});return map;};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
(async()=>{try{
 const A=path.join(root,'A'),B=path.join(root,'B');fs.mkdirSync(A);fs.mkdirSync(B);
 let selected=A,resolveIntake,calls=0;const revealed=[];
 const capture=createCaptureFamily({app:{getPath:()=>B},shell:{showItemInFolder:p=>revealed.push(p),openPath:async()=>''},readPrefs:()=>({captureDir:selected}),fluxLibDir:()=>A,appRoot:root,resourcesPath:()=>root,createIntake:()=>({count:async()=>7,intake:()=>{calls++;return new Promise(r=>resolveIntake=r);},discard:async()=>({ok:true}),park:async()=>({ok:true}),release:()=>{}})});
 const c=handlers(capture);ok(c.size===9,'capture registers exactly its9 existing public channels');
 ok(c.get('capture:dir')()===A,'capture resolves its current configured directory');selected=B;ok(c.get('capture:dir')()===B,'capture does not retain an obsolete config root');
 const first=c.get('capture:intake')();await Promise.resolve();assert.deepEqual(await c.get('capture:intake')(),{pdfs:[],sidecars:[],supplements:[]});ok(calls===1,'two intake callers have one active consumer');
 let stopped=false;const closing=capture.dispose().then(()=>stopped=true);await Promise.resolve();ok(!stopped,'capture disposal waits for already owned intake');resolveIntake({pdfs:['complete.pdf'],sidecars:[],supplements:[]});await first;await closing;
 assert.throws(()=>c.get('capture:count')(),/disposed/);ok(true,'disposed capture cannot start another job');
 assert.throws(()=>handlers(capture),/already registered/);ok(true,'capture handler installation cannot duplicate lifecycle ownership');
 const watches=[],events=[];let liveRoot=A,origin=1,failWatch=true;
 const makeWatch=()=>{if(failWatch){failWatch=false;throw Error('fixture watch setup');}const watcher=new EventEmitter();watcher.closed=0;watcher.close=async()=>{watcher.closed++;};watches.push(watcher);return watcher;};
 const watcher=createGlobalLibraryWatcher({loadChokidar:async()=>({watch:(targets)=>{const w=makeWatch();w.targets=targets;return w;}}),fluxLibDir:()=>liveRoot,captureDir:()=>null,readPrefs:()=>({}),liveWindows:()=>[1,2].map(id=>({webContents:{id,send:(channel,data)=>events.push({id,channel,data})}})),writeOrigin:()=>origin,notifyRenderer:()=>{},TMP_WRITE_RE:/\.tmp-/});
 await assert.rejects(()=>watcher.rebuild(),/fixture/);await watcher.rebuild();ok(watches.length===1,'watcher rebuild recovers after setup rejection');
 watches[0].emit('all','change',path.join(A,'.fluxlib','organize.json'));await sleep(230);ok(events.length===1&&events[0].id===2,'global change suppresses only its exact origin');
 events.length=0;origin=undefined;watches[0].emit('all','change',path.join(A,'library.bib'));await watcher.close();await sleep(230);ok(events.length===0&&watches[0].closed===1,'closing watcher cancels queued old-root notifications');
 liveRoot=B;await watcher.rebuild();ok(watches[1].targets[0]===path.join(B,'library.bib'),'rebuilt watcher reads latest library root');await watcher.dispose();await watcher.rebuild();ok(watches.length===2&&watches[1].closed===1,'disposed watcher cannot revive or duplicate registrations');
 let readRoot=A;const services=[];const read=createReadJobs({app:{isPackaged:false},appRoot:root,fluxLibDir:()=>readRoot,createService:({root})=>{const service={root,closed:0,cancelled:[],search:async(owner,query)=>({root,owner,query}),cancelOwner:owner=>service.cancelled.push(owner),dispose:()=>service.closed++};services.push(service);return service;}});const r=handlers(read),sender=new EventEmitter();sender.id=8;
 await r.get('fulltext:search')({sender},{query:'alpha'});await r.get('fulltext:search')({sender},{query:'beta'});ok(services.length===1&&sender.listenerCount('destroyed')===0,'read broker reuses worker and removes completed request listener');
 await r.get('fulltext:search')({sender},{query:''});ok(services[0].cancelled[0]==='8:default','clearing query cancels only the requesting sender and default pane owner');readRoot=B;await r.get('fulltext:search')({sender},{query:'gamma'});ok(services.length===2&&services[0].closed===1,'root change disposes old worker before new-root work');read.dispose();await assert.rejects(()=>r.get('fulltext:search')({sender},{query:'late'}),/disposed/);ok(services[1].closed===1,'disposed read broker does not recreate a process');
 const windows=[],sessions=[],printed=[];
 const session={fromPartition:partition=>{const s=new EventEmitter();s.partition=partition;s.setPermissionRequestHandler=fn=>s.permission=fn;s.webRequest={onBeforeRequest:(_filter,fn)=>s.request=fn,onErrorOccurred:(_filter,fn)=>s.assetError=fn};sessions.push(s);return s;}};
 class Window{constructor(options){this.options=options;this.dead=false;this.webContents=new EventEmitter();this.webContents.setWindowOpenHandler=fn=>this.popup=fn;this.webContents.printToPDF=async()=>{printed.push(this.html);return Buffer.from('%PDF-fixture\n'+this.html);};windows.push(this);}isDestroyed(){return this.dead;}destroy(){this.dead=true;}async loadFile(p){this.html=fs.readFileSync(p,'utf8');}async loadURL(url){this.url=url;}}
 const opts={BrowserWindow:Window,session,underDir:(p,r)=>p===r||p.startsWith(r+path.sep),atomicWriteMain:async(p,data)=>fs.promises.writeFile(p,data),fsGuard:()=>{},rootFor:()=>A,appRoot:root};
 const print=createStaticPrint(opts);const ph=handlers(print);
 await Promise.all([ph.get('export:pdf')({sender},{svg:'<svg><text>A</text></svg>',outPath:path.join(A,'A.pdf'),w:96,h:96}),ph.get('print:pdf')({sender},{html:'<html><head></head><body>B</body></html>',outPath:path.join(A,'B.pdf')})]);
 ok(windows.length===1&&printed[0].includes('<text>A</text>')&&printed[1].includes('<body>B</body>'),'print jobs serialize through one reusable window with exact owned content');
 ok(windows[0].url==='about:blank'&&fs.readFileSync(path.join(A,'A.pdf'),'utf8').startsWith('%PDF-fixture'),'print publishes owned output bytes and blanks after use');
 const security=windows[0].options.webPreferences;ok(security.javascript===false&&security.sandbox===true&&security.nodeIntegration===false&&!('preload'in security),'static print keeps its explicit isolated no-script configuration');
 let denied;sessions[0].request({url:'https://example.invalid/exfiltrate'},result=>denied=result.cancel);ok(denied,'static print session refuses arbitrary network egress');
 windows[0].destroy();await print.printHtmlToPdf('<b>recreated</b>',path.join(A,'C.pdf'),{},'test',A);ok(windows.length===2&&sessions.length===1&&sessions[0].listenerCount('will-download')===1,'window recreation reuses one owned session without duplicate policy listeners');
 const other=createStaticPrint(opts);await other.printHtmlToPdf('<b>independent</b>',path.join(B,'D.pdf'),{},'test',B);ok(sessions.length===2&&sessions[0].partition!==sessions[1].partition,'independent print owners never share a session policy');
 print.dispose();await assert.rejects(()=>print.printHtmlToPdf('late',path.join(A,'late.pdf'),{},'test',A),/disposed/);ok(!fs.existsSync(path.join(A,'late.pdf')),'disposed print owner refuses late output publication');other.dispose();
 let firstSpawn=true,failedTemp;class FailOnceWindow extends Window{constructor(options){if(firstSpawn){firstSpawn=false;throw Error('fixture window spawn');}super(options);}}
 const retryPrint=createStaticPrint({...opts,BrowserWindow:FailOnceWindow}),originalMkdtemp=fs.promises.mkdtemp;
 fs.promises.mkdtemp=async(...args)=>{failedTemp=await originalMkdtemp(...args);return failedTemp;};
 try{await assert.rejects(()=>retryPrint.printHtmlToPdf('fail',path.join(A,'failed.pdf'),{},'test',A),/fixture window spawn/);}finally{fs.promises.mkdtemp=originalMkdtemp;}
 ok(!fs.existsSync(failedTemp)&&!fs.existsSync(path.join(A,'failed.pdf')),'print setup failure removes exact owned temporary directory and publishes nothing');
 await retryPrint.printHtmlToPdf('retry',path.join(A,'retry.pdf'),{},'test',A);ok(fs.readFileSync(path.join(A,'retry.pdf'),'utf8').includes('retry'),'print queue recovers after window setup failure');retryPrint.dispose();
 class HungWindow extends Window{async loadFile(){await new Promise(()=>{});}}
 const timedPrint=createStaticPrint({...opts,BrowserWindow:HungWindow,timeoutMs:30}),priorPath=path.join(A,'prior.pdf');fs.writeFileSync(priorPath,'exact previous PDF bytes');
 await assert.rejects(()=>timedPrint.printHtmlToPdf('hang',priorPath,{},'test',A),/timed out/);ok(fs.readFileSync(priorPath,'utf8')==='exact previous PDF bytes'&&windows.at(-1).isDestroyed(),'bounded asset readiness destroys hung worker and preserves exact previous output');timedPrint.dispose();
 class MissingAssetWindow extends Window{async loadFile(p){await super.loadFile(p);this.options.webPreferences.session.assetError({url:'file:///missing-asset.png'});}}
 const missingPrint=createStaticPrint({...opts,BrowserWindow:MissingAssetWindow});await assert.rejects(()=>missingPrint.printHtmlToPdf('missing image',priorPath,{},'test',A),/could not load/);ok(fs.readFileSync(priorPath,'utf8')==='exact previous PDF bytes','missing asset is actionable failure and cannot publish an incomplete PDF');missingPrint.dispose();
 let finishRules;const asyncWatch=createGlobalLibraryWatcher({loadChokidar:async()=>({watch:()=>{throw Error('disposed watcher revived');}}),fluxLibDir:()=>A,captureDir:()=>B,readPrefs:()=>({}),liveWindows:()=>[],writeOrigin:()=>undefined,notifyRenderer:()=>{},TMP_WRITE_RE:/\.tmp-/,loadCaptureRules:()=>new Promise(resolve=>finishRules=resolve)});
 const rebuilding=asyncWatch.rebuild();await waitFor(()=>finishRules);const disposal=asyncWatch.dispose();finishRules({});await rebuilding;await disposal;ok(true,'disposal during asynchronous watcher setup cannot revive a native watcher');
 console.log(`NATIVE FAMILIES: PASS (${checks} checks)`);
}finally{fs.rmSync(root,{recursive:true,force:true});}})().catch(error=>{console.error(error);process.exitCode=1;});
async function waitFor(fn){for(let i=0;i<20;i++){if(fn())return;await Promise.resolve();}throw Error('fixture setup did not reach awaited boundary');}
