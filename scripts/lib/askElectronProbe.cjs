"use strict";
const { app, BrowserWindow, ipcMain } = require("electron");
const fs = require("node:fs/promises"), path = require("node:path");
const scratch = process.env.PROBE_SCRATCH;
app.setPath("userData", path.join(scratch, "config"));
app.whenReady().then(async () => {
  const { installFakeRunner } = require("./runnerFixture.cjs");
  const bin = await installFakeRunner(path.join(scratch, "bin"), process.env.PROBE_NODE);
  const root = path.join(scratch, "project"); await fs.mkdir(root); await fs.writeFile(path.join(root, "project.json"), "{}");
  const { createRunnerFamily } = require("../../electron/ipc/runner.cjs");
  const { wrapIpcMain } = require("../../electron/ipc/contract.cjs");
  let win;
  const family = createRunnerFamily({rootForSender:e=>e.sender===win?.webContents?root:null,userDataDir:()=>app.getPath("userData"),launcher:()=>bin.flux,preferences:()=>({}),
    runnerOptions:{binaries:bin,env:{...process.env,ELECTRON_RUN_AS_NODE:undefined,SHELL:'/not-a-shell'},killGraceMs:30}});
  family.registerHandlers(wrapIpcMain(ipcMain,{validateSender:e=>e.sender===win?.webContents}));
  win = new BrowserWindow({show:false,webPreferences:{preload:path.resolve(__dirname,"../../electron/preload.cjs"),contextIsolation:true,nodeIntegration:false,sandbox:true}});
  const html=path.join(scratch,"probe.html");await fs.writeFile(html,'<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\'"><title>Ask IPC probe</title>');
  try {
    await win.loadFile(html);
    const result=await win.webContents.executeJavaScript(`(async()=>{
      const events=[];const stop=window.fig.onRunnerEvent(e=>events.push(e));
      const caps=await window.fig.runnerCapabilities();
      const runs=[];
      for(const driver of ['claude','codex']) {
        const r=await window.fig.runnerStart({driver,mode:'ask',root:${JSON.stringify(root)},firstMessage:'question'});runs.push(r);
        const end=Date.now()+15000;
        while(!events.some(e=>e.runId===r.runId&&e.type==='status'&&e.state==='idle')){if(Date.now()>end)throw Error('IPC run timed out');await new Promise(r=>setTimeout(r,20));}
        await window.fig.runnerCancel(r);
      }
      let refused=false;try{await window.fig.runnerStart({driver:'claude',mode:'ask',root:${JSON.stringify(scratch)},firstMessage:'foreign'});}catch{refused=true}
      stop();return {caps,events,refused,runs};
    })()`);
    const checks = [result.caps.every(c=>c.available),result.refused];
    for(const run of result.runs) {
      const events=result.events.filter(e=>e.runId===run.runId);
      checks.push(events.some(e=>e.type==='message'),events.some(e=>e.type==='tool'&&e.input),events.some(e=>e.state==='cancelled'),events.every((e,i)=>e.seq===i+1));
      const log=await fs.readFile(path.join(scratch,'config','runs',run.runId+'.jsonl'),'utf8');checks.push(log.includes('stdout'));
    }
    console.log('##VERIFY## '+JSON.stringify({script:'verify-ask-electron',ok:checks.every(Boolean),checks:checks.length,failed:checks.filter(x=>!x).length}));
    await family.dispose(); win.destroy(); app.exit(checks.every(Boolean)?0:1);
  } catch(e) { console.error(e);await family.dispose();win?.destroy();app.exit(1); }
}).catch(e=>{console.error(e);app.exit(1)});
