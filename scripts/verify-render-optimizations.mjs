// Pixel and lifecycle contracts for renderer-only optimizations. The reference
// is the same artwork without the optimization, not a second implementation.
import fs from 'node:fs/promises';
import { launch, gotoApp, clickMode, waitFor, realErrors, APP_URL, sleep } from './lib/driver.mjs';
import { harness } from './lib/harness.mjs';
const h = harness('verify-render-optimizations');
const out = process.env.FLUX_OUT || 'test-results/responsiveness-audit';
await fs.mkdir(out, { recursive: true });
const { browser, page } = await launch();
try {
  await gotoApp(page, { url: APP_URL + '?fixture=demo', settle: 600 });
  await waitFor(page, () => !!window.__fluxSeedFigures, null, { timeout: 15000, label: 'paper figure source' });
  h.section('plot cache pixels match the pristine pipeline');
  const cases = await page.evaluate(async () => {
    const P = await import('/src/lib/plot/parse.ts');
    const wrap = body => `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="80" viewBox="0 0 160 80">${body}</svg>`;
    const body = '<path id="a" class="paint strong" d="M10 10h60v50h-60z"/><path id="b" class="paint" d="M85 10h60v50h-60z"/>';
    const clip = units => `<defs><clipPath id="c" clipPathUnits="${units}"><rect width="${units === 'objectBoundingBox' ? '.5' : '55'}" height="${units === 'objectBoundingBox' ? '1' : '80'}"/></clipPath></defs><path id="a" fill="red" d="M0 10h60v30h-60z" clip-path="url(#c)"/><path id="b" fill="blue" d="M80 10h60v30h-60z" clip-path="url(#c)"/>`;
    const fixtures = [
      ['overlapping curved clip', '<defs><clipPath id="c"><circle cx="75" cy="35" r="28.4"/></clipPath></defs><path d="M0 0H160V80H0z" fill="red" clip-path="url(#c)"/><path d="M0 0H160V80H0z" fill="blue" clip-path="url(#c)"/>'],
      ['overlapping fractional rect clip', '<defs><clipPath id="c"><rect x="25.3" y="12.3" width="60.3" height="48.3"/></clipPath></defs><path d="M0 0H160V80H0z" fill="red" clip-path="url(#c)"/><path d="M0 0H160V80H0z" fill="blue" clip-path="url(#c)"/>'],
      ['multiple sheets', '<style>.paint.strong{fill:red}</style><style>.paint{fill:blue}</style>' + body],
      ['conditional cascade', '<style>.paint.strong{fill:red}.paint:not(.absent){fill:blue}.paint.strong{fill:green}</style>' + body],
      ['attribute selector', '<style>path{fill:red}[fill="red"]{fill:blue}</style>' + body],
      ['uniform defaults', '<style>*{stroke-linecap:round;stroke-linejoin:bevel}</style><path d="M20 30H100" stroke="red" stroke-width="12"/>'],
      ['conditional stylesheet', '<style media="print">*{stroke-linecap:round}</style><path d="M20 30H100" stroke="red" stroke-width="12"/>'],
      ['invalid inline declaration', '<style>*{stroke-linecap:round}</style><path style="stroke-linecap:invalid" stroke-linecap="butt" d="M20 30H100" stroke="red" stroke-width="12"/>'],
      ['bounding-box clips', clip('objectBoundingBox')],
      ['user-space clips', clip('userSpaceOnUse')],
      ['moving clipped part', clip('userSpaceOnUse'), { a: { dx: 30 } }],
      ['CSS tree selectors', '<style>svg > path{fill:red}</style>' + clip('userSpaceOnUse')],
    ];
    const pixels = async root => {
      const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(root)], { type: 'image/svg+xml' }));
      try {
        const img = new Image(); img.src = url; await img.decode();
        const c = document.createElement('canvas'); c.width = 160; c.height = 80;
        const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0);
        return ctx.getImageData(0, 0, 160, 80).data;
      } finally { URL.revokeObjectURL(url); }
    };
    const result = [];
    for (const [name, body, overrides] of fixtures) {
      const pristine = P.preparePlot(wrap(body)).root;
      const optimized = pristine.cloneNode(true);
      P.bakePlotStyles(optimized); P.hoistPlotClips(optimized);
      for (const root of [pristine, optimized]) { P.prefixIds(root, 'plot'); P.applyOverrides(root, overrides, 'plot'); }
      const a = await pixels(pristine), b = await pixels(optimized);
      let changed = 0;
      for (let i = 0; i < a.length; i += 4) if ([0, 1, 2, 3].some(c => a[i + c] !== b[i + c])) changed++;
      result.push({ name, changed });
    }
    return result;
  });
  for (const c of cases) h.eq(c.changed, 0, `${c.name}: exact painted parity`);

  h.section('snapshot fidelity at the capture scale');
  await page.evaluate(async () => {
    await document.fonts.load('26px Gelasio');
    const host = document.createElement('div'); host.id = 'audit-art';
    host.style.cssText = 'position:fixed;left:32px;top:32px;width:400px;height:240px;background:white;z-index:100000';
    host.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" style="width:400px;height:240px;font-family:Gelasio;font-size:26px;color:#102030"><g transform="scale(1)">
      <style>.grid{fill:none;stroke:#995511;stroke-width:2}.editing-hidden{opacity:0}</style>
      <defs><linearGradient id="audit-gradient"><stop stop-color="#3080d0"/><stop offset="1" stop-color="#df9050"/></linearGradient><clipPath id="audit-clip"><rect x="210" y="95" width="140" height="65"/></clipPath></defs>
      <rect class="figure-bg" x="2" y="2" width="396" height="236" fill="#fff" stroke="#123456" stroke-width="1" vector-effect="non-scaling-stroke"/>
      <path class="grid" d="M20 85H380M20 115H380M20 145H380M20 175H380M50 70V200M110 70V200"/>
      <text x="20" y="45">Gelasio: wide &amp; thin</text>
      <g clip-path="url(#audit-clip)"><rect x="190" y="75" width="190" height="110" fill="url(#audit-gradient)" transform="rotate(12 280 120)"/></g>
      <g class="editing-hidden"><rect width="400" height="240" fill="red"/></g>
    </g></svg>`;
    document.body.appendChild(host);
    const Z = await import('/src/lib/interact/zoomProxy.ts');
    const scene = host.querySelector('svg');
    // The grid style is a document stylesheet, just like Canvas.svelte's CSS.
    const style = scene.querySelector('style'); document.head.appendChild(style);
    const snap = Z.serializeSceneSnapshot(scene, { bx: 0, by: 0, bw: 400, bh: 240 }, 1);
    const fonts = await Z.snapshotFontCss(snap.svg);
    const source = snap.svg.replace('>', `><style>${fonts}</style>`);
    const img = new Image(); img.id = 'audit-snapshot';
    img.src = URL.createObjectURL(new Blob([source], { type: 'image/svg+xml' }));
    await img.decode();
    img.style.cssText = 'position:absolute;inset:0;width:400px;height:240px;opacity:0';
    host.appendChild(img);
    window.__auditCleanup = () => { URL.revokeObjectURL(img.src); host.remove(); style.remove(); };
  });
  const clip = { x: 32, y: 32, width: 400, height: 240 };
  const live = await page.screenshot({ clip, encoding: 'base64' });
  await fs.writeFile(`${out}/snapshot-live.png`, Buffer.from(live, 'base64'));
  await page.evaluate(() => { document.querySelector('#audit-art svg').style.opacity = '0'; document.querySelector('#audit-snapshot').style.opacity = '1'; });
  const proxy = await page.screenshot({ clip, encoding: 'base64' });
  await fs.writeFile(`${out}/snapshot-proxy.png`, Buffer.from(proxy, 'base64'));
  const diff = await page.evaluate(async ({ live, proxy }) => {
    const read = async data => {
      const img = new Image(); img.src = 'data:image/png;base64,' + data; await img.decode();
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
      const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0); return ctx.getImageData(0, 0, c.width, c.height).data;
    };
    const a = await read(live), b = await read(proxy); let changed = 0, sum = 0;
    for (let i = 0; i < a.length; i += 4) { let d = 0; for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs(a[i + c] - b[i + c])); if (d > 24) changed++; sum += d; }
    return { changed, mean: sum / (a.length / 4) };
  }, { live, proxy });
  // Native SVG and an SVG image may differ at antialiased glyph edges; a lost
  // font, grid, fill, clip or hidden-state changes thousands of interior pixels.
  h.ok(diff.changed < 480 && diff.mean < 1, `snapshot matches live styles/fonts/geometry (${JSON.stringify(diff)})`);
  await page.evaluate(() => window.__auditCleanup());
  const math = await page.evaluate(async () => {
    const Z = await import('/src/lib/interact/zoomProxy.ts');
    const box = { bx: 2.125, by: -4.25, bw: 1834.7, bh: 987.9 };
    const S = Z.snapshotScale(box, 3, 2), w = Math.max(1, Math.floor(box.bw * S)), h = Math.max(1, Math.floor(box.bh * S));
    const m = new DOMMatrix(Z.proxyTransform({ ...box, S, w, h }, 27, 41, 1.37));
    const far = m.transformPoint(new DOMPoint(w, h));
    return { area: w * h * 4, side: Math.max(w, h) * 2, dx: Math.abs(far.x - (27 + 1.37 * (box.bx + box.bw))), dy: Math.abs(far.y - (41 + 1.37 * (box.by + box.bh))) };
  });
  h.ok(math.area <= 3_000_000 && math.side <= 4096, `DPR=2 respects the physical bitmap budget (${math.area} pixels)`);
  h.ok(math.dx < .001 && math.dy < .001, `rounded raster dimensions map exactly to world geometry (${math.dx}, ${math.dy})`);

  h.section('Paper image revisions, viewport demand and failure cleanup');
  // Initial project source loads must complete before synthetic revisions are
  // seeded; the editor itself intentionally mounts sooner for responsiveness.
  await clickMode(page, 'Paper');
  await page.waitForSelector('.paper[data-paper-sources-ready="true"]');
  await page.evaluate(async () => {
    const F = await import('/src/shell/modes/paper/scholar/figures.ts');
    const ref = { id: 'audit-image', label: 'fig-audit', name: 'Audit', family: 'figure', number: 1, display: 'Fig. 1', captionLabel: '', order: 1, canvas: 'c', caption: '', panels: [] };
    const fig = color => ({ id: ref.id, name: 'Audit', canvasId: 'c', x: 0, y: 0, width: 200, height: 120, background: '#fff', elements: [{ type: 'rect', id: 'r', x: 0, y: 0, width: 200, height: 120, fill: color, stroke: 'none', strokeWidth: 0, rotation: 0, cornerRadius: 0 }] });
    const host = document.createElement('div'); host.id = 'audit-paper'; host.style.cssText = 'position:fixed;left:20px;top:20px;width:220px;height:140px;z-index:100000';
    const img = new Image(); host.append(img); document.body.append(host);
    const seed = color => F.__seedFigures([ref], { [ref.id]: fig(color) });
    seed('#ff0000');
    const cancel = F.bindFigureImage(img, ref.id);
    window.__paperAudit = { F, host, img, seed, cancel, ref, fig };
  });
  await waitFor(page, () => window.__paperAudit.img.naturalWidth > 0 && window.__paperAudit.img.complete, null, { label: 'first image' });
  const old = await page.evaluate(() => window.__paperAudit.img.src);
  await page.evaluate(() => window.__paperAudit.seed('#0000ff'));
  await waitFor(page, old => window.__paperAudit.img.src !== old && window.__paperAudit.img.complete, old, { label: 'same-id revision refresh' }).catch(e => h.fail(e.message));
  const color = await page.evaluate(() => { const { img } = window.__paperAudit; const c = document.createElement('canvas'); c.width = 200; c.height = 120; const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0); return [...ctx.getImageData(100, 60, 1, 1).data]; });
  h.eq(color, [0, 0, 255, 255], 'an existing binding paints the latest revision without changing figure id');
  await page.evaluate(() => { const A = window.__paperAudit; A.last = A.img.src; A.host.className = 'mc hidden'; A.host.style.visibility = 'hidden'; A.seed('#00ff00'); });
  await sleep(350); // beyond the render queue deadline: hidden work must remain deferred
  h.ok(await page.evaluate(() => window.__paperAudit.img.src === window.__paperAudit.last), 'hidden Paper retains its prior image without rendering');
  await page.evaluate(() => { const A = window.__paperAudit; A.host.className = ''; A.host.style.visibility = ''; window.dispatchEvent(new Event('flux:pane-shown')); });
  await waitFor(page, () => window.__paperAudit.img.src !== window.__paperAudit.last && window.__paperAudit.img.complete, null, { label: 'hidden pane refresh' }).catch(e => h.fail(e.message));
  h.ok(await page.evaluate(() => window.__paperAudit.img.src !== window.__paperAudit.last), 'revealing a pane completes its deferred update');
  await page.evaluate(() => { const A = window.__paperAudit; A.host.style.top = '10000px'; A.last = A.img.src; });
  await sleep(100); // deliver the IntersectionObserver exit
  await page.evaluate(() => window.__paperAudit.seed('#ff00ff'));
  await sleep(350); // no offscreen render even at the queue deadline
  h.ok(await page.evaluate(() => window.__paperAudit.img.src === window.__paperAudit.last), 'offscreen thumbnails do not render unseen revisions');
  await page.evaluate(() => { const A = window.__paperAudit; A.host.style.top = '20px'; A.F.__seedFigures([], {}); });
  await waitFor(page, () => !window.__paperAudit.img.hasAttribute('src'), null, { label: 'deleted image cleared' }).catch(e => h.fail(e.message));
  h.ok(await page.evaluate(() => !window.__paperAudit.img.hasAttribute('src')), 'a removed figure never leaves another revision on screen');
  await page.evaluate(() => { window.__paperAudit.cancel(); window.__paperAudit.host.remove(); });

  h.section('dense Paper preparation yields to input without changing art');
  const sliced = await page.evaluate(async () => {
    const F = await import('/src/shell/modes/paper/scholar/figures.ts');
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">' +
      Array.from({length:1000}, (_, i) => `<path id="p${i}" d="M${i%100} ${Math.floor(i/100)*8}h1v1z" fill="#123456"/>`).join('') + '</svg>';
    const fig = {id:'audit-dense',name:'Dense audit',canvasId:'c',x:0,y:0,width:600,height:400,background:'#fff',elements:Array.from({length:24}, (_,i) =>
      ({id:`placed-${i}`,type:'plot',assetId:'dense-source',x:i%6*100,y:Math.floor(i/6)*100,width:100,height:100}))};
    const data = {'dense-source':'data:image/svg+xml;base64,' + btoa(svg)};
    F.__seedFigures([], {[fig.id]:fig}, data);
    const expected = F.renderFigureSvg(fig.id);
    F.__seedFigures([], {[fig.id]:fig}, data);
    let inputTurns = 0, turnsBeforeImage = -1, imageBlob;
    const timer = setInterval(() => inputTurns++, 0);
    const create = URL.createObjectURL;
    URL.createObjectURL = function(blob) {
      if (blob.type === 'image/svg+xml') { turnsBeforeImage = inputTurns; imageBlob = blob; }
      return create.call(URL, blob);
    };
    let url;
    try { url = await F.renderFigureImageUrl(fig.id); }
    finally { clearInterval(timer); URL.createObjectURL = create; }
    const actual = url ? await imageBlob?.text() : null;
    // A replacement arriving during preparation must prevent publication of
    // the old figure, not combine plots from different source revisions.
    F.__seedFigures([], {[fig.id]:fig}, data);
    const obsolete = F.renderFigureImageUrl(fig.id);
    setTimeout(() => F.__seedFigures([], {}), 0);
    return {turnsBeforeImage, parity:actual === expected, obsolete:await obsolete};
  });
  h.ok(sliced.turnsBeforeImage > 0, `input turns run before dense SVG image creation (${sliced.turnsBeforeImage})`);
  h.ok(sliced.parity, 'sliced preview SVG is byte-identical to the synchronous shared renderer');
  h.eq(sliced.obsolete, undefined, 'a source replacement cancels an unfinished dense preview');
  h.eq(realErrors(page).length, 0, `console clean: ${realErrors(page).join('; ')}`);
} finally { await browser.close(); }
await h.done();
