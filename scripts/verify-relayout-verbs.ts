import {mkdtemp,mkdir,copyFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';import {promisify} from 'node:util';import {execFile} from 'node:child_process';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {harness} from './lib/harness.mjs';import {tsxRun} from './lib/tsxRun.mjs';import * as core from '../flux-core/index';
import {resizePlot,matchPlotAreas} from '../src/lib/plot/relayout/ops';import {setPlotLayoutMode} from '../src/lib/ops';
const h=harness('verify-relayout-verbs'),root=await mkdtemp(join(tmpdir(),'flux-relayout-verbs-')),repo=resolve(import.meta.dirname,'..'),run=promisify(execFile);let client:Client|undefined;
const cli=(...args:string[])=>run(...tsxRun(join(repo,'flux-cli.ts'),[...args,'--root',root]),{cwd:repo,timeout:60000});
try{
 await core.scaffold(root,{title:'Elastic verbs'});await mkdir(join(root,'plots'),{recursive:true});
 for(const ext of ['svg','fluxplot.json'])await copyFile(join(repo,'scripts/fixtures/relayout/line/base.'+ext),join(root,'plots/line.'+ext));
 await core.createFigure(root,{id:'reflow',name:'Reflow'});await core.importPlots(root,'reflow',[join(root,'plots/line.svg'),join(root,'plots/line.svg')]);
 const initial=await core.loadFigModel(root),plots=initial.project.figures.find(f=>f.id==='reflow')!.elements.filter(e=>e.type==='plot'),[a,b]=plots;
 if(!a||!b)throw Error('Two imports required');const manifest=JSON.parse(await readFile(join(root,'plots/line.fluxplot.json'),'utf8')),expected=structuredClone(initial.project);
 resizePlot(expected,b.id,{width:4,height:2.3,unit:'in',keepAspect:false},manifest);await cli('resize-plot',b.id,'--width','4','--height','2.3','--unit','in','--figure','reflow');
 const elements=async()=>(await core.loadFigModel(root)).project.figures.find(f=>f.id==='reflow')!.elements;
 h.eq(await elements(),expected.figures.find(f=>f.id==='reflow')!.elements,'CLI resize equals shared GUI operation');
 matchPlotAreas(expected,[a.id,b.id],{dimension:'both',reference:a.id},{[a.assetId]:manifest,[b.assetId]:manifest});await cli('match-plot-areas',a.id,b.id,'--dimension','both','--reference',a.id);
 h.eq(await elements(),expected.figures.find(f=>f.id==='reflow')!.elements,'CLI Match equals shared operation');
 setPlotLayoutMode(expected,[a.id,b.id],'stretch');await cli('set-plot-layout-mode',a.id,b.id,'--mode','stretch');h.eq(await elements(),expected.figures.find(f=>f.id==='reflow')!.elements,'CLI Stretch persistence');
 const before=JSON.stringify(await elements());try{await cli('resize-plot',b.id,'--width','-2');h.fail('negative resize accepted')}catch{}h.eq(JSON.stringify(await elements()),before,'invalid edit atomic');
 const [command,args]=tsxRun('flux-mcp.ts',[root,'--toolset','full']);client=new Client({name:'relayout-verifier',version:'1'});await client.connect(new StdioClientTransport({command,args,cwd:repo,env:{...process.env,FLUX_NO_MIGRATE:'1',FLUX_MCP_TOOLSET:'full'} as Record<string,string>}));
 for(const call of [{name:'set_plot_layout_mode',arguments:{elements:[a.id,b.id],mode:'auto'}},{name:'resize_plot',arguments:{element:b.id,width:5,height:3,unit:'in',keepAspect:false}},{name:'match_plot_areas',arguments:{elements:[a.id,b.id],dimension:'height',reference:a.id}}])h.ok(!(await client.callTool(call)).isError,'MCP '+call.name+' executes');
 setPlotLayoutMode(expected,[a.id,b.id],null);resizePlot(expected,b.id,{width:5,height:3,unit:'in',keepAspect:false},manifest);matchPlotAreas(expected,[a.id,b.id],{dimension:'height',reference:a.id},{[a.assetId]:manifest,[b.assetId]:manifest});
 h.eq(await elements(),expected.figures.find(f=>f.id==='reflow')!.elements,'MCP persists identical shared results and auto absence');
}catch(e){h.fail(e instanceof Error?e.stack:String(e))}
await h.done(async()=>{await client?.close();await rm(root,{recursive:true,force:true})});
