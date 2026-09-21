import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { harness } from "./lib/harness.mjs";
const { createCaptureIntake } = createRequire(import.meta.url)("../electron/captureIntake.cjs");
const h = harness("verify-capture-integrity");
const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "flux-capture-integrity-"));
try {
  const downloads = path.join(root,"Downloads"), lib = path.join(root,"FluxLib");
  await fs.promises.mkdir(path.join(downloads,"flux"),{recursive:true});
  const name = "flux-paper.fluxcap";
  await fs.promises.writeFile(path.join(downloads,name), '{"origin":"top"}');
  await fs.promises.writeFile(path.join(downloads,"flux",name), '{"origin":"nested"}');
  const intake = createCaptureIntake({ captureDir:()=>downloads, fluxLibDir:()=>lib, path, fs, fsp:fs.promises, loadRules:()=>import("../electron/captureRules.js") });
  const result = await intake.intake();
  h.eq(result.sidecars.map((x:any)=>x.name), [name,`flux/${name}`], "intake retains exact source identity for duplicate basenames");
  h.eq((await intake.intake()).sidecars.length,0,"claimed sidecars have one processing consumer until released");
  const delivered = result.sidecars[1];
  await fs.promises.writeFile(path.join(downloads,"flux",name), '{"origin":"new replacement"}');
  h.ok((await intake.discard(delivered.id)).error,"stale opaque capture ID cannot discard a replacement with the same filename");
  h.eq(await fs.promises.readFile(path.join(downloads,"flux",name),"utf8"),'{"origin":"new replacement"}',"replacement bytes remain intact after stale disposal");
  intake.release(delivered.id);
  const fresh = (await intake.intake()).sidecars.find((row:any)=>row.name===`flux/${name}`);
  h.ok(fresh.id !== delivered.id,"new observed file generation receives a new opaque capture ID");
  const ambiguous = await intake.discard(name);
  h.ok(!!ambiguous.error && fs.existsSync(path.join(downloads,name)) && fs.existsSync(path.join(downloads,"flux",name)),"ambiguous legacy name refuses without removing either source");
  assert.deepEqual(await intake.discard(fresh.id),{ok:true});
  assert.deepEqual(await intake.discard(fresh.id),{ok:true});
  h.ok(!fs.existsSync(path.join(downloads,"flux",name)) && fs.existsSync(path.join(downloads,name)),"nested discard removes only delivered nested sidecar");
  const parked = await intake.park(name,"test");
  h.ok(parked.ok && (await fs.promises.readFile(parked.path,"utf8")) === '{"origin":"top"}',"park publishes complete original bytes and recovery note");
  h.ok((await intake.discard("../secret")).error,"arbitrary paths remain denied");
  const switchedName="flux-switch.fluxcap", nested=path.join(downloads,"flux"), moved=path.join(root,"moved-nested");
  await fs.promises.writeFile(path.join(nested,switchedName),"original nested bytes");
  const switched=(await intake.intake()).sidecars.find((row:any)=>row.name===`flux/${switchedName}`);
  await fs.promises.rename(nested,moved);await fs.promises.symlink(moved,nested);
  h.ok((await intake.discard(switched.id)).error,"capture disposal refuses a parent switched to an outside symlink after intake");
  h.eq(await fs.promises.readFile(path.join(moved,switchedName),"utf8"),"original nested bytes","parent symlink swap preserves exact captured bytes");
  await fs.promises.unlink(nested);await fs.promises.rename(moved,nested);
  await intake.discard(switched.id);

  const pdfName = "flux-verified.pdf", pdf = Buffer.from("%PDF-" + "exact-content".repeat(200));
  const src = path.join(downloads,pdfName);
  await fs.promises.writeFile(src,pdf);
  let failRemoval = true;
  const fsp = Object.assign({},fs.promises, {
    link: async (from:string,to:string) => { if (from === src) throw Object.assign(new Error("cross device"),{code:"EXDEV"}); return fs.promises.link(from,to); },
    rm: async (file:string,opts:any) => { if (file === src && failRemoval) {failRemoval=false;throw Object.assign(new Error("busy"),{code:"EBUSY"});} return fs.promises.rm(file,opts); }
  });
  const cross = createCaptureIntake({captureDir:()=>downloads,fluxLibDir:()=>lib,path,fs,fsp,loadRules:()=>import("../electron/captureRules.js")});
  h.eq((await cross.intake()).pdfs,[],"failure after cross-device publication does not claim success");
  h.eq(await fs.promises.readFile(src),pdf,"source remains intact on injected removal failure");
  h.eq((await cross.intake()).pdfs,[pdfName],"retry resumes exact recorded destination without creating a suffixed duplicate");
  h.eq(await fs.promises.readFile(path.join(lib,"pdfs_to_assign",pdfName)),pdf,"cross-device verified publication preserves exact PDF bytes");
  h.ok(!fs.existsSync(src) && !(await fs.promises.readdir(path.join(lib,"pdfs_to_assign"))).some(n=>n.includes(".capture-")||n.includes("pending-")),"completed retry disposes only original source and temporary receipts");
  await fs.promises.writeFile(src,pdf);
  const corrupt = createCaptureIntake({captureDir:()=>downloads,fluxLibDir:()=>lib,path,fs,fsp:{...fs.promises,
    link: fsp.link, copyFile: async (_from:string,to:string)=>fs.promises.writeFile(to,"corrupted")},loadRules:()=>import("../electron/captureRules.js")});
  h.eq((await corrupt.intake()).pdfs,[],"corrupted cross-device copy cannot publish or report success");
  h.eq(await fs.promises.readFile(src),pdf,"copy checksum failure preserves exact captured source");
  await fs.promises.symlink(src,path.join(downloads,"flux-symlink.pdf"));
  h.eq(await corrupt.count(),1,"symlink capture is excluded from intake candidates");

} finally { await fs.promises.rm(root,{recursive:true,force:true}); }
h.done();
