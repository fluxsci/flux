<script lang="ts">
  import { onDestroy, tick } from 'svelte';
  import ArrangementAnchorPicker from './ArrangementAnchorPicker.svelte';
  import { yieldsToShellModal, isAnnotateChord } from '../shell/agent/annotationVisibility';
  import { resizeCursorVar } from './interact/handles';
  import { alignArrange, arrangementLayout, passiveArrangement, alignmentGuides, beginArrangementDrag, setArrangementGap, endArrangementDrag, handleArrangementAnchorKey, arrangementAnchor, setArrangementAnchor } from './interact/alignArrange';
  import type { Viewport } from './types';
  export let viewport: Viewport;
  export let figureX=0;
  export let figureY=0;
  export let width=0;
  export let height=0;
  let anchorOpen=false;
  let popupOrigin={x:0,y:0};
  let anchorPopup: HTMLDivElement;
  let anchorToggle: SVGCircleElement;
  const anchorWatch={layout:null as typeof layout};
  let hover: {axis:'x'|'y';index:number}|null=null;
  let drag: {ownerId:number;axis:'x'|'y';pointer:number;node:SVGElement;start:number;value:number;zoom:number;factor:number;clientX:number;clientY:number;originX:number;originY:number}|null=null;
  // Explicit projection dependencies: helper closure reads are invisible to
  // legacy Svelte's reactive dependency analysis. Pan/zoom must move ALL chrome
  // even while the selected layout itself has not changed.
  $: layout=$alignArrange?$arrangementLayout:$passiveArrangement;
  $: showing=$alignArrange?$alignArrange.mode==='arrange'&&!$alignArrange.blockedReason:!!$passiveArrangement;
  $: projection={zoom:viewport.zoom,x:viewport.panX+figureX*viewport.zoom,y:viewport.panY+figureY*viewport.zoom};
  const sx=(x:number,p:typeof projection)=>p.x+x*p.zoom;
  const sy=(y:number,p:typeof projection)=>p.y+y*p.zoom;
  $: guides=(layout?.gaps??[]).map(g=>({...g,x1:sx(g.x1,projection),y1:sy(g.y1,projection),x2:sx(g.x2,projection),y2:sy(g.y2,projection)}))
    .filter(g=>Math.max(g.x1,g.x2)>=0&&Math.min(g.x1,g.x2)<=width&&Math.max(g.y1,g.y2)>=0&&Math.min(g.y1,g.y2)<=height)
    .map(g=>({...g,x1:Math.max(0,Math.min(width,g.x1)),x2:Math.max(0,Math.min(width,g.x2)),y1:Math.max(0,Math.min(height,g.y1)),y2:Math.max(0,Math.min(height,g.y2))}));
  $: bounds=$alignArrange?.bounds??layout?.bounds;
  $: anchor=$alignArrange?.anchor??$arrangementAnchor;
  $: topology=layout?.topology??'row';
  $: pinX=bounds?sx(bounds.x+bounds.w*anchor.x,projection):0;
  $: pinY=bounds?sy(bounds.y+bounds.h*anchor.y,projection):0;
  $: popupHeight=topology==='grid'?114:72;
  $: popupX=Math.max(4,Math.min(width-182,popupOrigin.x+12));
  $: popupY=Math.max(4,Math.min(height-popupHeight-4,popupOrigin.y+12));
  $: {if(anchorWatch.layout!==layout)anchorOpen=false;anchorWatch.layout=layout;}
  $: if(!showing || drag)anchorOpen=false;
  async function toggleAnchor(e:Event) {
    e.preventDefault();e.stopPropagation();popupOrigin={x:pinX,y:pinY};anchorOpen=!anchorOpen;
    if(anchorOpen){await tick();anchorPopup?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus({preventScroll:true});}
  }
  function outsideAnchor(e:PointerEvent) {if(!(e.target instanceof Element)||!e.target.closest('.arrangement-anchor-control'))anchorOpen=false;}
  function anchorKeys(e:KeyboardEvent) {
    if(yieldsToShellModal(e)||isAnnotateChord(e))return;
    if(anchorOpen && e.key==='Escape'){e.preventDefault();e.stopImmediatePropagation();anchorOpen=false;anchorToggle?.focus({preventScroll:true});return;}
    if(!showing || !(e.target instanceof Element) || !e.target.closest('.canvas-host,.align-arrange-panel'))return;
    const axis=drag?.axis??hover?.axis??(topology==='row'?'x':topology==='column'?'y':undefined);
    if(handleArrangementAnchorKey(e,axis))e.stopImmediatePropagation();
  }
  $: gapX=$alignArrange?.gapX??layout?.gapX??0;
  $: gapY=$alignArrange?.gapY??layout?.gapY??0;
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
      value:drag.axis==='x'?gapX:gapY,factor:f};
  }
  function down(e:PointerEvent,axis:'x'|'y') {
    if(e.button!==0||!showing||drag)return;
    e.preventDefault();e.stopPropagation();anchorOpen=false;
    // preventDefault preserves the previous native focus. End any numeric
    // draft and give the gesture keyboard ownership, so Space cannot activate
    // a previously focused anchor/button or type into the gap field mid-drag.
    if(document.activeElement instanceof HTMLElement)document.activeElement.blur();
    const focus=document.querySelector<HTMLElement>('[data-command-scope="align-arrange"]')??(e.currentTarget as SVGElement).closest<HTMLElement>('.canvas-host');
    focus?.focus({preventScroll:true});
    const hit=nearest(e); if(hit)axis=hit.axis;
    // Capture on the stable owner: an offscreen gutter may be culled while
    // its drag must keep running. Never capture the disposable line itself.
    const node=(e.currentTarget as SVGElement).closest('.gap-guides') as SVGGElement;
    const rect=node.ownerSVGElement!.getBoundingClientRect();
    beginArrangementDrag(axis);
    if(!$alignArrange?.dragging)return;
    drag={ownerId:$alignArrange.id,axis,pointer:e.pointerId,node,start:axis==='x'?e.clientX:e.clientY,value:axis==='x'?$alignArrange.gapX:$alignArrange.gapY,zoom:viewport.zoom,factor:factor(e),clientX:e.clientX,clientY:e.clientY,originX:rect.x,originY:rect.y};
    node.setPointerCapture(e.pointerId);
  }
  function move(e:PointerEvent) {
    if(!drag){const hit=nearest(e);hover=hit?{axis:hit.axis,index:hit.index}:null;return;}
    if(e.pointerId!==drag.pointer)return;
    e.preventDefault();e.stopPropagation();
    if(!$alignArrange?.dragging||$alignArrange.id!==drag.ownerId){release(false);return;}
    const position=drag.axis==='x'?e.clientX:e.clientY, f=factor(e);
    if(f!==drag.factor){drag.start=drag.axis==='x'?drag.clientX:drag.clientY;drag.value=drag.axis==='x'?gapX:gapY;drag.factor=f;}
    setArrangementGap(drag.axis,drag.value+(position-drag.start)/drag.zoom*f);
    drag={...drag,clientX:e.clientX,clientY:e.clientY};
  }
  function release(accept:boolean) {
    if(!drag)return;const old=drag;drag=null;hover=null;
    if($alignArrange?.id===old.ownerId)endArrangementDrag(accept&&!!$alignArrange.dragging);
    if(old.node.hasPointerCapture(old.pointer))old.node.releasePointerCapture(old.pointer);
  }
  function up(e:PointerEvent){if(e.pointerId!==drag?.pointer)return;e.preventDefault();e.stopPropagation();release(true);}
  function cancel(e:PointerEvent){if(e.pointerId===drag?.pointer)release(false);}
  $: if(drag&&(!$alignArrange?.dragging||$alignArrange.id!==drag.ownerId))release(false);
  onDestroy(()=>release(false));
