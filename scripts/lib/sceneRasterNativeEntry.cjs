"use strict";
// Actual sandboxed preload/IPC and Electron-as-Node raster worker, with no
// renderer development handles and no user project/configuration.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs/promises'), path = require('node:path'), assert = require('node:assert/strict');
const scratch = process.env.PROBE_SCRATCH, repo = process.env.PROBE_APP_ROOT;
if (!scratch || !repo) throw Error('Native scene raster requires an isolated scratch environment');
app.setPath('userData', path.join(scratch, 'userdata'));
app.disableHardwareAcceleration();
let family, win;
async function main() {
  await app.whenReady();
  family = require(path.join(repo, 'electron/ipc/sceneRaster.cjs')).createSceneRasterFamily({ app, appRoot: repo, rootFor: () => scratch, fontIndexFile: () => path.join(scratch, 'fonts.json') });
  family.registerHandlers(ipcMain);
  win = new BrowserWindow({ show: false, width: 500, height: 300, webPreferences: { offscreen: true, preload: path.join(repo, 'electron/preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false } });
  await win.loadURL('data:text/html,<html><body>Isolated scene raster acceptance</body></html>');
  const result = await win.webContents.executeJavaScript(`(async()=>{
    if(window.__flux||typeof require!=='undefined')throw Error('Renderer is not isolated');
    const svg='<svg xmlns="http://www.w3.org/2000/svg" width="100" height="60"><rect width="100" height="60" fill="white"/><text x="2" y="20" font-family="Gelasio" font-weight="600" font-size="18">Frame</text><path d="M50 30V55" stroke="red" stroke-width="4" vector-effect="non-scaling-stroke"/></svg>';
    const result=await window.fig.rasterizeScene({rid:'native-preload',svg,regions:[{bx:0,by:0,bw:100,bh:60,width:200,height:120}]});
    if(result.error||!result.rasters?.length)throw Error(result.error||'No native raster');
    const r=result.rasters[0],img=new Image(),url=URL.createObjectURL(new Blob([r.bytes],{type:'image/png'}));img.src=url;await img.decode();
    const c=document.createElement('canvas');c.width=r.width;c.height=r.height;const ctx=c.getContext('2d');ctx.drawImage(img,0,0);URL.revokeObjectURL(url);
    const p=ctx.getImageData(0,0,c.width,c.height).data;let width=0,ink=0;
    for(let x=0;x<c.width;x++){const i=(90*c.width+x)*4;if(p[i]>200&&p[i+1]<50&&p[i+2]<50)width++}
    for(let y=0;y<50;y++)for(let x=0;x<c.width;x++){const i=(y*c.width+x)*4;if(p[i]<100&&p[i+1]<100&&p[i+2]<100)ink++}
    const rejected=await window.fig.rasterizeScene({rid:'native-resource',svg:'<svg xmlns="http://www.w3.org/2000/svg"><image href="file:///etc/passwd"/></svg>',regions:[{bx:0,by:0,bw:10,bh:10,width:10,height:10}]});
    await window.fig.cancelSceneRaster('already-finished');
    return {width:r.width,height:r.height,stroke:width,ink,contained:!!rejected.error,png:Array.from(r.bytes.slice(0,8))};
  })()`);
  assert.equal(result.width, 200); assert.equal(result.height, 120); assert.equal(result.stroke, 4); assert.ok(result.ink > 100); assert.ok(result.contained);
  assert.deepEqual(result.png, [137,80,78,71,13,10,26,10]);
  await fs.writeFile(path.join(scratch, 'native-result.json'), JSON.stringify({ ...result, electron: process.versions.electron, chrome: process.versions.chrome, platform: process.platform, userData: app.getPath('userData') }, null, 2));
  console.log('SCENE RASTER NATIVE: PASS — sandboxed actual preload, child PNG, exact Gelasio weight, non-scaling stroke, resource refusal');
}
function finish(code) { family?.shutdown(); win?.destroy(); app.exit(code); }
main().then(() => finish(0), error => { console.error(error); finish(1); });
