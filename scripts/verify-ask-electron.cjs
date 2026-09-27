"use strict";
const fs = require("node:fs/promises"), os = require("node:os"), path = require("node:path");
async function main() {
  const { TestProcessScope } = await import("./lib/testProcess.mjs");
  const scratch=await fs.mkdtemp(path.join(os.tmpdir(),"ask-electron-"));
  const scope=new TestProcessScope();
  try {
    const env={...process.env,HOME:path.join(scratch,"home"),XDG_CONFIG_HOME:path.join(scratch,"xdg"),FLUX_NO_MIGRATE:"1",PROBE_SCRATCH:scratch,PROBE_NODE:process.execPath};
    delete env.ELECTRON_RUN_AS_NODE;
    await fs.mkdir(env.HOME,{recursive:true});
    const args=[];
    if(process.platform==='linux'){args.push('--ozone-platform=x11');if(process.env.FLUX_ELECTRON_NO_SANDBOX==='1')args.push('--no-sandbox');}
    const entry=scope.spawn(path.join(__dirname,"lib/askElectronProbe.cjs"),args,{command:require("electron"),nodeArgs:[],cwd:path.resolve(__dirname,".."),env,deadlineMs:90000});
    await entry.closed;
    process.stdout.write(entry.stdout);process.stderr.write(entry.stderr);
    if(!/##VERIFY## .*"ok":true/.test(entry.stdout))process.exitCode=1;
  }finally{await scope.dispose();await fs.rm(scratch,{recursive:true,force:true});}
}
main().catch(e=>{console.error(e);process.exitCode=1});
