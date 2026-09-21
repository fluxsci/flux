'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// Chromium 150's native EyeDropperView segfaults under GNOME Wayland. Keep
// desktop capture in the compositor's consent-based Screenshot.PickColor portal.
// The optional system Gio helper is isolated: no native Node dependency, project
// access, shell, persistent process, or Chromium EyeDropper fallback on Linux.
function createColorPicker({ spawnProcess = spawn, platform = process.platform, timeoutMs = 120000 } = {}) {
  const jobs = new Map();
  function cancel(sender, requestId) {
    const job = jobs.get(sender.id);
    if (!job || (requestId !== undefined && requestId !== job.requestId)) return false;
    job.stop();
    return true;
  }
  async function pick(sender, requestId) {
    if (platform !== 'linux') return { status: 'unavailable' };
    if (typeof requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(requestId)) throw new Error('Invalid color picker request');
    if (jobs.has(sender.id)) throw new Error('A color picker is already open');
    if (sender.isDestroyed()) return { status: 'cancelled' };
    return new Promise(resolve => {
      let child, timer, killTimer, output = '', finished = false, stopping = false;
      const job = { requestId, stop };
      function finish(result) {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        clearTimeout(killTimer);
        sender.removeListener('destroyed', stop);
        sender.removeListener('render-process-gone', stop);
        sender.removeListener('did-start-navigation', navigating);
        if (jobs.get(sender.id) === job) jobs.delete(sender.id);
        resolve(result);
      }
      function stop() {
        if (finished || stopping) return;
        stopping = true;
        // Closing the portal request (not merely killing Python) releases its UI.
        child?.stdin.write('cancel\n', () => {});
        killTimer = setTimeout(() => { child?.kill('SIGKILL'); finish({ status: 'cancelled' }); }, 1000);
      }
      function navigating(_event, _url, _inPlace, mainFrame) { if (mainFrame) stop(); }
      jobs.set(sender.id, job);
      sender.once('destroyed', stop);
      sender.once('render-process-gone', stop);
      sender.on('did-start-navigation', navigating);
      try {
        // Reading via Electron's fs also works from an asar; Python cannot open
        // an asar member itself. The program is shipped code, never renderer input.
        const code = fs.readFileSync(path.join(__dirname, 'colorPickerPortal.py'), 'utf8');
        child = spawnProcess('/usr/bin/python3', ['-I', '-c', code], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
        child.stdin.on('error', () => {});
        child.stdout.on('data', bytes => {
          output += String(bytes);
          if (output.length > 4096) { child.kill('SIGKILL'); finish({ status: 'error', message: 'The screen color picker returned an invalid response.' }); }
        });
        child.stderr.resume();
        child.once('error', () => finish({ status: 'unavailable' }));
        child.once('close', () => {
          if (stopping) { finish({ status: 'cancelled' }); return; }
          try {
            const result = JSON.parse(output);
            if (result.status === 'picked' && /^#[0-9a-f]{6}$/.test(result.hex)) finish(result);
            else if (['cancelled', 'unavailable'].includes(result.status)) finish({ status: result.status });
            else finish({ status: 'error', message: 'The screen color picker did not return a color.' });
          } catch { finish({ status: 'unavailable' }); }
        });
        timer = setTimeout(stop, timeoutMs);
      } catch { finish({ status: 'unavailable' }); }
    });
  }
  return {
    pick, cancel,
    cancelAll() { for (const job of jobs.values()) job.stop(); },
    registerHandlers(ipc) {
      ipc.handle('color:pickScreen', (event, requestId) => pick(event.sender, requestId));
      ipc.handle('color:cancelScreen', (event, requestId) => cancel(event.sender, requestId));
    },
  };
}
module.exports = { createColorPicker };
