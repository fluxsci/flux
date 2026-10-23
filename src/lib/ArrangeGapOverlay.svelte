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
  // The pin sits on the fixed point — by default the selection's centre, right where people grab
  // a selection to drag it. A press that stays put is a click on the pin (the picker); a press
  // that MOVES past the canvas's drag threshold is handed to whatever lies beneath the pin, so
  // the ordinary move (and a drop onto another figure) runs exactly as if the pin were not there.
  const PIN_DRAG_PX = 4;
  let pinDragged = false;
  function pinDown(e:PointerEvent) {
    e.stopPropagation();e.preventDefault();
    if(e.button!==0)return;
    pinDragged=false;
    const start={x:e.clientX,y:e.clientY,id:e.pointerId,type:e.pointerType,mods:{shiftKey:e.shiftKey,ctrlKey:e.ctrlKey,altKey:e.altKey,metaKey:e.metaKey}};
    const win=(e.currentTarget as Element).ownerDocument.defaultView!;
    const done=()=>{win.removeEventListener('pointermove',move,true);win.removeEventListener('pointerup',done,true);win.removeEventListener('pointercancel',done,true);};
    const move=(ev:PointerEvent)=>{
      if(ev.pointerId!==start.id||Math.hypot(ev.clientX-start.x,ev.clientY-start.y)<PIN_DRAG_PX)return;
      done();pinDragged=true;anchorOpen=false;
      const doc=win.document;
      const under=doc.elementsFromPoint(start.x,start.y).find(n=>!n.closest('.arrangement-anchor-control'));
      if(!under)return;
      const init={bubbles:true,cancelable:true,composed:true,pointerId:start.id,pointerType:start.type,isPrimary:true,...start.mods};
      under.dispatchEvent(new PointerEvent('pointerdown',{...init,clientX:start.x,clientY:start.y,button:0,buttons:1}));
      under.dispatchEvent(new PointerEvent('pointermove',{...init,clientX:ev.clientX,clientY:ev.clientY,button:-1,buttons:1}));
    };
    win.addEventListener('pointermove',move,true);win.addEventListener('pointerup',done,true);win.addEventListener('pointercancel',done,true);
  }
  function pinClick(e:MouseEvent) {
    if(pinDragged){pinDragged=false;e.preventDefault();e.stopPropagation();return;}
    void toggleAnchor(e);
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
    const node=e.currentTarget as SVGElement, svg=node.ownerSVGElement;
    // A move can still reach a band the moment the guides unmount (an object move starting
    // under the pointer): a detached node has no owner SVG and no nearest guide.
    if(!svg)return undefined;
    const rect=svg.getBoundingClientRect();
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
      {@const lit=(hover?.axis===g.axis&&hover.index===g.index)||$alignArrange?.hover===`gap-${g.axis}`||drag?.axis===g.axis}
      {@const span=Math.max(0,(g.axis==='x'?gapX:gapY)*projection.zoom)}
      <g class:lit>
        {#if lit && span>=2}
          <!-- The gap itself, filled: what a drag here edits (design tools' spacing highlight). -->
          {#if g.axis==='x'}<rect class="gap-fill" x={g.x1-span/2} y={Math.min(g.y1,g.y2)} width={span} height={Math.abs(g.y2-g.y1)} />
          {:else}<rect class="gap-fill" x={Math.min(g.x1,g.x2)} y={g.y1-span/2} width={Math.abs(g.x2-g.x1)} height={span} />{/if}
        {/if}
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
        <!-- The fixed point: a ring on a paper halo (legible on any artwork), a centre dot. -->
        <g class="pin-glyph" class:open={anchorOpen} aria-hidden="true">
          <circle class="pin-halo" cx={pinX} cy={pinY} r="7.5"/>
          <circle class="pin" cx={pinX} cy={pinY} r="5"/>
          <circle class="pin-core" cx={pinX} cy={pinY} r="1.75"/>
        </g>
        <circle bind:this={anchorToggle} class="pin-hit" data-arrangement-anchor-toggle role="button" tabindex="0" aria-label="Choose fixed point" aria-haspopup="dialog" aria-expanded={anchorOpen} cx={pinX} cy={pinY} r="10" on:pointerdown={pinDown} on:click={pinClick} on:keydown={e=>{if(e.key==='Enter'||e.key===' ')toggleAnchor(e);}}><title>Keep fixed · click to choose</title></circle>
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
        <rect class="gap-badge-shadow" x="0" y="1" width={badgeW} height="22" rx="11" />
        <rect width={badgeW} height="22" rx="11" />
        <text class="gap-value" x={badgeW/2} y="15" text-anchor="middle">{value}</text>
      </g>
    {/if}
  </g>
{/if}

<style>
  .gap-guides,.align-guides{pointer-events:none}
  .gap-visible,.align-guides line{stroke:var(--c-layout-gap,#ce5d97);stroke-width:1.25;fill:none}
  .reference-outline{fill:none;stroke:var(--c-layout-gap);stroke-width:1.25;stroke-dasharray:4 3}
  .align-guides line{stroke-dasharray:4 3}
  .gap-visible{opacity:.75;transition:opacity 80ms linear}
  .lit .gap-visible{opacity:1;stroke-width:1.75}
  .gap-fill{fill:var(--c-layout-gap-fill,rgba(206,93,151,.22));stroke:none}
  .gap-hit{stroke:transparent;stroke-width:12;pointer-events:stroke;touch-action:none}
  /* The pin: invisible 10 px target, a ring that grows a touch on hover and while its picker is open. */
  .pin-glyph{transform-box:fill-box;transform-origin:center;transition:transform 90ms ease-out}
  .arrangement-anchor-control:hover .pin-glyph,.pin-glyph.open{transform:scale(1.2)}
  .pin-halo{fill:var(--flx-paper,#fffcf0);opacity:.85;stroke:color-mix(in oklab,var(--flx-black,#100f0f) 25%,transparent);stroke-width:.75}
  .pin{fill:var(--flx-paper,#fffcf0);stroke:var(--c-layout-gap,#ce5d97);stroke-width:2}
  .pin-core{fill:var(--c-layout-gap,#ce5d97)}
  .pin-hit{pointer-events:all;cursor:var(--cursor-cross-hover);fill:transparent;stroke:none}
  .pin-hit:focus-visible{outline:none;stroke:var(--c-layout-gap);stroke-width:1.5}
  .arrangement-anchor-control foreignObject{overflow:visible}
  .anchor-popover{pointer-events:auto;box-sizing:border-box;padding:7px 8px 8px;background:var(--c-surface);border:1px solid var(--c-line-strong);border-radius:var(--r-panel,3px);color:var(--c-tx);box-shadow:var(--elev-2);font:11px var(--font-ui)}
  .anchor-title{display:block;margin-bottom:6px;color:var(--c-tx-muted);font:600 9.5px var(--font-mono);letter-spacing:.08em;text-transform:uppercase}
  /* The spacing badge: a paper pill that lifts off any artwork. */
  .gap-badge rect{fill:var(--flx-paper,#fffcf0);stroke:color-mix(in oklab,var(--c-layout-gap) 45%,transparent);stroke-width:1}
  .gap-badge .gap-badge-shadow{fill:rgba(0,0,0,.28);stroke:none;filter:blur(2px)}
  .gap-value{fill:var(--flx-magenta-600,#a02f6f);font:600 12px var(--font-mono,monospace);stroke:none}
  @media (prefers-reduced-motion: reduce){.pin-glyph,.gap-visible{transition:none}}
</style>
