// In-memory, bounded scene rasters. Called ONLY in the supervised child. No
// authored SVG resource may cause a file/network read; font files come solely
// from the shared trusted resolver and our bundled faces.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolveFontFile } from '../src/lib/text/fontFiles.mjs';
import { svgFontRequests } from './plotThumbEngine.mjs';
import { sceneStrokePlans } from './sceneRasterStrokes.mjs';
const require = createRequire(import.meta.url);
const { DOMParser, XMLSerializer } = require('@xmldom/xmldom');
const { renderAsync } = require('@resvg/resvg-js');
const { validateSceneRequest } = require('./sceneRasterRules.cjs');
const fontMemo = new Map();
const bundledFonts = ['Gelasio-Regular.ttf', 'Gelasio-SemiBold.ttf', 'Gelasio-Bold.ttf', 'Gelasio-Italic.ttf'].map(name => fileURLToPath(new URL(`../resources/fonts/${name}`, import.meta.url)));
const localReference = value => /^#[^\s]+$/.test(value);
function safeCss(value) {
  // Escapes/comments could disguise an external url/import. Generated scene
  // styles need neither; unsupported sheets keep the live renderer.
  if (/\\|\/\*|@import/i.test(value)) throw Error('Unsupported scene resource syntax');
  for (const match of value.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)) {
    const ref = match[2].trim();
    if (!localReference(ref) && !/^data:(?:font\/(?:woff2?|ttf|otf)|application\/(?:font-woff|x-font-ttf));base64,[a-z0-9+/=\s]+$/i.test(ref)) throw Error('External scene resources are unsupported');
  }
}
function sceneDocument(svg) {
  if (/<!DOCTYPE|<!ENTITY|<\?xml-stylesheet/i.test(svg)) throw Error('External scene resources are unsupported');
  const errors = [];
  const doc = new DOMParser({ errorHandler: { warning: () => {}, error: e => errors.push(e), fatalError: e => errors.push(e) } }).parseFromString(svg, 'image/svg+xml');
  const root = doc.documentElement;
  if (errors.length || root?.localName !== 'svg' || root.namespaceURI !== 'http://www.w3.org/2000/svg') throw Error('Invalid scene SVG');
  let nodes = 0;
  const elements = [root, ...Array.from(root.getElementsByTagName('*'))];
  const allTextFontsBaked = elements.filter(n => ['text', 'tspan', 'textPath'].includes(n.localName)).every(node => ['font-family', 'font-weight', 'font-style'].every(name => node.hasAttribute(name) || new RegExp(`(?:^|;)\\s*${name}\\s*:`).test(node.getAttribute('style') ?? '')));
  const bundledFamily = /Gelasio/.test(svg);
  const fonts = new WeakMap();
  for (const node of elements) {
    if (++nodes > 200_000) throw Error('Scene exceeds the raster node budget');
    if (['script', 'foreignObject', 'iframe'].includes(node.localName)) throw Error('Unsupported scene content');
    if (node.localName === 'style') {
      const css = node.textContent ?? ''; safeCss(css);
      // Arbitrary selectors can combine a bundled-family declaration with an
      // inherited italic/weight. Do not guess the cascade for these unsupported
      // sheets. resvg uses trusted font files rather than CSS font data, so
      // only the application's bundled family can retain its exact face.
      const rules = css.replace(/@font-face\s*\{([^}]*)\}/gi, (_rule, declarations) => {
        if (!/(?:^|;)\s*font-family\s*:\s*(?:"Gelasio"|'Gelasio'|Gelasio)\s*(?:;|$)/i.test(declarations)) throw Error('Embedded scene font requires the live renderer');
        return '';
      });
      if (/@font-face\b/i.test(rules)) throw Error('Unsupported scene font declaration');
      // resvg ignores vector-effect, and the compatibility pass deliberately
      // reads only known attributes/inline paint. Do not silently miss a
      // stylesheet-selected non-scaling stroke.
      for (const match of rules.matchAll(/(?:^|[;{])\s*vector-effect\s*:\s*([^;}]+)/gi))
        if (match[1].trim().replace(/\s*!important\s*$/i, '').toLowerCase() !== 'none') throw Error('Stylesheet vector effects require the live renderer');
      if (bundledFamily && !allTextFontsBaked && /font-style\s*:\s*(?:italic|oblique)|font\s*:[^;}]*\b(?:italic|oblique)\b/i.test(rules)) throw Error('Scene font style requires the live renderer');
    }
    for (let i = 0; i < node.attributes.length; i++) {
      const a = node.attributes[i], name = a.localName;
      if (a.name === 'xml:base') throw Error('External scene resources are unsupported');
      if (name === 'href' || name === 'src') {
        const ref = a.value.trim();
        // Local <use> is native geometry; image fragments need resvg's image
        // resolver. The async API cannot probe that resolver, so fail closed.
        if (localReference(ref) && /^(?:image|feImage)$/i.test(node.localName)) throw Error('Unresolved scene image resources are unsupported');
        if (!localReference(ref) && !/^data:image\/(?:png|jpe?g|gif);base64,[a-z0-9+/=\s]+$/i.test(ref)) throw Error('External scene resources are unsupported');
      }
      if (name === 'style' || /url\s*\(|\\|\/\*/i.test(a.value)) safeCss(a.value);
    }
    const inherited = fonts.get(node.parentNode) ?? { family: 'sans-serif', weight: '400', style: 'normal' };
    const font = { ...inherited };
    for (const [key, attr] of [['family', 'font-family'], ['weight', 'font-weight'], ['style', 'font-style']]) if (node.hasAttribute(attr)) font[key] = node.getAttribute(attr);
    for (const declaration of (node.getAttribute('style') ?? '').split(';')) {
      const colon = declaration.indexOf(':'); if (colon < 0) continue;
      const key = declaration.slice(0, colon).trim().toLowerCase(), value = declaration.slice(colon + 1).trim();
      if (key === 'font-family') font.family = value;
      if (key === 'font-weight') font.weight = value;
      if (key === 'font-style') font.style = value;
      if (key === 'font') {
        const match = /^(.*?)\b\d*\.?\d+(?:px|pt)(?:\s*\/\s*[^\s]+)?\s+(.+)$/.exec(value);
        if (match) { font.family = match[2]; font.style = /\b(?:italic|oblique)\b/.test(match[1]) ? 'italic' : 'normal'; font.weight = /\b(?:bold|[5-9]00)\b/.exec(match[1])?.[0] ?? '400'; }
      }
    }
    fonts.set(node, font);
    if (['text', 'tspan', 'textPath'].includes(node.localName) && /(?:^|[,\s"'])Gelasio(?:$|[,\s"'])/i.test(font.family)) {
      const weight = font.weight === 'normal' ? 400 : font.weight === 'bold' || font.weight === 'bolder' ? 700 : Number(font.weight);
      if (!([400, 600, 700].includes(weight)) || (/italic|oblique/.test(font.style) && weight !== 400)) throw Error('Unsupported bundled Gelasio weight/style; use the live renderer');
    }
  }
  return doc;
}
async function fontsFor(svg) {
  const files = new Set(bundledFonts), requests = svgFontRequests(svg);
  if (requests.length > 128) throw Error('Too many scene font requests');
  requests.push({ family: 'sans-serif', weight: 400, style: 'normal' }, { family: 'serif', weight: 400, style: 'normal' });
  let sans, serif;
  for (const req of requests) {
    const key = JSON.stringify(req);
    if (!fontMemo.has(key)) {
      if (fontMemo.size >= 256) fontMemo.delete(fontMemo.keys().next().value);
      fontMemo.set(key, resolveFontFile(req, { cacheFile: process.env.FLUX_SCENE_FONT_INDEX || undefined }).catch(() => null));
    }
    const hit = await fontMemo.get(key);
    if (hit?.file) files.add(hit.file);
    if (req.family === 'sans-serif') sans = hit?.family;
    if (req.family === 'serif') serif = hit?.family;
  }
  return { loadSystemFonts: false, fontFiles: [...files], defaultFontFamily: sans, sansSerifFamily: sans, serifFamily: serif };
}
export async function rasterizeScene(request, render = renderAsync) {
  const { svg, regions } = validateSceneRequest(request), doc = sceneDocument(svg), root = doc.documentElement;
  const strokePlans = sceneStrokePlans(root);
  const font = await fontsFor(svg), serializer = new XMLSerializer();
  const inputs = regions.map(region => {
    // Every resvg input itself has bounded intrinsic dimensions. In particular
    // no whole-scene image at a deep sharp-region zoom can allocate huge tiles.
    root.setAttribute('width', String(region.width)); root.setAttribute('height', String(region.height));
    root.setAttribute('viewBox', `${region.bx} ${region.by} ${region.bw} ${region.bh}`); root.setAttribute('preserveAspectRatio', 'none');
    for (const apply of strokePlans) apply(region.width / region.bw, region.height / region.bh);
    // Each native job owns an immutable string; the next region may safely
    // change the shared DOM and bake a different non-scaling stroke transform.
    return serializer.serializeToString(doc);
  });
  const jobs = inputs.map(input => Promise.resolve().then(async () => {
    const image = await render(input, { font, logLevel: 'off' });
    return { bytes: image.asPng(), width: image.width, height: image.height };
  }));
  try {
    return { rasters: await Promise.all(jobs) };
  } catch (error) {
    // A failed plane must retire its sibling before the worker accepts more
    // work, preserving the two-job bound and an atomic response.
    await Promise.allSettled(jobs);
    throw error;
  }
}
