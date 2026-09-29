// Hover resolves through DOM hit testing + prepared model/part indexes. Structural
// budgets are primary; record p95/worst so the owner can inspect the 16ms target.
import { mkdirSync, writeFileSync } from 'node:fs';
import { launch, gotoApp, realErrors, APP_URL } from './lib/driver.mjs';
import { harness } from './lib/harness.mjs';
import { seedAnnotationFigure, openAnnotation, cancelAnnotation, findPlotPoint } from './lib/annotationFixture.mjs';
const h=harness('verify-scale-annotate-hover'),{browser,page}=await launch({width:1500,height:1000});
const profiles=[];
try{
 await gotoApp(page,{url:APP_URL+'?fixture=demo'});
 for(const count of [1600,5000]){
  await seedAnnotationFigure(page,count);const point=await findPlotPoint(page);await openAnnotation(page);
  const report=await page.evaluate(async({count,point})=>{
   const R=await import('/src/lib/bridge/targetResolvers.ts'),C=await import('/src/lib/bridge/canvasTargets.ts');
   const before={...C.canvasTargetStats},rootBefore=R.targetResolutionStats.roots,callBefore=R.targetResolutionStats.calls;
   let scans=0;const query=Element.prototype.querySelectorAll;Element.prototype.querySelectorAll=function(...args){scans++;return query.apply(this,args);};
   const times=[];let correct=0;
   try{for(let i=0;i<200;i++){const start=performance.now();const hits=R.resolveAt(point.x,point.y,{ignore:document.querySelector('[data-annotation-surface]')});times.push(performance.now()-start);if(hits[0]?.ref.kind==='part')correct++;}}
   finally{Element.prototype.querySelectorAll=query;}
   times.sort((a,b)=>a-b);
   return {count,correct,scans,modelVisits:C.canvasTargetStats.modelVisits-before.modelVisits,partIndexBuilds:C.canvasTargetStats.partIndexBuilds-before.partIndexBuilds,domScans:C.canvasTargetStats.domScans-before.domScans,roots:R.targetResolutionStats.roots-rootBefore,calls:R.targetResolutionStats.calls-callBefore,p95:times[189],worst:times.at(-1)};
  },{count,point});profiles.push(report);
  h.ok(report.correct===200,`${count} elements: every hover resolves a semantic part`);
  h.ok(report.modelVisits===0&&report.partIndexBuilds===0&&report.domScans===0&&report.scans===0,`${count}: no scene/tree/DOM scans on the hover path`);
  h.ok(report.roots<=report.calls*12,`${count}: bounded resolver-root work, independent of scene size`);
  h.ok(report.p95<=16,`${count}: hover p95 ${report.p95.toFixed(2)}ms ≤16ms`);
  await cancelAnnotation(page);
 }
 h.ok((await realErrors(page)).length===0,'Clean scale console');
 mkdirSync('test-results',{recursive:true});writeFileSync('test-results/scale-annotate-hover.json',JSON.stringify(profiles,null,2));
}finally{await browser.close();}
await h.done();
