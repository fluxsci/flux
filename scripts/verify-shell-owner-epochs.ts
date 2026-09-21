import assert from 'node:assert/strict';
import { get } from 'svelte/store';
import { flushAll, flushPaneChecked, registerFlushable, notifyFlushOwnerReady, hasFlushOwner } from '../src/shell/lifecycle';
import { currentProject, view, goHome } from '../src/shell/shellStore';
import { setFocusedMode } from '../src/shell/paneStore';
import { setStoreTenant } from '../src/lib/tenancy';
import { embeddedProjectRoot } from '../src/lib/store';
import { installBridge } from '../src/lib/bridge/install';

const root='/disposable-owner-fixture';
currentProject.set({name:'Owner fixture',path:root});view.set('workspace');
let release!:()=>void, entered!:()=>void;
const started=new Promise<void>(r=>entered=r), blocked=new Promise<void>(r=>release=r);
const removeOld=registerFlushable({id:'paper-old',paneId:'old',isDirty:()=>false,flush:async()=>{entered();await blocked;}});
const leaving=goHome();await started;
let pendingText='new unsaved draft';
const removeNew=registerFlushable({id:'paper-new',paneId:'new',isDirty:()=>!!pendingText,flush:async()=>{pendingText='';}});
release();assert.equal(await leaving,false,'a newly mounted dirty owner prevents Home');
assert.equal(get(view),'workspace');assert.equal(get(currentProject)?.path,root);assert.equal(pendingText,'new unsaved draft');
removeOld();removeNew();

// The same object being unregistered/re-registered is a new ownership epoch.
let unblock!:()=>void; const wait=new Promise<void>(r=>unblock=r);
const owner={id:'paper-reused',paneId:'one',isDirty:()=>false,flush:()=>wait};
const removeFirst=registerFlushable(owner);const flushing=flushAll();
removeFirst();const removeSecond=registerFlushable(owner);removeFirst();
assert.equal(hasFlushOwner(owner.id),true,'old disposer cannot remove the new epoch');
unblock();assert.deepEqual(await flushing,{ok:false,failed:[owner.id]});removeSecond();

// Closing one pane does not reject merely because its neighbor changes.
let free!:()=>void;const holding=new Promise<void>(r=>free=r);
const removePane=registerFlushable({id:'paper-one',paneId:'one',isDirty:()=>false,flush:()=>holding});
const closing=flushPaneChecked('one');const removeNeighbor=registerFlushable({id:'paper-neighbor',paneId:'two',isDirty:()=>true,flush:async()=>{}});
free();assert.deepEqual(await closing,{ok:true,failed:[]});removePane();removeNeighbor();

// Drive the production subscription bridge, not getAppContext directly.
const pushed: {activeFigure:unknown;projectRoot:string|null}[]=[];
Object.assign(globalThis,{window:{fig:{bridge:{pushContext:(context:any)=>pushed.push(context),onDispatch:()=>{},reply:()=>{}}}}});
setFocusedMode('figure');setStoreTenant('figure');embeddedProjectRoot.set(root);
let ready=false;
const removeFigure=registerFlushable({id:'figure',isReady:()=>ready,isDirty:()=>false,flush:async()=>{}});
installBridge();
async function observed(predicate:()=>boolean) {const deadline=Date.now()+1500;while(!predicate()){assert.ok(Date.now()<deadline,'context published without unrelated input');await new Promise(r=>setTimeout(r,10));}}
await observed(()=>pushed.length>=2);assert.equal(pushed.at(-1)?.activeFigure,null);
let before=pushed.length;ready=true;notifyFlushOwnerReady('figure');
await observed(()=>pushed.length>before);assert.ok(pushed.at(-1)?.activeFigure,'delayed readiness publishes existing Figure data');
before=pushed.length;setStoreTenant('slide');await observed(()=>pushed.length>before);assert.equal(pushed.at(-1)?.activeFigure,null);
before=pushed.length;setStoreTenant('figure');await observed(()=>pushed.length>before);assert.ok(pushed.at(-1)?.activeFigure);
before=pushed.length;embeddedProjectRoot.set('/different-root');await observed(()=>pushed.length>before);assert.equal(pushed.at(-1)?.activeFigure,null);
before=pushed.length;embeddedProjectRoot.set(root);await observed(()=>pushed.length>before);assert.ok(pushed.at(-1)?.activeFigure);
before=pushed.length;removeFigure();await observed(()=>pushed.length>before);assert.equal(pushed.at(-1)?.activeFigure,null);
console.log('shell owner changes, pane-scoped safety, and delayed live context readiness PASS');
