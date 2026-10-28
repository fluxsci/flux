'use strict';
const assert = require('node:assert/strict');
const { configureWindow, assertWindow, renderedCamera, deepZoomNotches, deepZoomDelivered } = require('./perf/input-probe-policy.cjs');
const { assertUsableDisplay, qualifiedNativeBounds, assertNativePointerTarget } = require('./lib/nativeWindowQualification.cjs');
async function main() {
  const { harness } = await import('./lib/harness.mjs'); const h = harness('verify-input-probe-policy');
  h.eq(renderedCamera({matrix:{a:1.25,e:3,f:-4},baked:2}),{zoom:2.5,panX:3,panY:-4,proxy:false},'live camera multiplies baked SVG scale by residual transform');
  const proxy={worldBox:'-10 -20 100 50',rasterSize:'200 100',matrix:{a:1.5,e:40,f:50}};
  h.eq(renderedCamera({proxy,matrix:{a:1,e:0,f:0},baked:.25}),{zoom:3,panX:70,panY:110,proxy:true},'active proxy camera uses world/raster geometry instead of the frozen live SVG');
  for(const bad of [{...proxy,rasterSize:'0 100'},{...proxy,worldBox:'0 0 0 50'},{...proxy,matrix:{a:NaN,e:0,f:0}}]) assert.throws(()=>renderedCamera({proxy:bad,matrix:{a:1,e:0,f:0},baked:1}),/proxy camera/);
  assert.throws(()=>renderedCamera({matrix:{a:1,e:0,f:0},baked:NaN}),/live camera/);
  h.ok(true,'invalid proxy/live camera fails instead of topping up against false geometry');
  h.eq([deepZoomNotches(1.2326599263863325),deepZoomNotches(.05)],[15,33],'deep in-bursts derive actual notch counts from two different resting scales');
  assert.throws(()=>deepZoomNotches(0),RangeError);assert.throws(()=>deepZoomNotches(Infinity),RangeError);
  h.ok(true,'invalid deep starting zoom cannot fabricate an injection count');
  const batch=sent=>({sent,delivered:sent,complete:true});
  const deepPhase={preciseWheel:false,wheels:189,deepZoom:{target:16,cycles:[15,33,33].map(n=>({afterIn:{zoom:18},inBatches:[batch(n)],out:batch(36)}))}};
  h.ok(deepZoomDelivered(deepPhase),'three exact16x cycles with36out each accept189 actual delivered inputs rather than a hardcoded216');
  const invalid=[];
  {const p=structuredClone(deepPhase);p.wheels--;invalid.push(p);}
  {const p=structuredClone(deepPhase);p.deepZoom.cycles[0].out.delivered--;invalid.push(p);}
  {const p=structuredClone(deepPhase);p.deepZoom.cycles[0].afterIn.zoom=256;invalid.push(p);}
  {const p=structuredClone(deepPhase);p.deepZoom.cycles[0].afterIn.zoom=1.23;invalid.push(p);}
  {const p=structuredClone(deepPhase);p.deepZoom.cycles.pop();invalid.push(p);}
  {const p=structuredClone(deepPhase);p.deepZoom.cycles[0].out.sent=35;invalid.push(p);}
  h.ok(invalid.every(p=>!deepZoomDelivered(p)),'lost events, accidental256x, frozen-camera scale, missing cycle and shortened out burst all fail the deep contract');
  const calls = [], win = { webContents: { setBackgroundThrottling: value=>calls.push(value) }, isVisible:()=>true, isFocused:()=>true };
  const displays = [{ bounds: { width: 1920, height: 1080 } }];
  h.eq(configureWindow({qualify:false,win,displays}).mode,'diagnostic','default probe remains explicitly diagnostic');
  h.eq(calls,[false],'diagnostic default retains existing throttling behavior'); calls.length=0;
  h.eq(configureWindow({qualify:true,win,displays}),{mode:'qualified',productBackgroundThrottlingPreserved:true},'qualification reports preserved production policy');
  h.eq(calls,[],'qualification never changes background throttling');
  for(const invalid of [[],[{bounds:{width:0,height:0}}],[{bounds:{width:1920,height:0}}],[{bounds:{width:Infinity,height:1080}}]]) assert.throws(()=>assertUsableDisplay(invalid),error=>error.code==='NATIVE_DISPLAY_UNAVAILABLE');
  h.ok(true,'empty, zero-area, and invalid native displays cannot qualify');
  assertUsableDisplay([{bounds:{width:0,height:0}},...displays]); h.ok(true,'a real additional display permits qualification');
  const good={visible:'visible',focused:true}; assertWindow(win,[good,good]); h.ok(true,'visible focused cohort is accepted');
  for(const observations of [[],[good,{visible:'hidden',focused:true},good],[good,{visible:'visible',focused:false},good]]) assert.throws(()=>assertWindow(win,observations),/visible focused/);
  h.ok(true,'empty or temporarily unfocused/hidden cohort fails even after recovery');
  assert.throws(()=>assertWindow({...win,isFocused:()=>false},[good]),/visible focused/); assert.throws(()=>assertWindow({...win,isVisible:()=>false},[good]),/visible focused/); h.ok(true,'native window state must agree with renderer observations');
  const target={...good,point:{x:25,y:30},rect:{left:20,top:20,right:40,bottom:40},viewport:{width:100,height:100},matches:true,disabled:false};
  assertNativePointerTarget(win,target);h.ok(true,'native pointer target accepts a visible hit-tested point');
  for(const change of [{matches:false},{disabled:true},{point:{x:40,y:30}},{point:{x:25,y:100}},{rect:{left:20,top:20,right:20,bottom:40}},{point:{x:NaN,y:30}}]) assert.throws(()=>assertNativePointerTarget(win,{...target,...change}),error=>error.code==='NATIVE_TARGET_UNAVAILABLE');
  h.ok(true,'covered, disabled, clipped, degenerate and nonfinite pointer targets refuse before input');
  assert.throws(()=>assertNativePointerTarget({...win,isFocused:()=>false},target),error=>error.code==='NATIVE_DISPLAY_UNAVAILABLE');
  assert.throws(()=>assertNativePointerTarget(win,{...target,focused:false}),error=>error.code==='NATIVE_DISPLAY_UNAVAILABLE');
  h.ok(true,'native and renderer focus loss stay distinct from a target-layout failure');
  const primary={bounds:{x:0,y:0,width:1470,height:923},workArea:{x:0,y:0,width:1470,height:923}};
  h.eq(qualifiedNativeBounds([primary],primary,1440,1040),{x:10,y:10,width:1440,height:903},'native fixture is capped to the actual1470x923 display with ten-pixel margins');
  const offset={bounds:{x:-1920,y:0,width:1920,height:1080},workArea:{x:-1920,y:25,width:1920,height:1055}};
  h.eq(qualifiedNativeBounds([offset],offset,1440,891),{x:-1910,y:35,width:1440,height:891},'qualified bounds preserve a nonzero desktop origin and smaller requested dimensions');
  for(const area of [{x:0,y:0,width:0,height:0},{x:0,y:0,width:20,height:900},{x:0,y:0,width:Infinity,height:900},{x:-1,y:0,width:1470,height:923},{x:0,y:0,width:1471,height:923}]) assert.throws(()=>qualifiedNativeBounds([primary],{...primary,workArea:area},1440,1040),error=>error.code==='NATIVE_DISPLAY_UNAVAILABLE');
  h.ok(true,'zero, too-small, nonfinite, and uncontained primary work areas fail closed');
  assert.throws(()=>qualifiedNativeBounds([],primary,1440,1040),error=>error.code==='NATIVE_DISPLAY_UNAVAILABLE');
  assert.throws(()=>qualifiedNativeBounds([primary],primary,Infinity,1040),RangeError);
  assert.throws(()=>qualifiedNativeBounds([primary],primary,.5,1040),RangeError);
  assert.throws(()=>qualifiedNativeBounds([primary],{...primary,workArea:{x:0,y:0,width:20.5,height:923}},1440,1040),error=>error.code==='NATIVE_DISPLAY_UNAVAILABLE');
  h.ok(true,'missing display, subpixel requested dimensions and zero rounded size cannot produce test bounds');
  const { nativeModelWindowPolicy } = require('./lib/model3dNativePolicy.cjs');
  const absent={bounds:{x:0,y:0,width:0,height:0},workArea:{x:0,y:0,width:0,height:0}};
  for(const scenario of ['semantics','field','paper','source']) {
    h.eq(nativeModelWindowPolicy(scenario,[absent],absent).qualification,'functional-offscreen',`${scenario}: unavailable display is explicitly functional-only`);
    h.eq(nativeModelWindowPolicy(scenario,[primary],primary).qualification,'native-display',`${scenario}: usable display keeps native qualification`);
  }
  for(const scenario of ['hardware','software','shape','reopen','disabled','disabled-cached','scale','s8','unknown']) assert.throws(()=>nativeModelWindowPolicy(scenario,[absent],absent),error=>error.code==='NATIVE_DISPLAY_UNAVAILABLE');
  h.ok(true,'timing, scale and all non-allowlisted scenarios cannot use functional offscreen fallback');
  await h.done();
}
void main();
