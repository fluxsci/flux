<script lang="ts">
  /** Crystallize on the canvas: a small offer at the selection's corner whenever a loose selection
   * has a row, column or grid it is close to, a preview of that arrangement while the offer is
   * hovered, and one short word afterwards for what was recognized. Screen-space chrome only:
   * nothing here touches the model (interact/alignArrange.ts owns the action). */
  import { onDestroy } from 'svelte';
  import { crystallizeOffer, crystallizeNotice, crystallizeSelection, crystallizeLabel } from './interact/alignArrange';
  import type { Viewport } from './types';
  export let viewport: Viewport;
  export let figureX=0;
  export let figureY=0;
  export let width=0;
  export let height=0;
  const SIZE=22, GAP=9, NOTICE_MS=1400, PREVIEW_UNITS=400;
  let previewing=false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const shown={notice:0};
  // Explicit projection dependencies (legacy Svelte cannot see reads inside helper closures).
  $: projection={zoom:viewport.zoom,x:viewport.panX+figureX*viewport.zoom,y:viewport.panY+figureY*viewport.zoom};
  const sx=(x:number,p:typeof projection)=>p.x+x*p.zoom;
  const sy=(y:number,p:typeof projection)=>p.y+y*p.zoom;
  /** Just outside the selection's bottom-right corner, kept inside the canvas. */
  const corner=(b:{x:number;y:number;w:number;h:number},w:number,p:typeof projection)=>({
    x:Math.max(4,Math.min(width-w-4,sx(b.x+b.w,p)+GAP)),
    y:Math.max(4,Math.min(height-SIZE-4,sy(b.y+b.h,p)+GAP)),
  });
  $: offer=$crystallizeOffer;
  $: notice=offer?null:$crystallizeNotice;
  $: if(!offer)previewing=false;
  $: spot=offer?corner(offer.bounds,SIZE,projection):null;
  $: label=notice?crystallizeLabel(notice):'';
  $: noticeW=Math.ceil(label.length*6.4)+36;
  $: noticeSpot=notice?corner(notice.bounds,noticeW,projection):null;
  // One short showing per Crystallize; a new offer (Undo, another selection) retires it at once.
  $: if(offer&&$crystallizeNotice)crystallizeNotice.set(null);
  $: if(notice&&notice.id!==shown.notice) {
    shown.notice=notice.id;clearTimeout(timer);
    const id=notice.id;
    timer=setTimeout(()=>crystallizeNotice.update(n=>n?.id===id?null:n),NOTICE_MS);
  }
  function press(e:PointerEvent) { e.preventDefault();e.stopPropagation(); }
  function run(e:MouseEvent) { e.preventDefault();e.stopPropagation();previewing=false;crystallizeSelection(); }
  onDestroy(()=>clearTimeout(timer));
</script>

<!-- The word is a glance, never in the way: the next press anywhere retires it. -->
<svelte:window on:pointerdown|capture={()=>{if($crystallizeNotice)crystallizeNotice.set(null);}} />

