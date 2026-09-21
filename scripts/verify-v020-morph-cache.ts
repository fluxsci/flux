import { createHash } from 'node:crypto';
import { planElementMorph, sampleElementMorph } from '../src/lib/slide/outline';
import type { Element } from '../src/lib/types';
import { harness } from './lib/harness.mjs';
const h=harness('verify-v020-morph-cache');
const base={id:'shape',x:0,y:0,width:200,height:100,rotation:0};
const rect:Element={...base,type:'rect',fill:'#ff0000',stroke:'none',strokeWidth:0,cornerRadius:18};
const oval:Element={...base,type:'ellipse',fill:'none',fillMap:{map:'fixture',axis:'x',stops:['#ff0000','#0000ff']},stroke:'#111111',strokeWidth:2};
const line:Element={...base,type:'line',x1:0,y1:0,x2:200,y2:100,stroke:'#000',strokeWidth:3,arrowStart:false,arrowEnd:true};
const curve:Element={...base,type:'path',d:'',closed:true,fill:'#225588',stroke:'none',strokeWidth:0,nodes:Array.from({length:200},(_,i)=>({x:100+90*Math.cos(i*Math.PI/100),y:50+40*Math.sin(i*Math.PI/100),type:'smooth',hIn:{dx:-.9,dy:-.4},hOut:{dx:.9,dy:.4}}))};
const cusp:Element={...base,type:'path',d:'',closed:false,fill:'none',stroke:'#000',strokeWidth:1,nodes:[{x:0,y:0,type:'corner'},{x:1e-10,y:1e-10,type:'corner'},{x:90,y:100,type:'corner',hIn:{dx:180,dy:-90}},{x:200,y:0,type:'corner'}]};
const cases:[Element,Element][]=[[rect,oval],[curve,oval],[line,oval],[cusp,rect],[{...curve,nodes:[...curve.nodes!].reverse()},rect],[{...rect,width:2e8,height:1e8},oval]];
const expected:string[]=["979d4ae1cd7a6299f569f9bf0bd50a3b269719e6e6cb4a14535187faae3c61a7", "c0226b7ab0ec065ccd05b0906fbff7e8903ae8847961a88ff1b1b2a5dea43532", "84132f685fb89fd22bd005575c1c2fff8bacbce19a40b7e8f9d52e9890719064", "9e7cd52efc632d080e9150ec5f91e1cf665f000af910907a355c7b797bef0796", "ce01fbce3d696071f78a54397622d2d1ebe20c366063d59c47ca1443a0a2bffd", "1c95fc3d301c1153feb51654e0903a3299b2f26c9c3d446a09c85b42dda33ab3"];
const elapsed:number[]=[];
for(let i=0;i<cases.length;i++){
 const start=performance.now(),plan=planElementMorph(...cases[i]);elapsed.push(performance.now()-start);
 if(!plan)throw new Error('fixture must produce a morph');
 const hash=createHash('sha256').update(JSON.stringify([0,.13,.5,.87,1].map(t=>sampleElementMorph(plan,t)))).digest('hex');
 if(process.env.FLUX_RECORD_MORPH==='1')console.log(JSON.stringify({i,hash,ms:elapsed[i]}));
 else h.eq(hash,expected[i],`correspondence, gradient and sampled geometry exactly match pre-cache oracle ${i}`);
}
console.log(JSON.stringify({preparationMs:elapsed}));
if(process.env.FLUX_RECORD_MORPH!=='1')await h.done();
