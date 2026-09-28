'use strict';
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
async function inspectExports(report, output, scope, env, h) {
  const { createCanvas, loadImage } = require('@napi-rs/canvas');
  const svg = await fs.readFile(path.join(output, 'svg.svg'), 'utf8');
  const meshTag = svg.match(/<image\b[^>]*data-model3d-poster[^>]*>/)?.[0];
  if (!meshTag || report.metrics.saved.rotation !== 0) throw Error('Expected one unrotated fixture mesh viewport');
  const attr = name => meshTag.match(new RegExp(`\\b${name}="([^"]+)"`))?.[1];
  const viewport = Object.fromEntries(['x', 'y', 'width', 'height'].map(name=>[name,Number(attr(name))]));
  if (!Object.values(viewport).every(Number.isFinite) || viewport.width <= 0 || viewport.height <= 0) throw Error('Invalid mesh viewport');
  const countPixels = (rgba, width, height, channels=4, roi=viewport) => {
    const box = roi ? { x:Math.ceil(roi.x*width/600),y:Math.ceil(roi.y*height/450),right:Math.floor((roi.x+roi.width)*width/600),bottom:Math.floor((roi.y+roi.height)*height/450) } : {x:0,y:0,right:width,bottom:height};
    let colored=0;
    for(let y=box.y;y<box.bottom;y++)for(let x=box.x;x<box.right;x++){
      const i=(y*width+x)*channels;
      if ((channels===3||rgba[i+3]>80)&&Math.max(rgba[i],rgba[i+1],rgba[i+2])-Math.min(rgba[i],rgba[i+1],rgba[i+2])>25)colored++;
    }
    return {width,height,meshRoi:box,colored,coloredRatio:colored/((box.right-box.x)*(box.bottom-box.y))};
  };
  const pixels = async (file, roi=viewport) => {
    const image = await loadImage(Buffer.isBuffer(file)?file:await fs.readFile(file)), canvas = createCanvas(image.width, image.height), ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0);
    return countPixels(ctx.getImageData(0,0,image.width,image.height).data,image.width,image.height,4,roi);
  };
  const results = {viewport};
  for (const [label, dpi] of [['png300', 300], ['png600', 600]]) {
    const file = report.metrics.exports.find(item => item.label === label).file;
    const result = results[label] = await pixels(path.join(output, file));
    h.ok(result.width === Math.round(600 * dpi / 96) && result.height === Math.round(450 * dpi / 96), `${label}: final raster dimensions match physical figure size`);
    h.ok(result.coloredRatio > .001, `${label}: actual colored neuron pixels survive inside mesh-only export viewport`);
  }
  h.ok(svg.includes('data:image/png;') && svg.includes('<text') && svg.includes('Neuron-like mesh') && svg.includes('axon'), 'native SVG contains PNG mesh and genuine vector furniture text');
  results.svgMesh = await pixels(Buffer.from(attr('href').split(',')[1], 'base64'), null);
  h.ok(results.svgMesh.coloredRatio > .001, 'SVG embedded mesh PNG itself contains colored neuron pixels');
  const pdf = await fs.readFile(path.join(output, 'pdf.pdf'));
  const mediaBox = pdf.toString('latin1').match(/\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)/);
  h.ok(!!mediaBox && Math.abs(Number(mediaBox[1]) - 450) < .02 && Math.abs(Number(mediaBox[2]) - 337.5) < .02, 'native PDF MediaBox is 450 by 337.5 points (600 by 450 CSS pixels)');
  const textFile = path.join(output, 'pdf-text.txt');
  const extract = scope.spawn(path.join(output, 'pdf.pdf'), [textFile], { command: 'pdftotext', nodeArgs: [], env, deadlineMs: 15000 });
  await scope.waitExit(extract); if (extract.code !== 0) throw Error(`pdftotext: ${extract.stderr}`);
  const text = await fs.readFile(textFile, 'utf8');
  h.ok(text.includes('Neuron-like mesh') && text.includes('axon') && text.includes('dendrites'), 'native PDF preserves extractable vector labels');
  const raster = scope.spawn('-singlefile', ['-r', '96', '-png', path.join(output, 'pdf.pdf'), path.join(output, 'pdf-rendered')], { command: 'pdftoppm', nodeArgs: [], env, deadlineMs: 30000 });
  await scope.waitExit(raster); if (raster.code !== 0) throw Error(`pdftoppm: ${raster.stderr}`);
  results.pdf = await pixels(path.join(output, 'pdf-rendered.png'));
  h.ok(results.pdf.coloredRatio > .001, 'native PDF rasterization contains actual neuron pixels inside mesh-only viewport');
  const tiff = await fs.readFile(path.join(output, 'tiff600.tiff'));
  const little = tiff.subarray(0, 2).toString() === 'II', read16 = offset => little ? tiff.readUInt16LE(offset) : tiff.readUInt16BE(offset), read32 = offset => little ? tiff.readUInt32LE(offset) : tiff.readUInt32BE(offset);
  const tags = new Map(), ifd = read32(4);
  for (let i = 0; i < read16(ifd); i++) { const offset = ifd + 2 + i * 12; tags.set(read16(offset), { type: read16(offset + 2), count: read32(offset + 4), value: read32(offset + 8), at: offset + 8 }); }
  const number = tag => { const entry = tags.get(tag); return entry.type === 3 ? read16(entry.at) : entry.value; };
  const rational = tag => { const offset = tags.get(tag).value; return read32(offset) / read32(offset + 4); };
  results.tiff = { width: number(256), height: number(257), xDpi: rational(282), yDpi: rational(283), unit: number(296), bytes: tiff.length };
  h.ok(read16(2) === 42 && results.tiff.width === 3750 && results.tiff.height === 2813 && results.tiff.xDpi === 600 && results.tiff.yDpi === 600 && results.tiff.unit === 2, 'native TIFF is baseline TIFF at 600 dpi with expected dimensions');
  const samples=number(277),stripOffset=number(273),stripLength=number(279);
  h.ok(number(259)===1&&number(262)===2&&samples===3&&tags.get(273).count===1&&stripLength===results.tiff.width*results.tiff.height*samples&&stripOffset+stripLength<=tiff.length, 'TIFF stores a complete uncompressed RGB strip');
  results.tiff.pixels=countPixels(tiff.subarray(stripOffset,stripOffset+stripLength),results.tiff.width,results.tiff.height,samples);
  h.ok(results.tiff.pixels.coloredRatio>.001&&results.tiff.pixels.colored===results.png600.colored, 'TIFF mesh-only colored pixel coverage exactly matches PNG600');
  await fs.writeFile(path.join(output, 'export-inspection.json'), JSON.stringify(results, null, 2));
}
async function runModel3dNative({ scenarios = ['hardware', 'reopen', 'software', 'shape', 'disabled', 'disabled-cached'], artifactName = 'native', gateName = 'verify-model3d-electron' } = {}) {
  const { harness } = await import('./lib/harness.mjs');
  const { TestProcessScope } = await import('./lib/testProcess.mjs');
  const h = harness(gateName), scope = new TestProcessScope();
  const repo = path.resolve(__dirname, '..');
  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'flux-model3d-electron-')));
  const artifacts = path.join(repo, 'test-results/model3d', artifactName);
  const env = { ...process.env, HOME: path.join(scratch, 'home'), XDG_CONFIG_HOME: path.join(scratch, 'config'),
    XDG_CACHE_HOME: path.join(scratch, 'cache'), XDG_DATA_HOME: path.join(scratch, 'data'), APPDATA: path.join(scratch, 'appdata'),
    FLUX_NO_MIGRATE: '1', FLUX_PRIVATE_DISPLAY: '1', MODEL3D_NATIVE_SCRATCH: scratch };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'VITE_DEV_SERVER_URL', 'SOFTGPU', 'FLUX_MODEL3D_DISABLE', 'WAYLAND_DISPLAY']) delete env[key];
  if (process.platform === 'linux') env.DISPLAY = process.env.DISPLAY || ':0';
  try {
    await fs.mkdir(env.HOME, { recursive: true }); await fs.mkdir(artifacts, { recursive: true });
    for (const scenario of scenarios) {
      const root = path.join(scratch, scenario === 'reopen' ? 'hardware' : scenario);
      if (scenario === 'disabled-cached') await fs.cp(path.join(scratch, 'hardware'), root, { recursive: true });
      else if (scenario !== 'reopen') {
        const seed = scope.spawn(path.join(__dirname, 'lib/model3dNativeFixture.ts'), [root, scenario], { env, cwd: repo });
        await scope.waitExit(seed); if (seed.code !== 0) throw Error(seed.stdout + seed.stderr);
      }
      const output = path.join(artifacts, scenario); await fs.mkdir(output, { recursive: true });
      const childEnv = { ...env, MODEL3D_NATIVE_ROOT: root, MODEL3D_NATIVE_ARTIFACTS: output, MODEL3D_NATIVE_SCENARIO: scenario,
        ...(scenario === 'software' ? { SOFTGPU: '1' } : {}), ...(scenario.startsWith('disabled') ? { FLUX_MODEL3D_DISABLE: '1' } : {}) };
      const child = scope.spawn(path.join(__dirname, 'lib/model3dNativeEntry.cjs'), [root, ...(process.platform === 'linux' ? ['--ozone-platform=x11'] : [])], {
        command: require('electron'), nodeArgs: [], env: childEnv, cwd: repo, deadlineMs: 180000,
      });
      await scope.waitExit(child); await fs.writeFile(path.join(output, 'native.log'), child.stdout + child.stderr);
      if (child.code !== 0 || !child.stdout.includes('PROBE result=PASS')) throw Error(`${scenario}: ${(child.stdout + child.stderr).slice(-16000)}`);
      const report = JSON.parse(await fs.readFile(path.join(output, 'receipt.json'), 'utf8'));
      for (const check of report.checks) h.ok(check.ok, `${scenario}: ${check.label}`);
      if (scenario === 'hardware') await inspectExports(report, output, scope, env, h);
      if (scenario === 'reopen' || scenario === 'disabled-cached') {
        const before = JSON.parse(await fs.readFile(path.join(artifacts, 'hardware/receipt.json'), 'utf8'));
        h.eq(report.metrics.saved, before.metrics.saved ?? before.metrics.imported, `${scenario}: native saved placement and view survive process reload`);
      }
    }
  } catch (error) { h.fail(String(error.stack || error)); }
  finally { await scope.dispose(); await fs.rm(scratch, { recursive: true, force: true, maxRetries: 5 }); }
  await h.done();
}
module.exports = { runModel3dNative };
if (require.main === module) void runModel3dNative();
