<script lang="ts">
  import { onDestroy } from 'svelte';
  import { yieldsToShellModal, isAnnotateChord } from '../shell/agent/annotationVisibility';
  import { resizeCursorVar } from './interact/handles';
  import { alignArrange, arrangementLayout, alignmentGuides, beginArrangementDrag, setArrangementGap, acceptArrangementField, cancelArrangementField } from './interact/alignArrange';
  import type { Viewport } from './types';
  export let viewport: Viewport;
  export let figureX=0;
  export let figureY=0;
  export let width=0;
  export let height=0;
  let hover: {axis:'x'|'y';index:number}|null=null;
  let drag: {axis:'x'|'y';pointer:number;node:SVGElement;start:number;value:number;zoom:number;factor:number;clientX:number;clientY:number;originX:number;originY:number}|null=null;
  const sx=(x:number)=>viewport.panX+(figureX+x)*viewport.zoom;
  const sy=(y:number)=>viewport.panY+(figureY+y)*viewport.zoom;
  $: guides=($arrangementLayout?.gaps??[]).map(g=>({...g,x1:sx(g.x1),y1:sy(g.y1),x2:sx(g.x2),y2:sy(g.y2)}))
    .filter(g=>Math.max(g.x1,g.x2)>=0&&Math.min(g.x1,g.x2)<=width&&Math.max(g.y1,g.y2)>=0&&Math.min(g.y1,g.y2)<=height)
    .map(g=>({...g,x1:Math.max(0,Math.min(width,g.x1)),x2:Math.max(0,Math.min(width,g.x2)),y1:Math.max(0,Math.min(height,g.y1)),y2:Math.max(0,Math.min(height,g.y2))}));
  const factor=(e:Pick<PointerEvent,'shiftKey'|'altKey'>)=>e.shiftKey?10:e.altKey?.1:1;
  function nearest(e:PointerEvent) {
    const node=e.currentTarget as SVGElement, rect=node.ownerSVGElement!.getBoundingClientRect();
    const x=e.clientX-rect.x,y=e.clientY-rect.y;
    // Overlapping 12px hit bands choose the visibly nearest gutter; exact
    // intersections use X then track order, independent of SVG paint order.
    return guides.map(g=>{const dx=g.x2-g.x1,dy=g.y2-g.y1,l=dx*dx+dy*dy;
      const t=l?Math.max(0,Math.min(1,((x-g.x1)*dx+(y-g.y1)*dy)/l)):0;
      return {g,d:Math.hypot(x-g.x1-t*dx,y-g.y1-t*dy)};
    }).filter(v=>v.d<=6).sort((a,b)=>a.d-b.d||a.g.axis.localeCompare(b.g.axis)||a.g.index-b.g.index)[0]?.g;
  }
  function modifiers(e:KeyboardEvent) {
    if (yieldsToShellModal(e) || isAnnotateChord(e)) return;
    if(!drag||!$alignArrange?.dragging||(e.key!=='Shift'&&e.key!=='Alt'))return;
    const f=factor(e);if(f===drag.factor)return;
    drag={...drag,start:drag.axis==='x'?drag.clientX:drag.clientY,
      value:drag.axis==='x'?$alignArrange.gapX:$alignArrange.gapY,factor:f};
  }
  function down(e:PointerEvent,axis:'x'|'y') {
    if(e.button!==0||!$alignArrange||drag)return;
    e.preventDefault();e.stopPropagation();
    // preventDefault preserves the previous native focus. End any numeric
    // draft and give the gesture keyboard ownership, so Space cannot activate
    // a previously focused anchor/button or type into the gap field mid-drag.
    if(document.activeElement instanceof HTMLElement)document.activeElement.blur();
    document.querySelector<HTMLElement>('[data-command-scope="align-arrange"]')?.focus({preventScroll:true});
    const hit=nearest(e); if(hit)axis=hit.axis;
    // Capture on the stable owner: an offscreen gutter may be culled while
    // its drag must keep running. Never capture the disposable line itself.
    const node=(e.currentTarget as SVGElement).closest('.gap-guides') as SVGGElement;
    const rect=node.ownerSVGElement!.getBoundingClientRect();
    beginArrangementDrag(axis);
    drag={axis,pointer:e.pointerId,node,start:axis==='x'?e.clientX:e.clientY,value:axis==='x'?$alignArrange.gapX:$alignArrange.gapY,zoom:viewport.zoom,factor:factor(e),clientX:e.clientX,clientY:e.clientY,originX:rect.x,originY:rect.y};
    node.setPointerCapture(e.pointerId);
  }
  function move(e:PointerEvent) {
    if(!drag){const hit=nearest(e);hover=hit?{axis:hit.axis,index:hit.index}:null;return;}
    if(e.pointerId!==drag.pointer)return;
    e.preventDefault();e.stopPropagation();
    if(!$alignArrange?.dragging){release(false);return;}
    const position=drag.axis==='x'?e.clientX:e.clientY, f=factor(e);
    if(f!==drag.factor){drag.start=drag.axis==='x'?drag.clientX:drag.clientY;drag.value=drag.axis==='x'?$alignArrange.gapX:$alignArrange.gapY;drag.factor=f;}
    setArrangementGap(drag.axis,Math.max(0,drag.value+(position-drag.start)/drag.zoom*f));
    drag={...drag,clientX:e.clientX,clientY:e.clientY};
  }
  function release(accept:boolean) {
    if(!drag)return;const old=drag;drag=null;hover=null;
    if(accept&&$alignArrange?.dragging)acceptArrangementField();else cancelArrangementField();
    if(old.node.hasPointerCapture(old.pointer))old.node.releasePointerCapture(old.pointer);
  }
  function up(e:PointerEvent){if(e.pointerId!==drag?.pointer)return;e.preventDefault();e.stopPropagation();release(true);}
  function cancel(e:PointerEvent){if(e.pointerId===drag?.pointer)release(false);}
  $: if(drag&&!$alignArrange?.dragging)release(false);
  onDestroy(()=>release(false));
