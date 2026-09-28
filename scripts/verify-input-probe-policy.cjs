'use strict';
const assert = require('node:assert/strict');
const { configureWindow, assertWindow } = require('./perf/input-probe-policy.cjs');
const { assertUsableDisplay } = require('./lib/nativeWindowQualification.cjs');
async function main() {
  const { harness } = await import('./lib/harness.mjs'); const h = harness('verify-input-probe-policy');
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
  await h.done();
}
void main();
