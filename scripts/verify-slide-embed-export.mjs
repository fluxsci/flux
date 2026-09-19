import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { unzipSync, strFromU8 } from 'fflate';
import { launch, shot, realErrors } from './lib/driver.mjs';
import { harness } from './lib/harness.mjs';
const h=harness('verify-slide-embed-export');
const scratch=await fs.mkdtemp(path.join(os.tmpdir(),'flux-slide-export-'));
const root=path.resolve('test-results/inline-slide-export');
const config=path.join(scratch,'FluxConfig');
await fs.mkdir(path.join(config,'FluxLib'),{recursive:true});await fs.mkdir(path.join(scratch,'xdg','flux'),{recursive:true});
await fs.writeFile(path.join(scratch,'xdg','flux','preferences.json'),JSON.stringify({fluxConfigPath:config}));
const env={...process.env,XDG_CONFIG_HOME:path.join(scratch,'xdg'),XDG_CACHE_HOME:path.join(scratch,'cache'),FLUX_NO_MIGRATE:'1'};
const run=args=>spawnSync(process.execPath,args,{env,encoding:'utf8',timeout:60000});
// This gate renders through REAL Quarto (html/docx/pdf). Like verify-export-qmd
// and verify-project-lint, it skips cleanly when quarto is not installed rather
// than reporting the missing tool as a product failure — CI's headless `test`
// job deliberately ships no quarto. Where quarto IS present (the owner's
// machine, any box that installs it) the gate keeps every one of its teeth.
const quarto = spawnSync('quarto', ['--version'], { stdio: 'ignore', shell: process.platform === 'win32' });
if (quarto.status !== 0) {
  console.log('  (skip) quarto not on PATH — the inline-slide export gate needs a real quarto render');
  console.log(`##VERIFY## ${JSON.stringify({ script: 'verify-slide-embed-export', ok: true, skipped: true, checks: 0, failed: 0, ms: 0 })}`);
  console.log('verify-slide-embed-export: SKIPPED (quarto not installed)');
  await fs.rm(scratch, { recursive: true, force: true });
  process.exit(0);
}