</script>

<svelte:window on:blur={()=>{anchorOpen=false;release(false);}} on:pointerdown|capture={outsideAnchor} on:keydown|capture={anchorKeys} on:keydown={modifiers} on:keyup={modifiers} />
{#if $alignArrange}
  <g class="align-guides" aria-hidden="true">
    {#if $alignArrange.referenceBounds}
      {@const b=$alignArrange.referenceBounds}
      <rect class="reference-outline" x={sx(b.x,projection)-3} y={sy(b.y,projection)-3} width={b.w*projection.zoom+6} height={b.h*projection.zoom+6} />
    {/if}
    {#each $alignmentGuides as g}<line x1={sx(g.x1,projection)} y1={sy(g.y1,projection)} x2={sx(g.x2,projection)} y2={sy(g.y2,projection)} />{/each}
  </g>
{/if}
{#if showing}
  <g class="gap-guides" role="presentation" on:pointermove={move} on:pointerup={up} on:pointercancel={cancel} on:lostpointercapture={cancel}>
    {#each guides as g (`${g.axis}-${g.index}`)}
      <g class:lit={(hover?.axis===g.axis&&hover.index===g.index)||$alignArrange?.hover===`gap-${g.axis}`}>
        <line class="gap-visible" x1={g.x1} y1={g.y1} x2={g.x2} y2={g.y2} />
        <line role="presentation" data-arrange-gap={g.axis} data-gap-index={g.index} class="gap-hit" style:cursor={resizeCursorVar(g.axis==='x'?'e':'s')}
          x1={g.x1} y1={g.y1} x2={g.x2} y2={g.y2}
          on:pointerenter={()=>hover={axis:g.axis,index:g.index}} on:pointerleave={()=>{if(!drag)hover=null;}}
          on:pointerdown={e=>down(e,g.axis)} />
      </g>
    {/each}
    {#if bounds}
      <g class="arrangement-anchor-control">
        <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
        <circle class="pin" cx={pinX} cy={pinY} r="4" aria-hidden="true"/>
        <circle bind:this={anchorToggle} class="pin-hit" data-arrangement-anchor-toggle role="button" tabindex="0" aria-label="Choose fixed point" aria-haspopup="dialog" aria-expanded={anchorOpen} cx={pinX} cy={pinY} r="10" on:pointerdown|stopPropagation|preventDefault on:click={toggleAnchor} on:keydown={e=>{if(e.key==='Enter'||e.key===' ')toggleAnchor(e);}}><title>Keep fixed · click to choose</title></circle>
        {#if anchorOpen}
          <foreignObject x={popupX} y={popupY} width="178" height={popupHeight}>
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div bind:this={anchorPopup} class="anchor-popover" role="dialog" tabindex="-1" aria-label="Keep fixed" on:pointerdown|stopPropagation on:click|stopPropagation on:keydown={e=>{if(!e.ctrlKey&&!e.metaKey)e.stopPropagation();}}>
              <span class="anchor-title">Keep fixed</span>
              <ArrangementAnchorPicker {topology} {anchor} onchange={setArrangementAnchor}/>
            </div>
          </foreignObject>
        {/if}
      </g>
    {/if}
    {#if drag || hover && guides.find(g=>g.axis===hover?.axis&&g.index===hover.index)}
      {@const axis=drag?.axis??hover!.axis}
      {@const guide=guides.find(g=>g.axis===hover?.axis&&g.index===hover.index)}
      {@const value=String(Number((axis==='x'?gapX:gapY).toFixed(3)))}
      {@const badgeW=Math.max(30,value.length*7.5+12)}
      {@const x=Math.max(4,Math.min(width-badgeW-4,drag?drag.clientX-drag.originX+16:(guide!.x1+guide!.x2)/2+9))}
      {@const y=Math.max(4,Math.min(height-24,drag?drag.clientY-drag.originY-32:(guide!.y1+guide!.y2)/2-28))}
      <g class="gap-badge" transform={`translate(${x} ${y})`}>
        <rect width={badgeW} height="22" rx="4" />
        <text class="gap-value" x={badgeW/2} y="15" text-anchor="middle">{value}</text>
      </g>
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
  .pin-hit{pointer-events:all;cursor:var(--cursor-cross-hover);fill:transparent;stroke:none}
  .pin-hit:focus-visible{outline:none;stroke:var(--c-layout-gap);stroke-width:1.5}
  .arrangement-anchor-control foreignObject{overflow:visible}
  .anchor-popover{pointer-events:auto;box-sizing:border-box;padding:8px;background:var(--c-surface);border:1px solid var(--c-line-strong);border-radius:4px;color:var(--c-tx);box-shadow:var(--elev-2);font:11px var(--font-ui)}
  .anchor-title{display:block;margin-bottom:6px;font:600 11px var(--font-serif)}
  .gap-badge rect{fill:var(--flx-paper)}
  .gap-value{fill:var(--flx-magenta-600);font:600 12px var(--font-mono,monospace);stroke:none}
</style>
