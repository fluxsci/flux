// Exercise native registered PTY handlers with two genuine session owners.
const assert = require('node:assert/strict');
const os = require('node:os');
const { createTerminalFamily } = require('../electron/ipc/terminal.cjs');
const handlers = new Map(), writes = [], resizes = [], killed = [], events = [];
let next = 0;
const children = new Map();
const nodePty = { spawn(_command,_args,options) {
  const id=++next, child={pid:id,write:data=>writes.push([id,data]),resize:(c,r)=>resizes.push([id,c,r]),kill:()=>killed.push(id),onData:fn=>{child.emitData=fn},onExit:fn=>{child.emitExit=fn}};
  children.set(id,child);assert.equal(options.cwd,os.tmpdir());return child;
}};
const family=createTerminalFamily({app:{getPath:()=>os.tmpdir()},nodePty,rootForSender:()=>os.tmpdir()});
family.registerHandlers({on:(name,fn)=>handlers.set(name,fn),handle:(name,fn)=>handlers.set(name,fn)});
const owner=id=>({id,isDestroyed:()=>false,send:(name,data)=>events.push([id,name,data])});
const a={sender:owner(11)},b={sender:owner(22)};
const first=handlers.get('pty:create')(a,{cwd:os.tmpdir()}),second=handlers.get('pty:create')(b,{cwd:os.tmpdir()});
assert.ok(first.ok&&second.ok&&first.id!==second.id);
handlers.get('pty:write')(b,first.id,'NOT OWNED');handlers.get('pty:resize')(b,first.id,3,4);
assert.equal(handlers.get('pty:kill')(b,first.id),false);assert.deepEqual([writes,resizes,killed],[[],[],[]]);
handlers.get('pty:write')(a,first.id,'owned');handlers.get('pty:resize')(a,first.id,120,40);
assert.deepEqual(writes,[[1,'owned']]);assert.deepEqual(resizes,[[1,120,40]]);
children.get(1).emitData('output');assert.deepEqual(events,[[11,'pty:data',{id:first.id,data:'output'}]]);
assert.equal(handlers.get('pty:kill')(a,first.id),true);assert.deepEqual(killed,[1]);
assert.equal(handlers.get('pty:kill')(a,first.id),true);assert.deepEqual(killed,[1]);
handlers.get('pty:write')(a,second.id,'NOT OWNED');assert.deepEqual(writes,[[1,'owned']]);
family.reapPtys(s=>s.wc.id===22);assert.deepEqual(killed,[1,2]);
console.log('Native terminal sender ownership PASS: foreign write/resize/kill refused, output stays with owner, own kill/reap remains idempotent');
