import assert from 'node:assert/strict';
import {launch,gotoApp,realErrors} from './lib/driver.mjs';
const {browser,page}=await launch();
try{
  await gotoApp(page,{url:'http://127.0.0.1:1420/?fixture=demo'});
  const result=await page.evaluate(async()=>{
    const io=await import('/src/lib/io.ts');
    const f={id:'export-test',canvasId:'c',name:'Before',x:-50,y:-30,width:320,height:240,background:'#ffffff',elements:[
      {id:'r',type:'rect',x:40.5,y:30.5,width:150,height:120,rotation:17,fill:'#ab5522',stroke:'#000000',strokeWidth:.6,cornerRadius:7},
      {id:'t',type:'text',x:20,y:170,width:280,height:30,rotation:0,text:'Sharp vectors 123',fontSize:12,fontFamily:'Arial',fontWeight:400,fontStyle:'normal',align:'left',color:'#111111',sizing:'fixed'},
    ]};
    const svg=io.buildFigureSvg({...f,background:'transparent'});
    const url=URL.createObjectURL(new Blob([svg],{type:'image/svg+xml'}));
    const img=new Image();await new Promise((resolve,reject)=>{img.onload=resolve;img.onerror=reject;img.src=url});
    const canvas=document.createElement('canvas');canvas.width=600;canvas.height=450;
    const ctx=canvas.getContext('2d');ctx.drawImage(img,0,0,600,450);URL.revokeObjectURL(url);
    const expected=ctx.getImageData(0,0,600,450).data;
    const png=await io.renderFigureBytes(f,{format:'png',mm:25.4,dpi:600,transparent:true});
    const bitmap=await createImageBitmap(new Blob([png],{type:'image/png'}));
    ctx.clearRect(0,0,600,450);ctx.drawImage(bitmap,0,0);bitmap.close();
    const actual=ctx.getImageData(0,0,600,450).data;
    let total=0,changed=0,max=0,alphaMax=0,premultMax=0,premultTotal=0;
    for(let i=0;i<actual.length;i++){const d=Math.abs(expected[i]-actual[i]);total+=d;if(d)changed++;max=Math.max(max,d)}
    for(let i=0;i<actual.length;i+=4){
      alphaMax=Math.max(alphaMax,Math.abs(actual[i+3]-expected[i+3]));
      for(let c=0;c<3;c++){const d=Math.abs(actual[i+c]*actual[i+3]/255-expected[i+c]*expected[i+3]/255);premultMax=Math.max(premultMax,d);premultTotal+=d}
    }
    const tiff=await io.renderFigureBytes(f,{format:'tiff',mm:25.4,dpi:600,transparent:true});
    const view=new DataView(tiff.buffer);const offset=view.getUint32(4,true);const tags={};
    for(let i=0;i<view.getUint16(offset,true);i++){const j=offset+2+i*12;tags[view.getUint16(j,true)]=view.getUint32(j+8,true)}
    let tiffDifference=0,tiffAlphaMax=0,tiffVisualMax=0;for(let i=0;i<actual.length;i++)tiffDifference+=Math.abs(actual[i]-tiff[tags[273]+i]);
    for(let i=0;i<actual.length;i+=4){
      const start=tags[273]+i;
      tiffAlphaMax=Math.max(tiffAlphaMax,Math.abs(actual[i+3]-tiff[start+3]));
      for(let c=0;c<3;c++)tiffVisualMax=Math.max(tiffVisualMax,Math.abs(Math.round(actual[i+c]*actual[i+3]/255)-Math.round(tiff[start+c]*tiff[start+3]/255)));
    }
    const save=window.fig.save,write=window.fig.writeText,pdf=window.fig.exportPdf;
    let svgOutput='',pdfOutput=null;
    window.fig.save=async()=>{f.width=999;f.name='After';f.elements[0].fill='#0000ff';return '/isolated-export'};
    window.fig.writeText=async(_path,text)=>{svgOutput=text};
    window.fig.exportPdf=async(svg,_path,w,h)=>{pdfOutput={svg,w,h}};
    try{
      await io.exportFigureSvg(f);
      f.width=320;f.name='Before';f.elements[0].fill='#ab5522';
      await io.exportFigurePdf(f);
    }finally{window.fig.save=save;window.fig.writeText=write;window.fig.exportPdf=pdf;}
    let invalid='';try{await io.renderFigureBytes(f,{format:'png',mm:1e9,dpi:1200})}catch(e){invalid=e.message}
    return {tiffAlphaMax,tiffVisualMax,alphaMax,premultMax,premultMean:premultTotal/actual.length,mean:total/actual.length,changed,max,tiffDifference,svgOutput,pdfOutput,invalid,tags};
  });
  console.log({alphaMax:result.alphaMax,premultMax:result.premultMax,premultMean:result.premultMean,mean:result.mean,changed:result.changed,max:result.max,tiffDifference:result.tiffDifference});
  assert.equal(result.alphaMax,0,'raster coverage exactly matches the established SVG draw');
  assert.ok(result.premultMax < 1.01 && result.premultMean < .001,'bitmap transfer changes visible color by at most one 8-bit rounding unit');
  assert.equal(result.tiffAlphaMax,0,'PNG and TIFF retain identical transparency');
  assert.ok(result.tiffVisualMax <= 1,'PNG decode and TIFF retain the same visible pixels within 8-bit premultiplication rounding');
  assert.equal(result.tags[338],2,'TIFF retains unassociated transparency');
  assert.match(result.svgOutput,/#ab5522/);assert.doesNotMatch(result.svgOutput,/#0000ff/,'SVG captures artwork before dialog');
  assert.equal(result.pdfOutput.w,320,'PDF dimensions captured before dialog');assert.match(result.pdfOutput.svg,/#ab5522/);
  assert.match(result.invalid,/exceeds.*canvas/,'reject impossible allocation without changing resolution');
  assert.deepEqual(realErrors(page),[]);
  console.log('FIGURE EXPORT POLISH: PASS');
}finally{await browser.close()}
