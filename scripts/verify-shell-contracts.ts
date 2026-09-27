import assert from 'node:assert/strict';
import { z } from 'zod';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { CliArgSpec } from '../flux-core/registry';
import { VERBS, parseCliFlags, runCliVerb, registryHelp, errorToCli, errorToMcp } from '../flux-core/registry';
import { LockedError, ValidationError, ExternalToolError } from '../flux-core/errors';
import { decodeBridge } from '../flux-core/liveClient';
import { decodeRecents } from '../src/shell/storageValidation';
import { decodeSettings } from '../src/lib/settings';
import { decodePreferences } from '../src/lib/preferences';
const grobid=VERBS.find(v=>v.cli==='grobid')!;
const original=grobid.handler;
try {
  let captured:Record<string,unknown>|undefined;
  grobid.handler=async(_ctx,args)=>{captured=args;return {processed:[],skipped:[],failed:[],totalWithPdf:0,elapsedMs:0};};
  const parsed=parseCliFlags('grobid',['--run','--keys=alpha,beta','--root','/fixture']);
  const errors:string[]=[];
  await runCliVerb('grobid',{pos:parsed._,posRooted:parsed._,flags:parsed.flags,rootPositional:'/fixture',rootFlags:'/fixture'}, {log(){},err:s=>errors.push(s),setExit:code=>{throw new Error(`unexpected exit ${code}: ${errors.join('; ')}`);}});
  assert.deepEqual(captured?.keys,['alpha','beta']);assert.equal(captured?.run,true);
} finally {grobid.handler=original;}
assert.deepEqual(parseCliFlags('set-style',['--italic','el1','--font-size=-2','--','--literal'])._,['el1','--literal']);
assert.equal(parseCliFlags('set-style',['--italic','el1']).flags.italic,true);
assert.equal(parseCliFlags('set-style',['--italic=false','el1']).flags.italic,'false');
assert.throws(()=>parseCliFlags('set-style',['--unknown','x']),/unknown flag/);
assert.throws(()=>parseCliFlags('set-style',['--font-size']),/requires a value/);
assert.deepEqual(parseCliFlags('citing',['--s2','Smith2026'])._,['Smith2026']);
assert.equal(parseCliFlags('keys',['--s2','secret']).flags.s2,'secret');
assert.deepEqual(parseCliFlags('tag',['--remove','Smith2026','checked'])._,['Smith2026','checked']);
assert.equal(parseCliFlags('annotations',['--key','Smith2026','--md']).flags.md,true);
assert.match(registryHelp('grobid'),/--keys/);assert.match(registryHelp('export-deck'),/--saved/);
assert.equal(errorToCli(new LockedError('held')).exit,75);
assert.equal(errorToMcp(new ValidationError('bad')).isError,true);
assert.equal(errorToCli(new ExternalToolError('tool',9)).exit,9);
for(const url of ['http://example.org:1234','http://127.0.0.1:1234@remote.test:1234','https://127.0.0.1:1234','http://127.0.0.1:1234/redirect','http://127.0.0.1:1234?x=1']) assert.equal(decodeBridge({url,port:1234,token:'t'}),null);
assert.equal(decodeBridge({url:'http://127.0.0.1:1234',port:4321,token:'t'}),null);
assert.equal(decodeBridge({url:'http://127.0.0.1:1234',port:1234,token:'t'})?.port,1234);
for(const value of [null,'corrupt',3,[],{foo:true}])assert.deepEqual(decodeRecents(value),[]);
const row={name:'Valid',path:'/good',openedAt:1};assert.deepEqual(decodeRecents([row,row,{name:'bad',path:9,openedAt:1}]),[row]);
const defaults=decodeSettings(null);assert.equal(decodeSettings({showGrid:'yes',gridSize:NaN,paperMarginScene:'unknown'}).showGrid,defaults.showGrid);
assert.equal(decodeSettings({gridSize:-5,captionFontSize:100,paperCaretFeel:'monkeytype'}).gridSize,1);
assert.equal(decodeSettings({captionFontSize:100}).captionFontSize,28);
assert.equal(decodeSettings({paperCaretFeel:'monkeytype'}).paperCaretFeel,'smooth');
assert.deepEqual(decodePreferences({width:'bad',enabled:1,extra:true},{width:200,enabled:false},{width:{min:100,max:500}}),{width:200,enabled:false});
console.log('CLI handler coercion, parser, error taxonomy, live endpoint metadata, preference migration/validation PASS');

// Every declared coercion reaches a real handler through the shared parser and
// invocation adapter. The fixture temporarily replaces one registered contract.
const fixture=await mkdtemp(path.join(os.tmpdir(),'flux-coercions-'));
const file=path.join(fixture,'text.md');await writeFile(file,'α\nno extra newline');
const originalContract={params:grobid.params,cliArgs:grobid.cliArgs,handler:grobid.handler,render:grobid.render};
try {
  const values: {as:CliArgSpec['as'];argv:string[];expected:unknown;kind?:'rest'}[]=[
    {as:undefined,argv:['--sample=literal'],expected:'literal'},
    {as:'string',argv:['--sample=10'],expected:'10'},
    {as:'trim',argv:['--sample=  α  '],expected:'α'},
    {as:'number',argv:['--sample','-2.5'],expected:-2.5},
    {as:'boolean',argv:['--sample=false'],expected:false},
    {as:'csv',argv:['--sample=a,b'],expected:['a','b']},
    {as:'csvNum',argv:['--sample=1,NaN,-2.5'],expected:[1,-2.5]},
    {as:'json',argv:['--sample={"x":2}'],expected:{x:2}},
    {as:'path',argv:['relative file.svg'],expected:[path.resolve('relative file.svg')],kind:'rest'},
    {as:'joined',argv:['two','words'],expected:'two words',kind:'rest'},
    {as:'ptToPx',argv:['--sample=9'],expected:12},
    {as:'fileText',argv:['--sample',file],expected:'α\nno extra newline'},
  ];
  for(const item of values){
    grobid.params={value:z.unknown().optional()};grobid.cliArgs=[{kind:item.kind??'flag',at:item.kind?0:'sample',into:'value',as:item.as}];grobid.render={human:()=>({})};
    let received:unknown;grobid.handler=(_ctx,args)=>{received=args.value;};
    const parsed=parseCliFlags('grobid',item.argv);
    await runCliVerb('grobid',{pos:parsed._,posRooted:parsed._,flags:parsed.flags,rootPositional:fixture,rootFlags:fixture},{log(){},err(message){throw Error(message);},setExit(code){throw Error(`unexpected ${code}`);}});
    assert.deepEqual(received,item.expected,`${item.as??'identity'} parsed handler argument`);
  }
} finally {Object.assign(grobid,originalContract);await rm(fixture,{recursive:true,force:true});}
console.log('All12 coercion cases reach the registry handler with exact expected values PASS');