let browser;
try {
  await fs.rm(root,{recursive:true,force:true});
  let r=run(['--import','tsx','scripts/lib/slideEmbedFixture.ts',root]);
  if(r.status!==0)throw Error(r.stdout+'\n'+r.stderr);
  const rel='paper/nested/report.qmd', before=await fs.readFile(path.join(root,rel),'utf8'), incBefore=await fs.readFile(path.join(root,'paper/nested/detail.qmd'),'utf8');
  for(const format of ['html','docx','pdf']) {
    r=run(['dist/flux-cli.mjs','compile','--root',root,'--doc',rel,'--to',format]);
    h.ok(r.status===0,`built CLI compiles selected nested document to ${format}`);
    if(r.status!==0)throw Error(r.stdout+'\n'+r.stderr);
    h.ok(await fs.readFile(path.join(root,rel),'utf8')===before&&await fs.readFile(path.join(root,'paper/nested/detail.qmd'),'utf8')===incBefore,`${format} restores entry and include source bytes`);
  }
  const html=await fs.readFile(path.join(root,'paper/nested/report.html'),'utf8');
  h.ok((html.match(/id="flux-slide-data"/g)||[]).length===1&&!html.includes('PRIVATE speaker')&&!html.includes('/home/private'),'HTML has one runtime bundle, no speaker notes or private source paths');
  h.ok(!/<(?:script|link)[^>]+(?:src|href)="(?:https?:|[^"#]*site_libs)/.test(html),'HTML embeds local support and needs no remote runtime');
  const zip=unzipSync(await fs.readFile(path.join(root,'paper/nested/report.docx')));
  const media=Object.keys(zip).filter(p=>p.startsWith('word/media/'));
  h.ok(media.some(p=>p.endsWith('.svg'))&&media.some(p=>p.endsWith('.png')),'Word has SVG posters and raster fallbacks');
  h.ok(strFromU8(zip['word/document.xml']).includes('<w:drawing>'),'Word actually references rendered slide images');
  const {page,browser:b}=await launch();browser=b;
  const requests=[];page.on('requestfailed',r=>requests.push(r.url()));
  await page.setOfflineMode(true);
  await page.goto(`file://${path.join(root,'paper/nested/report.html')}`,{waitUntil:'load'});
  await page.waitForSelector('.flux-slide-art');
  const decode = b64 => page.evaluate(async data => {const img=new Image();img.src='data:image/png;base64,'+data;await img.decode();const c=document.createElement('canvas');c.width=c.height=1;const ctx=c.getContext('2d');ctx.drawImage(img,0,0);return [...ctx.getImageData(0,0,1,1).data.slice(0,3)];},b64);
  const pixel=async(x,y)=>{
    const box=await page.$eval('.flux-slide-art',el=>{const r=el.getBoundingClientRect();return{x:r.x,y:r.y,w:r.width};});
    return decode(await page.screenshot({encoding:"base64",clip:{x:box.x+x*box.w/640,y:box.y+y*box.w/640,width:1,height:1}}));
  };
  h.eq(await pixel(110,200),[255,255,255],'offline HTML initial primitive is hidden at step 0');
  h.eq(await pixel(442,165),[255,255,255],'offline HTML initial plot part is hidden at step 0');
  await page.click('[aria-label="Next animation step"]');await page.waitForFunction(()=>document.querySelector('.flux-slide-bar')?.textContent.includes('Step 1 / 2'));
  h.eq(await pixel(110,200),[67,133,190],'offline HTML step 1 paints the first reveal');
  await page.click('[aria-label="Next animation step"]');await page.waitForFunction(()=>document.querySelector('.flux-slide-bar')?.textContent.includes('Step 2 / 2'));
  h.eq(await pixel(442,165),[67,133,190],'offline HTML final step paints the semantic plot part');
  await shot(page,'inline-slide-offline-html');
  await page.goto('about:blank');await page.goBack({waitUntil:'load'});await page.waitForSelector('.flux-slide-art');
  h.ok(true,'offline player restores after browser Back navigation');
  // Compare player endpoints with SVG posters in the same browser rasterizer.
  await page.evaluate(()=>{const e=document.querySelector('.flux-slide-embed');e.classList.remove('flux-slide-enhanced');e.querySelector('.flux-slide-live').remove();});
  await page.waitForFunction(()=>document.querySelector('.flux-slide-poster').complete);
  const posterBox=await page.$eval('.flux-slide-poster',el=>{const r=el.getBoundingClientRect();return{x:r.x,y:r.y,w:r.width};});
  const pixel0=await decode(await page.screenshot({encoding:"base64",clip:{x:posterBox.x+442*posterBox.w/640,y:posterBox.y+165*posterBox.w/640,width:1,height:1}}));
  h.eq(pixel0,[255,255,255],'export fallback poster matches the initial hidden plot state');
  h.eq(requests,[],'offline HTML makes no failed asset requests');h.eq(realErrors(page),[],'offline export has no renderer errors');
  await page.goto(`file://${path.join(root,'exports/slide-static.html')}`,{waitUntil:'load'});await page.setJavaScriptEnabled(false);
  await page.reload({waitUntil:'load'});h.ok(await page.$('.flux-slide-poster'),'static export paints with JavaScript disabled');
  await shot(page,'inline-slide-static-poster');
  const pdf=await fs.readFile(path.join(root,'paper/nested/report.pdf'));h.ok(pdf.length>5000&&pdf.subarray(0,4).toString()==='%PDF','PDF output contains actual rendered content');
} catch(error){h.fail(String(error));console.error(error);}
await h.done(async()=>{await browser?.close();await fs.rm(scratch,{recursive:true,force:true});});
