"use strict";
const fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto");
/** Derived reading context has one focused native sender/root/claim owner. */
function createReaderContext({rootFor,windowFor,atomicWrite,guard=()=>{},now=Date.now,ttlMs=30000}) {
  const owners=new Map(),tails=new Map(),senders=new Map();let disposed=false,suspended=0;
  const stale=()=>Object.assign(new Error("Reader context owner changed"),{code:"STALE_READER_CONTEXT"});
  const canonical=()=>fs.realpathSync(rootFor());
  const live=r=>!disposed&&!suspended&&!r.sender.isDestroyed()&&owners.get(r.root)===r&&canonical()===r.root;
  const serial=(root,fn)=>{const p=(tails.get(root)||Promise.resolve()).catch(()=>{}).then(fn);tails.set(root,p);void p.finally(()=>{if(tails.get(root)===p)tails.delete(root);}).catch(()=>{});return p;};
  const target=root=>path.join(root,".fluxlib","reader-context.json");
  function confined(p,root) {
    let probe=p;
    for(;;){try{const real=fs.realpathSync(probe),rel=path.relative(root,real);if(rel==='..'||rel.startsWith('..'+path.sep)||path.isAbsolute(rel))throw Error('Reader context path escapes its library');return;}catch(error){if(error.code!=="ENOENT")throw error;const parent=path.dirname(probe);if(parent===probe)throw error;probe=parent;}}
  }
  async function release(sender,token) {
    const r=[...owners.values()].find(v=>v.token===token&&v.sender.id===sender.id);if(!r)return false;
    owners.delete(r.root);
    return serial(r.root,async()=>{
      if(owners.has(r.root)||disposed)return false;
      const p=target(r.root);confined(p,r.root);guard({sender},p);
      await atomicWrite(p,Buffer.from(JSON.stringify({citekey:"",updatedAt:new Date(now()).toISOString()})+"\n"),false,0o600,sender.id,()=>{if(owners.has(r.root)||disposed||suspended)throw stale();confined(p,r.root);});
      return true;
    }).catch(error=>{if(error.code==="STALE_READER_CONTEXT")return false;throw error;});
  }
  function observe(sender) {
    if(senders.has(sender.id))return;
    const drop=()=>{for(const r of [...owners.values()])if(r.sender.id===sender.id)void release(sender,r.token).catch(()=>{});};
    const destroyed=()=>{drop();senders.delete(sender.id);};
    sender.once("destroyed",destroyed);senders.set(sender.id,{sender,destroyed});
  }
  async function claim(sender,{root,owner}) {
    if(suspended)return null;
    if(disposed||typeof root!=="string"||typeof owner!=="string"||owner.length>128)throw Error("Invalid reader context claim");
    let real;try{real=fs.realpathSync(root);}catch(error){if(error.code==="ENOENT")return null;throw error;}
    if(real!==canonical())throw Error("Reader context library changed");
    if(sender.isDestroyed()||!windowFor(sender)?.isFocused())return null;
    observe(sender);const r={root:real,sender,owner,token:crypto.randomUUID(),generation:0,context:null,updatedAt:null};owners.set(real,r);
    // Adoption cannot leave a previous closed pane's context labeled as live
    // while the new owner is still preparing its first publication.
    try {
      await serial(real,async()=>{
        const valid=()=>{if(!live(r)||!windowFor(sender)?.isFocused())throw stale();};valid();
        const p=target(real);confined(p,real);guard({sender},p);
        await atomicWrite(p,Buffer.from(JSON.stringify({citekey:"",updatedAt:new Date(now()).toISOString()})+"\n"),false,0o600,sender.id,()=>{valid();confined(p,real);});
      });
      return live(r)?{token:r.token,root:real}:null;
    }catch(error){if(error.code==="STALE_READER_CONTEXT")return null;throw error;}
  }
  async function publish(sender,{token,generation,context}) {
    const r=[...owners.values()].find(v=>v.token===token&&v.sender.id===sender.id);
    if(!r||!Number.isSafeInteger(generation)||generation<=r.generation||!live(r)||!windowFor(sender)?.isFocused())return false;
    if(!context||typeof context.citekey!=="string"||context.citekey.length>1024)throw Error("Invalid reader context");
    if(context.sourcePdf&&context.sourcePdf!=="main") {
      const name=context.sourcePdf.supplement;
      if(typeof name!=="string"||!name||name.length>256||path.basename(name)!==name||name.includes("\\")||name==="."||name==="..")throw Error("Invalid reader PDF source");
    }
    r.generation=generation;
    // Snapshot before queueing so caller mutation cannot change an accepted packet.
    const captured=JSON.parse(JSON.stringify(context));delete captured.pdfPath;delete captured.fulltextPath;
    return serial(r.root,async()=>{
      const valid=()=>{if(!live(r)||!windowFor(sender)?.isFocused()||r.generation!==generation)throw stale();};valid();
      const value={...captured,owner:r.token,generation,foreground:true,updatedAt:new Date(now()).toISOString(),expiresAt:new Date(now()+ttlMs).toISOString()};
      const p=target(r.root);confined(p,r.root);guard({sender},p);
      await atomicWrite(p,Buffer.from(JSON.stringify(value,null,2)+"\n"),false,0o600,sender.id,()=>{valid();confined(p,r.root);});r.context=captured;r.updatedAt=value.updatedAt;return true;
    }).catch(error=>{if(error.code==="STALE_READER_CONTEXT")return false;throw error;});
  }
  async function renew(sender,{token,generation}) {
    const r=[...owners.values()].find(v=>v.token===token&&v.sender.id===sender.id);
    if(!r||!r.context||!Number.isSafeInteger(generation)||generation<=r.generation||!live(r))return false;
    r.generation=generation;
    return serial(r.root,async()=>{
      const valid=()=>{if(!live(r)||r.generation!==generation)throw stale();};valid();
      const p=target(r.root);confined(p,r.root);guard({sender},p);
      const value={...r.context,owner:r.token,generation,foreground:!!windowFor(sender)?.isFocused(),updatedAt:r.updatedAt,expiresAt:new Date(now()+ttlMs).toISOString()};
      await atomicWrite(p,Buffer.from(JSON.stringify(value,null,2)+"\n"),false,0o600,sender.id,()=>{valid();confined(p,r.root);});return true;
    }).catch(error=>{if(error.code==="STALE_READER_CONTEXT")return false;throw error;});
  }
  return {claim,publish,renew,release,registerHandlers(ipc){
    ipc.handle("readerContext:claim",(e,payload)=>claim(e.sender,payload));
    ipc.handle("readerContext:publish",(e,payload)=>publish(e.sender,payload));
    ipc.handle("readerContext:renew",(e,payload)=>renew(e.sender,payload));
    ipc.handle("readerContext:release",(e,token)=>release(e.sender,token));
  },async suspend(){suspended++;owners.clear();await Promise.allSettled([...tails.values()]);let resumed=false;return ()=>{if(!resumed){resumed=true;suspended--;}};},dispose(){disposed=true;owners.clear();for(const s of senders.values()){s.sender.removeListener("destroyed",s.destroyed);}senders.clear();}};
}
module.exports={createReaderContext};
