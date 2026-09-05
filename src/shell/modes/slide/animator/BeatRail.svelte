<script lang="ts">
  import { onDestroy, tick } from "svelte";
  import { activeBeat, selTrackIds, commitDeckLive, sealHistory, endpointEdit, enterEndpointEdit } from "../../../../lib/slide/store";
  import { selection, partSelection } from "../../../../lib/store";
  import { trackDuration } from "../../../../lib/slide/compile";
  import { staggerSpan } from "../../../../lib/slide/stagger";
  import { familyOf } from "../../../../lib/slide/family";
  import { slideById, addBeat, deleteBeat, duplicateBeat, reorderBeats, reorderTracks, moveTrackToBeat, duplicateTrack, setBeat, setTrackGroup, groupTracks, ungroupTracks } from "../../../../lib/slide/ops";
  import type { Slide, Track, Beat, TrackGroup } from "../../../../lib/slide/types";
  import type { FluxPlotManifest } from "../../../../lib/plot/types";
  import { PRESET_COLOR, chipLabel, trackFanout, beatEndMs, trackEndMs, snapMs, isDanglingTrack, presetLabel } from "./shared";
  import { hoverTrackId, timelinePxPerMs } from "./animatorState";
  import { deleteSelectedTracks, duplicateSelectedTracks, toggleSelectedDisabled, moveSelectedToBeat } from "./trackActions";
  import { openTrackCascade } from "./cascadeTracks";
  import TimelineMenu, { type MenuItem } from "./TimelineMenu.svelte";

  let { slide, plotTags, manifestFor, onFocusDock, onPreviewFrom, onSeek, time = 0, playing = false }: {
    slide: Slide; plotTags: Map<string,string>; manifestFor: (target:string)=>FluxPlotManifest|undefined;
    onFocusDock: ()=>void; onPreviewFrom?: (beat:number)=>void; onSeek?: (beat:number, time:number)=>void; time?:number; playing?:boolean;
  } = $props();
  const ROW = 30;
  let timelineWidth = $state(700);
  let trackArea = $state<HTMLDivElement | null>(null);
  let selectedOnly = $state(false);
  let menu = $state<{x:number;y:number;items:MenuItem[]} | null>(null);
  let renameGroupId=$state<string|null>(null);
  let renameId = $state<string|null>(null);
  let beatDragId = $state<string|null>(null);
  const beat = $derived(slide.beats[$activeBeat] ?? slide.beats[0]);
  const duration = $derived(Math.max(1000, beatEndMs(beat?.tracks ?? [], slide, manifestFor)));
  const scale = $derived($timelinePxPerMs ?? Math.max(.015, Math.min(.6, (timelineWidth - 240) / duration)));
  const tickStep = $derived(scale > .3 ? 250 : scale > .12 ? 500 : scale > .05 ? 1000 : 2000);
  const ticks = $derived(Array.from({length:Math.floor(duration/tickStep)+1},(_,i)=>i*tickStep));
  const timeWidth = $derived(Math.max(timelineWidth-230, duration*scale+32));
  const fmt = (ms:number) => `${(ms/1000).toFixed(ms % 1000 ? 2 : 0)}s`;
  type Row = {group:TrackGroup; tracks:Track[]} | {track:Track};
  const rows = $derived.by(():Row[] => {
    if (!beat) return [];
    const wanted = selectedOnly && $selection.size ? beat.tracks.filter(t=>$selection.has(t.target)) : beat.tracks;
    const out:Row[] = [], seen = new Set<string>();
    for(const t of wanted) {
      const g = beat.groups?.find(g=>g.id===t.groupId);
      if(!g) out.push({track:t});
      else if(!seen.has(g.id)) {
        seen.add(g.id);
        const members = wanted.filter(t=>t.groupId===g.id);
        out.push({group:g,tracks:members});
        if(!g.collapsed) out.push(...members.map(track=>({track})));
      }
    }
    return out;
  });
  const label = (t:Track)=>chipLabel(t,slide,plotTags);
  const width = (t:Track)=>Math.max(6,trackDuration(t)*scale);
  const tail = (t:Track)=>staggerSpan(t,trackFanout(t,slide,manifestFor(t.target)))*scale;
  function chooseBeat(index:number) {
    activeBeat.set(index); selTrackIds.set([]); onFocusDock();
  }
  function chooseTrack(t:Track, additive=false) {
    if(!t.id) return;
    selTrackIds.update(ids=>additive ? ids.includes(t.id!) ? ids.filter(id=>id!==t.id):[...ids,t.id!] : [t.id!]);
    const chosen=slide.beats.flatMap(b=>b.tracks).filter(t=>t.id&&$selTrackIds.includes(t.id));
    selection.set(new Set(chosen.filter(t=>!t.target.startsWith("@")).map(t=>t.target)));
    partSelection.set(chosen.length===1&&chosen[0].part ? {elementId:chosen[0].target,partId:chosen[0].part} : null);
    onFocusDock();
  }
  function chooseGroup(tracks:Track[]) {
    selTrackIds.set(tracks.map(t=>t.id!).filter(Boolean));
    selection.set(new Set(tracks.filter(t=>!t.target.startsWith("@")).map(t=>t.target)));
    partSelection.set(null); onFocusDock();
  }
  function insert(at:number) { commitDeckLive(d=>addBeat(d,slide.id,{label:`Step ${at}`,advance:"click",at})); chooseBeat(at); }
  function remove(b:Beat) {
    const at=slide.beats.indexOf(b); if(at<=0)return;
    commitDeckLive(d=>deleteBeat(d,slide.id,b.id)); chooseBeat(Math.min(at,slide.beats.length-1));
  }
  function nameBeat(b:Beat,value:string) { if(value.trim()) commitDeckLive(d=>setBeat(d,slide.id,b.id,{label:value.trim()})); renameId=null; }
  function reorderStep(to:number) {
    const id=beatDragId; beatDragId=null; if(!id||to<1)return;
    const order=slide.beats.slice(1).map(b=>b.id).filter(x=>x!==id); order.splice(to-1,0,id);
    commitDeckLive(d=>reorderBeats(d,slide.id,order)); chooseBeat(to);
  }
  export function cascadeSelection(){if($selTrackIds.length>1)openTrackCascade();}
  export function groupSelection() { if($activeBeat>0)commitDeckLive(d=>groupTracks(d,slide.id,beat.id,$selTrackIds,"Group")); }
  export function ungroupSelection() { if($activeBeat>0)commitDeckLive(d=>ungroupTracks(d,slide.id,beat.id,$selTrackIds)); }
  function trackMenu(e:MouseEvent,t:Track) {
    e.preventDefault(); if(!t.id)return;
    if(!$selTrackIds.includes(t.id))chooseTrack(t);
    menu={x:e.clientX,y:e.clientY,items:[
      {label:"Duplicate effects",action:duplicateSelectedTracks},{label:"Enable / disable",action:toggleSelectedDisabled},
      {label:"Group effects",action:groupSelection},{label:"Ungroup effects",action:ungroupSelection},
      ...($selTrackIds.length>1?[{label:"Cascade timing…",action:openTrackCascade}]:[]),
      ...slide.beats.slice(1).map((b,i)=>({label:`Move to ${i+1} · ${b.label||"Step"}`,action:()=>{moveSelectedToBeat(b.id);activeBeat.set(i+1);}})),
      {label:"Delete effects",danger:true,action:deleteSelectedTracks}]};
  }
  function stepMenu(e:MouseEvent,b:Beat,i:number) {
    e.preventDefault(); if(!i)return;
    menu={x:e.clientX,y:e.clientY,items:[{label:"Rename step",action:()=>{activeBeat.set(i);renameId=b.id;}},
      {label:"Duplicate step",action:()=>commitDeckLive(d=>duplicateBeat(d,slide.id,b.id))},
      {label:"Insert before",action:()=>insert(i)},{label:"Insert after",action:()=>insert(i+1)},
      {label:"Delete step",danger:true,action:()=>remove(b)}]};
  }
  type Drag={x:number;y:number;dx:number;kind:"start"|"duration";orig:{id:string;start:number;duration:number}[];primary:string;over:number|null;row:number|null;copy:boolean;moving:boolean;magnets:number[]};
  let drag=$state<Drag|null>(null);
  function down(e:PointerEvent,t:Track,kind:"start"|"duration") {
    if(e.button!==0||!t.id)return;
    e.preventDefault();e.stopPropagation();
    if(e.shiftKey||e.metaKey||e.ctrlKey){chooseTrack(t,true);return;}
    if(!$selTrackIds.includes(t.id))chooseTrack(t); else onFocusDock();
    const selected=beat.tracks.filter(t=>t.id&&$selTrackIds.includes(t.id));
    drag={x:e.clientX,y:e.clientY,dx:0,kind,primary:t.id,orig:selected.map(t=>({id:t.id!,start:t.start??0,duration:trackDuration(t)})),over:null,row:null,copy:e.altKey,moving:false,
      magnets:beat.tracks.filter(t=>!t.id||!$selTrackIds.includes(t.id)).flatMap(t=>[t.start??0,(t.start??0)+trackDuration(t)])};
    window.addEventListener("pointermove",move);window.addEventListener("pointerup",up);window.addEventListener("pointercancel",cancel);
  }
  function move(e:PointerEvent) {
    if(!drag)return; const d=drag;const dx=e.clientX-d.x,dy=e.clientY-d.y;
    if(Math.abs(dx)<3&&Math.abs(dy)<3&&!d.moving)return;
    const target=document.elementFromPoint(e.clientX,e.clientY)?.closest<HTMLElement>("[data-step-index]");
    const over=target?Number(target.dataset.stepIndex):null;
    d.over=over&&over!==$activeBeat?over:null;d.copy=e.altKey;
    d.moving=d.kind==="start"&&(d.over!=null||Math.abs(dy)>ROW*.7);
    const rowNode=document.elementFromPoint(e.clientX,e.clientY)?.closest<HTMLElement>("[data-row-index]");
    d.row=rowNode?Number(rowNode.dataset.rowIndex):null;
    const o=d.orig.find(o=>o.id===d.primary)!;
    const value=d.kind==="start"?o.start:o.duration;
    d.dx=snapMs(value+dx/scale,d.kind==="start"?d.magnets:d.magnets.map(m=>m-o.start),scale,!e.altKey)-value;
    drag={...d};
  }
  function cancel() { drag=null;window.removeEventListener("pointermove",move);window.removeEventListener("pointerup",up);window.removeEventListener("pointercancel",cancel); }
  function up() {
    const d=drag;cancel();if(!d)return;
    const targetBeat=d.over!=null?slide.beats[d.over]:beat;
    if(d.moving) {
      if(!targetBeat)return;
      const selected=new Set(d.orig.map(o=>o.id));
      const targetRow=d.row!=null?rows[d.row]:null;
      const anchor=targetRow&&"track"in targetRow?targetRow.track:targetRow&&"group"in targetRow?targetRow.tracks[0]:null;
      const at=anchor?targetBeat.tracks.findIndex(t=>t.id===anchor.id):targetBeat.tracks.length;
      const moved:string[]=[];
      const groupCopies=(beat.groups??[]).filter(g=>beat.tracks.filter(t=>t.groupId===g.id).every(t=>!!t.id&&selected.has(t.id))).map(g=>({group:{...g},ids:beat.tracks.filter(t=>t.groupId===g.id).map(t=>t.id!)}));
      commitDeckLive(deck=>{
        if(targetBeat.id===beat.id&&!d.copy) {
          const ids=beat.tracks.map(t=>t.id!).filter(Boolean), rest=ids.filter(id=>!selected.has(id));
          const n=at-ids.slice(0,at).filter(id=>selected.has(id)).length;rest.splice(Math.max(0,n),0,...selected);
          reorderTracks(deck,slide.id,beat.id,rest);
        } else for(const o of d.orig) { const id=d.copy?duplicateTrack(deck,slide.id,o.id):o.id; if(id){moveTrackToBeat(deck,slide.id,id,targetBeat.id,at+moved.length);moved.push(id);} }
        if(moved.length && targetBeat.id!==beat.id)for(const g of groupCopies){const ids=g.ids.map(id=>moved[d.orig.findIndex(o=>o.id===id)]).filter(Boolean);if(ids.length){const groupId=groupTracks(deck,slide.id,targetBeat.id,ids,g.group.label);if(groupId&&g.group.collapsed)setTrackGroup(deck,slide.id,targetBeat.id,groupId,{collapsed:true});}}
      });
      if(d.over!=null)activeBeat.set(d.over);if(moved.length)selTrackIds.set(moved);
    } else if(d.dx) {
      commitDeckLive(deck=>{const s=slideById(deck,slide.id);for(const t of s?.beats.flatMap(b=>b.tracks)??[]){const o=d.orig.find(o=>o.id===t.id);if(o)t[d.kind]=Math.max(d.kind==="start"?0:1,o[d.kind]+d.dx);}});
    }
    sealHistory();
  }
  function drawStart(t:Track){const o=drag?.orig.find(o=>o.id===t.id);return Math.max(0,(o&&drag?.kind==="start"&&!drag.moving?o.start+drag.dx:t.start??0))*scale;}
  function drawWidth(t:Track){const o=drag?.orig.find(o=>o.id===t.id);return o&&drag?.kind==="duration"?Math.max(6,(o.duration+drag.dx)*scale):width(t);}
  function wheel(e:WheelEvent){if(e.ctrlKey||e.metaKey){e.preventDefault();timelinePxPerMs.set(Math.max(.015,Math.min(1,scale*Math.exp(-e.deltaY*.002))));}}
  let stopScrub=()=>{};
  function scrub(e:PointerEvent){
    if(!onSeek||e.button!==0)return;e.preventDefault();stopScrub();
    const r=e.currentTarget as HTMLElement;
    const seek=(ev:PointerEvent)=>onSeek?.($activeBeat,Math.max(0,Math.min(duration,(ev.clientX-r.getBoundingClientRect().left)/scale)));
    stopScrub=()=>{window.removeEventListener("pointermove",seek);window.removeEventListener("pointerup",stopScrub);window.removeEventListener("pointercancel",stopScrub);};
    seek(e);window.addEventListener("pointermove",seek);window.addEventListener("pointerup",stopScrub);window.addEventListener("pointercancel",stopScrub);
  }
  function keyCancel(e:KeyboardEvent){if(e.key==="Escape"&&drag){e.preventDefault();cancel();}}
  onDestroy(()=>{cancel();stopScrub();hoverTrackId.set(null);});
  $effect(()=>{const i=$activeBeat;void tick().then(()=>document.querySelector(`[data-step-index="${i}"]`)?.scrollIntoView({block:"nearest",inline:"nearest"}));});
