/** Actual browser glyph bounds for the shared pure furniture layout. */
import {mkdir,writeFile} from 'node:fs/promises';
import {launch,APP_URL} from './lib/driver.mjs';
import {harness} from './lib/harness.mjs';
const h=harness('verify-model3d-furniture-gui'),out='test-results/model3d/furniture-fit';await mkdir(out,{recursive:true});
const {browser,page}=await launch({width:1400,height:1000});
try{
 await page.goto(APP_URL,{waitUntil:'domcontentloaded'});
 const result=await page.evaluate(async()=>{
  const {furnitureLayout}=await import('/src/lib/model3d/furnitureLayout.ts'),{furnitureSvg}=await import('/src/lib/model3d/furniture.ts'),{orbitPose}=await import('/src/lib/model3d/orbit.ts');
  const fixtures=[
   {name:'Long scientific title',width:230,height:330,label:'Path distance from soma (µm)'},
   {name:'Unbroken identifier',width:180,height:420,label:'LongUnbrokenScientificIdentifierαβγ'},
   {name:'Edited range and legend font',width:360,height:560,label:'Membrane potential difference (mV)',legend:true,fields:{f:{range:[-99999,99999]}},overrides:{legend:{fontSize:18}}},
   {name:'Python default DejaVu Sans',width:300,height:480,label:'LongUnbrokenScientificIdentifierαβγ',font:'DejaVu Sans',fontSizePt:10},
  ];
  const root=document.createElement('main');root.style.cssText='display:flex;align-items:start;gap:20px;padding:20px;background:white;font:14px sans-serif;color:black';document.body.replaceChildren(root);document.body.style.cssText='margin:0;overflow:auto';
  const rows=[];
  for(const [i,fixture]of fixtures.entries()){
   const manifest={spec:'fluxplot/scene3d',schemaVersion:'0.1.0',glb:'test.glb',style:{font:fixture.font??'Arial',fontSizePt:fixture.fontSizePt??7},parts:[{id:'f',role:'surface-field',field:{cmap:{name:'c',stops:[[0,'#003366'],[1,'#ffe080']]},range:[0,250],label:fixture.label}},{id:'bar',role:'colorbar',field:'f'},...(fixture.legend?[{id:'part',role:'mesh',label:'ApicalDendriteLongScientificLabel'},{id:'legend',role:'legend',entries:['part']}]:[])]};
   const element={type:'model3d',id:'fit'+i,assetId:'test',x:0,y:0,width:fixture.width,height:fixture.height,orbitAzimuth:30,orbitElevation:20,orbitZoom:1,orbitProjection:'orthographic',orbitFov:30,fill:'#446688',fields:fixture.fields,overrides:fixture.overrides};
   const layout=furnitureLayout(manifest,element,element.overrides),pose=orbitPose(element,{min:[-1,-1,-1],max:[1,1,1]},layout.viewport),svg=furnitureSvg(manifest,element,pose,layout),v=layout.viewport;
   const card=document.createElement('section');card.innerHTML=`<p>${fixture.name}</p><svg xmlns="http://www.w3.org/2000/svg" width="${fixture.width}" height="${fixture.height}" style="border:1px solid #ccc;background:white"><rect x="${v.x}" y="${v.y}" width="${v.width}" height="${v.height}" fill="#f6f6f6"/>${svg.under}${svg.over}</svg>`;root.append(card);
   rows.push({name:fixture.name,layout,manifest,element});
  }
  await document.fonts.ready;
  return rows.map((row,i)=>{const svg=root.children[i].querySelector('svg'),bounds=[...svg.querySelectorAll('text')].map(t=>{const b=t.getBBox();return{text:t.textContent,x:b.x,y:b.y,right:b.x+b.width,bottom:b.y+b.height}});return {...row,bounds,fits:bounds.every(b=>b.x>=0&&b.y>=0&&b.right<=row.element.width&&b.bottom<=row.element.height)};});
 });
 for(const row of result){h.ok(!row.layout.overflow,`${row.name}: estimated guide layout fits`);h.ok(row.fits,`${row.name}: actual browser text bounds fit the box`);}
 await writeFile(`${out}/browser.json`,JSON.stringify(result,null,2));await page.screenshot({path:`${out}/contact.png`,fullPage:true});
}finally{await browser.close();}
await h.done();
