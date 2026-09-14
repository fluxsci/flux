"use strict";
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
async function main() {
  const repo=path.resolve(__dirname,'..'),scratch=await fs.mkdtemp(path.join(os.tmpdir(),'flux-clip-editor-')),root=path.join(scratch,'project'),output=path.join(repo,'test-results/slide-video-clips');
  const {TestProcessScope}=await import('./lib/testProcess.mjs'),scope=new TestProcessScope();
  const env={...process.env,HOME:path.join(scratch,'home'),XDG_CONFIG_HOME:path.join(scratch,'xdg'),APPDATA:path.join(scratch,'appdata'),FLUX_NO_MIGRATE:'1',PROBE_PROJECT:root,PROBE_SCRATCH:scratch,PROBE_ARTIFACTS:output};
  delete env.ELECTRON_RUN_AS_NODE;delete env.VITE_DEV_SERVER_URL;
  try {
    await fs.mkdir(env.HOME,{recursive:true});await fs.mkdir(output,{recursive:true});
    const fixture=scope.spawn(path.join(__dirname,'lib/slideVideoFixture.ts'),[root],{env});assert.equal((await scope.waitExit(fixture)).code,0,fixture.stderr);
    await fs.mkdir(path.join(root,'plots/_videos'),{recursive:true});
    for(const name of ['moving-box.mp4','camera.MOV'])await fs.copyFile(path.join(__dirname,'fixtures/slide-video-clips/moving-box.mp4'),path.join(root,'plots/_videos',name));
    const native=scope.spawn(require.resolve('electron/cli.js'),[path.join(__dirname,'lib/slideVideoClipsNativeEntry.cjs'),root,...(process.platform==='linux'?['--ozone-platform=x11']:[])],{env,cwd:repo,nodeArgs:[],deadlineMs:240000});
    native.child.stdout.on('data',bytes=>{for(const line of String(bytes).split('\n'))if(line.startsWith('PROBE '))console.log(line);});
    const status=await scope.waitExit(native);await fs.writeFile(path.join(output,'native-editor.log'),native.stdout+native.stderr);
    assert.equal(status.code,0,(native.stdout+native.stderr).slice(-12000));
  } finally {await scope.dispose();await fs.rm(scratch,{recursive:true,force:true});}
}
import('./lib/harness.mjs').then(async({harness})=>{const h=harness('verify-slide-video-clips-electron');try{await main();h.ok(true,'native clip gallery/import, manipulation, authoring, media playback and persistence');}catch(error){console.error(error);h.fail(String(error.message||error));}await h.done();});
