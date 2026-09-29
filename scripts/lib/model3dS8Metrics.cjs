'use strict';
const p95 = values => { if (!Array.isArray(values)||!values.length || values.some(x=>!Number.isFinite(x)||x<0)) throw Error('S8 needs finite nonempty raw samples'); return [...values].sort((a,b)=>a-b)[Math.min(values.length-1,Math.floor(values.length*.95))]; };
function qualificationSamples(raw,phase) {
  if(!['hover','panSmall','zoom','typing'].includes(phase))throw Error('Unknown S8 phase');
  const values=raw?.rawTimings?.[phase==='typing'?'keyPaint':'frameGaps'];
  p95(values); // Fail closed: legacy rounded summaries are never qualification samples.
  return values.slice();
}
const { idleVsyncMs: idleVsyncFrom } = require('./model3dNativeScaleBudget.cjs');
/** Review R2: `model <= image * 1.1` alone is flaky at vsync granularity (one
 * extra refresh on a ~16.7 ms p95 is a 100 % "regression"). The budget is
 * max(image * 1.1, image + one idle vsync) from a control in the same run. */
function compareCohorts(cohorts, { idleVsyncMs } = {}) {
  if (!Number.isFinite(idleVsyncMs) || idleVsyncMs <= 0) throw Error('S8 requires a measured idle vsync control');
  if (cohorts.map(c=>c.variant).join(',')!=='model,image,image,model') throw Error('S8 requires the complete ABBA cohort');
  for(const cohort of cohorts)for(const phase of['hover','panSmall','zoom','typing'])p95(cohort.samples?.[phase]);
  return Object.fromEntries(['hover','panSmall','zoom','typing'].map(phase=>{
    const collect=variant=>cohorts.filter(c=>c.variant===variant).flatMap(c=>c.samples[phase]);
    const model=collect('model'), image=collect('image'), modelP95=p95(model), imageP95=p95(image);
    if (imageP95===0) throw Error('S8 baseline cannot have a zero frame/paint duration');
    const budgetMs=Math.max(imageP95*1.1,imageP95+idleVsyncMs);
    return [phase,{modelP95,imageP95,ratio:modelP95/imageP95,budgetMs,idleVsyncMs,modelSamples:model.length,imageSamples:image.length,ok:modelP95<=budgetMs}];
  }));
}
/** Pooled idle vsync over every cohort's recorded idle rAF control. */
function cohortIdleVsyncMs(controls){ if(!Array.isArray(controls)||!controls.length)throw Error('S8 requires an idle vsync control per cohort'); return idleVsyncFrom(controls.flatMap(c=>c?.gaps??[])); }
module.exports={p95,qualificationSamples,compareCohorts,cohortIdleVsyncMs};
