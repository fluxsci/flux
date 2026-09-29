/** Installed into a real app document. Observes app-owned RAF and actual canvas
 * publication without adding a clock, scheduling frames, or reading pixels. */
export function installSlideModelScaleProbe() {
  if (window.__slideModelScaleProbe) throw Error('Scale observer already installed');
  const state = { frames: [], inputs: [], visibility: [], requests: 0, callbacks: 0, cancels: 0, pending: new Set(), recording: false, activeStamp: null };
  const contexts = new Set(), getContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (kind, ...args) {
    const context = getContext.call(this, kind, ...args);
    if (kind === 'webgl2' && context) contexts.add(context);
    return context;
  };
  const raf = window.requestAnimationFrame, cancel = window.cancelAnimationFrame, draw = CanvasRenderingContext2D.prototype.drawImage;
  window.requestAnimationFrame = callback => {
    state.requests++;
    const id = raf.call(window, stamp => {
      state.callbacks++; state.pending.delete(id);
      const prior = state.activeStamp; state.activeStamp = stamp;
      try { callback(stamp); } finally {
        // Furniture follows bitmap submission synchronously in the same app
        // callback. Preserve its completion, not just the last drawImage call.
        const frame = state.frames.at(-1);
        if (state.recording && frame?.stamp === stamp) frame.finished = performance.now();
        state.activeStamp = prior;
      }
    });
    state.pending.add(id); return id;
  };
  window.cancelAnimationFrame = id => { state.cancels++; state.pending.delete(id); return cancel.call(window, id); };
  CanvasRenderingContext2D.prototype.drawImage = function (...args) {
    const result = draw.apply(this, args), id = this.canvas.dataset?.slideModel3d;
    if (state.recording && id && this.canvas.closest('.present .mount,.preview-host') && state.activeStamp !== null) {
      let frame = state.frames.at(-1);
      if (!frame || frame.stamp !== state.activeStamp) {
        frame = { stamp: state.activeStamp, started: performance.now(), ids: [], publications: 0, visible: document.visibilityState, focused: document.hasFocus() };
        state.frames.push(frame);
      }
      if (!frame.ids.includes(id)) frame.ids.push(id);
      frame.publications++; frame.finished = performance.now();
    }
    return result;
  };
  const status = () => ({ time: performance.now(), visible: document.visibilityState, focused: document.hasFocus() });
  for (const name of ['focus', 'blur', 'visibilitychange']) window.addEventListener(name, event => {
    if (name === 'visibilitychange' || event.target === window) state.visibility.push({ event: name, ...status() });
  }, true);
  document.addEventListener('keydown', event => { if (event.isTrusted) state.inputs.push({ key: event.key, stamp: event.timeStamp, ...status() }); }, true);
  window.__slideModelScaleProbe = {
    start() { state.frames = []; state.recording = true; },
    stop() { state.recording = false; return structuredClone(state.frames); },
    progress() { return { frames: state.frames.length, last: state.frames.at(-1)?.stamp, requests: state.requests, callbacks: state.callbacks, pending: state.pending.size }; },
    read() {
      const pool = document[Symbol.for('flux.model3d.inlineHost')];
      const gl = pool?.canvas.getContext('webgl2'), ext = gl?.getExtension('WEBGL_debug_renderer_info');
      return { ...status(), viewport: { width: innerWidth, height: innerHeight }, requests: state.requests, callbacks: state.callbacks, cancels: state.cancels, pending: state.pending.size,
        frames: structuredClone(state.frames), inputs: structuredClone(state.inputs), visibility: structuredClone(state.visibility),
        stats: pool?.core.stats(), owners: pool?.owners ?? 0, observedInlineContexts: contexts.size, renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : undefined,
        canvases: [...document.querySelectorAll('.present .mount canvas[data-slide-model3d],.preview-host canvas[data-slide-model3d]')].map(canvas => { const r = canvas.getBoundingClientRect(); return { id: canvas.dataset.slideModel3d, width: canvas.width, height: canvas.height, display: canvas.style.display, rect: { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height } }; }) };
    },
  };
}
