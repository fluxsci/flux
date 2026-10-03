<script>
import ColorScaleControls from '../../../src/lib/plot/ColorScaleControls.svelte';
import NumberField from '../../../src/lib/NumberField.svelte';
import {project, selection, activeFigureId, loadProject, mutate, undo, redo, historyAvailability} from '../../../src/lib/store';
import {plotManifests, plotRecipes} from '../../../src/lib/plot/store';
import {get} from 'svelte/store';
import {tick} from 'svelte';
// A legacy (pre-0.3.1) manifest: its colour controls are the series' field, regenerate-only.
const original={schemaVersion:'0.1.0',series:[{id:'field',name:'Signal',field:{controlKey:'field',cmap:'viridis',normalization:{kind:'Normalize',vmin:0,vmax:1}}}]};
let plotId='pa',shown=true;
$: selected=$project.figures?.[0]?.elements.find(e=>$selection.has(e.id));
// Two plots on their own figure (figure 0's rects are the NumberField's positions).
const plotEl=(id,assetId)=>({id,type:'plot',assetId,x:0,y:0,width:200,height:150,rotation:0,source:{recipePath:`plots/${assetId}.py`}});
function seed(){loadProject({version:2,name:'controls',assets:[],palette:[],canvases:[{id:'c',name:'C'}],figures:[{id:'f',name:'F',canvasId:'c',x:0,y:0,width:500,height:400,elements:[{id:'a',type:'rect',x:100,y:0,width:20,height:20,rotation:0,fill:'#000',stroke:'none',strokeWidth:0},{id:'b',type:'rect',x:200,y:0,width:20,height:20,rotation:0,fill:'#000',stroke:'none',strokeWidth:0}]},{id:'g',name:'G',canvasId:'c',x:600,y:0,width:500,height:400,elements:[plotEl('pa','a'),plotEl('pb','b')]}]},null);activeFigureId.set('f');selection.set(new Set(['a']))}
plotManifests.set({a:structuredClone(original),b:structuredClone(original)});
seed();
window.controls={
 // an unrelated store update: the same manifest content, a recipe param that is not a colour control
 notify(){plotManifests.update(m=>({...m}));plotRecipes.update(r=>({...r,a:{params:{unrelated:Date.now()}}}))},
 // the current plot's source regenerated with a new generated minimum
 replace(){const assetId=plotId==='pa'?'a':'b',next=structuredClone(original);next.series[0].field.normalization.vmin=-2;plotManifests.update(m=>({...m,[assetId]:next}))},
 target(){plotId='pb'},seed,select(id){selection.set(new Set([id]))},undo,redo,
 state(){return {positions:get(project).figures[0].elements.map(e=>e.x),canUndo:get(historyAvailability).undo,canRedo:get(historyAvailability).redo}},
 async unmount(){shown=false;await tick()},async mount(){shown=true;await tick()}};
</script>
<div class="color-probe"><ColorScaleControls elementId={plotId}/></div>
{#if shown}<div class="number-probe"><NumberField label="Position" value={selected?.x??0} on:scrub={e=>mutate(p=>{p.figures[0].elements.find(el=>el.id===selected.id).x=e.detail})}/></div>{/if}
