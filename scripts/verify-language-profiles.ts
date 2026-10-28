// Durable dictionary/mapping boundary, isolated from the owner's configuration.
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileLinksSupported} from './lib/symlinks.mjs';
import {LocalCorrectionProfile} from '../src/shell/modes/paper/editing/localCorrectionProfile';
import {SCIENTIFIC_VOCABULARY_VERSION} from '../src/shell/modes/paper/editing/scientificVocabulary';
const require=createRequire(import.meta.url);
const {registerLanguageProfiles}=require('../electron/ipc/languageProfiles.cjs');
const root=mkdtempSync(path.join(tmpdir(),'flux-language-profile-'));
try{
 const config=path.join(root,'config'),project=path.join(root,'project'),other=path.join(root,'other');
 for(const dir of [config,project,other])mkdirSync(dir);
 let active:string|null=project;
 const handlers=new Map<string,(event:unknown,payload:unknown)=>unknown>();
 // Each window saves its whole copy, so every OTHER window must hear of a save.
 const pushes:unknown[]=[];
 const writer={send:()=>assert.fail('the saving window is not told about its own save')},peer={send:(channel:string,change:unknown)=>pushes.push([channel,change])};
 registerLanguageProfiles({handle:(name:string,handler:(event:unknown,payload:unknown)=>unknown)=>handlers.set(name,handler)}, {
  configRoot:()=>config,rootForSender:()=>active,
  atomicWrite:(file:string,bytes:string)=>{mkdirSync(path.dirname(file),{recursive:true});writeFileSync(file,bytes);},
  otherRenderers:(sender:unknown)=>[writer,peer].filter(wc=>wc!==sender),
 });
 const get=(value='')=>handlers.get('correction:profileGet')!({sender:writer},value) as any;
 const set=(scope:string,data:unknown,projectRoot='')=>handlers.get('correction:profileSet')!({sender:writer}, {scope,data,projectRoot});
 assert.deepEqual([...handlers.keys()].sort(),['correction:profileGet','correction:profileSet']);
 assert.deepEqual(get().personal,{words:[],aliases:[]});
 const personal={words:['iGluSnFR4f','NREM'],aliases:[{trigger:'enviroment',expansion:'environment',learned:true}],scientificVocabularyVersion:1};
 assert.equal(set('personal',personal),true);assert.deepEqual(get().personal,personal);
 const shared={words:['SLAP2'],aliases:[],blockedPairs:['a\0b']};
 set('project',shared);assert.deepEqual(get().project,shared);
 assert.deepEqual(pushes,[['correction:profileChanged',{scope:'personal',projectRoot:''}],['correction:profileChanged',{scope:'project',projectRoot:project}]],'other windows hear each save, with the project it belongs to');
 pushes.length=0;
 assert.deepEqual(JSON.parse(readFileSync(path.join(project,'.flux','corrections.json'),'utf8')),shared);
 assert.throws(()=>get(other),/not active/);assert.throws(()=>set('project',shared,other),/not active/);
 assert.throws(()=>set('invalid',{}),/Invalid/);assert.throws(()=>set('personal',{data:'x'.repeat(300_000)}),/bound/);
 active=other;assert.deepEqual(get().personal,personal);assert.deepEqual(get().project,{words:[],aliases:[],blockedPairs:[]});
 active=null;assert.deepEqual(get().personal,personal);assert.throws(()=>get(project),/not active/);assert.throws(()=>set('project',{}),/not active/);
 if(fileLinksSupported()){
  active=other;symlinkSync(path.join(project,'.flux'),path.join(other,'.flux'),'dir');
  assert.throws(()=>get(),/escapes/);assert.throws(()=>set('project',{}),/escapes/);
  assert.deepEqual(JSON.parse(readFileSync(path.join(project,'.flux','corrections.json'),'utf8')),shared);
 }
 active=project;
 const personalFile=path.join(config,'Language','corrections.json');
 const acceptedBytes=readFileSync(personalFile,'utf8');
 for(const damaged of ['{"words":', '{"words":"broken","aliases":[]}', '[]', 'x'.repeat(300_000)]){
  writeFileSync(personalFile,damaged);
  assert.throws(()=>get(),/corrupt|bounded/);
  assert.throws(()=>set('personal',personal),/corrupt|bounded/);
  assert.equal(readFileSync(personalFile,'utf8'),damaged,'damaged profile bytes remain intact after read and attempted seed/write');
 }
 writeFileSync(personalFile,acceptedBytes);
 const nativeFs=require('node:fs'),originalRead=nativeFs.readFileSync;
 try{
  nativeFs.readFileSync=(file:unknown,...args:unknown[])=>{
   if(file===personalFile)throw Object.assign(new Error('injected permission failure'),{code:'EACCES'});
   return originalRead(file,...args);
  };
  assert.throws(()=>get(),/preserved.*permission/);
  assert.throws(()=>set('personal',personal),/preserved.*permission/);
 }finally{nativeFs.readFileSync=originalRead;}
 assert.equal(readFileSync(personalFile,'utf8'),acceptedBytes);
 assert.deepEqual(pushes,[],'a refused save announces nothing');
 assert.throws(()=>set('personal',null),/not an object/);
 assert.throws(()=>set('personal',{aliases:[{}]}),/aliases are invalid/);
 assert.throws(()=>set('personal',{words:[],aliases:[],scientificSeedWords:'wrong'}),/seed provenance is invalid/);
 const provenance={...personal,scientificSeedWords:['NREM']};set('personal',provenance);assert.deepEqual(get().personal,provenance);

 // Renderer hydration must surface a failed durable read and never issue a
 // seed or later mutation write against that damaged native profile.
 const previousWindow=(globalThis as any).window;
 try{
  let writes=0;const notices:string[]=[];
  (globalThis as any).window={fig:{correctionProfileGet:async()=>{throw Error('injected corrupt profile');},correctionProfileSet:async()=>{writes++;return true;}},dispatchEvent:(event:CustomEvent)=>{notices.push(event.detail.message);return true;}};
  const values=new Map<string,string>();const storage={getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>void values.set(key,value)};
  const broken=new LocalCorrectionProfile('isolated-test',storage);
  assert.equal(await broken.ready(),false);assert.match(broken.error(),/Existing files are preserved/);
  broken.addWord('authoredWord','personal');broken.setAlias('enviroment','environment','personal',true);
  await Promise.resolve();
  assert.equal(writes,0,'neither initial seed nor explicit mutations overwrite an unreadable native profile');
  assert.ok(notices.some(message=>message.includes('injected corrupt profile')),'the failure is visible to the editor UI');
  (globalThis as any).window={fig:{correctionProfileGet:async()=>({personal:{words:[],aliases:[],scientificVocabularyVersion:SCIENTIFIC_VOCABULARY_VERSION},project:{words:[],aliases:[],blockedPairs:[]}}),correctionProfileSet:async()=>{writes++;throw Error('disk full');}},dispatchEvent:(event:CustomEvent)=>{notices.push(event.detail.message);return true;}};
  const clean=new LocalCorrectionProfile('clean-test',storage);assert.equal(await clean.ready(),true);
  assert.deepEqual(clean.words('personal'),[],'an intentionally empty, versioned durable dictionary stays empty');
  clean.addWord('authoredWord','personal');await Promise.resolve();await Promise.resolve();
  assert.match(clean.error(),/disk full/);assert.ok(notices.some(message=>message.includes('disk full')),'a failed profile write is visible and retains the in-memory word');
  assert.ok(clean.hasWord('authoredWord','personal'));
 }finally{if(previousWindow===undefined)delete (globalThis as any).window;else(globalThis as any).window=previousWindow;}
 console.log('Language profiles PASS: durability, scopes, sender binding, other-window notification, bounds, symlink confinement, corrupt/unreadable byte preservation and visible renderer errors');
}finally{rmSync(root,{recursive:true,force:true});}
