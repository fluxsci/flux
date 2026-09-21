import assert from 'node:assert/strict';
import http from 'node:http';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { bridgeAvailable, getAppContext, dispatchCommand } from '../flux-core/liveClient';
const root=await fs.mkdtemp(path.join(os.tmpdir(),'flux-live-client-'));
let mode='good';let redirects=0;
const server=http.createServer((req,res)=>{
  assert.equal(req.headers.authorization,'Bearer fixture-token');
  if(mode==='hang')return;
  if(mode==='redirect'){res.writeHead(302,{location:'/unexpected'});res.end();return;}
  if(req.url==='/unexpected'){redirects++;res.end('{}');return;}
  if(mode==='oversize'){res.end(JSON.stringify({data:'x'.repeat(5*1024*1024)}));return;}
  if(req.url==='/health')res.end(JSON.stringify({ok:true}));
  else if(req.url==='/context')res.end(JSON.stringify({projectRoot:root}));
  else res.end(JSON.stringify({ok:true,result:{saved:true}}));
});
try {
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  const port=(server.address() as import('node:net').AddressInfo).port;
  await fs.mkdir(path.join(root,'.meta/live'),{recursive:true});
  await fs.writeFile(path.join(root,'.meta/live/bridge.json'),JSON.stringify({url:`http://127.0.0.1:${port}`,port,token:'fixture-token'}));
  assert.equal(await bridgeAvailable(root),true);
  assert.deepEqual(await getAppContext(root),{projectRoot:root});
  assert.deepEqual(await dispatchCommand(root,{type:'select'}),{saved:true});
  mode='redirect';await assert.rejects(getAppContext(root));assert.equal(redirects,0);
  mode='oversize';await assert.rejects(getAppContext(root),/4 MiB/);
  mode='hang';const start=Date.now();assert.equal(await bridgeAvailable(root),false);assert.ok(Date.now()-start<4500,'health deadline settles');
  console.log('live client actual loopback auth, context/dispatch, redirect refusal, byte cap and deadline PASS');
}finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await fs.rm(root,{recursive:true,force:true});}
