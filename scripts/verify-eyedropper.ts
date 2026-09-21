import assert from 'node:assert/strict';
import { harness } from './lib/harness.mjs';
const h = harness('verify-eyedropper');
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createRequire } from 'node:module';
import { pickColor, capturedPixel } from '../src/lib/color/eyedropper';
import type { FileBridge } from '../src/lib/project/types';
const { createColorPicker } = createRequire(import.meta.url)('../electron/ipc/colorPicker.cjs');
function ok(label: string) { h.ok(true, label); }
let browserCalls = 0;
class NativeTrap { constructor() { browserCalls++; throw Error('unsafe native API called'); } open(): Promise<{sRGBHex:string}> { throw Error('unused'); } }
const controller = new AbortController();
const bridge = { platform: 'linux', pickScreenColor: async () => ({status:'picked',hex:'#1280FE'}) } as unknown as FileBridge;
assert.equal(await pickColor({bridge,signal:controller.signal,browserDropper:NativeTrap}), '#1280fe');
assert.equal(browserCalls, 0); ok('Linux samples the portal and never invokes the crashing advertised browser API');
let captures = 0;
bridge.captureWindow = async () => { captures++; throw Error('must not capture on refusal'); };
bridge.pickScreenColor = async () => ({status:'cancelled'});
assert.equal(await pickColor({bridge,signal:controller.signal,browserDropper:NativeTrap}), null);
assert.equal(captures,0); ok('portal cancellation/denial never bypasses consent with capture');
bridge.pickScreenColor = async () => ({status:'error',message:'permission backend failed'});
await assert.rejects(pickColor({bridge,signal:controller.signal}), /permission backend failed/);
assert.equal(captures,0); ok('portal errors remain visible and never silently trigger capture');
let resolve!: (r: any) => void, cancelledId = '';
bridge.pickScreenColor = async () => new Promise(r => resolve=r);
bridge.cancelScreenColor = async id => {cancelledId=id;return true;};
const stale = new AbortController();
const pending = pickColor({bridge,signal:stale.signal,browserDropper:NativeTrap});
stale.abort(); resolve({status:'picked',hex:'#abcdef'});
await assert.rejects(pending, {name:'AbortError'}); assert.ok(cancelledId); ok('dismissal cancels its native request and rejects a late sampled color');
let nativeSignal: AbortSignal | undefined;
class BrowserPicker { open({signal}:{signal:AbortSignal}) {nativeSignal=signal;return Promise.resolve({sRGBHex:'#ABCDEF'});} }
assert.equal(await pickColor({signal:controller.signal,browserDropper:BrowserPicker}), '#abcdef');
assert.equal(nativeSignal,controller.signal); ok('browser/mac/windows native path retains cancellation');
assert.deepEqual(capturedPixel(33.3,21,80,50,100,63),[41,26]);
assert.deepEqual(capturedPixel(80,50,80,50,100,63),[99,62]);
assert.deepEqual(capturedPixel(-1,-1,80,50,100,63),[0,0]); ok('fallback maps fractional DPR and edge coordinates to exact device pixels');

const owner = (id: number) => Object.assign(new EventEmitter(), {id,isDestroyed:()=>false});
let child: any, command: string, argv: string[];
function spawnProcess(cmd: string, args: string[]) {
 command=cmd; argv=args;
 child = Object.assign(new EventEmitter(),{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),kill(){this.emit('close',0)}});
 return child;
}
const service = createColorPicker({spawnProcess});
const a = owner(1), b = owner(2);
let p = service.pick(a,'first');
assert.equal(command!,'/usr/bin/python3'); assert.equal(argv![0],'-I');
assert.equal(argv![1],'-c'); ok('portal program uses isolated fixed system interpreter with shipped code and no shell');
await assert.rejects(service.pick(a,'duplicate'), /already open/);
assert.equal(service.cancel(b,'first'),false); assert.equal(service.cancel(a,'foreign'),false);
child.stdout.write('{"status":"picked","hex":"#4080ff"}'); child.emit('close',0);
assert.deepEqual(await p,{status:'picked',hex:'#4080ff'}); ok('native jobs reject duplicates, enforce sender/token ownership, and preserve sampled bytes');
p=service.pick(a,'second');
let input=''; child.stdin.on('data',(data:Buffer)=>input+=data);
assert.equal(service.cancel(a,'second'),true); child.emit('close',0);
assert.equal(input,'cancel\n'); assert.deepEqual(await p,{status:'cancelled'});
assert.equal(a.listenerCount('destroyed'),0); ok('cancel closes portal through stdin and releases owner listeners');
p=service.pick(a,'third'); child.stdout.write('{"status":"picked","hex":"bogus"}'); child.emit('close',0);
assert.equal((await p).status,'error'); ok('invalid portal color never enters editor state');
p=service.pick(a,'fourth'); input=''; child.stdin.on('data',(data:Buffer)=>input+=data); a.emit('destroyed'); child.emit('close',0);
assert.equal(input,'cancel\n'); assert.equal((await p).status,'cancelled'); ok('window destruction closes pending portal request');
p=service.pick(a,'fifth'); child.emit('error',Error('ENOENT'));
assert.equal((await p).status,'unavailable'); ok('missing optional system runtime permits bounded window fallback');
await assert.rejects(service.pick(a,'../untrusted'),/Invalid/); ok('native request identity rejects invalid tokens');
await h.done();
