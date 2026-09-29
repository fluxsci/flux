import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { build } from 'esbuild';
import { launch, errors } from './lib/driver.mjs';
import { harness } from './lib/harness.mjs';
import { inspectGlb } from '../src/lib/model3d/glbCore.mjs';
const h = harness('verify-slide-model3d-morph-browser'), out = path.resolve('test-results/model3d/slides-morph');
await mkdir(out, { recursive: true });
const fixtures = Object.fromEntries(await Promise.all(['morph-a','morph-b','morph-incompatible','box-axes','continuous'].map(async id => {
  const bytes = await readFile(`scripts/fixtures/model3d/fluxplot/${id}.glb`);
  return [id, { bytes: bytes.toString('base64'), manifest: JSON.parse(await readFile(`scripts/fixtures/model3d/fluxplot/${id}.fluxplot.json`, 'utf8')),
    asset: { id, kind: 'glb', name: id, path: `assets/${id}.glb`, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, model: inspectGlb(bytes) } }];
})));
const bundle = await build({ stdin: { resolveDir: process.cwd(), loader: 'ts', contents: `
export { createPlayer } from './src/lib/slide/player/player';
export { modelBindingOf } from './src/lib/slide/player/model3d';
export { createInlineHost } from './src/lib/model3d/inlineHost';
export { makeModel3dElement } from './src/lib/model3d/make';
export { furnitureLayout } from './src/lib/model3d/furnitureLayout';
export { createDeck, addSlide, addBeat, setTransform, becomeTransform, addGhostTransform } from './src/lib/slide/ops';
export { morphCompatible } from './src/lib/model3d/morphPair';
export { FLUX_LIGHT } from './src/lib/slide/theme';
` }, bundle: true, format: 'iife', globalName: 'MorphProbe', write: false, platform: 'browser', target: 'es2022', loader: { '.css': 'empty' } });
const { browser, page } = await launch({ width: 1000, height: 760 });
try {
  await page.setContent('<!doctype html><html><body style="margin:0;background:white"><div id="stage"></div></body></html>');
  await page.evaluate('window.__name = value => value'); await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const result = await page.evaluate(async fixtures => {
    const api = (window as any).MorphProbe, checks: [boolean,string][] = [], ok = (yes: unknown, name: string) => checks.push([!!yes,name]);
    const table = fixtures as any, stage = document.getElementById('stage')!, host = api.createInlineHost({ sourceKey: 'morph-gate', modelBytes: (id: string) => Uint8Array.from(atob(table[id].bytes), c => c.charCodeAt(0)) });
    const opts = { theme: api.FLUX_LIGHT, model3d: host, modelAsset: (id: string) => table[id]?.asset, modelManifest: (id: string) => table[id]?.manifest };
    const model = (assetId: string, id: string, patch = {}) => ({ ...api.makeModel3dElement(table[assetId].asset, { id, manifest: table[assetId].manifest }), x: 10, y: 20, width: 300, height: 270, modelLighting: 'unlit', ...patch });
    const data = (canvas: HTMLCanvasElement) => canvas.toDataURL();
    const count = (canvas: HTMLCanvasElement) => { if (!canvas.width) return 0; const p = canvas.getContext('2d')!.getImageData(0,0,canvas.width,canvas.height).data; let n=0; for(let i=3;i<p.length;i+=4)if(p[i])n++;return n; };
    const setup = (a: any,b: any, mode: string) => {
      const deck = api.createDeck({withTitleSlide:false}); deck.stage = {width:740,height:400}; deck.assets = Object.values(table).map((x:any)=>x.asset);
      const slide = api.addSlide(deck); slide.elements.push(a,b); const beat = api.addBeat(deck,slide.id);
      const result = api.becomeTransform(deck,slide.id,beat.id,a.id,b.id,{mode,duration:1000,easing:'linear'});
      const player = api.createPlayer(stage,deck,opts); return {deck,slide,player,result};
    };
    const direct = document.createElement('canvas'), directView=host.view(direct);
    for(const [target,mode] of [['morph-b','consume'],['morph-incompatible','consume'],['morph-b','handoff'],['morph-incompatible','handoff']]) {
      const a=model('morph-a','A'),b=model(target,'B',{x:380,y:45,width:330,height:300,orbitAzimuth:145,orbitZoom:1.1});
      const {player,result}=setup(a,b,mode); await player.readyMedia();
      if(mode==='handoff')ok(stage.querySelector<HTMLCanvasElement>('.sl-handoff canvas')!.width===0,`${target}: inactive flight allocates no backing storage`);
      const before = stage.querySelector<HTMLCanvasElement>('canvas[data-slide-model3d="A"]')!;
      const layoutA=api.furnitureLayout(table[a.assetId].manifest,a,a.overrides);directView.render(a,before.width,before.height,{manifest:table[a.assetId].manifest});
      ok(data(before)===data(direct),`${mode}/${target}: t=0 exact A pixels`);
      const seen:Record<string,string>={};
      for(const ms of [500,250,750,500]) {
        player.seek(0,1,ms);await player.captureMedia([],ms);
        const canvas=mode==='handoff'?stage.querySelector<HTMLCanvasElement>('.sl-handoff canvas')!:before;
        ok(count(canvas)>1000,`${mode}/${target}: ${ms}ms visible mesh`);
        if(seen[ms])ok(seen[ms]===data(canvas),`${mode}/${target}: repeated seek exact`);seen[ms]=data(canvas);
        if(mode==='handoff')ok(before.width===0&&stage.querySelector<HTMLCanvasElement>('canvas[data-slide-model3d="B"]')!.width===0,`${target}: resting endpoints release storage in flight`);
      }
      player.seek(0,1,1000);await player.captureMedia([],1000);
      const endpoint=stage.querySelector<HTMLCanvasElement>(`canvas[data-slide-model3d="${mode==='handoff'?'B':'A'}"]`)!;
      directView.render(b,endpoint.width,endpoint.height,{manifest:table[b.assetId].manifest});ok(data(endpoint)===data(direct),`${mode}/${target}: t=1 pixel-identical B`);
      ok(result.morph===(target==='morph-b'),`${mode}/${target}: authoring compatibility matches actual route`);
      if(mode==='handoff')ok(stage.querySelector<HTMLCanvasElement>('.sl-handoff canvas')!.width===0,`${target}: landed flight releases backing storage`);
      const rendered=host.stats().renders;await new Promise(r=>setTimeout(r,40));ok(rendered===host.stats().renders,`${mode}/${target}: zero resting GPU work`);
      player.destroy();
    }
    // Geometry mix clamps independently of the supplied sampled camera/lighting.
    const viewA=model('morph-a','A'),viewB=model('morph-b','B',{orbitAzimuth:130,orbitProjection:'perspective'}), sampled={...viewA,orbitAzimuth:73,orbitZoom:1.37,orbitProjection:'orthographic'};
    const pairs=api.morphCompatible(table['morph-a'].asset,table['morph-b'].asset).pairs;
    for(const t of [-.2,1.2]) for(const kind of ['morph','crossfade']) {
      const extra={to:viewB.assetId,t,fromElement:viewA,toElement:viewB,toManifest:table[viewB.assetId].manifest,...(kind==='morph'?{pairs}:{})};
      const info=directView.render(sampled,250,220,{manifest:table[viewA.assetId].manifest,[kind]:extra});const actual=data(direct);
      directView.render({...t<0?viewA:viewB,orbitAzimuth:sampled.orbitAzimuth,orbitZoom:sampled.orbitZoom,orbitProjection:sampled.orbitProjection},250,220,{manifest:table[t<0?viewA.assetId:viewB.assetId].manifest});
      ok(actual===data(direct),`${kind} clamped ${t} geometry retains sampled camera/discrete projection`);
    }
    // A different axes manifest must be used by endpoint B, not inherited A.
    const a=model('morph-a','A'), b=model('morph-b','B',{x:380,orbitAzimuth:70});
    const old=table['morph-b'].manifest; table['morph-b'].manifest={...old,axes:{kind:'box',x:{lim:[-8,8]},y:{lim:[-3,3]},z:{lim:[-4,4]}}};
    const box=setup(a,b,'consume');await box.player.readyMedia();box.player.seek(0,1,1000);await box.player.captureMedia([],1000);
    const cb=stage.querySelector<HTMLCanvasElement>('canvas')!;directView.render(b,cb.width,cb.height,{manifest:table['morph-b'].manifest});
    ok(data(cb)===data(direct)&&!!stage.querySelector('svg line'),'different framing bounds and axes furniture land exactly on B');box.player.destroy();table['morph-b'].manifest=old;
    // Cross-kind model flight: encoded snapshots, never canvas.cloneNode().
    const image={id:'I',type:'image',assetId:'img',x:400,y:60,width:220,height:240,rotation:0,opacity:1};
    for(const reverse of [false,true]) {
      const deck=api.createDeck({withTitleSlide:false});deck.stage={width:740,height:400};deck.assets=Object.values(table).map((x:any)=>x.asset);
      const slide=api.addSlide(deck),mesh=model('continuous','M');slide.elements.push(mesh,image);const beat=api.addBeat(deck,slide.id);
      api.becomeTransform(deck,slide.id,beat.id,reverse?'I':'M',reverse?'M':'I',{duration:1000,easing:'linear'});
      let held: (()=>void)|undefined;const nativeSet=SVGElement.prototype.setAttribute;
      if(!reverse)SVGElement.prototype.setAttribute=function(name:string,value:string){if(this.tagName.toLowerCase()==='image'&&this.hasAttribute('data-model-snapshot')&&name==='href'&&value.startsWith('blob:')){held=()=>nativeSet.call(this,name,value);return;}nativeSet.call(this,name,value);};
      const player=api.createPlayer(stage,deck,{...opts,assetUrl:()=> 'data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="220" height="240"><rect width="220" height="240" fill="red"/></svg>')});
      const pendingReady=player.readyMedia();let ready=false;void pendingReady.then(()=>ready=true);
      if(!reverse){for(let i=0;i<100&&!held;i++)await new Promise(r=>setTimeout(r,5));ok(!!held&&!ready,'snapshot readiness waits for actual SVG image load');SVGElement.prototype.setAttribute=nativeSet;held?.();}
      await pendingReady;player.seek(0,1,500);await player.captureMedia([],500);
      const snap=stage.querySelector<SVGImageElement>('image[data-model-snapshot="M"]')!,url=snap?.getAttribute('href');
      const decoded=new Image();decoded.src=url!;await decoded.decode();ok(!!url?.startsWith('blob:')&&decoded.naturalWidth>10,`${reverse?'image→model':'model→image'} uses decoded model snapshot`);
      ok(!stage.querySelector('.sl-handoff canvas')&&stage.querySelector('.sl-handoff')?.textContent?.includes('Height'),'cross-kind snapshot retains vector furniture without live flight backing');
      player.destroy();
    }
    // A whole model in a group or part flight flies its mesh snapshot, never the
    // furniture-only SVG layer its wrapper holds; a video flies its stored poster.
    const decodedSnapshot=async(id:string)=>{const url=stage.querySelector<SVGImageElement>(`.sl-handoff image[data-model-snapshot="${id}"]`)?.getAttribute('href');if(!url?.startsWith('blob:'))return 0;const decoded=new Image();decoded.src=url;await decoded.decode();return decoded.naturalWidth;};
    const rectAt=(id:string,patch={})=>({id,type:'rect',x:20,y:40,width:200,height:160,rotation:0,opacity:1,fill:'#d14d41',stroke:'none',strokeWidth:0,cornerRadius:0,...patch});
    for(const kind of ['group','part']) {
      const deck=api.createDeck({withTitleSlide:false});deck.stage={width:740,height:400};deck.assets=Object.values(table).map((x:any)=>x.asset);
      const slide=api.addSlide(deck),beat=api.addBeat(deck,slide.id);
      if(kind==='group'){slide.groups={g:{id:'g',name:'Group'}};slide.elements.push(rectAt('R'),model('continuous','G1',{x:380,y:30,width:300,height:260,groupId:'g'}),rectAt('G2',{x:380,y:320,height:50,groupId:'g'}));api.becomeTransform(deck,slide.id,beat.id,'R',{element:'G1',group:'g'},{mode:'handoff',duration:1000,easing:'linear'});}
      else{slide.elements.push(model('continuous','P'),model('continuous','G1',{x:380,y:60}));beat.tracks.push({id:'part-flight',target:'P',part:'height.colorbar',preset:'transform',duration:1000,easing:'linear',to:{become:{mode:'handoff',ref:{element:'G1'}}}});}
      const player=api.createPlayer(stage,deck,opts);await player.readyMedia();player.seek(0,1,500);await player.captureMedia([],500);
      ok(await decodedSnapshot('G1')>10,`${kind} hand-off landing on a whole model flies its decoded mesh snapshot`);
      player.destroy();
    }
    for(const reverse of [false,true]) {
      const deck=api.createDeck({withTitleSlide:false});deck.stage={width:740,height:400};deck.assets=Object.values(table).map((x:any)=>x.asset);
      const slide=api.addSlide(deck),beat=api.addBeat(deck,slide.id),mesh=model('continuous','M'),clip={...rectAt('V',{x:400,y:60,width:240,height:180}),type:'video',assetId:'clip',posterAssetId:'clip-poster',durationMs:1000};
      slide.elements.push(mesh,clip);api.becomeTransform(deck,slide.id,beat.id,reverse?'V':'M',reverse?'M':'V',{duration:1000,easing:'linear'});
      const poster='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="240" height="180"><rect width="240" height="180" fill="#205ea6"/></svg>');
      const player=api.createPlayer(stage,deck,{...opts,assetUrl:(id:string)=>id==='clip-poster'?poster:undefined});await player.readyMedia();player.seek(0,1,500);await player.captureMedia([],500);
      // The flight group (clone node) carries the cross-fade opacity: 1-t or t.
      const still=stage.querySelector<SVGImageElement>('.sl-handoff image[data-video-poster="V"]'),flightGroup=still?.parentElement?.parentElement;
      ok(!!still&&still.getAttribute('href')===poster&&still.width.baseVal.value===240&&Math.abs(Number(flightGroup?.getAttribute('opacity'))-.5)<1e-9&&await decodedSnapshot('M')>10,`${reverse?'video→model':'model→video'} poster hand-off cross-fades both sides mid-flight`);
      player.destroy();
    }
    const semanticA=model('continuous','semantic'),semanticB=model('continuous','semanticB');
    table.semanticCopy={...table.continuous,asset:{...table.continuous.asset,id:'semanticCopy'}};semanticB.assetId='semanticCopy';
    const sem=setup(semanticA,semanticB,'consume');await sem.player.readyMedia();sem.player.seek(0,1,500);await sem.player.captureMedia([],500);
    ok(stage.querySelectorAll('[id="semantic__height.colorbar"]').length===1,'morph furniture keeps one canonical semantic target across both fading endpoints');sem.player.destroy();
    for(const reverse of [false,true]) {
      const rect={id:'rect',type:'rect',x:390,y:60,width:250,height:220,rotation:0,opacity:1,fill:'#d14d41',stroke:'none',strokeWidth:0,cornerRadius:0};
      const mesh=model('continuous','mesh'),source=reverse?rect:mesh,destination=reverse?mesh:rect;
      const {player,slide}=setup(source,destination,'consume');await player.readyMedia();
      ok(slide.elements.length===1,'cross-kind consume retains only the source identity');
      for(const ms of [250,500,750,250]) {
        player.seek(0,1,ms);await player.captureMedia([],ms);
        const canvas=stage.querySelector<HTMLCanvasElement>('canvas[data-slide-model3d]')!;
        const ownsModel=reverse?ms>=500:ms<500;
        ok(ownsModel?count(canvas)>1000:canvas.width===0&&!!stage.querySelector('image[data-model-snapshot][href^="blob:"]'),`${reverse?'rect→model':'model→rect'} ${ms}ms keeps live backing only while owning the discrete kind`);
      }
      player.destroy();
    }
    const deck=api.createDeck({withTitleSlide:false});deck.stage={width:960,height:640};deck.assets=Object.values(table).map((x:any)=>x.asset);
    const slide=api.addSlide(deck),source=model('morph-a','source',{width:180,height:160});slide.elements.push(source);const beat=api.addBeat(deck,slide.id);
    const ghosts=api.addGhostTransform(deck,slide.id,beat.id,source.id,{count:8,duration:1000,states:Array.from({length:8},(_,i)=>({x:10+(i%4)*230,y:220+Math.floor(i/4)*190,orbitAzimuth:i*43}))});
    const p=api.createPlayer(stage,deck,opts);await p.readyMedia();
    ok(ghosts.elementIds.every((id:string)=>stage.querySelector<HTMLCanvasElement>(`canvas[data-slide-model3d="${id}"]`)!.width===0),'eight unborn copies allocate zero backing pixels');
    p.seek(0,1,1000);await p.captureMedia([],1000);
    const frames=ghosts.elementIds.map((id:string)=>stage.querySelector<HTMLCanvasElement>(`canvas[data-slide-model3d="${id}"]`)!);
    ok(frames.every((c:HTMLCanvasElement)=>count(c)>100)&&new Set(frames.map(data)).size>=6,'eight copies share geometry with independent visible orbit frames');
    ok(host.stats().contexts===1,'content, handoff, snapshots and eight ghosts share one WebGL context');
    const wrap=stage.querySelector<HTMLElement>(`[data-el-id="${ghosts.elementIds[0]}"]`)!;wrap.style.transform='translateX(2000px)';
    await new Promise(r=>setTimeout(r,80));ok(frames[0].width===0,'offscreen copy releases its backing store');wrap.style.transform='';p.refresh();await new Promise(r=>setTimeout(r,80));await p.readyMedia();ok(frames[0].width>0,'onscreen copy reacquires its backing store');
    (window as any).morphGate={p,host,directView};return checks;
  }, fixtures);
  for(const [yes,name] of result)h.ok(yes,name);
  await page.screenshot({path:path.join(out,'eight-ghosts.png')});
  await writeFile(path.join(out,'receipt.json'),JSON.stringify({checks:result},null,2));
  await page.evaluate(()=>{const x=(window as any).morphGate;x.p.destroy();x.directView.dispose();x.host.dispose();});
  h.eq(errors(page),[],'no uncaught browser errors');
} finally {await browser.close();}
await h.done();
