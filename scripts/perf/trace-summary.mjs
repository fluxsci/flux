// Summarize a Chrome trace (contentTracing / DevTools JSON): busiest threads, the renderer
// main thread's long top-level tasks (default ≥50 ms) and the self time per event name
// inside them — a long task that is all Document::recalcStyle with elementCount ≈ the plot
// node count is the inherited-property trap (guide §9).
//   node scripts/perf/trace-summary.mjs <trace.json> [minLongMs]
import fs from 'node:fs';
const f=process.argv[2];const minLong=+(process.argv[3]||50);
const raw=JSON.parse(fs.readFileSync(f,'utf8'));const ev=raw.traceEvents||raw;
const names={};for(const e of ev)if(e.ph==='M'&&e.name==='thread_name')names[e.pid+':'+e.tid]=e.args.name;
const procs={};for(const e of ev)if(e.ph==='M'&&e.name==='process_name')procs[e.pid]=e.args.name;
const X=ev.filter(e=>e.ph==='X'&&typeof e.dur==='number');
// per-thread totals of top-level-ish names
const byThread={};for(const e of X){const k=e.pid+':'+e.tid;(byThread[k]=byThread[k]||{n:0,dur:0}).n++;byThread[k].dur+=e.dur}
console.log('threads (ms of X events):');for(const [k,v] of Object.entries(byThread).sort((a,b)=>b[1].dur-a[1].dur).slice(0,8))console.log('  ',k,names[k]||'?',procs[k.split(':')[0]]||'',(v.dur/1000).toFixed(0),'ms',v.n,'events');
const mainKeys=Object.keys(names).filter(k=>names[k]==='CrRendererMain');
for(const mk of mainKeys){
 const [pid,tid]=mk.split(':').map(Number);const M=X.filter(e=>e.pid===pid&&e.tid===tid).sort((a,b)=>a.ts-b.ts);
 if(!M.length)continue;
 console.log('\n== renderer main',mk,'events',M.length);
 // find long events that have no enclosing longer event (top-level long tasks)
 const long=M.filter(e=>e.dur>=minLong*1000);
 const tops=long.filter(e=>!long.some(o=>o!==e&&o.ts<=e.ts&&o.ts+o.dur>=e.ts+e.dur&&(o.dur>e.dur||(o.dur===e.dur&&o.ts<e.ts))));
 console.log('long (>='+minLong+'ms) top-level tasks:',tops.length);
 // aggregate by name: total self time inside long tops
 const agg={};const cnt={};
 for(const t of tops.slice(0,40)){
  const inside=M.filter(e=>e!==t&&e.ts>=t.ts&&e.ts+e.dur<=t.ts+t.dur);
  // self time: dur minus children dur (children = events directly nested; approximate by sorting)
  const all=[t,...inside].sort((a,b)=>a.ts-b.ts||b.dur-a.dur);
  const stack=[];
  for(const e of all){while(stack.length&&!(stack.at(-1).ts<=e.ts&&stack.at(-1).ts+stack.at(-1).dur>=e.ts+e.dur))stack.pop();if(stack.length){stack.at(-1)._child=(stack.at(-1)._child||0)+e.dur}stack.push(e)}
  for(const e of all){const self=e.dur-(e._child||0);const key=e.name+(e.args?.data?.type?'('+e.args.data.type+')':'');agg[key]=(agg[key]||0)+self;cnt[key]=(cnt[key]||0)+1;delete e._child}
 }
 console.log('self-time by event name inside long tasks (ms, count):');
 for(const [k,v] of Object.entries(agg).sort((a,b)=>b[1]-a[1]).slice(0,25))console.log('  ',(v/1000).toFixed(1).padStart(8),String(cnt[k]).padStart(5),k);
 // show the first two long tasks with their direct children
 for(const t of tops.slice(0,2)){
  console.log('\n-- long task',t.name,(t.dur/1000).toFixed(1),'ms args',JSON.stringify(t.args).slice(0,200));
  const inside=M.filter(e=>e!==t&&e.ts>=t.ts&&e.ts+e.dur<=t.ts+t.dur&&e.dur>2000).sort((a,b)=>b.dur-a.dur).slice(0,15);
  for(const e of inside)console.log('     ',(e.dur/1000).toFixed(1).padStart(7),e.name,JSON.stringify(e.args).slice(0,160));
 }
}
