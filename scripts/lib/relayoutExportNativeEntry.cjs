'use strict';
const {app,BrowserWindow,nativeImage}=require('electron'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const dir=process.env.PROBE_SCRATCH,out=process.env.PROBE_ARTIFACTS;if(!dir||!out)throw Error('Disposable context required');
app.commandLine.appendSwitch('force-device-scale-factor','1');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{
 const win=new BrowserWindow({width:720,height:500,useContentSize:true,show:true,webPreferences:{contextIsolation:true,nodeIntegration:false}}),errors=[];
 win.webContents.on('console-message',details=>{if(details?.level==='error')errors.push(details.message)});
 await win.loadFile(path.join(dir,'figure.html'));await win.webContents.executeJavaScript('document.fonts.ready');await delay(100);
 const b64=await win.webContents.executeJavaScript(`(async()=>{const s=document.querySelector('svg'),xml=new XMLSerializer().serializeToString(s),image=new Image();image.src='data:image/svg+xml;base64,'+btoa(unescape(encodeURIComponent(xml)));await image.decode();const c=document.createElement('canvas');c.width=720;c.height=500;const ctx=c.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,720,500);ctx.drawImage(image,0,0,720,500);return c.toDataURL().split(',')[1]})()`);
 const png=Buffer.from(b64,'base64'),shot=await win.webContents.capturePage({x:0,y:0,width:720,height:500});fs.writeFileSync(path.join(out,'figure.png'),png);fs.writeFileSync(path.join(out,'canvas.png'),shot.toPNG());
 const expected=nativeImage.createFromBuffer(png).toBitmap(),actual=shot.toBitmap();assert.equal(actual.length,expected.length);let sum=0;for(let i=0;i<actual.length;i++)sum+=Math.abs(actual[i]-expected[i]);assert(sum/actual.length<.5,`PNG vs native canvas mean error ${sum/actual.length}`);
 const pdf=await win.webContents.printToPDF({pageSize:{width:720/96,height:500/96},printBackground:true,preferCSSPageSize:false,margins:{top:0,bottom:0,left:0,right:0}});fs.writeFileSync(path.join(out,'figure.pdf'),pdf);assert(pdf.subarray(0,5).equals(Buffer.from('%PDF-')));
 await win.loadFile(path.join(dir,'deck.html'));for(let i=0;i<100&&!await win.webContents.executeJavaScript('!!window.fluxDeck?.seek');i++)await delay(50);
 await win.webContents.executeJavaScript('window.fluxDeck.seek(0,1,500)');assert.equal(await win.webContents.executeJavaScript("document.querySelectorAll('[data-tween-ticks]').length"),2);
 await win.webContents.executeJavaScript('window.fluxDeck.goTo(0,1)');assert.equal(await win.webContents.executeJavaScript("document.querySelector('[data-el-id=\"p\"] svg').getAttribute('viewBox')"),'0 0 585 450');
 await win.webContents.executeJavaScript('window.fluxDeck.goTo(0,0);window.fluxDeck.play({slide:0,fromBeat:0,toBeat:1})');await delay(180);const time=await win.webContents.executeJavaScript('window.fluxDeck.state().time');assert(time>0&&time<1000);await delay(1000);assert.deepEqual(errors,[]);fs.writeFileSync(path.join(out,'deck.png'),(await win.webContents.capturePage()).toPNG());console.log('PROBE '+JSON.stringify({ok:true,pixelMeanError:sum/actual.length,playbackTime:time}));win.destroy();app.exit(0);
}).catch(e=>{console.error(e);app.exit(1)});setTimeout(()=>app.exit(2),60000).unref();
