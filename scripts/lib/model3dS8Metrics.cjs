'use strict';
const p95 = values => { if (!Array.isArray(values)||!values.length || values.some(x=>!Number.isFinite(x)||x<0)) throw Error('S8 needs finite nonempty raw samples'); return [...values].sort((a,b)=>a-b)[Math.min(values.length-1,Math.floor(values.length*.95))]; };
function qualificationSamples(raw,phase) {
  if(!['hover','panSmall','zoom','typing'].includes(phase))throw Error('Unknown S8 phase');
  const values=raw?.rawTimings?.[phase==='typing'?'keyPaint':'frameGaps'];
  p95(values); // Fail closed: legacy rounded summaries are never qualification samples.
  return values.slice();
}
function compareCohorts(cohorts) {
  if (cohorts.map(c=>c.variant).join(',')!=='model,image,image,model') throw Error('S8 requires the complete ABBA cohort');
  for(const cohort of cohorts)for(const phase of['hover','panSmall','zoom','typing'])p95(cohort.samples?.[phase]);
  return Object.fromEntries(['hover','panSmall','zoom','typing'].map(phase=>{
    const collect=variant=>cohorts.filter(c=>c.variant===variant).flatMap(c=>c.samples[phase]);
    const model=collect('model'), image=collect('image'), modelP95=p95(model), imageP95=p95(image);
    if (imageP95===0) throw Error('S8 baseline cannot have a zero frame/paint duration');
    return [phase,{modelP95,imageP95,ratio:modelP95/imageP95,modelSamples:model.length,imageSamples:image.length,ok:modelP95<=imageP95*1.1}];
  }));
}
module.exports={p95,qualificationSamples,compareCohorts};
