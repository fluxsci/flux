'use strict';
// Optional Linux integration gate: the actual helper talks to a private D-Bus
// portal double. It cannot request the owner's real desktop or touch user data.
const {spawnSync} = require('node:child_process');
const path = require('node:path');
(async () => {
 const {harness}=await import('./lib/harness.mjs');
 const h=harness('verify-eyedropper-portal');
 if (process.platform!=='linux' || spawnSync('/usr/bin/python3',['-I','-c','from gi.repository import Gio, GLib']).status!==0) {
  console.log('BLOCKED: Linux system Python/Gio is required for the optional portal integration gate.'); process.exitCode=77; return;
 }
 const repo=path.resolve(__dirname,'..');
 for(const mode of ['picked','refuse','cancel','unavailable','invalid','notallowed','accessdenied','failed']) {
  const child=spawnSync('dbus-run-session',['--','/usr/bin/python3',path.join(__dirname,'lib/eyedropperPortalFixture.py'),mode,path.join(repo,'electron/ipc/colorPickerPortal.py')],{cwd:repo,encoding:'utf8',timeout:10000});
  h.ok(child.status===0 && child.stdout.includes('PASS '+mode),`actual portal helper ${mode}: ${child.stdout.trim() || child.stderr.trim()}`);
 }
 await h.done();
})();
