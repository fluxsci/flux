<script lang="ts">
  import { project,commit } from "../store";
  import { plotManifests } from "./store";
  import { setPlotLayoutMode } from "../ops";
  import { buildRelayoutModel,targetFigureSize } from "./relayout/model";
  import { solveRelayout } from "./relayout/solve";
  import { stretchReport,reportText } from "./relayout/report";
  import { settings } from "../settings";
  import { formatSizePx } from "../figure/physicalUnits";
  export let elementId:string;
  $: element=$project.figures.flatMap(f=>f.elements).find(e=>e.id===elementId);
  $: plot=element?.type==="plot"?element:null;
  $: manifest=plot?$plotManifests[plot.assetId]:undefined;
  $: model=buildRelayoutModel(manifest);
  $: report=plot?.layoutMode==="stretch"?stretchReport("layout:stretch"):plot&&model.supported?solveRelayout(model,targetFigureSize(plot)).report:model.supported?stretchReport("layout:missing"):model.report;
  $: native=manifest?.layout?.figure;
  function nativeSize(){
    if(!native)return;
    commit(p=>{const el=p.figures.flatMap(f=>f.elements).find(e=>e.id===elementId);if(el?.type!=="plot")return;el.width=native!.widthPt/.75*(el.contentScale??1);el.height=native!.heightPt/.75*(el.contentScale??1);});
  }
</script>
{#if plot}
  <div class="layout-controls" data-plot-layout>
    <div class="row"><span>Layout</span><div class="segments" aria-label="Plot layout">
      <button disabled={!model.supported} aria-pressed={plot.layoutMode!=="stretch"&&model.supported} on:click={()=>commit(p=>setPlotLayoutMode(p,[elementId],null))}>Reflow</button>
      <button aria-pressed={plot.layoutMode==="stretch"||!model.supported} on:click={()=>commit(p=>setPlotLayoutMode(p,[elementId],"stretch"))}>Stretch</button>
    </div></div>
    <p class="status" data-relayout-status title={report.warnings.map(w=>w.code+(w.ids?": "+w.ids.join(", "):"")).join("\n")}>{reportText(report)}</p>
    {#if native&&model.supported}
      <div class="row figsize"><span>{formatSizePx(plot.width/(plot.contentScale??1),plot.height/(plot.contentScale??1),$settings.physicalUnit)}</span><button class="native" on:click={nativeSize}>Native size</button></div>
    {/if}
  </div>
{/if}
<style>
  .layout-controls{padding:6px 0;font-size:var(--ts-xs);border-top:1px solid var(--c-line)}
  .row{display:flex;align-items:center;justify-content:space-between;gap:8px}.segments{display:flex;border:1px solid var(--c-line);border-radius:var(--r-ui)}
  button{font:inherit;color:var(--c-tx);background:transparent;border:0;padding:4px 8px;cursor:var(--cursor-cross-hover)}
  button[aria-pressed="true"]{background:var(--c-accent-tint);box-shadow:inset 0 -2px var(--c-accent)}button:disabled{opacity:.4}
  .status{margin:5px 0;color:var(--c-tx-muted)}.figsize{font-family:var(--font-mono)}.native{border:1px solid var(--c-line);border-radius:var(--r-ui)}
</style>
