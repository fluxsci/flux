'use strict';
// Optional S8 qualification, used only by the registered public-example gate.
// The ordinary probe's input sequences and measurement loop stay unchanged.
const fs = require('node:fs'), path = require('node:path');
module.exports = async function createModel3dProbe({ win, js, wait, wheel, mouse, sleep, out, variant, project }) {
  if (!['model', 'image'].includes(variant)) throw Error('S8 variant must be model or image');
  const fixture = JSON.parse(fs.readFileSync(path.join(project, 's8-fixture-receipt.json'), 'utf8'));
  const ids = fixture.additions.map(n => n.elementId);
  if (ids.length !== 4 || new Set(ids).size !== 4) throw Error('S8 requires four distinct added placements');
  const context = require('../lib/model3dNativeContextProbe.cjs')(win.webContents);
  await context.arm();
  const report = { variant, fixture, phases: {}, modelWorkers: null, context: null };
  await js(`(()=>{
    const p=window.__model3dS8={ids:${JSON.stringify(ids)},workers:[],samples:[],inputs:[],measuring:false};
    p.geometry=()=>{
      const h=document.querySelector('.figure-mode .canvas-host')?.getBoundingClientRect();
      const f=document.querySelector('[data-annotation-figure="${fixture.figureId}"] .figure-bg')?.getBoundingClientRect();
      const hover=document.querySelector('.figure-mode .hover-box')?.getBoundingClientRect();
      const boxes=p.ids.map(id=>{const n=document.querySelector('[data-editor-element-id="'+id+'"]'),r=n?.getBoundingClientRect();return {id,poster:!!n?.querySelector('[data-model3d-poster]'),image:!!n?.querySelector('image'),x:r?.x,y:r?.y,width:r?.width,height:r?.height,right:r?.right,bottom:r?.bottom}});
      return {host:h?{x:h.x,y:h.y,right:h.right,bottom:h.bottom,width:h.width,height:h.height}:null,figure:f?{x:f.x,y:f.y,right:f.right,bottom:f.bottom,width:f.width,height:f.height}:null,hover:hover?{x:hover.x,y:hover.y,width:hover.width,height:hover.height}:null,boxes};
    };
    for(const type of ['pointermove','wheel'])document.addEventListener(type,e=>{if(p.measuring&&e.isTrusted)p.inputs.push({type,x:e.clientX,y:e.clientY,stamp:e.timeStamp,targetId:e.target.closest?.('[data-editor-element-id]')?.dataset.editorElementId??null})},{capture:true,passive:true});
    p.sample=stamp=>{if(p.measuring)p.samples.push({stamp,...p.geometry()})};
    const Original=window.Worker;
    window.Worker=class extends Original{constructor(...args){super(...args);const row={url:String(args[0]),messages:[]};p.workers.push(row);this.addEventListener('message',e=>{const d=e.data;if(d&&typeof d==='object')row.messages.push({type:d.type,stats:d.stats,renderer:d.renderer,time:performance.now()})})}};
  })()`);
  const geometry = () => js('window.__model3dS8.geometry()');
  const persist = () => fs.writeFileSync(path.join(out, 'model3d-s8.json'), JSON.stringify(report, null, 2));
  async function prepareFigure() {
    // Fit the entire expanded public figure with clearance for the unchanged
    // 300px panSmall travel, retaining the original2D workload on-screen.
    for (let i = 0; i < 24; i++) {
      const g = await geometry();
      if (g.figure && g.host && g.figure.height<=g.host.height-324 && g.figure.width<=g.host.width-24) break;
      const label = 'Zoom out';
      const p = await js(`(()=>{const b=document.querySelector('.figure-mode button[aria-label="${label}"]').getBoundingClientRect();return{x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height/2)}})()`);
      mouse({type:'mouseDown',button:'left',clickCount:1,...p}); mouse({type:'mouseUp',button:'left',clickCount:1,...p});
      await sleep(35);
      if (i === 23) throw Error('S8 normal toolbar zoom did not settle at the specified row scale');
    }
    await sleep(250); // existing 180 ms zoom fold must finish before locating the row
    let g = await geometry();
    if (!g.host || g.host.height < 580 || g.boxes.some(b=>!b.width)) throw Error('S8 needs a visible canvas and four mounted boxes');
    const center={x:Math.round(g.host.x+g.host.width/2),y:Math.round(g.host.y+g.host.height/2)};
    const oldY=g.boxes[0].y;
    wheel(center.x,center.y,0,10); await sleep(80);
    const sign=Math.sign((await geometry()).boxes[0].y-oldY);
    if (!sign) throw Error('S8 native wheel pan was not delivered');
    wheel(center.x,center.y,0,-10); await sleep(80); g=await geometry();
    const targetX=center.x-g.figure.width/2;
    const targetY=sign>0?g.host.y+12:g.host.bottom-12-g.figure.height;
    wheel(center.x,center.y,(targetX-g.figure.x)/sign,(targetY-g.figure.y)/sign);
    await sleep(250);
    await wait(async()=>{const v=await geometry();return v.boxes.every(b=>b.width>=40&&b.height>=35&&(variant==='model'?b.poster:b.image))},'S8 four decoded model/image boxes',90000);
    report.viewport=await geometry(); report.wheelSign=sign;
    if (variant==='model') {
      await wait(()=>js("window.__model3dS8.workers.some(w=>w.url.includes('model3d.worker')&&w.messages.some(m=>m.stats?.assets===4))"),'S8 four resident worker assets',90000);
      const workers=await js("window.__model3dS8.workers.filter(w=>w.url.includes('model3d.worker'))");
      if (workers.length!==1) throw Error('S8 needs one actual model worker');
      const gpu=workers[0].messages.find(m=>m.type==='available')?.renderer;
      if (!gpu || /swiftshader|llvmpipe|software/i.test(gpu)) throw Error('S8 requires positively identified hardware rendering');
      const session=await context.connect(); report.context=await context.state(session);
      if (await context.workerCount()!==1 || report.context?.contexts!==1) throw Error('S8 must have one actual WebGL2 context');
      report.renderer=gpu; report.resident=workers[0].messages.filter(m=>m.stats).at(-1).stats;
    }
    persist();
  }
  async function beforePhase(label) {
    if(label==='paper:typing'){report.typingBefore=await js("document.querySelector('.cm-content').textContent");return;}
    if (!label.startsWith('figure:')) return;
    const initial=await geometry();
    if (!s8BoxesVisible(initial,variant)) throw Error('All four S8 boxes must be visible before '+label);
    report.phases[label]={initial};
    await js('window.__model3dS8.samples=[];window.__model3dS8.inputs=[];window.__model3dS8.measuring=true');
  }
  async function afterPhase(label, raw) {
    if (label.startsWith('figure:')) {
      const samples=await js('window.__model3dS8.measuring=false;window.__model3dS8.samples');
      const inputs=await js('window.__model3dS8.inputs');
      const rowInputs=inputs.filter(e=>ids.includes(e.targetId));
      const initial=report.phases[label].initial, response=s8InteractionEvidence(label.split(':').at(-1),initial,samples);
      report.phases[label]={initial,response,samples,inputs,rowInputs:rowInputs.length,delivered:{moves:raw.moves,wheels:raw.wheels,keys:raw.keys}}; persist();
      if(!response.ok)throw Error('S8 expected visible interaction response missing: '+label+' '+JSON.stringify(response));
      if (!rowInputs.length) throw Error('S8 input never hit a new model/image box: '+label);
      if (samples.length<20 || samples.some(s=>!s8BoxesVisible(s,variant))) throw Error('The full public figure and four S8 boxes were not visible throughout '+label);
      const minimum=label.endsWith(':hover')?['moves',35]:label.endsWith(':panSmall')?['wheels',72]:['wheels',20];
      if (raw[minimum[0]]<minimum[1]) throw Error('S8 native input delivery incomplete: '+label);
    } else if (label==='paper:typing') {
      const text=await js("document.querySelector('.cm-content').textContent");
      report.phases[label]={delivered:raw.keys,painted:raw.keyPaint.length,changed:text!==report.typingBefore,inserted:text.includes(' the quick brown fox jumps')};persist();
      if(!report.phases[label].changed||!report.phases[label].inserted)throw Error('S8 actual Paper text did not change');
      if (raw.keys<25 || raw.keyPaint.length<25) throw Error('S8 Paper typing was not delivered and painted');
    }
    const image=await win.webContents.capturePage(); fs.writeFileSync(path.join(out,'s8-'+label.replace(/[^a-z0-9]+/gi,'-')+'.png'),image.toPNG());
  }
  async function finish() {
    // Idle vsync control for the S8 budget (review R2): the page's own refresh
    // gap after every measured phase, in the same window and run.
    const idleGaps=await js("new Promise(resolve=>{const gaps=[];let last,frames=0;const step=t=>{if(last!==undefined)gaps.push(t-last);last=t;if(++frames<=120)requestAnimationFrame(step);else resolve(gaps)};requestAnimationFrame(step)})");
    report.idleControl={frames:idleGaps.length,gaps:idleGaps};
    report.modelWorkers=await js("window.__model3dS8.workers.filter(w=>w.url.includes('model3d.worker'))"); persist();
    if (report.modelWorkers.length!==(variant==='model'?1:0)) throw Error('S8 worker lifetime differs from the expected model/image variant');
    if (variant==='model') { const session=await context.connect(); report.contextAfter=await context.state(session); if (await context.workerCount()!==1||report.contextAfter?.contexts!==1) throw Error('S8 replaced its worker/context'); }
    persist();
  }
  return { prepareFigure, beforePhase, afterPhase, finish, ids };
};

