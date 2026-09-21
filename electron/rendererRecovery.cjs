'use strict';
// One recovery owner per application window; no renderer state or save claims.
const registrations = new WeakMap();
function attachRendererRecovery(win, { diagnostics, showMessageBox, getRoot, restart }) {
  if (registrations.has(win)) return registrations.get(win);
  const wc = win.webContents;
  let disposed = false, generation = 0, incident = null, pending = null;
  function clearIncident() { generation++; incident = null; }
  async function recover(code) {
    if (disposed || win.isDestroyed() || incident === code) return;
    incident = code;
    const operationId = diagnostics.record({ family: 'renderer', outcome: 'failed', code });
    // A crash during an unresponsive prompt is still an incident, but cannot
    // acquire a second dialog/restart owner for the same window.
    if (pending) return;
    const current = ++generation, root = getRoot();
    pending = (async () => {
      let response;
      try {
        ({ response } = await showMessageBox(win, { type: 'warning', title: 'Flux window needs recovery',
          message: code === 'RENDERER_UNRESPONSIVE' ? 'This Flux window stopped responding.' : 'This Flux window stopped unexpectedly.',
          detail: 'The last save may not have completed. Existing project and recovery files are kept. Restarting discards changes that exist only in this window. Cancel keeps the window available.',
          buttons: root ? ['Reopen saved project', 'Restart at Home', 'Cancel'] : ['Restart at Home', 'Cancel'],
          defaultId: root ? 2 : 1, cancelId: root ? 2 : 1, noLink: true }));
      } catch { diagnostics.record({ operationId, family: 'renderer', outcome: 'failed', code: 'RECOVERY_DIALOG_FAILED' }); return; }
      if (disposed || win.isDestroyed() || current !== generation || getRoot() !== root) return;
      const reopen = !!root && response === 0, home = response === (root ? 1 : 0);
      if (!reopen && !home) { diagnostics.record({ operationId, family: 'renderer', outcome: 'cancelled', code }); return; }
      try {
        await restart(reopen ? root : null);
        diagnostics.record({ operationId, family: 'renderer', outcome: reopen ? 'reopened' : 'restarted', code });
      } catch { diagnostics.record({ operationId, family: 'renderer', outcome: 'failed', code: 'RECOVERY_FAILED' }); }
    })().finally(() => { pending = null; });
    await pending;
  }
  const gone = (_event, details = {}) => {
    if (details.reason === 'clean-exit') return;
    void recover(details.reason === 'oom' ? 'RENDERER_OOM' : details.reason === 'killed' ? 'RENDERER_KILLED' : 'RENDERER_CRASHED');
  };
  const unresponsive = () => { void recover('RENDERER_UNRESPONSIVE'); };
  function dispose() {
    if (disposed) return; disposed = true; generation++;
    wc.removeListener('render-process-gone', gone); wc.removeListener('did-finish-load', clearIncident);
    win.removeListener('unresponsive', unresponsive); win.removeListener('responsive', clearIncident); win.removeListener('closed', dispose);
    registrations.delete(win);
  }
  wc.on('render-process-gone', gone); wc.on('did-finish-load', clearIncident);
  win.on('unresponsive', unresponsive); win.on('responsive', clearIncident); win.once('closed', dispose);
  registrations.set(win, dispose); return dispose;
}
module.exports = { attachRendererRecovery };