</script>

<svelte:window on:blur={()=>release(false)} on:keydown={modifiers} on:keyup={modifiers} />
{#if $alignArrange}
  <g class="align-guides" aria-hidden="true">
    {#if $alignArrange.referenceBounds}
      {@const b=$alignArrange.referenceBounds}
      <rect class="reference-outline" x={sx(b.x)-3} y={sy(b.y)-3} width={b.w*viewport.zoom+6} height={b.h*viewport.zoom+6} />
    {/if}
    {#each $alignmentGuides as g}<line x1={sx(g.x1)} y1={sy(g.y1)} x2={sx(g.x2)} y2={sy(g.y2)} />{/each}
  </g>
{/if}
{#if $alignArrange?.mode==='arrange' && !$alignArrange.blockedReason}
  <g class="gap-guides" role="presentation" aria-hidden="true" on:pointermove={move} on:pointerup={up} on:pointercancel={cancel} on:lostpointercapture={cancel}>
    {#each guides as g (`${g.axis}-${g.index}`)}
      <g class:lit={(hover?.axis===g.axis&&hover.index===g.index)||$alignArrange.hover===`gap-${g.axis}`}>
        <line class="gap-visible" x1={g.x1} y1={g.y1} x2={g.x2} y2={g.y2} />
        <line role="presentation" data-arrange-gap={g.axis} data-gap-index={g.index} class="gap-hit" style:cursor={resizeCursorVar(g.axis==='x'?'e':'s')}
          x1={g.x1} y1={g.y1} x2={g.x2} y2={g.y2}
          on:pointerenter={()=>hover={axis:g.axis,index:g.index}} on:pointerleave={()=>{if(!drag)hover=null;}}
          on:pointerdown={e=>down(e,g.axis)} />
      </g>
    {/each}
    {#if $alignArrange.bounds}
      {@const b=$alignArrange.bounds}
      <circle class="pin" cx={sx(b.x+b.w*$alignArrange.anchor.x)} cy={sy(b.y+b.h*$alignArrange.anchor.y)} r="4" />
    {/if}
    {#if drag}<text class="gap-value" x={Math.max(15,Math.min(width-45,drag.clientX-drag.originX+16))} y={Math.max(18,Math.min(height-10,drag.clientY-drag.originY-14))}>{Number((drag.axis==='x'?$alignArrange.gapX:$alignArrange.gapY).toFixed(3))}</text>{/if}
    {#if hover && !drag && guides.find(g=>g.axis===hover?.axis&&g.index===hover.index)}
      {@const g=guides.find(g=>g.axis===hover?.axis&&g.index===hover.index)!}
      <text class="gap-value" x={Math.min(width-30,Math.max(20,(g.x1+g.x2)/2+9))} y={Math.min(height-10,Math.max(16,(g.y1+g.y2)/2-9))}>{Number((hover.axis==='x'?$alignArrange.gapX:$alignArrange.gapY).toFixed(3))}</text>
    {/if}
  </g>
{/if}

<style>
  .gap-guides,.align-guides{pointer-events:none}
  .gap-visible,.align-guides line{stroke:var(--c-layout-gap,#ef83bd);stroke-width:1.5;fill:none}
  .reference-outline{fill:none;stroke:var(--c-layout-gap);stroke-width:1;stroke-dasharray:3 3}
  .align-guides line{stroke-dasharray:4 3}
  .gap-visible{opacity:.7}
  .lit .gap-visible{opacity:1;stroke-width:2}
  .gap-hit{stroke:transparent;stroke-width:12;pointer-events:stroke;touch-action:none}
  .pin{fill:var(--c-surface,#252523);stroke:var(--c-layout-gap,#ef83bd);stroke-width:2}
  .gap-value{fill:var(--c-layout-gap,#ef83bd);font:600 12px var(--font-mono,monospace);paint-order:stroke;stroke:var(--c-surface,#252523);stroke-width:4;stroke-linejoin:round}
</style>
