// Native PDF.js smoke: the current worker paints a PDF containing a real OpenAction
// JavaScript form mutation, while Flux's ordinary Reader keeps the action inert.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(),'flux-pdf-inert-'));
process.env.HOME = path.join(scratch,'home'); process.env.USERPROFILE=process.env.HOME;
process.env.XDG_CONFIG_HOME = path.join(scratch,'config'); process.env.APPDATA=path.join(scratch,'appdata'); process.env.FLUX_NO_MIGRATE='1';
for(const p of [process.env.HOME,process.env.XDG_CONFIG_HOME,process.env.APPDATA]) fs.mkdirSync(p,{recursive:true});
const url = new URL(process.env.FLUX_URL || 'http://127.0.0.1:1420/'); url.search='';
process.env.VITE_DEV_SERVER_URL=url.href;
const {app,BrowserWindow}=require('electron'); app.disableHardwareAcceleration();
const text='BT /F1 18 Tf 72 720 Td (Scientific PDF worker renders safely) Tj ET';
const objects=[
'<< /Type /Catalog /Pages 2 0 R /OpenAction 6 0 R /AcroForm << /Fields [7 0 R] /DR << /Font << /Helv 5 0 R >> >> /DA (/Helv 12 Tf 0 g) /NeedAppearances true >> >>',
'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R /Annots [7 0 R] >>',
`<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`,
'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
'<< /S /JavaScript /JS (this.getField\\("Marker"\\).value = "EXECUTED"; app.alert\\("FLUX_SCRIPT_EXECUTED"\\);) >>',
'<< /Type /Annot /Subtype /Widget /FT /Tx /T (Marker) /V (INERT) /Rect [72 650 260 675] /P 3 0 R /F 4 /DA (/Helv 12 Tf 0 g) >>'
];
let pdf='%PDF-1.7\n',offsets=[0]; objects.forEach((body,i)=>{offsets.push(Buffer.byteLength(pdf));pdf+=`${i+1} 0 obj\n${body}\nendobj\n`;});
const xref=Buffer.byteLength(pdf);pdf+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`+offsets.slice(1).map(n=>`${String(n).padStart(10,'0')} 00000 n \n`).join('')+`trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
fs.writeFileSync(path.join(scratch,'scripting-fixture.pdf'),pdf);
// Valid Standard Security R2 fixture: both failure without a password and
// successful decryption are checked, so a malformed PDF cannot stand in for it.
function lockedPdf() {
 const crypto=require('node:crypto'),md5=b=>crypto.createHash('md5').update(b).digest();
 const padding=Buffer.from('28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a','hex');
 const padded=s=>Buffer.concat([Buffer.from(s,'latin1'),padding]).subarray(0,32);
 const rc4=(key,input)=>{const S=Array.from({length:256},(_,i)=>i);let j=0;for(let i=0;i<256;i++){j=(j+S[i]+key[i%key.length])&255;[S[i],S[j]]=[S[j],S[i]];}let i=0;j=0;return Buffer.from([...input].map(x=>{i=(i+1)&255;j=(j+S[i])&255;[S[i],S[j]]=[S[j],S[i]];return x^S[(S[i]+S[j])&255];}));};
 const owner=rc4(md5(padded('fixture-owner')).subarray(0,5),padded('flux-fixture'));
 const id=Buffer.from('0123456789abcdef0123456789abcdef','hex'),permissions=Buffer.alloc(4);permissions.writeInt32LE(-4);
 const key=md5(Buffer.concat([padded('flux-fixture'),owner,permissions,id])).subarray(0,5),user=rc4(key,padding);
 const stream=rc4(md5(Buffer.concat([key,Buffer.from([4,0,0,0,0])])).subarray(0,10),Buffer.from('BT /F1 12 Tf 72 720 Td (Valid encrypted scientific fixture) Tj ET'));
 const objs=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',`<< /Length ${stream.length} >>\nstream\n${stream.toString('latin1')}\nendstream`,'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Filter /Standard /V 1 /R 2 /O <${owner.toString('hex')}> /U <${user.toString('hex')}> /P -4 >>`];
 let out='%PDF-1.4\n';const offsets=[0];objs.forEach((o,i)=>{offsets.push(out.length);out+=`${i+1} 0 obj\n${o}\nendobj\n`;});const x=out.length;
 out+=`xref\n0 ${objs.length+1}\n0000000000 65535 f \n`+offsets.slice(1).map(n=>`${String(n).padStart(10,'0')} 00000 n \n`).join('')+`trailer\n<< /Size ${objs.length+1} /Root 1 0 R /Encrypt 6 0 R /ID [<${id.toString('hex')}> <${id.toString('hex')}>] >>\nstartxref\n${x}\n%%EOF\n`;
 return Buffer.from(out,'latin1');
}
const encryptedPdf=lockedPdf();

try { require('../electron/main.cjs'); } catch (error) { fs.writeSync(2,String(error.stack||error)+'\n'); app.exit(1); }
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function wait(fn,label){const end=Date.now()+30000;while(Date.now()<end){try{const r=await fn();if(r)return r;}catch{}await sleep(100);}throw Error(`timeout ${label}`);}
const watchdog=setTimeout(()=>{fs.writeSync(2,'PDF INERT VERIFY timeout\n');app.exit(2);},45000);
app.whenReady().then(async()=>{
 const engine=await import('pdfjs-dist/legacy/build/pdf.mjs');
 const passwordTask=engine.getDocument({data:new Uint8Array(encryptedPdf),password:'flux-fixture',useWorkerFetch:false,isEvalSupported:false,useSystemFonts:false,verbosity:0});
 try {const doc=await passwordTask.promise;const page=await doc.getPage(1);const text=(await page.getTextContent()).items.map(i=>i.str).join('');if(!text.includes('Valid encrypted scientific fixture'))throw Error('Encrypted fixture did not decrypt valid scientific text');}finally{await passwordTask.destroy();}

 const win=await wait(()=>BrowserWindow.getAllWindows()[0],'native window');
 const js=code=>win.webContents.executeJavaScript(code);
 await wait(()=>js('!!(window.fig && window.__flux && window.__fluxSeedReaderItem && window.__fluxOpenReader)'),'real preload and Reader');
 await js(`window.__flux.shell.currentProject.set({name:'Native PDF fixture',path:null});window.__flux.shell.view.set('workspace');window.__flux.panes.resetPanes('reader');window.__fluxPdfExecuted=false;window.__fluxSeedReaderItem('inertFixture',${JSON.stringify(Buffer.from(pdf).toString('base64'))},{version:1,annotations:[]});window.__fluxOpenReader('inertFixture');`);
 await wait(()=>js('Number(document.querySelector(\'[data-testid="pdf-root"]\')?.dataset.rendered||0)>0'),'painted current PDF worker');
 const field=await wait(()=>js('document.querySelector(\'input[name="Marker"]\')?.value'),'PDF form fixture');
 if(field!=='INERT')throw Error(`PDF OpenAction ran: ${field}`);
 const result=await js(`(()=>{const c=document.querySelector('.pdf-page canvas');const data=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let dark=0;for(let i=0;i<data.length;i+=4)if(data[i]+data[i+1]+data[i+2]<500)dark++;return {dark,width:c.width,height:c.height,marker:window.__fluxPdfExecuted,text:document.querySelector('.textLayer')?.textContent};})()`);
 if(result.dark<100 || !result.text.includes('Scientific PDF worker') || result.marker)throw Error(`PDF rendering/inert assertion ${JSON.stringify(result)}`);
 const cleanup=await js(`(async()=>{
   const NativeWorker=window.Worker;let created=0,active=0;const terminated=new WeakSet();
   window.Worker=class extends NativeWorker {constructor(...args){super(...args);created++;active++;}terminate(){if(!terminated.has(this)){terminated.add(this);active--;}return super.terminate();}};
   try {
     const {extractFulltextText}=await import('/src/lib/pdf/pdfFulltext.ts');
     const {extractPdfSignals}=await import('/src/lib/pdf/pdfSignals.ts');
     let rejected=0,passwordRejected=0;
     const encrypted=Uint8Array.from(atob(${JSON.stringify(encryptedPdf.toString("base64"))}),c=>c.charCodeAt(0));
     for(let i=0;i<6;i++)for(const load of [extractFulltextText,extractPdfSignals]){
       const bytes=i%3===2?encrypted:new Uint8Array(i%3?[37,80,68,70,45,105,110,118,97,108,105,100]:[]);
       try{await load(bytes);}catch(error){rejected++;if(error.name==='PasswordException')passwordRejected++;}
       if(active!==0)throw Error('Rejected PDF retained '+active+' workers');
     }
     return {created,active,rejected,passwordRejected};
   }finally{window.Worker=NativeWorker;}
 })()`);
 if(cleanup.created!==12||cleanup.active!==0||cleanup.rejected!==12||cleanup.passwordRejected!==4)throw Error('PDF failed-task ownership '+JSON.stringify(cleanup));
 const out=process.env.FLUX_OUT||path.join(process.cwd(),'test-results','pdf-inert');fs.mkdirSync(out,{recursive:true});
 fs.writeFileSync(path.join(out,'pdf-inert.png'),(await win.webContents.capturePage()).toPNG());
 fs.writeFileSync(path.join(out,'pdf-inert.json'),JSON.stringify({...result,field,cleanup,pdfBytes:Buffer.byteLength(pdf),electron:process.versions.electron},null,2));
 fs.writeSync(1,`PDF INERT VERIFY: PASS — actual native Reader, rendered text/pixels, OpenAction form remains ${field}\n`);
 clearTimeout(watchdog);win.destroy();fs.rmSync(scratch,{recursive:true,force:true});app.exit(0);
}).catch(async error=>{clearTimeout(watchdog);fs.writeSync(2,String(error.stack||error)+'\n');
 const out=process.env.FLUX_OUT||path.join(process.cwd(),'test-results','pdf-inert');fs.mkdirSync(out,{recursive:true});
 const win=BrowserWindow.getAllWindows()[0];if(win){fs.writeFileSync(path.join(out,'failure.png'),(await win.webContents.capturePage()).toPNG());fs.writeFileSync(path.join(out,'failure.txt'),await win.webContents.executeJavaScript('document.body.innerText'));}
 app.exit(1);});
