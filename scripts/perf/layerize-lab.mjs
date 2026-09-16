// Micro-bench: does a per-frame transform write on a will-change:transform wrapper holding a
// huge SVG take Chromium's direct-compositor-update path (0 Layerize/frame) or fall back to a
// full PaintArtifactCompositor::Update per frame? Variants bisect the structure.
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
const CHROME = process.env.FLUX_CHROME || '/usr/bin/google-chrome';
const svg = fs.readFileSync('/home/driessen2/fluxsci.github.io/examples/neural-populations/fig/assets/asset_mu1xueajexpl.svg', 'utf8').replace(/<\?xml[^>]*>|<!DOCTYPE[^>]*>/g, '');
const svgs = Array.from({ length: 3 }, (_, i) => svg.replace(/id="/g, `id="p${i}_`).replace(/url\(#/g, `url(#p${i}_`).replace(/href="#/g, `href="#p${i}_`)).join('');
const variants = {
  base: { attr: 'style', scale: true, clip: false, svg: true, wc: true, t3d: true },
  styleProp: { attr: 'prop' },        // el.style.transform = … instead of setAttribute('style')
  noScale: { scale: false },          // no trailing scale(1)
  clip: { clip: true },               // clip-path on a wrapper
  noWc: { wc: false },                // no will-change
  html: { svg: false },               // 12k divs instead of svg
  translate2d: { t3d: false },        // translate() instead of translate3d()
  svgLayer: { svgwc: true },          // will-change also on the svg root
  outerSvgTransform: { outerSvg: true }, // move the transform onto <svg> itself
  waapi: { mode: 'waapi' },          // pan = paused Web Animation, currentTime driven (compositor owns the value)
  scrollTop: { mode: 'scroll' },     // pan = native scroll offset on an overflow:scroll host
  waapiTranslate: { mode: 'waapiT' }, // paused animation on the individual `translate` property
  waapiKeyframes: { mode: 'waapiK' },
  waapiKeyframesStyle: { mode: 'waapiK', alsoStyle: true },
  hoistClip: { hoist: true },       // consecutive siblings sharing a clip-path are wrapped in ONE clipped <g> (fewer clip nodes → fewer paint chunks)
  stripClip: { strip: true },       // diagnostic ceiling: remove every clip-path // keyframes per frame AND the base inline style kept current // ONE paused animation, keyframes replaced per frame (any 2-D pan + scale in one element)
};
const variant = process.argv[2] || 'base';
const cfg = { ...variants.base, ...(variants[variant] || {}) };
const html = `<!doctype html><html><body style="margin:0;overflow:hidden;background:#fff">
<div id="host" style="position:relative;width:1400px;height:900px;overflow:${cfg.mode === 'scroll' ? 'scroll' : 'hidden'}">
<div id="clip" style="${cfg.clip ? 'clip-path:inset(0 0 0 0);' : ''}">
<div id="scene" style="${cfg.wc ? 'will-change:transform;' : ''}transform:translate3d(0px,0px,0)${cfg.scale ? ' scale(1)' : ''}">
${cfg.svg ? `<svg style="${cfg.svgwc ? 'will-change:transform' : ''}" width="2800" height="1800" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><g transform="scale(0.6)">${svgs}</g></svg>` : `<div>${'<div style="width:6px;height:6px;display:inline-block;background:#48c;margin:1px"></div>'.repeat(12000)}</div>`}
</div></div></div></body></html>`;
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--window-size=1500,1000'] });
const page = await browser.newPage();
await page.setViewport({ width: 1500, height: 1000 });
await page.setContent(html);
await page.evaluate((cfg) => {
  if (cfg.strip) for (const el of document.querySelectorAll('#scene [clip-path]')) el.removeAttribute('clip-path');
  if (cfg.hoist) {
    let hoisted = 0;
    for (const parent of [...document.querySelectorAll('#scene g, #scene svg')]) {
      const kids = [...parent.children];
      let i = 0;
      while (i < kids.length) {
        const cp = kids[i].getAttribute('clip-path');
        if (!cp) { i++; continue; }
        let j = i + 1;
        while (j < kids.length && kids[j].getAttribute('clip-path') === cp) j++;
        if (j - i >= 2) {
          const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
          g.setAttribute('clip-path', cp);
          parent.insertBefore(g, kids[i]);
          for (let k = i; k < j; k++) { kids[k].removeAttribute('clip-path'); g.appendChild(kids[k]); }
          hoisted += j - i;
        }
        i = j;
      }
    }
    window.__hoisted = hoisted;
  }
}, cfg);
await new Promise((r) => setTimeout(r, 1200));
const nodes = await page.evaluate(() => document.querySelectorAll('#scene *').length + ' hoisted=' + (window.__hoisted ?? 0) + ' clipAttrs=' + document.querySelectorAll('#scene [clip-path]').length);
await page.tracing.start({ categories: ['disabled-by-default-devtools.timeline', 'devtools.timeline', 'blink'] });
await page.evaluate((cfg) => new Promise((done) => {
  const el = document.getElementById('scene');
  const target = cfg.outerSvg ? el.querySelector('svg') : el;
  let i = 0;
  let anim = null;
  if (cfg.mode === 'waapi') { anim = el.animate([{ transform: 'translate3d(0px,-1000px,0)' }, { transform: 'translate3d(0px,1000px,0)' }], { duration: 2000, fill: 'both' }); anim.pause(); anim.currentTime = 1000; }
  if (cfg.mode === 'waapiK') { anim = el.animate([{ transform: 'translate3d(0px,0px,0) scale(1)' }, { transform: 'translate3d(0px,0px,0) scale(1)' }], { duration: 1000, fill: 'both' }); anim.pause(); anim.currentTime = 0; }
  if (cfg.mode === 'waapiT') { el.style.transform = ''; anim = el.animate([{ translate: '0px -1000px' }, { translate: '0px 1000px' }], { duration: 2000, fill: 'both' }); anim.pause(); anim.currentTime = 1000; }
  const host = document.getElementById('host');
  if (cfg.mode === 'scroll') { el.style.transform = ''; el.style.willChange = ''; el.style.height = '3000px'; host.scrollTop = 500; }
  const step = () => {
    i++;
    const y = Math.round(Math.sin(i / 10) * 200);
    if (cfg.mode === 'waapiK') { const t = `translate3d(${Math.round(Math.cos(i / 7) * 150)}px,${y}px,0) scale(${(1 + Math.sin(i / 15) * 0.2).toFixed(4)})`; anim.effect.setKeyframes([{ transform: t }, { transform: t }]); if (cfg.alsoStyle) el.style.transform = t; if (i < 60) requestAnimationFrame(step); else done(); return; }
    if (cfg.mode === 'waapi' || cfg.mode === 'waapiT') { anim.currentTime = 1000 + y; if (i < 60) requestAnimationFrame(step); else done(); return; }
    if (cfg.mode === 'scroll') { host.scrollTop = 500 + y; if (i < 60) requestAnimationFrame(step); else done(); return; }
    const t = `${cfg.t3d ? `translate3d(0px,${y}px,0)` : `translate(0px,${y}px)`}${cfg.scale ? ' scale(1)' : ''}`;
    if (cfg.attr === 'prop') target.style.transform = t;
    else target.setAttribute('style', `${cfg.wc ? 'will-change:transform;' : ''}${cfg.svgwc && cfg.outerSvg ? 'will-change:transform;' : ''}transform:${t}`);
    if (i < 60) requestAnimationFrame(step); else done();
  };
  requestAnimationFrame(step);
}), cfg);
const buf = await page.tracing.stop();
await browser.close();
const ev = JSON.parse(new TextDecoder().decode(buf)).traceEvents;
let pac = 0, n = 0, paint = 0, pre = 0, upd = 0;
for (const e of ev) { if (e.ph !== 'X') continue; if (e.name === 'PaintArtifactCompositor::Update') { pac += e.dur; n++; } else if (e.name === 'Paint') paint += e.dur; else if (e.name === 'PrePaint') pre += e.dur; else if (e.name === 'UpdateLayerTree' || e.name === 'Blink.CompositingCommit.UpdateTime') upd += e.dur; }
console.log(`${variant.padEnd(18)} nodes=${nodes} frames=60 PAC.Update=${n}× ${(pac / 1000).toFixed(1)}ms (${n ? (pac / n / 1000).toFixed(2) : 0}/call) Paint=${(paint / 1000).toFixed(1)}ms PrePaint=${(pre / 1000).toFixed(1)}ms`);