{#if offer && spot}
  {#if previewing}
    <!-- Where everything would land: the arrangement's gutters and each object's place. -->
    <g class="crystal-preview" aria-hidden="true">
      {#each offer.plan.gaps as g (`${g.axis}-${g.index}`)}
        <line x1={sx(g.x1,projection)} y1={sy(g.y1,projection)} x2={sx(g.x2,projection)} y2={sy(g.y2,projection)} />
      {/each}
      {#if offer.plan.units.length<=PREVIEW_UNITS}
        {#each offer.plan.units as u (u.key)}
          <rect x={sx(u.bounds.x,projection)} y={sy(u.bounds.y,projection)} width={u.bounds.w*projection.zoom} height={u.bounds.h*projection.zoom} />
        {/each}
      {/if}
    </g>
  {/if}
  <!-- The keyboard's way in is Shift+A itself; this is the pointer's. -->
  <!-- svelte-ignore a11y_no_static_element_interactions a11y_click_events_have_key_events -->
  <g class="crystallize" class:previewing data-crystallize role="button" tabindex="-1" aria-label={`Crystallize into ${crystallizeLabel(offer).toLowerCase()}`}
    transform={`translate(${spot.x} ${spot.y})`}
    on:pointerdown={press} on:click={run}
    on:pointerenter={()=>previewing=true} on:pointerleave={()=>previewing=false}>
    <title>Crystallize · {crystallizeLabel(offer)} (Shift+A)</title>
    <rect class="crystal-shadow" x="0" y="1" width={SIZE} height={SIZE} rx="4" />
    <rect class="crystal-face" width={SIZE} height={SIZE} rx="4" />
    <g class="crystal-mark" transform="translate(3 3)">
      <path d="M1.5 5h13M1.5 11h13M5 1.5v13M11 1.5v13" />
      <circle cx="5" cy="5" r="1.7" /><circle cx="11" cy="5" r="1.7" /><circle cx="5" cy="11" r="1.7" /><circle cx="11" cy="11" r="1.7" />
    </g>
  </g>
{:else if notice && noticeSpot}
  {#key notice.id}
    <g class="crystal-notice" data-crystallize-notice role="status" transform={`translate(${noticeSpot.x} ${noticeSpot.y})`}>
      <rect class="crystal-shadow" x="0" y="1" width={noticeW} height={SIZE} rx="11" />
      <rect class="crystal-face" width={noticeW} height={SIZE} rx="11" />
      <g class="crystal-mark" transform="translate(7 3)">
        <path d="M1.5 5h13M1.5 11h13M5 1.5v13M11 1.5v13" />
        <circle cx="5" cy="5" r="1.7" /><circle cx="11" cy="5" r="1.7" /><circle cx="5" cy="11" r="1.7" /><circle cx="11" cy="11" r="1.7" />
      </g>
      <text x="28" y="15">{label}</text>
    </g>
  {/key}
{/if}

<style>
  /* The gap badge's paper pill: legible on any artwork, in Align & Arrange's own colour. */
  .crystallize{cursor:var(--cursor-cross-hover);pointer-events:all;outline:none}
  .crystal-face{fill:var(--flx-paper,#fffcf0);stroke:color-mix(in oklab,var(--c-layout-gap,#ce5d97) 45%,transparent);stroke-width:1;transition:fill 80ms linear,stroke 80ms linear}
  .crystal-shadow{fill:rgba(0,0,0,.28);stroke:none;filter:blur(2px)}
  .crystal-mark{color:var(--flx-magenta-600,#a02f6f);pointer-events:none}
  .crystal-mark path{fill:none;stroke:currentColor;stroke-width:1;stroke-linecap:round;opacity:.5}
  .crystal-mark circle{fill:currentColor;stroke:none}
  .crystallize:hover .crystal-face,.crystallize.previewing .crystal-face{fill:color-mix(in oklab,var(--c-layout-gap,#ce5d97) 14%,var(--flx-paper,#fffcf0));stroke:var(--c-layout-gap,#ce5d97)}
  .crystal-preview{pointer-events:none}
  .crystal-preview line{stroke:var(--c-layout-gap,#ce5d97);stroke-width:1.25;opacity:.75}
  .crystal-preview rect{fill:var(--c-layout-gap-tint,rgba(206,93,151,.15));stroke:var(--c-layout-gap,#ce5d97);stroke-width:1;stroke-dasharray:3 2}
  .crystal-notice{pointer-events:none;animation:crystal-notice 1400ms linear both}
  .crystal-notice text{fill:var(--flx-magenta-600,#a02f6f);font:600 11px var(--font-mono,monospace);stroke:none}
  @keyframes crystal-notice{0%,88%{opacity:1}100%{opacity:0}}
  @media (prefers-reduced-motion: reduce){.crystal-face{transition:none}}
</style>
