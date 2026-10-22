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
const expected:string[]=["c6ffb90557fd913056b2c949ec73d5a2519081d2fa6e77c2c744872a3c74e055", "c667995af49ee003d9df4fa805bad4dcc18481cf96ad46160d2dfd512be1225a", "450250b369990e9e0e2ae2b5fde02a7669d65ba782f46fdab56d8df3140d1567", "49f3116ec3fae764e90878a3bb93cff4d0b28df2b26d437ad7ca3d862b2642ba", "5ebe62b00c63e3a6aefbab5154864d12587eb6c622ac7011d331b6804d4a8d94", "98a4d22d528d9fb1feb01afd9c35f0bff6375c88b05fc4f4aa2b2c4692fe4e9e"];
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