function s8BoxesVisible(sample, variant) {
    const h=sample.host,f=sample.figure;
    return h && f && f.width>0 && f.height>0 && f.x>=h.x && f.y>=h.y && f.right<=h.right && f.bottom<=h.bottom && sample.boxes.length===4 && sample.boxes.every(b=>b.width>20&&b.height>20&&b.x>=h.x&&b.y>=h.y&&b.right<=h.right&&b.bottom<=h.bottom&&(variant==='model'?b.poster:b.image));
}

module.exports.s8BoxesVisible=s8BoxesVisible;

function s8InteractionEvidence(phase, initial, samples){
  if(!samples.length)return {ok:false,reason:'no geometry observations'};
  const first=initial.figure,last=samples.at(-1).figure;
  if(!first||!last||samples.some(s=>!s.figure))return {ok:false,reason:'missing figure geometry'};
  const returned=Math.abs(first.x-last.x)<=3&&Math.abs(first.y-last.y)<=3&&Math.abs(first.width-last.width)<=Math.max(2,first.width*.02);
  if(phase==='panSmall'){
    const ys=[first.y,...samples.map(s=>s.figure.y)],excursion=Math.max(...ys)-Math.min(...ys);
    return {ok:excursion>=250&&returned,excursion,returned};
  }
  if(phase==='zoom'){
    const widths=[first.width,...samples.map(s=>s.figure.width)],ratio=Math.max(...widths)/Math.min(...widths);
    return {ok:ratio>=1.5&&returned,scaleRatio:ratio,returned};
  }
  const states=samples.map(s=>!s.hover?'empty':s.boxes.some(b=>Math.abs(s.hover.x-b.x)<=6&&Math.abs(s.hover.y-b.y)<=6&&Math.abs(s.hover.width-b.width)<=12&&Math.abs(s.hover.height-b.height)<=12)?'row':'other');
  const transitions=states.reduce((n,state,i)=>n+(i>0&&state!==states[i-1]&&(state==='row'||states[i-1]==='row')?1:0),0);
  return {ok:states.includes('empty')&&states.includes('row')&&transitions>=10,transitions,rowFrames:states.filter(s=>s==='row').length,emptyFrames:states.filter(s=>s==='empty').length};
}
module.exports.s8InteractionEvidence=s8InteractionEvidence;
