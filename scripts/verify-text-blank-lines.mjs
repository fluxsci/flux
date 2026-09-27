// Empty SVG tspans ignore dy. Pin painted baselines in the editor and exported
// SVG, including leading/consecutive lines, wrap caches and script resets.
import {launch,gotoApp,clickMode,errors} from './lib/driver.mjs';
import {harness} from './lib/harness.mjs';
const h=harness('verify-text-blank-lines');const {browser,page}=await launch();
try {
 await gotoApp(page,{url:'http://127.0.0.1:1420/?fixture=demo'});await clickMode(page,'Figure');
 const result=await page.evaluate(async()=>{
   const F=window.__flux;const {makeText}=await import('/src/lib/ops.ts');const {elementToSvg}=await import('/src/lib/export.ts');
   const text='\nfirst\n\nsecond\n\n\nthird\n';
   F.fig.commit(p=>{const f=p.figures[0];f.elements=['auto','auto-h','fixed'].map((sizing,i)=>({...makeText(text,{x:10+i*160,y:20,width:140,height:250}),id:`blank-${i}`,fontSize:12,sizing,lineHeight:1.5,paragraphSpacing:3}));for(const e of f.elements)F.text.applyTextLayout(e);});
   const els=F.get(F.fig.project).figures[0].elements;
   const container=document.createElement('div');container.id='exported-blank-test';container.innerHTML='<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400">'+els.map(e=>elementToSvg(e,()=>null)).join('')+'</svg>';document.body.append(container);
   await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
   const baselines=host=>[...host.querySelectorAll('g.el[data-editor-element-id^="blank-"] text, #exported-blank-test text')].map(t=>[...t.children].filter(s=>s.textContent.trim()).map(s=>s.getStartPositionOfChar(0).y));
   return {editor:baselines(document.querySelector('.scene-svg')),exported:baselines(container),text:els.map(e=>e.text)};
 });
 const expected=[53,95,158];
 for(const [surface,sets] of Object.entries({editor:result.editor,export:result.exported}))for(const [i,values]of sets.entries())h.ok(values.length===expected.length && values.every((v,j)=>Math.abs(v-expected[j])<.001),`${surface} sizing ${i} paints every blank line (${values})`);
 h.ok(result.editor.length===3&&result.exported.length===3,'all three sizing modes exercised');
 h.ok(result.text.every(t=>t==='\nfirst\n\nsecond\n\n\nthird\n'),'authored leading, interior and trailing newlines unchanged');
 const scripts=await page.evaluate(async()=>{
   const F=window.__flux;const {makeText}=await import('/src/lib/ops.ts');const {elementToSvg}=await import('/src/lib/export.ts');
   F.fig.commit(p=>{p.figures[0].elements=['super','sub'].map((script,i)=>({...makeText('x2\n\nnormal',{x:10+i*200,y:20,width:150,height:150}),id:`script-${i}`,fontSize:12,sizing:'fixed',lineHeight:1.5,paragraphSpacing:3,runs:[{from:1,to:2,script}]}));});
   document.querySelector('#exported-blank-test').innerHTML='<svg xmlns="http://www.w3.org/2000/svg" width="500" height="300">'+F.figures()[0].elements.map(e=>elementToSvg(e,()=>null)).join('')+'</svg>';
   await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
   const ys=selector=>[...document.querySelectorAll(selector)].map(t=>t.lastElementChild.getStartPositionOfChar(0).y);
   return {editor:ys('.scene-svg g.el text'),exported:ys('#exported-blank-test text')};
 });
 h.ok([...scripts.editor,...scripts.exported].every(y=>Math.abs(y-74)<.001),'blank lines also carry superscript and subscript resets into editor and export');
 h.ok(errors(page).length===0,'clean console',errors(page));
}finally{await browser.close()}await h.done();
