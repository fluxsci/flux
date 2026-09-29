import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { build } from 'esbuild';
import { launch, errors } from './lib/driver.mjs';
import { harness } from './lib/harness.mjs';
import { inspectGlb } from '../src/lib/model3d/glbCore.mjs';
const h = harness('verify-slide-model3d-parts-browser'), out = path.resolve('test-results/model3d/slides-parts');
await mkdir(out, { recursive: true });
const bytes = await readFile('scripts/fixtures/model3d/fluxplot/morph-a.glb');
const manifest = JSON.parse(await readFile('scripts/fixtures/model3d/fluxplot/morph-a.fluxplot.json', 'utf8'));
manifest.parts.push({ id: 'title', role: 'title', text: 'Neuron compartments' }); manifest.layout = { title: 'top' };
const fixture = { bytes: bytes.toString('base64'), manifest, asset: { id: 'model', kind: 'glb', name: 'Model', path: 'assets/model.glb', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), model: inspectGlb(bytes) } };
const bundle = await build({ stdin: { resolveDir: process.cwd(), loader: 'ts', contents: `
export { createPlayer, renderStaticAt } from './src/lib/slide/player/player';
export { createInlineHost } from './src/lib/model3d/inlineHost';
export { makeModel3dElement } from './src/lib/model3d/make';
export { createDeck, addSlide, addBeat, setTransform, becomeTransform } from './src/lib/slide/ops';
export { FLUX_LIGHT } from './src/lib/slide/theme';
` }, bundle: true, write: false, format: 'iife', globalName: 'PartsProbe', platform: 'browser', target: 'es2022', loader: { '.css': 'empty' } });
const { browser, page } = await launch({ width: 760, height: 500 });
try {
  await page.setContent('<!doctype html><html><body style="margin:0;background:white"><div id="stage"></div></body></html>');
  await page.evaluate('window.__name=value=>value'); await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const result = await page.evaluate(async fixture => {
    const api = (window as any).PartsProbe, checks: [boolean, string][] = [], ok = (value: unknown, name: string) => checks.push([!!value, name]);
    const host = api.createInlineHost({ sourceKey: 'parts', modelBytes: () => Uint8Array.from(atob(fixture.bytes), c => c.charCodeAt(0)) });
    const deck = api.createDeck({ withTitleSlide: false }); deck.stage = { width: 720, height: 440 }; deck.assets = [fixture.asset];
    const slide = api.addSlide(deck), element = { ...api.makeModel3dElement(fixture.asset, { id: 'M', manifest: fixture.manifest }), x: 35, y: 20, width: 620, height: 390, orbitAzimuth: 0, orbitElevation: 0, modelLighting: 'unlit', overrides: { 'cortex.left': { opacity: .6 } } };
    slide.elements.push(element); const authored = JSON.stringify(slide.elements);
    const one = api.addBeat(deck, slide.id), two = api.addBeat(deck, slide.id), three = api.addBeat(deck, slide.id);
    one.tracks.push({ id: 'left-in', target: 'M', part: 'cortex.left', preset: 'fade', duration: 1000, easing: 'linear' }, { id: 'title-in', target: 'M', part: 'title', preset: 'fade', duration: 1000, easing: 'linear' });
    two.tracks.push({ id: 'left-out', target: 'M', part: 'cortex.left', preset: 'fadeOut', duration: 1000, easing: 'linear' });
    three.tracks.push({ id: 'right-emphasis', target: 'M', part: 'cortex.right', preset: 'highlight', duration: 1000, easing: 'linear' });
    const stage = document.getElementById('stage')!; let player = api.createPlayer(stage, deck, { theme: api.FLUX_LIGHT, model3d: host, modelManifest: () => fixture.manifest, modelAsset: () => fixture.asset });
    await player.readyMedia(); let canvas = stage.querySelector<HTMLCanvasElement>('canvas[data-slide-model3d="M"]')!;
    const reference = document.createElement('canvas'), view = host.view(reference);
    const pixels = (c: HTMLCanvasElement) => c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
    const rightPixels = (c: HTMLCanvasElement) => { const data = pixels(c), out: number[] = []; for (let y = 0; y < c.height; y++) for (let x = Math.ceil(c.width * .55); x < c.width; x++) for (let k = 0; k < 4; k++) out.push(data[(y*c.width+x)*4+k]); return JSON.stringify(out); };
    const right = rightPixels(canvas), seen: Record<string, string> = {};
    for (const [beat, ms, left, rightFactor] of [[0,0,0,1],[1,500,.5,1],[1,1000,1,1],[2,500,.5,1],[2,1000,0,1],[1,500,.5,1],[3,500,0,.7],[1,0,0,1]]) {
      player.seek(0, beat, ms); await player.captureMedia([], ms);
      const direct = { ...element, x: 0, y: 0, overrides: { 'cortex.left': { opacity: .6 * left, hidden: left === 0 }, 'cortex.right': { opacity: rightFactor } } };
      view.render(direct, canvas.width, canvas.height, { manifest: fixture.manifest });
      ok(canvas.toDataURL() === reference.toDataURL(), `beat${beat}/${ms}: appearance multiplies source alpha and agrees with independent styled render`);
      if (rightFactor === 1) ok(rightPixels(canvas) === right, `beat${beat}/${ms}: unselected neighboring mesh pixels are exact`);
      const key = `${beat}/${ms}`; if (seen[key]) ok(seen[key] === canvas.toDataURL(), 'reverse/random seek restores exact part pixels'); seen[key] = canvas.toDataURL();
      const title = stage.querySelector<SVGElement>('[id="M__title"]');
      if (beat === 1 && ms === 500) ok(!!title && Number(getComputedStyle(title).opacity) === .5, 'furniture follows the ordinary DOM appearance path');
    }
    ok(JSON.stringify(slide.elements) === authored, 'live part animation leaves saved Design overrides untouched');
    // Stills (thumbnails, presenter next slide, no-WebGL) name the step's mesh appearance.
    const requests: any[] = [], still = document.createElement('div'); document.body.append(still);
    const modelPoster = (_el: unknown, partOpacity?: Record<string, number>) => { requests.push(partOpacity); return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" data-left="${partOpacity?.['cortex.left'] ?? 1}"/>`)}`; };
    for (const [beat, left] of [[0, 0], [1, 1], [2, 0]] as const) {
      requests.length = 0; api.renderStaticAt(still, slide, deck.stage, beat, { theme: api.FLUX_LIGHT, modelManifest: () => fixture.manifest, modelAsset: () => fixture.asset, modelPoster });
      const href = decodeURIComponent(still.querySelector('image[data-model3d-poster]')?.getAttribute('href') ?? '');
      ok((requests.at(-1)?.['cortex.left'] ?? 1) === left && href.includes(`data-left="${left}"`), `step ${beat} still requests and shows the sampled mesh-part appearance`);
    }
    still.remove();
    // A with-prev step is one presenter/video cue: its mesh parts play concurrently.
    player.destroy();
    const runDeck = api.createDeck({ withTitleSlide: false }); runDeck.stage = deck.stage; runDeck.assets = deck.assets;
    const run = api.addSlide(runDeck); run.elements.push(structuredClone(element));
    api.addBeat(runDeck, run.id).tracks.push({ id: 'run-left', target: 'M', part: 'cortex.left', preset: 'fade', duration: 1000, easing: 'linear' });
    api.addBeat(runDeck, run.id, { advance: 'with-prev' }).tracks.push({ id: 'run-right', target: 'M', part: 'cortex.right', preset: 'fade', duration: 1000, easing: 'linear' });
    player = api.createPlayer(stage, runDeck, { theme: api.FLUX_LIGHT, model3d: host, modelManifest: () => fixture.manifest, modelAsset: () => fixture.asset, reducedMotion: false });
    await player.readyMedia(); canvas = stage.querySelector<HTMLCanvasElement>('canvas[data-slide-model3d="M"]')!;
    const runFrame = (left: number, right: number) => { view.render({ ...element, x: 0, y: 0, overrides: { 'cortex.left': { opacity: .6 * left, hidden: left === 0 }, 'cortex.right': { opacity: right, hidden: right === 0 } } }, canvas.width, canvas.height, { manifest: fixture.manifest }); return reference.toDataURL(); };
    player.seek(0, 2, 500, 1); await player.captureMedia([], 500);
    ok(canvas.toDataURL() === runFrame(.5, .5), 'video-cue seek samples both with-prev mesh fades at the same time');
    player.goTo(0, 0); player.next(); player.pause(); await player.captureMedia([], 0);
    ok(player.state().beat === 2 && player.state().time === 0 && canvas.toDataURL() === runFrame(0, 0), 'Present cue starts the click beat\'s mesh fade with its with-prev step');
    const mixed = api.addBeat(deck,slide.id); mixed.tracks.push({id:'mixed',target:'M',parts:['cortex.left','cortex.right','title'],preset:'fade',duration:1000,easing:'linear',stagger:{perMs:200}});
    player.destroy(); player = api.createPlayer(stage, deck, {theme:api.FLUX_LIGHT,model3d:host,modelManifest:()=>fixture.manifest,modelAsset:()=>fixture.asset}); await player.readyMedia(); canvas=stage.querySelector<HTMLCanvasElement>('canvas[data-slide-model3d="M"]')!; player.seek(0,4,500); await player.captureMedia([],500);
    ok(Math.abs(Number(getComputedStyle(stage.querySelector('[id="M__title"]')!).opacity)-.1)<1e-5,'mixed mesh/furniture stagger retains full semantic leaf ranks in DOM');
    view.render({...element,overrides:{'cortex.left':{opacity:.3},'cortex.right':{opacity:.3}}},canvas.width,canvas.height,{manifest:fixture.manifest});
    ok(stage.querySelector<HTMLCanvasElement>('canvas[data-slide-model3d="M"]')!.toDataURL()===reference.toDataURL(),'mixed stagger renders corresponding mesh factors with the same clock');
    const renders = host.stats().renders; await new Promise(resolve => setTimeout(resolve, 60)); ok(host.stats().renders === renders, 'part animation has no resting render heartbeat');
    player.seek(0,1,500); await player.captureMedia([],500);
    ok(host.stats().contexts === 1 && host.stats().loads === 1, 'mesh/furniture appearances keep one context and one parsed asset');
    await host.ready(['other']); const destination={...element,assetId:'other',overrides:{}}, destinationManifest=structuredClone(fixture.manifest);destinationManifest.parts=destinationManifest.parts.map(p=>p.node?{...p,id:'new.'+p.id}:p);destinationManifest.order=undefined;
    const pairs=fixture.manifest.parts.filter(p=>p.node).map(p=>({nodeA:p.node,nodeB:p.node}));
    const morph={to:'other',t:1,pairs,fromElement:element,toElement:destination,toManifest:destinationManifest};
    view.render(element,canvas.width,canvas.height,{manifest:fixture.manifest,morph,partOpacity:{'new.cortex.left':0}});const endpoint=reference.toDataURL();
    view.render({...destination,overrides:{'new.cortex.left':{hidden:true}}},canvas.width,canvas.height,{manifest:destinationManifest});ok(reference.toDataURL()===endpoint,'morph endpoint opacity resolves destination semantic IDs through destination manifest');
    view.render(element,canvas.width,canvas.height,{manifest:fixture.manifest,morph,partOpacity:{'new.cortex.left':1}});const restored=reference.toDataURL();
    view.render(destination,canvas.width,canvas.height,{manifest:destinationManifest});ok(reference.toDataURL()===restored,'destination factor one resets prior transient visibility/material alpha');
    player.destroy(); const future=api.createDeck({withTitleSlide:false});future.stage=deck.stage;future.assets=deck.assets;const f=api.addSlide(future);f.elements=[{id:'R',type:'rect',x:35,y:20,width:620,height:390,rotation:0,fill:'#ccc',stroke:'none',strokeWidth:0,cornerRadius:0},{...element,id:'B'}];const born=api.addBeat(future,f.id);api.becomeTransform(future,f.id,born.id,'R','B',{mode:'consume',modelAsset:()=>fixture.asset});const hide=api.addBeat(future,f.id);hide.tracks.push({id:'future-mesh',target:'R',part:'cortex.left',preset:'fadeOut',duration:1000,easing:'linear'});
    player=api.createPlayer(stage,future,{theme:api.FLUX_LIGHT,model3d:host,modelManifest:()=>fixture.manifest,modelAsset:()=>fixture.asset});await player.readyMedia();
    const count=()=>{const c=stage.querySelector<HTMLCanvasElement>('canvas[data-slide-model3d="R"]')!,p=pixels(c);let blue=0,teal=0;for(let k=0;k<p.length;k+=4)if(p[k+3]>32){if(p[k+2]>p[k+1]+20&&p[k+1]>p[k]+30)blue++;if(p[k+1]>p[k]+40&&Math.abs(p[k+1]-p[k+2])<20)teal++;}return{blue,teal};};
    player.seek(0,2,1000);await player.captureMedia([],1000);let futurePixels=count();ok(futurePixels.blue===0&&futurePixels.teal>100,'rect→model Consume followed by part exit samples the future model appearance');
    player.seek(0,1,1000);await player.captureMedia([],1000);futurePixels=count();ok(futurePixels.blue>100&&futurePixels.teal>100,'reverse seek restores source alpha after the future-model factor returns to one');
    player.seek(0,2,500);await player.captureMedia([],500);
    // A Become INTO a mesh part crossfades in place: no flight layer, clone or
    // snapshot; the mesh part fades in on the part-opacity channel while the
    // source (a 2D object, a whole model, another model's labels) fades out.
    player.destroy();
    const meshFrame = (f: number) => { const c = stage.querySelector<HTMLCanvasElement>('canvas[data-slide-model3d="M"]')!; view.render({ ...element, x: 0, y: 0, overrides: { 'cortex.left': { opacity: .6 * f, hidden: f === 0 } } }, c.width, c.height, { manifest: fixture.manifest }); return c.toDataURL() === reference.toDataURL(); };
    const maxDiff = (a: string, b: string) => new Promise<number>(resolve => { const [ia, ib] = [new Image(), new Image()]; let n = 0; const done = () => { if (++n < 2) return; const w = ia.naturalWidth, h2 = ia.naturalHeight, c = document.createElement('canvas'); c.width = w; c.height = h2; const g = c.getContext('2d')!; g.drawImage(ia, 0, 0); const pa = g.getImageData(0, 0, w, h2).data; g.clearRect(0, 0, w, h2); g.drawImage(ib, 0, 0); const pb = g.getImageData(0, 0, w, h2).data; let m = 0; for (let k = 0; k < pa.length; k++) m = Math.max(m, Math.abs(pa[k] - pb[k])); resolve(m); }; ia.onload = ib.onload = done; ia.src = a; ib.src = b; });
    const sources: Array<[string, string]> = [['R', 'a 2D object'], ['X', 'a whole model'], ['X__title', "another model's labels"]];
    for (const [from, label] of sources) {
      const cross = api.createDeck({ withTitleSlide: false }); cross.stage = deck.stage; cross.assets = deck.assets;
      const c = api.addSlide(cross), labels = from === 'X__title';
      c.elements = [structuredClone(element), { id: 'R', type: 'rect', x: 20, y: 300, width: 160, height: 110, rotation: 0, opacity: 1, fill: '#d14d41', stroke: 'none', strokeWidth: 0, cornerRadius: 0 },
        { ...structuredClone(element), id: 'X', x: 480, y: 250, width: 220, height: 180, overrides: {} }];
      api.addBeat(cross, c.id).tracks.push({ id: 'into-mesh', target: labels ? 'X' : from, ...(labels ? { part: 'title' } : {}), preset: 'transform', duration: 1000, easing: 'linear', to: { become: { mode: 'handoff', ref: { element: 'M', parts: ['cortex.left'] } } } });
      player = api.createPlayer(stage, cross, { theme: api.FLUX_LIGHT, model3d: host, modelManifest: () => fixture.manifest, modelAsset: () => fixture.asset });
      await player.readyMedia();
      ok(!player.state().issues.some((issue: { trackId?: string }) => issue.trackId === 'into-mesh'), `${label} → mesh part: the Become is admitted`);
      const canvases = stage.querySelectorAll('canvas').length, contexts = host.stats().contexts;
      const sourceNode = () => labels ? stage.querySelector<SVGElement>('[id="X__title"]')! : stage.querySelector<HTMLElement>(`[data-el-id="${from}"] .sl-effects`) ?? stage.querySelector<HTMLElement>(`[data-el-id="${from}"]`)!;
      const frames: Record<number, string> = {};
      for (const ms of [0, 250, 500, 750, 999, 1000, 250, 500]) {
        player.seek(0, 1, ms); await player.captureMedia([], ms);
        const f = ms / 1000, node = sourceNode(), style = getComputedStyle(node), shown = style.visibility !== 'hidden' ? Number(style.opacity) : 0;
        ok(meshFrame(f), `${label} → mesh part ${ms}ms: the mesh part renders at ${f} of its own appearance`);
        ok(Math.abs(shown - (1 - f)) < 1e-6, `${label} → mesh part ${ms}ms: the source shows at ${1 - f} (saw ${shown})`);
        const now = stage.querySelector<HTMLCanvasElement>('canvas[data-slide-model3d="M"]')!.toDataURL();
        if (frames[ms]) ok(frames[ms] === now, `${label} → mesh part: reverse/random seek to ${ms}ms restores exact pixels`); frames[ms] = now;
      }
      ok(await maxDiff(frames[999], frames[1000]) <= 2, `${label} → mesh part: the landing frame continues the crossfade (no pop at raw = 1)`);
      ok(!stage.querySelector('.sl-handoff') && !stage.querySelector('image[data-model-snapshot]') && stage.querySelectorAll('canvas').length === canvases && host.stats().contexts === contexts, `${label} → mesh part: no flight layer, snapshot or extra backing store`);
      // Present plays the cue to its landing on the same sampler.
      player.goTo(0, 0); player.next();
      for (let i = 0; i < 400 && player.state().playing; i++) await new Promise(r => setTimeout(r, 10));
      await player.captureMedia([], 1000);
      ok(player.state().beat === 1 && meshFrame(1) && getComputedStyle(sourceNode()).opacity === '0', `${label} → mesh part: Present lands on the destination's own render with the source gone`);
      player.destroy();
      ok(!stage.querySelector('canvas'), `${label} → mesh part: destroying the player releases every canvas`);
    }
    { // Video capture samples a with-prev run on one clock: the crossfade and a concurrent part fade.
      const run = api.createDeck({ withTitleSlide: false }); run.stage = deck.stage; run.assets = deck.assets;
      const c = api.addSlide(run); c.elements = [structuredClone(element), { id: 'R', type: 'rect', x: 20, y: 300, width: 160, height: 110, rotation: 0, opacity: 1, fill: '#d14d41', stroke: 'none', strokeWidth: 0, cornerRadius: 0 }];
      api.addBeat(run, c.id).tracks.push({ id: 'right-out', target: 'M', part: 'cortex.right', preset: 'fadeOut', duration: 1000, easing: 'linear' });
      api.addBeat(run, c.id, { advance: 'with-prev' }).tracks.push({ id: 'into-mesh', target: 'R', preset: 'transform', duration: 1000, easing: 'linear', to: { become: { mode: 'handoff', ref: { element: 'M', parts: ['cortex.left'] } } } });
      player = api.createPlayer(stage, run, { theme: api.FLUX_LIGHT, model3d: host, modelManifest: () => fixture.manifest, modelAsset: () => fixture.asset });
      await player.readyMedia(); player.seek(0, 2, 500, 1); await player.captureMedia([], 500);
      const canvas2 = stage.querySelector<HTMLCanvasElement>('canvas[data-slide-model3d="M"]')!;
      view.render({ ...element, x: 0, y: 0, overrides: { 'cortex.left': { opacity: .3 }, 'cortex.right': { opacity: .5 } } }, canvas2.width, canvas2.height, { manifest: fixture.manifest });
      ok(canvas2.toDataURL() === reference.toDataURL(), 'video-cue seek samples the crossfade and its with-prev part fade at the same time');
      // Stills name the crossfade's step appearance.
      const requests: any[] = [], still = document.createElement('div'); document.body.append(still);
      const modelPoster = (_el: unknown, partOpacity?: Record<string, number>) => { requests.push(partOpacity); return 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg"/>'); };
      for (const [beat, left] of [[0, 0], [2, 1]] as const) {
        requests.length = 0; api.renderStaticAt(still, c, run.stage, beat, { theme: api.FLUX_LIGHT, modelManifest: () => fixture.manifest, modelAsset: () => fixture.asset, modelPoster });
        ok((requests.at(-1)?.['cortex.left'] ?? 1) === left, `step ${beat} still of the crossfade requests the mesh part at ${left}`);
      }
      still.remove();
    }
    (window as any).__partsDispose = () => { player.destroy(); view.dispose(); host.dispose(); };
    return { checks };
  }, fixture);
  await page.screenshot({ path: path.join(out, 'mesh-and-furniture.png') });
  await page.evaluate(() => (window as any).__partsDispose());
  for (const [pass, name] of result.checks) h.ok(pass, name);
  await writeFile(path.join(out, 'receipt.json'), JSON.stringify(result, null, 2));
  h.eq(errors(page), [], 'browser console is clean');
} finally { await browser.close(); }
await h.done();
