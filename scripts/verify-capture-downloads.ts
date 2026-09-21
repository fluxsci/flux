// Execute the real background worker against a hermetic browser/download clock.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { transformSync } from 'esbuild';
import * as rules from '../electron/captureRules.js';
import { SUPPLEMENT_URL_PATTERNS } from '../electron/supplementRules.js';
import { unzip, ZIP_LIMITS } from '../src/lib/references/unzip';
import { fetchEuropePmcSupplements } from '../src/lib/references/supplementFinder';
import { zipSync, strToU8 } from 'fflate';
import { harness } from './lib/harness.mjs';
const h=harness('verify-capture-downloads');
const source=transformSync(fs.readFileSync('extension/background.js','utf8').replace(/^import .*;\n/gm,''),{target:'es2022'}).code;
const flush=async()=>{for(let i=0;i<150;i++)await Promise.resolve();};
function worker(options:{early?:boolean;bytes?:number[];pending?:boolean;initial?:any[];deferredPage?:Promise<any>;missingOwner?:boolean;startupFailures?:number;page?:any}={}) {
  let now=0,seq=0,click:any,change:any;const timers=new Map<number,{at:number,fn:()=>void,interval:number}>();
  const jobs=new Map<number,any>((options.initial??[]).map(j=>[j.id,{...j}]));const downloads:any[]=[],cancelled:number[]=[],titles:string[]=[],badges:any[]=[];
  const schedule=(fn:()=>void,delay=0,interval=0)=>{const id=++seq;timers.set(id,{at:now+delay,fn,interval});return id;};
  let nextId=100,startupFailures=options.startupFailures??0;
  const api={runtime:{id:'flux-test'},action:{onClicked:{addListener:(fn:any)=>click=fn},setBadgeText:(x:any)=>badges.push(x.text),setBadgeBackgroundColor:()=>{},setTitle:(x:any)=>titles.push(x.title)},scripting:{executeScript:async()=>[{result: options.deferredPage?await options.deferredPage:options.page??{isPdf:true,pdfUrl:'https://publisher.test/article.pdf',slugHint:'test',pageUrl:'https://publisher.test/a',supplements:(options.bytes??[]).slice(1).map((_,i)=>({url:`https://publisher.test/supp${i}.pdf`}))}}]},downloads:{
    onChanged:{addListener:(fn:any)=>change=fn},
    search:async(q:any)=>{if(!q.id&&startupFailures-->0)throw Error("Transient browser startup failure");return q.id?[jobs.get(q.id)].filter(Boolean):[...jobs.values()].filter(j=>j.state===q.state);},
    cancel:async(id:number)=>{cancelled.push(id);const j=jobs.get(id);if(j)j.state='interrupted';},
    download:async(opts:any)=>{const id=++nextId,bytes=options.bytes?.[downloads.length]??4096;const job={id,filename:opts.filename,byExtensionId:'flux-test',state:options.pending?'in_progress':'complete',bytesReceived:bytes,totalBytes:options.pending?-1:bytes,fileSize:options.pending?-1:bytes};jobs.set(id,job);downloads.push(opts);if(options.early)change({id,state:{current:job.state}});return id;}
  }};
  const context=vm.createContext({...rules,SUPPLEMENT_URL_PATTERNS,readPaperPage:()=>{},chrome:api,AbortController,AbortSignal,URL,TextDecoder,Map,Promise,console:{warn(){},info(){}},btoa:(s:string)=>Buffer.from(s,'binary').toString('base64'),unescape,encodeURIComponent,setTimeout:(fn:any,ms:number)=>schedule(fn,ms),clearTimeout:(id:number)=>timers.delete(id),setInterval:(fn:any,ms:number)=>schedule(fn,ms,ms),clearInterval:(id:number)=>timers.delete(id),fetch:()=>{throw Error('Unexpected network');}});
  vm.runInContext(source,context);
  return {jobs,downloads,cancelled,titles,badges,click:()=>click({id:1,url:'https://publisher.test/article.pdf'}),change:(d:any)=>change(d),async advance(ms:number){const end=now+ms;for(;;){const next=[...timers].filter(([,v])=>v.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!next)break;now=next[1].at;if(next[1].interval)next[1].at+=next[1].interval;else timers.delete(next[0]);next[1].fn();await flush();}now=end;await flush();}};
}
{
 const w=worker({early:true,bytes:[10,20,30]});await flush();w.click();await flush();
 h.ok(w.titles.at(-1)?.includes('Captured 3 files'),'actual worker observes early completion and counts main PDF before both supplements');
 h.ok(w.downloads[0].filename.includes('flux-test.pdf')&&w.downloads[1].filename.includes('flux-supp-'),'main PDF publication precedes supplements with exact filename convention');
}
{
 const w=worker({pending:true});await flush();w.click();await flush();await w.advance(60000);
 h.ok(w.cancelled.includes(101)&&!w.titles.some(t=>/Captured [1-9]/.test(t)),'60s pending transfer is cancelled and never reported completed');
 await w.advance(30000);h.ok(w.titles.at(-1)?.includes('incomplete'),'whole capture deadline remains truthful after fallback also stalls');
}
{
 const w=worker({pending:true});await flush();w.click();await flush();w.jobs.get(101).state='complete';await w.advance(60000);
 h.ok(w.titles.some(t=>t.includes('Captured 1 file'))&&!w.cancelled.includes(101),'lost complete event is recovered from browser final state');
}
{
 const w=worker({pending:true});await flush();w.click();await flush();w.change({id:101,state:{current:'interrupted'},error:{current:'SERVER_FORBIDDEN'}});await flush();await w.advance(90000);
 h.ok(!w.titles.some(t=>/Captured [1-9]/.test(t)),'interrupted browser result never becomes successful file count');
}
{
 const w=worker({pending:true});await flush();w.click();await flush();w.jobs.get(101).bytesReceived=64*1024*1024+1;await w.advance(250);
 h.ok(w.cancelled.includes(101),'unknown-length download is stopped by observed bytesReceived cap');
}
{
 const w=worker({bytes:[64,64,64,64,64].map(m=>m*1024*1024)});await flush();w.click();await flush();
 h.ok(w.cancelled.includes(105)&&!w.titles.some(t=>t.includes('Captured 5')),'aggregate capture byte cap applies across completed files');
}
{
 const initial=[{id:1,filename:'/Downloads/flux/flux-old.pdf',byExtensionId:'flux-test',state:'in_progress'},{id:2,filename:'/Downloads/flux/flux-foreign.pdf',byExtensionId:'other-extension',state:'in_progress'},{id:3,filename:'/Downloads/flux/flux-unknown.pdf',state:'in_progress'},{id:4,filename:'/Downloads/ordinary.pdf',byExtensionId:'flux-test',state:'in_progress'}];
 const w=worker({initial});w.click();await flush();
 h.eq(w.cancelled,[1],'worker restart cancels only exact extension-owned capture downloads');
 h.ok(w.titles.some(t=>t.includes('1 owned pending transfer cancelled')&&t.includes('1 unattributable')),'restart reports incomplete and leaves unknown ownership untouched');
 h.ok(w.titles.at(-1)?.includes('Captured 1 file'),'new capture starts only after startup reconciliation');
}
{
 let resolve!:(v:any)=>void;const w=worker({deferredPage:new Promise(r=>resolve=r)});await flush();w.click();await flush();await w.advance(90000);const title=w.titles.at(-1);resolve({isPdf:true,pdfUrl:'https://publisher.test/a.pdf',slugHint:'late',supplements:[]});await flush();
 h.ok(w.downloads.length===0&&w.titles.at(-1)===title,'late script callback after overall deadline cannot download or publish stale success');
}
{
 const w=worker({startupFailures:1});await flush();h.ok(w.titles.at(-1)?.includes('retry'),'transient startup failure is visible');w.click();await flush();
 h.ok(w.downloads.length===1&&w.titles.at(-1)?.includes('Captured 1 file'),'next action retries startup reconciliation after a transient failure');
}
{
 const w=worker({page:{pdfUrl:'',slugHint:'metadata',pageUrl:'https://publisher.test/article',doi:'10.5555/metadata',title:'Metadata-only scientific record',supplements:[]}});await flush();w.click();await flush();
 h.ok(w.downloads.length===1&&w.downloads[0].filename.endsWith('.fluxcap')&&w.titles.at(-1)?.includes('metadata only'),'metadata-only fallback reports the actual captured sidecar without claiming PDF success');
}
const ordinary=zipSync({'nested/supplement.txt':strToU8('Exact scientific supplementary bytes'),'../safe-name.txt':strToU8('Path names remain caller-sanitized')},{level:0});
h.eq((await unzip(ordinary)).map(e=>[e.name,new TextDecoder().decode(e.bytes)]),[['nested/supplement.txt','Exact scientific supplementary bytes'],['../safe-name.txt','Path names remain caller-sanitized']],'ordinary archive preserves exact bytes and names without disk traversal claims');
const cen=(b:Uint8Array)=>{for(let i=0;i<b.length-3;i++)if(b[i]===0x50&&b[i+1]===0x4b&&b[i+2]===1&&b[i+3]===2)return i;throw Error('no central');};
for(const [label,mutate] of [
 ['encrypted',(b:Uint8Array)=>{new DataView(b.buffer).setUint16(cen(b)+8,1,true);}],
 ['CRC',(b:Uint8Array)=>{b[cen(b)+16]^=1;}],
 ['declared oversized member',(b:Uint8Array)=>{new DataView(b.buffer).setUint32(cen(b)+24,ZIP_LIMITS.member+1,true);}],
 ['truncated local data',(b:Uint8Array)=>{new DataView(b.buffer).setUint32(cen(b)+20,b.length,true);}],
 ['invalid method',(b:Uint8Array)=>{new DataView(b.buffer).setUint16(cen(b)+10,99,true);}],
 ['member count',(b:Uint8Array)=>{const d=new DataView(b.buffer);d.setUint16(b.length-14,2001,true);d.setUint16(b.length-12,2001,true);}],
] as const) {const bad=ordinary.slice();mutate(bad);await assert.rejects(()=>unzip(bad),/ZIP/);h.ok(true,`ZIP ${label} rejects rather than partial success`);}
await assert.rejects(()=>unzip(ordinary.subarray(0,ordinary.length-3)),/truncated|missing/);h.ok(true,'truncated ZIP end record rejects');
await assert.rejects(()=>unzip(new Uint8Array(ZIP_LIMITS.archive+1)),/archive exceeds/);h.ok(true,'archive input byte cap is checked before parsing');
const compressed=zipSync({'supplement.csv':new Uint8Array(2*1024*1024)},{level:9});h.eq((await unzip(compressed))[0].bytes.length,2*1024*1024,'valid highly compressible scientific data remains compatible within declared absolute limits');
const bomb=compressed.slice();new DataView(bomb.buffer).setUint32(cen(bomb)+24,1024,true);await assert.rejects(()=>unzip(bomb),/resource limit/);h.ok(true,'streaming inflation rejects actual bytes beyond declared bounded member allocation');
const corrupt=ordinary.slice();corrupt[cen(corrupt)+16]^=1;
await assert.rejects(()=>fetchEuropePmcSupplements('PMC123',{getBytes:async()=>({bytes:corrupt})} as any),/CRC/);h.ok(true,'malformed EPMC archive remains an actionable failure rather than no supplements');
h.done();
