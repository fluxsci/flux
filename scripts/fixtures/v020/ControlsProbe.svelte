<script>
import ColorScaleControls from '../../../src/lib/plot/ColorScaleControls.svelte';
import NumberField from '../../../src/lib/NumberField.svelte';
import {project, selection, activeFigureId, loadProject, mutate, undo, redo, historyAvailability} from '../../../src/lib/store';
import {get} from 'svelte/store';
import {tick} from 'svelte';
const original={schemaVersion:'0.1.0',series:[{id:'field',name:'Signal',field:{controlKey:'field',cmap:'viridis',normalization:{kind:'Normalize',vmin:0,vmax:1}}}]};
let manifest=original,assetId='a',params={},shown=true;
$: selected=$project.figures?.[0]?.elements.find(e=>$selection.has(e.id));
function seed(){loadProject({version:2,name:'controls',assets:[],palette:[],canvases:[{id:'c',name:'C'}],figures:[{id:'f',name:'F',canvasId:'c',x:0,y:0,width:500,height:400,elements:[{id:'a',type:'rect',x:100,y:0,width:20,height:20,rotation:0,fill:'#000',stroke:'none',strokeWidth:0},{id:'b',type:'rect',x:200,y:0,width:20,height:20,rotation:0,fill:'#000',stroke:'none',strokeWidth:0}]}]},null);activeFigureId.set('f');selection.set(new Set(['a']))}
seed();
window.controls={notify(){manifest=manifest;params={...params,unrelated:Date.now()}},replace(){manifest=structuredClone(original);manifest.series[0].field.normalization.vmin=-2},target(){assetId='b'},seed,select(id){selection.set(new Set([id]))},undo,redo,state(){return {positions:get(project).figures[0].elements.map(e=>e.x),canUndo:get(historyAvailability).undo,canRedo:get(historyAvailability).redo}},async unmount(){shown=false;await tick()},async mount(){shown=true;await tick()}};
</script>
<div class="color-probe"><ColorScaleControls {manifest} {params} {assetId}/></div>
{#if shown}<div class="number-probe"><NumberField label="Position" value={selected?.x??0} on:scrub={e=>mutate(p=>{p.figures[0].elements.find(el=>el.id===selected.id).x=e.detail})}/></div>{/if}
