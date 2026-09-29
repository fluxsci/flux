/** Canonical demo must remain loadable, source-bound and safe to regenerate. */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { harness } from './lib/harness.mjs';
import { isolatedEnv } from './lib/verifyRuntime.mjs';
import { createModel3dDemo, emptyScratchDestination, demoSourceRevision, DEMO_STEMS, DEMO_INPUTS } from './lib/model3dDemo';
const h = harness('verify-model3d-demo'), scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-model3d-demo-gate-'));
Object.assign(process.env, isolatedEnv(path.join(scratch, 'machine')), { FLUX_NO_MIGRATE: '1', XDG_DATA_HOME: path.join(scratch, 'machine/data'), FLUX_MODEL3D_DISABLE: '1' });
const root = path.join(scratch, 'project');
let childRoot: string | undefined;
try {
  const sourceRepo = path.join(scratch, 'source-repo'); await fs.mkdir(sourceRepo);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: sourceRepo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '--initial-branch=scene3d-slides');
  git('-c', 'user.name=Flux verification', '-c', 'user.email=flux@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '--allow-empty', '-m', 'Scratch provenance checkpoint');
  const sourceCommit = git('rev-parse', 'HEAD');
  h.eq(demoSourceRevision(sourceRepo), { fluxplotBranch: 'scene3d-slides', fluxplotCommit: sourceCommit }, 'live demo provenance records the actual source branch and exact commit');
  git('branch', '-m', 'review-source');
  h.eq(demoSourceRevision(sourceRepo), { fluxplotBranch: 'review-source', fluxplotCommit: sourceCommit }, 'provenance follows a renamed source branch without a hardcoded scene3d label');
  git('checkout', '--detach', sourceCommit);
  h.eq(demoSourceRevision(sourceRepo), { fluxplotBranch: 'detached HEAD', fluxplotCommit: sourceCommit }, 'detached source provenance remains explicit and commit-pinned');
  const receipt = await createModel3dDemo(root);
  const { loadFigModel } = await import('../flux-core/model'), { readModel3dMetadata } = await import('../flux-core/model3d');
  const { validateModel } = await import('../flux-core/validate'), { inspectGlb } = await import('../src/lib/model3d/glbCore.mjs');
  const { morphCompatible } = await import('../src/lib/model3d/morphPair'), { modelFrame } = await import('../src/lib/model3d/semanticOps');
  const saved = (await loadFigModel(root)).project;
  h.eq(validateModel(saved), [], 'canonical saved demo passes model validation');
  h.eq([saved.figures.length, saved.assets.length], [3, 6], 'three review figures contain exactly six GLB assets');
  const models = saved.figures.flatMap(f => f.elements).filter(e => e.type === 'model3d');
  h.eq(models.length, 6, 'all demo placements are first-class model3d elements');
  const inputs = JSON.parse(await fs.readFile(path.join(DEMO_INPUTS, 'SHA256SUMS.json'), 'utf8')) as Record<string,string>;
  for (const [name, hash] of Object.entries(inputs)) assert.equal(createHash('sha256').update(await fs.readFile(path.join(root, 'plots', name))).digest('hex'), hash);
  h.ok(true, 'every frozen public-example input and copied source script matches its receipt');
  const infos = new Map<string, ReturnType<typeof inspectGlb>>();
  for (const stem of DEMO_STEMS) {
    const model = models.find(e => e.id === receipt.models[stem].elementId)!, asset = saved.assets.find(a => a.id === model.assetId)!;
    assert.equal(asset.kind, 'glb'); const bytes = await fs.readFile(path.join(root, 'fig', asset.path)), info = inspectGlb(bytes); infos.set(stem, info);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), asset.sha256);
    assert.equal(model.source?.sha256, createHash('sha256').update(await fs.readFile(path.join(root, 'plots', `${stem}.glb`))).digest('hex'));
    assert.equal(model.source?.glbPath, `plots/${stem}.glb`);
    const metadata = await readModel3dMetadata(root, saved, asset.id); assert.ok(metadata.manifest); assert.equal(metadata.issues?.length ?? 0, 0);
    assert.equal(await fs.readFile(path.join(root, 'fig/assets', `${asset.id}.fluxplot.json`), 'utf8'), await fs.readFile(path.join(root, 'plots', `${stem}.fluxplot.json`), 'utf8'));
    const recipe = JSON.parse(await fs.readFile(path.join(root, 'plots', `${stem}.recipe.json`), 'utf8')); assert.equal(recipe.outputs.glb, `${stem}.glb`);
  }
  h.ok(true, 'all meshes reopen with accepted source-bound metadata, exact bytes, provenance and valid recipe outputs');
  h.eq(infos.get('neuron')!.partNames, ['neuron.soma','neuron.axon','neuron.dendrites'], 'neuron contains meaningful named soma, axon and dendrite meshes');
  h.eq(infos.get('cortex-states')!.states, ['inflated','bent'], 'cortex provides both editable shape states');
  const state = models.find(e => e.id === receipt.models['cortex-states'].elementId)!;
  h.eq(state.modelStates, { inflated: .35 }, 'shape-state demo starts from a visible intermediate shape');
  const sequence = models.find(e => e.id === receipt.models['cell-sequence'].elementId)!;
  h.eq(modelFrame(sequence.modelStates, infos.get('cell-sequence')!.states), 2.5, 'sequence reopens at derived Frame 2.5');
  h.ok(morphCompatible(infos.get('cortex-pial')!, infos.get('cortex-inflated')!).ok, 'cortex pair has actual matching topology');
  h.eq(models.find(e => e.id === receipt.models['continuous-field'].elementId)!.fields?.['height.field'], {cmap:'viridis',range:[-1,1]}, 'continuous field has an editable saved map and range');
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'project.json'), 'utf8'));
  h.ok(manifest.slides.some((d:any)=>d.id===receipt.deck.deckId),'review deck is registered in the canonical project');
  const {loadDeck,compileDeckSlide}=await import('../flux-core/slides');const deck=await loadDeck(root,receipt.deck.deckId);
  h.eq(deck.slides.map(s=>s.name),['Turntable','Shape change','Ghost','Crossfade Become','Vertex morph'],'five focused motion examples reopen in order');
  const {compileSlide}=await import('../src/lib/slide/compile');
  const {resolveCurve}=await import('../src/lib/slide/curves');
  const turn=deck.slides[0].beats[1].tracks[0];
  h.ok(turn.easing==='linear'&&turn.duration===8000&&resolveCurve(turn).fn(.5)===.5,'review Turntable is a real linear eight-second Change');
  const neuronId=receipt.deck.examples.Turntable.modelIds[0],turntable=await compileDeckSlide(root,deck,deck.slides[0].id);
  h.eq(deck.slides[0].beats[2].id,receipt.deck.examples.Turntable.appearanceBeatId,'Turntable receipt identifies the separate next-step dendrite appearance');
  h.eq(deck.slides[0].beats[2].tracks.map(t=>[t.target,t.part,t.preset,t.duration]),[[neuronId,'neuron.dendrites','fade',1200]],'dendrite step uses one public semantic appearance track');
  h.eq(turntable.sample(0).partStates[neuronId],{'neuron.dendrites':{opacity:0,visible:false}},'Design stashes only dendrites; soma and axon receive no hidden state');
  const designNeuron=turntable.sample(0).elements.find(e=>e.id===neuronId)!;
  h.ok(designNeuron.type==='model3d'&&!designNeuron.hidden&&(designNeuron.opacity??1)===1,'Design keeps the neuron placement visible');
  h.eq(turntable.sample(1).partStates[neuronId]['neuron.dendrites'],{opacity:0,visible:false},'dendrites stay stashed throughout the preceding Turntable');
  h.eq(turntable.sample(2,600).partStates[neuronId]['neuron.dendrites'],{opacity:.5,visible:true},'dendrite step fades actual named dendrites at half opacity');
  h.eq(turntable.sample(2).partStates[neuronId]['neuron.dendrites'],{opacity:1,visible:true},'dendrite step settles the dendrite part fully visible');
  h.ok(!turntable.issues.length,'saved-source metadata resolves the dendrite target without diagnostics');
  h.eq(deck.slides[1].beats[1].tracks[0].to?.state?.modelStates,{inflated:1,bent:.25},'shape example authors named weights');
  h.eq(deck.slides[2].beats[1].tracks.filter(t=>t.ghostFrom).length,2,'ghost example has two independent births');
  for(const slide of deck.slides.slice(3))h.ok(slide.beats[1].tracks.some(t=>t.to?.become?.mode==='handoff'),'Become example records a live hand-off');
  for(const slide of deck.slides) {
    const compiled=compileSlide(slide,deck.stage,{modelAsset:id=>deck.assets.find(a=>a.id===id&&a.kind==='glb') as any});
    h.ok(!compiled.issues.some(i=>/missing|unsupported|not found/i.test(i.reason)),`review slide ${slide.name} compiles without missing targets/assets`);
  }
  for(const asset of deck.assets)if(asset.kind==='glb')assert.equal(createHash('sha256').update(await fs.readFile(path.join(root,'slides',deck.id,asset.path))).digest('hex'),asset.sha256);
  h.ok(true,'every slide-owned model reopens with matching immutable bytes');
  const {parseSlideEmbed}=await import('../src/lib/slide/embed');
  const paperEmbed=parseSlideEmbed(receipt.deck.embed)!;
  h.ok(paperEmbed?.deck===deck.id&&paperEmbed.slide===deck.slides[0].id&&(await fs.readFile(path.join(root,'paper/notes.qmd'),'utf8')).includes(receipt.deck.embed),'Paper embed binds the saved Turntable deck and slide');
  const cross=compileSlide(deck.slides[3],deck.stage,{assets:deck.assets}),morph=compileSlide(deck.slides[4],deck.stage,{assets:deck.assets});
  h.ok(cross.issues.some(i=>i.reason.includes('3D models crossfade:'))&&!morph.issues.some(i=>i.reason.includes('3D models crossfade:')),'actual topology compiles Crossfade Become as fallback and Vertex morph as compatible');
  h.ok((await fs.readFile(path.join(root, 'paper/notes.qmd'), 'utf8')).includes('@fig-model3d-overview'), 'Paper source references the saved model overview');
  const before = await fs.readFile(path.join(root, 'project.json'));
  await assert.rejects(createModel3dDemo(root), /not empty/); h.eq(await fs.readFile(path.join(root, 'project.json')), before, 'regeneration refuses an existing populated project without changing it');
  await assert.rejects(emptyScratchDestination(process.cwd()), /temporary/); h.ok(true, 'generator rejects a non-scratch destination before writing');
  const alias = path.join(scratch,'alias'); await fs.symlink(root,alias,'dir'); await assert.rejects(emptyScratchDestination(alias), /real scratch/); h.ok(true,'generator rejects a symlink destination');
  const rename = fs.rename;
  for (const mode of ['target', 'parent', 'occupied'] as const) {
    const parent = path.join(scratch, `race-${mode}`), destination = path.join(parent, 'project'), outside = path.join(scratch, `outside-${mode}`);
    await fs.mkdir(parent); await fs.mkdir(outside);
    if (mode !== 'parent') await fs.mkdir(destination);
    let swapped = false;
    fs.rename = async (from, to) => {
      if (!swapped && String(from).includes('flux-model3d-demo-stage-') && String(to).endsWith('/project')) {
        swapped = true;
        if (mode === 'target') { await rename(destination, destination + '-held'); await fs.symlink(outside, destination, 'dir'); }
        else if (mode === 'parent') { await rename(parent, parent + '-held'); await fs.symlink(outside, parent, 'dir'); }
        else await fs.writeFile(path.join(destination, 'keep.txt'), 'concurrent content');
      }
      return rename(from, to);
    };
    try { await assert.rejects(createModel3dDemo(destination)); } finally { fs.rename = rename; }
    assert.ok(swapped); assert.deepEqual(await fs.readdir(outside), []);
    if (mode === 'occupied') assert.equal(await fs.readFile(path.join(destination, 'keep.txt'), 'utf8'), 'concurrent content');
    if (mode === 'parent') assert.deepEqual(await fs.readdir(parent + '-held'), []);
    h.ok(true, `late ${mode} substitution refuses publication and leaves other scratch contents untouched`);
  }
  const originalWrite = fs.writeFile; let failedStage = '';
  fs.writeFile = async (file, ...args) => {
    if (String(file).includes('flux-model3d-demo-stage-') && String(file).endsWith('/project.json')) { failedStage = path.dirname(String(file)); throw new Error('Injected scaffold failure'); }
    return originalWrite(file, ...args);
  };
  try { await assert.rejects(createModel3dDemo(path.join(scratch, 'failed-project')), /Injected scaffold failure/); } finally { fs.writeFile = originalWrite; }
  assert.ok(failedStage); await assert.rejects(fs.stat(failedStage), { code: 'ENOENT' }); await assert.rejects(fs.stat(path.join(scratch, 'failed-project')), { code: 'ENOENT' });
  h.ok(true, 'failed build removes its owned staging tree and publishes no project');
  childRoot = await fs.mkdtemp(path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp', 'flux-model3d-demo-cli-'));
  await new Promise<void>((resolve,reject)=>{const child=spawn(process.execPath,['--import','tsx','scripts/create-model3d-demo.ts','--out',childRoot!],{cwd:process.cwd(),env:process.env,stdio:['ignore','pipe','pipe']});let error='';child.stderr.on('data',b=>error+=b);child.stdout.resume();child.once('error',reject);child.once('close',code=>code===0?resolve():reject(Error(error)));});
  const environment=JSON.parse(await fs.readFile(path.join(childRoot,'DEMO-ENV.json'),'utf8'));
  h.ok(path.isAbsolute(environment.HOME) && environment.HOME.startsWith(environment.environment + path.sep) && environment.XDG_DATA_HOME.startsWith(environment.environment + path.sep) && environment.FLUX_NO_MIGRATE==='1','public generator entry initializes private HOME/XDG and disables migration');
  await fs.rm(environment.environment,{recursive:true,force:true});
} catch(error) { h.fail(error instanceof Error ? error.stack ?? error.message : String(error)); }
finally { if (childRoot) await fs.rm(childRoot, {recursive:true,force:true}); await fs.rm(scratch,{recursive:true,force:true}); }
await h.done();