</script>

<svelte:window onkeydown={keyCancel}/>
<div class="beatrail" bind:clientWidth={timelineWidth}>
  <div class="step-strip" aria-label="Presentation steps">
    {#each slide.beats as b,i (b.id)}
      <button class="step" class:active={i===$activeBeat} class:drop={drag?.over===i} data-step-index={i}
        aria-pressed={i===$activeBeat} draggable={i>0} ondragstart={()=>beatDragId=b.id} ondragover={e=>e.preventDefault()} ondrop={e=>{e.preventDefault();reorderStep(i);}} ondragend={()=>beatDragId=null}
        onclick={()=>chooseBeat(i)} oncontextmenu={e=>stepMenu(e,b,i)} title={`${b.label||`Step ${i}`} · ${b.tracks.length} effects`}>
        <span class="step-num">{i||"○"}</span><span>{i===0?"Start":b.label||`Step ${i}`}<small>{i===0?"Initial frame":b.advance==="auto"?`After previous · ${(b.autoDelayMs??600)/1000}s`:b.advance==="with-prev"?"With previous":"On click"}</small></span>
        {#if i>0}<span class="count">{b.tracks.length}</span>{/if}
      </button>
    {/each}
    <button class="new-step" onclick={()=>insert(slide.beats.length)} title="Add presentation step">+ Step</button>
  </div>
  <div class="step-controls">
    {#if $activeBeat>0}
      {#if renameId===beat.id}<input class="step-name" aria-label="Step name" value={beat.label??""} onblur={e=>nameBeat(beat,e.currentTarget.value)} onkeydown={e=>{e.stopPropagation();if(e.key==="Enter")e.currentTarget.blur();if(e.key==="Escape")renameId=null;}}/>
      {:else}<button class="step-title" onclick={()=>renameId=beat.id} title="Rename step">{beat.label||`Step ${$activeBeat}`} ✎</button>{/if}
      <select aria-label="Step trigger" value={beat.advance??"click"} onchange={e=>commitDeckLive(d=>setBeat(d,slide.id,beat.id,{advance:e.currentTarget.value as Beat["advance"]}))}>
        <option value="click">On click</option><option value="with-prev">With previous</option><option value="auto">After previous</option>
      </select>
      {#if beat.advance==="auto"}<label class="delay-label">Wait <input type="number" aria-label="Automatic delay in milliseconds" min="0" step="100" value={beat.autoDelayMs??600} onchange={e=>commitDeckLive(d=>setBeat(d,slide.id,beat.id,{autoDelayMs:Math.max(0,+e.currentTarget.value)}))}/> ms</label>{/if}
      <span class="duration">{fmt(beatEndMs(beat.tracks,slide,manifestFor))}</span>
      <button onclick={()=>onPreviewFrom?.($activeBeat)} title="Replay this step">▶ Step</button>
      <button onclick={e=>stepMenu(e,beat,$activeBeat)} aria-label="Step actions">•••</button>
    {:else}<span class="start-note">The initial presentation frame. Select Design to arrange all objects.</span>{/if}
    <label class="filter"><input type="checkbox" bind:checked={selectedOnly}/> Selected objects</label>
  </div>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="timeline-scroll" onwheel={wheel} bind:this={trackArea}>
    <div class="timeline" style={`--time-w:${timeWidth}px;--row:${ROW}px`}>
      <div class="ruler-row"><div class="label-head">Object / effect</div>
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div class="ruler" onpointerdown={scrub} title="Drag to inspect any frame">
          {#each ticks as t}<span class="tick" style={`left:${t*scale}px`}>{fmt(t)}</span>{/each}
          <span class="ruler-head" style={`transform:translateX(${time*scale}px)`}></span>
        </div>
      </div>
      {#if !rows.length}<div class="empty">{$activeBeat===0?"Select an object, then choose Appear, Change, Emphasize, or Disappear.":"No effects in this step. Select an object or plot part and add an effect above."}</div>{/if}
      {#each rows as row,ri ("group"in row?row.group.id:row.track.id??ri)}
        {#if "group"in row}
          <div class="lane-row group" data-row-index={ri}>
            <div class="target-label"><button class="chevron" aria-label={row.group.collapsed?"Expand group":"Collapse group"} onclick={()=>commitDeckLive(d=>setTrackGroup(d,slide.id,beat.id,row.group.id,{collapsed:!row.group.collapsed}))}>{row.group.collapsed?"▸":"▾"}</button>{#if renameGroupId===row.group.id}<input class="group-title" aria-label="Group name" value={row.group.label} onblur={e=>{if(e.currentTarget.value.trim())commitDeckLive(d=>setTrackGroup(d,slide.id,beat.id,row.group.id,{label:e.currentTarget.value.trim()}));renameGroupId=null;}} onkeydown={e=>{e.stopPropagation();if(e.key==="Enter")e.currentTarget.blur();if(e.key==="Escape")renameGroupId=null;}}/>{:else}<button class="group-name" title="Select group · double-click to rename" onclick={()=>chooseGroup(row.tracks)} ondblclick={()=>renameGroupId=row.group.id}>{row.group.label} <small>{row.tracks.length}</small></button>{/if}</div>
            <div class="time-cell"><!-- svelte-ignore a11y_no_static_element_interactions --><span class="group-span" title="Drag to retime or move this group" onpointerdown={e=>{chooseGroup(row.tracks);down(e,row.tracks[0],"start");}} style={`left:${Math.min(...row.tracks.map(t=>t.start??0))*scale}px;width:${Math.max(8,(Math.max(...row.tracks.map(t=>trackEndMs(t,slide,manifestFor(t.target))))-Math.min(...row.tracks.map(t=>t.start??0)))*scale)}px`}></span></div>
          </div>
        {:else}{@const t=row.track}{@const tx=familyOf(t)==="transform"}
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div class="lane-row" class:selected={!!t.id&&$selTrackIds.includes(t.id)} class:disabled={t.disabled} class:missing={isDanglingTrack(t,slide)} data-row-index={ri} data-track-id={t.id} style={`--pc:${PRESET_COLOR[t.preset??"fade"]??"#4385be"}`} onpointerenter={()=>hoverTrackId.set(t.id??null)} onpointerleave={()=>hoverTrackId.set(null)} oncontextmenu={e=>trackMenu(e,t)}>
            <button class="target-label track-label" onclick={e=>chooseTrack(t,e.shiftKey||e.metaKey||e.ctrlKey)} title={`${label(t)} · ${presetLabel(t.preset??"fade")}`}>
              <span class="target-name">{#if isDanglingTrack(t,slide)}⚠ {/if}{label(t)}</span><small>{presetLabel(t.preset??"fade")}{t.disabled?" · disabled":""}</small>
            </button>
            <div class="time-cell">
              <!-- svelte-ignore a11y_no_static_element_interactions -->
              <div class="trk" class:tx class:sel={!!t.id&&$selTrackIds.includes(t.id)} style={`left:${drawStart(t)}px;width:${drawWidth(t)}px`} title={`${fmt(t.start??0)} → ${fmt((t.start??0)+trackDuration(t))} · drag to retime; vertical drag reorders; drag onto a step to move (Alt copies)`} onpointerdown={e=>down(e,t,"start")}>
                {#if tail(t)>0}<span class="tail" style={`width:${tail(t)}px`}></span>{/if}
                <span class="bar-time">{fmt(trackDuration(t))}</span>
                <!-- svelte-ignore a11y_no_static_element_interactions --><span class="edge" onpointerdown={e=>down(e,t,"duration")}></span>
              </div>
            </div>
          </div>
        {/if}
      {/each}
      <!-- One compositor line spans every lane; playback must not rewrite a
           layout property in every track on every frame. -->
      <span class="playhead" style={`transform:translateX(${time*scale}px)`}></span>
    </div>
  </div>
  {#if drag}<div class="drag-status">{drag.moving?drag.over!=null?`${drag.copy?"Copy":"Move"} to step ${drag.over}`:"Move effect row":`${drag.kind}: ${fmt(Math.max(0,(drag.orig.find(o=>o.id===drag?.primary)?.[drag.kind]??0)+drag.dx))}`} · Escape cancels</div>{/if}
</div>
{#if menu}<TimelineMenu x={menu.x} y={menu.y} items={menu.items} onClose={()=>menu=null}/>{/if}

<style>
  .group-title{width:160px;min-width:0;background:var(--c-bg);color:var(--c-tx);border:1px solid var(--c-line);font:inherit;padding:3px 5px;}
.beatrail{display:flex;flex-direction:column;min-width:0;min-height:0;flex:1;gap:8px;position:relative;font-size:12px}
.step-strip{display:flex;gap:5px;overflow-x:auto;flex:0 0 auto;padding:2px 1px 6px}
button,input,select{font:inherit;color:var(--c-tx);background:var(--c-bg-2);border:1px solid var(--c-line-strong);border-radius:5px}
button{cursor:pointer}button:hover{border-color:var(--c-accent)}button:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid var(--c-accent);outline-offset:1px}
.step{display:flex;gap:8px;align-items:center;flex:0 0 auto;text-align:left;padding:7px 10px;min-width:115px;max-width:220px}
.step small{display:block;color:var(--c-tx-3);font-size:10px;margin-top:3px}.step.active{border-color:var(--c-accent);background:color-mix(in oklab,var(--c-accent) 13%,var(--c-bg))}.step.drop{outline:2px dashed var(--c-accent)}
.step-num{font:600 12px var(--font-mono);color:var(--c-accent)}.count{margin-left:auto;color:var(--c-tx-3);font-size:10px}.new-step{padding:7px 12px;white-space:nowrap}
.step-controls{display:flex;align-items:center;gap:8px;min-height:28px;flex-wrap:wrap}.step-controls button,.step-controls select{padding:4px 7px}.step-title{font-weight:600;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.step-name{width:170px;padding:4px}.duration{font:11px var(--font-mono);color:var(--c-tx-2)}.delay-label{font-size:11px}.delay-label input{width:60px;padding:3px}.filter{margin-left:auto;display:flex;align-items:center;gap:4px;font-size:11px;color:var(--c-tx-2)}.filter input{margin:0}.start-note{color:var(--c-tx-2);font-size:11px}
.timeline-scroll{overflow:auto;min-height:55px;flex:1;border:1px solid var(--c-line);border-radius:6px}.timeline{width:max-content;min-width:100%;position:relative}.ruler-row,.lane-row{display:grid;grid-template-columns:220px var(--time-w)}.ruler-row{position:sticky;top:0;z-index:5;background:var(--c-bg-2);height:25px;border-bottom:1px solid var(--c-line)}.label-head{position:sticky;left:0;z-index:6;background:var(--c-bg-2);padding:5px 9px;font-size:11px;color:var(--c-tx-2);border-right:1px solid var(--c-line)}.ruler{position:relative;cursor:crosshair}.tick{position:absolute;top:3px;border-left:1px solid var(--c-line);padding-left:3px;font:10px var(--font-mono);color:var(--c-tx-2);height:20px}.ruler-head{position:absolute;bottom:0;left:-5px;width:0;height:0;border-left:5px solid transparent;border-right:5px solid transparent;border-top:7px solid var(--c-accent);}
.lane-row{height:var(--row);border-bottom:1px solid color-mix(in oklab,var(--c-line) 65%,transparent)}.lane-row.selected{background:color-mix(in oklab,var(--c-accent) 8%,transparent)}.lane-row.disabled{opacity:.5}.target-label{position:sticky;left:0;z-index:3;background:var(--c-bg);border:0;border-right:1px solid var(--c-line);border-radius:0;padding:3px 9px;display:flex;align-items:center;gap:7px;min-width:0}.track-label{text-align:left;display:block}.target-name{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px}.track-label small{display:block;font-size:9px;color:var(--c-tx-3);line-height:11px}.selected .target-label{background:color-mix(in oklab,var(--c-accent) 14%,var(--c-bg))}.missing .target-name{color:var(--c-warning)}.time-cell{position:relative}.group .target-label{background:var(--c-bg-2)}.group-name,.chevron{border:0;background:none;text-align:left;font-weight:600;padding:0}.group-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.group-name small{font-weight:400;color:var(--c-tx-3)}.group-span{position:absolute;top:13px;height:3px;background:var(--c-tx-3);border-radius:2px}
.trk{position:absolute;top:6px;height:18px;min-width:6px;border:1px solid var(--pc);background:color-mix(in oklab,var(--pc) 28%,var(--c-bg-2));border-radius:4px;cursor:grab;user-select:none;box-sizing:border-box}.trk.sel{outline:2px solid var(--pc);outline-offset:1px}.trk.tx{background:color-mix(in oklab,var(--pc) 16%,var(--c-bg-2))}.bar-time{display:block;overflow:hidden;white-space:nowrap;font:9px/16px var(--font-mono);padding:0 5px;color:var(--c-tx)}.edge{position:absolute;right:-4px;width:9px;top:-3px;bottom:-3px;cursor:ew-resize}.tail{position:absolute;left:100%;top:6px;height:5px;pointer-events:none;background:repeating-linear-gradient(-45deg,var(--pc) 0 2px,transparent 2px 5px)}.playhead{position:absolute;top:25px;bottom:0;left:220px;width:1px;background:var(--c-accent);pointer-events:none;opacity:.7}.empty{width:min(600px,90vw);padding:18px;color:var(--c-tx-2);font-size:12px;line-height:1.6}.drag-status{position:absolute;bottom:0;right:10px;padding:5px 10px;background:var(--c-bg);border:1px solid var(--c-accent);border-radius:5px;z-index:10;font:11px var(--font-mono)}
</style>
