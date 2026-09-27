// Observed browser state, separate from the requested launch configuration.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
export async function recordBrowserRuntime(page, { label = 'browser', directory = process.env.FLUX_OUT || 'test-results/out', appBuild = null } = {}) {
  const browser = page.browser();
  const session = await browser.target().createCDPSession();
  let system, version;
  try { [system,version] = await Promise.all([session.send('SystemInfo.getInfo'),session.send('Browser.getVersion')]); }
  finally { await session.detach(); }
  const surface = await page.evaluate(() => ({ url: location.href, viewport:{width:innerWidth,height:innerHeight}, outer:{width:outerWidth,height:outerHeight}, screen:{width:screen.width,height:screen.height,availableWidth:screen.availWidth,availableHeight:screen.availHeight}, deviceScaleFactor:devicePixelRatio, modules:[...document.querySelectorAll('script[type="module"][src]')].map(el=>el.src) }));
  const gpu = system.gpu;
  const renderer = String(gpu?.auxAttributes?.glRenderer || '');
  const record = { label, at:new Date().toISOString(), host:{platform:process.platform,arch:process.arch,cpu:os.cpus()[0]?.model || null,cores:os.cpus().length,totalMemory:os.totalmem()}, browser:version, ...surface, gpu, softwareRenderer:renderer ? /swiftshader|llvmpipe|software/i.test(renderer) : null, display:{requested:process.env.DISPLAY || null,private:process.env.FLUX_PRIVATE_DISPLAY==='1'||!!process.env.FLUX_XVFB,requestedHeadful:process.env.FLUX_HEADFUL==='1',qualification:'Automated observation; does not certify a physical owner display'}, appBuild:appBuild || {sourceDigest:process.env.FLUX_VERIFY_SOURCE_DIGEST || null,commit:process.env.FLUX_VERIFY_COMMIT || null,servedModules:surface.modules} };
  await mkdir(directory,{recursive:true});
  const target=path.join(directory,'runtime-environment.json');
  let records=[];try {records=JSON.parse(await readFile(target,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
  records.push(record);await writeFile(target,JSON.stringify(records,null,2)+'\n');
  return record;
}
