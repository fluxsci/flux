import './lib/cssStub.mjs';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { promises as mutableFs } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { harness } from './lib/harness.mjs';
import { isolatedEnv } from './lib/verifyRuntime.mjs';
const h = harness('verify-model3d-verbs'), repo = path.resolve(import.meta.dirname, '..');
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-model3d-verbs-'));
Object.assign(process.env, isolatedEnv(path.join(scratch, 'machine')), { FLUX_MODEL3D_DISABLE: '1', FLUX_NO_MIGRATE: '1' });
const core = await import('../flux-core/index');
const {readModel3dMetadata}=await import('../flux-core/model3d');
const { loadFigModel } = await import('../flux-core/model');
const { parseCliFlags, VERBS } = await import('../flux-core/registry');
const { applyModelViewCommand, applyModelFieldCommand } = await import('../src/lib/model3d/commandOps');
const { posterKey, isModelPosterPrunable } = await import('../src/lib/model3d/poster');
const { boundedModelFile, publishModelFile } = await import('../flux-core/model3dFile');
const { shareRetry } = await import('../electron/fsRetry.cjs');
const root = path.join(scratch, 'project'), inputs = path.join(scratch, 'inputs');
await fs.mkdir(inputs); await core.scaffold(root, { title: 'Model agent fixture' });
const { figureId } = await core.createFigure(root, { id: 'model-figure', name: '3D commands' });
for (const name of ['continuous', 'states', 'sequence', 'morph-a', 'morph-b', 'morph-incompatible', 'named-parts']) for (const extension of ['glb', 'fluxplot.json']) await fs.copyFile(path.join(repo, `scripts/fixtures/model3d/fluxplot/${name}.${extension}`), path.join(inputs, `${name}.${extension}`));
const input = (name: string) => path.join(inputs, `${name}.glb`);
const run = (args: string[], entry = 'dist/flux-cli.mjs') => new Promise<{ code: number; out: string; err: string }>((resolve, reject) => {
  const child = spawn(process.execPath, [path.join(repo, entry), ...args], { cwd: inputs, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = ''; child.stdout.on('data', b => out += b); child.stderr.on('data', b => err += b); child.once('error', reject); child.once('close', code => resolve({ code: code ?? -1, out, err }));
});
async function cli(args: string[]) { const result = await run(args); assert.equal(result.code, 0, result.err); return result.out.trim() ? JSON.parse(result.out) : undefined; }
async function tree(dir: string): Promise<string[]> { const values: string[] = []; for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) { const file = path.join(dir, entry.name); if (entry.isDirectory()) values.push(...await tree(file)); else values.push(`${path.relative(scratch, file)}:${createHash('sha256').update(await fs.readFile(file)).digest('hex')}`); } return values.sort(); }
try {
  const built = await run([], 'scripts/build-cli.mjs'); assert.equal(built.code, 0, built.err);
  h.ok(true, 'production CLI builder succeeds; all following commands execute its plain Node bundle');
  const beforeInfo = await tree(scratch), info = await cli(['model-info', 'states.glb', '--morph-with', 'states.glb']);
  h.ok(info.ok && info.states.includes('inflated') && info.topology && info.morph.ok, 'built model-info reports named states, topology and compatible pair');
  h.eq(await tree(scratch), beforeInfo, 'file-scoped model-info does not write inputs, project or machine state');
  const badPair = await cli(['model-info', input('morph-a'), '--morph-with', input('morph-incompatible')]);
  h.ok(!badPair.morph.ok && badPair.morph.reason && badPair.morph.hint, 'incompatible pair reports actionable reason and Python preparation hint');
  const goodPair = await cli(['model-info', input('morph-a'), '--morph-with', input('morph-b')]); h.ok(goodPair.morph.ok, 'separate compatible GLBs agree through built CLI');
  await fs.writeFile(path.join(inputs, 'invalid.glb'), 'invalid');
  h.ok(!(await cli(['model-info', 'invalid.glb'])).ok, 'malformed GLB returns an explicit inspection refusal');
  const mcp = VERBS.find(v => v.name === 'model_info')!;
  h.ok(mcp.scope === 'file' && mcp.readOnly && mcp.pathParams?.morphWith === 'path', 'MCP info is file/readOnly with both paths declared');
  const parsed = parseCliFlags('set-model-view', ['target', '--state', 'inflated=-.2', '--state=bent=1.2']);
  const viewVerb = VERBS.find(v => v.name === 'set_model_view')!;
  h.eq(Object.entries(viewVerb.params.states.parse(JSON.parse('{"__proto__":0.5,"constructor":-0.2}'))),[['__proto__',.5],['constructor',-.2]],'typed MCP/CLI state schema preserves inherited-name shape IDs as own properties');
  h.eq(parsed.flags.state, ['inflated=-.2','bent=1.2'], 'only declared repeated state values are collected by the flag parser');
  for (const values of [['--zoom','1','--zoom','2'], ['--unknown','x']]) assert.throws(() => parseCliFlags('set-model-view', values));
  for (const values of [['--state','x='], ['--state','x=NaN'], ['--state','x=1','--state','x=2']]) { const result=await run(['set-model-view','target',...values,'--root',root]); assert.notEqual(result.code,0); assert.match(result.err,/name=finite-number|Repeated shape state/); }
  h.ok(true, 'duplicate ordinary flags, unknown flags, missing/nonfinite/repeated state values refuse');
  const add = await cli(['add-model', figureId, 'states.glb', '--root', root, '--name', 'States', '--width', '280', '--view', '{"azimuth":47}']);
  h.ok(add.elementId && add.assetId && add.parts && add.warnings.some((w: string) => w.includes('disabled')), 'built add-model persists useful model and localized disabled-poster warning');
  let loaded = await loadFigModel(root), model = loaded.project.figures.find(f => f.id === figureId)!.elements.find(e => e.id === add.elementId) as import('../src/lib/model3d/types').Model3dElement;
  const asset = loaded.project.assets.find(a => a.id === add.assetId)!;
  h.ok(asset.kind === 'glb' && asset.model && model.width === 280 && model.orbitAzimuth === 47 && model.source?.sha256 === info.sha256, 'import records metadata, physical box, requested view and original-byte receipt');
  h.eq(await fs.readFile(path.join(root, `fig/assets/${asset.id}.fluxplot.json`), 'utf8'), await fs.readFile(path.join(inputs, 'states.fluxplot.json'), 'utf8'), 'source sidecar bytes persist unchanged');
  const snapshot = JSON.stringify(loaded.project), preparedFile = path.join(root, 'fig', asset.path);
  const publicationRoot=path.join(scratch,'publication-race'),outside=path.join(scratch,'outside-publication');await core.scaffold(publicationRoot,{title:'Publication race'});const publicationFigure=await core.createFigure(publicationRoot,{id:'publication'});await fs.mkdir(outside);
  const assetDirectory=path.join(publicationRoot,'fig/assets');await fs.mkdir(assetDirectory,{recursive:true});
  const publicationOpen=mutableFs.open;let substituted=false;mutableFs.open=async(...args)=>{if(!substituted&&String(args[0]).startsWith(assetDirectory+path.sep)&&String(args[0]).includes('.glb.tmp-')){substituted=true;await fs.rename(assetDirectory,assetDirectory+'-held');await fs.symlink(outside,assetDirectory,'dir');}return publicationOpen(...args);};syncBuiltinESMExports();
  try{await assert.rejects(core.addModel(publicationRoot,publicationFigure.figureId,input('states'),{noPoster:true}),/escapes|changed/);}finally{mutableFs.open=publicationOpen;syncBuiltinESMExports();}
  h.ok(substituted&&(await fs.readdir(outside)).length===0,'public add-model refuses substituted output directory before mesh bytes or file publication escape');
  await fs.unlink(assetDirectory);await fs.rename(assetDirectory+'-held',assetDirectory);
  const cacheDirectory=path.join(publicationRoot,'fig/renders/model3d');await fs.mkdir(cacheDirectory,{recursive:true});substituted=false;
  mutableFs.open=async(...args)=>{if(!substituted&&String(args[0]).startsWith(cacheDirectory+path.sep)){substituted=true;await fs.rename(cacheDirectory,cacheDirectory+'-held');await fs.symlink(outside,cacheDirectory,'dir');}return publicationOpen(...args);};syncBuiltinESMExports();
  try{await assert.rejects(publishModelFile(publicationRoot,path.join(cacheDirectory,'m3d-0123456789abcd.png'),Buffer.from('poster')),/escapes|changed/);}finally{mutableFs.open=publicationOpen;syncBuiltinESMExports();}
  h.ok(substituted&&(await fs.readdir(outside)).length===0,'project poster publication shares opened-file confinement and removes its exclusive temporary inode');
  await fs.unlink(cacheDirectory);await fs.rename(cacheDirectory+'-held',cacheDirectory);
  const collision=path.join(assetDirectory,'existing.glb');await fs.writeFile(collision,'original');await assert.rejects(publishModelFile(publicationRoot,collision,Buffer.from('replacement'),true),/EEXIST/);h.eq(await fs.readFile(collision,'utf8'),'original','confined create-only publisher preserves existing immutable assets');
  const rendersDirectory=path.join(publicationRoot,'fig/renders');await fs.rename(rendersDirectory,rendersDirectory+'-held');await fs.symlink(outside,rendersDirectory,'dir');
  await assert.rejects(publishModelFile(publicationRoot,path.join(rendersDirectory,'new-cache','m3d-0123456789abcd.png'),Buffer.from('poster')),/escapes/);
  h.eq(await fs.readdir(outside),[],'guarded project publication creates no directories below an escaped existing ancestor');await fs.unlink(rendersDirectory);await fs.rename(rendersDirectory+'-held',rendersDirectory);
  const originalUnlink=mutableFs.unlink;let replacedTemporary='';mutableFs.unlink=async(...args)=>{const file=String(args[0]);if(!replacedTemporary&&file.startsWith(assetDirectory+path.sep)&&file.includes('.tmp-')){replacedTemporary=file;await originalUnlink(...args);await fs.writeFile(file,'replacement inode');throw Object.assign(new Error('injected Windows sharing failure'),{code:'EBUSY'});}return originalUnlink(...args);};syncBuiltinESMExports();
  const cleanupDestination=path.join(assetDirectory,'cleanup.glb');try{await publishModelFile(publicationRoot,cleanupDestination,Buffer.from('owned bytes'),true,operation=>shareRetry(operation,100));}finally{mutableFs.unlink=originalUnlink;syncBuiltinESMExports();}
  h.ok(replacedTemporary&&await fs.readFile(replacedTemporary,'utf8')==='replacement inode'&&await fs.readFile(cleanupDestination,'utf8')==='owned bytes','cleanup retry rechecks inode and never removes a substituted temporary file');await fs.unlink(replacedTemporary);


  const failedRoot=path.join(scratch,'failed-import');await core.scaffold(failedRoot,{title:'Interrupted import'});const failedFigure=await core.createFigure(failedRoot,{id:'failure',name:'Failure'});
  const originalLink=mutableFs.link,originalRename=mutableFs.rename;let linked=false;
  mutableFs.link=async(...args)=>{await originalLink(...args);if(String(args[1]).startsWith(failedRoot)&&String(args[1]).endsWith('.glb'))linked=true;};
  mutableFs.rename=async(...args)=>{if(linked&&String(args[1]).startsWith(failedRoot)){linked=false;throw Object.assign(new Error('injected post-GLB publication failure'),{code:'EIO'});}await originalRename(...args);};syncBuiltinESMExports();
  try{await assert.rejects(core.addModel(failedRoot,failedFigure.figureId,input('states'),{noPoster:true}),/Stored GLB retained.*Reload the figure before retrying/);}finally{mutableFs.link=originalLink;mutableFs.rename=originalRename;syncBuiltinESMExports();}
  const orphanNames=(await fs.readdir(path.join(failedRoot,'fig/assets'))).filter(name=>name.endsWith('.glb'));
  h.eq(orphanNames.length,1,'uncertain metadata failure retains immutable GLB and reports an actionable reload hint');
  h.eq((await loadFigModel(failedRoot)).project.figures.flatMap(f=>f.elements).length,0,'pre-generation fault leaves no half-imported model reference');
  const retried=await core.addModel(failedRoot,failedFigure.figureId,input('states'),{noPoster:true});h.ok(retried.elementId&&(await loadFigModel(failedRoot)).project.figures.flatMap(f=>f.elements).length===1,'retry after recovery adds exactly one model and preserves the old orphan');
  const originalAppend=mutableFs.appendFile;mutableFs.appendFile=async(...args)=>{if(String(args[0]).startsWith(failedRoot)&&String(args[1]).includes('render_model_posters'))throw new Error('injected derived job completion failure');await originalAppend(...args);};syncBuiltinESMExports();
  let posterFailure:Awaited<ReturnType<typeof core.setModelViewCommand>>;try{posterFailure=await core.setModelViewCommand(failedRoot,{target:retried.elementId},{azimuth:123});}finally{mutableFs.appendFile=originalAppend;syncBuiltinESMExports();}
  h.ok(posterFailure.element.orbitAzimuth===123&&posterFailure.warnings.some(w=>w.startsWith('Model saved; poster could not be rendered:')),'post-commit poster failure preserves success and emits the exact localized warning');

  await assert.rejects(core.addModel(root, figureId, input('states'), { view: { states: { missing: 1 } } }), /Unknown shape/);
  h.eq(JSON.stringify((await loadFigModel(root)).project), snapshot, 'invalid import view never publishes project metadata');
  const result = await cli(['set-model-view', model.id, '--root', root, '--preset', 'front', '--azimuth', '15', '--state', 'inflated=-.2', '--state', 'bent=1.2']);
  h.eq(result.element.modelStates, { inflated: -.2, bent: 1.2 }, 'built view command stores extrapolated weights without clamping');
  h.eq(result.element.orbitAzimuth, 15, 'explicit camera property wins over preset');
  const reset = await cli(['set-model-view', model.id, '--root', root, '--preset', 'home']);
  h.eq(reset.element.modelStates, { inflated: .25 }, 'Home restores accepted original defaults');
  await assert.rejects(core.setModelViewCommand(root, { target: model.id, deckId: 'deck' }, { zoom: 2 }), /Slides/);
  await assert.rejects(core.setModelViewCommand(root, { target: model.id, figureId: 'wrong' }, { zoom: 2 }), /not in figure/);
  h.ok(true, 'file target selector refuses wrong figure and deferred Slides targets');
  const seq = await cli(['add-model', figureId, 'sequence.glb', '--root', root, '--no-poster']);
  h.ok(seq.poster===null && !seq.warnings.some((w:string)=>w.includes('disabled')), 'explicit no-poster import skips derived rendering without a failure warning');
  const frame = await cli(['set-model-view', seq.elementId, '--root', root, '--frame', '1.5']);
  h.ok(Object.values(frame.element.modelStates).every(v => v === .5) && Object.keys(frame.element.modelStates).length === 2 && !('frame' in frame.element), 'Frame persists only adjacent shape weights');
  const field = await cli(['add-model', figureId, 'continuous.glb', '--root', root]);
  await cli(['restyle-part', figureId, 'height.field', '--root', root, '--element', field.elementId, '--fill', '#123456']);
  const mapped = await cli(['set-model-field', field.elementId, 'height.field', '--root', root, '--cmap', 'viridis', '--min', '2', '--max', '2']);
  h.eq(mapped.element.fields['height.field'], { cmap: 'viridis', range: [2,2] }, 'built field command accepts named LUT and constant range');
  h.ok(mapped.element.modelColors === 'source' && mapped.element.overrides['height.field'].fill === '#123456', 'field command activates source mode and preserves explicit fill');
  const beforeInvalid = JSON.stringify((await loadFigModel(root)).project);
  for (const args of [['set-model-field', field.elementId, 'height.field', '--min','3','--max','2'], ['set-model-view', model.id, '--frame','1','--state','inflated=.5'], ['set-model-view', model.id, '--state','ghost=1'], ['restyle', figureId, 'typo', '--element', field.elementId, '--fill','#f00']]) h.ok((await run([...args, '--root',root])).code !== 0, 'invalid built command returns failure: ' + args[0]);
  h.eq(JSON.stringify((await loadFigModel(root)).project), beforeInvalid, 'invalid built commands leave figure bytes semantically unchanged');
  const resetField = await cli(['set-model-field', field.elementId, 'height.field', '--root', root, '--reset']); h.ok(!resetField.element.fields, 'reset removes the field override');
  // P2: a const switch never turns an explicit false into true.
  const partHidden = async () => ((await loadFigModel(root)).project.figures.flatMap(f => f.elements).find(e => e.id === field.elementId) as typeof model).overrides?.['height.field']?.hidden;
  await cli(['restyle-part', figureId, 'height.field', '--root', root, '--element', field.elementId, '--hidden']); h.eq(await partHidden(), true, 'bare --hidden hides the part');
  await cli(['restyle-part', figureId, 'height.field', '--root', root, '--element', field.elementId, '--hidden', 'false']); h.eq(await partHidden(), false, '--hidden false shows the part instead of hiding it');
  await cli(['restyle-part', figureId, 'height.field', '--root', root, '--element', field.elementId, '--hidden']); await cli(['restyle-part', figureId, 'height.field', '--root', root, '--element', field.elementId, '--show']); h.eq(await partHidden(), false, '--show is the documented unhide path');
  const switchValue = await run(['restyle-part', figureId, 'height.field', '--root', root, '--element', field.elementId, '--italic=false']);
  h.ok(switchValue.code !== 0 && /--italic is a switch.*--no-italic/.test(switchValue.err), 'a non-boolean switch refuses an explicit value and names its opposite');
  const contradictory = await run(['restyle-part', figureId, 'height.field', '--root', root, '--element', field.elementId, '--hidden', '--show']); h.ok(contradictory.code !== 0, '--hidden with --show is contradictory');
  // P5: no always-failing slide selectors are advertised before the Slides phase.
  for (const name of ['set_model_view', 'set_model_field', 'render_model_posters']) { const params = VERBS.find(v => v.name === name)!.params; h.ok(!('deckId' in params) && !('slideId' in params), `${name} advertises no deck/slide parameters`); }
  const {withLock}=await import('../flux-core/locks');
  await withLock(root,'project','gate-owned-document',async()=>{const cache=await core.renderModelPosters(root,{figureId});h.ok(cache.posters.length===3,'derived poster operation does not acquire a document writer lease');});
  const journalBeforeCancel=await fs.readFile(path.join(root,'.meta/journal.ndjson'),'utf8'),cancelled=new AbortController();cancelled.abort();
  await assert.rejects(core.renderModelPosters(root,{signal:cancelled.signal}));
  h.eq(await fs.readFile(path.join(root,'.meta/journal.ndjson'),'utf8'),journalBeforeCancel,'cancelled poster operation journals no completed render/prune');
  const posters = await cli(['render-model-posters', '--root',root,'--figure',figureId,'--prune']);
  h.ok(posters.posters.length === 3 && posters.posters.every((p: {ready:boolean}) => !p.ready) && posters.warnings.length, 'explicit poster verb reports unavailable native rendering, without bogus success paths');
  const dir = path.join(root, 'fig/renders/model3d'); await fs.mkdir(dir, {recursive:true});
  const old = 'm3d-ffffffffffffff.png', recent = 'm3d-eeeeeeeeeeeeee.png';
  await fs.writeFile(path.join(dir,old),'old'); await fs.writeFile(path.join(dir,recent),'new'); const ago = new Date(Date.now()-15*86400000); await fs.utimes(path.join(dir,old),ago,ago);
  const pruned = await cli(['render-model-posters','--root',root,'--prune']); h.eq(pruned.removed,[old],'prune removes only old unreferenced correctly named posters');
  h.ok(!isModelPosterPrunable(old,ago.getTime(),new Set(['m3d-ffffffffffffff'])) && !isModelPosterPrunable('../'+old,ago.getTime(),new Set()), 'shared prune policy protects live keys and arbitrary files');
  const raceProject=(await loadFigModel(root)).project,raceElement=raceProject.figures.flatMap(f=>f.elements).find(e=>e.id===model.id) as typeof model,raceAsset=raceProject.assets.find(a=>a.id===raceElement.assetId)!;
  const raceMetadata=await readModel3dMetadata(root,raceProject,raceAsset.id),{staticModelRequest}=await import('../src/lib/model3d/static');
  const raceRequest=staticModelRequest({...raceElement,orbitAzimuth:333},raceAsset as import('../src/lib/model3d/types').Model3dAsset,raceMetadata.manifest,'figure')!;
  const newlyReferenced=path.join(dir,`${raceRequest.key}.png`);await fs.writeFile(newlyReferenced,'old cache becoming live');await fs.utimes(newlyReferenced,ago,ago);
  const originalOpen=mutableFs.open;let savedDuringRender=false;mutableFs.open=async(...args)=>{if(!savedDuringRender&&String(args[0])===path.join(root,`fig/assets/${raceAsset.id}.fluxplot.json`)){savedDuringRender=true;await core.setModelViewCommand(root,{target:model.id,noPoster:true},{azimuth:333});}return originalOpen(...args);};syncBuiltinESMExports();
  let raced:Awaited<ReturnType<typeof core.renderModelPosters>>;try{raced=await core.renderModelPosters(root,{figureId,prune:true});}finally{mutableFs.open=originalOpen;syncBuiltinESMExports();}
  h.ok(savedDuringRender&&!raced.removed.includes(path.basename(newlyReferenced))&&await fs.readFile(newlyReferenced,'utf8')==='old cache becoming live','prune refreshes saved references after render and protects a newly referenced old key');

  const journal = await fs.readFile(path.join(root,'.meta/journal.ndjson'),'utf8'); h.ok(!journal.includes((await fs.readFile(preparedFile)).toString('base64')), 'journal contains no GLB bytes');
  loaded = await loadFigModel(root); model = loaded.project.figures.find(f=>f.id===figureId)!.elements.find(e=>e.id===add.elementId) as typeof model;
  const plain = structuredClone(loaded.project), before = JSON.stringify(plain);
  assert.throws(()=>applyModelViewCommand(plain,[model.id,field.elementId],{states:{inflated:.5}}),/Unknown shape/);
  assert.throws(()=>applyModelFieldCommand(plain,[field.elementId,model.id],{field:'height.field',min:0},{}),/Unknown value field/);
  h.eq(JSON.stringify(plain),before,'shared command preflight makes multi-target failure atomic');
  const stat = await fs.stat(preparedFile); await assert.rejects(boundedModelFile(preparedFile,stat.size-1),/exceeds/); h.ok(true,'shared bounded reader refuses actual opened-file size before allocation');
  // Connect collection is deliberately cold. Actual Connect regression remains
  // in its existing gate; this pins a GLB fixture on the shared image policy.
  const { resolveModelPosters } = await import('../flux-core/model3dPosterCache');
  const beforeCollect = await tree(scratch); const cold = await resolveModelPosters(root,loaded.project.figures,loaded.project.assets,{policy:'collect',renderBatch:async()=>{throw Error('collector rendered');}});
  h.ok(cold.requests.length === 3 && cold.warnings.length && !Object.keys(cold.urls).length,'cold overview supplies named model placeholders');
  h.eq(await tree(scratch),beforeCollect,'cold 3D collector writes neither project nor machine cache');
  const { connect } = await import('../flux-core/connect/index');
  const { detectAgentIdentity } = await import('../flux-core/agentIdentity');
  const { machineModelPosterDir } = await import('../flux-core/model3dPosterCache');
  const beforeConnectProject = await tree(root), beforeModelCache = await tree(machineModelPosterDir());
  const glbs=loaded.project.assets.filter(a=>a.kind==='glb').map(a=>path.join(root,'fig',a.path));
  // Deny byte reads while leaving metadata/stat available. The same process
  // first proves denial, then Connect must still produce its overview images.
  for(const file of glbs) await fs.chmod(file,0);
  try {
    await assert.rejects(fs.readFile(glbs[0]), /EACCES/);
    const pack=await connect({target:root,identity:detectAgentIdentity({})});
    h.ok(pack.images.length>0 && pack.problems.some(w=>w.includes('poster not rendered')) && !pack.problems.some(w=>/EACCES|Missing GLB/.test(w)), 'actual Connect renders named placeholders while GLB byte access is denied');
  } finally {for(const file of glbs)await fs.chmod(file,0o600);}
  h.eq(await tree(root),beforeConnectProject,'actual Connect leaves the 3D project unchanged');
  h.eq(await tree(machineModelPosterDir()),beforeModelCache,'actual Connect never writes the model poster machine cache');

  const { mountFigureCommandFixture } = await import('./lib/liveEditorFixture');
  const store=await import('../src/lib/store'), {get}=await import('svelte/store');
  const {dispatchCommand}=await import('../src/lib/bridge/commands');
  const {scene3dManifests}=await import('../src/lib/model3d/store');
  const {setStoreTenant}=await import('../src/lib/tenancy');
  const {registerFlushable}=await import('../src/shell/lifecycle');
  const {setFocusedMode}=await import('../src/shell/paneStore');
  const manifests:Record<string,import('../src/lib/model3d/types').Scene3dManifest>={};
  for(const a of loaded.project.assets.filter(a=>a.kind==='glb')){const metadata=await readModel3dMetadata(root,loaded.project,a.id);if(metadata.manifest)manifests[a.id]=metadata.manifest;}
  const cleanup=mountFigureCommandFixture(root);
  try {for(const tenant of ['figure','slide'] as const){
    setStoreTenant(tenant);setFocusedMode(tenant);const release=tenant==='slide'?registerFlushable({id:'slide',isDirty:()=>false,flush:async()=>{}}):()=>{};
    try {
      store.loadProject(structuredClone(loaded.project),root);scene3dManifests.set(manifests);store.activeFigureId.set(figureId);store.selection.set(new Set([model.id]));
      const beforeLive=JSON.stringify(get(store.project).figures);
      await dispatchCommand({type:'set_model_view',azimuth:78,states:{inflated:1.4,bent:-.3}});
      const liveModel=()=>get(store.project).figures.flatMap(f=>f.elements).find(e=>e.id===model.id) as typeof model;
      h.eq(liveModel().modelStates,{inflated:1.4,bent:-.3},`${tenant}: live selection mutation uses same finite weight policy`);
      const afterLive=JSON.stringify(get(store.project).figures);store.undo();h.eq(JSON.stringify(get(store.project).figures),beforeLive,`${tenant}: one Undo restores the whole agent view edit`);store.redo();h.eq(JSON.stringify(get(store.project).figures),afterLive,`${tenant}: Redo restores exactly the edited view`);
      const history=store.historyStats(),badBefore=JSON.stringify(get(store.project));
      await assert.rejects(dispatchCommand({type:'set_model_view',target:model.id,states:{ghost:1}}),/Unknown shape/);
      h.eq(JSON.stringify(get(store.project)),badBefore,`${tenant}: invalid live view leaves project untouched`);h.eq(store.historyStats(),history,`${tenant}: invalid live view adds no undo step`);
      const fieldModel=()=>get(store.project).figures.flatMap(f=>f.elements).find(e=>e.id===field.elementId) as typeof model;
      const keyBefore=posterKey(fieldModel(),loaded.project.assets.find(a=>a.id===field.assetId) as import('../src/lib/model3d/types').Model3dAsset,manifests[field.assetId],{w:200,h:200});
      await dispatchCommand({type:'set_model_field',target:field.elementId,field:'height.field',min:-2,max:2,cmap:'viridis'});
      h.eq(fieldModel().fields?.['height.field'],{cmap:'viridis',range:[-2,2]},`${tenant}: live field dispatch shares core override semantics`);
      h.ok(posterKey(fieldModel(),loaded.project.assets.find(a=>a.id===field.assetId) as import('../src/lib/model3d/types').Model3dAsset,manifests[field.assetId],{w:200,h:200})!==keyBefore,`${tenant}: field dispatch invalidates the mesh poster key`);
      await dispatchCommand({type:'restyle_part',elementId:field.elementId,partId:'height.colorbar',patch:{color:'#aa0000'}});
      h.eq(fieldModel().overrides?.['height.colorbar'],{color:'#aa0000'},`${tenant}: existing live restyle accepts semantic 3D furniture`);
      const beforePart=JSON.stringify(get(store.project));await assert.rejects(dispatchCommand({type:'restyle_part',elementId:field.elementId,partId:'typo',patch:{fill:'#fff'}}),/Unknown part/);h.eq(JSON.stringify(get(store.project)),beforePart,`${tenant}: unknown semantic part cannot create an inert override`);
    }finally{release();}
  }}finally{cleanup();setStoreTenant('figure');}

  // Lower review items: caller mistakes are usage errors, errors list known
  // names, and colour edits never silently do nothing.
  for (const args of [['model-info', 'absent.glb'], ['model-info', 'states.fluxplot.json'], ['model-info', 'states.glb', '--morph-with', 'absent.glb']]) {
    const refused = await run(args); h.ok(refused.code !== 0 && /not found|must be a \.glb/.test(refused.err), `model-info usage error exits non-zero: ${args.slice(1).join(' ')}`);
  }
  await assert.rejects(core.setModelViewCommand(root, { target: model.id, noPoster: true }, { states: { ghost: 1 } }), /Unknown shape state ghost.*Known shape states: .*inflated/);
  const seqId = seq.elementId; await assert.rejects(core.setModelFieldCommand(root, { target: seqId, noPoster: true }, { field: 'height.field', min: 0 }), /Unknown value field.*This model has no value fields/);
  await assert.rejects(core.setModelFieldCommand(root, { target: field.elementId, noPoster: true }, { field: 'typo', min: 0 }), /Known value fields: height\.field/);
  h.ok(true, 'unknown shape states and value fields name the known ones');
  const partFigure = await core.createFigure(root, { id: 'part-colors', name: 'Part colours' });
  const parts = await cli(['add-model', partFigure.figureId, 'named-parts.glb', '--root', root, '--no-poster']);
  const uniform = await cli(['set-model-view', parts.elementId, '--root', root, '--colors', 'uniform', '--no-poster']);
  h.eq(uniform.element.modelColors, 'uniform', 'fixture model starts in Uniform colours');
  const colorsOf = async () => ((await loadFigModel(root)).project.figures.flatMap(f => f.elements).find(e => e.id === parts.elementId) as typeof model).modelColors;
  await cli(['restyle-part', partFigure.figureId, 'legend', '--root', root, '--element', parts.elementId, '--fill', '#224466', '--no-poster']);
  h.eq(await colorsOf(), 'uniform', 'a furniture fill leaves Uniform colours alone');
  const meshFill = await run(['restyle-part', partFigure.figureId, 'neuron.soma', '--root', root, '--element', parts.elementId, '--fill', '#aa2200', '--no-poster']);
  h.ok(meshFill.code === 0 && meshFill.err.includes('switched colors to Source') && await colorsOf() === 'source', 'a mesh part fill on a Uniform model switches it to Source in the same edit');
  const hiddenColor = await cli(['set-model-view', parts.elementId, '--root', root, '--color', '#336699', '--no-poster']);
  h.ok(hiddenColor.warnings.some((w: string) => w.includes('no visible effect while colors are Source')), '--color in Source colours warns that it cannot show');
  const shownColor = await cli(['set-model-view', parts.elementId, '--root', root, '--color', '#336699', '--colors', 'uniform', '--no-poster']);
  h.ok(!shownColor.warnings.some((w: string) => w.includes('no visible effect')), '--color with --colors uniform does not warn');

  // H1 through the built CLI: a placed GLB goes missing; read verbs degrade to
  // named placeholders and the figure stays repairable.
  const broken = (await loadFigModel(root)).project, brokenAsset = broken.assets.find(a => a.id === field.assetId)!;
  await fs.rm(path.join(root, 'fig', brokenAsset.path));
  const missingOut = path.join(scratch, 'missing.svg'), missingRender = await run(['render-figure', figureId, '--root', root, '--out', missingOut]);
  h.ok(missingRender.code === 0 && missingRender.err.includes(`fig/${brokenAsset.path} is missing`) && missingRender.err.includes(field.elementId) && (await fs.readFile(missingOut, 'utf8')).includes('data-model3d-placeholder'), 'built render-figure succeeds with a named placeholder for a missing GLB');
  const missingCanvasOut = path.join(scratch, 'missing-canvas.svg'), missingCanvas = await run(['render-canvas', '--root', root, '--out', missingCanvasOut]);
  h.ok(missingCanvas.code === 0 && missingCanvas.err.includes('is missing'), 'built render-canvas succeeds and names the missing GLB');
  const missingPosters = await cli(['render-model-posters', '--root', root, '--figure', figureId]);
  h.ok(missingPosters.warnings.some((w: string) => w.includes('is missing') && /restore .* or delete the element/.test(w)), 'explicit poster verb names the missing file and its repair');
  const repaired = await run(['delete-element', field.elementId, '--root', root]);
  h.ok(repaired.code === 0 && !(await loadFigModel(root)).project.figures.flatMap(f => f.elements).some(e => e.id === field.elementId), 'built delete-element repairs a figure whose GLB is missing');

} catch(error) { console.error(error); h.fail(String(error)); }
finally { await fs.rm(scratch,{recursive:true,force:true}); }
await h.done();
