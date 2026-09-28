'use strict';
// Test-only CDP instrumentation. The production worker URL/source remains
// unchanged; the debugger is detached for all input latency measurements.
module.exports = function nativeContextProbe(contents) {
  const sessions = new Map(), failures = [];
  const debuggerApi = contents.debugger;
  const send = (method, params, session) => debuggerApi.sendCommand(method, params, session);
  const instrument = `(()=>{
    if(typeof OffscreenCanvas==='undefined')return;
    const probe=globalThis.__fluxNativeGLProbe={contexts:[],lost:0,restored:0};
    const original=OffscreenCanvas.prototype.getContext;
    OffscreenCanvas.prototype.getContext=function(kind,...args){
      const context=original.call(this,kind,...args);
      if(context&&kind==='webgl2'&&!probe.contexts.includes(context)){
        probe.contexts.push(context);
        this.addEventListener('webglcontextlost',()=>probe.lost++);
        this.addEventListener('webglcontextrestored',()=>probe.restored++);
      }
      return context;
    };
  })()`;
  async function message(_event, method, params) {
    if (method !== 'Target.attachedToTarget') return;
    const session = params.sessionId;
    sessions.set(params.targetInfo.targetId, { session, ...params.targetInfo });
    try {
      if (params.targetInfo.type === 'worker') await send('Runtime.evaluate', { expression: instrument }, session);
    } catch (error) { failures.push(String(error)); }
    finally { await send('Runtime.runIfWaitingForDebugger', {}, session).catch(error => failures.push(String(error))); }
  }
  function attach() { if (!debuggerApi.isAttached()) debuggerApi.attach('1.3'); }
  async function arm() {
    attach(); debuggerApi.on('message', message);
    await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  }
  function detach() {
    debuggerApi.removeListener('message', message);
    if (debuggerApi.isAttached()) debuggerApi.detach();
  }
  async function connect() {
    attach();
    const { targetInfos } = await send('Target.getTargets', {});
    const target = targetInfos.find(target => target.type === 'worker' && target.url.includes('model3d.worker'));
    if (!target) throw Error('Actual production model3d worker target is missing');
    const { sessionId } = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    return sessionId;
  }
  async function workerCount() {
    const { targetInfos } = await send('Target.getTargets', {});
    return targetInfos.filter(target=>target.type==='worker'&&target.url.includes('model3d.worker')).length;
  }
  async function evaluate(session, expression) {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, session);
    if (result.exceptionDetails) throw Error(result.exceptionDetails.text || 'Worker diagnostic failed');
    return result.result.value;
  }
  const state = session => evaluate(session, `(()=>{const p=globalThis.__fluxNativeGLProbe;return p?{contexts:p.contexts.length,lost:p.lost,restored:p.restored,isContextLost:p.contexts[0]?.isContextLost()}:null})()`);
  const lose = session => evaluate(session, `(()=>{const c=globalThis.__fluxNativeGLProbe?.contexts[0];if(!c)throw Error('No captured production WebGL2 context');const ext=c.getExtension('WEBGL_lose_context');if(!ext)throw Error('WEBGL_lose_context unavailable');globalThis.__fluxNativeLoseContext=ext;ext.loseContext();return true})()`);
  const restore = session => evaluate(session, `(()=>{if(!globalThis.__fluxNativeLoseContext)throw Error('Missing loss extension');globalThis.__fluxNativeLoseContext.restoreContext();return true})()`);
  return { arm, detach, connect, workerCount, state, lose, restore, failures, sessions };
};
