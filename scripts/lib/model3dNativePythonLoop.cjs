'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),{createHash}=require('node:crypto');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
/** Rerun the reviewed fluxplot demo from an isolated worktree into this scratch
 * project, with one source colour changed. No owner checkout or user project. */
module.exports=async function rerunNeuron(root,artifacts){
 const problem=require('./model3dPythonPrerequisite.cjs').model3dPythonWorktreeProblem(process.env.FLUXPLOT_ROOT);
 if(problem)throw Error('S6 prerequisite: '+problem);
 const fpRoot=path.resolve(process.env.FLUXPLOT_ROOT);
 const source=await fs.readFile(path.join(fpRoot,'examples/scene3d_demo.py'),'utf8');
 const original="'soma':'#D14D41'";if(source.split(original).length!==2)throw Error('Update S6 explicit demo colour fixture: expected unique soma palette entry');
 const sourceFile=path.join(root,'plots/neuron.glb'),beforeSha256=sha(await fs.readFile(sourceFile));
 const script=path.join(root,'rerun_neuron.py');
 await fs.writeFile(path.join(root,'neuron_source.py'),source.replace(original,"'soma':'#E8A240'"));
 await fs.writeFile(script,"from pathlib import Path\nimport fluxplot as fp\nfrom neuron_source import neuron_scene\nfp.use_paper()\nfp.save(neuron_scene(), Path(__file__).parent/'plots/neuron', recipe=False)\n");
 const {TestProcessScope}=await import('./testProcess.mjs'),scope=new TestProcessScope();
 try{
  const child=scope.spawn('run',['--project',fpRoot,'--no-sync','python',script],{command:'uv',nodeArgs:[],cwd:root,env:{...process.env,PYTHONPATH:path.join(fpRoot,'src'),UV_CACHE_DIR:path.join(root,'.uv-cache'),UV_OFFLINE:'1',FLUX_NO_MIGRATE:'1'},deadlineMs:60000});
  await scope.waitExit(child);await fs.writeFile(path.join(artifacts,'python-rerun.log'),child.stdout+child.stderr);
  if(child.code!==0)throw Error(`Scratch fluxplot rerun failed: ${child.stdout}${child.stderr}`);
  const sourceSha256=sha(await fs.readFile(sourceFile)),manifest=JSON.parse(await fs.readFile(path.join(root,'plots/neuron.fluxplot.json'),'utf8'));
  if(sourceSha256===beforeSha256||manifest.glbSha256!==sourceSha256||manifest.parts.find(p=>p.id==='neuron.soma')?.color.toLowerCase()!=='#e8a240')throw Error('Python rerun did not change GLB bytes and bind the expected soma colour');
  return{beforeSha256,sourceSha256,worktree:fpRoot,command:['uv','run','--project',fpRoot,'--no-sync','python',script],sourceColor:'#E8A240'};
 }finally{await scope.dispose();}
};
